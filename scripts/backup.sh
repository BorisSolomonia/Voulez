#!/bin/bash
set -e

SERVER="root@167.71.59.167"
REMOTE_PATH="/var/www/wolt-sync"
BACKUP_DIR="/var/www/wolt-sync-backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_NAME="wolt-sync-backup-$TIMESTAMP"

echo "💾 Starting backup..."

# Create backup directory on server
ssh $SERVER "mkdir -p $BACKUP_DIR"

# Backup application files
echo "📦 Backing up application files..."
ssh $SERVER "cd /var/www && tar -czf $BACKUP_DIR/$BACKUP_NAME.tar.gz \
  --exclude='node_modules' \
  --exclude='logs/*.log' \
  wolt-sync/"

# Backup state files separately (critical)
echo "💾 Backing up state files..."
ssh $SERVER "cd $REMOTE_PATH && tar -czf $BACKUP_DIR/$BACKUP_NAME-state.tar.gz state/"

# Get backup sizes
BACKUP_SIZE=$(ssh $SERVER "du -h $BACKUP_DIR/$BACKUP_NAME.tar.gz | cut -f1")
STATE_SIZE=$(ssh $SERVER "du -h $BACKUP_DIR/$BACKUP_NAME-state.tar.gz | cut -f1")

echo "✅ Backup complete!"
echo "📦 Application backup: $BACKUP_NAME.tar.gz ($BACKUP_SIZE)"
echo "💾 State backup: $BACKUP_NAME-state.tar.gz ($STATE_SIZE)"
echo "📍 Location: $BACKUP_DIR/"

# Clean up old backups (keep last 10)
echo "🧹 Cleaning up old backups..."
ssh $SERVER "cd $BACKUP_DIR && ls -t | tail -n +21 | xargs -r rm"

# List all backups
echo ""
echo "📋 Available backups:"
ssh $SERVER "ls -lh $BACKUP_DIR/"
