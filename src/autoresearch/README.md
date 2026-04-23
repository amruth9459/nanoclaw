# Autoresearch System

Autonomous improvement loops for NanoClaw agents, inspired by [awesome-autoresearch](https://github.com/alvinunreal/awesome-autoresearch).

## What is Autoresearch?

Autoresearch automates the research improvement cycle: **create → mutate → measure → decide**. Instead of manually testing whether a prompt change, config tweak, or code optimization actually improves performance, autoresearch runs the experiment loop autonomously and keeps only changes that demonstrably improve a defined fitness metric.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Orchestrator                     │
│  (concurrency, scheduling, resource management)   │
├─────────────────────────────────────────────────┤
│              Experiment Engine                     │
│  create → startRun → evaluateRun → decide         │
├──────────────┬──────────────────┬─────────────────┤
│ Fitness Lib  │  Mutation Strats │  Persistence    │
│ (measure)    │  (generate)      │  (SQLite)       │
├──────────────┴──────────────────┴─────────────────┤
│            Identity & Evidence Chain               │
│  (attribution, trust scoring, audit trail)         │
└─────────────────────────────────────────────────┘
```

## Quick Start

### From Container (MCP Tool)

```
autoresearch create --name "Prompt Optimization" \
  --fitness_metric '{"name":"accuracy","type":"maximize","unit":"score","measurement_fn":"accuracy","threshold_improvement":0.05}' \
  --mutation_strategy '{"type":"prompt_evolution","parameters":{"mutation_rate":0.3}}'

autoresearch baseline --experiment_id <id> --score 0.75

autoresearch run --experiment_id <id> \
  --variant_description "Improved system prompt" \
  --current_content "You are a helpful assistant." \
  --target "system_prompt.txt"

autoresearch analyze --experiment_id <id>
autoresearch leaderboard
```

### From Host Code

```typescript
import {
  createExperiment,
  setBaseline,
  startRun,
  evaluateRun,
  decideKeepOrRevert,
  analyzeExperiment,
} from './autoresearch/index.js';

// 1. Create experiment
const exp = await createExperiment(
  'Response Quality',
  'Optimize agent response quality via prompt evolution',
  {
    name: 'accuracy',
    type: 'maximize',
    unit: 'score',
    measurement_fn: 'accuracy',
    threshold_improvement: 0.05,
  },
  {
    type: 'prompt_evolution',
    parameters: { mutation_rate: 0.3, focus_areas: ['clarity', 'specificity'] },
  },
  agentId,
);

// 2. Set baseline
await setBaseline(exp.id, 0.72);

// 3. Run iteration
const { run, mutation } = await startRun(exp.id, agentId, 'Variant 1', currentPrompt, 'prompt.md');

// 4. Evaluate
const evaluated = await evaluateRun(run.id, { expected_output: golden, actual_output: result });

// 5. Auto-decide
const decision = await decideKeepOrRevert(exp.id, run.id);
// decision === 'keep' or 'revert'
```

## Built-in Fitness Functions

| Name | Type | Description |
|------|------|-------------|
| `latency` | minimize | Average response time from usage logs |
| `accuracy` | maximize | String similarity (Levenshtein) between expected/actual |
| `token_efficiency` | minimize | Total tokens consumed |
| `trust_score` | maximize | Agent trust score from identity system |
| `success_rate` | maximize | Success ratio from evidence chain |
| `custom` | configurable | User-provided eval script |

### Custom Metrics

```typescript
import { registerFitnessFn } from './autoresearch/index.js';

registerFitnessFn('extraction_f1', async (ctx) => {
  // Your custom measurement logic
  const result = await runExtraction(ctx.params.document);
  return computeF1(result, ctx.params.ground_truth);
});
```

## Mutation Strategies

| Strategy | Description | Use Case |
|----------|-------------|----------|
| `prompt_evolution` | GEPA-style reflective prompt optimization | System prompts, few-shot examples |
| `code_optimization` | Performance/size/readability improvements | Hot path code, utility functions |
| `config_tuning` | Random perturbation with search space bounds | Temperature, top_p, thresholds |
| `architecture_search` | Model/framework selection (round-robin, bandit) | Model selection, tool choice |

## Integration Points

- **Identity System**: All experiment runs are attributed to agents via Ed25519-signed evidence chains
- **Trust Scoring**: Agent trust scores can be used as fitness metrics
- **Monitoring System**: Actions logged for safety review; flagged mutations auto-revert
- **Resource Orchestrator**: Concurrent run limits enforced; RAM allocation per run
- **Team Orchestrator**: Experiments can spawn specialist agent teams

## Files

| File | Purpose |
|------|---------|
| `types.ts` | Core type definitions |
| `persistence.ts` | SQLite schema and CRUD |
| `fitness-library.ts` | Built-in measurement functions |
| `mutation-strategies.ts` | Variant generation strategies |
| `experiment-engine.ts` | Core experiment loop |
| `autoresearch-orchestrator.ts` | Multi-agent coordination |
| `mcp-tool.ts` | Container-side MCP tool registration |
| `ipc-handler.ts` | Host-side IPC message processing |
| `index.ts` | Public API barrel export |

## Best Practices (from awesome-autoresearch)

1. **Always set a baseline** before running experiments. Without a baseline, improvement can't be measured.
2. **Use conservative thresholds** (5-10% improvement minimum). Small improvements may be noise.
3. **Monitor for regressions** across metrics. Improving accuracy while doubling latency is not a win.
4. **Auto-complete plateaued experiments**. The orchestrator does this after 5 consecutive reverts.
5. **Keep mutation rates moderate** (0.2-0.4). Too high creates chaos; too low makes no progress.
6. **Run multiple iterations** before concluding. Single runs are unreliable; aim for 10+ per experiment.
