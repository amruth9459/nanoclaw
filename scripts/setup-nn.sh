#!/bin/bash
# One-time setup for NN server access on any machine.
# Run: curl -sL <your-hosted-url> | bash
# Or: bash ~/nanoclaw/scripts/setup-nn.sh

set -e

echo "Setting up NN server access..."

# 1. Install nn command
sudo tee /usr/local/bin/nn > /dev/null << 'SCRIPT'
#!/bin/bash
ssh -o StrictHostKeyChecking=accept-new -i ~/.ssh/id_rsa "Nutrition Nest@100.103.37.17" "$@"
SCRIPT
sudo chmod +x /usr/local/bin/nn

# 2. Add host key
ssh-keyscan 100.103.37.17 >> ~/.ssh/known_hosts 2>/dev/null

# 3. Claude Code global instructions
mkdir -p ~/.claude
if ! grep -q "NN Server" ~/.claude/CLAUDE.md 2>/dev/null; then
  cat >> ~/.claude/CLAUDE.md << 'CLAUDE'

## Remote Servers

### NN Server (Nutrition Nest)
- **Trigger phrases**: "connect to NN", "run on NN", "NN server", "Nutrition Nest"
- **Command**: `nn "<powershell command>"` — runs commands on the NN server via SSH
- **Fallback** (if `nn` not installed): `ssh -i ~/.ssh/id_rsa "Nutrition Nest@100.103.37.17" "<command>"`
- **Host**: 100.103.37.17 (Tailscale), Windows, hostname `NN-Server`
- **Shell**: PowerShell — use `;` not `&&` to chain commands
- **Examples**: `nn "hostname"`, `nn "Get-ChildItem C:\Users"`, `nn "Get-Process | Select -First 5"`
CLAUDE
fi

# 4. Codex instructions
mkdir -p ~/.codex
if ! grep -q "NN Server" ~/.codex/instructions.md 2>/dev/null; then
  cat >> ~/.codex/instructions.md << 'CODEX'

## Remote Servers

### NN Server (Nutrition Nest)
When asked to "connect to NN", "run on NN", or "Nutrition Nest": use `nn "<powershell command>"`.
Host: 100.103.37.17 (Tailscale), Windows, PowerShell. Use `;` not `&&` to chain commands.
CODEX
fi

# 5. GitHub Copilot instructions
mkdir -p ~/.github
if ! grep -q "NN Server" ~/.github/copilot-instructions.md 2>/dev/null; then
  cat >> ~/.github/copilot-instructions.md << 'COPILOT'

## Remote Servers

### NN Server (Nutrition Nest)
When asked to "connect to NN", "run on NN", or "Nutrition Nest": use `nn "<powershell command>"`.
Host: 100.103.37.17 (Tailscale), Windows, PowerShell. Use `;` not `&&` to chain commands.
COPILOT
fi

echo ""
echo "Done! Prerequisites:"
echo "  1. Tailscale connected (for 100.103.37.17)"
echo "  2. SSH key (~/.ssh/id_rsa) authorized on NN server"
echo ""
echo "Test: nn \"hostname\""
