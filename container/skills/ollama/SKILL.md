# Ollama — Local Uncensored LLM

Query local Ollama models running on the host Mac via IPC.

## Available Models

Run `ollama-query --model list` or check with the user. Key models:

| Model | Size | Best For | Notes |
|-------|------|----------|-------|
| `gemma4:26b` | 18GB | Reasoning, vision, code | Google Gemma 4 MoE — multimodal, 256K context, best reasoning locally |
| `gemma4:31b` | 20GB | Quality-critical tasks | Dense 31B — slightly more capable, slower |
| `glm-4.7-flash` | 5GB | Fast agentic loops | ZhipuAI 30B MoE/3B active — 200K context, very fast |
| `huihui_ai/qwen3-vl-abliterated:8b` | 6.1GB | Uncensored tasks | **Uncensored** Qwen3-VL 8B — text + images, no refusals |
| `huihui_ai/qwen3-vl-abliterated:32b` | 21GB | Uncensored + capable | **Uncensored** Qwen3-VL 32B — more capable, slower |
| `qwen3-vl:8b` | 6.1GB | Vision (standard) | Standard Qwen3-VL 8B |
| `qwen3-vl:32b` | 20GB | Vision (standard) | Standard Qwen3-VL 32B |
| `qwen2.5-coder:latest` | 4.7GB | Code generation | Fast coding specialist |
| `deepseek-coder-v2:latest` | 8.9GB | Complex code | Larger code specialist |
| `llama3:latest` | 4.7GB | General purpose | Meta Llama 3 8B |

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
