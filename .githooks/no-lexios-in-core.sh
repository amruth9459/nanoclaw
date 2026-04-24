#!/bin/bash
# Pre-commit hook: prevent integration-specific terms from leaking into core files.
# Core files must go through src/integration-types.ts hooks instead.

BLOCKED_TERMS='lexios|claw-lexios|ezdxf|ifcopenshell|lexios-prep|jyotish'

# Core files to scan (staged diffs only)
CORE_PATTERNS=(
  'src/*.ts'
  'container/Dockerfile'
  'container/agent-runner/src/ipc-mcp-stdio.ts'
)

# Excluded paths (integration boundary files are allowed)
EXCLUDE_PATTERNS='src/integrations/|container/skills/|scripts/|groups/|docs/|\.githooks/'

errors=0
for pattern in "${CORE_PATTERNS[@]}"; do
  for file in $(git diff --cached --name-only -- "$pattern" 2>/dev/null); do
    # Skip excluded paths
    echo "$file" | grep -qE "$EXCLUDE_PATTERNS" && continue

    # Check staged diff for blocked terms
    matches=$(git diff --cached -U0 -- "$file" | grep -E '^\+' | grep -iE "$BLOCKED_TERMS" || true)
    if [ -n "$matches" ]; then
      echo "ERROR: Integration-specific term found in core file: $file"
      echo "$matches"
      echo ""
      errors=$((errors + 1))
    fi
  done
done

if [ $errors -gt 0 ]; then
  echo "---"
  echo "Core files must not reference integration-specific names."
  echo "Add hooks to src/integration-types.ts instead."
  echo "Allowed locations: src/integrations/, container/skills/, scripts/, groups/, docs/"
  exit 1
fi
