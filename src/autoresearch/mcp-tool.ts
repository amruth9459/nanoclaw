/**
 * Autoresearch MCP Tool — User-facing tool for managing autonomous improvement experiments.
 *
 * This module registers MCP tools that agents can call from within containers.
 * It uses IPC to communicate with the host-side autoresearch engine.
 *
 * Actions:
 * - create: Start a new experiment
 * - run: Execute one iteration
 * - list: Show all experiments with metrics
 * - pause/resume/complete: Lifecycle management
 * - leaderboard: Best runs across all experiments
 * - analyze: Statistical analysis of an experiment
 * - baseline: Set/update baseline score
 */
// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type McpServer = any;
import { z } from 'zod';

export interface AutoresearchToolContext {
  groupFolder: string;
  chatJid: string;
  writeIpcFile: (dir: string, data: object) => string;
  pollResponse: (responseFile: string, timeoutMs: number) => Promise<Record<string, unknown> | null>;
  MESSAGES_DIR: string;
}

/**
 * Register autoresearch MCP tools on the given server.
 * Called from the container-side agent runner when NANOCLAW_TOOL_MODULES includes 'autoresearch-tools'.
 */
export function registerAutoresearchTools(server: McpServer, ctx: AutoresearchToolContext): void {
  const { writeIpcFile, pollResponse, MESSAGES_DIR } = ctx;

  server.tool(
    'autoresearch',
    `Autonomous improvement experiment system. Runs create→mutate→measure→decide loops.

Actions:
- create: Start a new experiment with a fitness metric and mutation strategy
- run: Execute one iteration (applies mutation, measures fitness, decides keep/revert)
- list: Show all experiments (optionally filtered by status)
- pause: Pause an active experiment
- resume: Resume a paused experiment
- complete: Mark an experiment as completed
- leaderboard: Show best runs across all experiments
- analyze: Statistical analysis of an experiment's performance
- baseline: Set/update the baseline score for an experiment
- metrics: Get aggregate metrics across all experiments`,
    {
      action: z.enum([
        'create', 'run', 'list', 'pause', 'resume', 'complete',
        'leaderboard', 'analyze', 'baseline', 'metrics',
      ]).describe('The action to perform'),

      // Create action params
      name: z.string().optional().describe('Experiment name (for create)'),
      description: z.string().optional().describe('Experiment description (for create)'),
      fitness_metric: z.object({
        name: z.string(),
        type: z.enum(['maximize', 'minimize']),
        unit: z.string(),
        measurement_fn: z.string(),
        threshold_improvement: z.number(),
      }).optional().describe('Fitness metric configuration (for create)'),
      mutation_strategy: z.object({
        type: z.enum(['prompt_evolution', 'code_optimization', 'config_tuning', 'architecture_search']),
        parameters: z.record(z.unknown()),
      }).optional().describe('Mutation strategy configuration (for create)'),

      // Run action params
      experiment_id: z.string().optional().describe('Experiment ID (for run, pause, resume, complete, analyze, baseline)'),
      variant_description: z.string().optional().describe('Description of this variant (for run)'),
      current_content: z.string().optional().describe('Current content to mutate (for run)'),
      target: z.string().optional().describe('Target file/config path (for run)'),

      // Baseline action params
      score: z.number().optional().describe('Baseline score (for baseline)'),

      // List action params
      status: z.enum(['active', 'paused', 'completed']).optional().describe('Filter by status (for list)'),

      // Leaderboard params
      limit: z.number().optional().describe('Max results (for leaderboard, default 10)'),
    },
    async (args) => {
      const agentId = process.env.NANOCLAW_AGENT_ID || 'unknown';

      // Send IPC request to host for processing
      const requestData = {
        type: 'autoresearch',
        action: args.action,
        agent_id: agentId,
        ...args,
      };

      const filename = writeIpcFile(MESSAGES_DIR, requestData);
      const responseFile = MESSAGES_DIR + '/' + filename.replace('.json', '.response.json');

      // Poll for response (30s timeout for most actions, 60s for run)
      const timeout = args.action === 'run' ? 60000 : 30000;
      const response = await pollResponse(responseFile, timeout);

      if (!response) {
        return {
          content: [{ type: 'text' as const, text: `Autoresearch ${args.action} timed out. The host may be busy.` }],
        };
      }

      if (response.error) {
        return {
          content: [{ type: 'text' as const, text: `Autoresearch error: ${response.error}` }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: formatResponse(args.action, response) }],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Response Formatting
// ---------------------------------------------------------------------------

function formatResponse(action: string, response: Record<string, unknown>): string {
  switch (action) {
    case 'create':
      return `Experiment created: ${response.name} (${response.id})\n` +
        `Metric: ${(response.fitness_metric as Record<string, unknown>)?.name}\n` +
        `Strategy: ${(response.mutation_strategy as Record<string, unknown>)?.type}\n` +
        `Status: ${response.status}`;

    case 'run': {
      const result = response as Record<string, unknown>;
      return `Run ${result.status}:\n` +
        `  Run ID: ${result.runId || 'N/A'}\n` +
        `  Decision: ${result.decision || 'N/A'}\n` +
        `  Improvement: ${result.improvement !== undefined ? `${((result.improvement as number) * 100).toFixed(2)}%` : 'N/A'}\n` +
        `  Fitness Score: ${result.fitnessScore ?? 'N/A'}\n` +
        `  Mutation: ${result.mutation || 'N/A'}`;
    }

    case 'list': {
      const experiments = response.experiments as Array<Record<string, unknown>> || [];
      if (experiments.length === 0) return 'No experiments found.';
      return experiments.map((e: Record<string, unknown>) =>
        `[${e.status}] ${e.name} (${e.id})\n` +
        `  Baseline: ${e.baseline_score ?? 'not set'} | Best: ${e.current_best_score ?? 'not set'}`
      ).join('\n\n');
    }

    case 'leaderboard': {
      const entries = response.entries as Array<Record<string, unknown>> || [];
      if (entries.length === 0) return 'No improvements recorded yet.';
      return 'Top improvements:\n' + entries.map((e: Record<string, unknown>, i: number) =>
        `${i + 1}. ${e.experiment_name}: +${((e.improvement as number) * 100).toFixed(2)}% (score: ${e.fitness_score})`
      ).join('\n');
    }

    case 'analyze': {
      const a = response as Record<string, unknown>;
      return `Experiment Analysis: ${(a.experiment as Record<string, unknown>)?.name}\n` +
        `  Total runs: ${a.total_runs} (kept: ${a.kept_runs}, reverted: ${a.reverted_runs}, pending: ${a.pending_runs})\n` +
        `  Mean improvement: ${((a.mean_improvement as number) * 100).toFixed(2)}%\n` +
        `  Std deviation: ${((a.std_improvement as number) * 100).toFixed(2)}%\n` +
        `  Trend: ${a.trend}`;
    }

    case 'metrics': {
      const m = response as Record<string, unknown>;
      return `Autoresearch Metrics:\n` +
        `  Experiments: ${m.total_experiments} total, ${m.active_experiments} active\n` +
        `  Runs: ${m.total_runs} total\n` +
        `  Kept: ${m.improvements_kept} | Reverted: ${m.improvements_reverted}\n` +
        `  Best improvement: ${((m.best_improvement_pct as number) * 100).toFixed(2)}%\n` +
        `  Avg improvement: ${((m.avg_improvement_pct as number) * 100).toFixed(2)}%`;
    }

    case 'baseline':
      return `Baseline set to ${response.baseline_score} for experiment ${response.id}`;

    case 'pause':
    case 'resume':
    case 'complete':
      return `Experiment ${response.id} is now ${response.status}`;

    default:
      return JSON.stringify(response, null, 2);
  }
}
