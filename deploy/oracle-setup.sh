#!/bin/bash
# Fortlite game server setup for a fresh Ubuntu VM (Oracle Cloud Always Free).
# Run once on the VM:   DOMAIN=yourname.duckdns.org REPO=https://github.com/tq1r/fortlite.git bash oracle-setup.sh
# It installs Node 20, clones the game, runs it as a service on port 3000,
# and puts Caddy in front for HTTPS/WebSockets (wss://) on port 443.
set -euo pipefail

: "${DOMAIN:?Set DOMAIN, e.g. DOMAIN=fortlite.duckdns.org (must already point to the VM public IP)}"
REPO="${REPO:-https://github.com/tq1r/fortlite.git}"
APP_DIR=/opt/fortlite

echo "==> Installing packages"
sudo apt-get update -y
sudo apt-get install -y git curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https

echo "==> Installing Node 20"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1)" != "v20" ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Installing Caddy (automatic HTTPS)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

echo "==> Opening web ports on the VM firewall"
sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo iptables -C INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT

echo "==> Getting the game"
if [ -d "$APP_DIR/.git" ]; then
  sudo git -C "$APP_DIR" pull --ff-only
else
  sudo git clone "$REPO" "$APP_DIR"
fi
sudo chown -R "$USER":"$USER" "$APP_DIR"

echo "==> Creating the game service"
sudo tee /etc/systemd/system/fortlite.service >/dev/null <<EOF
[Unit]
Description=Fortlite game server
After=network.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Restart=always
User=$USER

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now fortlite
sudo systemctl restart fortlite

echo "==> Configuring HTTPS proxy for $DOMAIN"
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
  reverse_proxy localhost:3000
}
EOF
sudo systemctl restart caddy

echo "==> Checking"
sleep 2
curl -s http://localhost:3000/health && echo
echo "Done. Game server: https://$DOMAIN (WebSocket: wss://$DOMAIN/ws)"
