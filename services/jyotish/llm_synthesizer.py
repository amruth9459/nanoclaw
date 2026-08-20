"""
LLM-based Synthesis for Jyotish Predictions.

Replaces rule-based stage7_synthesis with an LLM call that receives all
stage 1-6 outputs and wiki context, then returns structured predictions.

Usage:
    from llm_synthesizer import interpret_chart_llm
    result = interpret_chart_llm(chart_data, model='gemini-2.0-flash')
"""
import json
import os
import hashlib
import time
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from interpret import (
    stage1_verify, stage2_strength, stage2b_functional, stage3_navamsha,
    stage3b_yogas, stage4_karakas, stage5_dasha, stage6_transits,
    stage_arudha, stage_d10, _ashtakavarga_transit_score,
    RASHI_LORDS, YOGAKARAKA, HOUSE_THEMES, KENDRA, TRIKONA, DUSTHANA,
    GRAHA_DRISHTI, EVIDENCE_TIERS,
)

# ── Paths ────────────────────────────────────────────────────────────────────
_DIR = Path(__file__).parent
_WIKI_DIR = _DIR / 'wiki' / 'raw'
_FRAMEWORK_PATH = Path('/Users/amrut/nanoclaw/data/jyotish-books/MASTER-REASONING-FRAMEWORK.md')
_CACHE_PATH = _DIR / 'llm_cache.json'

# ── Cost tracking ────────────────────────────────────────────────────────────
_COST_PER_1M = {
    'gemini-2.0-flash': {'input': 0.10, 'output': 0.40},
    'gemini-2.5-flash': {'input': 0.15, 'output': 0.60},
    'claude-sonnet': {'input': 3.00, 'output': 15.00},
    'claude-haiku': {'input': 0.25, 'output': 1.25},
    'claude-opus': {'input': 15.00, 'output': 75.00},
}
_session_cost = {'input_tokens': 0, 'output_tokens': 0, 'calls': 0, 'model': ''}

# ── Wiki context (loaded once) ──────────────────────────────────────────────
_WIKI_FILES = [
    'prediction-hierarchy-rules.md',
    'dasha-interpretation.md',
    'event-timing-rules.md',
    'yoga-interpretation.md',
    'kn-rao-prediction-techniques.md',
    'pvr-seven-stage-methodology.md',
    'bv-raman-predictive-rules.md',
    'sanjay-rath-jaimini-techniques.md',
    'house-significations.md',
    'planet-significations.md',
    'divisional-charts.md',
    'transit-interpretation.md',
    'compatibility-rules.md',
    'remedial-measures.md',
]


def _load_wiki_context() -> str:
    """Load all wiki rule files into a single string."""
    parts = []
    for fname in _WIKI_FILES:
        fpath = _WIKI_DIR / fname
        if fpath.exists():
            parts.append(f'### {fname}\n{fpath.read_text()}')
    return '\n\n'.join(parts)


def _load_framework() -> str:
    """Load MASTER-REASONING-FRAMEWORK.md."""
    if _FRAMEWORK_PATH.exists():
        return _FRAMEWORK_PATH.read_text()
    return ''


# ── Cache ────────────────────────────────────────────────────────────────────
def _load_cache() -> dict:
    if _CACHE_PATH.exists():
        try:
            return json.loads(_CACHE_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _save_cache(cache: dict):
    _CACHE_PATH.write_text(json.dumps(cache, indent=2))


def _cache_key(system_prompt: str, user_prompt: str, model: str) -> str:
    """SHA-256 hash of prompts + model for deterministic cache key."""
    blob = f'{model}::{system_prompt}::{user_prompt}'
    return hashlib.sha256(blob.encode()).hexdigest()[:24]


# ── System Prompt ────────────────────────────────────────────────────────────
def _build_system_prompt() -> str:
    framework = _load_framework()
    wiki = _load_wiki_context()

    return f"""You are an expert Vedic astrologer applying the composite methodology of KN Rao, PVR Narasimha Rao, Sanjay Rath, and BV Raman.

## Your Task
Given a chart's computed analysis (stages 1-6 output), synthesize predictions for 6 life areas. You must produce a JSON object with predictions — no other text.

## Master Reasoning Framework
{framework}

## Classical Rules Reference
{wiki}

## CRITICAL ANTI-BIAS RULES
1. DO NOT default to positive predictions. Career fall, health crisis, marriage problems, wealth loss, and mental health struggles are real outcomes.
2. When the dasha lord owns dusthana houses (6, 8, 12) or is classified as maraka/direly_evil by Laghu Parashari, the DEFAULT should be NEGATIVE unless strong countervailing evidence exists.
3. Career fall domain: if the dasha lord is a functional malefic AND placed in dusthana/debilitated, predict NEGATIVE career direction.
4. Death/health crisis: if maraka lord dasha (2nd/7th lord) with LP confirming maraka role + 8th lord involvement, predict NEGATIVE health.
5. Mixed is NOT a safe default. Take a position based on the weight of evidence.
6. A natural benefic (Jupiter, Venus) can still give terrible results if it owns dusthana houses for that lagna. FUNCTIONAL nature overrides NATURAL nature.
7. Rahu/Ketu dashas: check the DISPOSITOR. Rahu/Ketu give results of their dispositor and sign lord.
8. Mental health: Moon condition (strength, aspects from Saturn/Rahu/Ketu), Mercury condition (mind significator), 4th house (happiness), and 5th house (emotional intelligence) are the primary indicators. Saturn-Moon conjunction/aspect is a classical depression indicator. Rahu on Moon causes anxiety/obsessive thinking.

## Evidence Hierarchy (strongest to weakest)
1. Dasha alignment (weight 10) — if dasha doesn't support, event won't happen
2. D-1 + D-9 confirmation (weight 8) — promise confirmed in both charts
3. Double transit (weight 7) — Jupiter + Saturn both activating house
4. Functional nature / LP classification (weight 6) — overrides natural benefic/malefic
5. Yoga activation (weight 5) — yoga only manifests in yoga-lord's dasha
6. D-10 confirmation (weight 4) — for career specifically
7. Arudha Pada (weight 3) — worldly image/perception
8. Static strength (weight 3) — shadbala, dignity
9. Ashtakavarga (weight 2) — transit quality
10. Transit alone (weight 1) — weakest evidence

## Output Schema
Return ONLY a JSON object (no markdown fences, no explanation):
{{
  "predictions": [
    {{
      "area": "Career" | "Marriage & Relationships" | "Wealth & Finance" | "Health" | "Mental Health" | "Spiritual",
      "summary": "<2-4 sentence narrative with specific astrological reasoning>",
      "direction": "positive" | "negative" | "mixed",
      "confidence": <float 0.15-0.95>,
      "key_factors": ["<top 3-5 factors that determined this prediction>"],
      "key_planets": ["<planets most relevant to this area>"]
    }}
  ],
  "overall_assessment": "<1-2 sentence holistic view>",
  "strongest_evidence_tier": "<which tier dominated the synthesis>"
}}

You MUST include all 6 areas. Confidence must reflect genuine uncertainty — don't cluster everything at 0.6-0.7.
"""


# ── Chart Context (User Prompt) ─────────────────────────────────────────────
def _build_chart_context(verified: dict, stages: dict) -> str:
    """Serialize all stage outputs into structured text for the LLM."""
    parts = []
    lagna = verified['lagna']
    planets = verified['planets']
    houses = verified['houses']
    house_lords = verified['house_lords']

    # 1. Basic chart info
    parts.append(f'## Chart: {lagna} Lagna')
    yk = YOGAKARAKA.get(lagna, 'None')
    parts.append(f'Yogakaraka: {yk}')

    # 2. Planet table
    lines = ['## Planet Positions']
    lines.append('Planet | Sign | House | Dignity | Strength | Retro')
    lines.append('-------|------|-------|---------|----------|------')
    for pname, pdata in sorted(planets.items()):
        sign = pdata.get('rashi', '?')
        house = pdata.get('house', '?')
        dignity = pdata.get('dignity', '-')
        strength = pdata.get('strength', '-')
        retro = 'R' if pdata.get('retro') else ''
        lines.append(f'{pname} | {sign} | {house} | {dignity} | {strength} | {retro}')
    parts.append('\n'.join(lines))

    # 3. House lords
    lines = ['## House Lords']
    for h in range(1, 13):
        lord = house_lords.get(h, '?')
        theme = HOUSE_THEMES.get(h, '')
        occupants = houses.get(h, [])
        occ_str = ', '.join(occupants) if occupants else 'empty'
        lines.append(f'House {h} ({theme}): Lord={lord}, Occupants=[{occ_str}]')
    parts.append('\n'.join(lines))

    # 4. Functional classifications (LP)
    func = stages.get('functional', {})
    lp = func.get('classifications', {})
    if lp:
        lines = ['## Laghu Parashari Functional Classification']
        for planet, role in sorted(lp.items()):
            lines.append(f'{planet}: {role}')
        parts.append('\n'.join(lines))

    # 5. Strength assessment
    strength = stages.get('strength', {})
    parts.append(f'## Strength\nStrong: {strength.get("strong_planets", [])}\nWeak: {strength.get("weak_planets", [])}')

    # 6. Navamsha
    nav = stages.get('navamsha', {})
    vargottama = nav.get('vargottama_planets', [])
    d1_d9 = nav.get('d1_d9_confirmation', {})
    nav_findings = nav.get('findings', [])
    lines = ['## Navamsha (D-9)']
    if vargottama:
        lines.append(f'Vargottama planets: {vargottama}')
    if d1_d9:
        for p, status in d1_d9.items():
            lines.append(f'{p}: {status}')
    for f in nav_findings[:10]:
        lines.append(f'- {f.get("factor", "")}')
    parts.append('\n'.join(lines))

    # 7. Yogas
    yoga_data = stages.get('yogas', {})
    yogas_list = yoga_data.get('yogas', [])
    lines = ['## Yogas Detected']
    lines.append(f'Total: {yoga_data.get("yoga_count", 0)}, Raja: {yoga_data.get("raja_yoga_count", 0)}, Dhana: {yoga_data.get("dhana_yoga_count", 0)}')
    for y in yogas_list[:15]:
        ytype = y.get('type', '')
        yplanets = y.get('planets', [])
        lines.append(f'- {y.get("yoga", "?")} ({ytype}) — planets: {yplanets}')
    parts.append('\n'.join(lines))

    # 8. Karakas
    karakas = stages.get('karakas', {})
    chara = karakas.get('chara_karakas', {})
    if chara:
        lines = ['## Chara Karakas']
        for role, planet in chara.items():
            lines.append(f'{role}: {planet}')
        parts.append('\n'.join(lines))

    # 9. Dasha
    dasha = stages.get('dasha', {})
    md = dasha.get('current_mahadasha', {}) or {}
    ad = dasha.get('current_antardasha', {}) or {}
    pad = dasha.get('current_pratyantardasha', {}) or {}
    lines = ['## Current Dasha Period']
    if md:
        md_lord = md.get('lord', '?')
        md_houses = [h for h, l in house_lords.items() if l == md_lord]
        md_lp = lp.get(md_lord, 'neutral') if lp else 'unknown'
        md_placement = planets.get(md_lord, {})
        lines.append(f'Mahadasha: {md_lord}')
        lines.append(f'  Houses owned: {md_houses}')
        lines.append(f'  LP role: {md_lp}')
        lines.append(f'  Placed in: house {md_placement.get("house", "?")}, {md_placement.get("rashi", "?")}, dignity={md_placement.get("dignity", "?")}, strength={md_placement.get("strength", "?")}')
    if ad:
        ad_lord = ad.get('lord', '?')
        ad_houses = [h for h, l in house_lords.items() if l == ad_lord]
        ad_lp = lp.get(ad_lord, 'neutral') if lp else 'unknown'
        ad_placement = planets.get(ad_lord, {})
        lines.append(f'Antardasha: {ad_lord}')
        lines.append(f'  Houses owned: {ad_houses}')
        lines.append(f'  LP role: {ad_lp}')
        lines.append(f'  Placed in: house {ad_placement.get("house", "?")}, {ad_placement.get("rashi", "?")}, dignity={ad_placement.get("dignity", "?")}, strength={ad_placement.get("strength", "?")}')
    if pad:
        lines.append(f'Pratyantardasha: {pad.get("lord", "?")}')

    # Dasha findings
    dasha_findings = dasha.get('findings', [])
    for f in dasha_findings[:8]:
        lines.append(f'- {f.get("factor", "")}')

    # Yoga activation
    yoga_activation = dasha.get('yoga_activation', [])
    if yoga_activation:
        lines.append(f'Yoga activation in current dasha: {yoga_activation}')
    parts.append('\n'.join(lines))

    # 10. Transits
    transits = stages.get('transits', {})
    dt_houses = transits.get('double_transit_houses', [])
    lines = ['## Transits']
    if dt_houses:
        lines.append(f'Double Transit active on houses: {dt_houses}')
    if transits.get('sade_sati'):
        lines.append('Sade Sati ACTIVE')
    for f in transits.get('findings', [])[:8]:
        lines.append(f'- {f.get("factor", "")}')
    parts.append('\n'.join(lines))

    # 11. Arudha Padas
    arudha = stages.get('arudha', {})
    padas = arudha.get('arudha_padas', {})
    if padas:
        lines = ['## Arudha Padas']
        for pad_name, pad_sign in padas.items():
            lines.append(f'{pad_name}: {pad_sign}')
        parts.append('\n'.join(lines))

    # 12. D-10
    d10 = stages.get('d10', {})
    if d10.get('d10_available'):
        lines = ['## D-10 (Dashamsha — Career)']
        lines.append(f'D-10 Lagna: {d10.get("d10_lagna", "?")}')
        for f in d10.get('findings', [])[:6]:
            lines.append(f'- {f.get("factor", "")}')
        parts.append('\n'.join(lines))

    # 13. Ashtakavarga
    avk = stages.get('ashtakavarga_scores', {})
    if avk:
        lines = ['## Ashtakavarga Transit Scores']
        for planet, score in avk.items():
            lines.append(f'{planet}: {score}')
        parts.append('\n'.join(lines))

    return '\n\n'.join(parts)


# ── LLM Callers ──────────────────────────────────────────────────────────────
def _call_gemini(system_prompt: str, user_prompt: str, model: str = 'gemini-2.0-flash',
                 temperature: float = 0.0, max_retries: int = 3) -> str:
    """Call Gemini API via google-genai SDK."""
    from google import genai

    client = genai.Client()
    model_id = model
    # Map short names to full model IDs
    model_map = {
        'gemini-2.0-flash': 'gemini-2.0-flash',
        'gemini-2.5-flash': 'gemini-2.5-flash-preview-04-17',
    }
    model_id = model_map.get(model, model)

    for attempt in range(max_retries):
        try:
            response = client.models.generate_content(
                model=model_id,
                contents=user_prompt,
                config=genai.types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    temperature=temperature,
                    response_mime_type='application/json',
                ),
            )
            # Track tokens
            usage = response.usage_metadata
            if usage:
                _session_cost['input_tokens'] += getattr(usage, 'prompt_token_count', 0) or 0
                _session_cost['output_tokens'] += getattr(usage, 'candidates_token_count', 0) or 0
            _session_cost['calls'] += 1
            _session_cost['model'] = model

            return response.text

        except Exception as e:
            if attempt < max_retries - 1:
                wait = 2 ** attempt
                print(f'  Gemini attempt {attempt+1} failed: {e}. Retrying in {wait}s...', file=sys.stderr)
                time.sleep(wait)
            else:
                raise RuntimeError(f'Gemini failed after {max_retries} attempts: {e}')


def _get_anthropic_oauth_token() -> str:
    """Retrieve OAuth token from Claude Code's macOS keychain entry."""
    import subprocess
    try:
        result = subprocess.run(
            ['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w'],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            data = json.loads(result.stdout.strip())
            return data.get('claudeAiOauth', {}).get('accessToken', '')
    except Exception:
        pass
    return ''


def _call_anthropic(system_prompt: str, user_prompt: str, model: str = 'claude-sonnet',
                    temperature: float = 0.0, max_retries: int = 3) -> str:
    """Call Anthropic API. Uses ANTHROPIC_API_KEY env var, or falls back to Claude Code OAuth."""
    import anthropic

    api_key = os.environ.get('ANTHROPIC_API_KEY', '')
    auth_token = ''
    if not api_key:
        auth_token = _get_anthropic_oauth_token()
    if not api_key and not auth_token:
        raise RuntimeError('No Anthropic API key or OAuth token found. Set ANTHROPIC_API_KEY or log in via `claude auth login`.')

    if api_key:
        client = anthropic.Anthropic(api_key=api_key)
    else:
        client = anthropic.Anthropic(auth_token=auth_token)

    model_map = {
        'claude-sonnet': 'claude-sonnet-4-20250514',
        'claude-haiku': 'claude-haiku-4-5-20251001',
        'claude-opus': 'claude-opus-4-20250514',
    }
    model_id = model_map.get(model, model)

    for attempt in range(max_retries):
        try:
            response = client.messages.create(
                model=model_id,
                max_tokens=4096,
                temperature=temperature,
                system=system_prompt,
                messages=[{'role': 'user', 'content': user_prompt}],
            )
            # Track tokens
            usage = response.usage
            if usage:
                _session_cost['input_tokens'] += usage.input_tokens
                _session_cost['output_tokens'] += usage.output_tokens
            _session_cost['calls'] += 1
            _session_cost['model'] = model

            return response.content[0].text

        except Exception as e:
            if attempt < max_retries - 1:
                wait = 2 ** attempt
                print(f'  Anthropic attempt {attempt+1} failed: {e}. Retrying in {wait}s...', file=sys.stderr)
                time.sleep(wait)
            else:
                raise RuntimeError(f'Anthropic failed after {max_retries} attempts: {e}')


def _call_claude_cli(system_prompt: str, user_prompt: str, model: str = 'claude-opus',
                     max_retries: int = 3) -> str:
    """Call Claude via the `claude` CLI which uses OAuth session auth."""
    import subprocess, tempfile

    model_map = {
        'claude-opus': 'claude-opus-4-6',
        'claude-sonnet': 'claude-sonnet-4-6',
        'claude-haiku': 'claude-haiku-4-5-20251001',
    }
    model_id = model_map.get(model, model)

    # Write system prompt to temp file to avoid argument length limits
    combined_prompt = f"""<system>
{system_prompt}
</system>

{user_prompt}

IMPORTANT: Return ONLY a valid JSON object matching the schema in the system prompt. No markdown fences, no explanation, just JSON."""

    for attempt in range(max_retries):
        try:
            result = subprocess.run(
                ['claude', '-p', '--model', model_id, '--output-format', 'text'],
                input=combined_prompt,
                capture_output=True, text=True,
                timeout=180,
            )

            if result.returncode != 0:
                raise RuntimeError(f'claude CLI failed: {result.stderr[:300]}')

            response = result.stdout.strip()
            if not response:
                raise RuntimeError('Empty response from claude CLI')

            _session_cost['calls'] += 1
            _session_cost['model'] = model
            # Rough token estimate for cost tracking (CLI doesn't report tokens)
            _session_cost['input_tokens'] += len(combined_prompt) // 4
            _session_cost['output_tokens'] += len(response) // 4

            return response

        except Exception as e:
            if attempt < max_retries - 1:
                wait = 5 * (attempt + 1)  # 5s, 10s, 15s — gentler on rate limits
                print(f'  claude CLI attempt {attempt+1} failed: {e}. Retrying in {wait}s...', file=sys.stderr)
                time.sleep(wait)
            else:
                raise RuntimeError(f'claude CLI failed after {max_retries} attempts: {e}')


def _call_llm(system_prompt: str, user_prompt: str, model: str = 'gemini-2.0-flash') -> str:
    """Dispatch to the right LLM provider."""
    if model.startswith('claude'):
        # Try CLI first (uses OAuth), fall back to SDK (needs API key)
        try:
            return _call_claude_cli(system_prompt, user_prompt, model)
        except Exception as cli_err:
            print(f'  CLI failed ({cli_err}), trying SDK...', file=sys.stderr)
            return _call_anthropic(system_prompt, user_prompt, model)
    else:
        return _call_gemini(system_prompt, user_prompt, model)


# ── Response Parser ──────────────────────────────────────────────────────────
def _parse_response(raw: str) -> dict:
    """Extract JSON predictions from LLM response."""
    text = raw.strip()
    # Strip markdown code fences if present
    if text.startswith('```'):
        lines = text.split('\n')
        # Remove first and last fence lines
        lines = [l for l in lines if not l.strip().startswith('```')]
        text = '\n'.join(lines)

    parsed = json.loads(text)

    # Validate structure
    predictions = parsed.get('predictions', [])
    if not predictions:
        raise ValueError('No predictions in LLM response')

    # Normalize and validate each prediction
    valid_areas = {'Career', 'Marriage & Relationships', 'Wealth & Finance', 'Health', 'Mental Health', 'Spiritual'}
    valid_directions = {'positive', 'negative', 'mixed'}
    # Map house numbers for compatibility with existing test harness
    area_to_house = {
        'Career': 10, 'Marriage & Relationships': 7, 'Wealth & Finance': 2,
        'Health': 1, 'Mental Health': 5, 'Spiritual': 12,
    }

    normalized = []
    for pred in predictions:
        area = pred.get('area', '')
        if area not in valid_areas:
            continue
        direction = pred.get('direction', 'mixed')
        if direction not in valid_directions:
            direction = 'mixed'
        confidence = pred.get('confidence', 0.5)
        confidence = max(0.15, min(0.95, float(confidence)))

        normalized.append({
            'area': area,
            'summary': pred.get('summary', ''),
            'house': area_to_house.get(area, 0),
            'key_planets': pred.get('key_planets', []),
            'confirmations': len(pred.get('key_factors', [])),
            'confidence': round(confidence, 2),
            'direction': direction,
            'net_score': round((confidence - 0.5) * 20 * (1 if direction == 'positive' else -1 if direction == 'negative' else 0), 1),
            'case_patterns': [],
            'key_factors': pred.get('key_factors', []),
        })

    return {
        'predictions': normalized,
        'overall_assessment': parsed.get('overall_assessment', ''),
        'strongest_evidence_tier': parsed.get('strongest_evidence_tier', ''),
    }


# ── Main Entry Point ────────────────────────────────────────────────────────
def interpret_chart_llm(chart_data: dict, model: str = 'gemini-2.0-flash',
                        use_cache: bool = True) -> dict:
    """
    Run stages 1-6, then use LLM for synthesis instead of rule-based stage7.

    Args:
        chart_data: Output from engine.compute_chart() or test harness _build_chart()
        model: 'gemini-2.0-flash', 'gemini-2.5-flash', 'claude-sonnet', 'claude-haiku'
        use_cache: Whether to use/save cache for repeated runs

    Returns:
        Same schema as interpret_chart() for test harness compatibility.
    """
    # ── Stages 1-6 (identical to interpret.py) ───────────────────────────────
    verified = stage1_verify(chart_data)
    if 'error' in verified:
        return verified

    strength = stage2_strength(chart_data, verified)
    verified['_vimshottari'] = chart_data.get('vimshottari', [])
    functional = stage2b_functional(verified)
    navamsha = stage3_navamsha(chart_data, verified)
    yoga_data = stage3b_yogas(verified)
    karakas = stage4_karakas(chart_data, verified)
    dasha = stage5_dasha(chart_data, verified)
    transits = stage6_transits(chart_data, verified)
    arudha = stage_arudha(verified)

    md_info = dasha.get('current_mahadasha', {}) or {}
    verified['_vimshottari_md'] = md_info.get('lord', '')
    d10 = stage_d10(chart_data, verified)

    avk_scores = {}
    sav = chart_data.get('ashtakavarga_sav', [])
    bav = chart_data.get('ashtakavarga_bav', {})
    if sav or bav:
        raw_transits = chart_data.get('transits', {})
        if isinstance(raw_transits, dict):
            for tp_name, tp_data in raw_transits.items():
                tp_sign = tp_data.get('rashi', '') if isinstance(tp_data, dict) else ''
                if tp_name and tp_sign:
                    score = _ashtakavarga_transit_score(tp_name, tp_sign, bav, sav)
                    if score:
                        avk_scores[tp_name] = score
        elif isinstance(raw_transits, list):
            for tp in raw_transits:
                tp_name = tp.get('body', '')
                tp_sign = tp.get('rashi', '')
                if tp_name and tp_sign:
                    score = _ashtakavarga_transit_score(tp_name, tp_sign, bav, sav)
                    if score:
                        avk_scores[tp_name] = score

    yogas_summary = {
        'count': yoga_data['yoga_count'],
        'raja_yoga_count': yoga_data['raja_yoga_count'],
        'dhana_yoga_count': yoga_data['dhana_yoga_count'],
        'notable': yoga_data['notable'],
        'yogas': yoga_data['yogas'],
    }
    doshas_summary = chart_data.get('doshas', {})

    stages = {
        'strength': strength,
        'functional': functional,
        'navamsha': navamsha,
        'yogas': yoga_data,
        'karakas': karakas,
        'dasha': dasha,
        'transits': transits,
        'arudha': arudha,
        'd10': d10,
        'ashtakavarga_scores': avk_scores,
        'yogas_summary': yogas_summary,
        'doshas_summary': doshas_summary,
    }

    # ── LLM Synthesis (replaces stage7) ──────────────────────────────────────
    system_prompt = _build_system_prompt()
    user_prompt = _build_chart_context(verified, stages)

    # Check cache
    cache = _load_cache() if use_cache else {}
    key = _cache_key(system_prompt, user_prompt, model)

    if key in cache:
        llm_result = cache[key]
    else:
        # Call LLM
        raw_response = _call_llm(system_prompt, user_prompt, model)
        try:
            llm_result = _parse_response(raw_response)
        except (json.JSONDecodeError, ValueError) as e:
            print(f'  LLM parse error: {e}. Falling back to rule-based synthesis.', file=sys.stderr)
            # Fallback to rule-based
            from interpret import stage7_synthesis
            synthesis = stage7_synthesis(verified, stages)
            return _build_output(verified, strength, functional, navamsha, yoga_data,
                                karakas, dasha, transits, arudha, d10, avk_scores,
                                yogas_summary, doshas_summary, synthesis)

        # Save to cache
        if use_cache:
            cache[key] = llm_result
            _save_cache(cache)

    # ── Build output compatible with test harness ────────────────────────────
    predictions = llm_result['predictions']

    # Collect all findings from stages
    all_findings = []
    for stage_name, stage_data in stages.items():
        for f in stage_data.get('findings', []):
            f['stage'] = stage_name
            all_findings.append(f)

    avg_conf = sum(p['confidence'] for p in predictions) / max(len(predictions), 1)
    avg_net = sum(p.get('net_score', 0) for p in predictions) / max(len(predictions), 1)

    if avg_conf >= 0.80:
        conf_label = 'very high (strong multi-tier evidence alignment)'
    elif avg_conf >= 0.65:
        conf_label = 'high (dasha + D-9 or transit support)'
    elif avg_conf >= 0.50:
        conf_label = 'moderate (some evidence, contradictions present)'
    else:
        conf_label = 'low - contradictory evidence or missing dasha support'

    return {
        'chart_summary': {
            'lagna': verified['lagna'],
            'birth_info': f"{verified.get('birth_date', '')} {verified.get('birth_time', '')} at {verified.get('place_name', '')}",
            'strong_planets': strength['strong_planets'],
            'weak_planets': strength['weak_planets'],
            'vargottama': navamsha.get('vargottama_planets', []),
            'yogakaraka': functional.get('yogakaraka'),
        },
        'stages': {
            'strength': {'strong': strength['strong_planets'], 'weak': strength['weak_planets'],
                        'findings': strength['findings']},
            'functional': {'classifications': functional['classifications'],
                          'yogakaraka': functional.get('yogakaraka'),
                          'findings': functional['findings']},
            'navamsha': {'vargottama': navamsha.get('vargottama_planets', []),
                        'findings': navamsha['findings']},
            'yogas': {'count': yoga_data['yoga_count'],
                     'raja_yogas': yoga_data['raja_yoga_count'],
                     'dhana_yogas': yoga_data['dhana_yoga_count'],
                     'list': [y['yoga'] for y in yoga_data['yogas']],
                     'findings': yoga_data['findings']},
            'karakas': {'assignments': karakas.get('chara_karakas', {}),
                       'findings': karakas['findings']},
            'dasha': {'current': dasha.get('current_mahadasha'),
                     'sub_period': dasha.get('current_antardasha'),
                     'sub_sub_period': dasha.get('current_pratyantardasha'),
                     'other_systems': dasha.get('other_systems_count', 0),
                     'findings': dasha['findings']},
            'transits': {'findings': transits['findings']},
            'arudha': {'padas': arudha.get('arudha_padas', {}),
                      'findings': arudha.get('findings', [])},
            'd10': {'available': d10.get('d10_available', False),
                   'd10_lagna': d10.get('d10_lagna'),
                   'findings': d10.get('findings', [])},
            'ashtakavarga': {'transit_scores': avk_scores},
        },
        'predictions': predictions,
        'yogas': yogas_summary,
        'active_yogas': dasha.get('yoga_activation', []),
        'doshas': doshas_summary,
        'overall_confidence': round(avg_conf, 2),
        'confirmation_level': conf_label,
        'avg_net_score': round(avg_net, 1),
        'lp_insight': llm_result.get('overall_assessment', ''),
        'evidence_hierarchy': llm_result.get('strongest_evidence_tier', ''),
        'methodology': f'LLM Synthesis ({model}) + Stages 1-6 from Composite Pipeline',
        'methodology_sources': [
            f'LLM: {model} (temperature=0, structured JSON output)',
            'Stages 1-6: PVR 7-Stage + LP + KN Rao + Sanjay Rath + BV Raman',
            'Context: MASTER-REASONING-FRAMEWORK.md + 14 wiki rule files',
        ],
        'all_findings': all_findings,
    }


# ── Hybrid Mode: Rule engine + LLM override ─────────────────────────────────

def _build_hybrid_prompt() -> str:
    """System prompt for hybrid mode — LLM reviews rule-engine predictions."""
    framework = _load_framework()
    wiki = _load_wiki_context()

    return f"""You are an expert Vedic astrologer reviewing predictions made by a rule-based engine.

## Your Role
You receive a chart analysis (stages 1-6) AND the rule engine's predictions. Your job is to REVIEW each prediction and either CONFIRM or OVERRIDE it.

## DOMAIN-SPECIFIC CALIBRATION (READ THIS FIRST — MANDATORY)

These rules are calibrated from blind testing on 49 celebrity charts. Follow them EXACTLY. When in doubt, CONFIRM the rule engine.

### Career (positive direction) — ALMOST NEVER override:
The rule engine is 92% accurate on career_rise. You MUST NOT override positive career predictions unless you have OVERWHELMING evidence — ALL THREE of these must be true simultaneously:
(a) Dasha lord is 8th lord AND LP classification is maraka or direly_evil
(b) ZERO raja yoga activation in current dasha
(c) D-9 confirms weakness (debilitation or enemy sign)

**CRITICAL: A10 position is NEVER a valid override reason.** A10 is weight 3 — it cannot override dasha (10), D-9 (8), or LP (6). Real examples of charts with A10 in dusthana that ARE positive career: PM Modi (A10 in 12th = still became PM), Tendulkar (A10 in 8th = still became cricket legend), Churchill (A10 in 6th = still became wartime PM). A10 in dusthana with positive higher-tier evidence = CONFIRM positive.

**Do NOT count these as override reasons:** weak 10th lord alone, inauspicious planets in 10th alone, dasha lord owns 12th alone (without also being maraka/direly_evil). These are common in successful careers.

### Wealth — NEVER override positive:
86% accurate. NEVER override positive wealth unless dasha lord is 12th lord AND maraka simultaneously.

### Health (negative) — NEVER override:
100% accurate. NEVER override negative health predictions.

### Death — RARELY override:
90% accurate. Almost never override.

### Marriage — MEDIUM bar:
75% accurate. Override only with 2+ strong contradicting signals.

### Career (negative direction) — SELECTIVELY override to negative:
When the engine predicts POSITIVE but the dasha lord is classified direly_evil or maraka AND owns 8th house, AND there is no activated raja yoga — override to NEGATIVE. This requires the dasha lord to be functionally malefic (LP classification), not just owning a dusthana.

### Negative → positive career override:
Override negative career to POSITIVE when: raja yoga is labeled "ACTIVATED" in summary + dasha lord is in kendra/trikona + strong D-9. The rule engine sometimes over-penalizes maraka/dusthana lords that also own trikona houses.

### Mixed → directional:
Override mixed to positive or negative based on weight of evidence. Mixed is weak — be decisive.

### Mental Health:
Assess independently — Moon condition, Saturn-Moon aspects, Mercury affliction, Rahu on Moon, 4th/5th house condition.

## Evidence Hierarchy (strongest to weakest)
1. Dasha alignment (weight 10)
2. D-1 + D-9 confirmation (weight 8)
3. Double transit (weight 7)
4. LP functional nature (weight 6)
5. Yoga activation (weight 5)
6. D-10 confirmation (weight 4)
7. Arudha Pada (weight 3)
8. Static strength (weight 3)
9. Ashtakavarga (weight 2)
10. Transit alone (weight 1)

## Master Reasoning Framework
{framework}

## Classical Rules Reference
{wiki}

## Output Schema
Return ONLY a JSON object (no markdown fences):
{{
  "reviews": [
    {{
      "area": "<area name>",
      "action": "confirm" | "override",
      "new_direction": "positive" | "negative" | "mixed",
      "new_confidence": <float 0.15-0.95>,
      "reasoning": "<1-2 sentences explaining confirm/override>",
      "key_factors": ["<top factors>"]
    }}
  ],
  "mental_health": {{
    "direction": "positive" | "negative" | "mixed",
    "confidence": <float 0.15-0.95>,
    "summary": "<2-3 sentence assessment>",
    "key_factors": ["<factors>"]
  }},
  "override_count": <int>
}}

Review ALL 5 areas from the rule engine. ALWAYS include mental_health as a new assessment.
"""


def _build_hybrid_user_prompt(chart_context: str, rule_predictions: list) -> str:
    """Build user prompt with chart context + rule engine predictions."""
    parts = [chart_context, '\n## Rule Engine Predictions (for your review)']
    for pred in rule_predictions:
        parts.append(
            f'- **{pred["area"]}**: direction={pred["direction"]}, '
            f'confidence={pred["confidence"]}, net_score={pred.get("net_score", 0)}\n'
            f'  Summary: {pred.get("summary", "")}'
        )
    return '\n'.join(parts)


def interpret_chart_hybrid(chart_data: dict, model: str = 'claude-opus',
                           use_cache: bool = True) -> dict:
    """
    Hybrid: run rule-based stage7 first, then LLM reviews and overrides.

    The rule engine's 86.4% accuracy is the floor. The LLM only overrides
    when it has strong countervailing evidence (especially for negative outcomes).
    Also adds Mental Health as a 6th prediction area.
    """
    from interpret import interpret_chart

    # Step 1: Full rule-based pipeline
    rule_result = interpret_chart(chart_data)
    if 'error' in rule_result:
        return rule_result

    rule_predictions = rule_result.get('predictions', [])

    # Step 2: Run stages 1-6 for chart context (reuse from rule result)
    verified = stage1_verify(chart_data)
    if 'error' in verified:
        return rule_result  # fallback

    strength = stage2_strength(chart_data, verified)
    verified['_vimshottari'] = chart_data.get('vimshottari', [])
    functional = stage2b_functional(verified)
    navamsha = stage3_navamsha(chart_data, verified)
    yoga_data = stage3b_yogas(verified)
    karakas = stage4_karakas(chart_data, verified)
    dasha = stage5_dasha(chart_data, verified)
    transits = stage6_transits(chart_data, verified)
    arudha = stage_arudha(verified)
    md_info = dasha.get('current_mahadasha', {}) or {}
    verified['_vimshottari_md'] = md_info.get('lord', '')
    d10 = stage_d10(chart_data, verified)
    avk_scores = {}
    sav = chart_data.get('ashtakavarga_sav', [])
    bav = chart_data.get('ashtakavarga_bav', {})
    if sav or bav:
        raw_transits = chart_data.get('transits', {})
        if isinstance(raw_transits, dict):
            for tp_name, tp_data in raw_transits.items():
                tp_sign = tp_data.get('rashi', '') if isinstance(tp_data, dict) else ''
                if tp_name and tp_sign:
                    score = _ashtakavarga_transit_score(tp_name, tp_sign, bav, sav)
                    if score:
                        avk_scores[tp_name] = score

    stages = {
        'strength': strength, 'functional': functional, 'navamsha': navamsha,
        'yogas': yoga_data, 'karakas': karakas, 'dasha': dasha,
        'transits': transits, 'arudha': arudha, 'd10': d10,
        'ashtakavarga_scores': avk_scores,
        'yogas_summary': rule_result.get('yogas', {}),
        'doshas_summary': rule_result.get('doshas', {}),
    }

    chart_context = _build_chart_context(verified, stages)

    # Step 3: LLM review
    system_prompt = _build_hybrid_prompt()
    user_prompt = _build_hybrid_user_prompt(chart_context, rule_predictions)

    cache = _load_cache() if use_cache else {}
    key = _cache_key(system_prompt, user_prompt, model)

    if key in cache:
        llm_review = cache[key]
    else:
        raw_response = _call_llm(system_prompt, user_prompt, model)
        try:
            llm_review = json.loads(raw_response.strip().strip('`').removeprefix('json').strip())
        except (json.JSONDecodeError, ValueError) as e:
            print(f'  Hybrid LLM parse error: {e}. Using rule-based only.', file=sys.stderr)
            return rule_result

        if use_cache:
            cache[key] = llm_review
            _save_cache(cache)

    # Step 4: Apply overrides
    reviews = {r['area']: r for r in llm_review.get('reviews', [])}
    override_count = 0
    final_predictions = []
    area_to_house = {
        'Career': 10, 'Marriage & Relationships': 7, 'Wealth & Finance': 2,
        'Health': 1, 'Mental Health': 5, 'Spiritual': 12,
    }

    for pred in rule_predictions:
        area = pred['area']
        review = reviews.get(area)

        if review and review.get('action') == 'override':
            override_count += 1
            new_dir = review.get('new_direction', pred['direction'])
            new_conf = review.get('new_confidence', pred['confidence'])
            new_conf = max(0.15, min(0.95, float(new_conf)))
            final_predictions.append({
                **pred,
                'direction': new_dir,
                'confidence': round(new_conf, 2),
                'net_score': round((new_conf - 0.5) * 20 * (1 if new_dir == 'positive' else -1 if new_dir == 'negative' else 0), 1),
                'summary': f'[LLM OVERRIDE] {review.get("reasoning", "")}. Original: {pred["direction"]} ({pred["confidence"]}). {pred.get("summary", "")[:200]}',
                'key_factors': review.get('key_factors', []),
            })
        else:
            # Confirmed — keep rule engine prediction
            reasoning = review.get('reasoning', '') if review else ''
            if reasoning:
                pred = {**pred, 'summary': f'[CONFIRMED] {reasoning}. {pred.get("summary", "")[:300]}'}
            final_predictions.append(pred)

    # Step 5: Add Mental Health prediction (always from LLM)
    mh = llm_review.get('mental_health', {})
    if mh:
        mh_dir = mh.get('direction', 'mixed')
        mh_conf = max(0.15, min(0.95, float(mh.get('confidence', 0.5))))
        final_predictions.append({
            'area': 'Mental Health',
            'summary': mh.get('summary', ''),
            'house': 5,
            'key_planets': [],
            'confirmations': len(mh.get('key_factors', [])),
            'confidence': round(mh_conf, 2),
            'direction': mh_dir,
            'net_score': round((mh_conf - 0.5) * 20 * (1 if mh_dir == 'positive' else -1 if mh_dir == 'negative' else 0), 1),
            'case_patterns': [],
            'key_factors': mh.get('key_factors', []),
        })

    # Build output
    avg_conf = sum(p['confidence'] for p in final_predictions) / max(len(final_predictions), 1)
    avg_net = sum(p.get('net_score', 0) for p in final_predictions) / max(len(final_predictions), 1)

    return {
        **rule_result,
        'predictions': final_predictions,
        'overall_confidence': round(avg_conf, 2),
        'avg_net_score': round(avg_net, 1),
        'methodology': f'Hybrid: Rule Engine + LLM Override ({model}), {override_count} overrides',
        'llm_overrides': override_count,
    }


def print_cost_summary():
    """Print API cost summary for the session."""
    model = _session_cost['model']
    costs = _COST_PER_1M.get(model, {'input': 0, 'output': 0})
    input_cost = (_session_cost['input_tokens'] / 1_000_000) * costs['input']
    output_cost = (_session_cost['output_tokens'] / 1_000_000) * costs['output']
    total = input_cost + output_cost

    print(f'\n{"="*50}')
    print(f'LLM COST SUMMARY ({model})')
    print(f'{"="*50}')
    print(f'API calls:     {_session_cost["calls"]}')
    print(f'Input tokens:  {_session_cost["input_tokens"]:,}')
    print(f'Output tokens: {_session_cost["output_tokens"]:,}')
    print(f'Input cost:    ${input_cost:.4f}')
    print(f'Output cost:   ${output_cost:.4f}')
    print(f'Total cost:    ${total:.4f}')


def reset_cost_tracking():
    """Reset session cost counters."""
    _session_cost['input_tokens'] = 0
    _session_cost['output_tokens'] = 0
    _session_cost['calls'] = 0
    _session_cost['model'] = ''
