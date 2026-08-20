"""
K-Fold Cross-Validation & Leave-One-Out for Jyotish Interpretation Pipeline.

For a rule-based system, CV measures whether rules generalize — i.e., would the
pipeline still get the right answer on cases it wasn't "tuned for"?

Since we can't retrain (rules are static), we measure:
1. Leave-One-Out (LOO): Run each case, check if it passes. Report marginal cases.
2. Sensitivity analysis: How close is each case to the decision boundary?
3. Robustness: Perturb dasha lords randomly, measure accuracy degradation.
4. Confidence calibration: Are high-confidence predictions more likely correct?

Usage:
    python3 crossval.py              # Full analysis
    python3 crossval.py --loo        # Leave-one-out only
    python3 crossval.py --perturb    # Perturbation robustness test
"""
import sys, os, json, random, copy
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from interpret import interpret_chart
from ground_truth import GROUND_TRUTH
from blind_test import BLIND_CASES, _build_chart as _build_blind_chart

# Import shared mappings from backtest
from backtest import DOMAIN_TO_AREA, EXPECTED_DIRECTION, _build_chart_data

import datetime
today_year = datetime.date.today().year

SIGNS = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
         'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces']
PLANETS = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn', 'Rahu', 'Ketu']


def _evaluate_case(chart_data, domain, known_outcome, area):
    """Run a single case and return (is_correct, direction, expected, net_score, confidence)."""
    try:
        result = interpret_chart(chart_data)
        if 'error' in result:
            return None

        pred = next((p for p in result.get('predictions', []) if p['area'] == area), None)
        if not pred:
            return None

        predicted = pred['direction']
        expected_key = (domain, known_outcome)
        expected = EXPECTED_DIRECTION.get(expected_key, known_outcome)
        is_correct = predicted == expected
        return (is_correct, predicted, expected, pred.get('net_score', 0), pred.get('confidence', 0.5))
    except Exception:
        return None


def run_loo_analysis():
    """Leave-One-Out: run every case, report marginal ones near decision boundary."""
    print("=" * 70)
    print("LEAVE-ONE-OUT ANALYSIS")
    print("=" * 70)

    # Training set
    print("\n--- Training Set (30 cases) ---")
    marginal_train = []
    correct_train = 0
    total_train = 0
    for gt in GROUND_TRUTH:
        domain = gt.get('domain', '')
        area = DOMAIN_TO_AREA.get(domain, 'Career')
        chart = _build_chart_data(gt)
        result = _evaluate_case(chart, domain, gt.get('known_outcome', ''), area)
        if result is None:
            continue
        total_train += 1
        is_correct, predicted, expected, net, conf = result
        if is_correct:
            correct_train += 1
        margin = abs(net) - 2  # distance from ±2 threshold
        if margin < 3:  # within 3 points of flipping
            marginal_train.append((gt['id'], domain, predicted, expected, net, conf, margin, is_correct))

    acc_train = correct_train / total_train if total_train > 0 else 0
    print(f"Accuracy: {correct_train}/{total_train} = {acc_train:.1%}")
    print(f"Marginal cases (within 3 pts of threshold flip):")
    for cid, dom, pred, exp, net, conf, margin, ok in sorted(marginal_train, key=lambda x: x[6]):
        mark = "OK" if ok else "FAIL"
        print(f"  [{mark}] {cid} ({dom}): net={net:.1f} margin={margin:.1f} conf={conf:.2f}")

    # Blind set
    print("\n--- Blind Set (14 cases) ---")
    marginal_blind = []
    correct_blind = 0
    total_blind = 0
    for case in BLIND_CASES:
        domain = case['domain']
        area = DOMAIN_TO_AREA.get(domain, 'Career')
        chart = _build_blind_chart(case)
        result = _evaluate_case(chart, domain, case.get('known_outcome', ''), area)
        if result is None:
            continue
        total_blind += 1
        is_correct, predicted, expected, net, conf = result
        if is_correct:
            correct_blind += 1
        margin = abs(net) - 2
        if margin < 3:
            marginal_blind.append((case['id'], domain, predicted, expected, net, conf, margin, is_correct))

    acc_blind = correct_blind / total_blind if total_blind > 0 else 0
    print(f"Accuracy: {correct_blind}/{total_blind} = {acc_blind:.1%}")
    print(f"Marginal cases (within 3 pts of threshold flip):")
    for cid, dom, pred, exp, net, conf, margin, ok in sorted(marginal_blind, key=lambda x: x[6]):
        mark = "OK" if ok else "FAIL"
        print(f"  [{mark}] {cid} ({dom}): net={net:.1f} margin={margin:.1f} conf={conf:.2f}")

    # Combined
    total = total_train + total_blind
    correct = correct_train + correct_blind
    print(f"\n--- Combined ---")
    print(f"Accuracy: {correct}/{total} = {correct/total:.1%}" if total > 0 else "No cases")
    print(f"Total marginal: {len(marginal_train) + len(marginal_blind)}/{total}")

    return {
        'train': {'accuracy': acc_train, 'correct': correct_train, 'total': total_train, 'marginal': len(marginal_train)},
        'blind': {'accuracy': acc_blind, 'correct': correct_blind, 'total': total_blind, 'marginal': len(marginal_blind)},
    }


def run_perturbation_test(n_perturbations=100):
    """Perturbation robustness: randomly change dasha lords, measure accuracy drop.
    A robust system degrades gracefully; an overfit one collapses."""
    print("\n" + "=" * 70)
    print("PERTURBATION ROBUSTNESS TEST")
    print("=" * 70)

    random.seed(42)

    # Baseline on training set
    baseline_correct = 0
    baseline_total = 0
    for gt in GROUND_TRUTH:
        domain = gt.get('domain', '')
        area = DOMAIN_TO_AREA.get(domain, 'Career')
        chart = _build_chart_data(gt)
        result = _evaluate_case(chart, domain, gt.get('known_outcome', ''), area)
        if result and result[0]:
            baseline_correct += 1
        if result:
            baseline_total += 1

    print(f"Baseline accuracy: {baseline_correct}/{baseline_total} = {baseline_correct/baseline_total:.1%}")

    # Perturbation levels
    for perturb_type, desc in [
        ('dasha_swap', 'Random dasha lord swap'),
        ('sign_shift', 'Shift 1-2 planets by one sign'),
        ('lagna_shift', 'Shift lagna by one sign'),
    ]:
        accuracies = []
        for trial in range(n_perturbations):
            correct = 0
            total = 0
            for gt in GROUND_TRUTH:
                perturbed = copy.deepcopy(gt)

                if perturb_type == 'dasha_swap':
                    # Swap dasha lord to a random planet
                    perturbed['dasha_lord'] = random.choice(PLANETS[:7])  # no Rahu/Ketu
                elif perturb_type == 'sign_shift':
                    # Shift 1-2 random planets by ±1 sign
                    planets_to_shift = random.sample(list(perturbed['planets'].keys()), min(2, len(perturbed['planets'])))
                    for p in planets_to_shift:
                        idx = SIGNS.index(perturbed['planets'][p])
                        shift = random.choice([-1, 1])
                        perturbed['planets'][p] = SIGNS[(idx + shift) % 12]
                elif perturb_type == 'lagna_shift':
                    idx = SIGNS.index(perturbed['lagna'])
                    shift = random.choice([-1, 1])
                    perturbed['lagna'] = SIGNS[(idx + shift) % 12]

                domain = perturbed.get('domain', '')
                area = DOMAIN_TO_AREA.get(domain, 'Career')
                chart = _build_chart_data(perturbed)
                result = _evaluate_case(chart, domain, perturbed.get('known_outcome', ''), area)
                if result:
                    total += 1
                    if result[0]:
                        correct += 1

            if total > 0:
                accuracies.append(correct / total)

        avg = sum(accuracies) / len(accuracies) if accuracies else 0
        std = (sum((a - avg) ** 2 for a in accuracies) / len(accuracies)) ** 0.5 if accuracies else 0
        drop = (baseline_correct / baseline_total - avg) if baseline_total > 0 else 0
        print(f"\n{desc}:")
        print(f"  Mean accuracy: {avg:.1%} ± {std:.1%}")
        print(f"  Drop from baseline: {drop:.1%}")
        print(f"  Min/Max: {min(accuracies):.1%} / {max(accuracies):.1%}")

        # Interpretation
        if drop < 0.1:
            print(f"  ⚠ LOW SENSITIVITY — predictions barely change. Possible overfitting to static rules.")
        elif drop < 0.3:
            print(f"  ✓ MODERATE SENSITIVITY — reasonable degradation. Rules capture real patterns.")
        else:
            print(f"  ✓ HIGH SENSITIVITY — predictions depend on input. System is responsive.")


def run_confidence_calibration():
    """Check if confidence scores are calibrated: higher confidence → more likely correct."""
    print("\n" + "=" * 70)
    print("CONFIDENCE CALIBRATION ANALYSIS")
    print("=" * 70)

    all_results = []

    # Training set
    for gt in GROUND_TRUTH:
        domain = gt.get('domain', '')
        area = DOMAIN_TO_AREA.get(domain, 'Career')
        chart = _build_chart_data(gt)
        result = _evaluate_case(chart, domain, gt.get('known_outcome', ''), area)
        if result:
            all_results.append(('train', gt['id'], *result))

    # Blind set
    for case in BLIND_CASES:
        domain = case['domain']
        area = DOMAIN_TO_AREA.get(domain, 'Career')
        chart = _build_blind_chart(case)
        result = _evaluate_case(chart, domain, case.get('known_outcome', ''), area)
        if result:
            all_results.append(('blind', case['id'], *result))

    # Bin by confidence
    bins = [(0, 0.4, 'Low'), (0.4, 0.6, 'Medium'), (0.6, 0.8, 'High'), (0.8, 1.0, 'Very High')]
    print(f"\n{'Confidence':>12s} | {'Correct':>7s} | {'Total':>5s} | {'Accuracy':>8s} | Cases")
    print("-" * 70)
    for lo, hi, label in bins:
        in_bin = [(src, cid, ok, pred, exp, net, conf) for src, cid, ok, pred, exp, net, conf in all_results
                  if lo <= conf < hi]
        if in_bin:
            n_correct = sum(1 for *_, ok, _, _, _, _ in in_bin if ok)
            n_total = len(in_bin)
            acc = n_correct / n_total
            case_ids = ', '.join(f'{cid}' for _, cid, *_ in in_bin[:5])
            print(f"  {label:>10s} | {n_correct:>7d} | {n_total:>5d} | {acc:>7.0%} | {case_ids}")

    # Correlation: confidence vs correctness
    correct_confs = [conf for _, _, ok, _, _, _, conf in all_results if ok]
    incorrect_confs = [conf for _, _, ok, _, _, _, conf in all_results if not ok]

    if correct_confs:
        avg_correct = sum(correct_confs) / len(correct_confs)
        print(f"\nAvg confidence when CORRECT:   {avg_correct:.3f} (n={len(correct_confs)})")
    if incorrect_confs:
        avg_incorrect = sum(incorrect_confs) / len(incorrect_confs)
        print(f"Avg confidence when INCORRECT: {avg_incorrect:.3f} (n={len(incorrect_confs)})")
    else:
        print(f"\nNo incorrect predictions to compare.")

    if correct_confs and incorrect_confs:
        if avg_correct > avg_incorrect:
            print(f"Calibration: GOOD — higher confidence on correct predictions")
        else:
            print(f"Calibration: POOR — confidence doesn't track accuracy")
    elif correct_confs and not incorrect_confs:
        print(f"Calibration: UNTESTABLE — no incorrect predictions to compare against")

    # Net score distribution
    print(f"\n--- Net Score Distribution ---")
    nets = [(cid, net, ok) for _, cid, ok, _, _, net, _ in all_results]
    nets.sort(key=lambda x: x[1])
    print(f"{'Case':>12s} | {'Net Score':>9s} | {'Correct':>7s} | Margin from ±2")
    print("-" * 55)
    for cid, net, ok in nets:
        margin = abs(net) - 2
        mark = "✓" if ok else "✗"
        bar = "█" * max(0, int(margin))
        print(f"  {cid:>10s} | {net:>+9.1f} | {mark:>7s} | {margin:>+5.1f} {bar}")


def run_domain_stress_test():
    """Check each domain's robustness by testing with randomized charts."""
    print("\n" + "=" * 70)
    print("DOMAIN STRESS TEST — Random charts per domain")
    print("=" * 70)

    random.seed(123)
    domains_tested = defaultdict(lambda: {'pos': 0, 'neg': 0, 'mix': 0, 'err': 0, 'total': 0})

    for _ in range(200):
        lagna = random.choice(SIGNS)
        planet_signs = {p: random.choice(SIGNS) for p in PLANETS}
        md_lord = random.choice(PLANETS[:7])
        ad_lord = random.choice(PLANETS[:7])

        chart = {
            'rasi': [{'body': 'Lagna', 'rashi': lagna}] +
                    [{'body': p, 'rashi': s, 'degrees': 15.0, 'retro': False}
                     for p, s in planet_signs.items()],
            'vimshottari': [
                {'level': 'maha', 'lord': md_lord,
                 'start_date': f'{today_year-3}-01-01', 'end_date': f'{today_year+4}-01-01'},
                {'level': 'antar', 'lord': f'{md_lord}/{ad_lord}',
                 'start_date': f'{today_year-1}-01-01', 'end_date': f'{today_year+1}-01-01'},
            ],
            'birth_date': '2000', 'place_name': 'stress_test',
            'transits': {}, 'karakas': {}, 'navamsha': [],
            'shadbala': {}, 'doshas': {},
            'ashtakavarga_sav': [], 'ashtakavarga_bav': {},
        }

        try:
            result = interpret_chart(chart)
            if 'error' in result:
                continue
            for pred in result.get('predictions', []):
                area = pred['area']
                d = pred['direction']
                domains_tested[area]['total'] += 1
                if d == 'positive':
                    domains_tested[area]['pos'] += 1
                elif d == 'negative':
                    domains_tested[area]['neg'] += 1
                else:
                    domains_tested[area]['mix'] += 1
        except Exception:
            pass

    print(f"\n{'Domain':>25s} | {'Total':>5s} | {'Pos%':>5s} | {'Neg%':>5s} | {'Mix%':>5s} | Balance")
    print("-" * 75)
    for area, stats in sorted(domains_tested.items()):
        t = stats['total']
        if t == 0:
            continue
        pp = stats['pos'] / t
        pn = stats['neg'] / t
        pm = stats['mix'] / t
        balance = abs(pp - pn)
        flag = "⚠ BIASED" if balance > 0.4 else "✓ OK"
        print(f"  {area:>23s} | {t:>5d} | {pp:>4.0%} | {pn:>4.0%} | {pm:>4.0%} | {flag} ({balance:.2f})")

    print(f"\nNote: Random charts should produce roughly balanced pos/neg predictions.")
    print(f"Strong bias (>40% gap) suggests the pipeline has a systematic tilt.")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Cross-validation for Jyotish pipeline')
    parser.add_argument('--loo', action='store_true', help='Leave-one-out analysis only')
    parser.add_argument('--perturb', action='store_true', help='Perturbation robustness only')
    parser.add_argument('--calibration', action='store_true', help='Confidence calibration only')
    parser.add_argument('--stress', action='store_true', help='Domain stress test only')
    args = parser.parse_args()

    run_all = not (args.loo or args.perturb or args.calibration or args.stress)

    if run_all or args.loo:
        run_loo_analysis()
    if run_all or args.calibration:
        run_confidence_calibration()
    if run_all or args.perturb:
        run_perturbation_test()
    if run_all or args.stress:
        run_domain_stress_test()
