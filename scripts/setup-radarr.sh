#!/usr/bin/env bash
# scripts/setup-radarr.sh - Production Radarr 6.3.0 + qBittorrent-nox on 21TB HDD
set -euo pipefail

echo "====================================================="
echo " Installing Radarr 6.3.0 & qBittorrent-nox for ASHS"
echo " Storage: /opt/ashs/media/.downloads (21TB HDD)"
echo " Concurrency: 20 active downloads"
echo "====================================================="

# 1. Create dedicated ashs service user if not exists
if ! id -u ashs >/dev/null 2>&1; then
    echo "Creating ashs service user..."
    useradd -r -m -d /var/lib/ashs -s /bin/bash ashs || true
fi

# 2. Ensure directories exist on 21TB HDD
mkdir -p /opt/ashs/media/.downloads/temp
mkdir -p /opt/ashs/media/movies
mkdir -p /opt/ashs/media/tv
chmod -R 775 /opt/ashs/media/.downloads
chown -R ashs:ashs /opt/ashs/media/.downloads /opt/ashs/media/movies || true

# 3. Install dependencies & qbittorrent-nox
apt-get update
apt-get install -y curl sqlite3 libicu-dev qbittorrent-nox

# 4. Download & Install official Radarr 6.3.0.10514 Linux x64
echo "[1/4] Installing Radarr binary..."
rm -rf /opt/Radarr
curl -fsSL "https://github.com/Radarr/Radarr/releases/download/v6.3.0.10514/Radarr.master.6.3.0.10514.linux-core-x64.tar.gz" -o /tmp/radarr.tar.gz
tar -xzf /tmp/radarr.tar.gz -C /opt/
rm -f /tmp/radarr.tar.gz
chown -R ashs:ashs /opt/Radarr || true

# 5. Pre-configure qBittorrent config (Bypass localhost auth for Radarr & set 20 slots)
echo "[2/4] Pre-configuring qBittorrent settings..."
CONF_DIR="/var/lib/ashs/.config/qBittorrent"
mkdir -p "$CONF_DIR"
cat << 'EOF' > "$CONF_DIR/qBittorrent.conf"
[LegalNotice]
Accepted=true

[BitTorrent]
Session\MaxActiveDownloads=20
Session\MaxActiveTorrents=25
Session\MaxActiveUploads=5
Session\QueueingSystemEnabled=false

[Preferences]
WebUI\Port=8080
WebUI\LocalHostAuth=false
WebUI\AuthSubnetWhitelist=127.0.0.1/32
WebUI\AuthSubnetWhitelistEnabled=true
Downloads\SavePath=/opt/ashs/media/.downloads/
Downloads\TempPath=/opt/ashs/media/.downloads/temp/
Queueing\QueueingEnabled=false
Queueing\MaxActiveDownloads=20
Queueing\MaxActiveTorrents=25
Session\MaxActiveDownloads=20
Session\MaxActiveTorrents=25
Session\MaxActiveUploads=5
EOF
chown -R ashs:ashs /var/lib/ashs || true

# 6. Configure systemd services
echo "[3/4] Configuring systemd services..."
cat << 'EOF' > /etc/systemd/system/radarr.service
[Unit]
Description=Radarr Daemon for ASHS
After=network.target

[Service]
User=ashs
Group=ashs
Type=simple
ExecStart=/opt/Radarr/Radarr -nobrowser -data=/var/lib/radarr/
TimeoutStopSec=20
KillMode=process
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

mkdir -p /var/lib/radarr
chown -R ashs:ashs /var/lib/radarr || true

cat << 'EOF' > /etc/systemd/system/qbittorrent.service
[Unit]
Description=qBittorrent-nox headless daemon for ASHS
After=network.target

[Service]
User=ashs
Group=ashs
Type=simple
Environment="HOME=/var/lib/ashs"
ExecStart=/usr/bin/qbittorrent-nox --webui-port=8080
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now qbittorrent.service
systemctl enable --now radarr.service

echo "[4/4] Services active!"
echo "Radarr WebUI:       http://<your-server-ip>:7878"
echo "qBittorrent WebUI:  http://<your-server-ip>:8080"
echo ""
echo "Webhook URL for Radarr Connect:"
echo "URL: http://localhost:4000/0x/api/radarr/webhook"
echo "Method: POST"
echo "Triggers: On Download (Import), On Upgrade"
echo "====================================================="
