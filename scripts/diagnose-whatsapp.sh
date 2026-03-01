#!/bin/bash
# WhatsApp Diagnostic Tool
# Checks common WhatsApp issues and provides recommendations

echo "🔍 NanoClaw WhatsApp Diagnostic"
echo "================================"
echo ""

# Check if process is running
echo "1️⃣ Process Status"
if pgrep -f "nanoclaw.*dist" > /dev/null; then
    echo "✅ NanoClaw process is running"
    ps aux | grep -E "nanoclaw.*dist" | grep -v grep
else
    echo "❌ NanoClaw process NOT running"
    echo "   → Start with: launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist"
fi
echo ""

# Check auth state
echo "2️⃣ WhatsApp Auth State"
if [ -f "/workspace/project/store/auth_info_baileys/creds.json" ]; then
    echo "✅ Auth credentials found"
    echo "   Last modified: $(stat -f "%Sm" /workspace/project/store/auth_info_baileys/creds.json)"
else
    echo "❌ No auth credentials"
    echo "   → Need to scan QR code again"
fi
echo ""

# Check database
echo "3️⃣ Database Status"
if [ -f "/workspace/project/store/nanoclaw.db" ]; then
    SIZE=$(du -h /workspace/project/store/nanoclaw.db | cut -f1)
    echo "✅ Database exists ($SIZE)"

    # Check message count
    MSG_COUNT=$(sqlite3 /workspace/project/store/nanoclaw.db "SELECT COUNT(*) FROM messages" 2>/dev/null || echo "N/A")
    echo "   Messages in DB: $MSG_COUNT"

    # Check last message time
    LAST_MSG=$(sqlite3 /workspace/project/store/nanoclaw.db "SELECT timestamp FROM messages ORDER BY timestamp DESC LIMIT 1" 2>/dev/null || echo "N/A")
    echo "   Last message: $LAST_MSG"
else
    echo "❌ Database not found"
fi
echo ""

# Check recent logs
echo "4️⃣ Recent Log Activity"
if [ -f ~/nanoclaw-logs/nanoclaw.log ]; then
    echo "Last 5 log entries:"
    tail -5 ~/nanoclaw-logs/nanoclaw.log | sed 's/^/   /'

    echo ""
    echo "Recent errors:"
    tail -100 ~/nanoclaw-logs/nanoclaw.log | grep -i "error\|fail\|warn" | tail -5 | sed 's/^/   /'
else
    echo "⚠️  Log file not found at ~/nanoclaw-logs/nanoclaw.log"
fi
echo ""

# Check port usage
echo "5️⃣ Port Usage (Baileys typically uses random ports)"
PORTS=$(lsof -nP -iTCP -sTCP:ESTABLISHED | grep -i node | wc -l | xargs)
echo "   Active Node.js connections: $PORTS"
echo ""

# Check memory
echo "6️⃣ Memory Usage"
ps aux | grep -E "nanoclaw.*dist" | grep -v grep | awk '{print "   RSS: " $6/1024 " MB, VSZ: " $5/1024 " MB"}'
echo ""

# Check last container run
echo "7️⃣ Last Container Run"
LAST_CONTAINER=$(ls -t /workspace/project/groups/main/logs/*.log 2>/dev/null | head -1)
if [ -n "$LAST_CONTAINER" ]; then
    echo "   File: $(basename $LAST_CONTAINER)"
    grep "Duration:" $LAST_CONTAINER | sed 's/^/   /'
    grep "Exit Code:" $LAST_CONTAINER | sed 's/^/   /'
else
    echo "   No container logs found"
fi
echo ""

# Common issues and fixes
echo "🔧 Common Issues & Fixes"
echo "========================"
echo ""
echo "Issue: Connection keeps dropping"
echo "  → Check internet stability"
echo "  → Restart: launchctl unload + load"
echo "  → Clear auth: rm -rf store/auth_info_baileys && restart"
echo ""
echo "Issue: Messages arrive but no response"
echo "  → Check logs for errors"
echo "  → Verify trigger word matches (check CLAUDE.md)"
echo "  → Check if message is from registered group"
echo ""
echo "Issue: Slow responses"
echo "  → Check container logs for timeouts"
echo "  → Monitor memory usage (above)"
echo "  → Check API rate limits"
echo ""
echo "Issue: QR code needed frequently"
echo "  → WhatsApp session expired (normal after 14 days inactive)"
echo "  → Re-scan QR code"
echo "  → Check if phone is online"
echo ""

# Recommendations
echo "📋 Quick Checks"
echo "==============="
echo "1. Is your phone connected to internet?"
echo "2. Is WhatsApp active on phone?"
echo "3. Did you log out of WhatsApp Web elsewhere?"
echo "4. Check ~/nanoclaw-logs/nanoclaw.log for details"
echo ""
