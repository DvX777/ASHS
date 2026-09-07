#!/usr/bin/env bash
# scripts/force-concurrency.sh - Permanently sets qBittorrent to 50 concurrent downloads on disk & via API
set -e

echo "====================================================="
echo "  UNLOCKING QBITTORRENT CONCURRENCY (50 SLOTS)"
echo "====================================================="

# Stop qBittorrent so edits don't get overwritten on exit
systemctl stop qbittorrent || true
systemctl stop qbittorrent-nox || true

find / -name "qBittorrent.conf" 2>/dev/null | while read conf; do
  echo "Patching config file: $conf"
  sed -i '/QueueingEnabled/d' "$conf"
  sed -i '/MaxActiveDownloads/d' "$conf"
  sed -i '/MaxActiveTorrents/d' "$conf"
  sed -i '/QueueingSystemEnabled/d' "$conf"
  sed -i '/IgnoreSlowTorrents/d' "$conf"

  cat << 'EOF' >> "$conf"

[BitTorrent]
Session\MaxActiveDownloads=50
Session\MaxActiveTorrents=50
Session\QueueingSystemEnabled=false

[Preferences]
Queueing\QueueingEnabled=false
Queueing\MaxActiveDownloads=50
Queueing\MaxActiveTorrents=50
Queueing\IgnoreSlowTorrents=true
Session\MaxActiveDownloads=50
Session\MaxActiveTorrents=50
EOF
done

systemctl start qbittorrent || systemctl start qbittorrent-nox || true

echo "Restarted qBittorrent service!"
echo "Now running API force-start..."
cd /opt/ashs && bun run scripts/set-qbittorrent-concurrency.ts
