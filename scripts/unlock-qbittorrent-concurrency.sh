#!/usr/bin/env bash
# scripts/unlock-qbittorrent-concurrency.sh - Unlock all 20 download slots in qBittorrent
set -e

echo "Unlocking qBittorrent 20 active download concurrency..."

CONF="/var/lib/ashs/.config/qBittorrent/qBittorrent.conf"
if [ ! -f "$CONF" ]; then
  mkdir -p /var/lib/ashs/.config/qBittorrent
  touch "$CONF"
fi

systemctl stop qbittorrent || true

# Update or insert Queueing\QueueingEnabled=false
sed -i '/Queueing\\QueueingEnabled/d' "$CONF"
sed -i '/Session\\MaxActiveDownloads/d' "$CONF"
sed -i '/Session\\MaxActiveTorrents/d' "$CONF"
sed -i '/Queueing\\MaxActiveDownloads/d' "$CONF"

cat << 'EOF' >> "$CONF"
[BitTorrent]
Session\MaxActiveDownloads=20
Session\MaxActiveTorrents=25
Session\QueueingSystemEnabled=false

[Preferences]
Queueing\QueueingEnabled=false
Queueing\MaxActiveDownloads=20
Queueing\MaxActiveTorrents=25
Session\MaxActiveDownloads=20
Session\MaxActiveTorrents=25
EOF

chown -R ashs:ashs /var/lib/ashs || true
systemctl start qbittorrent

echo "qBittorrent restarted with 20 concurrent download slots!"
