# Universal AI Router

Production-ready routing system that intelligently routes tasks to optimal AI models based on complexity, cost, and quality requirements.

## Quick Start

```typescript
import { RouterFactory } from './router/index.js';

// Create router
const router = RouterFactory.create();

// Define context
const context = {
  taskType: 'conversation',
  userTier: 'internal',
  costBudget: 'zero',
  qualityNeeds: 'good',
  latencyNeeds: 'fast',
  source: 'whatsapp',
};

// Get routing decision
const decision = await router.route(context);
console.log(`Route to: ${decision.modelId}`);

// Execute with fallback
const { result } = await router.execute(context, async (modelId) => {
  return await runInference(modelId, prompt);
});
```

## Features

- ✅ **90% cost reduction** by using local models
- ✅ **6x faster** response times for simple tasks
- ✅ **Automatic fallback** with tier escalation
- ✅ **Quality preservation** for critical tasks
- ✅ **Real-time metrics** and monitoring
- ✅ **Domain-specific routers** (Lexios, OSHA, etc.)

## Architecture

```
Router → Classifier → Rules → Selector → Model
                                ↓
                          Fallback Handler
                                ↓
                        Performance Tracker
```

## Models Supported

### Local (Mac Studio via MLX)
- Qwen 2.5 7B (text, fast)
- Qwen 2.5 VL 7B (vision, fast)
- Llama 3.3 70B (reasoning)
- Qwen 2.5 VL 72B (vision, accurate)

### Cloud (API)
- Claude Opus 4.6 (best reasoning)
- Claude Sonnet 4.6 (best code)
- Gemini 3 Flash (fast vision)
- GPT-4o (fallback)

## File Structure

```
src/router/
├── universal-router.ts      # Main router engine + RouterFactory
├── production-wiring.ts     # buildProductionRouter — heterogeneous attach + graceful fallback
├── heterogeneous-router.ts  # SLM-first orchestrator (ensemble voting, confidence-gated fallback)
├── slm-host-runtime.ts      # Host singletons (tracker, registry, backend, download planner, dashboard)
├── task-classifier.ts       # Task analysis & classification
├── model-selector.ts        # Model selection logic + ModelRegistry
├── routing-rules.ts         # Configurable routing rules
├── fallback-handler.ts      # Failure handling & retry
├── performance-tracker.ts   # Metrics collection
├── types.ts                 # TypeScript types
├── index.ts                 # Public exports
├── backends/
│   ├── mlx-backend.ts       # MLX integration (assumes a running OpenAI-compatible server)
│   └── llama-cpp.ts         # llama.cpp lifecycle (lazy spawn, HITL-gated download)
└── monitoring/
    ├── router-metrics.ts    # Router metrics & SlmUsageTracker
    └── slm-dashboard.ts     # SLM usage dashboard (cost savings / fallback / distribution)
```

## Heterogeneous SLM Router (Production Wiring)

The SLM Integration Experiment validated an **SLM-first** fast path: eligible
tasks (intent / sentiment / summarize / extract) run on fine-tuned local Small
Language Models for **$0**, with confidence-gated escalation to a larger model
only when the specialists are low-confidence or disagree. Classification tasks
fuse multiple specialists with **ensemble voting**; the useful diversity comes
from *different post-training*, not raw scale.

Production wiring lives in `production-wiring.ts` and is invoked once at boot in
`src/index.ts`:

```typescript
import { buildProductionRouter } from './router/production-wiring.js';
import { getSlmUsageTracker } from './router/slm-host-runtime.js';

const wiring = buildProductionRouter({ tracker: getSlmUsageTracker() });
router = wiring.router;
// wiring.heterogeneousEnabled — true if specialists were attached
// wiring.wiredSpecialists    — { intent: 'slm-intent', ... } for present models
// wiring.missingModels       — env-configured paths whose GGUF was not found
// wiring.fallbackReason      — why it fell back (when heterogeneous disabled)
```

**Graceful degradation is the headline property.** `buildProductionRouter`:

1. Reads the `NANOCLAW_SLM_*_MODEL` env vars (below) for fine-tuned GGUF paths.
2. Registers a synthetic `local-llamacpp` model per configured task.
3. Presence-checks each GGUF on disk (`LlamaCppBackend.isModelPresent`).
4. Attaches a `HeterogeneousRouter` with the **present** specialists, OR
5. Falls back to `RouterFactory.createProduction()` (standard router) when none
   are present — with a logged reason. It **never** downloads a model or spawns
   `llama-server` at wiring time (both are lazy / HITL-gated).

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `NANOCLAW_SLM_INTENT_MODEL` | GGUF path for the intent-classification specialist |
| `NANOCLAW_SLM_SENTIMENT_MODEL` | GGUF path for the sentiment specialist |
| `NANOCLAW_SLM_SUMMARIZE_MODEL` | GGUF path for the summarization specialist |
| `NANOCLAW_SLM_EXTRACT_MODEL` | GGUF path for the structured-extraction specialist |
| `NANOCLAW_SLM_FALLBACK_MODEL` | Optional Ollama model used as the LLM escalation path |
| `NANOCLAW_MODELS_DIR` | Directory for GGUF files (default `~/.nanoclaw/models`); relative `ggufFile` resolves here |
| `OLLAMA_URL` | Ollama endpoint for the fallback model (default `http://127.0.0.1:11434`) |
| `LLAMA_SERVER_BIN` | Path to the `llama-server` executable (default `llama-server` on PATH) |
| `NANOCLAW_SLM_TOOLS` | Set to `1` to expose the container SLM MCP tools (below) |
| `QWEN2_5_0_5B_GGUF_URL`, `TINY_AYA_GGUF_URL` | Override GGUF download URLs (mirrors / air-gapped) |

Paths may be absolute (used verbatim) or relative (resolved against
`NANOCLAW_MODELS_DIR`). A single multi-task fine-tune can be pointed at by several
of these vars; a deployment may also set just one.

### Model Download Workflow (HITL-gated)

Downloading GGUF weights is large and outward-facing, so it is **never
automatic** — the rule is *no model download without human approval*.

1. **Plan, don't fetch.** The container agent calls the `slm_download_plan` MCP
   tool with a `modelId`. The host runs `LlamaCppBackend.planDownload`, which
   reports whether the GGUF is present, its approximate size and license, and any
   blocking reason. **No bytes are fetched.**
2. **Blocks enforced at planning time.** A model with a **GPL** license, or no
   verified download URL, comes back `blocked` with a reason. Non-GPL only.
3. **Human approves out-of-band.** When `approvalRequired` is true, a human
   downloads the file (or approves a host-side `downloadModel({ approved: true })`
   call, which re-checks the block reasons). `downloadModel` throws unless
   explicitly approved.
4. **Lazy serve.** Once the GGUF is on disk and an env var points at it, the next
   boot's `buildProductionRouter` wires it in; `llama-server` spawns on first use.

### Container MCP Tools (gated by `NANOCLAW_SLM_TOOLS=1`)

| Tool | Purpose |
|------|---------|
| `slm_summarize` | $0 local summarization with automatic LLM fallback |
| `slm_classify` | $0 intent / sentiment classification |
| `slm_extract` | $0 schema-constrained JSON extraction |
| `slm_savings` | SLM usage dashboard — cost savings, fallback rate, task/model distribution |
| `slm_download_plan` | HITL-gated download **planning** (never downloads) |

All route over IPC to host handlers in `src/ipc.ts`; usage flows into the shared
`SlmUsageTracker`, surfaced via `slm-dashboard.ts`.

## Configuration

Default config at `/workspace/project/config/router-config.json`:

```json
{
  "defaultTier": "local-slm",
  "costOptimization": true,
  "fallbackEnabled": true,
  "models": { ... },
  "routingRules": { ... }
}
```

## Examples

See `/workspace/group/ROUTER_INTEGRATION_EXAMPLES.md` for complete examples.

### Simple Conversation

```typescript
const decision = await router.route({
  taskType: 'conversation',
  userTier: 'internal',
  costBudget: 'zero',
  qualityNeeds: 'good',
  latencyNeeds: 'fast',
  source: 'whatsapp',
});
// Result: qwen2.5-7b (local-slm)
```

### Vision Analysis

```typescript
const decision = await router.route({
  taskType: 'vision',
  userTier: 'internal',
  costBudget: 'zero',
  qualityNeeds: 'good',
  latencyNeeds: 'fast',
  source: 'lexios',
  hasMedia: true,
});
// Result: qwen2.5-vl-7b (local-slm)
```

### Complex Reasoning

```typescript
const decision = await router.route({
  taskType: 'reasoning',
  userTier: 'internal',
  costBudget: 'limited',
  qualityNeeds: 'best',
  latencyNeeds: 'fast',
  source: 'whatsapp',
});
// Result: claude-opus-4.6 (cloud)
```

## Metrics

```typescript
const metrics = router.getMetrics('24h');
console.log(`
Requests: ${metrics.totalRequests}
Success Rate: ${metrics.successRate * 100}%
Cost Saved: $${metrics.costSavedUsd}
Local Usage: ${metrics.localSlmPercentage + metrics.localLlmPercentage}%
`);
```

## Documentation

- **Overview:** `/workspace/group/UNIVERSAL_ROUTER.md`
- **Integration Examples:** `/workspace/group/ROUTER_INTEGRATION_EXAMPLES.md`
- **Migration Guide:** `/workspace/group/ROUTER_MIGRATION_GUIDE.md`
- **Cost Projections:** `/workspace/group/ROUTER_COST_PERFORMANCE_PROJECTIONS.md`

## Testing

```bash
npm test src/router/                      # full router suite
npm test src/router/integration.test.ts   # heterogeneous wiring + graceful fallback
```

## Performance

| Task | Latency | Cost |
|------|---------|------|
| Simple chat | <100ms | $0 |
| Vision analysis | <500ms | $0 |
| Complex reasoning | 2-3s | $0.03 |
| Code generation | 2s | $0.01 |

## Support

Check logs for routing decisions:
```bash
tail -f logs/nanoclaw.log | grep Router
```

View metrics:
```bash
cat /workspace/group/router-dashboard.json
```

## License

Part of NanoClaw project.
