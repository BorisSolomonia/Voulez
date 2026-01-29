#!/bin/bash
# ===========================================
# Wolt Sync System - Deployment Script
# ===========================================
# Usage: ./scripts/deploy.sh [server] [path]
# Example: ./scripts/deploy.sh root@167.71.59.167 /var/www/wolt-sync
#
# Prerequisites:
# - SSH access to the server (key-based auth recommended)
# - Node.js 18+ installed on server
# - PM2 installed globally: npm install -g pm2

set -e

# Configuration - can be overridden via command line args
SERVER="${1:-root@165.227.171.84}"
REMOTE_PATH="${2:-/var/www/wolt-sync}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "Deploying to: $SERVER:$REMOTE_PATH"

echo "🚀 Starting Wolt Sync Deployment..."

# Step 1: Build locally
echo "📦 Building project..."
npm run build

if [ $? -ne 0 ]; then
  echo "❌ Build failed! Aborting deployment."
  exit 1
fi

# Step 2: Run tests
echo "🧪 Running tests..."
npm test -- --run

if [ $? -ne 0 ]; then
  echo "❌ Tests failed! Aborting deployment."
  exit 1
fi

# Step 3: Backup current production
echo "💾 Creating backup on server..."
ssh $SERVER "cd /var/www && cp -r wolt-sync wolt-sync-backup-$TIMESTAMP"

if [ $? -ne 0 ]; then
  echo "⚠️  Warning: Backup failed, but continuing..."
fi

# Step 4: Upload built files
echo "📤 Uploading files..."
rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='logs' \
  --exclude='state' \
  --exclude='.git' \
  --exclude='.env' \
  ./dist/ $SERVER:$REMOTE_PATH/dist/

rsync -avz \
  ./package.json \
  ./package-lock.json \
  ./ecosystem.config.js \
  $SERVER:$REMOTE_PATH/

# Step 5: Install dependencies on server
echo "📥 Installing dependencies..."
ssh $SERVER "cd $REMOTE_PATH && npm ci --production"

# Step 6: Reload PM2 processes (graceful restart)
echo "🔄 Reloading PM2 processes..."
ssh $SERVER "cd $REMOTE_PATH && pm2 reload ecosystem.config.js"

# Step 7: Wait for processes to stabilize
echo "⏳ Waiting for processes to stabilize..."
sleep 5

# Step 8: Verify all processes running
echo "✅ Verifying processes..."
ssh $SERVER "pm2 list | grep wolt-sync"

# Step 9: Check health endpoints
echo "🏥 Checking health endpoints..."
for PORT in 3002 3004 3007 3008 3009 3010 3017; do
  echo "Port $PORT:"
  ssh $SERVER "curl -s http://localhost:$PORT/health | jq '.status, .store, .lastSync' 2>/dev/null || echo 'Not running yet'"
done

# Step 10: Save PM2 configuration
echo "💾 Saving PM2 configuration..."
ssh $SERVER "pm2 save"

echo "✅ Deployment complete!"
echo "📊 Monitor logs: ssh $SERVER 'pm2 logs'"
echo "🔍 Check health: ssh $SERVER 'pm2 list'"
