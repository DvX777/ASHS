#!/bin/bash
# scripts/setup-firewall.sh
# Hardens the Dedi: DROP all inbound traffic except SSH from your IP.
# All ASHS traffic flows via CF Tunnel (outbound) — zero open ports needed.
set -euo pipefail

# !! CHANGE THIS to your actual management/home IP !!
MGMT_IP="${1:-}"

if [ -z "$MGMT_IP" ]; then
  echo "Usage: bash scripts/setup-firewall.sh <YOUR_MGMT_IP>"
  echo "Example: bash scripts/setup-firewall.sh 203.0.113.42"
  echo ""
  echo "Your current external IP: $(curl -s https://api.ipify.org)"
  exit 1
fi

echo "=== ASHS Firewall Setup ==="
echo "Management IP: $MGMT_IP"
echo ""

# Flush existing rules
iptables -F
iptables -X
iptables -Z

# Default policies: DROP all inbound and forward, ACCEPT all outbound
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT ACCEPT

# Allow loopback (cloudflared + local service communication)
iptables -A INPUT -i lo -j ACCEPT

# Allow established/related connections (cloudflared outbound tunnels need this)
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow SSH ONLY from your management IP
iptables -A INPUT -p tcp --dport 22 -s "$MGMT_IP" -j ACCEPT

# Log dropped packets (optional, useful for debugging)
iptables -A INPUT -j LOG --log-prefix "ASHS-DROP: " --log-level 4

echo "✅ iptables rules applied"
echo ""
iptables -L -n -v --line-numbers

# Persist rules across reboots
if command -v iptables-save &>/dev/null; then
  echo ""
  echo "Persisting rules..."
  mkdir -p /etc/iptables
  iptables-save > /etc/iptables/rules.v4

  # Install iptables-persistent if available
  if command -v apt-get &>/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent 2>/dev/null || true
  fi

  # Fallback: restore via rc.local
  if [ ! -f /etc/network/if-up.d/iptables ]; then
    cat > /etc/network/if-up.d/iptables << 'RESTORE'
#!/bin/bash
iptables-restore < /etc/iptables/rules.v4
RESTORE
    chmod +x /etc/network/if-up.d/iptables
  fi
fi

echo ""
echo "=================================================="
echo "  ✅ Firewall configured!"
echo ""
echo "  Rules:"
echo "    ✗ ALL inbound traffic: DROPPED"
echo "    ✓ SSH from $MGMT_IP: ALLOWED"
echo "    ✓ Loopback: ALLOWED"
echo "    ✓ Established connections: ALLOWED"
echo "    ✓ All outbound (cloudflared): ALLOWED"
echo ""
echo "  ⚠️  If you lose SSH access, reboot the Dedi"
echo "     and rerun with the correct IP."
echo "=================================================="