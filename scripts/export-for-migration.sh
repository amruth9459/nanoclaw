#!/usr/bin/env bash
# NanoClaw Migration Export Script
# Creates a complete backup package for migrating to a new Mac
#
# Usage:
#   ./scripts/export-for-migration.sh [output-path]
#
# Default output: ~/Desktop/nanoclaw-migration-[timestamp].tar.gz

set -euo pipefail

cd "$(dirname "$0")/.."

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT_PATH="${1:-$HOME/Desktop/nanoclaw-migration-$TIMESTAMP.tar.gz}"
TEMP_DIR=$(mktemp -d)
EXPORT_DIR="$TEMP_DIR/nanoclaw-export"

echo "==> Creating NanoClaw migration package..."
echo "    Output: $OUTPUT_PATH"
echo ""

# Create export directory structure
mkdir -p "$EXPORT_DIR"

echo "📦 Copying codebase..."
rsync -a \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'logs/*.log' \
  --exclude '.git' \
  --exclude 'container/agent-container' \
  --exclude 'data/sessions/*/agent-*' \
  ./ "$EXPORT_DIR/"

echo "💾 Backing up critical data..."

# WhatsApp session data (authentication state)
echo "  → WhatsApp sessions"
mkdir -p "$EXPORT_DIR/data/sessions"
if [ -d "data/sessions" ]; then
  rsync -a data/sessions/ "$EXPORT_DIR/data/sessions/"
fi

# SQLite database
echo "  → SQLite database"
mkdir -p "$EXPORT_DIR/store"
if [ -f "store/nanoclaw.db" ]; then
  cp store/nanoclaw.db "$EXPORT_DIR/store/"
fi
if [ -f "store/nanoclaw.db-wal" ]; then
  cp store/nanoclaw.db-wal "$EXPORT_DIR/store/" 2>/dev/null || true
fi
if [ -f "store/nanoclaw.db-shm" ]; then
  cp store/nanoclaw.db-shm "$EXPORT_DIR/store/" 2>/dev/null || true
fi

# Group configurations and memory
echo "  → Group configurations"
mkdir -p "$EXPORT_DIR/groups"
if [ -d "groups" ]; then
  rsync -a \
    --exclude '*.pyc' \
    --exclude '__pycache__' \
    --exclude 'node_modules' \
    --exclude '.DS_Store' \
    groups/ "$EXPORT_DIR/groups/"
fi

# Environment variables
echo "  → Environment configuration"
if [ -f ".env" ]; then
  cp .env "$EXPORT_DIR/"
fi

# Container configuration
echo "  → Container setup"
if [ -d "container" ]; then
  rsync -a \
    --exclude 'agent-container' \
    container/ "$EXPORT_DIR/container/"
fi

# Create migration instructions
cat > "$EXPORT_DIR/MIGRATION_INSTRUCTIONS.md" << 'EOF'
# NanoClaw Migration to Mac Studio

## Quick Migration (5 minutes)

### Step 1: Transfer Package
Copy this entire folder to your Mac Studio:
```bash
# On Mac Studio, extract:
tar -xzf nanoclaw-migration-*.tar.gz
cd nanoclaw-export
```

### Step 2: Install Dependencies
```bash
# Install Node.js 20+ if not installed
# Install Homebrew if not installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Docker Desktop or Apple Container
brew install --cask docker
# OR for Apple Container:
# brew tap apple/apple
# brew install apple-container
```

### Step 3: Restore NanoClaw
```bash
# Install npm dependencies
npm install

# Build TypeScript
npm run build

# Build container
./container/build.sh

# Setup launchd service
cp launchd/com.nanoclaw.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Start service
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"
```

### Step 4: Verify
```bash
# Check logs
tail -f logs/nanoclaw.log

# Test WhatsApp connection
# Send a message to yourself with @Claw
```

## What's Included

✅ **Complete Codebase**
- All source code (`src/`)
- All scripts
- Container configuration
- Skills and utilities

✅ **Critical Data**
- WhatsApp session authentication
- SQLite database (messages, groups, state)
- Group configurations and memory
- Environment variables (.env)

✅ **Configuration**
- launchd plist file
- Container setup
- All user customizations

## What's NOT Included (Rebuilt on New Mac)

❌ `node_modules/` - Reinstalled via `npm install`
❌ `dist/` - Rebuilt via `npm run build`
❌ Container image - Rebuilt via `./container/build.sh`
❌ Old logs - Fresh logs on new machine

## Troubleshooting

**WhatsApp won't connect:**
1. Check `logs/nanoclaw.log` for errors
2. Delete `data/sessions/main/` and re-authenticate:
   ```bash
   npm run auth
   ```

**Service won't start:**
1. Check service status:
   ```bash
   launchctl list | grep nanoclaw
   ```
2. Check logs:
   ```bash
   tail -50 logs/nanoclaw.log
   ```

**Container build fails:**
1. Ensure Docker Desktop is running
2. Rebuild container:
   ```bash
   ./container/build.sh
   ```

## Migration Checklist

- [ ] Extract migration package on Mac Studio
- [ ] Install Node.js 20+
- [ ] Install Docker Desktop (or Apple Container)
- [ ] Run `npm install`
- [ ] Run `npm run build`
- [ ] Run `./container/build.sh`
- [ ] Copy launchd plist to ~/Library/LaunchAgents/
- [ ] Load launchd service
- [ ] Verify logs show clean startup
- [ ] Test WhatsApp message to self
- [ ] Verify Vantage Intelligence workspace is accessible
- [ ] Test scheduled tasks still running

## Complete Migration Time

**Total:** ~10-15 minutes
- Transfer: 2 minutes
- Dependencies: 3 minutes
- Build: 3 minutes
- Service setup: 2 minutes
- Verification: 2 minutes

## Support

If migration fails, check Discord or run `/debug` in Claude Code.

EOF

# Create verification script
cat > "$EXPORT_DIR/verify-migration.sh" << 'EOF'
#!/usr/bin/env bash
# Verify NanoClaw migration was successful

set -euo pipefail

echo "==> Verifying NanoClaw migration..."
echo ""

ERRORS=0

# Check Node.js
if command -v node >/dev/null 2>&1; then
  NODE_VERSION=$(node -v)
  echo "✅ Node.js: $NODE_VERSION"
else
  echo "❌ Node.js not installed"
  ERRORS=$((ERRORS + 1))
fi

# Check npm dependencies
if [ -d "node_modules" ]; then
  echo "✅ npm dependencies installed"
else
  echo "❌ npm dependencies missing (run: npm install)"
  ERRORS=$((ERRORS + 1))
fi

# Check built files
if [ -d "dist" ]; then
  echo "✅ TypeScript compiled"
else
  echo "❌ Build missing (run: npm run build)"
  ERRORS=$((ERRORS + 1))
fi

# Check container
if command -v docker >/dev/null 2>&1; then
  if docker images | grep -q nanoclaw-agent; then
    echo "✅ Container image built"
  else
    echo "⚠️  Container image missing (run: ./container/build.sh)"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "⚠️  Docker not running (or using Apple Container)"
fi

# Check database
if [ -f "store/nanoclaw.db" ]; then
  echo "✅ Database present"
else
  echo "❌ Database missing"
  ERRORS=$((ERRORS + 1))
fi

# Check environment
if [ -f ".env" ]; then
  echo "✅ Environment configured"
else
  echo "❌ .env missing"
  ERRORS=$((ERRORS + 1))
fi

# Check launchd service
if launchctl list | grep -q com.nanoclaw; then
  echo "✅ Service loaded"
else
  echo "⚠️  Service not loaded (run: launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist)"
fi

# Check recent logs
if [ -f "logs/nanoclaw.log" ]; then
  echo "✅ Logs present"
  echo ""
  echo "Recent log entries:"
  tail -5 logs/nanoclaw.log | sed 's/^/  /'
else
  echo "⚠️  No logs yet (service may not have started)"
fi

echo ""
if [ $ERRORS -eq 0 ]; then
  echo "🎉 Migration verified! NanoClaw is ready."
else
  echo "❌ $ERRORS issues found. Check instructions above."
  exit 1
fi

EOF
chmod +x "$EXPORT_DIR/verify-migration.sh"

# Create quick restore script
cat > "$EXPORT_DIR/restore.sh" << 'EOF'
#!/usr/bin/env bash
# One-command NanoClaw restoration
# Run this on your Mac Studio after extracting the migration package

set -euo pipefail

echo "==> NanoClaw Quick Restore"
echo "    This will set up NanoClaw on your new Mac"
echo ""

# Check for Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js not found. Install it first:"
  echo "   brew install node@20"
  exit 1
fi

# Check for container runtime
if ! command -v docker >/dev/null 2>&1; then
  echo "⚠️  Docker not found. Install Docker Desktop:"
  echo "   brew install --cask docker"
  echo ""
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

echo "📦 Installing dependencies..."
npm install

echo "🔨 Building TypeScript..."
npm run build

echo "🐳 Building container..."
./container/build.sh

echo "⚙️  Setting up service..."
cp launchd/com.nanoclaw.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null || true

echo "🚀 Starting NanoClaw..."
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"

sleep 3

echo ""
echo "✅ Restoration complete!"
echo ""
echo "Check logs:"
echo "  tail -f logs/nanoclaw.log"
echo ""
echo "Verify migration:"
echo "  ./verify-migration.sh"

EOF
chmod +x "$EXPORT_DIR/restore.sh"

echo ""
echo "📦 Creating archive..."
cd "$TEMP_DIR"
tar -czf "$OUTPUT_PATH" nanoclaw-export/

# Cleanup
rm -rf "$TEMP_DIR"

echo ""
echo "✅ Migration package created!"
echo ""
echo "📍 Location: $OUTPUT_PATH"
echo "📦 Size: $(du -h "$OUTPUT_PATH" | cut -f1)"
echo ""
echo "🚀 On your Mac Studio, run:"
echo "   tar -xzf nanoclaw-migration-*.tar.gz"
echo "   cd nanoclaw-export"
echo "   ./restore.sh"
echo ""
