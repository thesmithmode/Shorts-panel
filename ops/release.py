#!/usr/bin/env python3
"""Forced-command receiver. Install root-owned only after VPS preflight.
No generic shell execution, package installation, or edits to proxy/firewall.
"""
import fcntl
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path('/opt/shorts-panel')
DATA = Path('/var/lib/shorts-panel')
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_EXPANDED = 640 * 1024 * 1024
KEEP_RELEASES = 3
STATE_FILES = ['panel.sqlite', 'panel.sqlite-wal', 'panel.sqlite-shm', 'secret.key']
REQUIRED = ['bin/node', 'dist/index.html', 'src/server/index.ts', 'package.json', 'node_modules/tsx/package.json']
SHA = re.compile(r'[0-9a-f]{40}')
ALLOWED = {'bin', 'dist', 'src', 'node_modules', 'package.json', 'package-lock.json', 'LICENSE'}

def parse_command(command):
    match = re.fullmatch(r'release ([0-9a-f]{40})', command)
    if not match:
        raise ValueError('Only release followed by an exact commit SHA is allowed')
    return match.group(1)

def extract_release(stream, destination):
    with tarfile.open(fileobj=stream, mode='r:gz') as archive:
        members = []
        seen = set()
        total = 0
        for member in archive:
            path = PurePosixPath(member.name)
            if (path.is_absolute() or '..' in path.parts or not path.parts
                    or path.parts[0] not in ALLOWED
                    or not (member.isfile() or member.isdir())
                    or str(path) in seen):
                raise ValueError('Unsafe archive member')
            seen.add(str(path))
            total += member.size
            if total > MAX_EXPANDED or len(seen) > 50000:
                raise ValueError('Expanded archive is too large')
            members.append(member)
        # Validate every header before writing anything. Never restore ownership.
        for member in members:
            path = destination.joinpath(*PurePosixPath(member.name).parts)
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
                path.chmod(0o755)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, path.open('xb') as target:
                    shutil.copyfileobj(source, target)
                path.chmod(0o755 if member.mode & 0o111 else 0o644)

def service(action):
    subprocess.run(['/usr/bin/systemctl', action, 'shorts-panel.service'], check=True, timeout=95)

def healthy(sha):
    import ipaddress
    import json
    host = Path('/etc/shorts-panel/health-host').read_text().strip()
    address = ipaddress.ip_address(host)
    if not address.is_private or address.is_unspecified:
        raise ValueError('Health address must be the verified local bridge or loopback')
    for _ in range(60):
        try:
            # Require a configured local health endpoint; never an arbitrary URL.
            with urllib.request.urlopen(f'http://{host}:47921/healthz', timeout=2) as response:
                result = json.load(response)
                if result.get('release') == sha and result.get('service') == 'shorts-panel':
                    return True
        except (OSError, ValueError):
            pass
        time.sleep(1)
    return False

def switch_current(target):
    link = ROOT/'current.next'
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(target)
    link.replace(ROOT/'current')

def snapshot_state(checkpoint):
    owners = {}
    for name in STATE_FILES:
        path = DATA/name
        if path.exists():
            st = path.stat()
            owners[name] = (st.st_uid, st.st_gid)
            shutil.copy2(path, checkpoint/name)
    return owners

def restore_state(checkpoint, owners):
    # Restore only our checkpoint, preserving original UID/GID.
    for name in STATE_FILES:
        saved = checkpoint/name
        current = DATA/name
        if saved.exists():
            shutil.copy2(saved, current)
            os.chown(current, *owners[name])
        elif current.exists():
            current.unlink()

def prune(releases, active):
    """Keep the active release plus the newest others up to KEEP_RELEASES; drop stale staging and checkpoints."""
    for stale in releases.glob('.stage-*'):
        shutil.rmtree(stale, ignore_errors=True)
    installed = sorted((p for p in releases.iterdir() if SHA.fullmatch(p.name) and p.is_dir() and not p.is_symlink()),
                       key=lambda p: p.stat().st_mtime, reverse=True)
    keep = {active, *[p for p in installed if p != active][:KEEP_RELEASES - 1]}
    for path in installed:
        if path not in keep:
            shutil.rmtree(path)
    checkpoints = ROOT/'checkpoints'
    if checkpoints.is_dir():
        saved = sorted((p for p in checkpoints.iterdir() if p.is_dir() and not p.is_symlink()),
                       key=lambda p: p.name.rsplit('-', 1)[-1], reverse=True)
        for path in saved[KEEP_RELEASES:]:
            shutil.rmtree(path)

def main():
    if os.geteuid() != 0:
        raise PermissionError('Receiver must be installed as a root-owned forced command')
    sha = parse_command(sys.argv[1] if len(sys.argv) == 2 else os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    # Deliberately no bootstrap: existing dedicated directories/unit are required.
    if not ROOT.is_dir() or not DATA.is_dir():
        raise RuntimeError('Complete isolated VPS bootstrap first')
    with (ROOT/'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        releases = ROOT/'releases'
        releases.mkdir(exist_ok=True)
        target = releases/sha
        current_link = ROOT/'current'
        previous = current_link.resolve(strict=True) if current_link.is_symlink() else None
        if previous is not None and (previous.parent != releases or previous.is_symlink()):
            raise RuntimeError('Unexpected previous release path')
        if previous == target:
            # Re-run of the active release: verify, change nothing.
            if not healthy(sha):
                raise RuntimeError('Active release health check failed')
            print('Release already active:', sha)
            return
        with tempfile.TemporaryFile() as payload:
            total = 0
            while chunk := sys.stdin.buffer.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_ARCHIVE:
                    raise ValueError('Archive too large')
                payload.write(chunk)
            if shutil.disk_usage(ROOT).free < MAX_EXPANDED + 2 * 1024**3:
                raise RuntimeError('Insufficient disk reserve')
            payload.seek(0)
            if target.exists():
                # Inactive leftover of the same commit (e.g. kept for rollback): reinstall cleanly.
                shutil.rmtree(target)
            with tempfile.TemporaryDirectory(prefix='.stage-', dir=releases) as staging:
                stage = Path(staging)
                extract_release(payload, stage)
                for required in REQUIRED:
                    if not (stage/required).is_file():
                        raise ValueError('Incomplete release')
                (stage/'release-sha').write_text(sha)
                stage.chmod(0o755)
                stage.rename(target)
                os.utime(target)
        checkpoint = ROOT/'checkpoints'/f'{sha}-{time.time_ns()}'
        checkpoint.mkdir(parents=True, mode=0o700)
        owners = {}
        snapshot_complete = False
        try:
            service('stop')
            # Copy only application state, never the shared server or videos.
            owners = snapshot_state(checkpoint)
            snapshot_complete = True
            switch_current(target)
            service('start')
            if not healthy(sha):
                raise RuntimeError('Release health check failed')
        except Exception:
            service('stop')
            if snapshot_complete:
                restore_state(checkpoint, owners)
            if previous is not None:
                switch_current(previous)
                service('start')
            elif current_link.is_symlink():
                current_link.unlink()
            # Never leave a failed release behind; a retry of the same SHA must be possible.
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            raise
        prune(releases, target)
        print('Release installed:', sha)

if __name__ == '__main__':
    main()
