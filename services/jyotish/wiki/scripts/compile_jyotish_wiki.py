#!/usr/bin/env python3
"""Compile Jyotish knowledge base — entrypoint.

Implementation lives in services/wiki_compile/ (shared with Brain compiler).
This file just configures the Jyotish domain and runs the pipeline so behaviour
matches the original script byte-for-byte (same metadata schema, confidence
formula, knowledge graph format, index layout).

Usage:
    python3 scripts/compile_jyotish_wiki.py            # incremental compile
    python3 scripts/compile_jyotish_wiki.py --force    # full recompile
    python3 scripts/compile_jyotish_wiki.py --stats    # show statistics
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow running this script directly without installing the package.
REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT))

from services.wiki_compile import compile_all, show_stats  # noqa: E402
from services.wiki_compile.domains.jyotish import make_domain  # noqa: E402


WIKI_BASE = Path(__file__).resolve().parent.parent  # services/jyotish/wiki


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--stats", action="store_true")
    args = parser.parse_args()

    domain = make_domain(WIKI_BASE)

    if args.stats:
        show_stats(domain)
    else:
        compile_all(domain, force=args.force)
        show_stats(domain)
    return 0


if __name__ == "__main__":
    sys.exit(main())
