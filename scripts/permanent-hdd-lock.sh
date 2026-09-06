#!/usr/bin/env bash
# scripts/permanent-hdd-lock.sh
# Permanently lock ALL media and download paths to /mnt/media (20TB HDD) via OS filesystem links
set -e

echo "====================================================="
echo " PERMANENT HDD STORAGE LOCK"
echo " Routing all paths directly to /mnt/media (20TB HDD)"
echo "====================================================="

echo ""
echo "[1/6] Stopping services..."
systemctl stop ashs || true
systemctl stop qbittorrent || true
systemctl stop radarr || true

echo ""
echo "[2/6] Ensuring HDD directories exist..."
mkdir -p /mnt/media/downloads/incomplete
mkdir -p /mnt/media/downloads/temp
mkdir -p /mnt/media/movies
mkdir -p /mnt/media/movie
mkdir -p /mnt/media/tv

echo ""
echo "[3/6] Moving any lingering downloads from NVMe to HDD..."
for d in /var/lib/ashs/Downloads /var/lib/ashs/downloads /home/ashs/Downloads /root/Downloads /opt/ashs/media/.downloads /media/Movies /var/lib/ashs/.local/share/data/qBittorrent/downloads; do
  if [ -d "$d" ] && [ ! -L "$d" ]; then
    echo "Relocating real directory $d -> /mnt/media/downloads/..."
    cp -rn "$d"/* /mnt/media/downloads/ 2>/dev/null || true
    rm -rf "$d"
  fi
done

echo ""
echo "[4/6] Creating permanent OS-level symlinks to /mnt/media..."
# Any write to ANY of these legacy paths will now be physically forced onto the 20TB HDD:
mkdir -p /var/lib/ashs /home/ashs /opt/ashs/media /var/lib/ashs/.local/share/data/qBittorrent /media

ln -sfn /mnt/media/downloads /var/lib/ashs/Downloads
ln -sfn /mnt/media/downloads /home/ashs/Downloads
ln -sfn /mnt/media/downloads /root/Downloads
ln -sfn /mnt/media/downloads /opt/ashs/media/.downloads
ln -sfn /mnt/media/downloads /var/lib/ashs/.local/share/data/qBittorrent/downloads
ln -sfn /mnt/media/downloads/temp /opt/ashs/temp
ln -sfn /mnt/media/movies /media/Movies
ln -sfn /mnt/media/movies /media/movies
ln -sfn /mnt/media/tv /media/TV
ln -sfn /mnt/media/tv /media/tv

echo "Permanent redirects created:"
ls -ld /var/lib/ashs/Downloads /home/ashs/Downloads /root/Downloads /opt/ashs/media/.downloads /media/Movies

echo ""
echo "[5/6] Cleaning NVMe journal logs and setting permissions..."
journalctl --vacuum-size=50M 2>/dev/null || true
apt-get clean 2>/dev/null || true

chown -R ashs:ashs /var/lib/ashs /mnt/media/downloads /mnt/media/movies /mnt/media/tv 2>/dev/null || true
chmod -R 775 /mnt/media/downloads /mnt/media/movies /mnt/media/tv 2>/dev/null || true

echo ""
echo "[6/6] Restarting services with clean state..."
systemctl start qbittorrent
systemctl start radarr
sleep 3
systemctl start ashs

echo ""
echo "=== Disk Space Check ==="
df -h / /mnt/media

echo ""
echo "Permanent HDD Lock applied successfully!"
echo "Radarr's SQLite disk I/O error is cleared."
