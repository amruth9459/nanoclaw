#!/bin/bash
# ollama-query — Query a local Ollama model via host IPC
#
# Usage:
#   ollama-query --model <model> --prompt <prompt>
#   ollama-query --model <model> --prompt <prompt> --system <system_prompt>
#   ollama-query --model <model> --prompt <prompt> --image /path/to/image.jpg
#
# Examples:
#   ollama-query --model huihui_ai/qwen3-vl-abliterated:8b --prompt "Explain quantum computing"
#   ollama-query --model huihui_ai/qwen3-vl-abliterated:8b --prompt "What's in this image?" --image /workspace/media/photo.jpg

set -euo pipefail

MODEL=""
PROMPT=""
SYSTEM=""
IMAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --system) SYSTEM="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$MODEL" || -z "$PROMPT" ]]; then
  echo "Usage: ollama-query --model <model> --prompt <prompt> [--system <system>] [--image <path>]" >&2
  exit 1
fi

IPC_DIR="/workspace/ipc/tasks"
TS=$(date +%s%N)
REQ_FILE="${IPC_DIR}/ollama_${TS}.json"
RESP_FILE="/workspace/ipc/messages/ollama_${TS}.response.json"

# Build JSON payload
PAYLOAD=$(python3 -c "
import json, sys, base64

model = sys.argv[1]
prompt = sys.argv[2]
system = sys.argv[3]
image_path = sys.argv[4]
resp_file = sys.argv[5]

d = {
    'type': 'ollama_query',
    'model': model,
    'prompt': prompt,
    'responseFile': resp_file,
}
if system:
    d['system'] = system
if image_path:
    with open(image_path, 'rb') as f:
        data = base64.b64encode(f.read()).decode()
    ext = image_path.rsplit('.', 1)[-1].lower()
    mime = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp'}.get(ext, 'image/jpeg')
    d['images'] = [f'data:{mime};base64,{data}']

print(json.dumps(d))
" "$MODEL" "$PROMPT" "$SYSTEM" "$IMAGE" "$RESP_FILE")

echo "$PAYLOAD" > "$REQ_FILE"

# Poll for response (max 120s)
for i in $(seq 1 240); do
  if [[ -f "$RESP_FILE" ]]; then
    cat "$RESP_FILE"
    rm -f "$RESP_FILE"
    exit 0
  fi
  sleep 0.5
done

echo '{"error":"Timeout waiting for Ollama response after 120s"}' >&2
exit 1
