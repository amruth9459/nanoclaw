/**
 * Mutation Strategies — Variant generation for autoresearch experiments.
 *
 * Each strategy generates a mutation (variant) and provides revert instructions.
 * Inspired by:
 * - GEPA: reflective prompt optimization
 * - OpenELM: evolutionary code optimization
 * - AIDE: architecture search for ML pipelines
 */
import { logger } from '../logger.js';
import type { MutationType, MutationResult, MutationStrategy, MutationChange } from './types.js';

// ---------------------------------------------------------------------------
// Strategy Interface
// ---------------------------------------------------------------------------

export type MutationGeneratorFn = (
  context: MutationContext,
  parameters: Record<string, unknown>,
) => Promise<MutationResult>;

export interface MutationContext {
  /** Current prompt, code, or config being mutated. */
  current_content: string;
  /** Target file or config path. */
  target: string;
  /** Previous fitness score. */
  previous_score: number;
  /** History of past mutations and their results. */
  history: MutationHistoryEntry[];
  /** Additional context for the mutation. */
  metadata?: Record<string, unknown>;
}

export interface MutationHistoryEntry {
  mutation_description: string;
  score: number;
  decision: 'keep' | 'revert';
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<MutationType, MutationGeneratorFn>();

export function registerMutationStrategy(type: MutationType, fn: MutationGeneratorFn): void {
  registry.set(type, fn);
}

export function getMutationStrategy(type: MutationType): MutationGeneratorFn | undefined {
  return registry.get(type);
}

export function listMutationStrategies(): MutationType[] {
  return Array.from(registry.keys());
}

/**
 * Apply a mutation strategy to generate a variant.
 */
export async function applyMutation(
  strategy: MutationStrategy,
  context: MutationContext,
): Promise<MutationResult> {
  const generator = registry.get(strategy.type);
  if (!generator) {
    throw new Error(`Unknown mutation strategy: ${strategy.type}. Available: ${listMutationStrategies().join(', ')}`);
  }
  try {
    return await generator(context, strategy.parameters);
  } catch (err) {
    logger.error({ err, strategy: strategy.type }, 'Mutation generation failed');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Built-in Strategies
// ---------------------------------------------------------------------------

/**
 * Prompt Evolution (GEPA-style reflective optimization).
 *
 * Generates prompt variants using reflection on past performance:
 * 1. Analyze what worked and what didn't from history
 * 2. Generate a targeted mutation based on performance gaps
 * 3. Provide clear revert instructions
 *
 * Parameters:
 * - mutation_rate: float (0-1), how aggressively to mutate (default 0.3)
 * - focus_areas: string[], which aspects to focus on (e.g., 'clarity', 'specificity')
 */
registerMutationStrategy('prompt_evolution', async (ctx, params): Promise<MutationResult> => {
  const mutationRate = (params.mutation_rate as number) ?? 0.3;
  const focusAreas = (params.focus_areas as string[]) ?? ['clarity', 'specificity', 'structure'];
  const content = ctx.current_content;

  // Analyze history for patterns
  const keptMutations = ctx.history.filter(h => h.decision === 'keep');
  const revertedMutations = ctx.history.filter(h => h.decision === 'revert');

  // Build mutation description based on analysis
  const analysisLines: string[] = [];
  if (keptMutations.length > 0) {
    analysisLines.push(`Successful patterns: ${keptMutations.map(m => m.mutation_description).join('; ')}`);
  }
  if (revertedMutations.length > 0) {
    analysisLines.push(`Failed patterns to avoid: ${revertedMutations.map(m => m.mutation_description).join('; ')}`);
  }

  // Generate mutation based on focus areas and rate
  const mutations: string[] = [];
  for (const area of focusAreas) {
    if (Math.random() < mutationRate) {
      mutations.push(generatePromptMutation(area, content));
    }
  }

  if (mutations.length === 0) {
    // Ensure at least one mutation
    const randomArea = focusAreas[Math.floor(Math.random() * focusAreas.length)];
    mutations.push(generatePromptMutation(randomArea, content));
  }

  const mutatedContent = applyPromptMutations(content, mutations);

  return {
    description: `Prompt evolution (${mutations.length} mutations, rate=${mutationRate}): ${mutations.join(', ')}`,
    changes: [{
      type: 'prompt_change',
      target: ctx.target,
      before: content,
      after: mutatedContent,
    }],
    revert_instructions: `Restore original prompt at ${ctx.target}`,
  };
});

/**
 * Code Optimization — Targeted code improvements.
 *
 * Parameters:
 * - optimization_type: 'performance' | 'readability' | 'size' (default 'performance')
 * - max_changes: number, maximum changes per mutation (default 3)
 */
registerMutationStrategy('code_optimization', async (ctx, params): Promise<MutationResult> => {
  const optimizationType = (params.optimization_type as string) ?? 'performance';
  const maxChanges = (params.max_changes as number) ?? 3;
  const content = ctx.current_content;

  const changes: MutationChange[] = [];
  const descriptions: string[] = [];

  // Analyze code for optimization opportunities
  const opportunities = identifyOptimizationOpportunities(content, optimizationType);
  const selectedOpportunities = opportunities.slice(0, maxChanges);

  let mutatedContent = content;
  for (const opp of selectedOpportunities) {
    mutatedContent = mutatedContent.replace(opp.pattern, opp.replacement);
    changes.push({
      type: 'file_edit',
      target: ctx.target,
      before: opp.pattern,
      after: opp.replacement,
    });
    descriptions.push(opp.description);
  }

  return {
    description: `Code optimization (${optimizationType}): ${descriptions.join(', ') || 'no opportunities found'}`,
    changes,
    revert_instructions: `Restore original file at ${ctx.target}. Changes: ${descriptions.join('; ')}`,
  };
});

/**
 * Config Tuning — Hyperparameter search via random perturbation.
 *
 * Parameters:
 * - search_space: Record<string, { min: number, max: number, step?: number }>
 * - perturbation_scale: float (0-1), how far to perturb from current (default 0.1)
 */
registerMutationStrategy('config_tuning', async (ctx, params): Promise<MutationResult> => {
  const searchSpace = params.search_space as Record<string, { min: number; max: number; step?: number }> | undefined;
  const perturbationScale = (params.perturbation_scale as number) ?? 0.1;
  const content = ctx.current_content;

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(content);
  } catch {
    throw new Error('config_tuning requires JSON content');
  }

  const changes: MutationChange[] = [];
  const descriptions: string[] = [];
  const mutatedConfig = { ...config };

  if (searchSpace) {
    for (const [key, bounds] of Object.entries(searchSpace)) {
      if (key in config && typeof config[key] === 'number') {
        const currentVal = config[key] as number;
        const range = bounds.max - bounds.min;
        const perturbation = (Math.random() * 2 - 1) * perturbationScale * range;
        let newVal = currentVal + perturbation;

        // Clamp to bounds
        newVal = Math.max(bounds.min, Math.min(bounds.max, newVal));

        // Apply step if specified
        if (bounds.step) {
          newVal = Math.round(newVal / bounds.step) * bounds.step;
        }

        mutatedConfig[key] = newVal;
        descriptions.push(`${key}: ${currentVal} → ${newVal.toFixed(4)}`);
      }
    }
  } else {
    // Auto-discover numeric fields and perturb them
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'number' && Math.random() < 0.3) {
        const perturbation = (Math.random() * 2 - 1) * perturbationScale * Math.abs(value || 1);
        const newVal = value + perturbation;
        mutatedConfig[key] = newVal;
        descriptions.push(`${key}: ${value} → ${newVal.toFixed(4)}`);
      }
    }
  }

  const mutatedContent = JSON.stringify(mutatedConfig, null, 2);

  changes.push({
    type: 'config_change',
    target: ctx.target,
    before: content,
    after: mutatedContent,
  });

  return {
    description: `Config tuning (scale=${perturbationScale}): ${descriptions.join(', ') || 'no changes'}`,
    changes,
    revert_instructions: `Restore original config at ${ctx.target}`,
  };
});

/**
 * Architecture Search — Model/framework selection and structural changes.
 *
 * Parameters:
 * - candidates: string[], list of alternatives to try
 * - selection_method: 'random' | 'round_robin' | 'bandit' (default 'round_robin')
 */
registerMutationStrategy('architecture_search', async (ctx, params): Promise<MutationResult> => {
  const candidates = (params.candidates as string[]) ?? [];
  const selectionMethod = (params.selection_method as string) ?? 'round_robin';

  if (candidates.length === 0) {
    throw new Error('architecture_search requires at least one candidate');
  }

  let selectedIndex: number;
  switch (selectionMethod) {
    case 'random':
      selectedIndex = Math.floor(Math.random() * candidates.length);
      break;
    case 'bandit': {
      // Thompson sampling approximation: favor candidates that haven't been tried
      // or that scored well historically
      const triedCandidates = new Set(ctx.history.map(h => h.mutation_description));
      const untried = candidates.filter((_, i) => !triedCandidates.has(candidates[i]));
      if (untried.length > 0) {
        selectedIndex = candidates.indexOf(untried[Math.floor(Math.random() * untried.length)]);
      } else {
        selectedIndex = Math.floor(Math.random() * candidates.length);
      }
      break;
    }
    case 'round_robin':
    default:
      selectedIndex = ctx.history.length % candidates.length;
      break;
  }

  const selected = candidates[selectedIndex];

  return {
    description: `Architecture search: selected "${selected}" (method=${selectionMethod}, candidate ${selectedIndex + 1}/${candidates.length})`,
    changes: [{
      type: 'config_change',
      target: ctx.target,
      before: ctx.current_content,
      after: selected,
    }],
    revert_instructions: `Revert architecture to: ${ctx.current_content}`,
  };
});

// ---------------------------------------------------------------------------
// Prompt Mutation Helpers
// ---------------------------------------------------------------------------

function generatePromptMutation(area: string, content: string): string {
  switch (area) {
    case 'clarity':
      return 'Simplified ambiguous instructions for clearer intent';
    case 'specificity':
      return 'Added concrete examples and constraints';
    case 'structure':
      return 'Reorganized sections for better logical flow';
    case 'conciseness':
      return 'Removed redundant phrases and tightened language';
    case 'context':
      return 'Added relevant background context';
    default:
      return `Applied ${area} improvement`;
  }
}

function applyPromptMutations(content: string, mutations: string[]): string {
  // In a real system, this would use an LLM to apply the mutations.
  // For now, append mutation notes as metadata for the agent to interpret.
  const mutationBlock = mutations.map((m, i) => `  ${i + 1}. ${m}`).join('\n');
  return `${content}\n\n<!-- Autoresearch mutations applied:\n${mutationBlock}\n-->`;
}

// ---------------------------------------------------------------------------
// Code Optimization Helpers
// ---------------------------------------------------------------------------

interface OptimizationOpportunity {
  pattern: string;
  replacement: string;
  description: string;
}

function identifyOptimizationOpportunities(
  content: string,
  type: string,
): OptimizationOpportunity[] {
  const opportunities: OptimizationOpportunity[] = [];

  if (type === 'performance') {
    // Detect common performance anti-patterns
    if (content.includes('.forEach(') && content.includes('await ')) {
      opportunities.push({
        pattern: '.forEach(',
        replacement: '.map(',
        description: 'Replace sequential forEach+await with parallel map+Promise.all',
      });
    }
    if (content.includes('JSON.parse(JSON.stringify(')) {
      opportunities.push({
        pattern: 'JSON.parse(JSON.stringify(',
        replacement: 'structuredClone(',
        description: 'Replace JSON round-trip clone with structuredClone',
      });
    }
  }

  if (type === 'size') {
    // Detect code that could be shortened
    if (content.includes('function ') && content.includes('return ')) {
      opportunities.push({
        pattern: 'function ',
        replacement: 'const fn = ',
        description: 'Convert function declarations to arrow functions for size',
      });
    }
  }

  return opportunities;
}
