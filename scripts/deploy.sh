#!/bin/bash
# scripts/deploy.sh
# Full production setup for ASHS on the Dedi (Debian/Ubuntu).
# Run as root on the Dedi after uploading the project.
set -euo pipefail

ASHS_DIR="/opt/ashs"
MEDIA_DIR="/mnt/media"
TEMP_DIR="/opt/ashs/temp"
DB_DIR="/opt/ashs/db"
LOG_DIR="/var/log/ashs"
USER="ashs"

echo ""
echo "=================================================="
echo "   ASHS Production Deploy"
echo "   Target: ${ASHS_DIR}"
echo "=================================================="
echo ""

# ── 1. System packages ─────────────────────────────────────────────────────────
echo "[1/8] Installing system packages..."
apt-get update -qq
apt-get install -y curl wget unzip git rsync htop ncdu lsof 2>/dev/null

# ── 2. Install Bun ─────────────────────────────────────────────────────────────
echo "[2/8] Installing Bun..."
if ! command -v bun &>/dev/null; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  echo 'export PATH="$HOME/.bun/bin:$PATH"' >> /root/.bashrc
fi
bun --version

# ── 3. Install PM2 ─────────────────────────────────────────────────────────────
echo "[3/8] Installing PM2..."
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2 2>/dev/null || bun install -g pm2
fi

# ── 4. Directory setup ─────────────────────────────────────────────────────────
echo "[4/8] Creating directories..."
mkdir -p "${ASHS_DIR}" "${DB_DIR}" "${TEMP_DIR}" "${LOG_DIR}"
mkdir -p "${MEDIA_DIR}/movie" "${MEDIA_DIR}/tv"

# Check HDD mount
if ! mountpoint -q /mnt/media 2>/dev/null; then
  echo "⚠️  WARNING: /mnt/media is not a mounted filesystem!"
  echo "   Make sure your HDD is mounted at /mnt/media before continuing."
  echo "   Add to /etc/fstab: /dev/sdX1  /mnt/media  ext4  defaults  0  2"
fi

# ── 5. Install dependencies ────────────────────────────────────────────────────
echo "[5/8] Installing Node dependencies..."
cd "${ASHS_DIR}"
bun install --production

# ── 6. Database migration ──────────────────────────────────────────────────────
echo "[6/8] Running database migrations..."
DB_PATH="${DB_DIR}/ashs.sqlite3" bun run scripts/migrate.ts

# ── 7. Systemd service ─────────────────────────────────────────────────────────
echo "[7/8] Installing systemd service..."
cat > /etc/systemd/system/ashs.service << 'SYSTEMD'
[Unit]
Description=ASHS — Auto Self-Hosted System
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/ashs
EnvironmentFile=/opt/ashs/.env
ExecStart=/root/.bun/bin/bun run src/index.ts
Restart=always
RestartSec=5
StandardOutput=append:/var/log/ashs/out.log
StandardError=append:/var/log/ashs/error.log
SyslogIdentifier=ashs
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
SYSTEMD

systemctl daemon-reload
systemctl enable ashs

# ── 8. cloudflared install ─────────────────────────────────────────────────────
echo "[8/8] Installing cloudflared..."
if ! command -v cloudflared &>/dev/null; then
  curl -L --output /tmp/cloudflared.deb \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  dpkg -i /tmp/cloudflared.deb
fi
cloudflared --version

echo ""
echo "=================================================="
echo "  ✅ Deploy script complete!"
echo ""
echo "  NEXT STEPS:"
echo "  1. Fill in /opt/ashs/.env  (cp .env.example .env && nano .env)"
echo "  2. Setup CF Tunnel:  bash scripts/setup-tunnel.sh"
echo "  3. Add approved site: DB_PATH=/opt/ashs/db/ashs.sqlite3 bun run scripts/seed-site.ts vidzen.fun Vidzen"
echo "  4. Import Jellyfin library (optional):"
echo "     MEDIA_DIR=/mnt/media DB_PATH=/opt/ashs/db/ashs.sqlite3 bun run scripts/import-library.ts /old/jellyfin/movies --move"
echo "  5. Start service:  systemctl start ashs"
echo "  6. View logs:      journalctl -u ashs -f"
echo "  7. Health check:   curl https://primeshow.online/health"
echo "=================================================="