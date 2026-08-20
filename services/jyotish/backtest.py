"""
Backtesting Harness for Jyotish Interpretation Pipeline.
Runs ground truth cases through interpret_chart() and measures prediction accuracy.

Usage:
    python3 backtest.py                    # Run all tests
    python3 backtest.py --domain career    # Filter by domain
    python3 backtest.py --source kn_rao    # Filter by source
    python3 backtest.py --verbose          # Show per-case details
"""
import json
import sys
import os
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from interpret import interpret_chart
from ground_truth import GROUND_TRUTH


# ── Domain → prediction area mapping ──────────────────────────────────────
DOMAIN_TO_AREA = {
    'career_rise': 'Career',
    'career_fall': 'Career',
    'marriage_timing': 'Marriage & Relationships',
    'marriage_problems': 'Marriage & Relationships',
    'wealth': 'Wealth & Finance',
    'health': 'Health',
    'death': 'Health',
    'longevity': 'Health',
    'accident': 'Health',
    'mental_health': 'Mental Health',
    'spiritual': 'Spiritual',
    'education': 'Career',
    'foreign_travel': 'Career',
    'legal': 'Health',  # conflict/adversity bucket
    'children': 'Marriage & Relationships',
}

# Expected direction from known_outcome + domain
EXPECTED_DIRECTION = {
    ('career_rise', 'positive'): 'positive',
    ('career_rise', 'negative'): 'negative',
    ('career_fall', 'positive'): 'negative',  # career_fall with positive outcome means fall happened
    ('career_fall', 'negative'): 'positive',
    ('marriage_timing', 'positive'): 'positive',
    ('marriage_timing', 'negative'): 'negative',
    ('marriage_problems', 'positive'): 'negative',  # problems confirmed
    ('marriage_problems', 'negative'): 'positive',
    ('wealth', 'positive'): 'positive',
    ('wealth', 'negative'): 'negative',
    ('health', 'positive'): 'positive',
    ('health', 'negative'): 'negative',
    ('death', 'positive'): 'negative',  # death event = negative health
    ('death', 'negative'): 'positive',
    ('longevity', 'positive'): 'positive',
    ('longevity', 'negative'): 'negative',
    ('spiritual', 'positive'): 'positive',
    ('education', 'positive'): 'positive',
    ('education', 'negative'): 'negative',
    ('foreign_travel', 'positive'): 'positive',
    ('foreign_travel', 'negative'): 'negative',
    ('legal', 'positive'): 'negative',
    ('legal', 'negative'): 'positive',
    ('accident', 'positive'): 'negative',
    ('children', 'positive'): 'positive',
    ('children', 'negative'): 'negative',
    ('mental_health', 'positive'): 'positive',
    ('mental_health', 'negative'): 'negative',
}


def _build_chart_data(gt_case: dict) -> dict:
    """Convert ground truth case into chart_data dict for interpret_chart."""
    lagna = gt_case['lagna']
    planets = gt_case.get('planets', {})

    rasi = [{'body': 'Lagna', 'rashi': lagna}]
    for name, rashi in planets.items():
        rasi.append({
            'body': name,
            'rashi': rashi,
            'degrees': 15.0,  # approximate mid-sign
            'retro': False,
        })

    # Build vimshottari from dasha info — dates must surround today
    import datetime
    today_year = datetime.date.today().year
    vimshottari = []
    md = gt_case.get('dasha_lord', '')
    if md:
        vimshottari.append({
            'level': 'maha',
            'lord': md,
            'start_date': f'{today_year - 3}-01-01',
            'end_date': f'{today_year + 4}-01-01',
        })
    ad = gt_case.get('antardasha_lord', '')
    if ad:
        vimshottari.append({
            'level': 'antar',
            'lord': f'{md}/{ad}' if md else ad,
            'start_date': f'{today_year - 1}-01-01',
            'end_date': f'{today_year + 1}-01-01',
        })

    return {
        'rasi': rasi,
        'vimshottari': vimshottari,
        'birth_date': str(gt_case.get('event_year', '2000')),
        'place_name': gt_case.get('id', ''),
        'transits': {},
        'karakas': {},
        'navamsha': [],
        'shadbala': {},
        'doshas': {},
        'ashtakavarga_sav': [],
        'ashtakavarga_bav': {},
    }


def run_backtest(domain_filter=None, source_filter=None, verbose=False,
                 use_llm=False, model='gemini-2.0-flash', use_cache=True):
    """Run all ground truth cases through the pipeline and score accuracy."""
    if use_llm:
        from llm_synthesizer import interpret_chart_llm, print_cost_summary, reset_cost_tracking
        reset_cost_tracking()
        _interpret = lambda chart: interpret_chart_llm(chart, model=model, use_cache=use_cache)
        print(f'Using LLM synthesis: {model}\n')
    else:
        _interpret = interpret_chart

    cases = GROUND_TRUTH

    if domain_filter:
        cases = [c for c in cases if domain_filter in c.get('domain', '')]
    if source_filter:
        cases = [c for c in cases if c.get('source', '') == source_filter]

    total = len(cases)
    if total == 0:
        print("No cases match filters.")
        return

    # Metrics
    correct = 0
    incorrect = 0
    skipped = 0
    errors = 0
    by_domain = defaultdict(lambda: {'correct': 0, 'incorrect': 0, 'total': 0})
    by_source = defaultdict(lambda: {'correct': 0, 'incorrect': 0, 'total': 0})
    confidence_when_correct = []
    confidence_when_incorrect = []
    yoga_detection_hits = 0
    yoga_detection_total = 0

    for i, gt in enumerate(cases):
        case_id = gt.get('id', f'case_{i}')
        domain = gt.get('domain', 'unknown')
        source = gt.get('source', 'unknown')
        known_outcome = gt.get('known_outcome', 'unknown')
        area = DOMAIN_TO_AREA.get(domain, 'Career')

        try:
            chart_data = _build_chart_data(gt)
            result = _interpret(chart_data)

            if 'error' in result:
                skipped += 1
                if verbose:
                    print(f"  SKIP {case_id}: {result['error']}")
                continue

            # Find the relevant prediction
            predictions = result.get('predictions', [])
            pred = None
            for p in predictions:
                if p.get('area') == area:
                    pred = p
                    break

            # Fallback: Mental Health → Health for rule-based engine
            if not pred and area == 'Mental Health':
                for p in predictions:
                    if p.get('area') == 'Health':
                        pred = p
                        break

            if not pred:
                skipped += 1
                if verbose:
                    print(f"  SKIP {case_id}: no prediction for area '{area}'")
                continue

            predicted_dir = pred.get('direction', 'mixed')
            confidence = pred.get('confidence', 0.5)

            # What direction did we expect?
            expected_key = (domain, known_outcome)
            expected_dir = EXPECTED_DIRECTION.get(expected_key, known_outcome)

            # Score: direction match
            is_correct = (predicted_dir == expected_dir) or \
                         (predicted_dir == 'mixed' and expected_dir in ('positive', 'negative'))
            # Partial credit: mixed is half-right when expecting positive/negative
            if predicted_dir == 'mixed':
                is_correct = False  # strict mode

            by_domain[domain]['total'] += 1
            by_source[source]['total'] += 1

            if is_correct:
                correct += 1
                by_domain[domain]['correct'] += 1
                by_source[source]['correct'] += 1
                confidence_when_correct.append(confidence)
            else:
                incorrect += 1
                by_domain[domain]['incorrect'] += 1
                by_source[source]['incorrect'] += 1
                confidence_when_incorrect.append(confidence)

            # Yoga detection accuracy
            key_yogas = gt.get('key_yogas', [])
            if key_yogas:
                detected_yogas = [y.get('yoga', '').lower() for y in result.get('yogas', {}).get('yogas', [])]
                detected_names = set()
                for dy in detected_yogas:
                    # Normalize yoga names
                    for ky in key_yogas:
                        if ky.lower() in dy.lower() or dy.lower() in ky.lower():
                            detected_names.add(ky)
                yoga_detection_total += len(key_yogas)
                yoga_detection_hits += len(detected_names)

            if verbose:
                mark = 'OK' if is_correct else 'FAIL'
                print(f"  [{mark}] {case_id} ({domain}): predicted={predicted_dir} expected={expected_dir} conf={confidence:.2f}")
                if not is_correct:
                    print(f"         net_score={pred.get('net_score', 0)}, confirmations={pred.get('confirmations', 0)}")

        except Exception as e:
            errors += 1
            if verbose:
                print(f"  ERROR {case_id}: {e}")

    # ── Report ──────────────────────────────────────────────────────────────
    evaluated = correct + incorrect
    accuracy = correct / evaluated if evaluated > 0 else 0

    print(f"\n{'='*60}")
    print(f"BACKTEST RESULTS")
    print(f"{'='*60}")
    print(f"Total cases: {total}")
    print(f"Evaluated:   {evaluated}")
    print(f"Skipped:     {skipped}")
    print(f"Errors:      {errors}")
    print(f"")
    print(f"Accuracy:    {correct}/{evaluated} = {accuracy:.1%}")
    print(f"Correct:     {correct}")
    print(f"Incorrect:   {incorrect}")

    if confidence_when_correct:
        avg_c = sum(confidence_when_correct) / len(confidence_when_correct)
        print(f"Avg conf (correct):   {avg_c:.2f}")
    if confidence_when_incorrect:
        avg_i = sum(confidence_when_incorrect) / len(confidence_when_incorrect)
        print(f"Avg conf (incorrect): {avg_i:.2f}")

    # Calibration check: confidence should be higher when correct
    if confidence_when_correct and confidence_when_incorrect:
        avg_c = sum(confidence_when_correct) / len(confidence_when_correct)
        avg_i = sum(confidence_when_incorrect) / len(confidence_when_incorrect)
        if avg_c > avg_i:
            print(f"Calibration: GOOD (correct {avg_c:.2f} > incorrect {avg_i:.2f})")
        else:
            print(f"Calibration: POOR (correct {avg_c:.2f} <= incorrect {avg_i:.2f})")

    # By domain
    print(f"\n--- By Domain ---")
    for domain, stats in sorted(by_domain.items()):
        acc = stats['correct'] / stats['total'] if stats['total'] > 0 else 0
        print(f"  {domain:25s}: {stats['correct']}/{stats['total']} = {acc:.0%}")

    # By source
    print(f"\n--- By Source ---")
    for source, stats in sorted(by_source.items()):
        acc = stats['correct'] / stats['total'] if stats['total'] > 0 else 0
        print(f"  {source:15s}: {stats['correct']}/{stats['total']} = {acc:.0%}")

    # Yoga detection
    if yoga_detection_total > 0:
        yoga_acc = yoga_detection_hits / yoga_detection_total
        print(f"\n--- Yoga Detection ---")
        print(f"  Detected: {yoga_detection_hits}/{yoga_detection_total} = {yoga_acc:.0%}")

    if use_llm:
        print_cost_summary()

    return {
        'accuracy': accuracy,
        'total': total,
        'evaluated': evaluated,
        'correct': correct,
        'incorrect': incorrect,
        'skipped': skipped,
        'errors': errors,
        'by_domain': dict(by_domain),
        'by_source': dict(by_source),
    }


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Backtest Jyotish interpretation pipeline')
    parser.add_argument('--domain', help='Filter by domain (e.g. career, marriage)')
    parser.add_argument('--source', help='Filter by source (kn_rao, bv_raman, sanjay_rath)')
    parser.add_argument('--verbose', '-v', action='store_true', help='Show per-case details')
    parser.add_argument('--llm', action='store_true', help='Use LLM synthesis instead of rule-based stage7')
    parser.add_argument('--model', default='gemini-2.0-flash',
                        help='LLM model (gemini-2.0-flash, gemini-2.5-flash, claude-sonnet, claude-haiku)')
    parser.add_argument('--no-cache', action='store_true', help='Disable LLM response cache')
    args = parser.parse_args()

    run_backtest(
        domain_filter=args.domain,
        source_filter=args.source,
        verbose=args.verbose,
        use_llm=args.llm,
        model=args.model,
        use_cache=not args.no_cache,
    )
