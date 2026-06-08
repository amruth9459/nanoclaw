/**
 * JsonExtractor
 *
 * Extracts structured data from unstructured text against a lightweight schema
 * (field name → type + required flag). Tolerant JSON parsing + schema validation
 * + LLM fallback. This is the "structured output generation" SLM task — the one
 * the hackathon finding showed a fine-tuned 0.5B can do at 100% format validity.
 */

import {
  type SlmExtensionDeps,
  type SlmResult,
  type InferenceRequest,
  runJsonWithFallback,
} from './base.js';

export type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface FieldSpec {
  type: FieldType;
  required?: boolean;
  description?: string;
}

/** field name → spec */
export type ExtractionSchema = Record<string, FieldSpec>;

const SYSTEM_PROMPT =
  'You are a data extraction engine. Respond with ONLY a JSON object matching the ' +
  'requested schema. Use null for fields you cannot find. No prose, no markdown.';

function buildPrompt(text: string, schema: ExtractionSchema): string {
  const fields = Object.entries(schema)
    .map(([name, spec]) => {
      const req = spec.required ? ' (required)' : '';
      const desc = spec.description ? ` — ${spec.description}` : '';
      return `  "${name}": ${spec.type}${req}${desc}`;
    })
    .join('\n');

  return (
    'Extract the following fields from the text below. Respond as a JSON object ' +
    'with exactly these keys:\n' +
    `{\n${fields}\n}\n\n` +
    `--- TEXT ---\n${text}\n--- END ---`
  );
}

function typeMatches(value: unknown, type: FieldType): boolean {
  if (value === null || value === undefined) return true; // null allowed for any field
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && !Array.isArray(value);
  }
}

export class JsonExtractor {
  constructor(private deps: SlmExtensionDeps) {}

  async extract(
    text: string,
    schema: ExtractionSchema,
  ): Promise<SlmResult<Record<string, unknown>>> {
    if (!text || text.trim() === '') {
      return { ok: false, value: null, confidence: 0, usedFallback: false, error: 'empty input' };
    }
    if (!schema || Object.keys(schema).length === 0) {
      return { ok: false, value: null, confidence: 0, usedFallback: false, error: 'empty schema' };
    }

    const req: InferenceRequest = {
      systemPrompt: SYSTEM_PROMPT,
      prompt: buildPrompt(text, schema),
      maxTokens: 400,
      temperature: 0,
    };

    return runJsonWithFallback<Record<string, unknown>>(this.deps, req, (parsed) => {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      const obj = parsed as Record<string, unknown>;

      // Validate schema: required fields present (non-null) and types match.
      for (const [name, spec] of Object.entries(schema)) {
        const value = obj[name];
        if (spec.required && (value === undefined || value === null)) {
          return null; // missing required field → reject, trigger fallback
        }
        if (value !== undefined && !typeMatches(value, spec.type)) {
          return null; // type mismatch → reject
        }
      }

      // Project to exactly the schema keys (drop hallucinated extras).
      const result: Record<string, unknown> = {};
      for (const name of Object.keys(schema)) {
        result[name] = obj[name] ?? null;
      }
      return result;
    });
  }
}
