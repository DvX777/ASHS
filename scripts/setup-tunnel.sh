#!/bin/bash
# scripts/setup-tunnel.sh — Install cloudflared and configure CF Tunnel for ASHS
set -e

TUNNEL_NAME="ashs-primeshow"
HOSTNAME_API="primeshow.online"
HOSTNAME_STREAM="stream.primeshow.online"

echo "=== Installing cloudflared ==="
curl -L --output /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i /tmp/cloudflared.deb

echo "=== Login to Cloudflare (browser will open) ==="
cloudflared tunnel login

echo "=== Creating tunnel: ${TUNNEL_NAME} ==="
cloudflared tunnel create ${TUNNEL_NAME}

echo "=== Creating DNS routes ==="
cloudflared tunnel route dns ${TUNNEL_NAME} ${HOSTNAME_API}
cloudflared tunnel route dns ${TUNNEL_NAME} ${HOSTNAME_STREAM}

echo "=== Writing config ==="
mkdir -p /opt/ashs/config
TUNNEL_ID=$(cloudflared tunnel list | grep ${TUNNEL_NAME} | awk '{print $1}')

cat > /opt/ashs/config/cloudflared.yml << EOF
tunnel: ${TUNNEL_ID}
credentials-file: /root/.cloudflared/${TUNNEL_ID}.json

ingress:
  - hostname: ${HOSTNAME_API}
    service: http://localhost:4000
    originRequest:
      connectTimeout: 30s
      noTLSVerify: true
  - hostname: ${HOSTNAME_STREAM}
    service: http://localhost:4001
    originRequest:
      connectTimeout: 300s
      tcpKeepAlive: 60s
  - service: http_status:404
EOF

echo "=== Installing as systemd service ==="
cloudflared service install --config /opt/ashs/config/cloudflared.yml
systemctl enable cloudflared
systemctl start cloudflared

echo ""
echo "✅ CF Tunnel setup complete!"
echo "   API:    https://${HOSTNAME_API}"
echo "   Stream: https://${HOSTNAME_STREAM}"
echo "   Health: https://${HOSTNAME_API}/health"
