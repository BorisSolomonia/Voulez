#!/bin/bash
set -e

SERVER="root@167.71.59.167"

echo "🔧 Setting up Wolt Sync on server..."

# Install Node.js 18 LTS
echo "📦 Installing Node.js 18 LTS..."
ssh $SERVER "curl -fsSL https://deb.nodesource.com/setup_18.x | bash -"
ssh $SERVER "apt-get install -y nodejs"

# Verify Node.js installation
echo "✅ Verifying Node.js installation..."
ssh $SERVER "node --version && npm --version"

# Install PM2 globally
echo "📦 Installing PM2..."
ssh $SERVER "npm install -g pm2"

# Verify PM2 installation
echo "✅ Verifying PM2 installation..."
ssh $SERVER "pm2 --version"

# Create application directory
echo "📁 Creating application directory..."
ssh $SERVER "mkdir -p /var/www/wolt-sync/{logs,state,dist}"

# Set permissions
echo "🔒 Setting permissions..."
ssh $SERVER "chown -R root:root /var/www/wolt-sync"

# Disable PM2 systemd (same issue as Glovo project)
echo "⚠️  Disabling PM2 systemd auto-start..."
ssh $SERVER "pm2 unstartup systemd || echo 'Systemd already disabled'"

# Install useful utilities
echo "🛠️  Installing utilities..."
ssh $SERVER "apt-get install -y jq curl htop"

# Create .env file template
echo "📝 Creating .env template on server..."
ssh $SERVER "cat > /var/www/wolt-sync/.env.example << 'EOF'
# Fina API Configuration
FINA_API_URL=http://185.139.56.128:8091
FINA_LOGIN=your_fina_login
FINA_PASSWORD=your_fina_password

# Store 4 Configuration
WOLT_VENUE_ID_4=your_venue_id
WOLT_USER_4=your_username
WOLT_PASS_4=your_password

# Store 3 Configuration
WOLT_VENUE_ID_3=your_venue_id
WOLT_USER_3=your_username
WOLT_PASS_3=your_password

# Store 6 Configuration
WOLT_VENUE_ID_6=your_venue_id
WOLT_USER_6=your_username
WOLT_PASS_6=your_password

# Store 10 Configuration
WOLT_VENUE_ID_10=your_venue_id
WOLT_USER_10=your_username
WOLT_PASS_10=your_password

# Store 17 Configuration
WOLT_VENUE_ID_17=your_venue_id
WOLT_USER_17=your_username
WOLT_PASS_17=your_password
EOF"

echo "✅ Server setup complete!"
echo ""
echo "📋 Next steps:"
echo "1. Copy .env file to server: scp .env $SERVER:/var/www/wolt-sync/"
echo "2. Run initial deployment: ./scripts/deploy.sh"
echo "3. Check PM2 status: ssh $SERVER 'pm2 list'"
echo "4. Monitor logs: ssh $SERVER 'pm2 logs'"
