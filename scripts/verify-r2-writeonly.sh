#!/usr/bin/env bash
set -euo pipefail

# Verification script for R2 write-only token
# Tests that r2-backup-writeonly can write but cannot delete

REMOTE="r2-backup-writeonly"
BUCKET="nanoclaw-backup"
TEST_FILE="/tmp/nanoclaw-r2-test-$$.txt"
TEST_PATH="security-test/verify-writeonly-$$.txt"

echo "=== R2 Write-Only Token Verification ==="
echo ""

# Check if remote exists
if ! rclone listremotes | grep -q "^${REMOTE}:"; then
    echo "FAIL: Remote '${REMOTE}' not found in rclone config"
    echo "   Run: rclone config to create it"
    exit 1
fi
echo "PASS: Remote '${REMOTE}' exists in rclone config"

# Test 1: Can write?
echo "test data $(date)" > "$TEST_FILE"
if rclone copy "$TEST_FILE" "${REMOTE}:${BUCKET}/${TEST_PATH}" --quiet 2>/dev/null; then
    echo "PASS: Write test (can upload objects)"
else
    echo "FAIL: Cannot write to bucket (check token permissions)"
    rm -f "$TEST_FILE"
    exit 1
fi

# Test 2: Can list?
if rclone ls "${REMOTE}:${BUCKET}/security-test/" --max-depth 1 >/dev/null 2>&1; then
    echo "PASS: List test (can enumerate objects)"
else
    echo "FAIL: Cannot list bucket contents"
    rm -f "$TEST_FILE"
    exit 1
fi

# Test 3: Cannot delete?
if rclone delete "${REMOTE}:${BUCKET}/${TEST_PATH}" --quiet 2>/dev/null; then
    echo "FAIL: Delete test FAILED - token has delete permission!"
    echo "   This token is NOT write-only. Recreate with restricted permissions."
    rm -f "$TEST_FILE"
    exit 1
else
    echo "PASS: Delete test (delete correctly denied)"
fi

# Cleanup
rm -f "$TEST_FILE"

echo ""
echo "=== All Tests Passed ==="
echo "The '${REMOTE}' token is correctly configured as write-only."
echo "It can upload and list objects but cannot delete them."
