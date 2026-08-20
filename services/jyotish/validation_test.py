"""
VALIDATION TEST — Fresh cases added AFTER all engine development.
These cases were NEVER used for tuning thresholds, weights, or rules.
Purpose: detect overfitting to the 62-case blind+adversarial set.

All charts computed from birth data via PyJHora engine (no hand-curated positions).
Sources: AstroSage (A-rated), Astrodatabank, public biographies.

Target: >80% accuracy on unseen cases.
"""
import sys, os, json, datetime
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from interpret import interpret_chart
from birth_data_registry import BIRTH_DATA, CASES

# Domain → prediction area mapping
DOMAIN_TO_AREA = {
    'career_rise': 'Career',
    'career_fall': 'Career',
    'death': 'Health',
    'health': 'Health',
    'wealth': 'Wealth & Finance',
    'marriage': 'Marriage & Relationships',
}

EXPECTED_DIRECTION = {
    ('career_rise', 'positive'): 'positive',
    ('career_fall', 'positive'): 'negative',
    ('death', 'positive'): 'negative',
    ('health', 'negative'): 'negative',
    ('wealth', 'positive'): 'positive',
    ('marriage', 'positive'): 'positive',
}

VALIDATION_CASES = [
    # ── Career Rise ──
    {'id': 'VAL-001', 'name': 'Indira Gandhi — became PM of India 1966',
     'domain': 'career_rise', 'known_outcome': 'positive'},
    {'id': 'VAL-002', 'name': 'Steve Jobs — returned as Apple CEO 1997',
     'domain': 'career_rise', 'known_outcome': 'positive'},
    {'id': 'VAL-003', 'name': 'Virat Kohli — India cricket captain 2015',
     'domain': 'career_rise', 'known_outcome': 'positive'},
    {'id': 'VAL-004', 'name': 'Nelson Mandela — first Black president of South Africa 1994',
     'domain': 'career_rise', 'known_outcome': 'positive'},

    # ── Death ──
    {'id': 'VAL-005', 'name': 'John Lennon — shot dead 1980',
     'domain': 'death', 'known_outcome': 'positive'},
    {'id': 'VAL-006', 'name': 'Sridevi — accidental drowning 2018',
     'domain': 'death', 'known_outcome': 'positive'},
    {'id': 'VAL-007', 'name': 'Kobe Bryant — helicopter crash 2020',
     'domain': 'death', 'known_outcome': 'positive'},
    {'id': 'VAL-012', 'name': 'Martin Luther King Jr. — assassinated 1968',
     'domain': 'death', 'known_outcome': 'positive'},
    {'id': 'VAL-013', 'name': 'Indira Gandhi — assassinated 1984',
     'domain': 'death', 'known_outcome': 'positive'},

    # ── Wealth ──
    {'id': 'VAL-008', 'name': 'Ratan Tata — Tata Group peak 2007',
     'domain': 'wealth', 'known_outcome': 'positive'},
    {'id': 'VAL-009', 'name': 'Elon Musk — Tesla/SpaceX surge 2020',
     'domain': 'wealth', 'known_outcome': 'positive'},

    # ── Marriage ──
    {'id': 'VAL-010', 'name': 'King Charles III — marriage to Diana 1981',
     'domain': 'marriage', 'known_outcome': 'positive'},

    # ── Health ──
    {'id': 'VAL-011', 'name': 'Stephen Hawking — ALS diagnosis 1963',
     'domain': 'health', 'known_outcome': 'negative'},
]


def _build_chart_from_engine(case_id: str) -> dict | None:
    """Build chart entirely from engine computation — no hand-curated positions."""
    case_info = CASES.get(case_id)
    if not case_info:
        return None
    person_slug = case_info['person']
    birth = BIRTH_DATA.get(person_slug)
    if not birth:
        return None

    # Try cache first
    try:
        from chart_cache import get_cached_chart, save_chart_cache
        cached = get_cached_chart(birth)
        if cached:
            chart = cached
        else:
            from engine import compute_chart
            from dataclasses import asdict
            result = compute_chart(
                year=birth['year'], month=birth['month'], day=birth['day'],
                hour=birth['hour'], minute=birth['minute'], second=0,
                place_name=birth['place_name'],
                latitude=birth['latitude'], longitude=birth['longitude'],
                timezone_offset=birth['timezone_offset'],
                ayanamsa='LAHIRI',
                divisional_charts=[9, 10],
                analyses=['all'],
            )
            if not result:
                return None
            chart = asdict(result)
            save_chart_cache(birth, chart)
    except Exception as e:
        print(f'  Engine error for {case_id}: {e}')
        return None

    # Add event_date for dasha period matching
    event_date = case_info.get('event_date')
    if event_date:
        chart['event_date'] = event_date

    return chart


def run_validation_test(verbose=True):
    total = len(VALIDATION_CASES)
    correct = 0
    incorrect = 0
    errors = 0
    by_domain = defaultdict(lambda: {'correct': 0, 'incorrect': 0, 'total': 0})

    for case in VALIDATION_CASES:
        cid = case['id']
        domain = case['domain']
        area = DOMAIN_TO_AREA.get(domain, 'Career')
        expected_key = (domain, case['known_outcome'])
        expected_dir = EXPECTED_DIRECTION.get(expected_key, case['known_outcome'])

        try:
            chart = _build_chart_from_engine(cid)
            if not chart:
                errors += 1
                if verbose:
                    print(f'  SKIP {cid}: could not build chart')
                continue

            result = interpret_chart(chart)
            if 'error' in result:
                errors += 1
                if verbose:
                    print(f'  ERROR {cid}: {result["error"]}')
                continue

            pred = next((p for p in result.get('predictions', []) if p['area'] == area), None)
            if not pred:
                errors += 1
                if verbose:
                    print(f'  SKIP {cid}: no prediction for area "{area}"')
                continue

            predicted = pred['direction']
            conf = pred['confidence']
            net = pred.get('net_score', 0)
            is_correct = predicted == expected_dir

            by_domain[domain]['total'] += 1
            if is_correct:
                correct += 1
                by_domain[domain]['correct'] += 1
            else:
                incorrect += 1
                by_domain[domain]['incorrect'] += 1

            mark = 'OK' if is_correct else 'FAIL'
            if verbose:
                print(f'  [{mark}] {cid} ({domain}): predicted={predicted} expected={expected_dir} '
                      f'conf={conf:.2f} net={net:.1f}  |  {case["name"]}')
                if not is_correct:
                    summary = pred.get('summary', '')[:200]
                    print(f'         summary: {summary}')

        except Exception as e:
            errors += 1
            if verbose:
                import traceback
                print(f'  ERROR {cid}: {e}')
                traceback.print_exc()

    evaluated = correct + incorrect
    accuracy = correct / evaluated if evaluated > 0 else 0

    print(f'\n{"="*70}')
    print(f'VALIDATION TEST RESULTS (fresh cases, never used for tuning)')
    print(f'{"="*70}')
    print(f'Total: {total}  |  Evaluated: {evaluated}  |  Errors: {errors}')
    print(f'Accuracy: {correct}/{evaluated} = {accuracy:.1%}')
    print()
    print('--- By Domain ---')
    for d, s in sorted(by_domain.items()):
        acc = s['correct'] / s['total'] if s['total'] > 0 else 0
        print(f'  {d:20s}: {s["correct"]}/{s["total"]} = {acc:.0%}')

    return {'accuracy': accuracy, 'correct': correct, 'evaluated': evaluated, 'by_domain': dict(by_domain)}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Validation test for Jyotish interpretation pipeline')
    parser.add_argument('--verbose', '-v', action='store_true', default=True)
    args = parser.parse_args()
    run_validation_test(verbose=args.verbose)
