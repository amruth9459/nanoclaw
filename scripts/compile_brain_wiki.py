#!/usr/bin/env python3
"""Stage 4 — compile the Brain (Obsidian vault) + Claw shared memory into
LLM Wiki v2. Shares the engine at services/wiki_compile/lib.py with the Jyotish
compiler.

Outputs land in /Users/amrut/nanoclaw/data/brain-wiki/ (out-of-vault so
Obsidian doesn't render them and we don't recursively ingest our own outputs).

Usage:
    python3 scripts/compile_brain_wiki.py            # incremental
    python3 scripts/compile_brain_wiki.py --force    # full recompile
    python3 scripts/compile_brain_wiki.py --stats    # statistics only
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from services.wiki_compile import compile_all, show_stats  # noqa: E402
from services.wiki_compile.domains.brain import make_domain  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--stats", action="store_true")
    args = parser.parse_args()

    domain = make_domain()
    if args.stats:
        show_stats(domain)
    else:
        compile_all(domain, force=args.force)
        show_stats(domain)
    return 0


if __name__ == "__main__":
    sys.exit(main())
