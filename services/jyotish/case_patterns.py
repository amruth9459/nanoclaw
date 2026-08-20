"""
Case-Study Pattern Library for the Jyotish Synthesis Engine.

Extracted from 126 case studies across three master astrologers:
  - KN Rao  (KNR-CS-001..066)  — 4 books
  - BV Raman (BVR-CS-001..034) — Hindu Predictive Astrology
  - Sanjay Rath (SR-CS-001..032) — Crux of Vedic Astrology + Vimsottari & Udu Dasas

Each pattern cluster groups 2+ cases that show the SAME combination producing the
SAME category of result.  Patterns are ordered by confidence (more evidence = first).

Usage in interpret.py:
    from case_patterns import CASE_PATTERNS
    # During synthesis, iterate matching patterns and add confidence_boost.
"""

# ── CASE_PATTERNS ─────────────────────────────────────────────────────────────
# Keys are life-domain clusters.  Each value is a list of pattern dicts.
#
# Schema per pattern:
#   name              – short identifier
#   conditions        – dict of matchable conditions (keys described below)
#   evidence_cases    – list of case-IDs where this pattern was observed
#   confidence_boost  – float to ADD to base confidence when pattern matches
#   outcome           – 'positive' | 'negative' | 'mixed'
#   description       – one-line human-readable summary
#
# Condition keys:
#   planet_in_house       – list of (planet, house_number) tuples
#   planet_in_sign        – list of (planet, sign_name) tuples
#   planet_aspect_house   – list of (aspecting_planet, target_house)
#   planet_aspect_planet  – list of (aspecting_planet, target_planet)
#   planet_conjunct       – list of frozensets: {p1, p2}
#   house_lord_in_house   – list of (house_owned, house_occupied)
#   yoga                  – str name of yoga required
#   dasha_lord            – planet whose dasha is running
#   antardasha_lord       – planet whose antardasha is running
#   transit_planet_house  – list of (transiting_planet, house_from_moon)
#   lagna                 – str sign name (or list) the pattern is lagna-specific to
#   divisional            – str divisional chart (e.g. 'D10', 'D9', 'D7')
#   karaka                – str Jaimini chara karaka role (e.g. 'AK', 'DK', 'AmK')
#   functional_role       – str from LAGHU_PARASHARI ('yogakaraka', 'maraka', etc.)
#   triple_lagna          – bool — pattern validated from birth, Moon AND Sun lagnas
#   from_arudha           – str arudha reference (e.g. 'AL', 'A7', 'A10', 'UL')
#   dasha_antardasha_relation – '6_8' | '2_12' | 'kendra' | 'trikona' (positional)
#   fire_signs_on_maraka  – bool
#   sade_sati             – bool
#   papakartari           – int house hemmed by malefics

CASE_PATTERNS = {

    # =========================================================================
    # CAREER RISE / RAJAYOGA ACTIVATION
    # =========================================================================
    'career_rise': [
        {
            'name': '10th_lord_jupiter_association',
            'conditions': {
                'planet_aspect_planet': [('Jupiter', '10th_lord')],
                'triple_lagna': True,
            },
            'evidence_cases': ['KNR-CS-001', 'KNR-CS-002', 'KNR-CS-029',
                               'KNR-CS-033', 'KNR-CS-038', 'KNR-CS-051'],
            'confidence_boost': 0.15,
            'outcome': 'positive',
            'description': '10th lord associated with Jupiter at time of career '
                           'elevation — repeating template from Indira Gandhi '
                           'to IAS officers. Transit Jupiter touching 10th from '
                           'all three lagnas is the trigger.',
        },
        {
            'name': 'yogakaraka_dasha_career_peak',
            'conditions': {
                'dasha_lord': 'yogakaraka',
                'functional_role': 'yogakaraka',
            },
            'evidence_cases': ['KNR-CS-029', 'BVR-CS-006', 'BVR-CS-015',
                               'SR-CS-018', 'SR-CS-028'],
            'confidence_boost': 0.15,
            'outcome': 'positive',
            'description': 'Dasha of the yogakaraka planet produces career peak. '
                           'Saturn yogakaraka for Taurus/Libra, Mars for Cancer/Leo, '
                           'Venus for Capricorn/Aquarius — confirmed across 5+ cases.',
        },
        {
            'name': 'rajayoga_9th_10th_lords',
            'conditions': {
                'yoga': 'dharma_karmadhipati',
            },
            'evidence_cases': ['KNR-CS-025', 'KNR-CS-049', 'KNR-CS-050',
                               'KNR-CS-051', 'SR-CS-006', 'SR-CS-019'],
            'confidence_boost': 0.12,
            'outcome': 'positive',
            'description': '9th and 10th lords in mutual relationship (conjunction, '
                           'exchange, or mutual aspect) produce Rajayoga. Fructifies '
                           'only during dasha of forming planets with transit support.',
        },
        {
            'name': 'dashamsha_confirmation',
            'conditions': {
                'divisional': 'D10',
                'planet_in_house': [('dasha_lord', 10)],
            },
            'evidence_cases': ['KNR-CS-001', 'KNR-CS-003', 'KNR-CS-033',
                               'SR-CS-006', 'SR-CS-012', 'SR-CS-018'],
            'confidence_boost': 0.10,
            'outcome': 'positive',
            'description': 'When birth chart and navamsha show conflict, Dashamsha '
                           '(D-10) provides the tiebreaker for career events. Dasha '
                           'lord well-placed in D-10 confirms career success.',
        },
        {
            'name': 'jupiter_in_10th_dasamsa',
            'conditions': {
                'divisional': 'D10',
                'planet_in_house': [('Jupiter', 10)],
            },
            'evidence_cases': ['SR-CS-018', 'SR-CS-020', 'KNR-CS-003'],
            'confidence_boost': 0.10,
            'outcome': 'positive',
            'description': 'Jupiter in 10th house of Dasamsa — career at highest '
                           'level. FDR, Dhirubhai Ambani, K.C. Saxena all showed this.',
        },
        {
            'name': 'sun_jupiter_government_service',
            'conditions': {
                'planet_aspect_house': [('Sun', 10), ('Jupiter', 10)],
            },
            'evidence_cases': ['KNR-CS-009', 'KNR-CS-033', 'KNR-CS-038'],
            'confidence_boost': 0.10,
            'outcome': 'positive',
            'description': 'Sun (royalty) and Jupiter (divine grace) jointly '
                           'influencing 10th house indicates government or judicial '
                           'career. Confirmed across IAS and judge appointments.',
        },
        {
            'name': 'debilitated_malefic_in_kendra_rajayoga',
            'conditions': {
                'planet_in_house': [('malefic_debilitated', 'kendra')],
            },
            'evidence_cases': ['SR-CS-018', 'SR-CS-019', 'BVR-CS-004'],
            'confidence_boost': 0.08,
            'outcome': 'mixed',
            'description': 'Debilitated malefic in kendra produces Rajayoga at '
                           'personal cost. FDR (polio + presidency), Naveen Patnaik '
                           '(father death + CM), Mussolini (poverty + dictatorship).',
        },
        {
            'name': 'vipareeta_rajayoga_from_al',
            'conditions': {
                'from_arudha': 'AL',
                'planet_in_house': [('natural_malefic', 'dusthana_from_AL')],
            },
            'evidence_cases': ['SR-CS-019', 'SR-CS-014', 'SR-CS-030'],
            'confidence_boost': 0.08,
            'outcome': 'positive',
            'description': 'Natural malefics in 6/8/12 from Arudha Lagna give '
                           'authority and power during their dasha. Benefics in '
                           'same positions give loss. Sanjay Rath reversal principle.',
        },
        {
            'name': 'saturn_transit_a10_political',
            'conditions': {
                'from_arudha': 'A10',
                'transit_planet_house': [('Saturn', 'over_A10')],
            },
            'evidence_cases': ['SR-CS-011', 'SR-CS-016', 'SR-CS-028'],
            'confidence_boost': 0.08,
            'outcome': 'mixed',
            'description': 'Saturn transit over Rajyapada (A10) triggers political '
                           'rise or fall depending on dasha alignment. Rise when '
                           'dasha supports; fall when dasha opposes.',
        },
    ],

    # =========================================================================
    # CAREER FALL / BUSINESS LOSS
    # =========================================================================
    'career_fall': [
        {
            'name': 'rajayoga_shelf_life',
            'conditions': {
                'dasha_lord': 'dusthana_lord',
            },
            'evidence_cases': ['KNR-CS-025', 'KNR-CS-049', 'KNR-CS-053',
                               'SR-CS-011'],
            'confidence_boost': 0.10,
            'outcome': 'negative',
            'description': 'Rajayogas have a shelf life. When dasha switches from '
                           'yoga-forming planets to 6th/8th/12th lords, the fall '
                           'comes. Two ex-PMs and PV Narasimha Rao confirm this.',
        },
        {
            'name': 'dasha_antardasha_6_8_hostility',
            'conditions': {
                'dasha_antardasha_relation': '6_8',
            },
            'evidence_cases': ['KNR-CS-030', 'KNR-CS-028', 'KNR-CS-032',
                               'SR-CS-024'],
            'confidence_boost': 0.10,
            'outcome': 'negative',
            'description': 'Sub-period lord in 6th or 8th from major period lord '
                           'destroys honour and fame. If also natural enemies, '
                           'damage is maximum. KN Rao general principle + cases.',
        },
        {
            'name': 'debilitated_amk_business_ruin',
            'conditions': {
                'karaka': 'AmK',
                'planet_in_sign': [('AmK', 'debilitated')],
            },
            'evidence_cases': ['KNR-CS-011', 'KNR-CS-032', 'SR-CS-024'],
            'confidence_boost': 0.08,
            'outcome': 'negative',
            'description': 'Debilitated Amatyakaraka can give initial success from '
                           'placement but eventual ruin from inherent weakness. '
                           'Retrograde enemy dasha attacks what the karaka signifies.',
        },
        {
            'name': 'mars_marana_karaka_sthana',
            'conditions': {
                'planet_in_house': [('Mars', 7)],
            },
            'evidence_cases': ['SR-CS-024', 'SR-CS-032'],
            'confidence_boost': 0.07,
            'outcome': 'negative',
            'description': 'Mars in Marana Karaka Sthana (7th house) — entire '
                           'business destroyed, family reduced to penury during '
                           'Mars dasha. Sanjay Rath standard nativity confirms.',
        },
    ],

    # =========================================================================
    # MARRIAGE TIMING
    # =========================================================================
    'marriage_timing': [
        {
            'name': 'jupiter_transit_7th_triple_lagna',
            'conditions': {
                'transit_planet_house': [('Jupiter', 7)],
                'triple_lagna': True,
            },
            'evidence_cases': ['KNR-CS-031', 'KNR-CS-035', 'KNR-CS-036',
                               'BVR-CS-024'],
            'confidence_boost': 0.12,
            'outcome': 'positive',
            'description': 'Transit Jupiter touching 7th house from all three '
                           'lagnas (birth, Moon, Sun) confirms marriage timing. '
                           'KN Rao triple-lagna method across 4+ charts.',
        },
        {
            'name': '7th_lord_dasha_marriage',
            'conditions': {
                'dasha_lord': '7th_lord',
            },
            'evidence_cases': ['KNR-CS-031', 'KNR-CS-036', 'BVR-CS-024'],
            'confidence_boost': 0.10,
            'outcome': 'positive',
            'description': 'Dasha or antardasha of 7th lord well-placed triggers '
                           'marriage. Moon as 7th lord on Poornima (full Moon) = '
                           'especially strong for Cancer lagna.',
        },
        {
            'name': 'darakaraka_chara_dasha_marriage',
            'conditions': {
                'karaka': 'DK',
            },
            'evidence_cases': ['KNR-CS-009', 'KNR-CS-012', 'KNR-CS-013',
                               'KNR-CS-014', 'KNR-CS-015'],
            'confidence_boost': 0.10,
            'outcome': 'positive',
            'description': 'In Jaimini Chara Dasha, marriage occurs when the '
                           'dasha sign contains or aspects the Darakaraka. '
                           'Five cases from KN Rao Chara Dasha book confirm.',
        },
        {
            'name': 'upapada_marriage_analysis',
            'conditions': {
                'from_arudha': 'UL',
            },
            'evidence_cases': ['SR-CS-021', 'SR-CS-015', 'SR-CS-013'],
            'confidence_boost': 0.10,
            'outcome': 'positive',
            'description': 'Upapada (UL) and planets in it describe spouse and '
                           'marriage quality. 8th from UL = 2nd marriage sign. '
                           'Elizabeth Taylor 8 marriages mapped via successive '
                           '8th-from-UL.',
        },
        {
            'name': 'late_marriage_dasha_mismatch',
            'conditions': {
                'planet_in_house': [('7th_lord', 'well_placed')],
            },
            'evidence_cases': ['KNR-CS-036', 'KNR-CS-031'],
            'confidence_boost': 0.07,
            'outcome': 'mixed',
            'description': 'Good 7th house does NOT mean early marriage if dasha '
                           'sequence does not support it. Promise vs timing — '
                           'the chart promises, the dasha delivers.',
        },
    ],

    # =========================================================================
    # MARRIAGE PROBLEMS / DIVORCE / WIDOWHOOD
    # =========================================================================
    'marriage_problems': [
        {
            'name': 'mars_in_7th_marital_strife',
            'conditions': {
                'planet_in_house': [('Mars', 7)],
            },
            'evidence_cases': ['BVR-CS-011', 'SR-CS-015', 'BVR-CS-004',
                               'KNR-CS-034'],
            'confidence_boost': 0.12,
            'outcome': 'negative',
            'description': 'Mars in 7th house destroys marital happiness. Even '
                           'with Jupiter/Saturn aspect saving spouse life, '
                           'behavioral problems remain. Archduke Rudolf suicide, '
                           'Mussolini, Sanjay Rath general principle.',
        },
        {
            'name': 'mars_rahu_8th_widowhood',
            'conditions': {
                'planet_in_house': [('Mars', 8), ('Rahu', 8)],
            },
            'evidence_cases': ['BVR-CS-017', 'BVR-CS-008', 'BVR-CS-021'],
            'confidence_boost': 0.12,
            'outcome': 'negative',
            'description': 'Mars + Rahu in 8th bhava = specific widowhood '
                           'combination for women. 8th = longevity of husband '
                           '(2nd from 7th). Three BV Raman cases confirm.',
        },
        {
            'name': 'venus_afflicted_multiple_marriages',
            'conditions': {
                'planet_aspect_planet': [('malefic', 'Venus')],
            },
            'evidence_cases': ['BVR-CS-005', 'BVR-CS-023', 'SR-CS-021',
                               'BVR-CS-012'],
            'confidence_boost': 0.10,
            'outcome': 'negative',
            'description': 'Venus afflicted by malefics gives rise to more than '
                           'one marriage. BV Raman: "In hundreds of horoscopes '
                           'observed." Elizabeth Taylor (8 marriages) confirms.',
        },
        {
            'name': 'spouse_death_7th_8th_malefic',
            'conditions': {
                'planet_aspect_house': [('Saturn', 7), ('Mars', 7)],
            },
            'evidence_cases': ['KNR-CS-034', 'KNR-CS-046', 'KNR-CS-060',
                               'BVR-CS-017', 'BVR-CS-008'],
            'confidence_boost': 0.12,
            'outcome': 'negative',
            'description': 'Malefics (Saturn + Mars) afflicting 7th house from '
                           'multiple lagnas indicate spouse death or severe '
                           'marital crisis. Five cases across KN Rao and BV Raman.',
        },
        {
            'name': '6th_7th_lord_connection_divorce',
            'conditions': {
                'house_lord_in_house': [(6, 7)],
            },
            'evidence_cases': ['KNR-CS-041', 'SR-CS-024'],
            'confidence_boost': 0.08,
            'outcome': 'negative',
            'description': 'Connection between 6th house (litigation/separation) '
                           'and 7th house (marriage) indicates divorce. Activated '
                           'during dasha of connecting planet.',
        },
    ],

    # =========================================================================
    # DEATH / LONGEVITY
    # =========================================================================
    'death_longevity': [
        {
            'name': 'saturn_7th_maraka',
            'conditions': {
                'planet_in_house': [('Saturn', 7)],
            },
            'evidence_cases': ['KNR-CS-003', 'KNR-CS-029', 'BVR-CS-007'],
            'confidence_boost': 0.12,
            'outcome': 'negative',
            'description': 'Saturn in 7th house is classic maraka even when '
                           'exalted. K.C. Saxena knew his own death would come '
                           'in Saturn period. The same planet can give career '
                           'peak AND death.',
        },
        {
            'name': 'saturn_transit_triple_lagna_death',
            'conditions': {
                'transit_planet_house': [('Saturn', 'lagna')],
                'triple_lagna': True,
            },
            'evidence_cases': ['KNR-CS-029', 'KNR-CS-034', 'KNR-CS-035',
                               'KNR-CS-037', 'KNR-CS-048'],
            'confidence_boost': 0.15,
            'outcome': 'negative',
            'description': 'Transit Saturn afflicting all three lagnas (birth, '
                           'Moon, Sun) simultaneously triggers death when dasha '
                           'supports. The negative counterpart of Jupiter triple-'
                           'lagna for positive events.',
        },
        {
            'name': 'maraka_dasha_2nd_7th_lords',
            'conditions': {
                'dasha_lord': 'maraka',
                'functional_role': 'maraka',
            },
            'evidence_cases': ['KNR-CS-029', 'KNR-CS-048', 'BVR-CS-001',
                               'BVR-CS-002', 'BVR-CS-007', 'BVR-CS-025'],
            'confidence_boost': 0.12,
            'outcome': 'negative',
            'description': 'Death occurs during dasha of 2nd or 7th lord '
                           '(maraka planets). BV Raman hierarchy: planets '
                           'occupying > owning > conjoining lords of 2nd/7th.',
        },
        {
            'name': 'fire_death_pattern',
            'conditions': {
                'fire_signs_on_maraka': True,
                'planet_aspect_house': [('Mars', 8)],
            },
            'evidence_cases': ['KNR-CS-034', 'KNR-CS-052', 'KNR-CS-059'],
            'confidence_boost': 0.10,
            'outcome': 'negative',
            'description': 'Death by fire when fiery planets (Mars, Sun, Ketu) '
                           'and fiery signs (Aries, Leo, Sagittarius) connect to '
                           'maraka houses and 8th house. FIVE fire-death cases '
                           'in KN Rao establish this beyond doubt.',
        },
        {
            'name': 'saturn_12th_mars_8th_transit_death',
            'conditions': {
                'transit_planet_house': [('Saturn', 12), ('Mars', 8)],
            },
            'evidence_cases': ['BVR-CS-025', 'KNR-CS-048'],
            'confidence_boost': 0.10,
            'outcome': 'negative',
            'description': 'Transit Saturn in 12th from Moon + Mars in 8th from '
                           'Moon simultaneously = lethal transit combination. '
                           'BV Raman detailed Vedha analysis confirms.',
        },
        {
            'name': 'derived_chart_relative_death',
            'conditions': {},  # Structural principle
            'evidence_cases': ['KNR-CS-028', 'KNR-CS-039', 'KNR-CS-046',
                               'BVR-CS-018', 'BVR-CS-019', 'BVR-CS-021'],
            'confidence_boost': 0.10,
            'outcome': 'negative',
            'description': 'For relative death, treat relevant house as lagna: '
                           '9th for father (markesh = 10th + 3rd), 4th for mother '
                           '(markesh = 5th + 10th), 7th for spouse (markesh = '
                           '8th + 1st). Six cases confirm derived chart technique.',
        },
    ],

    # =========================================================================
    # INFANT MORTALITY (BALARISHTA)
    # =========================================================================
    'balarishta': [
        {
            'name': 'moon_malefic_kendra_no_benefic',
            'conditions': {
                'planet_in_house': [('Moon', 'kendra')],
                'planet_aspect_planet': [('Saturn', 'Moon')],
            },
            'evidence_cases': ['BVR-CS-001', 'BVR-CS-002', 'BVR-CS-009',
                               'BVR-CS-022'],
            'confidence_boost': 0.15,
            'outcome': 'negative',
            'description': 'Moon in kendra aspected by Saturn without benefic '
                           'aspect = Balarishta. When dasha lord is also '
                           'afflicted by Saturn, death within dasha period. '
                           'Four BV Raman infant death cases.',
        },
        {
            'name': 'papakartari_on_lagna_infant',
            'conditions': {
                'papakartari': 1,
            },
            'evidence_cases': ['BVR-CS-002', 'BVR-CS-003', 'BVR-CS-022',
                               'KNR-CS-037'],
            'confidence_boost': 0.12,
            'outcome': 'negative',
            'description': 'Lagna hemmed between malefics (Papakartari Yoga) '
                           'in infancy charts. Combined with Moon affliction, '
                           'indicates severe childhood suffering or death.',
        },
        {
            'name': 'jupiter_kendra_balarishta_cancel',
            'conditions': {
                'planet_in_house': [('Jupiter', 'kendra')],
            },
            'evidence_cases': ['BVR-CS-003', 'BVR-CS-023', 'BVR-CS-005'],
            'confidence_boost': 0.15,
            'outcome': 'positive',
            'description': 'Jupiter in kendra CANCELS Balarishta. Even with '
                           'multiple death indicators, Jupiter in kendra saves '
                           'life. BV Raman: "Best gift in a horoscope." Child '
                           'suffers but survives to long life.',
        },
    ],

    # =========================================================================
    # HEALTH / DISEASE
    # =========================================================================
    'health': [
        {
            'name': 'mercury_mars_saturn_nervous_disease',
            'conditions': {
                'planet_conjunct': [frozenset({'Mercury', 'Mars'})],
                'planet_aspect_planet': [('Saturn', 'Mercury')],
            },
            'evidence_cases': ['BVR-CS-012', 'BVR-CS-029'],
            'confidence_boost': 0.10,
            'outcome': 'negative',
            'description': 'Mercury (nerves) + Mars (inflammation) + Saturn '
                           'aspect (degeneration) = chronic nervous system '
                           'disease. In Aquarius: optic nerve damage. In 6th '
                           'house: chronic arthritis (25+ years).',
        },
        {
            'name': 'saturn_aspect_lagna_and_moon',
            'conditions': {
                'planet_aspect_house': [('Saturn', 1)],
                'planet_aspect_planet': [('Saturn', 'Moon')],
            },
            'evidence_cases': ['BVR-CS-007', 'BVR-CS-002', 'BVR-CS-001'],
            'confidence_boost': 0.10,
            'outcome': 'negative',
            'description': 'Saturn aspecting BOTH lagna and Moon simultaneously '
                           'creates pattern of chronic ill-health. Combined with '
                           'malefic conjunction in 6th house, diseases become '
                           'severe enough to shorten life.',
        },
        {
            'name': 'moon_mercury_afflicted_mental_health',
            'conditions': {
                'planet_aspect_planet': [('malefic', 'Moon'), ('malefic', 'Mercury')],
            },
            'evidence_cases': ['KNR-CS-027', 'KNR-CS-042', 'SR-CS-007'],
            'confidence_boost': 0.10,
            'outcome': 'negative',
            'description': 'Moon (mind) and Mercury (rational mind) both '
                           'afflicted by malefics indicates mental health issues. '
                           'Check 4th house (emotions) and 5th house (intellect) '
                           'additionally. Manifests in dasha of afflicting planet.',
        },
        {
            'name': 'badhak_mrityupada_epilepsy',
            'conditions': {
                'from_arudha': 'A8',
            },
            'evidence_cases': ['SR-CS-007', 'SR-CS-008'],
            'confidence_boost': 0.07,
            'outcome': 'negative',
            'description': 'Badhak lord conjunct Mrityupada (A8) activated by '
                           'Shoola dasa aspecting Arudha Lagna = severe health '
                           'crisis (epilepsy, short longevity). Sanjay Rath '
                           'methodology.',
        },
    ],

    # =========================================================================
    # FATHER DEATH / LOSS
    # =========================================================================
    'father_loss': [
        {
            'name': 'sun_saturn_conjunction_father',
            'conditions': {
                'planet_conjunct': [frozenset({'Sun', 'Saturn'})],
            },
            'evidence_cases': ['BVR-CS-005', 'BVR-CS-018', 'BVR-CS-021',
                               'KNR-CS-028'],
            'confidence_boost': 0.12,
            'outcome': 'negative',
            'description': 'Sun (karaka for father) conjunct Saturn = early '
                           'death of father. BV Raman: "Mark the conjunction of '
                           'Saturn with the Sun who represents father." Four '
                           'cases confirm, death within 2-9 years of birth.',
        },
        {
            'name': 'sun_debilitated_father_loss',
            'conditions': {
                'planet_in_sign': [('Sun', 'debilitated_or_approaching')],
            },
            'evidence_cases': ['BVR-CS-019', 'BVR-CS-018', 'SR-CS-024'],
            'confidence_boost': 0.08,
            'outcome': 'negative',
            'description': 'Sun debilitated or approaching debilitation sign '
                           'weakens father karaka. Combined with malefic '
                           'aspects = father loss in early years. Even Sun '
                           '"approaching debilitation" (in sign before Libra) '
                           'qualifies.',
        },
        {
            'name': '9th_house_papakartari_father',
            'conditions': {
                'papakartari': 9,
            },
            'evidence_cases': ['KNR-CS-028', 'BVR-CS-018'],
            'confidence_boost': 0.08,
            'outcome': 'negative',
            'description': '9th house hemmed between malefics (Papakartari) = '
                           'severe affliction to father. When 9th lord is also '
                           'in inimical sign with Mars, violent death of father.',
        },
        {
            'name': 'sun_in_bhagyapada_saturn_aspect',
            'conditions': {
                'from_arudha': 'A9',
                'planet_aspect_planet': [('Saturn', 'Sun')],
            },
            'evidence_cases': ['SR-CS-024', 'BVR-CS-018'],
            'confidence_boost': 0.07,
            'outcome': 'negative',
            'description': 'Sun in Bhagyapada (A9) aspected by Saturn or Rahu = '
                           'father suffers severe setback. Sanjay Rath dictum '
                           'applied to standard nativity.',
        },
    ],

    # =========================================================================
    # CHILDREN / PROGENY
    # =========================================================================
    'children': [
        {
            'name': 'jupiter_transit_5th_triple_lagna_child',
            'conditions': {
                'transit_planet_house': [('Jupiter', 5)],
                'triple_lagna': True,
            },
            'evidence_cases': ['KNR-CS-035', 'KNR-CS-044', 'KNR-CS-036'],
            'confidence_boost': 0.12,
            'outcome': 'positive',
            'description': 'Transit Jupiter touching 5th house from all three '
                           'lagnas triggers childbirth. Jupiter = karaka for '
                           'progeny. Male child when Jupiter dominates transit.',
        },
        {
            'name': 'saturn_transit_female_child',
            'conditions': {
                'transit_planet_house': [('Saturn', 5)],
            },
            'evidence_cases': ['KNR-CS-036', 'KNR-CS-044'],
            'confidence_boost': 0.07,
            'outcome': 'positive',
            'description': 'Saturn (female karaka) in female sign as 5th lord '
                           'from all three lagnas in transit indicates female '
                           'child. Jupiter = male, Saturn = female gender '
                           'determination.',
        },
        {
            'name': 'saptamsa_twins_dual_sign',
            'conditions': {
                'divisional': 'D7',
            },
            'evidence_cases': ['SR-CS-005', 'SR-CS-004'],
            'confidence_boost': 0.08,
            'outcome': 'positive',
            'description': 'Saptamsa (D-7) is the primary divisional chart for '
                           'children. Dual planets and specific signs (Scorpio) '
                           'indicate twins. Moon strong in female chart overrides '
                           '6th lord destructive potential.',
        },
        {
            'name': '5th_house_afflicted_child_loss',
            'conditions': {
                'planet_aspect_house': [('malefic', 5)],
            },
            'evidence_cases': ['KNR-CS-047', 'KNR-CS-056'],
            'confidence_boost': 0.08,
            'outcome': 'negative',
            'description': '5th house severely afflicted + Jupiter (progeny '
                           'karaka) weak = loss of children. Stillbirth when '
                           'markesh from derived 5th-as-lagna simultaneously '
                           'active with 5th house activation.',
        },
    ],

    # =========================================================================
    # SPIRITUAL / RENUNCIATION
    # =========================================================================
    'spiritual': [
        {
            'name': 'ketu_10th_dasamsa_meditation',
            'conditions': {
                'divisional': 'D10',
                'planet_in_house': [('Ketu', 10)],
            },
            'evidence_cases': ['SR-CS-013', 'SR-CS-012', 'KNR-CS-006'],
            'confidence_boost': 0.10,
            'outcome': 'positive',
            'description': 'Ketu in 10th house or dominating arthatrikona in '
                           'Dasamsa = spiritual/meditation career. Saturn-Ketu '
                           'in Pisces (D-10) = teacher of transcendental '
                           'meditation. Contrast: Saturn-Rahu in Scorpio = '
                           'secret service.',
        },
        {
            'name': 'navamsa_lagna_lord_ak_rajayoga',
            'conditions': {
                'karaka': 'AK',
                'divisional': 'D9',
            },
            'evidence_cases': ['SR-CS-006', 'SR-CS-013', 'SR-CS-027'],
            'confidence_boost': 0.12,
            'outcome': 'positive',
            'description': 'Conjunction of navamsa lagna lord with Atmakaraka '
                           'is THE most powerful Rajayoga. When in research '
                           'signs (Scorpio) = hidden fields. Freud, Vivekananda, '
                           'Swami Asutosh all demonstrate this.',
        },
        {
            'name': 'upapada_lord_8th_renunciation',
            'conditions': {
                'from_arudha': 'UL',
                'house_lord_in_house': [('UL_lord', 8)],
            },
            'evidence_cases': ['SR-CS-013', 'SR-CS-027'],
            'confidence_boost': 0.08,
            'outcome': 'positive',
            'description': 'Upapada lord in 8th or 12th or debilitated = '
                           'renunciation rather than marriage. Parasara dictum '
                           'applied by Sanjay Rath. Swami Asutosh and '
                           'Vivekananda confirm.',
        },
        {
            'name': 'late_life_spiritual_activation',
            'conditions': {
                'dasha_lord': '9th_or_12th_lord',
            },
            'evidence_cases': ['KNR-CS-007', 'KNR-CS-006', 'SR-CS-027'],
            'confidence_boost': 0.07,
            'outcome': 'positive',
            'description': 'Spiritual mission can activate late in life through '
                           'dasha of 9th/12th lord. Prabhupada went to America '
                           'at 69. Never dismiss chart potential based on early-'
                           'life events alone.',
        },
    ],

    # =========================================================================
    # FOREIGN TRAVEL / RESIDENCE
    # =========================================================================
    'foreign_travel': [
        {
            'name': '9th_12th_rahu_foreign',
            'conditions': {
                'planet_in_house': [('Rahu', 'trikona_or_12th')],
            },
            'evidence_cases': ['KNR-CS-040', 'KNR-CS-057', 'SR-CS-022',
                               'SR-CS-027'],
            'confidence_boost': 0.10,
            'outcome': 'positive',
            'description': '9th + 12th houses + Rahu = foreign travel indicators. '
                           'Foreign prosperity requires BOTH foreign indicators '
                           '(9th/12th/Rahu) AND wealth indicators (2nd/11th) '
                           'simultaneously active.',
        },
        {
            'name': 'badhakesh_kendra_foreign_residence',
            'conditions': {
                'planet_in_house': [('planet', 'kendra_from_badhakesh')],
            },
            'evidence_cases': ['SR-CS-027', 'SR-CS-022'],
            'confidence_boost': 0.08,
            'outcome': 'positive',
            'description': 'Planets in kendra to badhakesh or conjoined badhak '
                           'house give foreign travel and residence. Normally '
                           'badhakesh = obstruction, but here it enables foreign '
                           'journeys. Vivekananda USA trips confirm.',
        },
        {
            'name': '12th_lord_lagnesh_saturn_foreign_residence',
            'conditions': {
                'planet_conjunct': [frozenset({'12th_lord', 'lagna_lord', 'Saturn'})],
            },
            'evidence_cases': ['SR-CS-022', 'SR-CS-010'],
            'confidence_boost': 0.08,
            'outcome': 'positive',
            'description': '12th lord with lagna lord + Saturn = foreign residence '
                           'nearly certain. Neil Armstrong (12th house analysis) '
                           'and Ashtottari case both confirm.',
        },
    ],

    # =========================================================================
    # EDUCATION / INTELLECTUAL TALENT
    # =========================================================================
    'education': [
        {
            'name': 'mercury_4th_aspecting_10th_astrology',
            'conditions': {
                'planet_in_house': [('Mercury', 4)],
                'planet_aspect_house': [('Mercury', 10)],
            },
            'evidence_cases': ['KNR-CS-003', 'BVR-CS-023'],
            'confidence_boost': 0.08,
            'outcome': 'positive',
            'description': 'Mercury in 4th house aspecting 10th = KN Rao specific '
                           'marker for brilliance in astrology. Plus Jupiter '
                           'aspecting 5th in birth/navamsha = genuine astrological '
                           'talent.',
        },
        {
            'name': 'karakamsha_technical_education',
            'conditions': {
                'karaka': 'AK',
                'divisional': 'D9',
            },
            'evidence_cases': ['KNR-CS-019', 'KNR-CS-020'],
            'confidence_boost': 0.08,
            'outcome': 'positive',
            'description': 'Karakamsha (AK in Navamsha) reveals nature of '
                           'education. Mars/Saturn/Rahu association = engineering. '
                           'Venus/Moon = arts. Four engineers and six artists '
                           'tested by KN Rao.',
        },
        {
            'name': 'jupiter_mercury_10th_scholarship',
            'conditions': {
                'planet_conjunct': [frozenset({'Jupiter', 'Mercury'})],
                'planet_in_house': [('Jupiter', 10), ('Mercury', 10)],
            },
            'evidence_cases': ['BVR-CS-023', 'BVR-CS-013'],
            'confidence_boost': 0.08,
            'outcome': 'positive',
            'description': 'Jupiter and Mercury together in 10th house = '
                           'scholarly distinction, authorship, intellectual '
                           'career. Prof. Suryanarain Rao and Marconi.',
        },
    ],

    # =========================================================================
    # WEALTH / FINANCIAL PATTERNS
    # =========================================================================
    'wealth': [
        {
            'name': 'single_planet_multiple_lords_wealth',
            'conditions': {},  # Check if one planet lords lagna + Moon sign + AL
            'evidence_cases': ['SR-CS-020', 'SR-CS-018'],
            'confidence_boost': 0.12,
            'outcome': 'positive',
            'description': 'When one planet lords multiple key reference points '
                           '(lagna, Moon sign, Sun sign, Arudha Lagna), its '
                           'dasha brings extraordinary results. Dhirubhai '
                           'Ambani: Jupiter as lord of 4 critical points.',
        },
        {
            'name': 'venus_saturn_11th_scorpio_wealth',
            'conditions': {
                'planet_in_house': [('Venus', 11), ('Saturn', 11)],
                'lagna': 'Scorpio',
            },
            'evidence_cases': ['BVR-CS-016', 'BVR-CS-006'],
            'confidence_boost': 0.08,
            'outcome': 'positive',
            'description': 'Venus and Saturn in 11th house (gains) for Scorpio '
                           'lagna = massive wealth accumulation. Henry Ford '
                           '"world\'s richest man." For Taurus lagna, Saturn '
                           'yogakaraka alone produces royalty-level status.',
        },
        {
            'name': 'amk_saturn_self_made',
            'conditions': {
                'karaka': 'AmK',
                'planet_aspect_planet': [('Saturn', 'AmK')],
            },
            'evidence_cases': ['KNR-CS-010', 'SR-CS-020'],
            'confidence_boost': 0.08,
            'outcome': 'positive',
            'description': 'Saturn aspecting Amatyakaraka = self-made through '
                           'hardship. Jupiter aspecting AmK = born into advantage. '
                           'Father-son business empire comparison from KN Rao.',
        },
        {
            'name': 'venus_dasha_prosperity_then_loss',
            'conditions': {
                'dasha_lord': 'Venus',
            },
            'evidence_cases': ['KNR-CS-032', 'KNR-CS-005'],
            'confidence_boost': 0.07,
            'outcome': 'mixed',
            'description': 'Venus period can bring great prosperity, but the '
                           'NEXT dasha may reverse it. Prosperity during '
                           'favorable dasha does not mean permanent success. '
                           'Always check what follows.',
        },
    ],

    # =========================================================================
    # POLITICAL CAREER (SPECIFIC)
    # =========================================================================
    'political': [
        {
            'name': 'rajayoga_rise_and_fall_both_written',
            'conditions': {
                'yoga': 'rajayoga',
            },
            'evidence_cases': ['KNR-CS-025', 'KNR-CS-029', 'KNR-CS-035',
                               'KNR-CS-053', 'SR-CS-011'],
            'confidence_boost': 0.10,
            'outcome': 'mixed',
            'description': 'Political Rajayoga does NOT guarantee permanent '
                           'power. Every rise has a corresponding fall. Both '
                           'are written in the chart — different dasha periods '
                           'activate each. Two ex-PMs, Indira Gandhi confirm.',
        },
        {
            'name': 'rahu_6th_8th_conspiracy',
            'conditions': {
                'planet_in_house': [('Rahu', 6)],
            },
            'evidence_cases': ['KNR-CS-054', 'KNR-CS-055'],
            'confidence_boost': 0.07,
            'outcome': 'negative',
            'description': 'Rahu in 6th/8th house with dasha activation = '
                           'conspiracy, hidden enemies, potential kidnapping. '
                           'Recovery when sub-period changes to benefic.',
        },
        {
            'name': 'multiple_arudha_convergence_political',
            'conditions': {
                'from_arudha': 'AL',
            },
            'evidence_cases': ['SR-CS-016', 'SR-CS-011', 'SR-CS-019'],
            'confidence_boost': 0.10,
            'outcome': 'positive',
            'description': 'Political Rajayoga requires convergence of multiple '
                           'Jaimini arudha padas: Narayan dasa sign must be '
                           'simultaneously favorable to AL (image), A7 '
                           '(alliances), and A10 (authority).',
        },
    ],

    # =========================================================================
    # METHODOLOGY PATTERNS (META — apply to all domains)
    # =========================================================================
    'methodology': [
        {
            'name': 'triple_lagna_validation',
            'conditions': {
                'triple_lagna': True,
            },
            'evidence_cases': ['KNR-CS-033', 'KNR-CS-034', 'KNR-CS-035',
                               'KNR-CS-036', 'KNR-CS-037', 'KNR-CS-038'],
            'confidence_boost': 0.15,
            'outcome': 'positive',
            'description': 'KN Rao master method: verify every prediction from '
                           'THREE lagnas (Birth, Moon, Sun). Event manifests '
                           'ONLY when all three show activation. Jupiter for '
                           'positive events, Saturn for negative.',
        },
        {
            'name': 'multi_dasha_verification',
            'conditions': {},  # Structural principle
            'evidence_cases': ['KNR-CS-004', 'KNR-CS-017', 'KNR-CS-062',
                               'SR-CS-023', 'SR-CS-029'],
            'confidence_boost': 0.10,
            'outcome': 'positive',
            'description': 'Cross-reference multiple dasha systems. When '
                           'Vimshottari, Chara Dasha, and conditional dashas '
                           'agree, confidence is high. Multiple clocks showing '
                           'same time = certain event.',
        },
        {
            'name': 'divisional_chart_override',
            'conditions': {
                'divisional': 'relevant',
            },
            'evidence_cases': ['KNR-CS-001', 'KNR-CS-063', 'SR-CS-006',
                               'SR-CS-010'],
            'confidence_boost': 0.10,
            'outcome': 'positive',
            'description': 'When birth chart and navamsha conflict, the relevant '
                           'divisional chart provides tiebreaker. D-10 for career, '
                           'D-9 for marriage, D-7 for children, D-16 for travel. '
                           'The specialist chart wins.',
        },
        {
            'name': 'karaka_supremacy_over_lordship',
            'conditions': {
                'karaka': 'any',
            },
            'evidence_cases': ['SR-CS-030', 'SR-CS-020', 'KNR-CS-010',
                               'KNR-CS-065'],
            'confidence_boost': 0.08,
            'outcome': 'positive',
            'description': 'Sanjay Rath Rule 50: "The Karaka gives or takes '
                           'away; lords of houses only work for the Karaka." '
                           'Karaka supremacy over house lordship — Jaimini '
                           'principle within Parashari timing.',
        },
        {
            'name': 'dasha_aspect_modification',
            'conditions': {},  # Structural principle
            'evidence_cases': ['KNR-CS-034', 'KNR-CS-030'],
            'confidence_boost': 0.07,
            'outcome': 'mixed',
            'description': 'A planet dasha results are modified by planets '
                           'aspecting it. Venus can give fire death if Mars '
                           'aspects it. Inherent nature is overridden by '
                           'received aspects.',
        },
        {
            'name': 'sade_sati_diminishing_returns',
            'conditions': {
                'sade_sati': True,
            },
            'evidence_cases': ['BVR-CS-025', 'BVR-CS-015'],
            'confidence_boost': 0.05,
            'outcome': 'mixed',
            'description': 'Saturn Sade Sati (7.5 years over Moon) is most '
                           'severe in FIRST cycle. Each subsequent cycle '
                           'produces diminished effects. BV Raman: "evil '
                           'effects will only be moderate" in 2nd round.',
        },
    ],

    # =========================================================================
    # MARAKA EXCEPTIONS (WILL NOT KILL)
    # =========================================================================
    'maraka_exceptions': [
        {
            'name': 'maraka_will_not_kill_by_lagna',
            'conditions': {
                'lagna': ['Aries', 'Gemini', 'Cancer', 'Leo', 'Virgo',
                          'Libra', 'Scorpio', 'Sagittarius', 'Pisces'],
            },
            'evidence_cases': ['BVR-CS-003', 'BVR-CS-005', 'KNR-CS-029'],
            'confidence_boost': 0.08,
            'outcome': 'positive',
            'description': 'BV Raman exceptions: Venus will NOT kill for Aries; '
                           'Moon for Gemini; Sun for Cancer/Virgo; Saturn for '
                           'Leo/Sagittarius; Mars for Libra/Pisces; Jupiter for '
                           'Scorpio. Override maraka predictions for these combos.',
        },
    ],

    # =========================================================================
    # EYESIGHT / VISION LOSS
    # =========================================================================
    'eyesight': [
        {
            'name': '2nd_12th_afflicted_vision_loss',
            'conditions': {
                'planet_aspect_house': [('malefic', 2), ('malefic', 12)],
            },
            'evidence_cases': ['BVR-CS-012', 'KNR-CS-058'],
            'confidence_boost': 0.08,
            'outcome': 'negative',
            'description': '2nd house (right eye) and 12th house (left eye) '
                           'afflicted by malefics + Sun/Moon/Venus (eye karakas) '
                           'afflicted. Mercury+Mars+Saturn in Aquarius = optic '
                           'nerve damage specifically.',
        },
    ],

    # =========================================================================
    # SURGERY / ACCIDENT
    # =========================================================================
    'accident_surgery': [
        {
            'name': 'mars_6th_8th_surgery_accident',
            'conditions': {
                'planet_in_house': [('Mars', 8)],
            },
            'evidence_cases': ['KNR-CS-043', 'KNR-CS-045'],
            'confidence_boost': 0.08,
            'outcome': 'negative',
            'description': 'Mars + 6th house (accident) + 8th house (sudden event) '
                           'activation = surgery or accident. Mars involvement '
                           'with these houses in dasha period triggers physical '
                           'injury.',
        },
    ],
}

# ── LAGNA-SPECIFIC YOGAKARAKA PATTERNS ─────────────────────────────────────
# Quick-lookup: which yogakaraka produces what result for each lagna.
# Derived from cross-referencing YOGAKARAKA dict with case evidence.
YOGAKARAKA_CAREER_PATTERNS = {
    'Taurus': {
        'planet': 'Saturn',
        'evidence': ['BVR-CS-006', 'BVR-CS-015'],
        'description': 'Saturn as yogakaraka for Taurus lagna — even commoner '
                       'rises to equivalent of royalty. Herbert Hoover, Gandhi.',
    },
    'Cancer': {
        'planet': 'Mars',
        'evidence': ['KNR-CS-029', 'KNR-CS-035'],
        'description': 'Mars yogakaraka for Cancer lagna — career peak in Mars '
                       'dasha. Indira Gandhi PM in Jupiter dasha with Mars-Jupiter '
                       'connection. Mars exalted + royal Sun = power.',
    },
    'Leo': {
        'planet': 'Mars',
        'evidence': ['KNR-CS-038'],
        'description': 'Mars yogakaraka for Leo lagna — IAS officer career start. '
                       'Sun (lagna lord) + Jupiter (divine grace) + Mars (yogakaraka) '
                       '= royal government service.',
    },
    'Libra': {
        'planet': 'Saturn',
        'evidence': ['BVR-CS-015'],
        'description': 'Saturn as yogakaraka for Libra — creates success through '
                       'hardship and sacrifice. MODE of success depends on Saturn '
                       'placement. Gandhi: greatness through suffering.',
    },
    'Scorpio': {
        'planet': 'Mars',  # Note: Mars is lagna lord, not classic yogakaraka
        'evidence': ['BVR-CS-004', 'BVR-CS-016'],
        'description': 'Mars as lagna lord for Scorpio — spectacular rise from '
                       'nothing. Mussolini, Henry Ford. Same Mars-Saturn that '
                       'drives rise creates violent fall.',
    },
    'Capricorn': {
        'planet': 'Venus',
        'evidence': ['BVR-CS-014'],
        'description': 'Venus yogakaraka for Capricorn — academic distinction. '
                       'Linnaeus "greatest botanist." Venus in 4th = educational '
                       'eminence.',
    },
}

# ── GAJAKESARI PATTERN ─────────────────────────────────────────────────────
# Jupiter-Moon mutual kendra = Gajakesari. Appears across many successful charts.
GAJAKESARI_EVIDENCE = {
    'cases': ['KNR-CS-003', 'KNR-CS-029', 'SR-CS-010', 'BVR-CS-023'],
    'description': 'Gajakesari Yoga (Moon-Jupiter in mutual kendras) provides '
                   'protection from adversity and elevates fortune. Can override '
                   'otherwise difficult Moon placement. Neil Armstrong, Indira '
                   'Gandhi, K.C. Saxena, Prof. Suryanarain Rao.',
    'confidence_boost': 0.10,
    'override': 'Moon in 8th house normally bad for Vimsottari, but Gajakesari '
                'overrides — strong Jupiter-Moon connection rescues Moon dasha.',
}

# ── JUPITER IN KENDRA PROTECTION ──────────────────────────────────────────
# The single most referenced protective factor across all three authors.
JUPITER_KENDRA_PROTECTION = {
    'cases': ['BVR-CS-003', 'BVR-CS-005', 'BVR-CS-023', 'SR-CS-024'],
    'confidence_boost': 0.15,
    'description': 'Jupiter in kendra is "the best gift in a horoscope" (BV Raman). '
                   'Cancels Balarishta, provides cure for diseases (dog bite with '
                   'cure because Jupiter in lagna), extends life, elevates fortune. '
                   'Cannot prevent karmic losses but ensures native rises above them.',
}
