#!/usr/bin/env python3
"""Forced-command receiver. Install root-owned only after VPS preflight.
No generic shell execution, package installation, or edits to proxy/firewall.
"""
import fcntl
import io
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
MAX_EXPANDED = 512 * 1024 * 1024
ALLOWED = {'dist', 'src', 'node_modules', 'package.json', 'package-lock.json', 'LICENSE'}

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
    host = Path('/etc/shorts-panel/health-host').read_text().strip()
    address = ipaddress.ip_address(host)
    if not address.is_private or address.is_unspecified:
        raise ValueError('Health address must be the verified local bridge or loopback')
    for _ in range(30):
        try:
            # Require a configured loopback health endpoint; never an arbitrary URL.
            with urllib.request.urlopen(f'http://{host}:47921/healthz', timeout=2) as response:
                import json
                result = json.load(response)
                if result.get('release') == sha and result.get('service') == 'shorts-panel':
                    return True
        except (OSError, ValueError):
            pass
        time.sleep(1)
    return False

def main():
    if os.geteuid() != 0:
        raise PermissionError('Receiver must be installed as a root-owned forced command')
    sha = parse_command(sys.argv[1] if len(sys.argv) == 2 else os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    # Deliberately no bootstrap: existing dedicated directories/unit are required.
    if not ROOT.is_dir() or not DATA.is_dir():
        raise RuntimeError('Complete isolated VPS bootstrap first')
    with (ROOT/'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
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
            releases = ROOT/'releases'
            releases.mkdir(exist_ok=True)
            target = releases/sha
            if target.exists():
                raise RuntimeError('Release SHA already installed; refusing overwrite')
            with tempfile.TemporaryDirectory(prefix='.stage-', dir=releases) as staging:
                stage = Path(staging)
                extract_release(payload, stage)
                for required in ['dist/index.html', 'src/server/index.ts', 'package.json', 'node_modules/tsx/package.json']:
                    if not (stage/required).is_file():
                        raise ValueError('Incomplete release')
                (stage/'release-sha').write_text(sha)
                stage.chmod(0o755)
                stage.rename(target)
            previous = (ROOT/'current').resolve(strict=True)
            if previous.parent != releases or previous.is_symlink():
                raise RuntimeError('Unexpected previous release path')
            checkpoint = ROOT/'checkpoints'/sha
            checkpoint.mkdir(parents=True, mode=0o700)
            owners = {}
            snapshot_complete = False
            service('stop')
            try:
                # Copy only application state, never the shared server or videos.
                for name in ['panel.sqlite', 'panel.sqlite-wal', 'panel.sqlite-shm', 'secret.key']:
                    path = DATA/name
                    if path.exists():
                        st = path.stat()
                        owners[name] = (st.st_uid, st.st_gid)
                        shutil.copy2(path, checkpoint/name)
                snapshot_complete = True
                link = ROOT/'next'
                if link.exists() or link.is_symlink():
                    raise RuntimeError('Unexpected next link')
                link.symlink_to(target)
                link.replace(ROOT/'current')
                service('start')
                if not healthy(sha):
                    raise RuntimeError('Release health check failed')
            except Exception:
                service('stop')
                if not snapshot_complete:
                    service('start')
                    raise
                # Restore only our checkpoint, preserving original UID/GID.
                for name in ['panel.sqlite', 'panel.sqlite-wal', 'panel.sqlite-shm', 'secret.key']:
                    saved = checkpoint/name
                    current = DATA/name
                    if saved.exists():
                        shutil.copy2(saved, current)
                        os.chown(current, *owners[name])
                    elif current.exists():
                        current.unlink()
                rollback = ROOT/'rollback'
                rollback.symlink_to(previous)
                rollback.replace(ROOT/'current')
                service('start')
                raise
            print('Release installed:', sha)

if __name__ == '__main__':
    main()
