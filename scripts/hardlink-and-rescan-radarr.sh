#!/usr/bin/env bash
# scripts/hardlink-and-rescan-radarr.sh - Replace symlinks with hardlinks & re-enable Radarr Webhook
set -e

cd /opt/ashs

echo "====================================================="
echo " Converting Symlinks to Real Hardlinks & Rescanning"
echo " (Makes all 411+ movies Downloaded in Radarr)"
echo "====================================================="

bun run scripts/hardlink-and-rescan-radarr.ts

systemctl restart ashs

echo ""
echo "====================================================="
echo " Complete! Radarr is now linking all 411+ movies."
echo " Webhook re-enabled and Discord alerts active."
echo "====================================================="
