#!/usr/bin/env bash
# =============================================================================
# setup-static-ip.sh — One-time static IP / mDNS setup for the CQR Chat server
#
# Run this script once on the server machine (Ubuntu/Debian Linux).
# After running, the server will be reachable at a stable address instead of
# a DHCP-assigned IP that changes on every reboot.
#
# Usage:
#   chmod +x setup-static-ip.sh
#   sudo ./setup-static-ip.sh
# =============================================================================

set -e

STATIC_IP="192.168.1.7"
NETMASK="24"           # /24 = 255.255.255.0
GATEWAY="192.168.1.1"
DNS="8.8.8.8,8.8.4.4"
MDNS_HOSTNAME="cqr-server"   # will be reachable as cqr-server.local

echo "================================================================="
echo " CQR Chat Server — Static IP + mDNS Setup"
echo "================================================================="
echo ""

# ---------------------------------------------------------------------------
# 1. Set static IP via Netplan (Ubuntu 18.04+)
# ---------------------------------------------------------------------------
echo "[1/3] Configuring static IP via Netplan..."

# Detect the primary network interface
IFACE=$(ip -4 route show default | awk '{print $5}' | head -1)
if [ -z "$IFACE" ]; then
  echo "ERROR: Could not detect primary network interface. Set it manually."
  exit 1
fi
echo "     Detected interface: $IFACE"

NETPLAN_FILE="/etc/netplan/99-cqr-static.yaml"
cat > "$NETPLAN_FILE" <<EOF
network:
  version: 2
  renderer: networkd
  ethernets:
    $IFACE:
      dhcp4: no
      addresses:
        - $STATIC_IP/$NETMASK
      routes:
        - to: default
          via: $GATEWAY
      nameservers:
        addresses: [$DNS]
EOF

echo "     Written to $NETPLAN_FILE"
echo ""
echo "     IMPORTANT: Also reserve $STATIC_IP for this machine's MAC address"
echo "     in your router admin panel (DHCP Reservation / Static DHCP)."
echo "     This prevents IP conflicts if you ever re-enable DHCP."
echo ""

# ---------------------------------------------------------------------------
# 2. Install and configure Avahi mDNS (optional but recommended)
# ---------------------------------------------------------------------------
echo "[2/3] Installing Avahi daemon for mDNS hostname (cqr-server.local)..."
apt-get update -qq
apt-get install -y avahi-daemon avahi-utils

# Set the mDNS hostname
hostnamectl set-hostname "$MDNS_HOSTNAME"

AVAHI_CONF="/etc/avahi/avahi-daemon.conf"
if grep -q "^host-name=" "$AVAHI_CONF" 2>/dev/null; then
  sed -i "s/^host-name=.*/host-name=$MDNS_HOSTNAME/" "$AVAHI_CONF"
else
  sed -i "/^\[server\]/a host-name=$MDNS_HOSTNAME" "$AVAHI_CONF"
fi

systemctl enable avahi-daemon
systemctl restart avahi-daemon

echo "     mDNS hostname set. Server will be reachable as:"
echo "       http://$MDNS_HOSTNAME.local:8008   (Synapse direct)"
echo "       http://$MDNS_HOSTNAME.local:3000   (CQR backend)"
echo ""

# ---------------------------------------------------------------------------
# 3. Apply Netplan and show result
# ---------------------------------------------------------------------------
echo "[3/3] Applying static IP configuration..."
netplan apply

echo ""
echo "================================================================="
echo " Setup complete!"
echo ""
echo " Static IP : $STATIC_IP (on interface $IFACE)"
echo " mDNS host : $MDNS_HOSTNAME.local"
echo ""
echo " Next steps:"
echo "  1. In your router admin, add a DHCP Reservation:"
echo "     MAC address of $IFACE  →  $STATIC_IP"
echo "     (this prevents conflicts if DHCP is ever re-enabled)"
echo ""
echo "  2. Restart Docker and PM2 services:"
echo "     docker compose down && docker compose up -d"
echo "     pm2 restart all"
echo ""
echo "  3. Update the frontend app config to use one of:"
echo "     http://$STATIC_IP:3000          (stable IP)"
echo "     http://$MDNS_HOSTNAME.local:3000  (mDNS hostname — no IP needed)"
echo "================================================================="
