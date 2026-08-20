"""Single LLM helper used by every brain-* stage.

Shells out to the `claude` CLI in --print mode, which uses OAuth (the user's
plan quota) rather than burning API credits. Wraps the CLI's JSON envelope and
returns the parsed model output.

Usage:
    from services.wiki_compile.llm import call_claude
    response = call_claude(prompt, model="sonnet", json_output=True)

Why this and not anthropic SDK / urllib:
  - The user's Pro/Max plan covers OAuth-mode calls; raw API key burns paid credits.
  - `claude` CLI handles OAuth refresh transparently from launchd context.
  - Same path the existing desktop_claude integration already validated.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import time


CLAUDE_BIN = shutil.which("claude") or "/opt/homebrew/bin/claude"

# Backoff schedule for rate-limit errors. Plan-quota windows are 5h rolling;
# the schedule covers a worst-case window with a hard cap on retries.
RATE_LIMIT_BACKOFF_S = (60, 180, 600, 1800, 3600)
RATE_LIMIT_PATTERNS = re.compile(
    r"(rate.?limit|429|too many requests|usage.?limit|quota|"
    r"5.?hour|5h.?window|reset[^a-z]?in|please.?wait|temporarily)",
    re.IGNORECASE,
)

# Minimal system prompt — overrides Claude Code's default (~40K tokens of
# tool definitions etc) since we only need raw JSON synthesis here.
DEFAULT_SYSTEM_PROMPT = (
    "You answer with strict JSON only. No markdown, no prose outside the JSON. "
    "If asked for plain text, return text only — no fences."
)

JSON_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


class ClaudeCallError(RuntimeError):
    pass


def _strip_fences(text: str) -> str:
    return JSON_FENCE_RE.sub("", text.strip()).strip()


def _is_rate_limit(text: str) -> bool:
    return bool(RATE_LIMIT_PATTERNS.search(text or ""))


def _log(msg: str) -> None:
    """Stderr-only: callers redirect stderr to their own log file."""
    print(f"[llm] {msg}", file=sys.stderr, flush=True)


def call_claude(
    prompt: str,
    model: str = "sonnet",
    *,
    system_prompt: str | None = DEFAULT_SYSTEM_PROMPT,
    json_output: bool = True,
    timeout: int = 600,
    max_retries: int = 5,
) -> dict | str:
    """Run a one-shot prompt through `claude -p` and return the model's response.

    Retries on rate-limit errors with exponential backoff (RATE_LIMIT_BACKOFF_S).
    Other errors raise ClaudeCallError immediately — caller decides whether to
    catch.
    """
    args = [
        CLAUDE_BIN, "-p",
        "--model", model,
        "--no-session-persistence",
        "--dangerously-skip-permissions",
        "--output-format", "json",
    ]
    if system_prompt:
        args += ["--system-prompt", system_prompt]

    last_error: str = ""
    for attempt in range(max_retries + 1):
        try:
            proc = subprocess.run(
                args,
                input=prompt,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as e:
            raise ClaudeCallError(f"claude CLI timed out after {timeout}s") from e

        if proc.returncode != 0:
            err = proc.stderr.strip() or proc.stdout.strip()
            if _is_rate_limit(err) and attempt < max_retries:
                wait = RATE_LIMIT_BACKOFF_S[min(attempt, len(RATE_LIMIT_BACKOFF_S) - 1)]
                _log(f"rate-limit (exit {proc.returncode}): sleeping {wait}s "
                     f"(attempt {attempt + 1}/{max_retries})")
                time.sleep(wait)
                continue
            raise ClaudeCallError(
                f"claude CLI exit {proc.returncode}: {err[:500]}"
            )

        try:
            envelope = json.loads(proc.stdout.strip())
        except json.JSONDecodeError as e:
            raise ClaudeCallError(f"could not parse claude envelope: {e}") from e

        if envelope.get("is_error"):
            err_msg = envelope.get("result", "") or ""
            if _is_rate_limit(err_msg) and attempt < max_retries:
                wait = RATE_LIMIT_BACKOFF_S[min(attempt, len(RATE_LIMIT_BACKOFF_S) - 1)]
                _log(f"rate-limit (envelope): sleeping {wait}s "
                     f"(attempt {attempt + 1}/{max_retries})")
                time.sleep(wait)
                continue
            raise ClaudeCallError(f"claude reported error: {err_msg[:500]}")

        raw_result = envelope.get("result", "")
        if not json_output:
            return raw_result

        cleaned = _strip_fences(raw_result)
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError as e:
            # If the model returned plain text instead of JSON, that's not a
            # rate-limit issue — fail fast so caller sees the bug.
            raise ClaudeCallError(
                f"model response wasn't JSON: {e}\nFirst 500 chars: {cleaned[:500]}"
            ) from e

    raise ClaudeCallError(f"exhausted retries after rate-limit; last error: {last_error[:500]}")


def call_claude_text(prompt: str, model: str = "sonnet", **kw) -> str:
    """Convenience wrapper for plain-text answers."""
    return call_claude(prompt, model=model, json_output=False, **kw)


def analyze_image(
    image_path: str,
    prompt: str,
    *,
    model: str = "sonnet",
    json_output: bool = True,
    **kw,
) -> dict | str:
    """Run Claude Vision on a local image. The CLI's Read tool loads the image
    when the prompt references its absolute path; we just need to ask it to.

    The image must be readable by the user running this script. If the path
    is wrong or unreadable, the model will say so and we surface the error.
    """
    full_prompt = (
        f"Read the image at {image_path} and analyse it.\n\n{prompt}"
    )
    return call_claude(full_prompt, model=model, json_output=json_output, **kw)
