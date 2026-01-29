#!/bin/bash
# ===========================================
# Wolt Sync System - Server Setup Script
# ===========================================
# Run this script on a fresh Ubuntu 22.04 droplet as root
# Usage: curl -sSL https://raw.githubusercontent.com/YOUR_REPO/setup-server.sh | bash

set -e

echo "=== Wolt Sync System - Server Setup ==="
echo ""

# Update system
echo "[1/6] Updating system packages..."
apt update && apt upgrade -y

# Install Node.js 20 LTS
echo "[2/6] Installing Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Verify Node.js installation
node --version
npm --version

# Install PM2 globally
echo "[3/6] Installing PM2..."
npm install -g pm2

# Create app user
echo "[4/6] Creating wolt user..."
if id "wolt" &>/dev/null; then
    echo "User 'wolt' already exists"
else
    useradd -m -s /bin/bash wolt
    echo "Created user 'wolt'"
fi

# Setup directories
echo "[5/6] Setting up directories..."
mkdir -p /home/wolt/apps
chown -R wolt:wolt /home/wolt/apps

# Setup firewall
echo "[6/6] Configuring firewall..."
ufw allow OpenSSH
ufw allow 3000/tcp comment 'Wolt Sync Health Endpoint'
ufw --force enable

echo ""
echo "=== Server Setup Complete ==="
echo ""
echo "Next steps:"
echo "1. Switch to wolt user: su - wolt"
echo "2. Clone/copy application to /home/wolt/apps/wolt-sync"
echo "3. Run: cd /home/wolt/apps/wolt-sync && npm ci && npm run build"
echo "4. Create .env file with credentials"
echo "5. Bootstrap stores: npm run bootstrap:all"
echo "6. Start service: npm run pm2:start"
echo "7. Save PM2 config: pm2 save && pm2 startup"
echo ""
