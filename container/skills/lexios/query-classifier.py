#!/usr/bin/env python3
"""Fast keyword-based query classifier (<50ms).
Port of Lexios/backend/services/query_router.py keywords.

Usage: echo "where is room 101" | lexios-classify
   or: lexios-classify "where is room 101"

Output: JSON with complexity and route fields.
"""
import sys
import json
import re

SIMPLE_KW = {'where', 'find', 'locate', 'show', 'list', 'how many', 'count', 'what is', 'which', 'what are'}
COMPLEX_KW = {'comply', 'compliance', 'code', 'requirement', 'calculate', 'analyze', 'compare', 'conflict', 'difference', 'between'}
CRITICAL_KW = {'safety', 'fire', 'emergency', 'exit', 'egress', 'ada', 'ibc', 'nfpa', 'structural', 'load', 'seismic', 'wind', 'bearing'}

LOCATION_KW = {'where', 'find', 'locate', 'location', 'floor', 'room', 'near', 'next to', 'adjacent'}
QUANTITY_KW = {'how many', 'count', 'total', 'number of', 'quantity', 'takeoff'}
SPEC_KW = {'what is', 'what are', 'type of', 'material', 'specification', 'spec', 'size', 'dimension'}
COMPLIANCE_KW = {'comply', 'compliance', 'code', 'ibc', 'ada', 'nfpa', 'osha', 'requirement', 'violation', 'legal'}

def classify_category(query_lower):
    """Classify query into a category based on keywords."""
    if any(kw in query_lower for kw in COMPLIANCE_KW):
        return "compliance"
    if any(kw in query_lower for kw in QUANTITY_KW):
        return "quantity"
    if any(kw in query_lower for kw in LOCATION_KW):
        return "location"
    if any(kw in query_lower for kw in SPEC_KW):
        return "specification"
    return "general"

def classify(query):
    """Classify a query into complexity + route + category."""
    query_lower = query.lower().strip()
    words = query_lower.split()
    word_count = len(words)

    # Critical always goes to LLM
    if any(kw in query_lower for kw in CRITICAL_KW):
        return {
            "complexity": "critical",
            "route": "llm",
            "category": classify_category(query_lower),
        }

    # Complex: multiple complex keywords or long query
    complex_hits = sum(1 for kw in COMPLEX_KW if kw in query_lower)
    if complex_hits >= 2 or word_count > 20:
        return {
            "complexity": "complex",
            "route": "llm",
            "category": classify_category(query_lower),
        }

    # Simple: known simple patterns + short query
    if any(kw in query_lower for kw in SIMPLE_KW) and word_count < 10:
        return {
            "complexity": "simple",
            "route": "cache",
            "category": classify_category(query_lower),
        }

    return {
        "complexity": "moderate",
        "route": "extraction",
        "category": classify_category(query_lower),
    }


if __name__ == '__main__':
    if len(sys.argv) > 1:
        query = ' '.join(sys.argv[1:])
    else:
        query = sys.stdin.read().strip()

    if not query:
        print(json.dumps({"error": "No query provided"}))
        sys.exit(1)

    print(json.dumps(classify(query)))
