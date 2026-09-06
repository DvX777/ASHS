#!/usr/bin/env bash
# scripts/reclaim-nvme-and-fix-storage.sh
# Emergency cleanup and permanent storage redirect to /mnt/media (20TB HDD)
set -e

echo "====================================================="
echo " ASHS NVMe Storage Reclaim & HDD Migration"
echo " Target HDD: /mnt/media"
echo "====================================================="

echo ""
echo "=== Disk Space Before Cleanup ==="
df -h / /mnt/media

echo ""
echo "[1/6] Stopping services to safely relocate files..."
systemctl stop ashs || true
systemctl stop qbittorrent || true
systemctl stop radarr || true

echo ""
echo "[2/6] Preparing HDD storage structure in /mnt/media..."
mkdir -p /mnt/media/downloads/incomplete
mkdir -p /mnt/media/downloads/temp
mkdir -p /mnt/media/movies
mkdir -p /mnt/media/movie
mkdir -p /mnt/media/tv

echo ""
echo "[3/6] Moving media and downloads from NVMe (/) to /mnt/media..."

# Migrate /media/Movies to /mnt/media/movies
if [ -d "/media/Movies" ]; then
  echo "Relocating /media/Movies -> /mnt/media/movies..."
  cp -rn /media/Movies/* /mnt/media/movies/ 2>/dev/null || true
  rm -rf /media/Movies
fi

# Migrate old qBittorrent & ASHS download folders from NVMe
for d in /var/lib/ashs/Downloads /var/lib/ashs/downloads /home/ashs/Downloads /root/Downloads /opt/ashs/media/.downloads /opt/ashs/temp /opt/ashs/media/movies; do
  if [ -d "$d" ]; then
    echo "Relocating $d -> /mnt/media/downloads..."
    cp -rn "$d"/* /mnt/media/downloads/ 2>/dev/null || true
    rm -rf "$d"
  fi
done

# Clean system journal and apt cache to free NVMe breathing room
journalctl --vacuum-size=100M 2>/dev/null || true
apt-get clean 2>/dev/null || true

echo ""
echo "[4/6] Reconfiguring qBittorrent to use /mnt/media/downloads..."
for conf in /var/lib/ashs/.config/qBittorrent/qBittorrent.conf /home/ashs/.config/qBittorrent/qBittorrent.conf /root/.config/qBittorrent/qBittorrent.conf; do
  if [ -f "$conf" ] || [ -d "$(dirname "$conf")" ]; then
    mkdir -p "$(dirname "$conf")"
    touch "$conf"
    sed -i '/SavePath/d' "$conf"
    sed -i '/TempPath/d' "$conf"
    sed -i '/QueueingEnabled/d' "$conf"
    sed -i '/MaxActiveDownloads/d' "$conf"
    sed -i '/MaxActiveTorrents/d' "$conf"

    cat << 'EOF' >> "$conf"

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
    echo "Updated $conf"
  fi
done

# Set permissions
chown -R ashs:ashs /mnt/media/downloads /mnt/media/movies /var/lib/ashs 2>/dev/null || true
chmod -R 775 /mnt/media/downloads /mnt/media/movies 2>/dev/null || true

echo ""
echo "[5/6] Updating ASHS .env configuration..."
ENV_FILE="/opt/ashs/.env"
if [ -f "$ENV_FILE" ]; then
  sed -i '/^MEDIA_DIR=/d' "$ENV_FILE"
  sed -i '/^TEMP_DIR=/d' "$ENV_FILE"
  sed -i '/^RADARR_ROOT_FOLDER=/d' "$ENV_FILE"
  echo "MEDIA_DIR=/mnt/media" >> "$ENV_FILE"
  echo "TEMP_DIR=/mnt/media/downloads/temp" >> "$ENV_FILE"
  echo "RADARR_ROOT_FOLDER=/mnt/media/movies" >> "$ENV_FILE"
  echo "Updated $ENV_FILE"
fi

echo ""
echo "[6/6] Restarting services..."
systemctl start qbittorrent
systemctl start radarr
sleep 3
systemctl start ashs

echo ""
echo "=== Disk Space After Reclaiming NVMe ==="
df -h / /mnt/media

echo ""
echo "Now running library bridge to populate all 411 movies in Radarr..."
bash /opt/ashs/scripts/link-ashs-to-radarr.sh
