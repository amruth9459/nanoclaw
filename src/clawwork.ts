import { readFileSync } from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { MLXBackendFactory } from './router/index.js';

// Load BLS wages map at startup
let blsWages: Record<string, number> = {};
let occupationList: string[] = [];
try {
  blsWages = JSON.parse(readFileSync(path.join(DATA_DIR, 'bls-wages.json'), 'utf-8'));
  occupationList = Object.keys(blsWages);
} catch (err) {
  logger.warn({ err }, 'Failed to load bls-wages.json — ClawWork task classification unavailable');
}

export interface ClawworkTaskRow {
  id: string;
  group_id: string;
  occupation: string;
  sector?: string | null;
  prompt: string;
  max_payment: number;
  estimated_hours?: number | null;
  status: string;
  assigned_at: string;
  submitted_at?: string | null;
  evaluation_score?: number | null;
  actual_payment?: number | null;
  work_output?: string | null;
  artifact_paths?: string | null;
}

export interface ClassifyResult {
  occupation: string;
  hours: number;
  sector: string;
}

export interface EvaluationResult {
  score: number;
  feedback: string;
}

const FALLBACK_CLASSIFY: ClassifyResult = {
  occupation: 'General and Operations Managers',
  hours: 2,
  sector: 'Business',
};

export async function classifyTask(description: string): Promise<ClassifyResult> {
  if (occupationList.length === 0) return FALLBACK_CLASSIFY;

  try {
    const ollama = MLXBackendFactory.create();
    if (!(await ollama.isAvailable())) {
      logger.warn('Ollama not available for classifyTask, using fallback');
      return FALLBACK_CLASSIFY;
    }

    const prompt = `Given this task: ${description}

Classify into one of these occupations:
${occupationList.join('\n')}

Estimate hours to complete (0.25–40).
Return JSON only: {"occupation": "...", "hours": 2.0, "sector": "..."}`;

    const response = await ollama.inference({
      modelId: 'qwen2.5-coder',
      prompt,
      maxTokens: 256,
      temperature: 0.1,
    });

    logger.info({ latencyMs: response.latencyMs }, 'classifyTask via Ollama');
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return FALLBACK_CLASSIFY;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.occupation || !occupationList.includes(parsed.occupation)) {
      return FALLBACK_CLASSIFY;
    }

    return {
      occupation: parsed.occupation,
      hours: Math.max(0.25, Math.min(40, Number(parsed.hours) || 2)),
      sector: String(parsed.sector || 'General'),
    };
  } catch (err) {
    logger.warn({ err }, 'classifyTask failed, using fallback');
    return FALLBACK_CLASSIFY;
  }
}

export async function evaluateWork(
  task: ClawworkTaskRow,
  workOutput: string,
  artifactPaths: string[],
): Promise<EvaluationResult> {
  const artifactNote = artifactPaths.length > 0
    ? `\nArtifacts: ${artifactPaths.join(', ')}`
    : '';

  const prompt = `You are evaluating work for a ${task.occupation}.
Task: ${task.prompt}
Submitted work: ${workOutput.slice(0, 3000)}${artifactNote}

Score 0.0–1.0 on: accuracy, completeness, professionalism, relevance.
Return JSON only: {"score": 0.85, "feedback": "..."}`;

  try {
    const ollama = MLXBackendFactory.create();
    if (!(await ollama.isAvailable())) {
      return { score: 0.5, feedback: 'Ollama unavailable — default score assigned' };
    }

    const response = await ollama.inference({
      modelId: 'qwen2.5-coder',
      prompt,
      maxTokens: 200,
      temperature: 0.1,
    });
    logger.info({ latencyMs: response.latencyMs }, 'evaluateWork via Ollama');

    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { score: 0.5, feedback: 'Evaluation returned non-JSON — default score assigned' };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      score: Math.max(0, Math.min(1, Number(parsed.score) || 0)),
      feedback: String(parsed.feedback || 'No feedback provided'),
    };
  } catch (err) {
    logger.warn({ err }, 'evaluateWork failed');
    return { score: 0, feedback: `Evaluation error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function computeMaxPayment(occupation: string, hours: number): number {
  const hourlyWage = blsWages[occupation] ?? 25;
  return Math.round(hourlyWage * hours * 100) / 100;
}
