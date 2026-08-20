"""Generic LLM Wiki v2 compile pipeline. Domain-pluggable.

Extracted from services/jyotish/wiki/scripts/compile_jyotish_wiki.py so that
multiple knowledge bases (Jyotish, Brain/Claw shared memory, Lexios) share the
same compile/graph/index machinery and any improvement lifts all consumers.

A *domain* supplies four pluggable functions; the lib runs the pipeline.
"""
from .lib import (
    Domain,
    compile_all,
    compile_file,
    build_knowledge_graph,
    generate_index,
    show_stats,
    calculate_confidence,
)

__all__ = [
    "Domain",
    "compile_all",
    "compile_file",
    "build_knowledge_graph",
    "generate_index",
    "show_stats",
    "calculate_confidence",
]
