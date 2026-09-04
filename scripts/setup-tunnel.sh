#!/bin/bash
# scripts/setup-tunnel.sh
# Sets up Cloudflare Tunnel for ASHS.
# Prerequisites:
#   - primeshow.online must be on your Cloudflare account
#   - Run from /opt/ashs on the Dedi as root
set -euo pipefail

TUNNEL_NAME="ashs-primeshow"
API_DOMAIN="primeshow.online"
STREAM_DOMAIN="stream.primeshow.online"
CF_CONFIG_DIR="/opt/ashs/config"
CF_CONFIG="$CF_CONFIG_DIR/cloudflared.yml"

echo "=================================================="
echo "  ASHS — Cloudflare Tunnel Setup"
echo "  API:    https://${API_DOMAIN}"
echo "  Stream: https://${STREAM_DOMAIN}"
echo "=================================================="
echo ""

# 1. Install cloudflared
echo "[1/6] Installing cloudflared..."
if ! command -v cloudflared &>/dev/null; then
  curl -L --output /tmp/cloudflared.deb \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  dpkg -i /tmp/cloudflared.deb
  rm /tmp/cloudflared.deb
fi
cloudflared --version

# 2. Authenticate with Cloudflare
echo ""
echo "[2/6] Authenticating with Cloudflare..."
echo "      A browser window will open. Log in and authorize."
echo "      (If headless: copy the URL shown and open it on your machine)"
cloudflared tunnel login

# 3. Create tunnel (idempotent — skips if name exists)
echo ""
echo "[3/6] Creating tunnel: ${TUNNEL_NAME}..."
if cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
  echo "      Tunnel already exists — skipping creation"
else
  cloudflared tunnel create "$TUNNEL_NAME"
fi

# Get tunnel ID
TUNNEL_ID=$(cloudflared tunnel list --output json 2>/dev/null | \
  python3 -c "import sys,json; t=[x for x in json.load(sys.stdin) if x['name']=='${TUNNEL_NAME}']; print(t[0]['id'])" 2>/dev/null || \
  cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')

echo "      Tunnel ID: ${TUNNEL_ID}"

# 4. Create DNS routes (adds CNAME records in Cloudflare automatically)
echo ""
echo "[4/6] Routing DNS..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$API_DOMAIN"    2>/dev/null && \
  echo "      ✓ $API_DOMAIN → tunnel" || \
  echo "      ! $API_DOMAIN may already be routed"

cloudflared tunnel route dns "$TUNNEL_NAME" "$STREAM_DOMAIN" 2>/dev/null && \
  echo "      ✓ $STREAM_DOMAIN → tunnel" || \
  echo "      ! $STREAM_DOMAIN may already be routed"

# 5. Write cloudflared config
echo ""
echo "[5/6] Writing config: ${CF_CONFIG}..."
mkdir -p "$CF_CONFIG_DIR"

cat > "$CF_CONFIG" << CFCONFIG
tunnel: ${TUNNEL_ID}
credentials-file: /root/.cloudflared/${TUNNEL_ID}.json

ingress:
  # API server — library queries, admin, health
  - hostname: ${API_DOMAIN}
    service: http://localhost:4000
    originRequest:
      connectTimeout: 30s
      noTLSVerify: true
      httpHostHeader: ${API_DOMAIN}

  # File server — raw MP4/HLS streaming
  - hostname: ${STREAM_DOMAIN}
    service: http://localhost:4001
    originRequest:
      connectTimeout: 300s
      tcpKeepAlive: 60s
      noTLSVerify: true
      httpHostHeader: ${STREAM_DOMAIN}

  # Catch-all
  - service: http_status:404
CFCONFIG

echo "      Written to: ${CF_CONFIG}"
cat "$CF_CONFIG"

# 6. Install as systemd service
echo ""
echo "[6/6] Installing systemd service..."
cloudflared service install --config "$CF_CONFIG" 2>/dev/null || true
systemctl enable cloudflared 2>/dev/null || true
systemctl restart cloudflared 2>/dev/null || true

sleep 3
if systemctl is-active cloudflared &>/dev/null; then
  echo "      ✅ cloudflared service is RUNNING"
else
  echo "      ⚠️  cloudflared service failed to start. Check:"
  echo "         journalctl -u cloudflared -n 30"
fi

echo ""
echo "=================================================="
echo "  ✅ CF Tunnel setup complete!"
echo ""
echo "  Test endpoints:"
echo "    curl https://${API_DOMAIN}/health"
echo "    curl https://${STREAM_DOMAIN}/health"
echo ""
echo "  Cloudflare Dashboard:"
echo "    https://dash.cloudflare.com → Zero Trust → Tunnels"
echo ""
echo "  DNS (auto-created in Cloudflare):"
echo "    ${API_DOMAIN}        CNAME → ${TUNNEL_ID}.cfargotunnel.com"
echo "    ${STREAM_DOMAIN}     CNAME → ${TUNNEL_ID}.cfargotunnel.com"
echo ""
echo "  Useful commands:"
echo "    Status:  systemctl status cloudflared"
echo "    Logs:    journalctl -u cloudflared -f"
echo "    Restart: systemctl restart cloudflared"
echo "=================================================="