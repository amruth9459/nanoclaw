#!/bin/bash
# NanoClaw + Lexios Migration to Mac Studio
# Run this on NEW Mac Studio

set -e

echo "=== NanoClaw + Lexios Migration Script ==="
echo ""

# Get Mac Studio IP/hostname
read -p "Mac Studio hostname/IP: " MAC_STUDIO_HOST
read -p "Mac Studio username: " MAC_USER

# Directories to sync
SYNC_DIRS=(
    "/workspace/project"
    "/workspace/group"
    "/workspace/lexios"
    "$HOME/.claude"
)

# Files to sync
CONFIG_FILES=(
    "$HOME/Library/LaunchAgents/com.nanoclaw.plist"
)

echo ""
echo "Will sync:"
for dir in "${SYNC_DIRS[@]}"; do
    echo "  - $dir"
done
for file in "${CONFIG_FILES[@]}"; do
    echo "  - $file"
done
echo ""

read -p "Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
fi

# Sync directories
for dir in "${SYNC_DIRS[@]}"; do
    echo "Syncing $dir..."
    rsync -avz --progress \
        --exclude 'node_modules' \
        --exclude '__pycache__' \
        --exclude '*.pyc' \
        --exclude '.git' \
        "$dir/" "$MAC_USER@$MAC_STUDIO_HOST:$dir/"
done

# Sync config files
for file in "${CONFIG_FILES[@]}"; do
    if [ -f "$file" ]; then
        echo "Syncing $file..."
        scp "$file" "$MAC_USER@$MAC_STUDIO_HOST:$file"
    fi
done

echo ""
echo "=== File Sync Complete ==="
echo ""

# Database backup (if needed)
echo "=== Database Migration ==="
if [ -f "$HOME/.nanoclaw/nanoclaw.db" ]; then
    echo "Backing up SQLite database..."
    rsync -avz "$HOME/.nanoclaw/nanoclaw.db" "$MAC_USER@$MAC_STUDIO_HOST:$HOME/.nanoclaw/nanoclaw.db"
fi

# PostgreSQL backup for Lexios
echo ""
read -p "Do you want to backup PostgreSQL database? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    read -p "PostgreSQL database name: " DB_NAME
    echo "Creating PostgreSQL dump..."
    pg_dump "$DB_NAME" > /tmp/lexios_backup.sql
    echo "Transferring PostgreSQL dump..."
    scp /tmp/lexios_backup.sql "$MAC_USER@$MAC_STUDIO_HOST:/tmp/lexios_backup.sql"
    rm /tmp/lexios_backup.sql
    echo "PostgreSQL dump transferred to Mac Studio:/tmp/lexios_backup.sql"
fi

echo ""
echo "=== Migration Complete ==="
echo ""
echo "============================================"
echo "Next steps on Mac Studio:"
echo "============================================"
echo ""
echo "1. INSTALL DEPENDENCIES"
echo "   cd /workspace/project && npm install"
echo "   pip install -r /workspace/lexios/backend/requirements.txt"
echo ""
echo "2. CONFIGURE ENVIRONMENT"
echo "   cp /workspace/lexios/backend/.env.example /workspace/lexios/backend/.env"
echo "   # Edit .env with your values:"
echo "   #   - DATABASE_URL=postgresql://user:pass@localhost:5432/lexios"
echo "   #   - ANTHROPIC_API_KEY=sk-ant-..."
echo "   #   - EMBEDDING_MODEL=sentence-transformers"
echo "   #   - LLM_PROVIDER=anthropic"
echo ""
echo "3. DATABASE SETUP"
echo "   # Create PostgreSQL database"
echo "   createdb lexios"
echo "   # Restore from backup (if transferred)"
echo "   psql lexios < /tmp/lexios_backup.sql"
echo "   # OR run fresh migrations"
echo "   psql lexios < /workspace/lexios/backend/database/migrations/001_whatsapp_support.sql"
echo "   psql lexios < /workspace/lexios/backend/database/migrations/002_vector_embeddings.sql"
echo ""
echo "4. VERIFY CONFIGURATION"
echo "   python3 -c 'from backend.database.session import init_database; init_database()'"
echo "   # Should connect without errors"
echo ""
echo "5. START NANOCLAW"
echo "   launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist"
echo "   launchctl start com.nanoclaw"
echo ""
echo "6. VERIFY SERVICES"
echo "   # Check NanoClaw status"
echo "   launchctl list | grep nanoclaw"
echo "   # Check logs"
echo "   tail -f ~/Library/Logs/nanoclaw/nanoclaw.log"
echo ""
echo "============================================"
echo "Migration complete!"
echo "============================================"
