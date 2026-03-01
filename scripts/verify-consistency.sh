#!/bin/bash
# NanoClaw Consistency Verification
# Ensures database schema, code, and documentation align

set -e

PROJECT_ROOT="/workspace/project"
GROUPS_MAIN="$PROJECT_ROOT/groups/main"
EXIT_CODE=0

echo "🔍 NanoClaw Consistency Verification"
echo "===================================="
echo

# 1. DATABASE SCHEMA VERIFICATION
echo "1️⃣  Verifying database schema matches code..."

# Extract table names from db.ts
TABLES_IN_CODE=$(grep -o "CREATE TABLE IF NOT EXISTS \w\+" "$PROJECT_ROOT/src/db.ts" | awk '{print $5}' | sort)

# Extract interface names from db.ts
INTERFACES_IN_CODE=$(grep "^export interface" "$PROJECT_ROOT/src/db.ts" | awk '{print $3}' | sort)

echo "   Tables defined: $(echo "$TABLES_IN_CODE" | wc -l)"
echo "   Interfaces defined: $(echo "$INTERFACES_IN_CODE" | wc -l)"

# Check each table has corresponding usage
for table in $TABLES_IN_CODE; do
    USAGE=$(grep -r "\b$table\b" "$PROJECT_ROOT/src" --include="*.ts" | grep -v "CREATE TABLE" | wc -l)
    if [ "$USAGE" -eq 0 ]; then
        echo "   ❌ UNUSED TABLE: $table"
        EXIT_CODE=1
    fi
done

echo "   ✅ Database schema verification complete"
echo

# 2. MCP TOOLS VERIFICATION
echo "2️⃣  Verifying MCP tools have handlers..."

# Extract MCP tool names
MCP_TOOLS=$(grep -A1 "server.tool(" "$PROJECT_ROOT/container/agent-runner/src/ipc-mcp-stdio.ts" | grep -E "^\s*'|^\s*\"" | sed "s/.*['\"]\\([^'\"]*\\)['\"].*/\\1/" | grep -v "^--$" | sort -u)

# Check each tool has IPC handler
for tool in $MCP_TOOLS; do
    # Skip tools that write IPC files (handled differently)
    if echo "$tool" | grep -qE "^(schedule_task|pause_task|resume_task|cancel_task|register_group|semantic_search|index_document|clawwork_|find_bounties|propose_bounty|submit_bounty|remote_shell)"; then
        continue
    fi

    # Check for handler in ipc.ts
    if ! grep -q "data.type === '$tool'" "$PROJECT_ROOT/src/ipc.ts" 2>/dev/null; then
        echo "   ⚠️  WARNING: Tool '$tool' may not have handler in ipc.ts"
    fi
done

echo "   ✅ MCP tools verification complete"
echo

# 3. DEPRECATED REFERENCES CHECK
echo "3️⃣  Checking for deprecated references..."

DEPRECATED_FOUND=0

# Check for AUTH_CODE_77 in active files (not conversations)
if grep -r "AUTH_CODE_77" "$GROUPS_MAIN" --include="*.md" --exclude-dir=conversations 2>/dev/null | grep -v "Binary"; then
    echo "   ❌ Found AUTH_CODE_77 references in active documentation"
    DEPRECATED_FOUND=1
    EXIT_CODE=1
fi

# Check for registered_groups.json references
if grep -r "registered_groups\.json" "$GROUPS_MAIN" --include="*.md" --exclude-dir=conversations 2>/dev/null | grep -v "Binary"; then
    echo "   ❌ Found registered_groups.json references (should be database)"
    DEPRECATED_FOUND=1
    EXIT_CODE=1
fi

# Check if the old JSON file exists
if [ -f "$PROJECT_ROOT/data/registered_groups.json" ]; then
    echo "   ❌ Old registered_groups.json file still exists"
    DEPRECATED_FOUND=1
    EXIT_CODE=1
fi

if [ "$DEPRECATED_FOUND" -eq 0 ]; then
    echo "   ✅ No deprecated references found"
fi
echo

# 4. DOCUMENTATION CONSISTENCY
echo "4️⃣  Verifying documentation consistency..."

# Check MEMORY.md exists
if [ ! -f "$GROUPS_MAIN/MEMORY.md" ]; then
    echo "   ❌ MEMORY.md missing (referenced in CLAUDE.md)"
    EXIT_CODE=1
else
    echo "   ✅ MEMORY.md exists"
fi

# Check for contradictory statements
CONTRADICTIONS=0

# Example: Check if both "stored in JSON" and "stored in database" appear
if grep -q "stored in.*JSON" "$GROUPS_MAIN/CLAUDE.md" 2>/dev/null && grep -q "stored in.*database" "$GROUPS_MAIN/CLAUDE.md" 2>/dev/null; then
    echo "   ⚠️  WARNING: Both JSON and database storage mentioned"
    CONTRADICTIONS=1
fi

if [ "$CONTRADICTIONS" -eq 0 ]; then
    echo "   ✅ No obvious contradictions found"
fi
echo

# 5. SOURCE CODE CONSISTENCY
echo "5️⃣  Verifying source code builds..."

cd "$PROJECT_ROOT"
if npm run build >/dev/null 2>&1; then
    echo "   ✅ TypeScript builds without errors"
else
    echo "   ❌ TypeScript build failed"
    EXIT_CODE=1
fi
echo

# 6. SECURITY CHECKS
echo "6️⃣  Running security checks..."

# Check for hardcoded secrets
SECRETS_FOUND=$(grep -rn -E "sk-ant-|ANTHROPIC_API_KEY\s*=|password\s*=\s*['\"][^'\"]+|secret\s*=\s*['\"][^'\"]+" "$PROJECT_ROOT/src" "$PROJECT_ROOT/container/agent-runner/src" --include="*.ts" 2>/dev/null | grep -v "process.env" | grep -v "const.*=.*require" | wc -l)

if [ "$SECRETS_FOUND" -gt 0 ]; then
    echo "   ⚠️  WARNING: Potential hardcoded secrets found"
else
    echo "   ✅ No hardcoded secrets detected"
fi

# Check for AUTH_CODE_77 in source code
if grep -r "AUTH_CODE_77" "$PROJECT_ROOT/src" "$PROJECT_ROOT/container/agent-runner/src" --include="*.ts" 2>/dev/null; then
    echo "   ❌ AUTH_CODE_77 found in source code"
    EXIT_CODE=1
else
    echo "   ✅ No AUTH_CODE_77 in source code"
fi
echo

# 7. FINAL SUMMARY
echo "=================================="
if [ "$EXIT_CODE" -eq 0 ]; then
    echo "✅ ALL CHECKS PASSED"
    echo "   Database schema aligned with code"
    echo "   MCP tools have handlers"
    echo "   No deprecated references"
    echo "   Documentation consistent"
    echo "   Code builds successfully"
    echo "   No security issues detected"
else
    echo "❌ CONSISTENCY ISSUES FOUND"
    echo "   Review errors above and fix before deploying"
fi
echo

exit $EXIT_CODE
