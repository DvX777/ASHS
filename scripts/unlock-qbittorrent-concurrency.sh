#!/usr/bin/env bash
# scripts/unlock-qbittorrent-concurrency.sh - Unlock all 20 download slots in qBittorrent on /mnt/media/downloads
set -e

echo "Unlocking qBittorrent 20 active download concurrency on /mnt/media/downloads..."

mkdir -p /mnt/media/downloads/incomplete
mkdir -p /mnt/media/movies

CONF="/var/lib/ashs/.config/qBittorrent/qBittorrent.conf"
if [ ! -f "$CONF" ]; then
  mkdir -p /var/lib/ashs/.config/qBittorrent
  touch "$CONF"
fi

systemctl stop qbittorrent || true

sed -i '/SavePath/d' "$CONF"
sed -i '/TempPath/d' "$CONF"
sed -i '/Queueing\\QueueingEnabled/d' "$CONF"
sed -i '/Session\\MaxActiveDownloads/d' "$CONF"
sed -i '/Session\\MaxActiveTorrents/d' "$CONF"
sed -i '/Queueing\\MaxActiveDownloads/d' "$CONF"
sed -i '/Queueing\\MaxActiveTorrents/d' "$CONF"

cat << 'EOF' >> "$CONF"

[BitTorrent]
Session\DefaultSavePath=/mnt/media/downloads
Session\TempPath=/mnt/media/downloads/incomplete
Session\TempPathEnabled=true
Session\MaxActiveDownloads=20
Session\MaxActiveTorrents=25
Session\QueueingSystemEnabled=false

[Preferences]
Downloads\SavePath=/mnt/media/downloads
Downloads\TempPath=/mnt/media/downloads/incomplete
Downloads\TempPathEnabled=true
Queueing\QueueingEnabled=false
Queueing\MaxActiveDownloads=20
Queueing\MaxActiveTorrents=25
Session\MaxActiveDownloads=20
Session\MaxActiveTorrents=25
EOF

chown -R ashs:ashs /var/lib/ashs /mnt/media/downloads || true
chmod -R 775 /mnt/media/downloads || true
systemctl start qbittorrent

echo "qBittorrent restarted with 20 concurrent download slots downloading to /mnt/media/downloads!"
