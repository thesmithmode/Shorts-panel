#!/usr/bin/env bash
# Read-only inventory. No restart, install, firewall or proxy changes.
set -euo pipefail
printf 'Host: '; hostname
printf 'Date: '; date -u +%FT%TZ
uptime
free -m
df -h / /opt /var/lib
systemctl is-active stream-panel.service || true
systemctl show stream-panel.service -p ActiveState -p MemoryCurrent -p CPUUsageNSec
ss -lntp | awk 'NR==1 || /:80 |:443 |:47921 |:47831 /'
if command -v docker >/dev/null; then
  docker ps --format '{{.Names}} {{.Image}} {{.Ports}}'
  docker inspect traefik --format '{{json .Mounts}}' 2>/dev/null || true
fi
if [ -d /root/traefik/config ]; then
  find /root/traefik/config -maxdepth 1 -type f -printf '%f\n'
fi
command -v node || true
command -v ffprobe || true
