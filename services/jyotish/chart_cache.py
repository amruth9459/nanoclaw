"""
Chart cache for computed birth charts.

Avoids re-computing full charts (5+ minutes per case via PyJHora) on every test run.
Cache key: SHA-256 of deterministic birth data fields.
Storage: .chart_cache/ directory, JSON files.
"""

import hashlib
import json
import os

CACHE_DIR = os.path.join(os.path.dirname(__file__), '.chart_cache')


def _cache_key(birth_data: dict) -> str:
    """Deterministic cache key from birth data fields."""
    fields = (
        birth_data.get('year', 0),
        birth_data.get('month', 0),
        birth_data.get('day', 0),
        birth_data.get('hour', 0),
        birth_data.get('minute', 0),
        birth_data.get('latitude', 0),
        birth_data.get('longitude', 0),
        birth_data.get('timezone_offset', 0),
    )
    raw = json.dumps(fields, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def get_cached_chart(birth_data: dict) -> dict | None:
    """Load cached chart if available."""
    key = _cache_key(birth_data)
    path = os.path.join(CACHE_DIR, f'{key}.json')
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return None
    return None


def save_chart_cache(birth_data: dict, chart: dict) -> None:
    """Save computed chart to cache."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    key = _cache_key(birth_data)
    path = os.path.join(CACHE_DIR, f'{key}.json')
    try:
        with open(path, 'w') as f:
            json.dump(chart, f, default=str)
    except OSError:
        pass  # Cache write failure is non-fatal


def clear_cache() -> int:
    """Clear all cached charts. Returns count of files removed."""
    if not os.path.exists(CACHE_DIR):
        return 0
    count = 0
    for f in os.listdir(CACHE_DIR):
        if f.endswith('.json'):
            os.remove(os.path.join(CACHE_DIR, f))
            count += 1
    return count
