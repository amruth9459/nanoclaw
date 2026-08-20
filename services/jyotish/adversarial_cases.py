"""
ADVERSARIAL TEST CASES -- Charts where naive Jyotish prediction engines FAIL.

Each case represents a real celebrity chart where the obvious textbook prediction
is WRONG. These stress-test edge cases that require deeper analysis (yogas,
cancellations, divisional charts, karaka overrides, etc.).

Sources: AstroSage (A-rated birth times), AstroNidan, Lagna360, AstroLinked --
cross-referenced across at least 2 databases. All positions SIDEREAL (Lahiri).

Excludes all charts in BLIND_CASES and GROUND_TRUTH:
  Modi, Obama, Sachin, Amitabh, Nixon, Rajiv Gandhi, MJ, Mahatma Gandhi,
  Elvis, Diana, Gates, Bezos, Indira Gandhi, Steve Jobs, Elon Musk.
"""

import sys, os, json
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from interpret import interpret_chart

# Domain -> prediction area mapping (same as blind_test.py)
DOMAIN_TO_AREA = {
    'career_rise': 'Career',
    'career_fall': 'Career',
    'death': 'Health',
    'health': 'Health',
    'mental_health': 'Mental Health',
    'wealth': 'Wealth & Finance',
    'wealth_loss': 'Wealth & Finance',
    'marriage_timing': 'Marriage & Relationships',
    'marriage_problems': 'Marriage & Relationships',
    'spiritual': 'Spiritual',
    'longevity': 'Health',
}

EXPECTED_DIRECTION = {
    ('career_rise', 'positive'): 'positive',
    ('career_fall', 'positive'): 'negative',
    ('death', 'positive'): 'negative',
    ('health', 'negative'): 'negative',
    ('health', 'positive'): 'positive',
    ('wealth', 'positive'): 'positive',
    ('wealth_loss', 'positive'): 'negative',
    ('marriage_timing', 'positive'): 'positive',
    ('marriage_problems', 'positive'): 'negative',
    ('longevity', 'positive'): 'positive',
}

import datetime
today_year = datetime.date.today().year


# ==============================================================================
# ADVERSARIAL CASES
# ==============================================================================

ADVERSARIAL_CASES = [

    # --------------------------------------------------------------------------
    # ADV-001: Donald Trump -- Elected President 2016 during Jupiter Mahadasha
    #
    # WHY ADVERSARIAL: Jupiter is lord of 5th (Aries) and 8th (Pisces) for Leo
    # lagna. 8th lord dasha is textbook "bad" -- crisis, scandal, downfall. Yet
    # Trump won the presidency. A naive engine seeing "8th lord dasha" would
    # predict negative career outcome. The key: Jupiter also owns the 5th
    # (purva-punya, authority), Sun-Rahu in 10th create powerful raja yoga, and
    # Mars in lagna gives ruchaka-like strength. 8th lordship gets overridden by
    # 5th lord trikona ownership and powerful 10th house combinations.
    #
    # Source: AstroSage A-rated, AstroNidan, AstroLinked -- DOB 14 Jun 1946,
    # 10:54 AM, Jamaica NY. Jupiter Mahadasha Nov 2016-Nov 2032.
    # --------------------------------------------------------------------------
    {
        'id': 'ADV-001', 'name': 'Donald Trump — elected US President 2016',
        'source': 'astrosage_A', 'lagna': 'Leo',
        'planets': {
            'Sun': 'Taurus', 'Moon': 'Scorpio', 'Mars': 'Leo',
            'Mercury': 'Gemini', 'Jupiter': 'Virgo', 'Venus': 'Cancer',
            'Saturn': 'Cancer', 'Rahu': 'Taurus', 'Ketu': 'Scorpio',
        },
        'domain': 'career_rise', 'known_outcome': 'positive',
        'dasha_lord': 'Jupiter', 'antardasha_lord': '',
        'adversarial_reason': 'Jupiter is 8th lord for Leo lagna -- textbook dusthana lord dasha '
                              'should give crisis/downfall, not presidential victory. Requires '
                              'recognizing 5th lord trikona override and Sun-Rahu raja yoga in 10th.',
    },

    # --------------------------------------------------------------------------
    # ADV-002: Marilyn Monroe -- Death at 36 during Jupiter Mahadasha
    #
    # WHY ADVERSARIAL: Cancer lagna with Jupiter as 6th and 9th lord. 9th lord
    # dasha = bhagya period = textbook "great fortune". Yet she died (overdose,
    # Aug 1962). Jupiter is in 8th house (Aquarius) with Mars (yogakaraka for
    # Cancer but IN 8th house of death). A naive engine seeing "9th lord dasha"
    # predicts fortune. The key: Jupiter in 8th house becomes a functional
    # maraka (death-inflicter), and Mars-Jupiter in 8th amplifies danger despite
    # Mars being yogakaraka.
    #
    # Source: AstroSage A-rated -- DOB 1 Jun 1926, 9:30 AM, Los Angeles.
    # Jupiter MD approximately 1958-1974. Death Aug 1962 in Jupiter MD.
    # --------------------------------------------------------------------------
    {
        'id': 'ADV-002', 'name': 'Marilyn Monroe — death at 36 (1962)',
        'source': 'astrosage_A', 'lagna': 'Cancer',
        'planets': {
            'Sun': 'Taurus', 'Moon': 'Capricorn', 'Mars': 'Aquarius',
            'Mercury': 'Taurus', 'Jupiter': 'Aquarius', 'Venus': 'Aries',
            'Saturn': 'Libra', 'Rahu': 'Gemini', 'Ketu': 'Sagittarius',
        },
        'domain': 'death', 'known_outcome': 'positive',
        'dasha_lord': 'Jupiter', 'antardasha_lord': 'Rahu',
        'adversarial_reason': '9th lord Jupiter dasha should be the most fortunate period '
                              '(bhagya). But Jupiter sits in 8th house of death with Mars. '
                              'Naive system predicts fortune; actual outcome is death.',
    },

    # --------------------------------------------------------------------------
    # ADV-003: Muhammad Ali -- World Heavyweight Champion during Saturn dasha
    #
    # WHY ADVERSARIAL: Cancer lagna with Saturn as 7th and 8th lord (double
    # maraka + dusthana). Saturn dasha for Cancer = classic "terrible period"
    # per textbooks. Yet Ali became world champion (Feb 1964, Saturn MD) and
    # dominated boxing. The key: Saturn in Aries (10th house, debilitated but
    # WITH Mars creating neechabhanga raja yoga via dispositor), Mars-Saturn in
    # 10th = extraordinary career in combat/athletics. Debilitation cancellation
    # overrides textbook negativity.
    #
    # Source: AstroSage A-rated, AstroNidan -- DOB 17 Jan 1942, 6:35 PM,
    # Louisville KY. Saturn MD during championship years.
    # --------------------------------------------------------------------------
    {
        'id': 'ADV-003', 'name': 'Muhammad Ali — World Heavyweight Champion 1964',
        'source': 'astrosage_A', 'lagna': 'Cancer',
        'planets': {
            'Sun': 'Capricorn', 'Moon': 'Capricorn', 'Mars': 'Aries',
            'Mercury': 'Capricorn', 'Jupiter': 'Taurus', 'Venus': 'Capricorn',
            'Saturn': 'Aries', 'Rahu': 'Leo', 'Ketu': 'Aquarius',
        },
        'domain': 'career_rise', 'known_outcome': 'positive',
        'dasha_lord': 'Saturn', 'antardasha_lord': '',
        'adversarial_reason': 'Saturn is 7th+8th lord (maraka+dusthana) for Cancer lagna and is '
                              'debilitated in Aries. Textbook predicts crisis/death. Yet Saturn in '
                              '10th with Mars creates neechabhanga raja yoga + career peak in combat.',
    },

    # --------------------------------------------------------------------------
    # ADV-004: Warren Buffett -- Became billionaire despite 2nd lord Saturn in
    # Sagittarius and 8th house Jupiter-Mars
    #
    # WHY ADVERSARIAL: Sagittarius lagna. 2nd lord (dhana, wealth) Saturn is in
    # lagna (not in wealth houses). Jupiter (lagna lord) AND Mars are both in
    # 8th house (Gemini) -- 8th house = losses, inheritance problems. A naive
    # engine sees "lagna lord in 8th" as deeply negative for longevity AND
    # wealth. But Jupiter-Mars in 8th gives "other people's money" (8th =
    # insurance, investments, pooled capital) -- literally Buffett's business
    # model. Venus-Mercury in 11th (gains house, Virgo) is the real wealth
    # driver, ignored if engine fixates on 8th house affliction.
    #
    # Source: AstroSage, AstroNidan (Sagittarius asc), Lagna360 -- DOB 30 Aug
    # 1930, 3:00 PM, Omaha NE.
    # --------------------------------------------------------------------------
    {
        'id': 'ADV-004', 'name': 'Warren Buffett — became world richest investor',
        'source': 'astrosage_A', 'lagna': 'Sagittarius',
        'planets': {
            'Sun': 'Leo', 'Moon': 'Scorpio', 'Mars': 'Gemini',
            'Mercury': 'Virgo', 'Jupiter': 'Gemini', 'Venus': 'Virgo',
            'Saturn': 'Sagittarius', 'Rahu': 'Aries', 'Ketu': 'Libra',
        },
        'domain': 'wealth', 'known_outcome': 'positive',
        'dasha_lord': 'Mercury', 'antardasha_lord': '',
        'adversarial_reason': 'Lagna lord Jupiter in 7th with Mars, plus Moon in 12th (Scorpio = losses). '
                              'Textbook sees lagna lord in dusthana-adjacent and 12th Moon as wealth-negative. '
                              'But Mercury-Venus in 10th (Virgo, own sign) + Jupiter aspects 1st = massive wealth.',
    },

    # --------------------------------------------------------------------------
    # ADV-005: Tiger Woods -- Career destruction 2009 despite strong Virgo lagna
    #
    # WHY ADVERSARIAL: Virgo lagna with lagna lord Mercury in 5th house
    # (Capricorn) -- excellent for sports, games, creativity. Jupiter exalted
    # in 7th house (Pisces) -- hamsa yoga. Venus in Scorpio (3rd house) gives
    # artistic/athletic talent. Yet in 2009, his career was destroyed by
    # scandal. A naive engine seeing "lagna lord in 5th + exalted Jupiter" would
    # predict sustained success. The key: Rahu in 2nd (Libra) + Ketu in 8th
    # (Aries) = hidden scandals surface. Saturn dasha lord (6th lord, enemy) in
    # 11th (Cancer, debilitated) eventually brings disgrace through hidden
    # enemies and self-destructive behavior.
    #
    # Source: AstroSage A-rated, AstroNidan -- DOB 30 Dec 1975, 10:50 PM,
    # Cypress CA.
    # --------------------------------------------------------------------------
    {
        'id': 'ADV-005', 'name': 'Tiger Woods — scandal and career destruction 2009',
        'source': 'astrosage_A', 'lagna': 'Virgo',
        'planets': {
            'Sun': 'Sagittarius', 'Moon': 'Scorpio', 'Mars': 'Taurus',
            'Mercury': 'Capricorn', 'Jupiter': 'Pisces', 'Venus': 'Scorpio',
            'Saturn': 'Cancer', 'Rahu': 'Libra', 'Ketu': 'Aries',
        },
        'domain': 'career_fall', 'known_outcome': 'positive',
        'dasha_lord': 'Saturn', 'antardasha_lord': 'Mercury',
        'adversarial_reason': 'Lagna lord Mercury in 5th (sports) + exalted Jupiter in 7th (hamsa yoga) '
                              '= textbook extraordinary career. Naive engine predicts sustained success. '
                              'But Saturn is debilitated 6th lord and Rahu in 2nd destroys reputation.',
    },

    # --------------------------------------------------------------------------
    # ADV-006: JFK -- Assassination during Saturn-Jupiter dasha
    #
    # WHY ADVERSARIAL: Virgo lagna. Saturn is yogakaraka for Virgo? No -- Saturn
    # owns 5th (Capricorn) and 6th (Aquarius), making it mixed. Jupiter owns 4th
    # (Sagittarius) and 7th (Pisces) -- 7th lord is maraka but 4th lord is kendra.
    # The real trap: Jupiter in 9th (Taurus) looks great (9th house fortune), and
    # Saturn in 11th (Cancer) looks like gains. A naive engine seeing Jupiter in
    # 9th + Saturn in 11th predicts positive. But Saturn is debilitated in Cancer
    # and Jupiter as 7th lord is a maraka. Assassination on 22 Nov 1963.
    #
    # Source: AstroSage, AstroNidan (Virgo lagna confirmed) -- DOB 29 May 1917,
    # 3:00 PM, Brookline MA.
    # --------------------------------------------------------------------------
    {
        'id': 'ADV-006', 'name': 'JFK — assassinated November 1963',
        'source': 'astrosage_A', 'lagna': 'Virgo',
        'planets': {
            'Sun': 'Taurus', 'Moon': 'Leo', 'Mars': 'Aries',
            'Mercury': 'Aries', 'Jupiter': 'Taurus', 'Venus': 'Taurus',
            'Saturn': 'Cancer', 'Rahu': 'Sagittarius', 'Ketu': 'Gemini',
        },
        'domain': 'death', 'known_outcome': 'positive',
        'dasha_lord': 'Saturn', 'antardasha_lord': 'Jupiter',
        'adversarial_reason': 'Jupiter in 9th (fortune house) + Saturn in 11th (gains) looks '
                              'positive. Naive engine misses: Jupiter is 7th lord maraka, Saturn '
                              'is debilitated in Cancer. Saturn-Jupiter = double maraka activation.',
    },

    # --------------------------------------------------------------------------
    # ADV-007: Sanjay Dutt -- Imprisonment despite strong Venus in 10th
    #
    # WHY ADVERSARIAL: Scorpio lagna. Venus is yogakaraka (5th+10th lord) and is
    # in 10th house (Leo) with Mars (lagna lord in 10th = great career). This
    # should give extraordinary career + fame without obstacles. Yet Sanjay Dutt
    # was imprisoned (1993, arms case; again 2013-2016). During Rahu MD, Venus
    # antardasha -- the YOGAKARAKA itself became the vehicle for imprisonment.
    # A naive engine seeing "yogakaraka in 10th" predicts unqualified success.
    # The key: Rahu MD corrupts Venus AD results. Jupiter (2nd+5th lord... no,
    # for Scorpio: Jupiter = 2nd+5th lord) in 12th house (Libra) = confinement
    # + legal troubles. Rahu in Virgo (11th) aspects Jupiter in 12th.
    #
    # Source: AstroSage A-rated, AstroNidan, VedicNakshatras -- DOB 29 Jul 1959,
    # 2:45 PM, Bombay.
    # --------------------------------------------------------------------------
    {
        'id': 'ADV-007', 'name': 'Sanjay Dutt — imprisoned 1993 (arms case)',
        'source': 'astrosage_A', 'lagna': 'Scorpio',
        'planets': {
            'Sun': 'Cancer', 'Moon': 'Taurus', 'Mars': 'Leo',
            'Mercury': 'Cancer', 'Jupiter': 'Libra', 'Venus': 'Leo',
            'Saturn': 'Sagittarius', 'Rahu': 'Virgo', 'Ketu': 'Pisces',
        },
        'domain': 'career_fall', 'known_outcome': 'positive',
        'dasha_lord': 'Rahu', 'antardasha_lord': 'Venus',
        'adversarial_reason': 'Venus is yogakaraka (5th+10th lord) in 10th house with lagna lord '
                              'Mars -- textbook raja yoga. Naive engine predicts peak career. But '
                              'Rahu MD corrupts results; Jupiter in 12th = confinement.',
    },

    # --------------------------------------------------------------------------
    # ADV-008: Jayalalithaa -- CM of Tamil Nadu despite Jupiter in badhaka
    # (obstruction) sign + imprisonment, then comeback
    #
    # WHY ADVERSARIAL: Taurus lagna. Jupiter rules 8th (Sagittarius) and 11th
    # (Pisces). Jupiter in Sagittarius (own sign, 8th house) -- 8th house is
    # dusthana; lagna lord Venus in 11th (Pisces, exalted!) is great for gains.
    # She was imprisoned in 2014 (corruption case) during Jupiter MD / Saturn AD.
    # But then ACQUITTED in 2015 and returned as CM. A naive engine would see
    # "8th lord dasha + Saturn AD" = total downfall. But Jupiter in own sign in
    # 8th actually gives "rising from the ashes" ability, and Venus exalted in
    # 11th = ultimate gains despite obstacles. The COMEBACK is the adversarial
    # element.
    #
    # Source: AstroSage, VedicNakshatras -- DOB 24 Feb 1948, 2:36 PM, Mysore.
    # --------------------------------------------------------------------------
    {
        'id': 'ADV-008', 'name': 'Jayalalithaa — acquitted and returned as CM 2015',
        'source': 'astrosage_A', 'lagna': 'Taurus',
        'planets': {
            'Sun': 'Aquarius', 'Moon': 'Leo', 'Mars': 'Leo',
            'Mercury': 'Aquarius', 'Jupiter': 'Sagittarius', 'Venus': 'Pisces',
            'Saturn': 'Cancer', 'Rahu': 'Sagittarius', 'Ketu': 'Gemini',
        },
        'domain': 'career_rise', 'known_outcome': 'positive',
        'dasha_lord': 'Jupiter', 'antardasha_lord': 'Saturn',
        'adversarial_reason': 'Jupiter is 8th lord and Saturn is badhaka (3rd lord) for Taurus. '
                              '8th lord + badhaka dasha = textbook ruin. But Jupiter in own sign '
                              'in 8th = phoenix-like comeback. Venus exalted in 11th seals victory.',
    },

    # --------------------------------------------------------------------------
    # ADV-009: Whitney Houston -- Death during Moon dasha (Moon in 2nd, Pisces)
    #
    # WHY ADVERSARIAL: Aquarius lagna. Moon is 6th lord (Cancer) placed in 2nd
    # house (Pisces) with Jupiter (lord of 2nd Pisces + 11th Sagittarius) --
    # creating Gajakesari yoga in 2nd house. 2nd house with benefic Jupiter +
    # Moon = wealth, voice (she was the greatest vocalist). Gajakesari yoga gave
    # her extraordinary fame. A naive engine seeing "Gajakesari in 2nd, Moon
    # dasha" predicts continued fame and wealth. But Moon is 6th lord (disease,
    # enemies, debt) AND 2nd house is a maraka sthana. Moon as 6th lord in
    # maraka sthana during its own dasha = drug addiction (6th) + death (2nd
    # maraka). The same yoga that gave fame killed her.
    #
    # Source: AstroSage, AstroNidan, Komilla Sutton analysis -- DOB 9 Aug 1963,
    # 8:55 PM, Newark NJ. Death 11 Feb 2012 in Moon MD.
    # --------------------------------------------------------------------------
    {
        'id': 'ADV-009', 'name': 'Whitney Houston — death from drug overdose 2012',
        'source': 'astrosage_A', 'lagna': 'Aquarius',
        'planets': {
            'Sun': 'Cancer', 'Moon': 'Pisces', 'Mars': 'Cancer',
            'Mercury': 'Cancer', 'Jupiter': 'Pisces', 'Venus': 'Gemini',
            'Saturn': 'Aquarius', 'Rahu': 'Cancer', 'Ketu': 'Capricorn',
        },
        'domain': 'death', 'known_outcome': 'positive',
        'dasha_lord': 'Moon', 'antardasha_lord': 'Ketu',
        'adversarial_reason': 'Moon-Jupiter Gajakesari yoga in 2nd house gave her legendary voice '
                              'and fame. Naive engine predicts positive Moon dasha. But Moon is 6th '
                              'lord (disease/addiction) in 2nd maraka sthana -- same yoga that gave '
                              'fame caused death.',
    },

    # --------------------------------------------------------------------------
    # ADV-010: Benazir Bhutto -- Became PM despite debilitated Moon + 8th lord
    # emphasis, then assassinated in Saturn dasha
    #
    # WHY ADVERSARIAL (dual trap): Sagittarius lagna. She became PM in 1988
    # during Jupiter MD (lagna lord, positive -- this part is expected). But the
    # SECOND trap: she was assassinated in 2007 during Saturn MD / Jupiter AD.
    # Saturn is 2nd lord (maraka) and 3rd lord. Jupiter is lagna lord. A naive
    # engine might see "lagna lord as antardasha" and think protection. But
    # Saturn as 2nd lord maraka in 10th house (Virgo) + Jupiter AD doesn't
    # protect -- it brings public death (10th = public life). Venus in 5th
    # (Aries) debilitated suggests political vulnerability despite being 6th+11th
    # lord.
    #
    # Source: AstroSage, AstroNidan, Shanker study -- DOB 21 Jun 1953, 4:30 PM,
    # Karachi. Assassinated 27 Dec 2007.
    # --------------------------------------------------------------------------
    {
        'id': 'ADV-010', 'name': 'Benazir Bhutto — assassinated December 2007',
        'source': 'astrosage_A', 'lagna': 'Sagittarius',
        'planets': {
            'Sun': 'Gemini', 'Moon': 'Libra', 'Mars': 'Gemini',
            'Mercury': 'Cancer', 'Jupiter': 'Taurus', 'Venus': 'Aries',
            'Saturn': 'Virgo', 'Rahu': 'Capricorn', 'Ketu': 'Cancer',
        },
        'domain': 'death', 'known_outcome': 'positive',
        'dasha_lord': 'Saturn', 'antardasha_lord': 'Jupiter',
        'adversarial_reason': 'Saturn-Jupiter dasha: Jupiter is lagna lord (protection expected), '
                              'Saturn is in 10th (career house, looks strong). Naive engine predicts '
                              'career event, not death. But Saturn is 2nd lord maraka, and Jupiter AD '
                              'as 4th lord in 6th = no protection. Public assassination.',
    },

    # --------------------------------------------------------------------------
    # ADV-011: Lance Armstrong -- Doping ban 2012 during Rahu/Ketu dasha
    #
    # WHY ADVERSARIAL: Mars exalted in Capricorn (3rd house for Scorpio lagna)
    # gives extraordinary physical prowess. Jupiter in lagna (Scorpio) = strong
    # self. Lagna lord Mars exalted = textbook peak career/health. Naive engine
    # sees exalted Mars + Jupiter in lagna and predicts positive career. But
    # Rahu/Ketu dasha brings hidden karma to light — doping scandal.
    #
    # Source: AstroSage, Astrodatabank. DOB 18 Sep 1971, 12:00 PM, Plano TX.
    # --------------------------------------------------------------------------
    {
        'id': 'ADV-011', 'name': 'Lance Armstrong — doping ban and career destruction 2012',
        'source': 'astrosage_A', 'lagna': 'Scorpio',
        'planets': {
            'Sun': 'Virgo', 'Moon': 'Leo', 'Mars': 'Capricorn',
            'Mercury': 'Leo', 'Jupiter': 'Scorpio', 'Venus': 'Virgo',
            'Saturn': 'Taurus', 'Rahu': 'Capricorn', 'Ketu': 'Cancer',
        },
        'domain': 'career_fall', 'known_outcome': 'positive',
        'dasha_lord': 'Rahu', 'antardasha_lord': 'Ketu',
        'adversarial_reason': 'Mars exalted in Capricorn + Jupiter in lagna = textbook extraordinary '
                              'athlete. Naive engine sees strong chart and predicts positive career. '
                              'But Rahu/Ketu axis brings hidden karma (doping) to surface.',
    },

    # --------------------------------------------------------------------------
    # ADV-012: OJ Simpson -- Criminal trial 1995 during Venus/Sun dasha
    #
    # WHY ADVERSARIAL: Venus is 3rd+10th lord for Leo lagna, placed in 11th
    # (Gemini) — textbook gains and career success house. Sun is lagna lord
    # (Leo) in 11th = even more gains. Naive engine sees lagna lord + 10th lord
    # both in house of gains and predicts positive career. But Venus/Sun also
    # activates 3rd house themes (violence, courage) and the chart has Saturn
    # in Cancer (12th = imprisonment).
    #
    # Source: AstroSage A-rated. DOB 9 Jul 1947, 8:08 AM, San Francisco.
    # --------------------------------------------------------------------------
    {
        'id': 'ADV-012', 'name': 'OJ Simpson — criminal trial and career destruction 1995',
        'source': 'astrosage_A', 'lagna': 'Leo',
        'planets': {
            'Sun': 'Gemini', 'Moon': 'Pisces', 'Mars': 'Taurus',
            'Mercury': 'Cancer', 'Jupiter': 'Libra', 'Venus': 'Gemini',
            'Saturn': 'Cancer', 'Rahu': 'Taurus', 'Ketu': 'Scorpio',
        },
        'domain': 'career_fall', 'known_outcome': 'positive',
        'dasha_lord': 'Venus', 'antardasha_lord': 'Sun',
        'adversarial_reason': 'Venus (10th lord) and Sun (lagna lord) both in 11th house (gains) = '
                              'textbook career success. Naive engine predicts positive. But Saturn in '
                              '12th (prison) and the murder trial destroyed his career/reputation.',
    },

    # --------------------------------------------------------------------------
    # ADV-013: Bernie Madoff -- Fraud conviction 2009 during Jupiter/Ketu dasha
    #
    # WHY ADVERSARIAL: Jupiter is lagna lord for Cancer lagna, placed in
    # Aquarius (8th house) — but this is Viparita configuration. Sun-Moon-
    # Mercury in Aries (10th house = exalted Sun in 10th = powerful career).
    # Naive engine sees Sun exalted in 10th + lagna lord Jupiter and predicts
    # positive wealth. But Jupiter in 8th + Ketu AD = secrets exposed.
    #
    # Source: Lagna360, navamsa.com. DOB 29 Apr 1938, Queens, NY.
    # --------------------------------------------------------------------------
    {
        'id': 'ADV-013', 'name': 'Bernie Madoff — fraud conviction and career destruction 2009',
        'source': 'lagna360_R', 'lagna': 'Cancer',
        'planets': {
            'Sun': 'Aries', 'Moon': 'Aries', 'Mars': 'Taurus',
            'Mercury': 'Aries', 'Jupiter': 'Aquarius', 'Venus': 'Taurus',
            'Saturn': 'Pisces', 'Rahu': 'Scorpio', 'Ketu': 'Taurus',
        },
        'domain': 'career_fall', 'known_outcome': 'positive',
        'dasha_lord': 'Jupiter', 'antardasha_lord': 'Ketu',
        'adversarial_reason': 'Sun exalted in 10th (Aries) + Sun-Moon-Mercury conjunction in 10th = '
                              'textbook powerful career and wealth. Naive engine predicts positive. '
                              'But Jupiter (lagna lord) in 8th + Ketu AD = secrets/fraud exposed.',
    },
]


# ==============================================================================
# RUNNER (mirrors blind_test.py structure)
# ==============================================================================

def _build_chart_legacy(case):
    """Build minimal rasi-only chart_data from test case (fallback)."""
    rasi = [{'body': 'Lagna', 'rashi': case['lagna']}]
    for name, rashi in case['planets'].items():
        rasi.append({'body': name, 'rashi': rashi, 'degrees': 15.0, 'retro': False})

    vimshottari = []
    md = case.get('dasha_lord', '')
    if md:
        vimshottari.append({'level': 'maha', 'lord': md,
                            'start_date': f'{today_year-3}-01-01', 'end_date': f'{today_year+4}-01-01'})
    ad = case.get('antardasha_lord', '')
    if ad:
        vimshottari.append({'level': 'antar', 'lord': f'{md}/{ad}',
                            'start_date': f'{today_year-1}-01-01', 'end_date': f'{today_year+1}-01-01'})

    return {
        'rasi': rasi, 'vimshottari': vimshottari,
        'birth_date': '2000', 'place_name': case['id'],
        'transits': {}, 'karakas': {}, 'navamsha': [],
        'shadbala': {}, 'doshas': {},
        'ashtakavarga_sav': [], 'ashtakavarga_bav': {},
    }


def _build_chart(case):
    """Build chart_data: test-case rasi (hand-verified) + engine enrichment (navamsha, yogas, etc.)."""
    # Start with legacy rasi-only chart (hand-verified positions)
    chart = _build_chart_legacy(case)

    # Try to enrich with engine-computed data (navamsha, shadbala, yogas, karakas, arudha, other dashas)
    try:
        from birth_data_registry import get_birth_data
        from chart_cache import get_cached_chart, save_chart_cache
    except ImportError:
        return chart

    birth = get_birth_data(case['id'])
    if not birth:
        return chart

    # Check cache first
    cached = get_cached_chart(birth)
    if cached:
        enrichment = cached
    else:
        try:
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
                return chart
            enrichment = asdict(result)
            save_chart_cache(birth, enrichment)
        except Exception:
            return chart

    # Enrich: only add engine data that's safe with test-case rasi positions.
    # Exclude shadbala/yogas/navamsha — they depend on exact degrees which differ
    # from the hand-curated test case positions (15° default).
    ENRICHMENT_KEYS = [
        'other_dashas', 'sthira_karakas',
    ]
    for key in ENRICHMENT_KEYS:
        if key in enrichment and enrichment[key]:
            chart[key] = enrichment[key]

    # Pass event_date for Yogini/Chara period matching (not today's date)
    event_date = birth.get('event_date')
    if not event_date:
        from birth_data_registry import CASES
        case_info = CASES.get(case['id'], {})
        event_date = case_info.get('event_date')
    if event_date:
        chart['event_date'] = event_date

    return chart


def run_adversarial_test(verbose=True, use_llm=False, model='gemini-2.0-flash', use_cache=True):
    if use_llm == 'hybrid':
        from llm_synthesizer import interpret_chart_hybrid, print_cost_summary, reset_cost_tracking
        reset_cost_tracking()
        _interpret = lambda chart: interpret_chart_hybrid(chart, model=model, use_cache=use_cache)
        print(f'Using HYBRID synthesis (rule + LLM override): {model}\n')
    elif use_llm:
        from llm_synthesizer import interpret_chart_llm, print_cost_summary, reset_cost_tracking
        reset_cost_tracking()
        _interpret = lambda chart: interpret_chart_llm(chart, model=model, use_cache=use_cache)
        print(f'Using LLM synthesis: {model}\n')
    else:
        _interpret = interpret_chart

    total = len(ADVERSARIAL_CASES)
    correct = 0
    incorrect = 0
    errors = 0
    by_domain = defaultdict(lambda: {'correct': 0, 'incorrect': 0, 'total': 0})

    print(f'\n{"="*70}')
    print(f'ADVERSARIAL TEST — edge cases where naive prediction SHOULD fail')
    print(f'{"="*70}\n')

    for case in ADVERSARIAL_CASES:
        cid = case['id']
        domain = case['domain']
        area = DOMAIN_TO_AREA.get(domain, 'Career')
        expected_key = (domain, case['known_outcome'])
        expected_dir = EXPECTED_DIRECTION.get(expected_key, case['known_outcome'])

        try:
            chart = _build_chart(case)
            result = _interpret(chart)

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
                      f'conf={conf:.2f} net={net:.1f}')
                print(f'         {case["name"]}')
                if not is_correct:
                    summary = pred.get('summary', '')[:200]
                    print(f'         summary: {summary}')
                print(f'         adversarial: {case["adversarial_reason"][:120]}')
                print()

        except Exception as e:
            errors += 1
            if verbose:
                print(f'  ERROR {cid}: {e}')

    evaluated = correct + incorrect
    accuracy = correct / evaluated if evaluated > 0 else 0

    print(f'\n{"="*70}')
    print(f'ADVERSARIAL TEST RESULTS')
    print(f'{"="*70}')
    print(f'Total: {total}  |  Evaluated: {evaluated}  |  Errors: {errors}')
    print(f'Accuracy: {correct}/{evaluated} = {accuracy:.1%}')
    print()
    print('--- By Domain ---')
    for d, s in sorted(by_domain.items()):
        acc = s['correct'] / s['total'] if s['total'] > 0 else 0
        print(f'  {d:20s}: {s["correct"]}/{s["total"]} = {acc:.0%}')

    print()
    print('NOTE: Low accuracy on these cases is EXPECTED. These are adversarial')
    print('edge cases specifically chosen because naive rule-based systems get')
    print('them wrong. Improvement here requires deeper logic:')
    print('  - Neechabhanga (debilitation cancellation)')
    print('  - Viparita raja yoga (dusthana lords in dusthanas)')
    print('  - Maraka sthana analysis overriding benefic yogas')
    print('  - Dasha lord functional role vs natural role')
    print('  - Rahu/Ketu acting as dispositor proxy')

    if use_llm:
        print_cost_summary()

    return {'accuracy': accuracy, 'correct': correct, 'evaluated': evaluated, 'by_domain': dict(by_domain)}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Adversarial test for Jyotish interpretation pipeline')
    parser.add_argument('--llm', action='store_true', help='Use LLM synthesis instead of rule-based stage7')
    parser.add_argument('--hybrid', action='store_true', help='Use hybrid mode: rule engine + LLM override')
    parser.add_argument('--model', default='gemini-2.0-flash',
                        help='LLM model (gemini-2.0-flash, gemini-2.5-flash, claude-sonnet, claude-haiku, claude-opus)')
    parser.add_argument('--no-cache', action='store_true', help='Disable LLM response cache')
    args = parser.parse_args()
    mode = 'hybrid' if args.hybrid else (True if args.llm else False)
    run_adversarial_test(use_llm=mode, model=args.model, use_cache=not args.no_cache)
