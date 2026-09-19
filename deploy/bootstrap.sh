#!/usr/bin/env bash
# Forge server bootstrap — FullStackDeploymentHandbook baseline, automated.
# Run ONCE on a fresh Ubuntu 24.04 box as root:  bash bootstrap.sh <deploy-user>
# After this, the vps deploy adapter handles per-app releases.
set -euo pipefail

DEPLOY_USER="${1:-forge}"
SWAP_GB="${2:-2}"

echo "==> base packages"
apt-get update -qq
apt-get install -y -qq nginx supervisor certbot python3-certbot-nginx ufw fail2ban \
  curl git build-essential nodejs npm

echo "==> non-root user: $DEPLOY_USER"
if ! id "$DEPLOY_USER" &>/dev/null; then
  useradd -m -s /bin/bash "$DEPLOY_USER"
  usermod -aG sudo "$DEPLOY_USER"
  mkdir -p "/home/$DEPLOY_USER/.ssh"
  cp ~/.ssh/authorized_keys "/home/$DEPLOY_USER/.ssh/" 2>/dev/null || true
  chown -R "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
  chmod 700 "/home/$DEPLOY_USER/.ssh"
  chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys" 2>/dev/null || true
fi

echo "==> swap (${SWAP_GB}GB)"
if [ ! -f /swapfile ]; then
  fallocate -l "${SWAP_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> firewall (22/80/443 only)"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "==> fail2ban (SSH brute-force protection)"
systemctl enable --now fail2ban

echo "==> ssh hardening"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh

echo "==> app root"
mkdir -p /srv
chown "$DEPLOY_USER:$DEPLOY_USER" /srv

echo "==> nginx baseline"
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl enable --now nginx

echo "==> logrotate for app logs"
cat > /etc/logrotate.d/forge-apps <<'EOF'
/var/log/supervisor/*.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    copytruncate
}
EOF

echo ""
echo "Done. Next:"
echo "  1. Point DNS A record at this box, then: sudo certbot --nginx -d yourdomain.com"
echo "  2. From your machine: forge agent → 'deploy to vps $DEPLOY_USER@<this-ip>'"
