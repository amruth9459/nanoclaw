"""
Comparison harness: PyJHora vs VedAstro API vs known reference data.
Validates calculations to match Jagannatha Hora exactly.
"""

import json
import requests
from engine import compute_chart, ChartData, RASHI


def vedastro_chart(year, month, day, hour, minute, second,
                   latitude, longitude, timezone_offset):
    """Fetch chart from VedAstro API for comparison."""
    # VedAstro API format: /Calculate/AllPlanetData/Location/...
    # Free API at api.vedastro.org
    time_str = f"{hour:02d}:{minute:02d} {day:02d}/{month:02d}/{year}"
    tz_sign = "+" if timezone_offset >= 0 else "-"
    tz_h = int(abs(timezone_offset))
    tz_m = int((abs(timezone_offset) - tz_h) * 60)
    tz_str = f"{tz_sign}{tz_h:02d}:{tz_m:02d}"
    loc_str = f"Location/{latitude}/{longitude}/{tz_str}"

    base = "https://api.vedastro.org"

    results = {}

    # Get all planet positions
    planets = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn', 'Rahu', 'Ketu']
    for planet in planets:
        try:
            url = f"{base}/Calculate/PlanetZodiacSign/{planet}/Time/{time_str}/{loc_str}"
            resp = requests.get(url, timeout=15)
            if resp.status_code == 200:
                data = resp.json()
                results[planet] = data
        except Exception as e:
            results[planet] = {'error': str(e)}

    return results


def compare_charts(birth_data: dict) -> dict:
    """
    Run PyJHora and VedAstro for the same birth data and compare.

    birth_data = {
        'year': 2000, 'month': 1, 'day': 1,
        'hour': 12, 'minute': 0, 'second': 0,
        'place_name': 'Delhi',
        'latitude': 28.6139, 'longitude': 77.2090,
        'timezone_offset': 5.5,
    }
    """
    # PyJHora
    pyjhora = compute_chart(**birth_data)

    # VedAstro
    vedastro = vedastro_chart(
        birth_data['year'], birth_data['month'], birth_data['day'],
        birth_data['hour'], birth_data['minute'], birth_data.get('second', 0),
        birth_data['latitude'], birth_data['longitude'],
        birth_data['timezone_offset'],
    )

    # Compare rashi placements
    report = {
        'birth_data': birth_data,
        'matches': [],
        'mismatches': [],
        'vedastro_raw': vedastro,
    }

    for pos in pyjhora.rasi:
        if pos.body == 'Lagna':
            continue
        va = vedastro.get(pos.body, {})
        if 'error' in va:
            report['mismatches'].append({
                'planet': pos.body,
                'pyjhora': pos.rashi,
                'vedastro': f'ERROR: {va["error"]}',
            })
        else:
            # Try to extract sign from VedAstro response
            va_sign = str(va).lower() if va else ''
            pj_sign = pos.rashi.lower()
            if pj_sign in va_sign:
                report['matches'].append({
                    'planet': pos.body,
                    'sign': pos.rashi,
                    'pyjhora_deg': pos.degrees,
                })
            else:
                report['mismatches'].append({
                    'planet': pos.body,
                    'pyjhora': f'{pos.rashi} {pos.degrees}°',
                    'vedastro': str(va),
                })

    return report


def compare_with_reference(birth_data: dict, reference: dict) -> dict:
    """
    Compare PyJHora output against known JH reference values.

    reference = {
        'Sun': {'rashi': 'Sagittarius', 'deg': 15, 'min': 24},
        'Moon': {'rashi': 'Libra', 'deg': 15, 'min': 49},
        ...
    }
    """
    chart = compute_chart(**birth_data)

    matches = []
    mismatches = []

    for pos in chart.rasi:
        if pos.body == 'Lagna' and 'Lagna' not in reference:
            continue
        ref = reference.get(pos.body)
        if not ref:
            continue

        rashi_match = pos.rashi == ref['rashi']
        deg_match = pos.deg == ref['deg']
        min_match = pos.min == ref['min']

        if rashi_match and deg_match and min_match:
            matches.append(pos.body)
        else:
            mismatches.append({
                'planet': pos.body,
                'pyjhora': f'{pos.rashi} {pos.deg}°{pos.min:02d}\'',
                'reference': f'{ref["rashi"]} {ref["deg"]}°{ref["min"]:02d}\'',
                'rashi_match': rashi_match,
                'deg_match': deg_match,
            })

    total = len(matches) + len(mismatches)
    return {
        'accuracy': f'{len(matches)}/{total}' if total > 0 else 'N/A',
        'matches': matches,
        'mismatches': mismatches,
    }


if __name__ == "__main__":
    birth = {
        'year': 2000, 'month': 1, 'day': 1,
        'hour': 12, 'minute': 0, 'second': 0,
        'place_name': 'Delhi',
        'latitude': 28.6139, 'longitude': 77.2090,
        'timezone_offset': 5.5,
    }

    print("Running PyJHora vs VedAstro comparison...")
    print("=" * 55)
    report = compare_charts(birth)

    print(f"\nMatches ({len(report['matches'])}):")
    for m in report['matches']:
        print(f"  {m['planet']:10s} {m['sign']:13s} {m['pyjhora_deg']}°")

    print(f"\nMismatches ({len(report['mismatches'])}):")
    for m in report['mismatches']:
        print(f"  {m['planet']:10s} PyJHora={m['pyjhora']}  VedAstro={m['vedastro']}")

    print("\nVedAstro raw responses:")
    for planet, data in report['vedastro_raw'].items():
        print(f"  {planet}: {json.dumps(data)[:120]}")
