#!/usr/bin/env bash
# MLX Local Model Server
# Serves Qwen 2.5 7B via OpenAI-compatible API on port 8800
# Managed by launchd: com.nanoclaw.mlx-server

set -euo pipefail

export PATH="/Users/amrut/.local/bin:$PATH"

MODEL="${MLX_MODEL:-mlx-community/Qwen2.5-7B-Instruct-4bit}"
HOST="${MLX_HOST:-127.0.0.1}"
PORT="${MLX_PORT:-8800}"

exec mlx_lm.server \
  --model "$MODEL" \
  --host "$HOST" \
  --port "$PORT"
