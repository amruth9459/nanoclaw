/**
 * Personality Tuner — A/B testing engine for agent personality parameters
 *
 * Karpathy-inspired Phase 2: systematically tunes agent personality by
 * running controlled experiments. Mutates one parameter at a time, measures
 * quality impact, and adopts improvements >5 percentage points.
 *
 * Workflow:
 *   1. getOrCreateProfile() — get/create personality profile for a group
 *   2. shouldRunExperiment() — check if enough baseline data exists
 *   3. startExperiment() — mutate one param, record experiment
 *   4. (agent runs with mutated params for ~20 outputs)
 *   5. evaluateExperiment() — compare quality, adopt if improved
 */

import { randomUUID } from 'crypto';
import {
  createPersonalityProfile,
  createTuningExperiment,
  getExperimentsForProfile,
  getProfileForGroup,
  updateExperimentResults,
  updateProfileParams,
  updateProfileQuality,
  type PersonalityParams,
  type PersonalityProfile,
  type TuningExperiment,
} from './db.js';
import { logger } from './logger.js';
import { compositeScore, getBaselineQuality, getQualitySince } from './output-scorer.js';
import { DEFAULT_PERSONALITY, mutateOne, type Mutation } from './prompt-mutator.js';

/** Minimum outputs before baseline measurement is valid. */
const MIN_BASELINE_OUTPUTS = 5;
/** Minimum outputs during experiment before evaluation. */
const MIN_EXPERIMENT_OUTPUTS = 5;
/** Target experiment sample size. */
const TARGET_SAMPLE_SIZE = 20;
/** Improvement threshold (percentage points) to adopt a mutation. */
const ADOPTION_THRESHOLD = 5;
/** Cooldown between experiments (ms) — 1 hour. */
const EXPERIMENT_COOLDOWN_MS = 60 * 60 * 1000;

export interface ActiveExperiment {
  experiment: TuningExperiment;
  profile: PersonalityProfile;
  mutation: Mutation;
  startedAt: string; // ISO timestamp
}

// In-memory tracking of the currently running experiment per group
const activeExperiments = new Map<string, ActiveExperiment>();

/**
 * Get or create a personality profile for a group/agent-type pair.
 * New profiles start with balanced defaults.
 */
export function getOrCreateProfile(groupId: string, agentType = 'default'): PersonalityProfile {
  const existing = getProfileForGroup(groupId, agentType);
  if (existing) return existing;

  const now = Date.now();
  const profile: PersonalityProfile = {
    id: randomUUID(),
    group_id: groupId,
    agent_type: agentType,
    personality_params: JSON.stringify(DEFAULT_PERSONALITY),
    avg_quality_score: null,
    total_outputs: 0,
    created_at: now,
    last_updated: now,
  };

  createPersonalityProfile(profile);
  logger.info({ groupId, agentType, profileId: profile.id }, 'Created personality profile with defaults');
  return profile;
}

/**
 * Get the current personality params for a group, falling back to defaults
 * if no profile exists. Returns null if we should use the system's default
 * behavior (no profile yet and no reason to create one).
 */
export function getPersonalityParams(groupId: string, agentType = 'default'): PersonalityParams | null {
  const profile = getProfileForGroup(groupId, agentType);
  if (!profile) return null;

  // If there's an active experiment, return the mutated params
  const active = activeExperiments.get(groupId);
  if (active && active.profile.id === profile.id) {
    return active.mutation.params;
  }

  try {
    return JSON.parse(profile.personality_params) as PersonalityParams;
  } catch {
    return DEFAULT_PERSONALITY;
  }
}

/**
 * Check if conditions are met to start a new experiment.
 * Requires: enough baseline data, no active experiment, cooldown elapsed.
 */
export function shouldRunExperiment(groupId: string, agentType = 'default'): boolean {
  // Already running an experiment
  if (activeExperiments.has(groupId)) return false;

  const profile = getProfileForGroup(groupId, agentType);
  if (!profile) return false;

  // Check baseline quality data
  const baseline = getBaselineQuality(groupId, TARGET_SAMPLE_SIZE);
  if (!baseline || baseline.sampleSize < MIN_BASELINE_OUTPUTS) return false;

  // Check cooldown — don't run experiments too frequently
  const experiments = getExperimentsForProfile(profile.id);
  if (experiments.length > 0) {
    const lastExperiment = experiments[0]; // sorted by tested_at DESC
    if (Date.now() - lastExperiment.tested_at < EXPERIMENT_COOLDOWN_MS) return false;
  }

  return true;
}

/**
 * Start a new tuning experiment: mutate one parameter and record it.
 * Returns the active experiment with mutated params, or null if preconditions not met.
 */
export function startExperiment(groupId: string, agentType = 'default'): ActiveExperiment | null {
  if (!shouldRunExperiment(groupId, agentType)) return null;

  const profile = getOrCreateProfile(groupId, agentType);
  const currentParams: PersonalityParams = JSON.parse(profile.personality_params);

  // Measure baseline before mutation
  const baseline = getBaselineQuality(groupId, TARGET_SAMPLE_SIZE);
  if (!baseline) return null;

  const baselineScore = compositeScore(baseline);

  // Mutate one parameter
  const mutation = mutateOne(currentParams);

  // Record the experiment
  const now = Date.now();
  const experiment: TuningExperiment = {
    id: randomUUID(),
    profile_id: profile.id,
    parameter_name: mutation.parameter,
    old_value: mutation.oldValue,
    new_value: mutation.newValue,
    quality_before: baselineScore,
    quality_after: null,
    sample_size: null,
    improvement: null,
    adopted: 0,
    tested_at: now,
  };

  createTuningExperiment(experiment);

  // Update baseline quality on profile
  updateProfileQuality(profile.id, baselineScore, baseline.sampleSize);

  const active: ActiveExperiment = {
    experiment,
    profile,
    mutation,
    startedAt: new Date().toISOString(),
  };

  activeExperiments.set(groupId, active);

  logger.info(
    {
      groupId,
      experimentId: experiment.id,
      parameter: mutation.parameter,
      oldValue: mutation.oldValue,
      newValue: mutation.newValue,
      baselineScore,
    },
    'Started personality tuning experiment',
  );

  return active;
}

/**
 * Evaluate the current experiment: measure quality since experiment start,
 * compare with baseline, adopt if improvement > threshold.
 *
 * Returns evaluation result or null if experiment can't be evaluated yet.
 */
export function evaluateExperiment(groupId: string): {
  adopted: boolean;
  improvement: number;
  qualityBefore: number;
  qualityAfter: number;
  sampleSize: number;
} | null {
  const active = activeExperiments.get(groupId);
  if (!active) return null;

  // Measure quality since experiment started
  const qualitySince = getQualitySince(groupId, active.startedAt, TARGET_SAMPLE_SIZE);
  if (!qualitySince || qualitySince.sampleSize < MIN_EXPERIMENT_OUTPUTS) {
    logger.debug(
      { groupId, sampleSize: qualitySince?.sampleSize ?? 0 },
      'Not enough experiment data yet',
    );
    return null;
  }

  const qualityAfter = compositeScore(qualitySince);
  const qualityBefore = active.experiment.quality_before ?? 0;
  const improvement = qualityAfter - qualityBefore;
  const adopted = improvement >= ADOPTION_THRESHOLD;

  // Record results
  updateExperimentResults(
    active.experiment.id,
    qualityAfter,
    qualitySince.sampleSize,
    improvement,
    adopted,
  );

  if (adopted) {
    // Apply the mutation permanently
    updateProfileParams(active.profile.id, active.mutation.params);
    logger.info(
      {
        groupId,
        parameter: active.mutation.parameter,
        oldValue: active.mutation.oldValue,
        newValue: active.mutation.newValue,
        improvement: `+${improvement.toFixed(1)}pp`,
      },
      'Adopted personality mutation — quality improved',
    );
  } else {
    logger.info(
      {
        groupId,
        parameter: active.mutation.parameter,
        improvement: `${improvement >= 0 ? '+' : ''}${improvement.toFixed(1)}pp`,
      },
      'Rejected personality mutation — insufficient improvement',
    );
  }

  // Clear active experiment
  activeExperiments.delete(groupId);

  return { adopted, improvement, qualityBefore, qualityAfter, sampleSize: qualitySince.sampleSize };
}

/** Get the active experiment for a group, if any. */
export function getActiveExperiment(groupId: string): ActiveExperiment | null {
  return activeExperiments.get(groupId) ?? null;
}

/** Cancel an active experiment without evaluating it. */
export function cancelExperiment(groupId: string): boolean {
  if (!activeExperiments.has(groupId)) return false;
  activeExperiments.delete(groupId);
  logger.info({ groupId }, 'Cancelled personality tuning experiment');
  return true;
}

/**
 * Increment the output counter for the active experiment.
 * Called after each agent output during an experiment.
 * Returns true if enough outputs have been collected for evaluation.
 */
export function recordExperimentOutput(groupId: string): boolean {
  const active = activeExperiments.get(groupId);
  if (!active) return false;

  // We rely on agent_quality_reviews count rather than a separate counter
  const qualitySince = getQualitySince(groupId, active.startedAt, TARGET_SAMPLE_SIZE);
  return (qualitySince?.sampleSize ?? 0) >= TARGET_SAMPLE_SIZE;
}
