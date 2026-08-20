"""Ground truth test cases for backtesting the Jyotish interpretation pipeline.

Each case has complete rasi chart data (lagna + all planet positions) so it can
be run through interpret_chart(). Sources: KN Rao, BV Raman, Sanjay Rath case
studies + well-known celebrity charts with documented life outcomes.

Format matches interpret_chart() input requirements.
"""

GROUND_TRUTH = [
    # ── Career Rise Cases ────────────────────────────────────────────────
    {'id': 'GT-001', 'source': 'kn_rao', 'description': 'Indira Gandhi — Cancer lagna, PM of India',
     'lagna': 'Cancer', 'planets': {'Sun': 'Scorpio', 'Moon': 'Cancer', 'Mars': 'Leo', 'Mercury': 'Scorpio', 'Jupiter': 'Taurus', 'Venus': 'Sagittarius', 'Saturn': 'Cancer', 'Rahu': 'Capricorn', 'Ketu': 'Cancer'},
     'domain': 'career_rise', 'known_outcome': 'positive', 'dasha_lord': 'Jupiter', 'antardasha_lord': '',
     'key_yogas': ['gajakesari', 'raja_yoga'], 'key_principles': ['yogakaraka_mars_for_cancer', 'gajakesari_yoga']},
    {'id': 'GT-002', 'source': 'sanjay_rath', 'description': 'Neil Armstrong — Cancer lagna, Moon landing',
     'lagna': 'Cancer', 'planets': {'Sun': 'Cancer', 'Moon': 'Cancer', 'Mars': 'Libra', 'Mercury': 'Leo', 'Jupiter': 'Cancer', 'Venus': 'Virgo', 'Saturn': 'Sagittarius', 'Rahu': 'Aquarius', 'Ketu': 'Leo'},
     'domain': 'career_rise', 'known_outcome': 'positive', 'dasha_lord': 'Jupiter', 'antardasha_lord': 'Rahu',
     'key_yogas': ['hamsa_yoga', 'raja_yoga'], 'key_principles': ['jupiter_exalted_lagna', 'moon_in_lagna']},
    {'id': 'GT-003', 'source': 'sanjay_rath', 'description': 'P.V. Narasimha Rao — Virgo lagna, PM of India',
     'lagna': 'Virgo', 'planets': {'Sun': 'Gemini', 'Moon': 'Cancer', 'Mars': 'Pisces', 'Mercury': 'Gemini', 'Jupiter': 'Virgo', 'Venus': 'Taurus', 'Saturn': 'Virgo', 'Rahu': 'Leo', 'Ketu': 'Aquarius'},
     'domain': 'career_rise', 'known_outcome': 'positive', 'dasha_lord': 'Mercury', 'antardasha_lord': 'Jupiter',
     'key_yogas': ['raja_yoga'], 'key_principles': ['mercury_in_10th', 'jupiter_saturn_in_lagna']},
    {'id': 'GT-004', 'source': 'sanjay_rath', 'description': 'FDR — Capricorn lagna, President of USA',
     'lagna': 'Capricorn', 'planets': {'Sun': 'Sagittarius', 'Moon': 'Capricorn', 'Mars': 'Aries', 'Mercury': 'Capricorn', 'Jupiter': 'Aquarius', 'Venus': 'Scorpio', 'Saturn': 'Capricorn', 'Rahu': 'Gemini', 'Ketu': 'Sagittarius'},
     'domain': 'career_rise', 'known_outcome': 'positive', 'dasha_lord': 'Jupiter', 'antardasha_lord': '',
     'key_yogas': ['sasa_yoga', 'raja_yoga'], 'key_principles': ['saturn_in_lagna_own_sign', 'jupiter_d10_10th']},
    {'id': 'GT-005', 'source': 'sanjay_rath', 'description': 'Aishwarya Rai — Scorpio lagna, Miss World + Bollywood',
     'lagna': 'Scorpio', 'planets': {'Sun': 'Scorpio', 'Moon': 'Taurus', 'Mars': 'Libra', 'Mercury': 'Sagittarius', 'Jupiter': 'Aries', 'Venus': 'Capricorn', 'Saturn': 'Aquarius', 'Rahu': 'Pisces', 'Ketu': 'Virgo'},
     'domain': 'career_rise', 'known_outcome': 'positive', 'dasha_lord': 'Jupiter', 'antardasha_lord': 'Venus',
     'key_yogas': ['raja_yoga'], 'key_principles': ['venus_beauty_indicator', 'jupiter_6th_viparita']},
    {'id': 'GT-006', 'source': 'sanjay_rath', 'description': 'Dhirubhai Ambani — Sagittarius lagna, built Reliance empire',
     'lagna': 'Sagittarius', 'planets': {'Sun': 'Sagittarius', 'Moon': 'Aquarius', 'Mars': 'Aries', 'Mercury': 'Scorpio', 'Jupiter': 'Leo', 'Venus': 'Scorpio', 'Saturn': 'Capricorn', 'Rahu': 'Virgo', 'Ketu': 'Pisces'},
     'domain': 'wealth', 'known_outcome': 'positive', 'dasha_lord': 'Jupiter', 'antardasha_lord': '',
     'key_yogas': ['dhana_yoga', 'raja_yoga'], 'key_principles': ['jupiter_in_9th', 'mars_exalted_5th']},
    {'id': 'GT-007', 'source': 'bv_raman', 'description': 'Taurus lagna — Saturn yogakaraka, commoner to ruler',
     'lagna': 'Taurus', 'planets': {'Sun': 'Taurus', 'Moon': 'Taurus', 'Mars': 'Leo', 'Mercury': 'Aries', 'Jupiter': 'Pisces', 'Venus': 'Taurus', 'Saturn': 'Taurus', 'Rahu': 'Sagittarius', 'Ketu': 'Gemini'},
     'domain': 'career_rise', 'known_outcome': 'positive', 'dasha_lord': 'Saturn', 'antardasha_lord': '',
     'key_yogas': ['raja_yoga', 'sasa_yoga'], 'key_principles': ['saturn_yogakaraka_taurus', 'saturn_own_sign_lagna']},

    # ── Career Fall Cases ────────────────────────────────────────────────
    {'id': 'GT-008', 'source': 'kn_rao', 'description': 'Indira Gandhi — lost power 1977',
     'lagna': 'Cancer', 'planets': {'Sun': 'Scorpio', 'Moon': 'Cancer', 'Mars': 'Leo', 'Mercury': 'Scorpio', 'Jupiter': 'Taurus', 'Venus': 'Sagittarius', 'Saturn': 'Cancer', 'Rahu': 'Capricorn', 'Ketu': 'Cancer'},
     'domain': 'career_fall', 'known_outcome': 'positive', 'dasha_lord': 'Saturn', 'antardasha_lord': 'Jupiter',
     'key_yogas': [], 'key_principles': ['saturn_maraka_dasha', 'sade_sati']},
    {'id': 'GT-009', 'source': 'kn_rao', 'description': 'Libra lagna — ruined business from debilitated AmK',
     'lagna': 'Libra', 'planets': {'Sun': 'Cancer', 'Moon': 'Aries', 'Mars': 'Gemini', 'Mercury': 'Leo', 'Jupiter': 'Sagittarius', 'Venus': 'Gemini', 'Saturn': 'Pisces', 'Rahu': 'Scorpio', 'Ketu': 'Taurus'},
     'domain': 'career_fall', 'known_outcome': 'positive', 'dasha_lord': 'Rahu', 'antardasha_lord': '',
     'key_yogas': [], 'key_principles': ['debilitated_amk', 'rahu_dasha_disruption']},

    # ── Marriage Cases ───────────────────────────────────────────────────
    {'id': 'GT-010', 'source': 'kn_rao', 'description': 'Taurus lagna — marriage via Chara Dasha timing',
     'lagna': 'Taurus', 'planets': {'Sun': 'Leo', 'Moon': 'Pisces', 'Mars': 'Scorpio', 'Mercury': 'Leo', 'Jupiter': 'Scorpio', 'Venus': 'Cancer', 'Saturn': 'Gemini', 'Rahu': 'Sagittarius', 'Ketu': 'Gemini'},
     'domain': 'marriage_timing', 'known_outcome': 'positive', 'dasha_lord': 'Venus', 'antardasha_lord': '',
     'key_yogas': [], 'key_principles': ['double_transit_on_7th', 'venus_dasha_marriage']},
    {'id': 'GT-011', 'source': 'kn_rao', 'description': 'Capricorn lagna — Venus-Jupiter marriage period',
     'lagna': 'Capricorn', 'planets': {'Sun': 'Gemini', 'Moon': 'Scorpio', 'Mars': 'Virgo', 'Mercury': 'Gemini', 'Jupiter': 'Libra', 'Venus': 'Cancer', 'Saturn': 'Sagittarius', 'Rahu': 'Taurus', 'Ketu': 'Scorpio'},
     'domain': 'marriage_timing', 'known_outcome': 'positive', 'dasha_lord': 'Venus', 'antardasha_lord': 'Jupiter',
     'key_yogas': [], 'key_principles': ['double_transit_on_7th', 'venus_dasha']},
    {'id': 'GT-012', 'source': 'bv_raman', 'description': 'Taurus lagna — Mars in 7th own sign, destructive marriage',
     'lagna': 'Taurus', 'planets': {'Sun': 'Scorpio', 'Moon': 'Cancer', 'Mars': 'Scorpio', 'Mercury': 'Libra', 'Jupiter': 'Scorpio', 'Venus': 'Sagittarius', 'Saturn': 'Virgo', 'Rahu': 'Aries', 'Ketu': 'Libra'},
     'domain': 'marriage_problems', 'known_outcome': 'positive', 'dasha_lord': 'Mars', 'antardasha_lord': '',
     'key_yogas': [], 'key_principles': ['mars_in_7th_own_sign', 'manglik']},

    # ── Death / Longevity Cases ──────────────────────────────────────────
    {'id': 'GT-013', 'source': 'sanjay_rath', 'description': 'Vivekananda — Sagittarius lagna, died at 39',
     'lagna': 'Sagittarius', 'planets': {'Sun': 'Sagittarius', 'Moon': 'Virgo', 'Mars': 'Gemini', 'Mercury': 'Scorpio', 'Jupiter': 'Cancer', 'Venus': 'Libra', 'Saturn': 'Virgo', 'Rahu': 'Scorpio', 'Ketu': 'Taurus'},
     'domain': 'death', 'known_outcome': 'positive', 'dasha_lord': 'Sun', 'antardasha_lord': 'Moon',
     'key_yogas': [], 'key_principles': ['atmakaraka_in_lagna', '8th_lord_moon_afflicted']},
    {'id': 'GT-014', 'source': 'kn_rao', 'description': 'Virgo lagna — father died by hanging',
     'lagna': 'Virgo', 'planets': {'Sun': 'Scorpio', 'Moon': 'Virgo', 'Mars': 'Capricorn', 'Mercury': 'Sagittarius', 'Jupiter': 'Libra', 'Venus': 'Scorpio', 'Saturn': 'Sagittarius', 'Rahu': 'Gemini', 'Ketu': 'Sagittarius'},
     'domain': 'death', 'known_outcome': 'positive', 'dasha_lord': 'Saturn', 'antardasha_lord': 'Mercury',
     'key_yogas': [], 'key_principles': ['maraka_dasha', '2nd_lord_7th_lord']},
    {'id': 'GT-015', 'source': 'bv_raman', 'description': 'Leo lagna — Balarishta, infant death',
     'lagna': 'Leo', 'planets': {'Sun': 'Leo', 'Moon': 'Aquarius', 'Mars': 'Virgo', 'Mercury': 'Leo', 'Jupiter': 'Leo', 'Venus': 'Virgo', 'Saturn': 'Capricorn', 'Rahu': 'Scorpio', 'Ketu': 'Taurus'},
     'domain': 'death', 'known_outcome': 'positive', 'dasha_lord': 'Moon', 'antardasha_lord': 'Rahu',
     'key_yogas': [], 'key_principles': ['balarishta', 'malefic_papakarthari']},

    # ── Health Cases ─────────────────────────────────────────────────────
    {'id': 'GT-016', 'source': 'bv_raman', 'description': 'Taurus lagna — Saturn aspects lagna and Moon, chronic illness',
     'lagna': 'Taurus', 'planets': {'Sun': 'Taurus', 'Moon': 'Taurus', 'Mars': 'Scorpio', 'Mercury': 'Aries', 'Jupiter': 'Aries', 'Venus': 'Gemini', 'Saturn': 'Leo', 'Rahu': 'Taurus', 'Ketu': 'Scorpio'},
     'domain': 'health', 'known_outcome': 'negative', 'dasha_lord': 'Saturn', 'antardasha_lord': '',
     'key_yogas': [], 'key_principles': ['saturn_aspects_lagna_moon', 'malefic_6th_house']},
    {'id': 'GT-017', 'source': 'sanjay_rath', 'description': 'Libra lagna — female epilepsy, badhak activation',
     'lagna': 'Libra', 'planets': {'Sun': 'Pisces', 'Moon': 'Virgo', 'Mars': 'Libra', 'Mercury': 'Aries', 'Jupiter': 'Scorpio', 'Venus': 'Libra', 'Saturn': 'Libra', 'Rahu': 'Virgo', 'Ketu': 'Pisces'},
     'domain': 'health', 'known_outcome': 'negative', 'dasha_lord': 'Jupiter', 'antardasha_lord': '',
     'key_yogas': [], 'key_principles': ['badhak_lord_activation', 'mrityupada']},
    {'id': 'GT-018', 'source': 'kn_rao', 'description': 'Leo lagna — Sun debilitated in 7th, chronic health',
     'lagna': 'Leo', 'planets': {'Sun': 'Aquarius', 'Moon': 'Gemini', 'Mars': 'Taurus', 'Mercury': 'Pisces', 'Jupiter': 'Scorpio', 'Venus': 'Pisces', 'Saturn': 'Cancer', 'Rahu': 'Pisces', 'Ketu': 'Virgo'},
     'domain': 'health', 'known_outcome': 'negative', 'dasha_lord': 'Saturn', 'antardasha_lord': 'Rahu',
     'key_yogas': [], 'key_principles': ['sun_debilitated', 'saturn_12th']},

    # ── Wealth Cases ─────────────────────────────────────────────────────
    {'id': 'GT-019', 'source': 'sanjay_rath', 'description': 'Chandraswami — Cancer lagna, immense wealth from tantra',
     'lagna': 'Cancer', 'planets': {'Sun': 'Virgo', 'Moon': 'Aquarius', 'Mars': 'Leo', 'Mercury': 'Libra', 'Jupiter': 'Capricorn', 'Venus': 'Leo', 'Saturn': 'Leo', 'Rahu': 'Sagittarius', 'Ketu': 'Gemini'},
     'domain': 'wealth', 'known_outcome': 'positive', 'dasha_lord': 'Saturn', 'antardasha_lord': '',
     'key_yogas': ['gajakesari'], 'key_principles': ['hora_lagna_analysis', '2nd_house_saturn_mars']},
    {'id': 'GT-020', 'source': 'kn_rao', 'description': 'Leo lagna — father-son business empire',
     'lagna': 'Leo', 'planets': {'Sun': 'Pisces', 'Moon': 'Sagittarius', 'Mars': 'Capricorn', 'Mercury': 'Aquarius', 'Jupiter': 'Aries', 'Venus': 'Aries', 'Saturn': 'Cancer', 'Rahu': 'Leo', 'Ketu': 'Aquarius'},
     'domain': 'wealth', 'known_outcome': 'positive', 'dasha_lord': 'Jupiter', 'antardasha_lord': '',
     'key_yogas': ['dhana_yoga'], 'key_principles': ['amk_in_kendra', 'jupiter_venus_conjunction']},

    # ── Spiritual Cases ──────────────────────────────────────────────────
    {'id': 'GT-021', 'source': 'sanjay_rath', 'description': 'Swami Asutosh — Aquarius lagna, renunciation',
     'lagna': 'Aquarius', 'planets': {'Sun': 'Capricorn', 'Moon': 'Pisces', 'Mars': 'Aries', 'Mercury': 'Aquarius', 'Jupiter': 'Gemini', 'Venus': 'Aquarius', 'Saturn': 'Sagittarius', 'Rahu': 'Cancer', 'Ketu': 'Capricorn'},
     'domain': 'spiritual', 'known_outcome': 'positive', 'dasha_lord': 'Saturn', 'antardasha_lord': '',
     'key_yogas': [], 'key_principles': ['12th_house_emphasis', 'upapada_lord_in_8th']},

    # ── Education Cases ──────────────────────────────────────────────────
    {'id': 'GT-022', 'source': 'bv_raman', 'description': 'Capricorn lagna — Venus in 4th, academic distinction',
     'lagna': 'Capricorn', 'planets': {'Sun': 'Aries', 'Moon': 'Cancer', 'Mars': 'Aries', 'Mercury': 'Aries', 'Jupiter': 'Sagittarius', 'Venus': 'Taurus', 'Saturn': 'Aquarius', 'Rahu': 'Virgo', 'Ketu': 'Pisces'},
     'domain': 'education', 'known_outcome': 'positive', 'dasha_lord': 'Venus', 'antardasha_lord': '',
     'key_yogas': [], 'key_principles': ['venus_4th_education', 'saturn_own_sign']},

    # ── Foreign Travel ───────────────────────────────────────────────────
    {'id': 'GT-023', 'source': 'kn_rao', 'description': 'Pisces lagna — foreign settlement, 12th lord in 11th',
     'lagna': 'Pisces', 'planets': {'Sun': 'Aquarius', 'Moon': 'Cancer', 'Mars': 'Aries', 'Mercury': 'Capricorn', 'Jupiter': 'Pisces', 'Venus': 'Capricorn', 'Saturn': 'Scorpio', 'Rahu': 'Gemini', 'Ketu': 'Sagittarius'},
     'domain': 'foreign_travel', 'known_outcome': 'positive', 'dasha_lord': 'Jupiter', 'antardasha_lord': 'Saturn',
     'key_yogas': ['hamsa_yoga'], 'key_principles': ['12th_lord_in_11th', 'rahu_in_4th']},

    # ── Mental Health Cases ──────────────────────────────────────────────
    {'id': 'GT-024', 'source': 'kn_rao', 'description': 'Gemini lagna — mental abnormality',
     'lagna': 'Gemini', 'planets': {'Sun': 'Aquarius', 'Moon': 'Leo', 'Mars': 'Pisces', 'Mercury': 'Aquarius', 'Jupiter': 'Sagittarius', 'Venus': 'Pisces', 'Saturn': 'Cancer', 'Rahu': 'Virgo', 'Ketu': 'Pisces'},
     'domain': 'mental_health', 'known_outcome': 'negative', 'dasha_lord': 'Mercury', 'antardasha_lord': '',
     'key_yogas': [], 'key_principles': ['mercury_affliction', 'moon_affliction', 'saturn_2nd']},

    # ── Additional career tests ──────────────────────────────────────────
    {'id': 'GT-025', 'source': 'bv_raman', 'description': 'Cancer lagna — Jupiter exalted + Mars yogakaraka, extraordinary career',
     'lagna': 'Cancer', 'planets': {'Sun': 'Cancer', 'Moon': 'Virgo', 'Mars': 'Cancer', 'Mercury': 'Cancer', 'Jupiter': 'Cancer', 'Venus': 'Gemini', 'Saturn': 'Gemini', 'Rahu': 'Libra', 'Ketu': 'Aries'},
     'domain': 'career_rise', 'known_outcome': 'positive', 'dasha_lord': 'Jupiter', 'antardasha_lord': '',
     'key_yogas': ['hamsa_yoga', 'gajakesari'], 'key_principles': ['jupiter_exalted_lagna', 'mars_yogakaraka_cancer']},

    # ── Longevity — long life confirmed ─────────────────────────────────
    {'id': 'GT-026', 'source': 'bv_raman', 'description': 'Scorpio lagna — Jupiter exalted in 5th, long life',
     'lagna': 'Scorpio', 'planets': {'Sun': 'Libra', 'Moon': 'Capricorn', 'Mars': 'Capricorn', 'Mercury': 'Scorpio', 'Jupiter': 'Pisces', 'Venus': 'Scorpio', 'Saturn': 'Sagittarius', 'Rahu': 'Gemini', 'Ketu': 'Sagittarius'},
     'domain': 'longevity', 'known_outcome': 'positive', 'dasha_lord': 'Jupiter', 'antardasha_lord': '',
     'key_yogas': ['hamsa_yoga'], 'key_principles': ['jupiter_exalted_trikona', 'mars_exalted']},

    # ── Military career ─────────────────────────────────────────────────
    {'id': 'GT-027', 'source': 'bv_raman', 'description': 'Aquarius lagna — Mars in 9th, distinguished military career',
     'lagna': 'Aquarius', 'planets': {'Sun': 'Virgo', 'Moon': 'Sagittarius', 'Mars': 'Virgo', 'Mercury': 'Virgo', 'Jupiter': 'Taurus', 'Venus': 'Leo', 'Saturn': 'Taurus', 'Rahu': 'Leo', 'Ketu': 'Aquarius'},
     'domain': 'career_rise', 'known_outcome': 'positive', 'dasha_lord': 'Mars', 'antardasha_lord': '',
     'key_yogas': [], 'key_principles': ['mars_in_8th_from_lagna', 'saturn_jupiter_in_4th']},

    # ── Aries lagna Ruchaka yoga ────────────────────────────────────────
    {'id': 'GT-028', 'source': 'bv_raman', 'description': 'Aries lagna — Mars in own sign in lagna, leadership',
     'lagna': 'Aries', 'planets': {'Sun': 'Capricorn', 'Moon': 'Scorpio', 'Mars': 'Aries', 'Mercury': 'Sagittarius', 'Jupiter': 'Sagittarius', 'Venus': 'Aquarius', 'Saturn': 'Pisces', 'Rahu': 'Cancer', 'Ketu': 'Capricorn'},
     'domain': 'career_rise', 'known_outcome': 'positive', 'dasha_lord': 'Mars', 'antardasha_lord': '',
     'key_yogas': ['ruchaka_yoga'], 'key_principles': ['mars_in_own_sign_lagna', 'jupiter_in_9th']},

    # ── Jupiter exalted career ──────────────────────────────────────────
    {'id': 'GT-029', 'source': 'kn_rao', 'description': 'Sagittarius lagna — Jupiter exalted in 8th, judicial position',
     'lagna': 'Sagittarius', 'planets': {'Sun': 'Cancer', 'Moon': 'Taurus', 'Mars': 'Virgo', 'Mercury': 'Cancer', 'Jupiter': 'Cancer', 'Venus': 'Gemini', 'Saturn': 'Virgo', 'Rahu': 'Aries', 'Ketu': 'Libra'},
     'domain': 'career_rise', 'known_outcome': 'positive', 'dasha_lord': 'Jupiter', 'antardasha_lord': 'Saturn',
     'key_yogas': ['raja_yoga', 'hamsa_yoga'], 'key_principles': ['jupiter_exalted_8th', 'triple_lagna_transit']},
    {'id': 'GT-030', 'source': 'kn_rao', 'description': 'Scorpio lagna — Jupiter exalted in 9th, fortune and elevation',
     'lagna': 'Scorpio', 'planets': {'Sun': 'Libra', 'Moon': 'Taurus', 'Mars': 'Scorpio', 'Mercury': 'Libra', 'Jupiter': 'Cancer', 'Venus': 'Virgo', 'Saturn': 'Leo', 'Rahu': 'Aries', 'Ketu': 'Libra'},
     'domain': 'career_rise', 'known_outcome': 'positive', 'dasha_lord': 'Jupiter', 'antardasha_lord': 'Moon',
     'key_yogas': ['hamsa_yoga', 'raja_yoga'], 'key_principles': ['jupiter_exalted_9th', 'mars_in_lagna_own_sign']},
]
