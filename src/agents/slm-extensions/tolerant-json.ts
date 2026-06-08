/**
 * Tolerant JSON parsing layer.
 *
 * Small models emit *mostly*-valid JSON: wrapped in ```json fences, with a
 * preamble ("Here is the JSON:"), trailing commas, or single quotes. Per the
 * "small-language-models-production" finding, a tolerant parser is what makes
 * model swapping a config change rather than a code refactor — so it lives here,
 * shared by every SLM extension.
 *
 * It never throws on malformed input; it returns a discriminated result so the
 * caller can decide whether to accept, retry, or fall back to a larger model.
 */

export type TolerantParseResult<T = unknown> =
  | { ok: true; value: T; repaired: boolean }
  | { ok: false; error: string };

/**
 * Parse model output into JSON, applying escalating repairs.
 * `repaired` is true when the raw text was not already strict JSON.
 */
export function parseTolerantJson<T = unknown>(raw: string): TolerantParseResult<T> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'empty output' };
  }

  // 1. Strict parse of the raw string.
  const strict = tryParse<T>(raw);
  if (strict.ok) return { ok: true, value: strict.value, repaired: false };

  // 2. Strip markdown code fences and common preambles, then parse.
  const unfenced = stripFences(raw);
  const unfencedParsed = tryParse<T>(unfenced);
  if (unfencedParsed.ok) return { ok: true, value: unfencedParsed.value, repaired: true };

  // 3. Extract the first balanced {...} or [...] block.
  const block = extractJsonBlock(unfenced);
  if (block) {
    const blockParsed = tryParse<T>(block);
    if (blockParsed.ok) return { ok: true, value: blockParsed.value, repaired: true };

    // 4. Apply textual repairs to the extracted block.
    const repaired = repairJson(block);
    const repairedParsed = tryParse<T>(repaired);
    if (repairedParsed.ok) return { ok: true, value: repairedParsed.value, repaired: true };
  }

  return { ok: false, error: 'could not parse JSON after repairs' };
}

function tryParse<T>(s: string): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) as T };
  } catch {
    return { ok: false };
  }
}

/** Remove ```json ... ``` / ``` ... ``` fences and leading "Here is..." chatter. */
function stripFences(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  return s;
}

/**
 * Find the first balanced JSON object/array, respecting strings and escapes.
 * Returns null if no balanced block exists.
 */
export function extractJsonBlock(s: string): string | null {
  const startObj = s.indexOf('{');
  const startArr = s.indexOf('[');
  let start = -1;
  let open = '{';
  let close = '}';
  if (startObj === -1 && startArr === -1) return null;
  if (startArr === -1 || (startObj !== -1 && startObj < startArr)) {
    start = startObj;
    open = '{';
    close = '}';
  } else {
    start = startArr;
    open = '[';
    close = ']';
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Best-effort textual repairs that don't require a full JSON tokenizer. */
function repairJson(s: string): string {
  let out = s;
  // Smart quotes → straight quotes.
  out = out.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // Remove trailing commas before } or ].
  out = out.replace(/,\s*([}\]])/g, '$1');
  // If there are no double quotes at all, promote single-quoted strings.
  if (!out.includes('"') && out.includes("'")) {
    out = out.replace(/'/g, '"');
  }
  return out;
}
