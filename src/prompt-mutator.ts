/**
 * Prompt Mutator — Parameter mutation logic for personality tuning
 *
 * Karpathy-inspired Phase 2: mutates one personality parameter at a time
 * for A/B testing. Uses small incremental changes to avoid catastrophic
 * quality drops.
 */

import type { PersonalityParams } from './db.js';

const TONE_VALUES: PersonalityParams['tone'][] = ['concise', 'balanced', 'verbose'];
const FORMALITY_VALUES: PersonalityParams['formality'][] = ['casual', 'professional', 'formal'];

export const DEFAULT_PERSONALITY: PersonalityParams = {
  tone: 'balanced',
  verbosity: 5,
  creativity: 5,
  formality: 'professional',
};

export type MutableParam = keyof PersonalityParams;
const MUTABLE_PARAMS: MutableParam[] = ['tone', 'verbosity', 'creativity', 'formality'];

export interface Mutation {
  parameter: MutableParam;
  oldValue: string;
  newValue: string;
  params: PersonalityParams;
}

/**
 * Pick a random parameter and mutate it by one step.
 * Numeric params: ±1 (clamped to 1-10).
 * Categorical params: step to adjacent value.
 */
export function mutateOne(current: PersonalityParams): Mutation {
  const param = MUTABLE_PARAMS[Math.floor(Math.random() * MUTABLE_PARAMS.length)];
  const mutated = { ...current };

  switch (param) {
    case 'verbosity':
    case 'creativity': {
      const val = current[param];
      const delta = Math.random() < 0.5 ? -1 : 1;
      mutated[param] = Math.max(1, Math.min(10, val + delta));
      return { parameter: param, oldValue: String(val), newValue: String(mutated[param]), params: mutated };
    }
    case 'tone': {
      const idx = TONE_VALUES.indexOf(current.tone);
      const newIdx = pickAdjacentIndex(idx, TONE_VALUES.length);
      mutated.tone = TONE_VALUES[newIdx];
      return { parameter: param, oldValue: current.tone, newValue: mutated.tone, params: mutated };
    }
    case 'formality': {
      const idx = FORMALITY_VALUES.indexOf(current.formality);
      const newIdx = pickAdjacentIndex(idx, FORMALITY_VALUES.length);
      mutated.formality = FORMALITY_VALUES[newIdx];
      return { parameter: param, oldValue: current.formality, newValue: mutated.formality, params: mutated };
    }
  }
}

/**
 * Generate a specific mutation for a named parameter and target value.
 */
export function mutateSpecific(
  current: PersonalityParams, parameter: MutableParam, newValue: string,
): Mutation {
  const mutated = { ...current };

  switch (parameter) {
    case 'verbosity':
    case 'creativity': {
      const numVal = Math.max(1, Math.min(10, parseInt(newValue, 10) || current[parameter]));
      mutated[parameter] = numVal;
      return { parameter, oldValue: String(current[parameter]), newValue: String(numVal), params: mutated };
    }
    case 'tone': {
      const toneVal = TONE_VALUES.includes(newValue as PersonalityParams['tone'])
        ? newValue as PersonalityParams['tone']
        : current.tone;
      mutated.tone = toneVal;
      return { parameter, oldValue: current.tone, newValue: toneVal, params: mutated };
    }
    case 'formality': {
      const formalVal = FORMALITY_VALUES.includes(newValue as PersonalityParams['formality'])
        ? newValue as PersonalityParams['formality']
        : current.formality;
      mutated.formality = formalVal;
      return { parameter, oldValue: current.formality, newValue: formalVal, params: mutated };
    }
  }
}

/**
 * Build the system prompt personality block to inject into the agent.
 * Returns a markdown block that gets appended to the system prompt.
 */
export function buildPersonalityPrompt(params: PersonalityParams): string {
  const lines = [
    '',
    '## Communication Style',
    '',
  ];

  // Tone
  switch (params.tone) {
    case 'concise':
      lines.push('- Be concise and direct. Minimize filler words. Get to the point quickly.');
      break;
    case 'verbose':
      lines.push('- Be thorough and detailed. Explain your reasoning step by step. Provide context and examples.');
      break;
    default:
      lines.push('- Balance brevity with clarity. Include necessary context without over-explaining.');
  }

  // Verbosity scale
  if (params.verbosity <= 3) {
    lines.push('- Keep responses short. Use bullet points. Omit obvious details.');
  } else if (params.verbosity >= 8) {
    lines.push('- Provide comprehensive responses with detailed explanations, examples, and edge cases.');
  }

  // Creativity
  if (params.creativity <= 3) {
    lines.push('- Stick to conventional, well-established approaches. Avoid novel or experimental solutions.');
  } else if (params.creativity >= 8) {
    lines.push('- Think creatively. Consider unconventional approaches and novel solutions when appropriate.');
  }

  // Formality
  switch (params.formality) {
    case 'casual':
      lines.push('- Use a casual, conversational tone. Keep it friendly and approachable.');
      break;
    case 'formal':
      lines.push('- Use formal, professional language. Be precise and structured in your communication.');
      break;
    default:
      lines.push('- Maintain a professional but approachable tone.');
  }

  return lines.join('\n');
}

/** Pick an adjacent index in a list, ensuring it differs from the current. */
function pickAdjacentIndex(current: number, length: number): number {
  if (length <= 1) return 0;
  if (current === 0) return 1;
  if (current === length - 1) return length - 2;
  return Math.random() < 0.5 ? current - 1 : current + 1;
}
