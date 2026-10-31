#!/usr/bin/env bash
# Root-owned forced command for the dedicated shorts-deploy SSH key.
set -euo pipefail
exec sudo -n /usr/local/lib/shorts-panel/release.py "${SSH_ORIGINAL_COMMAND:-}"
