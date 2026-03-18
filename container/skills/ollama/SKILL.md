# Ollama — Local Uncensored LLM

Query local Ollama models running on the host Mac via IPC.

## Available Models

Run `ollama-query --model list` or check with the user. Key models:

| Model | Size | Notes |
|-------|------|-------|
| `huihui_ai/qwen3-vl-abliterated:8b` | 6.1GB | **Uncensored** Qwen3-VL 8B — text + images, no refusals |
| `huihui_ai/qwen3-vl-abliterated:32b` | 21GB | **Uncensored** Qwen3-VL 32B — more capable, slower |
| `qwen3-vl:8b` | 6.1GB | Standard (censored) Qwen3-VL 8B |
| `qwen3-vl:32b` | 20GB | Standard (censored) Qwen3-VL 32B |
| `deepseek-coder-v2:latest` | 8.9GB | Code specialist |

## Usage

```bash
# Text query
ollama-query --model huihui_ai/qwen3-vl-abliterated:8b --prompt "Your question here"

# With system prompt
ollama-query --model huihui_ai/qwen3-vl-abliterated:8b \
  --system "You are a security researcher" \
  --prompt "Explain SQL injection"

# With image (multimodal)
ollama-query --model huihui_ai/qwen3-vl-abliterated:8b \
  --prompt "What's in this image?" \
  --image /workspace/media/photo.jpg
```

## Response Format

Returns JSON:
```json
{"response": "...", "model": "huihui_ai/qwen3-vl-abliterated:8b"}
```
or on error:
```json
{"error": "Ollama unavailable: ..."}
```

## Parsing the Response

```bash
result=$(ollama-query --model huihui_ai/qwen3-vl-abliterated:8b --prompt "Hello")
text=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('response') or d.get('error',''))")
echo "$text"
```

## Notes

- Ollama runs locally on host Mac (not the container) — queries go via IPC
- Max timeout: 120 seconds per query
- The abliterated models have safety filtering removed — use responsibly
- For sensitive tasks, prefer the abliterated variants over standard models
