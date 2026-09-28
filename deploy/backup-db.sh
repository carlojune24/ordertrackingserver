#!/usr/bin/env bash
# Nightly local pg_dump backup for the order_tracking database.
# Scheduled via crontab, e.g.: 0 2 * * * /home/ubuntu/apps/order-tracking-server/deploy/backup-db.sh >> /home/ubuntu/backups/backup.log 2>&1
set -euo pipefail

BACKUP_DIR="/home/ubuntu/backups"
RETENTION_DAYS=14
DB_NAME="order_tracking"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

sudo -u postgres pg_dump "$DB_NAME" | gzip > "$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql.gz"

find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete

echo "Backup complete: ${DB_NAME}_${TIMESTAMP}.sql.gz"
