"""
Jyotish Interpretation Pipeline — 7-Stage Chart Analysis.
Composite methodology: PVR Narasimha Rao + KN Rao (PACDARES, Double Transit,
Composite Approach) + Sanjay Rath (Jaimini Karakas, Arudha, Argala) +
BV Raman (Maraka rules, Ashtakavarga, Hindu Predictive Astrology).

Takes computed chart data and produces structured interpretations with
confidence levels. Designed for LLM consumption — the output is a structured
analysis that an LLM can use to generate natural language predictions.
"""
import json
import datetime
from case_patterns import (CASE_PATTERNS, YOGAKARAKA_CAREER_PATTERNS,
                           GAJAKESARI_EVIDENCE, JUPITER_KENDRA_PROTECTION)

# ── Constants ───────────────────────────────────────────────────────────────
RASHI = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo',
         'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces']

RASHI_LORDS = {
    'Aries': 'Mars', 'Taurus': 'Venus', 'Gemini': 'Mercury', 'Cancer': 'Moon',
    'Leo': 'Sun', 'Virgo': 'Mercury', 'Libra': 'Venus', 'Scorpio': 'Mars',
    'Sagittarius': 'Jupiter', 'Capricorn': 'Saturn', 'Aquarius': 'Saturn', 'Pisces': 'Jupiter',
}

EXALTATION = {
    'Sun': 'Aries', 'Moon': 'Taurus', 'Mars': 'Capricorn', 'Mercury': 'Virgo',
    'Jupiter': 'Cancer', 'Venus': 'Pisces', 'Saturn': 'Libra',
}
DEBILITATION = {
    'Sun': 'Libra', 'Moon': 'Scorpio', 'Mars': 'Cancer', 'Mercury': 'Pisces',
    'Jupiter': 'Capricorn', 'Venus': 'Virgo', 'Saturn': 'Aries',
}

OWN_SIGNS = {
    'Sun': ['Leo'], 'Moon': ['Cancer'], 'Mars': ['Aries', 'Scorpio'],
    'Mercury': ['Gemini', 'Virgo'], 'Jupiter': ['Sagittarius', 'Pisces'],
    'Venus': ['Taurus', 'Libra'], 'Saturn': ['Capricorn', 'Aquarius'],
}

NATURAL_BENEFICS = {'Jupiter', 'Venus', 'Mercury'}  # Mercury when unafflicted
NATURAL_MALEFICS = {'Sun', 'Mars', 'Saturn', 'Rahu', 'Ketu'}

# Yogakaraka by Lagna — single planet owning BOTH a Kendra AND a Trikona
# Laghu Parashari Sloka 12: Only true Kendra+Trikona lords qualify
# Aries and Scorpio have no single Yogakaraka (pairs instead)
YOGAKARAKA = {
    'Taurus': 'Saturn',       # owns 9th + 10th
    'Gemini': 'Mercury',      # owns 1st + 4th (Lagna=Trikona + Kendra)
    'Cancer': 'Mars',         # owns 5th + 10th
    'Leo': 'Mars',            # owns 4th + 9th
    'Virgo': 'Mercury',       # owns 1st + 10th (Lagna=Trikona + Kendra)
    'Libra': 'Saturn',        # owns 4th + 5th
    'Sagittarius': 'Jupiter', # owns 1st + 4th (Lagna=Trikona + Kendra)
    'Capricorn': 'Venus',     # owns 5th + 10th
    'Aquarius': 'Venus',      # owns 4th + 9th
    'Pisces': 'Jupiter',      # owns 1st + 10th (Lagna=Trikona + Kendra)
}

# Graha Drishti (planetary aspects) — houses aspected from occupied position
GRAHA_DRISHTI = {
    'Sun': [7], 'Moon': [7], 'Mercury': [7], 'Venus': [7],
    'Mars': [4, 7, 8], 'Jupiter': [5, 7, 9], 'Saturn': [3, 7, 10],
    'Rahu': [5, 7, 9], 'Ketu': [5, 7, 9],  # nodes aspect like Jupiter
}

# Jupiter/Saturn transit influence signs (for Double Transit)
# Jupiter influences: occupied + 5th, 7th, 9th from it
# Saturn influences: occupied + 3rd, 7th, 10th from it
JUPITER_ASPECT_OFFSETS = [0, 4, 6, 8]  # 1st, 5th, 7th, 9th (0-indexed)
SATURN_ASPECT_OFFSETS = [0, 2, 6, 9]   # 1st, 3rd, 7th, 10th (0-indexed)

HOUSE_THEMES = {
    1: 'Self, health, personality, appearance',
    2: 'Wealth, family, speech, food',
    3: 'Courage, siblings, communication, short travel',
    4: 'Mother, happiness, property, vehicles, education',
    5: 'Children, intelligence, romance, past-life merit',
    6: 'Enemies, disease, debt, service',
    7: 'Spouse, marriage, partnerships, public dealings',
    8: 'Longevity, transformation, inheritance, occult',
    9: 'Fortune, father, guru, dharma, long travel',
    10: 'Career, authority, fame, government',
    11: 'Gains, income, elder siblings, desire fulfillment',
    12: 'Losses, foreign lands, moksha, bed pleasures',
}

KENDRA = {1, 4, 7, 10}
TRIKONA = {1, 5, 9}
DUSTHANA = {6, 8, 12}
UPACHAYA = {3, 6, 10, 11}
MARAKA = {2, 7}

# Combustion degrees from Sun (Rule F-3, KN Rao/Ansari)
COMBUSTION_DEGREES = {
    'Moon': 12, 'Mars': 17, 'Mercury': 11, 'Jupiter': 15,
    'Venus': 9, 'Saturn': 17,
}

# Marana Karaka Sthana — houses where planets lose vitality (classical)
# Planet placed in its MKS house behaves as if "dead" — severely weakened
MARANA_KARAKA_STHANA = {
    'Sun': 12, 'Moon': 8, 'Mars': 7, 'Mercury': 7,
    'Jupiter': 3, 'Venus': 6, 'Saturn': 1, 'Rahu': 9,
}

# Separative planets — give separation from house events (Rule E-1)
SEPARATIVE_PLANETS = {'Sun', 'Saturn', 'Rahu', 'Mars'}

# Natural friendship table (Ansari p.18-20)
NATURAL_FRIENDS = {
    'Sun': {'Moon', 'Mars', 'Jupiter'},
    'Moon': {'Sun', 'Mercury'},
    'Mars': {'Sun', 'Moon', 'Jupiter'},
    'Mercury': {'Sun', 'Venus'},
    'Jupiter': {'Sun', 'Moon', 'Mars'},
    'Venus': {'Mercury', 'Saturn'},
    'Saturn': {'Mercury', 'Venus'},
    'Rahu': {'Mercury', 'Venus', 'Saturn'},
    'Ketu': {'Mercury', 'Venus'},
}
NATURAL_ENEMIES = {
    'Sun': {'Venus', 'Saturn', 'Rahu'},
    'Moon': set(),  # Moon has NO natural enemy
    'Mars': {'Mercury'},
    'Mercury': {'Moon'},
    'Jupiter': {'Mercury', 'Venus'},
    'Venus': {'Sun', 'Moon'},
    'Saturn': {'Sun', 'Moon', 'Mars'},
    'Rahu': {'Sun', 'Moon', 'Mars'},
    'Ketu': {'Sun', 'Moon', 'Mars'},
}

# House karaka planets (Ansari p.33)
HOUSE_KARAKA = {
    1: 'Sun', 2: 'Jupiter', 3: 'Mars', 4: 'Moon', 5: 'Jupiter', 6: 'Saturn',
    7: 'Venus', 8: 'Saturn', 9: 'Jupiter', 10: 'Jupiter', 11: 'Jupiter', 12: 'Saturn',
}

# Dasha lord classification by house ownership (Rule D-4/D-5/D-6, Ansari p.37-38)
AUSPICIOUS_HOUSES = {1, 5, 9}          # Trikona lords = auspicious
INAUSPICIOUS_HOUSES = {3, 6, 11}       # Lords of 3/6/11 = inauspicious even if natural benefic
NEUTRAL_HOUSES = {1, 4, 7, 10}         # Kendra lords = neutral (benefic/malefic quality cancels)

# Badhak Sthana — obstruction house per ascendant sign (Sanjay Rath, Crux of Vedic Astrology)
# Movable signs: 11th = badhak; Fixed signs: 9th = badhak; Dual signs: 7th = badhak
BADHAK_HOUSE = {
    'Aries': 11, 'Taurus': 9, 'Gemini': 7, 'Cancer': 11,
    'Leo': 9, 'Virgo': 7, 'Libra': 11, 'Scorpio': 9,
    'Sagittarius': 7, 'Capricorn': 11, 'Aquarius': 9, 'Pisces': 7,
}

# BV Raman: Gocharaphala — favorable transit houses from Moon for each planet
# Planets transiting these houses from natal Moon give good results
GOCHARA_FAVORABLE = {
    'Sun': {3, 6, 10, 11},
    'Moon': {1, 3, 6, 7, 10, 11},
    'Mars': {3, 6, 11},
    'Mercury': {2, 4, 6, 8, 10, 11},
    'Jupiter': {2, 5, 7, 9, 11},
    'Venus': {1, 2, 3, 4, 5, 8, 9, 11, 12},
    'Saturn': {3, 6, 11},
}

# Vedha (obstruction) pairs — when a planet transits a favorable house,
# another planet in the vedha house cancels the benefit (BV Raman, p.271)
VEDHA_PAIRS = {
    'Sun': {3: 9, 6: 12, 10: 4, 11: 5},
    'Moon': {1: 5, 3: 9, 6: 12, 7: 2, 10: 4, 11: 8},
    'Mars': {3: 12, 6: 9, 11: 5},
    'Mercury': {2: 5, 4: 3, 6: 9, 8: 1, 10: 7, 11: 12},
    'Jupiter': {2: 12, 5: 4, 7: 3, 9: 10, 11: 8},
    'Venus': {1: 8, 2: 7, 3: 1, 4: 10, 5: 9, 8: 5, 9: 11, 11: 6, 12: 3},
    'Saturn': {3: 12, 6: 9, 11: 5},
}

# ── Laghu Parashari: Functional Planet Classification by Lagna ────────────
# Based on Laghu Parashari (Jataka Chandrika) Slokas 43-72.
# OVERRIDES natural benefic/malefic for Vimshottari Dasha interpretation.
# Roles: yogakaraka > auspicious > auspicious_blemished > neutral > inauspicious > maraka > direly_evil
LAGHU_PARASHARI = {
    'Aries': {
        'Sun': 'auspicious',            # 5th Trikona — strongest auspicious
        'Moon': 'neutral',               # 4th Kendra
        'Mars': 'auspicious',            # 1st+8th — Lagna lord (8th mitigated by LP-017)
        'Mercury': 'inauspicious',       # 3rd+6th — double Trishadaya
        'Jupiter': 'auspicious',         # 9th+12th — 9th Trikona lord
        'Venus': 'maraka',               # 2nd+7th — deadly Kendradhipati Maraka
        'Saturn': 'inauspicious',        # 10th+11th — 11th Trishadaya dominates
    },
    'Taurus': {
        'Sun': 'neutral',                # 4th Kendra (malefic = no Kendradhipati)
        'Moon': 'inauspicious',           # 3rd Trishadaya
        'Mars': 'neutral',               # 7th+12th — malefic no Kendradhipati; weak Maraka
        'Mercury': 'auspicious',          # 2nd+5th — 5th Trikona lord
        'Jupiter': 'direly_evil',         # 8th+11th — worst combination (LP-053)
        'Venus': 'inauspicious',          # 1st+6th — 6th Trishadaya > 1st weak Trikona
        'Saturn': 'yogakaraka',           # 9th+10th — RAJAYOGAKARAKA
    },
    'Gemini': {
        'Sun': 'inauspicious',           # 3rd Trishadaya
        'Moon': 'neutral',               # 2nd — Sun/Moon exempt from severe evil
        'Mars': 'direly_evil',           # 6th+11th — double Trishadaya (LP-054)
        'Mercury': 'yogakaraka',          # 1st+4th — Lagna Trikona + Kendra
        'Jupiter': 'maraka',             # 7th+10th — Kendradhipati + Maraka
        'Venus': 'auspicious',           # 5th+12th — 5th Trikona lord
        'Saturn': 'auspicious_blemished', # 8th+9th — 9th Trikona blemished by 8th
    },
    'Cancer': {
        'Sun': 'neutral',                # 2nd — Sun exempt from Maraka evil
        'Moon': 'auspicious',             # 1st — Lagna lord (Kendra+Trikona)
        'Mars': 'yogakaraka',             # 5th+10th — celebrated RAJAYOGAKARAKA
        'Mercury': 'inauspicious',        # 3rd+12th — 3rd Trishadaya
        'Jupiter': 'auspicious_blemished', # 6th+9th — 9th Trikona blemished by 6th
        'Venus': 'inauspicious',          # 4th+11th — 11th Trishadaya + Kendradhipati
        'Saturn': 'maraka',               # 7th+8th — evil Maraka + 8th deadly
    },
    'Leo': {
        'Sun': 'auspicious',             # 1st — Lagna lord
        'Moon': 'neutral',               # 12th lord — neutral per association
        'Mars': 'yogakaraka',             # 4th+9th — Yogakaraka
        'Mercury': 'inauspicious',        # 2nd+11th — 11th Trishadaya; also Maraka
        'Jupiter': 'auspicious_blemished', # 5th+8th — 5th Trikona blemished by 8th
        'Venus': 'inauspicious',          # 3rd+10th — 3rd Trishadaya
        'Saturn': 'maraka',               # 6th+7th — Trishadaya + Maraka
    },
    'Virgo': {
        'Sun': 'neutral',                # 12th — gives results per association
        'Moon': 'inauspicious',           # 11th Trishadaya
        'Mars': 'direly_evil',            # 3rd+8th — Trishadaya + 8th evil
        'Mercury': 'yogakaraka',          # 1st+10th — Lagna Trikona + Kendra
        'Jupiter': 'maraka',             # 4th+7th — Kendradhipati + deadly Maraka
        'Venus': 'auspicious',           # 2nd+9th — 9th Trikona lord
        'Saturn': 'auspicious_blemished', # 5th+6th — 5th Trikona blemished by 6th
    },
    'Libra': {
        'Sun': 'inauspicious',           # 11th Trishadaya
        'Moon': 'neutral',               # 10th Kendra
        'Mars': 'maraka',                # 2nd+7th — Maraka (does not kill; malefic)
        'Mercury': 'auspicious',          # 9th+12th — 9th Trikona lord
        'Jupiter': 'inauspicious',        # 3rd+6th — double Trishadaya
        'Venus': 'neutral',              # 1st+8th — auspicious only in 1st/8th house
        'Saturn': 'yogakaraka',           # 4th+5th — RAJAYOGAKARAKA
    },
    'Scorpio': {
        'Sun': 'neutral',                # 10th — malefic Kendra (neutral)
        'Moon': 'auspicious',             # 9th — strongest Trikona lord
        'Mars': 'neutral',               # 1st+6th — 6th > 1st; somewhat inauspicious
        'Mercury': 'direly_evil',         # 8th+11th — worst combination
        'Jupiter': 'auspicious',          # 2nd+5th — 5th Trikona lord
        'Venus': 'maraka',               # 7th+12th — Kendradhipati + Maraka
        'Saturn': 'inauspicious',         # 3rd+4th — 3rd Trishadaya
    },
    'Sagittarius': {
        'Sun': 'auspicious',             # 9th — strongest Trikona lord
        'Moon': 'inauspicious',           # 8th lord
        'Mars': 'auspicious',             # 5th+12th — 5th Trikona lord
        'Mercury': 'maraka',              # 7th+10th — Kendradhipati + Maraka
        'Jupiter': 'yogakaraka',          # 1st+4th — Lagna Trikona + Kendra
        'Venus': 'direly_evil',           # 6th+11th — double Trishadaya
        'Saturn': 'maraka',               # 2nd+3rd — Trishadaya + Maraka
    },
    'Capricorn': {
        'Sun': 'inauspicious',           # 8th lord
        'Moon': 'maraka',                 # 7th — Kendradhipati Maraka
        'Mars': 'inauspicious',           # 4th+11th — 11th Trishadaya
        'Mercury': 'auspicious_blemished', # 6th+9th — 9th Trikona blemished by 6th
        'Jupiter': 'inauspicious',        # 3rd+12th — 3rd Trishadaya
        'Venus': 'yogakaraka',            # 5th+10th — RAJAYOGAKARAKA
        'Saturn': 'auspicious',           # 1st+2nd — Lagna lord (doesn't become Maraka)
    },
    'Aquarius': {
        'Sun': 'neutral',                # 7th — malefic 7th (no Kendradhipati)
        'Moon': 'inauspicious',           # 6th Trishadaya
        'Mars': 'inauspicious',           # 3rd+10th — 3rd Trishadaya
        'Mercury': 'auspicious_blemished', # 5th+8th — 5th Trikona blemished by 8th
        'Jupiter': 'inauspicious',        # 2nd+11th — 11th Trishadaya + Maraka
        'Venus': 'yogakaraka',            # 4th+9th — RAJAYOGAKARAKA
        'Saturn': 'auspicious',           # 1st+12th — Lagna lord
    },
    'Pisces': {
        'Sun': 'inauspicious',           # 6th Trishadaya
        'Moon': 'auspicious',             # 5th — 5th Trikona lord
        'Mars': 'auspicious',             # 2nd+9th — 9th Trikona lord
        'Mercury': 'maraka',              # 4th+7th — Kendradhipati + Maraka
        'Jupiter': 'yogakaraka',          # 1st+10th — Lagna Trikona + Kendra
        'Venus': 'direly_evil',           # 3rd+8th — Trishadaya + 8th evil
        'Saturn': 'inauspicious',         # 11th+12th — 11th Trishadaya
    },
}

# LP role ordering for comparisons (higher = more auspicious)
_LP_ROLE_ORDER = {
    'yogakaraka': 6, 'auspicious': 5, 'auspicious_blemished': 4,
    'neutral': 3, 'inauspicious': 2, 'maraka': 1, 'direly_evil': 0,
}

# Evidence hierarchy weights (Master Reasoning Framework Phase 4A)
# Based on KN Rao's Composite Approach hierarchy:
#   Dasha > D1-D9 > Double Transit > LP Functional > Yoga > D10 > Arudha > Static > Transit
# Classical sources: KN Rao "Predicting Through Jaimini's Chara Dasha" (tier ordering),
# BV Raman "Hindu Predictive Astrology" ch.20 (dasha primacy),
# Sanjay Rath "Crux of Vedic Astrology" (Arudha/Argala placement).
EVIDENCE_TIERS = {
    'dasha': 10,          # Tier 1: Dasha alignment — strongest (KN Rao: dasha is sine qua non)
    'd1_d9': 8,           # Tier 2: D-1 + D-9 confirmation (Parashara: D9 = fruit of D1)
    'double_transit': 7,  # Tier 3: Jupiter + Saturn jointly activate house (KN Rao's trigger)
    'functional': 6,      # Tier 4: Laghu Parashari functional nature (Jyotish Tattvam)
    'yoga': 5,            # Tier 5: Yoga activation in current dasha (BPHS ch.41)
    'd10': 4,             # Tier 5b: D-10 Dashamsha career confirmation (BPHS ch.7)
    'arudha': 3,          # Tier 5c: Arudha Pada image/perception (Sanjay Rath)
    'static': 3,          # Tier 6: Shadbala, dignity, placement (BPHS ch.27)
    'ashtakavarga': 2,    # Tier 6b: Ashtakavarga transit quality (BV Raman ch.25)
    'transit': 1,         # Tier 7: Transit alone — weakest (subordinate to dasha)
}

# Best Yoga combinations by Lagna (Laghu Parashari Slokas 14-22)
LP_BEST_YOGAS = {
    'Aries': [('Sun', 'Mars'), ('Sun', 'Moon'), ('Mars', 'Jupiter')],
    'Taurus': [('Saturn', 'Mercury')],
    'Gemini': [('Venus', 'Mercury')],
    'Cancer': [('Mars', 'Moon'), ('Mars', 'Jupiter')],
    'Leo': [('Mars', 'Sun'), ('Mars', 'Jupiter')],
    'Virgo': [('Mercury', 'Venus')],
    'Libra': [('Saturn', 'Mercury'), ('Moon', 'Mercury')],
    'Scorpio': [('Sun', 'Moon'), ('Jupiter', 'Moon')],
    'Sagittarius': [('Sun', 'Mercury'), ('Mars', 'Jupiter'), ('Sun', 'Jupiter')],
    'Capricorn': [('Venus', 'Mercury'), ('Venus', 'Saturn')],
    'Aquarius': [('Venus', 'Saturn')],
    'Pisces': [('Mars', 'Jupiter'), ('Jupiter', 'Moon')],
}


def _house_of(planet_rashi: str, lagna_rashi: str) -> int:
    """Get the house number of a planet given the Lagna sign."""
    try:
        li = RASHI.index(lagna_rashi)
        pi = RASHI.index(planet_rashi)
        return ((pi - li) % 12) + 1
    except ValueError:
        return 0


def _dignity(planet: str, rashi: str) -> str:
    if EXALTATION.get(planet) == rashi:
        return 'exalted'
    if DEBILITATION.get(planet) == rashi:
        return 'debilitated'
    if rashi in OWN_SIGNS.get(planet, []):
        return 'own_sign'
    lord = RASHI_LORDS.get(rashi, '')
    if lord in NATURAL_FRIENDS.get(planet, set()):
        return 'friend_sign'
    if lord in NATURAL_ENEMIES.get(planet, set()):
        return 'enemy_sign'
    return 'neutral_sign'


def _is_combust(planet: str, planets: dict) -> bool:
    """Check if planet is combust (within combustion degrees of Sun). Rule F-3."""
    if planet in ('Sun', 'Rahu', 'Ketu'):
        return False
    sun_data = planets.get('Sun', {})
    planet_data = planets.get(planet, {})
    if sun_data.get('rashi') != planet_data.get('rashi'):
        return False
    sun_deg = sun_data.get('degrees', 0)
    p_deg = planet_data.get('degrees', 0)
    threshold = COMBUSTION_DEGREES.get(planet, 15)
    return abs(sun_deg - p_deg) <= threshold


def _are_natural_enemies(p1: str, p2: str) -> bool:
    """Check if two planets are natural enemies. Rule P-5/P-6."""
    return p2 in NATURAL_ENEMIES.get(p1, set()) or p1 in NATURAL_ENEMIES.get(p2, set())


def _are_natural_friends(p1: str, p2: str) -> bool:
    """Check if two planets are natural friends."""
    return p2 in NATURAL_FRIENDS.get(p1, set()) or p1 in NATURAL_FRIENDS.get(p2, set())


def _panchada_maitri(p1: str, p2: str, verified: dict) -> str:
    """Five-fold friendship between two planets. Rule P-6, Ansari p.19.
    Returns: 'fast_friend', 'friend', 'neutral', 'enemy', 'bitter_enemy'."""
    # Natural relationship
    if p2 in NATURAL_FRIENDS.get(p1, set()):
        natural = 'friend'
    elif p2 in NATURAL_ENEMIES.get(p1, set()):
        natural = 'enemy'
    else:
        natural = 'neutral'

    # Temporal friendship: planets in 2,3,4,10,11,12 from each other = temp friends
    h1 = verified['planets'].get(p1, {}).get('house', 0)
    h2 = verified['planets'].get(p2, {}).get('house', 0)
    if h1 and h2:
        diff = ((h2 - h1) % 12)
        if diff in (1, 2, 3, 9, 10, 11):  # 2nd,3rd,4th,10th,11th,12th
            temporal = 'friend'
        else:
            temporal = 'enemy'
    else:
        temporal = 'neutral'

    # Combine (Rule P-6)
    combos = {
        ('friend', 'friend'): 'fast_friend',
        ('friend', 'enemy'): 'neutral',
        ('friend', 'neutral'): 'friend',
        ('enemy', 'enemy'): 'bitter_enemy',
        ('enemy', 'friend'): 'neutral',
        ('enemy', 'neutral'): 'enemy',
        ('neutral', 'friend'): 'friend',
        ('neutral', 'enemy'): 'enemy',
        ('neutral', 'neutral'): 'neutral',
    }
    return combos.get((natural, temporal), 'neutral')


def _dispositor_of(planet: str, verified: dict) -> str:
    """Get the dispositor (sign lord) of a planet."""
    rashi = verified['planets'].get(planet, {}).get('rashi', '')
    return RASHI_LORDS.get(rashi, '')


def _effective_houses(planet: str, house_lords: dict, verified: dict) -> list[int]:
    """Get houses a planet activates: its own + dispositor's for Rahu/Ketu.

    Rahu/Ketu don't own houses in LP, but act through their dispositor
    (sign lord where they sit). This proxy enables domain activation checks.
    """
    houses = [h for h, l in house_lords.items() if l == planet]
    if planet in ('Rahu', 'Ketu') and not houses:
        disp = _dispositor_of(planet, verified)
        if disp:
            houses = [h for h, l in house_lords.items() if l == disp]
    return houses


def _dispositor_chain(planet: str, verified: dict, max_depth: int = 5) -> list[str]:
    """Trace the dispositor chain: Planet → Dispositor → Final Dispositor.
    Rules DISP-1 through DISP-9, Ansari pp.119-137."""
    chain = [planet]
    current = planet
    for _ in range(max_depth):
        disp = _dispositor_of(current, verified)
        if not disp or disp in chain:
            break
        chain.append(disp)
        # Final dispositor = planet in its own sign
        disp_rashi = verified['planets'].get(disp, {}).get('rashi', '')
        if disp_rashi in OWN_SIGNS.get(disp, []):
            break
        current = disp
    return chain


def _house_distance(from_house: int, to_house: int) -> int:
    """Vedic house distance (1-indexed, inclusive). Same house = 1, next = 2, ..., 12th from = 12."""
    if from_house == 0 or to_house == 0:
        return 0
    return ((to_house - from_house) % 12) + 1


def _argala_analysis(house: int, verified: dict) -> dict:
    """Analyze argala (planetary intervention) on a house.
    Sanjay Rath — Crux of Vedic Astrology, Chapter on Argala.
    Returns dict with 'subhargala' (benefic) and 'papargala' (malefic) influences."""
    houses = verified['houses']
    # Argala positions and their obstructions
    argala_map = {
        2: 12,   # 2nd house argala, 12th obstructs
        4: 10,   # 4th house argala, 10th obstructs
        11: 3,   # 11th house argala, 3rd obstructs
        5: 9,    # 5th house (secondary), 9th obstructs
    }

    subhargala = []
    papargala = []
    for offset, obstruction_offset in argala_map.items():
        argala_house = ((house - 1 + offset) % 12) + 1
        obstruction_house = ((house - 1 + obstruction_offset) % 12) + 1

        argala_planets = houses.get(argala_house, [])
        obstruction_planets = houses.get(obstruction_house, [])

        # If obstruction has more planets, argala is cancelled
        if len(obstruction_planets) >= len(argala_planets) and obstruction_planets:
            continue

        for p in argala_planets:
            # Exception: malefics in 3rd from karya = subhargala (Sanjay Rath)
            if offset == 11 and p in NATURAL_MALEFICS:  # 11th = 3rd check handled by offset
                subhargala.append((p, argala_house, offset))
            elif p in NATURAL_BENEFICS:
                subhargala.append((p, argala_house, offset))
            elif p in NATURAL_MALEFICS:
                papargala.append((p, argala_house, offset))

    return {'subhargala': subhargala, 'papargala': papargala}


def _gochara_score(planet: str, house_from_moon: int) -> str:
    """Score a planet's transit from Moon sign using BV Raman's Gocharaphala.
    Returns 'favorable', 'unfavorable', or 'neutral'."""
    favorable = GOCHARA_FAVORABLE.get(planet, set())
    if house_from_moon in favorable:
        return 'favorable'
    elif house_from_moon > 0:
        return 'unfavorable'
    return 'neutral'


def _functional_role(planet: str, lagna: str, verified: dict = None) -> str:
    """Get Laghu Parashari functional role for a planet given the Lagna.
    For Rahu/Ketu, dynamically determines role from house occupation and conjunction (LP-023)."""
    if planet in ('Rahu', 'Ketu'):
        if not verified:
            return 'neutral'
        pdata = verified['planets'].get(planet, {})
        house = pdata.get('house', 0)
        if house in TRIKONA:
            base_role = 'auspicious'
        elif house in KENDRA:
            base_role = 'neutral'
        elif house == 8:
            base_role = 'direly_evil'
        elif house in DUSTHANA:
            base_role = 'inauspicious'
        elif house in MARAKA:
            base_role = 'maraka'
        else:
            base_role = 'neutral'
        # Adopt strongest conjunct's role (LP-023)
        conjuncts = [p for p in verified['houses'].get(house, []) if p != planet]
        if conjuncts:
            best_role = base_role
            for c in conjuncts:
                c_role = LAGHU_PARASHARI.get(lagna, {}).get(c, 'neutral')
                if _LP_ROLE_ORDER.get(c_role, 3) > _LP_ROLE_ORDER.get(best_role, 3):
                    best_role = c_role
            return best_role
        return base_role
    return LAGHU_PARASHARI.get(lagna, {}).get(planet, 'neutral')


def _lp_quality_label(role: str) -> str:
    """Convert LP functional role to a human-readable dasha quality label."""
    return {
        'yogakaraka': 'excellent (Yogakaraka)',
        'auspicious': 'very favorable (Trikona lord)',
        'auspicious_blemished': 'favorable with caveats (blemished Trikona)',
        'neutral': 'neutral',
        'inauspicious': 'challenging (Trishadaya lord)',
        'maraka': 'dangerous (Maraka)',
        'direly_evil': 'severely adverse (direly evil)',
    }.get(role, 'neutral')


# ── Stage 2B: Laghu Parashari Functional Classification ──────────────────
def stage2b_functional(verified: dict) -> dict:
    """Classify all planets by Laghu Parashari functional nature.
    This is the foundation of Vimshottari Dasha interpretation — overrides natural benefic/malefic."""
    lagna = verified['lagna']
    classifications = {}
    findings = []

    for planet in verified['planets']:
        role = _functional_role(planet, lagna, verified)
        classifications[planet] = role
        verified['planets'][planet]['functional_role'] = role

    yogakaraka = YOGAKARAKA.get(lagna)
    if yogakaraka:
        yk_data = verified['planets'].get(yogakaraka, {})
        findings.append({
            'factor': f'Yogakaraka for {lagna}: {yogakaraka} (house {yk_data.get("house", "?")})',
            'implication': f'{yogakaraka} owns both Kendra and Trikona — most auspicious planet. '
                          f'Its dasha gives best results. Rajayoga manifests in its period (LP-022).',
            'confidence': 0.95,
        })

    # Detect LP best yoga combinations that are actually connected
    best_yogas = LP_BEST_YOGAS.get(lagna, [])
    for p1, p2 in best_yogas:
        p1_data = verified['planets'].get(p1, {})
        p2_data = verified['planets'].get(p2, {})
        p1_house = p1_data.get('house', 0)
        p2_house = p2_data.get('house', 0)
        if not p1_house or not p2_house:
            continue
        connection = None
        # Conjunction
        if p1_house == p2_house:
            connection = 'conjunction'
        else:
            # Exchange (parivartana) — STRONGEST (LP-024)
            p1_rashi = p1_data.get('rashi', '')
            p2_rashi = p2_data.get('rashi', '')
            if RASHI_LORDS.get(p1_rashi) == p2 and RASHI_LORDS.get(p2_rashi) == p1:
                connection = 'exchange (parivartana — strongest)'
            else:
                # Mutual aspect
                for h_off in GRAHA_DRISHTI.get(p1, [7]):
                    if ((p1_house - 1 + h_off) % 12) + 1 == p2_house:
                        connection = 'aspect'
                        break
                if not connection:
                    for h_off in GRAHA_DRISHTI.get(p2, [7]):
                        if ((p2_house - 1 + h_off) % 12) + 1 == p1_house:
                            connection = 'aspect'
                            break
        if connection:
            findings.append({
                'factor': f'LP Rajayoga: {p1} + {p2} connected by {connection}',
                'implication': f'Best Rajayoga combination for {lagna} Lagna (Laghu Parashari). '
                              f'Results manifest in dasha/bhukti of these planets.',
                'confidence': 0.9,
            })

    # Flag direly evil and maraka planets
    for planet, role in classifications.items():
        if role == 'direly_evil':
            findings.append({
                'factor': f'{planet} is DIRELY EVIL for {lagna} Lagna (LP)',
                'implication': f'{planet}\'s dasha brings severe difficulties. Houses it owns suffer.',
                'confidence': 0.85,
            })
        elif role == 'maraka':
            findings.append({
                'factor': f'{planet} is Maraka for {lagna} Lagna (LP)',
                'implication': f'{planet}\'s dasha can cause health crises at longevity boundaries. '
                              f'Within lifespan, diseases and troubles (LP-031).',
                'confidence': 0.8,
            })

    # LP Dasha-Bhukti quality matrix insight (LP-039)
    md = None
    today = datetime.date.today().isoformat()
    for d in verified.get('_vimshottari', []):
        if d.get('level') == 'maha' and d.get('start_date', '') <= today <= d.get('end_date', ''):
            md = d
            break
    if md:
        md_lord = md.get('lord', '')
        md_role = classifications.get(md_lord, 'neutral')
        if md_role in ('inauspicious', 'direly_evil'):
            findings.append({
                'factor': f'LP WARNING: Current Mahadasha lord {md_lord} is {md_role}',
                'implication': f'In inauspicious dasha, even Yogakaraka bhukti gives WORSE results '
                              f'than related auspicious bhukti (LP-047 counterintuitive rule). '
                              f'Unrelated Yogakaraka bhukti = extremely inauspicious.',
                'confidence': 0.85,
            })

    return {
        'classifications': classifications,
        'yogakaraka': yogakaraka,
        'findings': findings,
    }


# ── Stage 1: Chart Verification ─────────────────────────────────────────────
def stage1_verify(chart: dict) -> dict:
    """Verify chart data quality and extract basic structure."""
    rasi = chart.get('rasi', [])
    lagna = None
    planets = {}

    for p in rasi:
        name = p.get('body', '')
        rashi = p.get('rashi', '')
        if name == 'Lagna':
            lagna = rashi
        else:
            planets[name] = {
                'rashi': rashi,
                'degrees': p.get('degrees', 0),
                'nakshatra': p.get('nakshatra'),
                'pada': p.get('pada'),
                'retro': p.get('retro', False),
            }

    if not lagna:
        return {'error': 'No Lagna found in chart', 'confidence': 0}

    # Build house-to-planets mapping
    houses = {i: [] for i in range(1, 13)}
    for name, data in planets.items():
        h = _house_of(data['rashi'], lagna)
        if h:
            houses[h].append(name)
            data['house'] = h
            data['dignity'] = _dignity(name, data['rashi'])
            # Marana Karaka Sthana check
            if h == MARANA_KARAKA_STHANA.get(name, 0):
                data['mks'] = True

    # House lords
    house_lords = {}
    for i in range(12):
        sign = RASHI[(RASHI.index(lagna) + i) % 12]
        lord = RASHI_LORDS.get(sign, '?')
        house_lords[i + 1] = lord

    return {
        'lagna': lagna,
        'planets': planets,
        'houses': houses,
        'house_lords': house_lords,
        'birth_date': chart.get('birth_date', ''),
        'birth_time': chart.get('birth_time', ''),
        'place_name': chart.get('place_name', ''),
        'confidence': 1.0,
    }


# ── Stage 2: Static Strength Assessment ─────────────────────────────────────
def stage2_strength(chart: dict, verified: dict) -> dict:
    """Assess planet and house strengths."""
    shadbala = chart.get('shadbala', {})
    bhava_bala = chart.get('bhava_bala', [])
    planets = verified['planets']
    findings = []

    # Planet strength assessment
    strong_planets = []
    weak_planets = []
    for name, data in planets.items():
        sb = shadbala.get(name, {})
        total = sb.get('Total', 0) if isinstance(sb, dict) else 0
        dignity = data.get('dignity', 'placed')

        strength = 'moderate'
        if dignity == 'exalted' or total > 1.5:
            strength = 'strong'
            strong_planets.append(name)
        elif dignity == 'debilitated' or total < 0.7:
            strength = 'weak'
            weak_planets.append(name)
        elif dignity == 'own_sign' or total > 1.0:
            strength = 'strong'
            strong_planets.append(name)

        # Combustion check (Rule F-3)
        if _is_combust(name, planets):
            if strength == 'strong':
                strength = 'moderate'
            else:
                strength = 'weak'
            data['combust'] = True
            findings.append({
                'factor': f'{name} is combust (too close to Sun)',
                'implication': f'{name}\'s significations are burned — reduced effectiveness. '
                              f'Combust planets "become evil" (Ansari p.8).',
                'confidence': 0.8,
            })

        # Marana Karaka Sthana — planet in its death house (classical)
        if data.get('mks'):
            if strength == 'strong':
                strength = 'moderate'
            else:
                strength = 'weak'
                if name not in weak_planets:
                    weak_planets.append(name)
            findings.append({
                'factor': f'{name} in Marana Karaka Sthana (house {data["house"]})',
                'implication': f'{name} loses vitality in this house — significations suffer. '
                              f'Classical: planet behaves as if dead in its MKS position.',
                'confidence': 0.8,
            })

        # Retrograde = powerful (Rule D-1.4)
        if data.get('retro') and name not in ('Sun', 'Moon', 'Rahu', 'Ketu'):
            if strength == 'weak':
                strength = 'moderate'
            data['retrograde_strength'] = True
            findings.append({
                'factor': f'{name} is retrograde — adds strength',
                'implication': f'Retrograde {name} gains power and persistence. Internalized energy.',
                'confidence': 0.7,
            })

        data['strength'] = strength
        data['shadbala_total'] = total

    # Lagna lord strength
    lagna_lord = verified['house_lords'][1]
    ll_strength = planets.get(lagna_lord, {}).get('strength', 'unknown')

    if ll_strength == 'strong':
        findings.append({
            'factor': f'Lagna lord {lagna_lord} is strong',
            'implication': 'Good overall health, strong personality, ability to overcome obstacles',
            'confidence': 0.85,
        })
    elif ll_strength == 'weak':
        findings.append({
            'factor': f'Lagna lord {lagna_lord} is weak',
            'implication': 'Health challenges possible, need conscious effort to assert self',
            'confidence': 0.8,
        })

    # Moon condition (mental state)
    moon = planets.get('Moon', {})
    moon_house = moon.get('house', 0)
    if moon.get('strength') == 'strong':
        findings.append({
            'factor': 'Moon is strong',
            'implication': 'Stable mind, emotional resilience, good memory',
            'confidence': 0.85,
        })
    elif moon.get('strength') == 'weak':
        findings.append({
            'factor': 'Moon is weak or afflicted',
            'implication': 'Emotional sensitivity, possible anxiety or mood fluctuations',
            'confidence': 0.8,
        })

    # House strength from Bhava Bala
    strong_houses = []
    weak_houses = []
    if bhava_bala:
        for i, val in enumerate(bhava_bala[:12]):
            if isinstance(val, (int, float)):
                if val > 10:
                    strong_houses.append(i + 1)
                elif val < 5:
                    weak_houses.append(i + 1)

    return {
        'strong_planets': strong_planets,
        'weak_planets': weak_planets,
        'strong_houses': strong_houses,
        'weak_houses': weak_houses,
        'findings': findings,
    }


# ── Stage 3: Navamsha Cross-Check ───────────────────────────────────────────
def stage3_navamsha(chart: dict, verified: dict) -> dict:
    """Cross-check D-1 promises with D-9 confirmation."""
    navamsa = chart.get('navamsa', [])
    if not navamsa:
        d9 = chart.get('divisional', {}).get('D-9', [])
        navamsa = d9 if d9 else []

    findings = []
    vargottama = []

    nav_positions = {}
    for p in navamsa:
        body = p.get('body', p.get('name', ''))
        rashi = p.get('rashi', '')
        if body and rashi:
            nav_positions[body] = rashi

    # Check vargottama and D-1/D-9 confirmation (prediction hierarchy rules)
    d1_d9_confirmation = {}  # planet -> 'confirmed'|'mixed'|'negated'
    for name, data in verified['planets'].items():
        d1_rashi = data.get('rashi', '')
        d9_rashi = nav_positions.get(name, '')
        if not d1_rashi or not d9_rashi:
            continue
        d1_dig = data.get('dignity', 'placed')
        d9_dig = _dignity(name, d9_rashi)

        # Vargottama check
        if d1_rashi == d9_rashi:
            vargottama.append(name)
            # Neecha Vargottama = VERY BAD (debilitated in both)
            if d1_dig == 'debilitated':
                findings.append({
                    'factor': f'{name} is Neecha Vargottama (debilitated in D-1 AND D-9)',
                    'implication': f'{name}\'s results are consistently poor — this is VERY negative, not positive',
                    'confidence': 0.9,
                })
                d1_d9_confirmation[name] = 'negated'
            elif d1_dig == 'exalted':
                findings.append({
                    'factor': f'{name} is Vargottama in exaltation — extremely powerful',
                    'implication': f'{name}\'s results are excellent and reliable throughout life',
                    'confidence': 0.95,
                })
                d1_d9_confirmation[name] = 'confirmed'
            else:
                findings.append({
                    'factor': f'{name} is Vargottama (same sign in D-1 and D-9)',
                    'implication': f'{name}\'s results are confirmed and reliable throughout life',
                    'confidence': 0.9,
                })
                d1_d9_confirmation[name] = 'confirmed'
        else:
            # D-1/D-9 cross-check: exalted D-1 but debilitated D-9 = fails to deliver
            if d1_dig == 'exalted' and d9_dig == 'debilitated':
                findings.append({
                    'factor': f'{name} exalted in D-1 but debilitated in D-9',
                    'implication': f'{name} promises much but FAILS to deliver fully — external success with internal dissatisfaction',
                    'confidence': 0.85,
                })
                d1_d9_confirmation[name] = 'mixed'
            elif d1_dig == 'debilitated' and d9_dig == 'exalted':
                findings.append({
                    'factor': f'{name} debilitated in D-1 but exalted in D-9',
                    'implication': f'{name} appears weak but delivers above expectations — delayed but deep success',
                    'confidence': 0.8,
                })
                d1_d9_confirmation[name] = 'mixed'
            elif d1_dig in ('exalted', 'own_sign') and d9_dig in ('exalted', 'own_sign'):
                d1_d9_confirmation[name] = 'confirmed'
            elif d1_dig == 'debilitated' and d9_dig == 'debilitated':
                d1_d9_confirmation[name] = 'negated'

    # Check D-9 7th house for marriage
    d9_lagna = nav_positions.get('Lagna', '')
    d9_7th_assessment = None
    if d9_lagna:
        seventh_sign = RASHI[(RASHI.index(d9_lagna) + 6) % 12] if d9_lagna in RASHI else ''
        benefics_in_7th = []
        malefics_in_7th = []
        for name, rashi in nav_positions.items():
            if name == 'Lagna':
                continue
            if rashi == seventh_sign:
                if name in NATURAL_BENEFICS:
                    benefics_in_7th.append(name)
                elif name in NATURAL_MALEFICS:
                    malefics_in_7th.append(name)
        if benefics_in_7th:
            findings.append({
                'factor': f'Benefics in 7th house of D-9: {", ".join(benefics_in_7th)}',
                'implication': 'Good marriage potential, harmonious married life',
                'confidence': 0.75,
            })
            d9_7th_assessment = 'favorable'
        if malefics_in_7th:
            findings.append({
                'factor': f'Malefics in 7th house of D-9: {", ".join(malefics_in_7th)}',
                'implication': 'Challenges in marriage — delays, friction, or need for patience',
                'confidence': 0.7,
            })
            d9_7th_assessment = 'challenged' if not benefics_in_7th else 'mixed'

        # D-9 Lagna lord placement for marriage timing
        d9_lagna_lord = RASHI_LORDS.get(d9_lagna, '')
        d9_ll_rashi = nav_positions.get(d9_lagna_lord, '')
        if d9_ll_rashi and d9_lagna:
            d9_ll_house = _house_of(d9_ll_rashi, d9_lagna)
            if d9_ll_house in KENDRA:
                findings.append({
                    'factor': f'D-9 Lagna lord {d9_lagna_lord} in Kendra (house {d9_ll_house})',
                    'implication': 'Indicates early marriage potential',
                    'confidence': 0.7,
                })
            elif d9_ll_house in DUSTHANA:
                findings.append({
                    'factor': f'D-9 Lagna lord {d9_lagna_lord} in Dusthana (house {d9_ll_house})',
                    'implication': 'Marriage may be delayed beyond 30, or requires extra effort',
                    'confidence': 0.7,
                })

    # D-9 career 10th lord check
    career_d9 = None
    if d9_lagna and d9_lagna in RASHI:
        d9_10th_sign = RASHI[(RASHI.index(d9_lagna) + 9) % 12]
        d9_10th_lord = RASHI_LORDS.get(d9_10th_sign, '')
        d9_10th_rashi = nav_positions.get(d9_10th_lord, '')
        if d9_10th_rashi and d9_10th_lord:
            d9_10th_house = _house_of(d9_10th_rashi, d9_lagna)
            d9_10th_dig = _dignity(d9_10th_lord, d9_10th_rashi)
            if d9_10th_house in KENDRA or d9_10th_house in TRIKONA or d9_10th_dig in ('exalted', 'own_sign'):
                career_d9 = 'confirmed'
                findings.append({
                    'factor': f'D-9: 10th lord {d9_10th_lord} well-placed (house {d9_10th_house}, {d9_10th_dig})',
                    'implication': 'Career promise confirmed in Navamsha — career success is reliable.',
                    'confidence': 0.75,
                })
            elif d9_10th_house in DUSTHANA or d9_10th_dig == 'debilitated':
                career_d9 = 'negated'
                findings.append({
                    'factor': f'D-9: 10th lord {d9_10th_lord} afflicted (house {d9_10th_house}, {d9_10th_dig})',
                    'implication': 'Career promise weakened in Navamsha — career may face hidden obstacles.',
                    'confidence': 0.7,
                })

    return {
        'vargottama_planets': vargottama,
        'd9_positions': nav_positions,
        'd1_d9_confirmation': d1_d9_confirmation,
        'd9_7th_assessment': d9_7th_assessment,
        'career_d9': career_d9,
        'findings': findings,
    }


# ── Stage 3B: Comprehensive Yoga Detection (Phase 2D) ────────────────────────
# Exalt-sign lords for Neechabhanga lookup
_NEECHA_EXALT_LORD = {
    'Sun': 'Mars',       # Sun debil Libra, exalts Aries -> Mars
    'Moon': 'Venus',     # Moon debil Scorpio, exalts Taurus -> Venus
    'Mars': 'Saturn',    # Mars debil Cancer, exalts Capricorn -> Saturn
    'Mercury': 'Mercury',# Mercury debil Pisces, exalts Virgo -> Mercury
    'Jupiter': 'Moon',   # Jupiter debil Capricorn, exalts Cancer -> Moon
    'Venus': 'Jupiter',  # Venus debil Virgo, exalts Pisces -> Jupiter
    'Saturn': 'Venus',   # Saturn debil Aries, exalts Libra -> Venus
}

_MOVABLE_SIGNS = {'Aries', 'Cancer', 'Libra', 'Capricorn'}
_FIXED_SIGNS = {'Taurus', 'Leo', 'Scorpio', 'Aquarius'}
_DUAL_SIGNS = {'Gemini', 'Virgo', 'Sagittarius', 'Pisces'}


def stage3b_yogas(verified: dict) -> dict:
    """Detect yogas from chart data — Pancha Mahapurusha, Raja, Dhana,
    Moon-based, Gajakesari, Budhaditya, Viparita, Neechabhanga, Nabhasa."""
    planets = verified['planets']
    houses = verified['houses']
    house_lords = verified['house_lords']
    lagna = verified['lagna']
    yogas = []
    findings = []

    def _house_from(base_sign, target_sign):
        """House of target_sign counted from base_sign."""
        try:
            return (RASHI.index(target_sign) - RASHI.index(base_sign)) % 12 + 1
        except (ValueError, IndexError):
            return 0

    # Helper: get planet house
    def _ph(name):
        return planets.get(name, {}).get('house', 0)

    # Helper: get planet sign
    def _ps(name):
        return planets.get(name, {}).get('rashi', '')

    # ── 1. Pancha Mahapurusha Yogas ──
    pmp = {
        'Mars':    {'signs': {'Aries', 'Scorpio', 'Capricorn'}, 'name': 'Ruchaka'},
        'Mercury': {'signs': {'Gemini', 'Virgo'}, 'name': 'Bhadra'},
        'Jupiter': {'signs': {'Sagittarius', 'Pisces', 'Cancer'}, 'name': 'Hamsa'},
        'Venus':   {'signs': {'Taurus', 'Libra', 'Pisces'}, 'name': 'Malavya'},
        'Saturn':  {'signs': {'Capricorn', 'Aquarius', 'Libra'}, 'name': 'Sasa'},
    }
    for planet, info in pmp.items():
        pdata = planets.get(planet, {})
        if pdata.get('rashi') in info['signs'] and pdata.get('house') in KENDRA:
            # Check not combust or debilitated (cancellation)
            if not pdata.get('combust'):
                yogas.append({
                    'yoga': info['name'],
                    'type': 'pancha_mahapurusha',
                    'planet': planet,
                    'strength': 'full',
                })
                findings.append({
                    'factor': f"{info['name']} Yoga — {planet} in own/exalted sign in Kendra",
                    'implication': f'Powerful personality yoga. {planet} gives its highest results. '
                                  f'Manifests during {planet} dasha.',
                    'confidence': 0.85,
                })

    # ── 2. Raja Yogas ──
    # 2A: Kendra-Trikona lord connection
    for k in KENDRA:
        k_lord = house_lords.get(k, '')
        for t in TRIKONA:
            t_lord = house_lords.get(t, '')
            if not k_lord or not t_lord or k_lord == t_lord:
                continue
            # Check conjunction (same house)
            k_h = _ph(k_lord)
            t_h = _ph(t_lord)
            connected = False
            conn_type = ''
            if k_h and t_h and k_h == t_h:
                connected = True
                conn_type = 'conjunction'
            # Check mutual aspect (7th from each other)
            elif k_h and t_h and abs(k_h - t_h) in (6,):
                # 7th house aspect (house diff of 6 = opposite)
                connected = True
                conn_type = 'mutual_aspect'
            # Check sign exchange (parivartana)
            elif _ps(k_lord) and _ps(t_lord):
                if RASHI_LORDS.get(_ps(k_lord)) == t_lord and RASHI_LORDS.get(_ps(t_lord)) == k_lord:
                    connected = True
                    conn_type = 'exchange'
            if connected:
                name = 'Raja Yoga'
                if {k, t} == {9, 10}:
                    name = 'Dharma-Karmadhipati Yoga'
                elif 1 in {k, t}:
                    name = f'Raja Yoga (Lagna + {max(k,t)}th lord)'
                yogas.append({
                    'yoga': name,
                    'type': 'raja_yoga',
                    'planets': [k_lord, t_lord],
                    'houses': [k, t],
                    'connection': conn_type,
                    'strength': 'strong' if {k, t} == {9, 10} else 'moderate',
                })
                findings.append({
                    'factor': f'{name}: {k_lord} (H{k}) + {t_lord} (H{t}) by {conn_type}',
                    'implication': f'Kendra-Trikona lord union — rise in life during '
                                  f'{k_lord} or {t_lord} dasha.',
                    'confidence': 0.8,
                })

    # 2B: Single-planet Yogakaraka raja yoga
    yk = YOGAKARAKA.get(lagna)
    if yk and yk in planets:
        yk_h = _ph(yk)
        if yk_h in KENDRA or yk_h in TRIKONA:
            yogas.append({
                'yoga': f'Yogakaraka Raja Yoga ({yk})',
                'type': 'raja_yoga',
                'planets': [yk],
                'strength': 'strong',
            })

    # ── 3. Dhana Yogas ──
    # 3A: 2nd lord + 11th lord connection
    lord_2 = house_lords.get(2, '')
    lord_11 = house_lords.get(11, '')
    if lord_2 and lord_11 and _ph(lord_2) == _ph(lord_11) and _ph(lord_2) > 0:
        yogas.append({
            'yoga': 'Dhana Yoga (2nd + 11th lords conjunct)',
            'type': 'dhana_yoga',
            'planets': [lord_2, lord_11],
        })
    # 3B: 5th lord + 9th lord in kendra
    lord_5 = house_lords.get(5, '')
    lord_9 = house_lords.get(9, '')
    if lord_5 and lord_9:
        if _ph(lord_5) in KENDRA and _ph(lord_9) in KENDRA:
            yogas.append({
                'yoga': 'Dhana Yoga (5th + 9th lords in Kendra)',
                'type': 'dhana_yoga',
                'planets': [lord_5, lord_9],
            })
    # 3C: Chandramangala Yoga
    if _ph('Moon') and _ph('Mars') and _ph('Moon') == _ph('Mars'):
        yogas.append({
            'yoga': 'Chandramangala Yoga',
            'type': 'dhana_yoga',
            'planets': ['Moon', 'Mars'],
        })

    # ── 4. Moon-based Yogas ──
    moon_sign = _ps('Moon')
    moon_h = _ph('Moon')
    checkers = {'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn'}
    if moon_sign:
        in_2nd_from_moon = set()
        in_12th_from_moon = set()
        for p in checkers:
            p_sign = _ps(p)
            if p_sign:
                h_from_moon = _house_from(moon_sign, p_sign)
                if h_from_moon == 2:
                    in_2nd_from_moon.add(p)
                elif h_from_moon == 12:
                    in_12th_from_moon.add(p)

        if in_2nd_from_moon and in_12th_from_moon:
            yogas.append({
                'yoga': 'Durudhura Yoga',
                'type': 'moon_yoga',
                'planets': list(in_2nd_from_moon | in_12th_from_moon),
            })
            findings.append({
                'factor': 'Durudhura Yoga — Moon flanked on both sides',
                'implication': 'Wealth, vehicles, generous, happy. Superior to Sunapha/Anapha alone.',
                'confidence': 0.8,
            })
        elif in_2nd_from_moon:
            yogas.append({
                'yoga': 'Sunapha Yoga',
                'type': 'moon_yoga',
                'planets': list(in_2nd_from_moon),
            })
            findings.append({
                'factor': f'Sunapha Yoga — {", ".join(in_2nd_from_moon)} in 2nd from Moon',
                'implication': 'Wealthy, self-made, intelligent, famous.',
                'confidence': 0.75,
            })
        elif in_12th_from_moon:
            yogas.append({
                'yoga': 'Anapha Yoga',
                'type': 'moon_yoga',
                'planets': list(in_12th_from_moon),
            })
            findings.append({
                'factor': f'Anapha Yoga — {", ".join(in_12th_from_moon)} in 12th from Moon',
                'implication': 'Powerful, healthy, virtuous, well-dressed.',
                'confidence': 0.75,
            })
        else:
            # Check Kemadruma
            moon_conjuncts = [p for p in checkers if _ph(p) == moon_h] if moon_h else []
            if not in_2nd_from_moon and not in_12th_from_moon and not moon_conjuncts:
                # Check cancellation
                cancelled = False
                if moon_h in KENDRA:
                    cancelled = True
                jup_sign = _ps('Jupiter')
                if jup_sign and moon_sign:
                    jup_from_moon = _house_from(moon_sign, jup_sign)
                    if jup_from_moon in (1, 4, 7, 10):  # Jupiter aspects Moon
                        cancelled = True
                # Any planet in kendra from lagna
                for kh in KENDRA:
                    if houses.get(kh):
                        cancelled = True
                        break
                if not cancelled:
                    yogas.append({
                        'yoga': 'Kemadruma Yoga',
                        'type': 'moon_yoga',
                        'outcome': 'negative',
                    })
                    findings.append({
                        'factor': 'Kemadruma Yoga — Moon isolated',
                        'implication': 'Financial struggles, loneliness. But cancellation can mitigate.',
                        'confidence': 0.7,
                    })

    # ── 5. Gajakesari Yoga ──
    jup_sign = _ps('Jupiter')
    if jup_sign and moon_sign:
        jup_from_moon = _house_from(moon_sign, jup_sign)
        if jup_from_moon in (1, 4, 7, 10):
            jdata = planets.get('Jupiter', {})
            if jdata.get('dignity') != 'debilitated' and not jdata.get('combust'):
                yogas.append({
                    'yoga': 'Gajakesari Yoga',
                    'type': 'gajakesari',
                    'planets': ['Jupiter', 'Moon'],
                    'strength': 'full' if _ph('Jupiter') in KENDRA else 'partial',
                })
                findings.append({
                    'factor': 'Gajakesari Yoga — Jupiter in Kendra from Moon',
                    'implication': 'Fame, leadership, financial stability. Fructifies in Jupiter dasha.',
                    'confidence': 0.8,
                })

    # ── 6. Budhaditya Yoga ──
    if _ph('Sun') and _ph('Mercury') and _ph('Sun') == _ph('Mercury'):
        merc = planets.get('Mercury', {})
        if not merc.get('combust'):  # Mercury not fully combust
            yogas.append({
                'yoga': 'Budhaditya Yoga',
                'type': 'budhaditya',
                'planets': ['Sun', 'Mercury'],
            })
            findings.append({
                'factor': 'Budhaditya Yoga — Sun + Mercury conjunction',
                'implication': 'Intelligence, communication skills, scholarly. Strongest for Leo/Virgo/Aries.',
                'confidence': 0.7,
            })

    # ── 7. Viparita Raja Yoga ──
    lord_6 = house_lords.get(6, '')
    lord_8 = house_lords.get(8, '')
    lord_12 = house_lords.get(12, '')
    viparita_count = 0
    # Harsha: 6th lord in 8th or 12th
    if lord_6 and _ph(lord_6) in (8, 12):
        viparita_count += 1
        yogas.append({'yoga': 'Harsha Yoga (Viparita)', 'type': 'viparita_raja',
                      'planets': [lord_6], 'house': _ph(lord_6)})
    # Sarala: 8th lord in 6th or 12th
    if lord_8 and _ph(lord_8) in (6, 12):
        viparita_count += 1
        yogas.append({'yoga': 'Sarala Yoga (Viparita)', 'type': 'viparita_raja',
                      'planets': [lord_8], 'house': _ph(lord_8)})
    # Vimala: 12th lord in 6th or 8th
    if lord_12 and _ph(lord_12) in (6, 8):
        viparita_count += 1
        yogas.append({'yoga': 'Vimala Yoga (Viparita)', 'type': 'viparita_raja',
                      'planets': [lord_12], 'house': _ph(lord_12)})
    if viparita_count:
        findings.append({
            'factor': f'{viparita_count} Viparita Raja Yoga(s) detected',
            'implication': 'Rise through adversity. Dusthana lords in dusthanas = turning negatives '
                          'into strengths. Caution: benefics conjoining these lords may suffer.',
            'confidence': 0.7,
        })

    # ── 8. Neecha Bhanga Raja Yoga ──
    for name, data in planets.items():
        if name in ('Rahu', 'Ketu'):
            continue
        if data.get('dignity') == 'debilitated':
            cancelled = False
            reason = ''
            # (a) Dispositor in kendra from lagna
            dispositor = RASHI_LORDS.get(data.get('rashi', ''), '')
            if dispositor and _ph(dispositor) in KENDRA:
                cancelled = True
                reason = f'dispositor {dispositor} in Kendra'
            # (b) Exalt-sign lord in kendra from lagna
            exalt_lord = _NEECHA_EXALT_LORD.get(name, '')
            if not cancelled and exalt_lord and _ph(exalt_lord) in KENDRA:
                cancelled = True
                reason = f'exaltation-sign lord {exalt_lord} in Kendra'
            # (c) Debilitated planet itself in kendra
            if not cancelled and data.get('house') in KENDRA:
                cancelled = True
                reason = f'{name} itself in Kendra'
            if cancelled:
                yogas.append({
                    'yoga': f'Neecha Bhanga Raja Yoga ({name})',
                    'type': 'neechabhanga',
                    'planets': [name],
                    'reason': reason,
                })
                findings.append({
                    'factor': f'Neecha Bhanga: {name} debilitated but cancelled ({reason})',
                    'implication': f'{name} rises from degradation to power during its dasha. '
                                  f'Classic "rags to riches" yoga.',
                    'confidence': 0.75,
                })

    # ── 9. Sankhya Nabhasa Yogas (occupied sign count) ──
    classical = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn']
    occupied_signs = set()
    for p in classical:
        s = _ps(p)
        if s:
            occupied_signs.add(s)
    n_signs = len(occupied_signs)
    sankhya_names = {1: 'Gola', 2: 'Yuga', 3: 'Soola', 4: 'Kedara',
                     5: 'Pasa', 6: 'Damani', 7: 'Vallaki'}
    if n_signs in sankhya_names:
        yogas.append({
            'yoga': f'{sankhya_names[n_signs]} Yoga (Nabhasa)',
            'type': 'nabhasa_sankhya',
            'sign_count': n_signs,
        })

    # Asraya Yogas
    all_signs = {_ps(p) for p in classical if _ps(p)}
    if all_signs and all_signs <= _MOVABLE_SIGNS:
        yogas.append({'yoga': 'Rajju Yoga (Nabhasa)', 'type': 'nabhasa_asraya'})
    elif all_signs and all_signs <= _FIXED_SIGNS:
        yogas.append({'yoga': 'Musala Yoga (Nabhasa)', 'type': 'nabhasa_asraya'})
    elif all_signs and all_signs <= _DUAL_SIGNS:
        yogas.append({'yoga': 'Nala Yoga (Nabhasa)', 'type': 'nabhasa_asraya'})

    # Kamala (all planets in kendras)
    occupied_houses = {_ph(p) for p in classical if _ph(p)}
    if occupied_houses and occupied_houses <= set(KENDRA):
        yogas.append({'yoga': 'Kamala Yoga (Nabhasa)', 'type': 'nabhasa_akriti'})
    # Sringataka (all in trines)
    if occupied_houses and occupied_houses <= set(TRIKONA):
        yogas.append({'yoga': 'Sringataka Yoga (Nabhasa)', 'type': 'nabhasa_akriti'})

    # ── 10. Dala Yogas ──
    benefics_in_kendra = set()
    malefics_in_kendra = set()
    nat_benefics = {'Jupiter', 'Venus', 'Mercury', 'Moon'}
    nat_malefics = {'Sun', 'Mars', 'Saturn'}
    for p in classical:
        if _ph(p) in KENDRA:
            if p in nat_benefics:
                benefics_in_kendra.add(p)
            elif p in nat_malefics:
                malefics_in_kendra.add(p)
    if len(benefics_in_kendra) >= 3 and not malefics_in_kendra:
        yogas.append({'yoga': 'Mala Yoga (benefics in Kendras)', 'type': 'dala'})
        findings.append({
            'factor': f'Mala Yoga — {", ".join(benefics_in_kendra)} in Kendras',
            'implication': 'Prosperity, comfort, happiness throughout life.',
            'confidence': 0.75,
        })
    if len(malefics_in_kendra) >= 3:
        yogas.append({'yoga': 'Sarpa Yoga (malefics in Kendras)', 'type': 'dala',
                      'outcome': 'negative'})
        findings.append({
            'factor': f'Sarpa Yoga — {", ".join(malefics_in_kendra)} in Kendras',
            'implication': 'Challenges, obstacles, enemies. Requires courage and persistence.',
            'confidence': 0.7,
        })

    # ── 11. Bandhana Yoga (imprisonment/disgrace) ──
    # Saturn + Rahu/Ketu + 6th lord all in Kendra/Trikona
    _kendra_trikona = KENDRA | TRIKONA
    _saturn_h = _ph('Saturn')
    _rahu_h = _ph('Rahu')
    _ketu_h = _ph('Ketu')
    _sixth_lord = house_lords.get(6, '')
    _sixth_lord_h = _ph(_sixth_lord) if _sixth_lord else 0
    _twelfth_lord = house_lords.get(12, '')
    _twelfth_lord_h = _ph(_twelfth_lord) if _twelfth_lord else 0
    if (_saturn_h in _kendra_trikona and
        (_rahu_h in _kendra_trikona or _ketu_h in _kendra_trikona) and
        _sixth_lord_h in _kendra_trikona):
        yogas.append({
            'yoga': 'Bandhana Yoga',
            'type': 'affliction',
            'planets': ['Saturn', 'Rahu' if _rahu_h in _kendra_trikona else 'Ketu', _sixth_lord],
            'outcome': 'negative',
        })
        findings.append({
            'factor': f'Bandhana Yoga — Saturn, {"Rahu" if _rahu_h in _kendra_trikona else "Ketu"}, '
                      f'6th lord {_sixth_lord} all in Kendra/Trikona',
            'implication': 'Imprisonment, disgrace, or confinement possible during activating dasha.',
            'confidence': 0.7,
        })
    # Also: 6th lord in 12th OR 12th lord in 6th (imprisonment via legal)
    if _sixth_lord_h == _house_from(lagna, RASHI[(RASHI.index(lagna) + 11) % 12]) if lagna in RASHI else False:
        pass  # Complex; simpler check:
    if _sixth_lord and _twelfth_lord:
        if _sixth_lord_h and _sixth_lord_h == ((RASHI.index(lagna) + 11) % 12) + 1:
            yogas.append({
                'yoga': 'Legal Confinement (6th lord in 12th)',
                'type': 'affliction',
                'planets': [_sixth_lord],
                'outcome': 'negative',
            })
        elif _twelfth_lord_h and _twelfth_lord_h == ((RASHI.index(lagna) + 5) % 12) + 1:
            yogas.append({
                'yoga': 'Legal Confinement (12th lord in 6th)',
                'type': 'affliction',
                'planets': [_twelfth_lord],
                'outcome': 'negative',
            })

    # Summary counts
    raja_yogas = [y for y in yogas if y['type'] in ('raja_yoga', 'viparita_raja', 'neechabhanga')]
    dhana_yogas_list = [y for y in yogas if y['type'] == 'dhana_yoga']

    return {
        'yogas': yogas,
        'yoga_count': len(yogas),
        'raja_yoga_count': len(raja_yogas),
        'dhana_yoga_count': len(dhana_yogas_list),
        'notable': [y['yoga'] for y in yogas[:10]],
        'findings': findings,
    }


# ── Stage 4: Karaka Identification ──────────────────────────────────────────
def stage4_karakas(chart: dict, verified: dict) -> dict:
    """Identify and interpret Chara Karakas."""
    ck = chart.get('chara_karakas', {})
    findings = []

    karaka_meanings = {
        'Atma Karaka': 'soul desire, deepest life theme',
        'Amatya Karaka': 'career direction, livelihood',
        'Bhratru Karaka': 'siblings, courage, initiatives',
        'Matru Karaka': 'mother, happiness, emotional foundation',
        'Putra Karaka': 'children, intelligence, creativity',
        'Gnati Karaka': 'enemies, obstacles, health challenges',
        'Dara Karaka': 'spouse, relationships, partnerships',
    }

    for karaka, planet in ck.items():
        meaning = karaka_meanings.get(karaka, '')
        planet_data = verified['planets'].get(planet, {})
        house = planet_data.get('house', 0)
        strength = planet_data.get('strength', 'unknown')

        if karaka == 'Atma Karaka' and planet:
            findings.append({
                'factor': f'Atma Karaka is {planet} in house {house}',
                'implication': f'The soul\'s deepest desire relates to {HOUSE_THEMES.get(house, "unknown")}. '
                              f'{planet} themes dominate the spiritual journey.',
                'confidence': 0.85,
            })
        elif karaka == 'Dara Karaka' and planet:
            findings.append({
                'factor': f'Dara Karaka (spouse indicator) is {planet} in house {house}',
                'implication': f'Spouse has {planet} qualities. Marriage themes connect to house {house} '
                              f'({HOUSE_THEMES.get(house, "")}).',
                'confidence': 0.8,
            })
        elif karaka == 'Amatya Karaka' and planet:
            findings.append({
                'factor': f'Amatya Karaka (career) is {planet} in house {house}',
                'implication': f'Career direction influenced by {planet}. Professional life connected to '
                              f'{HOUSE_THEMES.get(house, "")}.',
                'confidence': 0.8,
            })

    return {'chara_karakas': ck, 'findings': findings}


def _pacdares_assessment(planet: str, verified: dict) -> list[str]:
    """PACDARES assessment for a planet (KN Rao framework).
    P=Position, A=Aspect, C=Conjunction, D=Dasha, A=Avasthas, R=Rajayoga, E=Exchange, S=Special"""
    notes = []
    data = verified['planets'].get(planet, {})
    house = data.get('house', 0)
    rashi = data.get('rashi', '')
    dignity = data.get('dignity', 'placed')
    houses = verified['houses']
    house_lords = verified['house_lords']

    # P — Position
    if house in KENDRA:
        notes.append(f'P: {planet} in Kendra (house {house}) — angular strength')
    elif house in TRIKONA:
        notes.append(f'P: {planet} in Trikona (house {house}) — fortunate placement')
    elif house in DUSTHANA:
        notes.append(f'P: {planet} in Dusthana (house {house}) — challenging placement')

    # A — Aspects received
    aspects_from = []
    for other, odata in verified['planets'].items():
        if other == planet:
            continue
        ohouse = odata.get('house', 0)
        if ohouse == 0 or house == 0:
            continue
        offsets = GRAHA_DRISHTI.get(other, [7])
        for off in offsets:
            if ((ohouse - 1 + off) % 12) + 1 == house:
                aspects_from.append(other)
                break
    if aspects_from:
        benefic_asp = [p for p in aspects_from if p in NATURAL_BENEFICS]
        malefic_asp = [p for p in aspects_from if p in NATURAL_MALEFICS]
        if benefic_asp:
            notes.append(f'A: benefic aspects from {", ".join(benefic_asp)}')
        if malefic_asp:
            notes.append(f'A: malefic aspects from {", ".join(malefic_asp)}')

    # C — Conjunctions
    conjuncts = [p for p in houses.get(house, []) if p != planet]
    if conjuncts:
        notes.append(f'C: conjunct with {", ".join(conjuncts)} in house {house}')

    # R — Raja Yoga connections
    owned = [h for h, l in house_lords.items() if l == planet]
    owns_kendra = any(h in KENDRA for h in owned)
    owns_trikona = any(h in TRIKONA for h in owned)
    if owns_kendra and owns_trikona:
        notes.append(f'R: Yogakaraka — owns both Kendra and Trikona houses {owned}')
    elif owns_trikona:
        notes.append(f'R: Trikona lord (houses {owned}) — naturally beneficial')

    # E — Exchange (Parivartana)
    if house and rashi:
        sign_lord = RASHI_LORDS.get(rashi, '')
        if sign_lord != planet:
            sl_data = verified['planets'].get(sign_lord, {})
            sl_rashi = sl_data.get('rashi', '')
            if sl_rashi and RASHI_LORDS.get(sl_rashi) == planet:
                sl_house = sl_data.get('house', 0)
                notes.append(f'E: Parivartana (exchange) with {sign_lord} — houses {house} & {sl_house} mutually activated')

    return notes


# ── Stage 5: Dasha Analysis ─────────────────────────────────────────────────
def stage5_dasha(chart: dict, verified: dict) -> dict:
    """Analyze current and upcoming dashas for timing."""
    vimshottari = chart.get('vimshottari', [])
    findings = []
    current_dasha = None
    current_antar = None
    upcoming = []
    today = datetime.date.today().isoformat()

    current_pratyantar = None

    # Find current Mahadasha, Antardasha, and Pratyantardasha
    for d in vimshottari:
        start = d.get('start_date', '')
        end = d.get('end_date', '')
        if start <= today <= end:
            if d.get('level') == 'maha':
                current_dasha = d
            elif d.get('level') == 'antar':
                current_antar = d
                # Extract antardasha lord from compound name (e.g., "Mercury/Venus" -> "Venus")
                lord_parts = d.get('lord', '').split('/')
                if len(lord_parts) == 2:
                    d['lord'] = lord_parts[1]
                    # Also set Mahadasha if not found yet
                    if not current_dasha:
                        current_dasha = {
                            'lord': lord_parts[0],
                            'level': 'maha',
                            'start_date': start,
                            'end_date': end,
                        }
            elif d.get('level') in ('pratyantar', 'pratyantara', 'prat'):
                current_pratyantar = d
                # Extract PD lord from compound name (e.g., "Mars/Jupiter/Saturn" -> "Saturn")
                lord_parts = d.get('lord', '').split('/')
                if len(lord_parts) >= 3:
                    d['lord'] = lord_parts[2]
                elif len(lord_parts) == 2:
                    d['lord'] = lord_parts[1]
        elif start > today and len(upcoming) < 5:
            upcoming.append(d)

    house_lords = verified['house_lords']
    quality = 'neutral'

    if current_dasha:
        lord = current_dasha['lord']
        planet_data = verified['planets'].get(lord, {})
        house = planet_data.get('house', 0)
        strength = planet_data.get('strength', 'moderate')

        # Find what houses the dasha lord owns
        owned_houses = [h for h, l in house_lords.items() if l == lord]

        # Laghu Parashari functional classification — overrides natural benefic/malefic
        lp_role = _functional_role(lord, verified['lagna'], verified)
        quality = _lp_quality_label(lp_role)

        findings.append({
            'factor': f'Current Mahadasha: {lord} ({current_dasha.get("years", 0)} years)',
            'implication': f'{lord} is in house {house}, owns houses {owned_houses}. '
                          f'LP functional role: {lp_role}. Period quality: {quality}. '
                          f'Strength: {strength}. '
                          f'Life theme: {HOUSE_THEMES.get(house, "")}.',
            'confidence': 0.9,
        })

    # Antardasha analysis with KN Rao/Ansari rules
    antar_quality = None
    if current_antar:
        antar_lord = current_antar['lord']
        antar_data = verified['planets'].get(antar_lord, {})
        antar_house = antar_data.get('house', 0)
        antar_owned = [h for h, l in house_lords.items() if l == antar_lord]
        # LP functional classification for antardasha lord
        antar_lp_role = _functional_role(antar_lord, verified['lagna'], verified)
        antar_quality = _lp_quality_label(antar_lp_role).split(' (')[0]  # short label

        md_lord = current_dasha['lord'] if current_dasha else ''
        md_house = verified['planets'].get(md_lord, {}).get('house', 0) if md_lord else 0

        # ── RULE MD-1: Enemy sub-period lord gives unfavorable results ──
        if md_lord and _are_natural_enemies(md_lord, antar_lord):
            findings.append({
                'factor': f'Antardasha lord {antar_lord} is ENEMY of Mahadasha lord {md_lord}',
                'implication': f'Sub-period gives unfavorable results (Ansari MD-1). '
                              f'Enemy sub-lord produces obstacles, setbacks, or reversals in areas it rules.',
                'confidence': 0.85,
            })
            if antar_quality != 'challenging':
                antar_quality = 'strained'

        # ── RULE MD-5/MD-6: 6/8/12 Rule ──
        if md_house and antar_house:
            dist = _house_distance(md_house, antar_house)
            if dist in (6, 8, 12):
                findings.append({
                    'factor': f'Antardasha lord {antar_lord} is in {dist}th from Mahadasha lord {md_lord}',
                    'implication': f'CRITICAL: Sub-lord in 6/8/12 from main lord "destroys honour and fame" (Ansari MD-5, p.65). '
                                  f'Potential for loss, health issues, or setbacks until {current_antar.get("end_date", "?")}.',
                    'confidence': 0.85,
                })
                antar_quality = 'very challenging'
            # Also check from own lordship (MD-6)
            for owned_h in antar_owned:
                ad_dist = _house_distance(owned_h, antar_house)
                if ad_dist in (6, 8, 12):
                    findings.append({
                        'factor': f'{antar_lord} in {ad_dist}th from own house {owned_h}',
                        'implication': f'{antar_lord} is weakened from own lordship position — '
                                      f'loses good qualities for house {owned_h} matters (MD-6).',
                        'confidence': 0.75,
                    })
                    break

        # ── RULE MD-17/18/19: Cumulative influence ──
        if md_lord and md_house and antar_house:
            # Check if both lords influence the same houses
            md_owned = [h for h, l in house_lords.items() if l == md_lord]
            md_influences = set(md_owned + [md_house])
            ad_influences = set(antar_owned + [antar_house])
            shared = md_influences & ad_influences
            if shared:
                findings.append({
                    'factor': f'Both {md_lord} and {antar_lord} influence houses {sorted(shared)}',
                    'implication': f'Cumulative influence = excellent results for these houses (Ansari MD-17). '
                                  f'Areas: {", ".join(HOUSE_THEMES.get(h, "") for h in sorted(shared))}.',
                    'confidence': 0.8,
                })

        # ── RULE BVR-15: Cross-Trikona synergy (5th lord + 9th lord) ──
        md_owned_set = set(md_owned) if md_lord else set()
        ad_owned_set = set(antar_owned)
        if (5 in md_owned_set and 9 in ad_owned_set) or (9 in md_owned_set and 5 in ad_owned_set):
            findings.append({
                'factor': f'Cross-Trikona synergy: {md_lord} (houses {sorted(md_owned_set)}) + {antar_lord} (houses {sorted(ad_owned_set)})',
                'implication': 'Excellent period! 5th lord + 9th lord sub-period produces strong positive effects — '
                              'intelligence, fortune, children, dharma all flourish (BV Raman Rule 15).',
                'confidence': 0.85,
            })
            if antar_quality not in ('very challenging',):
                antar_quality = 'very favorable'

        # ── Badhak lord check (Sanjay Rath) ──
        badhak_h = BADHAK_HOUSE.get(verified['lagna'], 0)
        if badhak_h:
            badhak_lord = house_lords.get(badhak_h, '')
            if antar_lord == badhak_lord:
                findings.append({
                    'factor': f'{antar_lord} is Badhak lord (lord of {badhak_h}th — obstruction house)',
                    'implication': f'Badhak lord sub-period causes inexplicable obstacles, delays, and hindrances '
                                  f'(Sanjay Rath). Remedial measures for Badhak planet may help.',
                    'confidence': 0.75,
                })
                if antar_quality == 'neutral':
                    antar_quality = 'obstructed'

        # ── LP Dasha-Bhukti Quality Matrix (LP-039 through LP-048) ──
        md_lp = _functional_role(md_lord, verified['lagna'], verified) if md_lord else 'neutral'
        md_positive = _LP_ROLE_ORDER.get(md_lp, 3) >= 4  # yogakaraka/auspicious/blemished
        ad_positive = _LP_ROLE_ORDER.get(antar_lp_role, 3) >= 4
        md_ad_related = _are_natural_friends(md_lord, antar_lord) if md_lord else False

        # LP-047: Inauspicious dasha + unrelated Yogakaraka bhukti = EXTREMELY bad
        if not md_positive and antar_lp_role == 'yogakaraka' and not md_ad_related:
            findings.append({
                'factor': f'LP-047 WARNING: Yogakaraka {antar_lord} bhukti in inauspicious {md_lord} dasha (UNRELATED)',
                'implication': f'Counterintuitive LP rule: unrelated Yogakaraka in inauspicious dasha gives '
                              f'EXTREMELY bad results. The dutiful Yogakaraka follows the evil dasha lord\'s orders.',
                'confidence': 0.85,
            })
            antar_quality = 'severely adverse'

        # HIERARCHY RULE: Antardasha cannot override Mahadasha (KN Rao)
        elif md_positive and not ad_positive and antar_quality not in ('neutral',):
            findings.append({
                'factor': f'Current Antardasha: {antar_lord} ({antar_lp_role}) in favorable {md_lord} dasha',
                'implication': f'Temporary obstacles via {antar_lord} until {current_antar.get("end_date", "?")}. '
                              f'Overall positive Mahadasha trend will resume after this sub-period.',
                'confidence': 0.85,
            })
        elif not md_positive and ad_positive:
            findings.append({
                'factor': f'Current Antardasha: {antar_lord} (favorable) in challenging {md_lord} dasha',
                'implication': f'Temporary relief via {antar_lord} but Mahadasha challenges persist. '
                              f'Good sub-period cannot override difficult main period (KN Rao).',
                'confidence': 0.85,
            })
        else:
            findings.append({
                'factor': f'Current Antardasha: {antar_lord} (LP: {antar_lp_role})',
                'implication': f'Sub-period in house {antar_house}, owns {antar_owned}. '
                              f'Quality: {antar_quality}. Active until {current_antar.get("end_date", "?")}.',
                'confidence': 0.8,
            })

        # ── Dispositor analysis for Antardasha lord (DISP rules) ──
        ad_chain = _dispositor_chain(antar_lord, verified)
        if len(ad_chain) > 1:
            final_disp = ad_chain[-1]
            final_strength = verified['planets'].get(final_disp, {}).get('strength', 'moderate')
            final_house = verified['planets'].get(final_disp, {}).get('house', 0)
            if final_strength == 'weak' or final_house in DUSTHANA:
                findings.append({
                    'factor': f'Dispositor chain for {antar_lord}: {" → ".join(ad_chain)}',
                    'implication': f'Final dispositor {final_disp} is {"weak" if final_strength == "weak" else "in dusthana"}. '
                                  f'This weakens {antar_lord}\'s delivery (Ansari DISP-3: dispositor in evil house destroys effects).',
                    'confidence': 0.75,
                })
            elif final_strength == 'strong':
                findings.append({
                    'factor': f'Dispositor chain for {antar_lord}: {" → ".join(ad_chain)}',
                    'implication': f'Final dispositor {final_disp} is strong — supports {antar_lord}\'s delivery.',
                    'confidence': 0.75,
                })

    # ── Pratyantardasha Analysis (Phase 3A.3) ──
    # "The pratyantardasha lord is the TRIGGER" — KN Rao
    pd_quality = None
    if current_pratyantar:
        pd_lord = current_pratyantar['lord']
        pd_data = verified['planets'].get(pd_lord, {})
        pd_house = pd_data.get('house', 0)
        pd_owned = [h for h, l in house_lords.items() if l == pd_lord]
        pd_lp = _functional_role(pd_lord, verified['lagna'], verified)
        pd_quality = _lp_quality_label(pd_lp).split(' (')[0]

        # PD lord relationship with MD and AD lords
        md_lord = current_dasha['lord'] if current_dasha else ''
        ad_lord = current_antar['lord'] if current_antar else ''

        # Check which house areas the PD lord triggers
        pd_themes = [HOUSE_THEMES.get(h, '') for h in pd_owned if HOUSE_THEMES.get(h)]
        trigger_note = f'Triggers: {", ".join(pd_themes)}.' if pd_themes else ''

        findings.append({
            'factor': f'Pratyantardasha: {pd_lord} (LP: {pd_lp})',
            'implication': f'Sub-sub-period TRIGGER — {pd_lord} in house {pd_house}, owns {pd_owned}. '
                          f'{trigger_note} '
                          f'Quality: {pd_quality}. Active until {current_pratyantar.get("end_date", "?")}. '
                          f'Events in this PD period are colored by the exact nature of {pd_lord}.',
            'confidence': 0.8,
        })

        # PD lord in 6/8 from AD lord = friction within sub-period
        if ad_lord and pd_house:
            ad_house = verified['planets'].get(ad_lord, {}).get('house', 0)
            if ad_house:
                pd_ad_dist = _house_distance(ad_house, pd_house)
                if pd_ad_dist in (6, 8):
                    findings.append({
                        'factor': f'PD lord {pd_lord} in {pd_ad_dist}th from AD lord {ad_lord}',
                        'implication': f'Sub-sub-period friction: {pd_lord} and {ad_lord} in 6/8 relationship. '
                                      f'Short but sharp difficulties during this PD.',
                        'confidence': 0.75,
                    })
                    pd_quality = 'strained'

        # PD lord activating a yoga = event trigger
        if pd_lord == YOGAKARAKA.get(verified['lagna'], ''):
            findings.append({
                'factor': f'PD lord {pd_lord} IS the Yogakaraka',
                'implication': f'Yogakaraka triggering in PD — specific events (career/marriage/wealth) '
                              f'most likely to manifest NOW during this sub-sub-period.',
                'confidence': 0.85,
            })

    # PACDARES check for Mahadasha lord (KN Rao framework)
    if current_dasha:
        lord = current_dasha['lord']
        planet_data = verified['planets'].get(lord, {})
        pacdares = _pacdares_assessment(lord, verified)
        if pacdares:
            findings.append({
                'factor': f'PACDARES analysis for Mahadasha lord {lord}',
                'implication': '; '.join(pacdares),
                'confidence': 0.8,
            })

        # Dispositor chain for Mahadasha lord (Ansari DISP theory)
        md_chain = _dispositor_chain(lord, verified)
        if len(md_chain) > 1:
            final_disp = md_chain[-1]
            final_data = verified['planets'].get(final_disp, {})
            final_strength = final_data.get('strength', 'moderate')
            findings.append({
                'factor': f'Dispositor chain: {" → ".join(md_chain)}',
                'implication': f'Final dispositor is {final_disp} ({final_strength}). '
                              f'The final dispositor\'s condition colors the entire Mahadasha experience (Ansari DISP theory).',
                'confidence': 0.75,
            })

        # Vipareet Rajayoga check (Rule MD-15)
        owned_houses = [h for h, l in house_lords.items() if l == lord]
        lord_house = planet_data.get('house', 0)
        if any(h in DUSTHANA for h in owned_houses) and lord_house in DUSTHANA:
            findings.append({
                'factor': f'Vipareet Rajayoga: {lord} (dusthana lord {owned_houses}) in dusthana house {lord_house}',
                'implication': 'Dusthana lord in dusthana creates Vipareet Rajayoga — '
                              'wealth, honour, and status through overcoming adversity (Ansari MD-15).',
                'confidence': 0.8,
            })

        # Rahu/Ketu as Yogakaraka check (Rule D-3)
        if lord in ('Rahu', 'Ketu') and lord_house:
            if lord_house in KENDRA or lord_house in TRIKONA:
                # Check if aspected by or conjoined with Kendra/Trikona lord
                house_occupants = verified['houses'].get(lord_house, [])
                for occ in house_occupants:
                    if occ == lord:
                        continue
                    occ_owned = [h for h, l in house_lords.items() if l == occ]
                    if any(h in KENDRA for h in occ_owned) or any(h in TRIKONA for h in occ_owned):
                        findings.append({
                            'factor': f'{lord} in Kendra/Trikona with {occ} (Kendra/Trikona lord)',
                            'implication': f'{lord} becomes Yogakaraka and gives good results in this dasha (Rule D-3).',
                            'confidence': 0.8,
                        })
                        break

    # Yoga activation check — yogas activate ONLY during relevant dasha
    yoga_activation = []
    active_yogas = chart.get('yogas', [])
    if current_dasha and active_yogas:
        for y in active_yogas[:20]:
            yoga_name = y.get('yoga', '')
            yoga_planets = y.get('planets', [])
            if current_dasha['lord'] in yoga_planets:
                yoga_activation.append(yoga_name)
            elif current_antar and current_antar['lord'] in yoga_planets:
                yoga_activation.append(f'{yoga_name} (via Antardasha)')
    if yoga_activation:
        findings.append({
            'factor': f'Active yoga(s) during current dasha: {", ".join(yoga_activation[:5])}',
            'implication': 'These yogas are currently delivering results. Yogas not in current dasha remain latent.',
            'confidence': 0.85,
        })

    # Other dasha systems for cross-reference (Composite Approach)
    other_dashas = chart.get('other_dashas', {})
    active_systems = list(other_dashas.keys())[:5]

    # Yogini Dasha cross-check (2G)
    # Planet lord → Yogini name mapping
    PLANET_TO_YOGINI = {
        'Moon': 'Mangala', 'Sun': 'Pingala', 'Jupiter': 'Dhanya',
        'Mars': 'Bhramari', 'Mercury': 'Bhadrika', 'Saturn': 'Ulka',
        'Venus': 'Siddha', 'Rahu': 'Sankata',
    }
    YOGINI_QUALITY = {
        'Mangala': 'excellent', 'Siddha': 'excellent',
        'Pingala': 'good', 'Dhanya': 'good', 'Bhadrika': 'good',
        'Bhramari': 'mixed',
        'Ulka': 'difficult', 'Sankata': 'difficult',
    }
    yogini_quality = None
    yogini = other_dashas.get('yogini', [])
    event_date = chart.get('event_date', today)
    if yogini:
        # Collect maha-level entries to find active period (start to NEXT maha start)
        maha_entries = [yd for yd in yogini
                        if isinstance(yd, dict) and yd.get('level') == 'maha' and yd.get('start')]
        try:
            event_dt = datetime.date.fromisoformat(event_date) if isinstance(event_date, str) else event_date
            for i, yd in enumerate(maha_entries):
                start_dt = datetime.date.fromisoformat(yd['start'])
                # End of this maha = start of next maha (or far future if last)
                if i + 1 < len(maha_entries):
                    end_dt = datetime.date.fromisoformat(maha_entries[i + 1]['start'])
                else:
                    from datetime import timedelta
                    end_dt = start_dt + timedelta(days=3650)  # ~10 years fallback
                if start_dt <= event_dt < end_dt:
                    lord_raw = yd.get('lord', '')
                    planet_lord = lord_raw.split('/')[0].strip() if '/' in lord_raw else lord_raw
                    yogini_name = PLANET_TO_YOGINI.get(planet_lord, planet_lord)
                    yogini_quality = YOGINI_QUALITY.get(yogini_name, 'neutral')
                    findings.append({
                        'factor': f'Yogini Dasha: {yogini_name} ({planet_lord}) — {yogini_quality}',
                        'implication': f'Yogini system shows {yogini_name} period — '
                                      f'{"favorable for achievements" if yogini_quality in ("excellent", "good") else "challenging period, obstacles likely" if yogini_quality == "difficult" else "mixed results, careful navigation needed"}.',
                        'confidence': 0.7,
                    })
                    break
        except (ValueError, TypeError):
            pass

    # Chara Dasha cross-check (2H) — skip if lord format doesn't contain sign info
    chara_quality = None

    if active_systems:
        findings.append({
            'factor': f'Composite verification: {len(other_dashas)} other dasha systems available',
            'implication': f'Systems: {", ".join(active_systems[:5])}. '
                          f'If Chara Dasha and Vimshottari agree, confidence exceeds 80% (KN Rao).',
            'confidence': 0.7,
        })

    return {
        'current_mahadasha': current_dasha,
        'current_antardasha': current_antar,
        'current_pratyantardasha': current_pratyantar,
        'mahadasha_quality': quality if current_dasha else None,
        'antardasha_quality': antar_quality,
        'pratyantardasha_quality': pd_quality,
        'yoga_activation': yoga_activation,
        'upcoming_transitions': upcoming[:3],
        'other_systems_count': len(other_dashas),
        'yogini_quality': yogini_quality,
        'chara_quality': chara_quality,
        'findings': findings,
    }


# ── Stage 6: Transit Layer ──────────────────────────────────────────────────
def stage6_transits(chart: dict, verified: dict) -> dict:
    """Analyze current transits and their impact.
    Note: This uses birth chart positions + current approximate transit positions.
    For precise transit analysis, real-time ephemeris would be needed."""
    findings = []
    moon = verified['planets'].get('Moon', {})
    moon_rashi = moon.get('rashi', '')

    if not moon_rashi:
        return {'findings': [{'factor': 'Transit analysis unavailable', 'implication': 'Moon position needed', 'confidence': 0}],
                'double_transit_houses': [], 'sade_sati': False}

    lagna = verified.get('lagna', '')
    lagna_idx = RASHI.index(lagna) if lagna in RASHI else -1
    moon_idx = RASHI.index(moon_rashi) if moon_rashi in RASHI else -1

    # ── Double Transit Analysis (KN Rao) ─────────────────────────────────
    # Check current Jupiter and Saturn positions from chart transits or approximate
    transit_data = chart.get('transits', {})
    jupiter_transit = transit_data.get('Jupiter', {}).get('rashi', '')
    saturn_transit = transit_data.get('Saturn', {}).get('rashi', '')

    double_transit_houses = []
    if jupiter_transit and saturn_transit and jupiter_transit in RASHI and saturn_transit in RASHI:
        jup_idx = RASHI.index(jupiter_transit)
        sat_idx = RASHI.index(saturn_transit)

        # Signs influenced by Jupiter (occupied + 5th, 7th, 9th)
        jup_signs = set()
        for off in JUPITER_ASPECT_OFFSETS:
            jup_signs.add((jup_idx + off) % 12)
        # Signs influenced by Saturn (occupied + 3rd, 7th, 10th)
        sat_signs = set()
        for off in SATURN_ASPECT_OFFSETS:
            sat_signs.add((sat_idx + off) % 12)

        # Double Transit = overlap signs
        overlap = jup_signs & sat_signs
        if overlap and lagna_idx >= 0:
            for sign_idx in overlap:
                house_num = ((sign_idx - lagna_idx) % 12) + 1
                double_transit_houses.append(house_num)

            # Map to life events
            dt_events = []
            for h in double_transit_houses:
                if h == 7:
                    dt_events.append('Marriage/Partnership')
                elif h == 10:
                    dt_events.append('Career advancement')
                elif h == 5:
                    dt_events.append('Children/Intelligence')
                elif h == 2:
                    dt_events.append('Wealth accumulation')
                elif h == 4:
                    dt_events.append('Property/Vehicles')
                elif h == 9:
                    dt_events.append('Fortune/Higher learning')
                elif h == 1:
                    dt_events.append('Self/New beginnings')
                elif h == 11:
                    dt_events.append('Gains/Desire fulfillment')
                elif h == 12:
                    dt_events.append('Foreign travel/Spirituality')

            findings.append({
                'factor': f'Double Transit (Jupiter in {jupiter_transit} + Saturn in {saturn_transit})',
                'implication': f'Jupiter-Saturn jointly activate houses {double_transit_houses} from Lagna. '
                              f'Events supported: {", ".join(dt_events) if dt_events else "check houses"}. '
                              f'KN Rao: No major event fructifies without Double Transit support (98% accuracy).',
                'confidence': 0.85,
            })
    else:
        findings.append({
            'factor': 'Double Transit — transit positions not available in chart data',
            'implication': 'For precise timing, provide current Jupiter and Saturn transit positions. '
                          'Double Transit is essential for timing major events (KN Rao, 98% accuracy for marriage).',
            'confidence': 0.5,
        })

    # ── Sade Sati Check ──────────────────────────────────────────────────
    sade_sati = False
    if saturn_transit and saturn_transit in RASHI and moon_idx >= 0:
        sat_transit_idx = RASHI.index(saturn_transit)
        relative = (sat_transit_idx - moon_idx) % 12
        if relative in (11, 0, 1):  # 12th, 1st, 2nd from Moon
            sade_sati = True
            phase = {11: '1st phase (12th from Moon)', 0: '2nd phase (over Moon — peak)',
                     1: '3rd phase (2nd from Moon)'}[relative]
            # Saturn dignity context for Sade Sati
            natal_saturn = verified['planets'].get('Saturn', {})
            saturn_dignity = natal_saturn.get('dignity', '')
            if saturn_dignity in ('exalted', 'own_sign'):
                sade_sati_context = ('Restructuring period, NOT destruction — natal Saturn is strong '
                                    f'({saturn_dignity}). Career discipline, authority-building, '
                                    'delayed but lasting gains. Saturn rewards hard work here.')
            elif saturn_dignity == 'debilitated':
                sade_sati_context = ('Heightened difficulties — natal Saturn is debilitated. '
                                    'Health issues, career setbacks, mental stress more pronounced. '
                                    'Remedial measures strongly advised.')
            else:
                sade_sati_context = ('Major life restructuring period. Saturn over Moon sign causes mental stress, '
                                    'career changes, and transformation. Not always negative — depends on Saturn\'s '
                                    'Ashtakavarga bindus in this sign and natal Saturn strength.')
            findings.append({
                'factor': f'Sade Sati ACTIVE — {phase}',
                'implication': sade_sati_context,
                'confidence': 0.85,
            })

    # ── Ashtakavarga Transit Guidance ─────────────────────────────────────
    sav = chart.get('ashtakavarga_sav', [])
    bav = chart.get('ashtakavarga_bav', {})  # Individual planet BAV
    if sav:
        strong_signs = []
        weak_signs = []
        for i, v in enumerate(sav):
            if isinstance(v, (int, float)):
                if v >= 30:
                    strong_signs.append(RASHI[i])
                elif v <= 24:
                    weak_signs.append(RASHI[i])
        if strong_signs:
            findings.append({
                'factor': f'Strong SAV signs (30+): {", ".join(strong_signs)}',
                'implication': 'Planet transits through these signs bring favorable results. '
                              'Events timing through these signs manifest smoothly.',
                'confidence': 0.75,
            })
        if weak_signs:
            findings.append({
                'factor': f'Weak SAV signs (≤24): {", ".join(weak_signs)}',
                'implication': 'Planet transits through these signs bring challenges. '
                              'Even promised events face obstacles when triggered through these signs.',
                'confidence': 0.75,
            })

        # Saturn BAV check for current transit (BV Raman)
        if saturn_transit and saturn_transit in RASHI and bav.get('Saturn'):
            sat_bav = bav['Saturn']
            sat_bav_idx = RASHI.index(saturn_transit)
            if sat_bav_idx < len(sat_bav):
                bindus = sat_bav[sat_bav_idx]
                if isinstance(bindus, (int, float)):
                    if bindus >= 4:
                        findings.append({
                            'factor': f'Saturn transit with {bindus} BAV bindus — favorable',
                            'implication': 'Saturn gives structured, rewarding results in this transit. '
                                          'Good for career building, discipline, authority.',
                            'confidence': 0.75,
                        })
                    elif bindus <= 2:
                        findings.append({
                            'factor': f'Saturn transit with only {bindus} BAV bindus — difficult',
                            'implication': 'Saturn causes significant difficulties in this transit period. '
                                          'Health issues, career obstacles, financial stress possible.',
                            'confidence': 0.8,
                        })

    # ── Three-Lagna Transit Method (Ansari TR-5) ───────────────────────
    # Check Jupiter/Saturn transit from Birth Lagna, Moon Lagna, AND Sun Lagna
    sun = verified['planets'].get('Sun', {})
    sun_rashi = sun.get('rashi', '')
    sun_idx = RASHI.index(sun_rashi) if sun_rashi in RASHI else -1

    if jupiter_transit and saturn_transit and jupiter_transit in RASHI and saturn_transit in RASHI:
        jup_t_idx = RASHI.index(jupiter_transit)
        sat_t_idx = RASHI.index(saturn_transit)

        # Check key houses from all three Lagnas
        three_lagnas = []
        if lagna_idx >= 0:
            three_lagnas.append(('Birth Lagna', lagna_idx))
        if moon_idx >= 0:
            three_lagnas.append(('Moon Lagna', moon_idx))
        if sun_idx >= 0:
            three_lagnas.append(('Sun Lagna', sun_idx))

        if len(three_lagnas) >= 2:
            # Jupiter on 10th from all three = career rise (TR-6)
            jup_on_10th_count = sum(1 for _, idx in three_lagnas if ((jup_t_idx - idx) % 12) + 1 == 10
                                    or ((jup_t_idx - idx) % 12) + 1 in [h for off in JUPITER_ASPECT_OFFSETS
                                    if ((jup_t_idx + off - idx) % 12) + 1 == 10 for h in [10]])
            # Simplified: check if Jupiter aspects 10th from each Lagna
            jup_career_hits = 0
            sat_health_hits = 0
            for lbl, idx in three_lagnas:
                # Jupiter influence on 10th house from this Lagna
                for off in JUPITER_ASPECT_OFFSETS:
                    aspected_sign = (jup_t_idx + off) % 12
                    house_from_lagna = ((aspected_sign - idx) % 12) + 1
                    if house_from_lagna == 10:
                        jup_career_hits += 1
                        break
                # Saturn influence on Lagna (health threat)
                for off in SATURN_ASPECT_OFFSETS:
                    aspected_sign = (sat_t_idx + off) % 12
                    house_from_lagna = ((aspected_sign - idx) % 12) + 1
                    if house_from_lagna == 1:
                        sat_health_hits += 1
                        break

            if jup_career_hits >= 2:
                findings.append({
                    'factor': f'Jupiter transiting 10th from {jup_career_hits}/{len(three_lagnas)} Lagnas',
                    'implication': f'Strong career rise indicator (Ansari TR-6). '
                                  f'Jupiter as karaka for auspicious events activates professional advancement.',
                    'confidence': 0.8,
                })
            if sat_health_hits >= 2:
                findings.append({
                    'factor': f'Saturn transiting over {sat_health_hits}/{len(three_lagnas)} Lagnas',
                    'implication': f'Health awareness period. Saturn as karaka for inauspicious events '
                                  f'affecting body/vitality from multiple reference points (Ansari TR-7).',
                    'confidence': 0.75,
                })

    # ── Gocharaphala Transit Scoring (BV Raman) ────────────────────────
    if jupiter_transit and saturn_transit and moon_idx >= 0:
        transit_planets = {'Jupiter': jupiter_transit, 'Saturn': saturn_transit}
        for tp_name, tp_rashi in transit_planets.items():
            if tp_rashi in RASHI:
                tp_idx = RASHI.index(tp_rashi)
                house_from_moon = ((tp_idx - moon_idx) % 12) + 1
                score = _gochara_score(tp_name, house_from_moon)
                if score == 'favorable':
                    # Check vedha
                    vedha_house = VEDHA_PAIRS.get(tp_name, {}).get(house_from_moon)
                    vedha_blocked = False
                    if vedha_house:
                        vedha_sign_idx = (moon_idx + vedha_house - 1) % 12
                        vedha_sign = RASHI[vedha_sign_idx]
                        # Check if any planet transiting vedha sign
                        for other_name, other_rashi in transit_planets.items():
                            if other_name != tp_name and other_rashi == vedha_sign:
                                vedha_blocked = True
                                break
                    if not vedha_blocked:
                        findings.append({
                            'factor': f'{tp_name} transit in {house_from_moon}th from Moon — FAVORABLE (Gocharaphala)',
                            'implication': f'{tp_name} transiting favorable house from Moon supports positive results '
                                          f'for {HOUSE_THEMES.get(house_from_moon, "")} (BV Raman).',
                            'confidence': 0.7,
                        })
                elif score == 'unfavorable':
                    findings.append({
                        'factor': f'{tp_name} transit in {house_from_moon}th from Moon — unfavorable (Gocharaphala)',
                        'implication': f'{tp_name} transiting unfavorable house from Moon causes challenges '
                                      f'in {HOUSE_THEMES.get(house_from_moon, "")} (BV Raman).',
                        'confidence': 0.65,
                    })

    # ── Maraka Transit Warning ────────────────────────────────────────────
    house_lords = verified['house_lords']
    maraka_lords = [house_lords.get(2, ''), house_lords.get(7, '')]
    if saturn_transit and saturn_transit in RASHI:
        for ml in maraka_lords:
            ml_data = verified['planets'].get(ml, {})
            if ml_data.get('rashi') == saturn_transit:
                findings.append({
                    'factor': f'Saturn transiting over Maraka lord {ml}',
                    'implication': 'Heightened health awareness needed. This transit activates Maraka energy — '
                                  'relevant only if native is in their longevity window and Maraka Dasha is running.',
                    'confidence': 0.65,
                })

    return {
        'findings': findings,
        'double_transit_houses': double_transit_houses,
        'sade_sati': sade_sati,
    }


# ── Arudha Pada Computation (Sanjay Rath) ──────────────────────────────────
def _compute_arudha(house_num: int, house_lords: dict, planets: dict, lagna: str) -> str:
    """Compute Arudha Pada for a given house.
    Rule: Count from house to its lord's position, then count same distance from lord.
    Exception: If the result falls in the same house or 7th from it, use the 10th house instead."""
    lord = house_lords.get(house_num, '')
    if not lord or lord not in planets:
        return ''
    lord_house = planets[lord].get('house', 0)
    if not lord_house:
        return ''
    # Distance from house to lord
    dist = ((lord_house - house_num) % 12) or 12
    # Count same distance from lord
    arudha_house = ((lord_house + dist - 1) % 12) + 1
    # Exception: if arudha falls in same house or 7th, use 10th from house
    if arudha_house == house_num or arudha_house == ((house_num + 6 - 1) % 12) + 1:
        arudha_house = ((house_num + 9 - 1) % 12) + 1
    return arudha_house


def stage_arudha(verified: dict) -> dict:
    """Compute and analyze Arudha Padas — Sanjay Rath method."""
    house_lords = verified['house_lords']
    planets = verified['planets']
    lagna = verified['lagna']
    findings = []

    # Compute key Arudha Padas
    al = _compute_arudha(1, house_lords, planets, lagna)  # Arudha Lagna
    a7 = _compute_arudha(7, house_lords, planets, lagna)  # Darapada (spouse)
    a10 = _compute_arudha(10, house_lords, planets, lagna)  # Rajyapada (career image)
    ul = _compute_arudha(12, house_lords, planets, lagna)  # Upapada (marriage)
    a2 = _compute_arudha(2, house_lords, planets, lagna)  # Dhana Pada (wealth)
    a5 = _compute_arudha(5, house_lords, planets, lagna)  # Mantra Pada

    arudha_padas = {
        'AL': al, 'A7': a7, 'A10': a10, 'UL': ul, 'A2': a2, 'A5': a5,
    }

    if al:
        # Check planets in 3rd and 6th from AL (Sanjay Rath: malefics = power)
        houses = verified['houses']
        nat_malefics = {'Sun', 'Mars', 'Saturn', 'Rahu', 'Ketu'}
        al_3rd = ((al + 2 - 1) % 12) + 1
        al_6th = ((al + 5 - 1) % 12) + 1
        malefics_in_upachaya = []
        for h in [al_3rd, al_6th]:
            for p in houses.get(h, []):
                if p in nat_malefics:
                    malefics_in_upachaya.append(f'{p} in {h}th ({"3rd" if h == al_3rd else "6th"} from AL)')

        if malefics_in_upachaya:
            findings.append({
                'factor': f'Malefics in upachaya from AL: {"; ".join(malefics_in_upachaya)}',
                'implication': 'Sanjay Rath: Natural malefics in 3rd/6th from Arudha Lagna give authority, '
                              'power, and victory over enemies. Stronger public image.',
                'confidence': 0.75,
            })

        # Benefics in 3/6 from AL = loss of image
        nat_benefics = {'Jupiter', 'Venus', 'Mercury', 'Moon'}
        benefics_in_upachaya = []
        for h in [al_3rd, al_6th]:
            for p in houses.get(h, []):
                if p in nat_benefics:
                    benefics_in_upachaya.append(f'{p} in {h}th')
        if benefics_in_upachaya:
            findings.append({
                'factor': f'Benefics in 3rd/6th from AL: {"; ".join(benefics_in_upachaya)}',
                'implication': 'Sanjay Rath warning: Natural benefics in 3rd/6th from AL can cause '
                              'loss of public image and status. Counterintuitive but confirmed across cases.',
                'confidence': 0.7,
            })

        # Check 12th from AL (what sustains fame — KNR-CS-010)
        al_12th = ((al + 11 - 1) % 12) + 1
        planets_in_12th_al = houses.get(al_12th, [])
        if planets_in_12th_al:
            findings.append({
                'factor': f'12th from AL (house {al_12th}): {", ".join(planets_in_12th_al)}',
                'implication': f'Planets in 12th from AL show what sustains/undermines fame. '
                              f'Benefics here = lasting reputation. Malefics = fame from unconventional means.',
                'confidence': 0.7,
            })

    # UL analysis for marriage quality
    if ul:
        ul_lord = house_lords.get(ul, '')
        ul_2nd = ((ul + 1 - 1) % 12) + 1  # 2nd from UL = sustenance of marriage
        planets_2nd_ul = verified['houses'].get(ul_2nd, [])
        if planets_2nd_ul:
            nat_malefics = {'Sun', 'Mars', 'Saturn', 'Rahu', 'Ketu'}
            malefics = [p for p in planets_2nd_ul if p in nat_malefics]
            if malefics:
                findings.append({
                    'factor': f'Malefics in 2nd from UL: {", ".join(malefics)}',
                    'implication': 'Stress on marriage sustenance. 2nd from Upapada afflicted by malefics '
                                  'indicates challenges in maintaining the marriage bond.',
                    'confidence': 0.7,
                })

    return {
        'arudha_padas': arudha_padas,
        'findings': findings,
    }


# ── D-10 Dashamsha Analysis (Phase 2F) ────────────────────────────────────
def stage_d10(chart: dict, verified: dict) -> dict:
    """Analyze D-10 (Dashamsha) for career — the tiebreaker per KN Rao."""
    d10_data = chart.get('dashamsha', chart.get('d10', []))
    findings = []
    d10_planets = {}
    d10_lagna = None

    # Parse D-10 data
    if isinstance(d10_data, list):
        for p in d10_data:
            name = p.get('body', '')
            rashi = p.get('rashi', '')
            if name == 'Lagna':
                d10_lagna = rashi
            elif name and rashi:
                d10_planets[name] = {
                    'rashi': rashi,
                    'house': 0,  # will compute below
                }

    if not d10_lagna:
        return {'findings': [], 'd10_available': False}

    # Compute house positions in D-10
    d10_lagna_idx = RASHI.index(d10_lagna) if d10_lagna in RASHI else -1
    if d10_lagna_idx >= 0:
        for name, data in d10_planets.items():
            if data['rashi'] in RASHI:
                data['house'] = ((RASHI.index(data['rashi']) - d10_lagna_idx) % 12) + 1

    # D-10 10th lord
    d10_10th_sign_idx = (d10_lagna_idx + 9) % 12
    d10_10th_sign = RASHI[d10_10th_sign_idx]
    d10_10th_lord = RASHI_LORDS.get(d10_10th_sign, '')

    if d10_10th_lord and d10_10th_lord in d10_planets:
        d10_10th_h = d10_planets[d10_10th_lord].get('house', 0)
        if d10_10th_h in KENDRA or d10_10th_h in TRIKONA:
            findings.append({
                'factor': f'D-10: 10th lord {d10_10th_lord} in Kendra/Trikona (house {d10_10th_h})',
                'implication': 'Career confirmation from Dashamsha. D-10 10th lord well-placed = '
                              'career success verified at divisional level (KNR-CS-001: D-10 is the clincher).',
                'confidence': 0.8,
            })
        elif d10_10th_h in DUSTHANA:
            findings.append({
                'factor': f'D-10: 10th lord {d10_10th_lord} in dusthana (house {d10_10th_h})',
                'implication': 'Career challenges in D-10. Even if D-1 shows yogas, D-10 weakness '
                              'limits career manifestation.',
                'confidence': 0.75,
            })

    # Check dasha lord placement in D-10
    md_lord = verified.get('_vimshottari_md', '')
    if md_lord and md_lord in d10_planets:
        md_d10_h = d10_planets[md_lord].get('house', 0)
        if md_d10_h == 10:
            findings.append({
                'factor': f'D-10: Mahadasha lord {md_lord} in 10th house of Dashamsha',
                'implication': 'Strongest career confirmation. Dasha lord in 10th of D-10 = '
                              'career peak during this period. KN Rao uses this as the clinching factor.',
                'confidence': 0.85,
            })
        elif md_d10_h in KENDRA:
            findings.append({
                'factor': f'D-10: Mahadasha lord {md_lord} in Kendra of Dashamsha (house {md_d10_h})',
                'implication': 'Career well-supported by current dasha in D-10.',
                'confidence': 0.75,
            })

    # Jupiter in D-10 10th (SR-CS-018, KNR-CS-003: highest career)
    if 'Jupiter' in d10_planets and d10_planets['Jupiter'].get('house') == 10:
        findings.append({
            'factor': 'D-10: Jupiter in 10th of Dashamsha',
            'implication': 'Career at highest level. FDR, Dhirubhai Ambani, KC Saxena all had this. '
                          'Jupiter in D-10 10th = international/national-level career.',
            'confidence': 0.8,
        })

    # Planets in D-10 kendras (general career strength)
    d10_kendra_count = sum(1 for p, d in d10_planets.items()
                          if d.get('house') in KENDRA and p not in ('Rahu', 'Ketu'))
    if d10_kendra_count >= 3:
        findings.append({
            'factor': f'D-10: {d10_kendra_count} planets in Kendra of Dashamsha',
            'implication': 'Strong career foundation. Multiple planets in D-10 kendras = '
                          'authority and achievement in profession.',
            'confidence': 0.75,
        })

    return {
        'findings': findings,
        'd10_available': True,
        'd10_lagna': d10_lagna,
        'd10_10th_lord': d10_10th_lord,
        'd10_planets': {name: data.get('house', 0) for name, data in d10_planets.items()},
    }


# ── Enhanced Ashtakavarga Transit Scoring ──────────────────────────────────
def _ashtakavarga_transit_score(planet: str, transit_sign: str, bav: dict,
                                 sav: list) -> dict:
    """Score a transiting planet using BAV and SAV.
    Returns {bindus, sav_score, quality, description}."""
    if not transit_sign or transit_sign not in RASHI:
        return {}
    sign_idx = RASHI.index(transit_sign)
    result = {}

    # BAV score for this planet in this sign
    planet_bav = bav.get(planet, [])
    if planet_bav and sign_idx < len(planet_bav):
        bindus = planet_bav[sign_idx]
        if isinstance(bindus, (int, float)):
            result['bindus'] = int(bindus)
            if bindus >= 5:
                result['quality'] = 'excellent'
            elif bindus >= 4:
                result['quality'] = 'good'
            elif bindus == 3:
                result['quality'] = 'neutral'
            elif bindus == 2:
                result['quality'] = 'difficult'
            else:
                result['quality'] = 'very_difficult'

    # SAV score for the sign
    if sav and sign_idx < len(sav):
        sav_val = sav[sign_idx]
        if isinstance(sav_val, (int, float)):
            result['sav_score'] = int(sav_val)
            if sav_val >= 30:
                result['sav_quality'] = 'strong'
            elif sav_val >= 28:
                result['sav_quality'] = 'average'
            else:
                result['sav_quality'] = 'weak'

    return result


# ── Stage 7: Synthesis ──────────────────────────────────────────────────────
def stage7_synthesis(verified: dict, stages: dict) -> dict:
    """Synthesize all stages into final predictions with confidence levels."""
    predictions = []

    # Collect all findings
    all_findings = []
    for stage_name, stage_data in stages.items():
        for f in stage_data.get('findings', []):
            f['stage'] = stage_name
            all_findings.append(f)

    # ── Life Area Predictions with Triple Confirmation ──────────────────────
    house_lords = verified['house_lords']
    planets = verified['planets']
    d1_d9_conf = stages.get('navamsha', {}).get('d1_d9_confirmation', {})
    dasha_data = stages.get('dasha', {})
    transit_data = stages.get('transits', {})
    double_transit_houses = transit_data.get('double_transit_houses', [])
    yoga_activation = dasha_data.get('yoga_activation', [])
    detected_yogas = stages.get('yogas', {}).get('yogas', [])
    lagna = verified['lagna']
    yogakaraka = YOGAKARAKA.get(lagna, '')

    lp_classifications = stages.get('functional', {}).get('classifications', {})

    # ── Case-Study Pattern Matching (Phase 4D) ──
    md_info = dasha_data.get('current_mahadasha', {}) or {}
    ad_info = dasha_data.get('current_antardasha', {}) or {}
    _md_lord = md_info.get('lord', '')
    _ad_lord = ad_info.get('lord', '')

    def _match_case_patterns(domain: str, house_num: int, key_planet: str) -> list:
        """Match chart against case-study patterns for a life domain.
        Returns list of (confidence_boost, description, outcome, pattern_name)."""
        matches = []
        patterns = CASE_PATTERNS.get(domain, [])
        for pat in patterns:
            conds = pat.get('conditions', {})
            matched = True
            match_count = 0

            # planet_in_house
            for p, h in conds.get('planet_in_house', []):
                actual_planet = p
                if p == 'dasha_lord':
                    actual_planet = _md_lord
                elif p == '10th_lord':
                    actual_planet = house_lords.get(10, '')
                elif p == '7th_lord':
                    actual_planet = house_lords.get(7, '')
                if actual_planet and actual_planet in planets:
                    p_house = planets[actual_planet].get('house', 0)
                    target_h = h
                    if h == 'kendra':
                        if p_house in KENDRA:
                            match_count += 1
                        else:
                            matched = False
                    elif isinstance(h, int) and p_house == h:
                        match_count += 1
                    elif isinstance(h, int):
                        matched = False
                else:
                    matched = False

            # dasha_lord
            if 'dasha_lord' in conds:
                dl = conds['dasha_lord']
                if dl == 'yogakaraka':
                    if _md_lord == YOGAKARAKA.get(lagna, ''):
                        match_count += 1
                    else:
                        matched = False
                elif dl == '7th_lord':
                    if _md_lord == house_lords.get(7, ''):
                        match_count += 1
                    else:
                        matched = False
                elif dl == 'dusthana_lord':
                    md_houses = [h for h, l in house_lords.items() if l == _md_lord]
                    if any(h in DUSTHANA for h in md_houses):
                        match_count += 1
                    else:
                        matched = False
                elif _md_lord == dl:
                    match_count += 1
                else:
                    matched = False

            # functional_role
            if 'functional_role' in conds:
                fr = conds['functional_role']
                md_role = lp_classifications.get(_md_lord, 'neutral')
                if md_role == fr:
                    match_count += 1
                else:
                    matched = False

            # dasha_antardasha_relation (Vedic 1-indexed forward distance)
            if 'dasha_antardasha_relation' in conds:
                rel = conds['dasha_antardasha_relation']
                if _md_lord and _ad_lord and _md_lord in planets and _ad_lord in planets:
                    md_h = planets[_md_lord].get('house', 0)
                    ad_h = planets[_ad_lord].get('house', 0)
                    diff = _house_distance(md_h, ad_h) if md_h and ad_h else 0
                    if rel == '6_8' and diff in (6, 8):
                        match_count += 1
                    elif rel == 'kendra' and diff in (1, 4, 7, 10):
                        match_count += 1
                    elif rel == 'trikona' and diff in (1, 5, 9):
                        match_count += 1
                    else:
                        matched = False
                else:
                    matched = False

            # planet_conjunct
            for pair in conds.get('planet_conjunct', []):
                pair_list = list(pair)
                if len(pair_list) == 2:
                    p1, p2 = pair_list
                    p1h = planets.get(p1, {}).get('house', 0)
                    p2h = planets.get(p2, {}).get('house', 0)
                    if p1h and p2h and p1h == p2h:
                        match_count += 1
                    else:
                        matched = False

            # sade_sati
            if conds.get('sade_sati') and not transit_data.get('sade_sati'):
                matched = False
            elif conds.get('sade_sati'):
                match_count += 1

            # lagna restriction
            if 'lagna' in conds:
                lag = conds['lagna']
                if isinstance(lag, list):
                    if lagna not in lag:
                        matched = False
                    else:
                        match_count += 1
                elif lagna != lag:
                    matched = False
                else:
                    match_count += 1

            # from_arudha: check if the referenced Arudha Pada exists
            if 'from_arudha' in conds:
                arudha_ref = conds['from_arudha']
                arudha_padas = stages.get('arudha', {}).get('arudha_padas', {})
                if arudha_padas.get(arudha_ref):
                    match_count += 1
                else:
                    matched = False

            # karaka: check if a specific karaka role matches a condition
            if 'karaka' in conds:
                karaka_role = conds['karaka']
                karaka_data = stages.get('karakas', {}).get('chara_karakas', {})
                karaka_map = {'AK': 'Atma Karaka', 'DK': 'Dara Karaka', 'AmK': 'Amatya Karaka',
                             'BK': 'Bhratri Karaka', 'MK': 'Matri Karaka', 'PK': 'Putra Karaka',
                             'GK': 'Gnati Karaka'}
                full_role = karaka_map.get(karaka_role, karaka_role)
                karaka_planet = karaka_data.get(full_role, '')
                if karaka_planet:
                    match_count += 1
                else:
                    matched = False

            # Skip divisional conditions we can't fully check yet
            if 'divisional' in conds:
                d10_avail = stages.get('d10', {}).get('d10_available', False)
                div = conds['divisional']
                if div == 'D10' and d10_avail:
                    match_count += 1
                else:
                    continue  # skip patterns requiring other divisionals

            if matched and match_count >= 1:
                boost = pat['confidence_boost']
                # Scale boost by number of conditions matched
                total_conds = len([k for k in conds if k not in ('divisional',)])
                if total_conds > 0:
                    boost *= min(match_count / total_conds, 1.0)
                outcome = pat['outcome']
                # Guard: yogakaraka career peak is negated when AD lord is maraka or 8th owner
                if pat['name'] == 'yogakaraka_dasha_career_peak' and outcome == 'positive' and _ad_lord:
                    _ad_h_pat = [h for h, l in house_lords.items() if l == _ad_lord]
                    _ad_lp_pat = lp_classifications.get(_ad_lord, 'neutral')
                    if _ad_lp_pat == 'maraka' or 8 in _ad_h_pat:
                        outcome = 'mixed'
                matches.append((
                    boost,
                    f"Pattern [{pat['name']}]: {pat['description'][:80]}",
                    outcome,
                    pat['name'],
                ))
        return matches

    def _evidence_assessment(house_num: int, key_planet: str,
                             domain: str = '') -> dict:
        """Assess evidence using the Master Reasoning Framework hierarchy.
        Returns weighted evidence for/against with contradiction detection.
        domain: life area key for case-study pattern matching (Phase 4D)."""
        evidence_for = []   # (weight, description)
        evidence_against = []

        md = dasha_data.get('current_mahadasha', {})
        ad = dasha_data.get('current_antardasha', {})
        md_lord = md.get('lord', '') if md else ''
        ad_lord = ad.get('lord', '') if ad else ''
        md_owned = [h for h, l in house_lords.items() if l == md_lord] if md_lord else []
        ad_owned = [h for h, l in house_lords.items() if l == ad_lord] if ad_lord else []

        # ── Tier 1: Dasha alignment (weight 10) — STRONGEST ──
        w = EVIDENCE_TIERS['dasha']
        dasha_active = False
        if md_lord == key_planet or house_num in md_owned:
            evidence_for.append((w, f'Dasha: MD lord {md_lord} activates house {house_num}'))
            dasha_active = True
        elif ad_lord == key_planet or house_num in ad_owned:
            evidence_for.append((w * 0.7, f'Dasha: AD lord {ad_lord} activates house {house_num}'))
            dasha_active = True
        # Dasha lord LP role check
        if md_lord:
            md_role = lp_classifications.get(md_lord, 'neutral')
            if md_role in ('maraka', 'direly_evil') and dasha_active:
                evidence_against.append((w * 0.5, f'But MD lord {md_lord} is {md_role} (LP)'))

        # ── Extended Tier 1: Dasha placement & aspect ──
        if not dasha_active and md_lord and md_lord in planets:
            md_placement = planets[md_lord].get('house', 0)
            if md_placement == house_num:
                evidence_for.append((w * 0.5, f'Dasha: MD lord {md_lord} placed in house {house_num}'))
                dasha_active = True
            elif md_placement > 0:
                aspects = GRAHA_DRISHTI.get(md_lord, [7])
                aspected_h = [(md_placement + a - 1) % 12 + 1 for a in aspects]
                if house_num in aspected_h:
                    evidence_for.append((w * 0.3, f'Dasha: MD lord {md_lord} aspects house {house_num}'))
                    dasha_active = True

        # ── Domain-specific dasha activation ──
        if md_lord and domain:
            # Marriage: Venus/Jupiter as natural karakas
            if domain in ('marriage_timing', 'marriage_problems'):
                if md_lord == 'Venus' and not dasha_active:
                    evidence_for.append((w * 0.7, 'Venus dasha — natural marriage karaka'))
                    dasha_active = True
                elif md_lord == 'Jupiter' and not dasha_active:
                    evidence_for.append((w * 0.3, 'Jupiter dasha — benefic marriage support'))
                dk = stages.get('karakas', {}).get('chara_karakas', {}).get('Dara Karaka', '')
                if dk and md_lord == dk and not dasha_active:
                    evidence_for.append((w * 0.5, f'MD lord {md_lord} is Dara Karaka'))
                    dasha_active = True

            # Wealth: multi-house (2, 5, 9, 11) and natural indicator
            if domain == 'wealth':
                wealth_extra = [h for h in md_owned if h in {5, 9, 11} and h != house_num]
                if wealth_extra and not dasha_active:
                    evidence_for.append((w * 0.6, f'MD lord {md_lord} owns wealth houses {wealth_extra}'))
                    dasha_active = True
                if md_lord == 'Jupiter':
                    evidence_for.append((w * 0.4, 'Jupiter dasha — natural wealth indicator'))
                if md_lord in planets:
                    _md_h = planets[md_lord].get('house', 0)
                    if _md_h in {2, 5, 9, 11} and not dasha_active:
                        evidence_for.append((w * 0.5, f'MD lord {md_lord} in wealth house {_md_h}'))
                        dasha_active = True

        # ── Tier 2: D-1 + D-9 confirmation (weight 8) ──
        w = EVIDENCE_TIERS['d1_d9']
        conf = d1_d9_conf.get(key_planet, '')
        pdata = planets.get(key_planet, {})
        d1_strong = pdata.get('strength') in ('strong',) or pdata.get('dignity') in ('exalted', 'own_sign')
        if conf == 'confirmed' and d1_strong:
            evidence_for.append((w, f'D-1+D-9: {key_planet} strong AND confirmed in Navamsha'))
        elif conf == 'confirmed':
            evidence_for.append((w * 0.7, f'D-9: {key_planet} confirmed in Navamsha'))
        elif conf == 'negated':
            evidence_against.append((w, f'D-9: {key_planet} NEGATED in Navamsha'))
        elif d1_strong:
            evidence_for.append((w * 0.5, f'D-1: {key_planet} is strong (D-9 unconfirmed)'))

        # ── Tier 3: Double Transit (weight 7) ──
        w = EVIDENCE_TIERS['double_transit']
        if house_num in double_transit_houses:
            evidence_for.append((w, f'Double Transit: Jupiter+Saturn activate house {house_num}'))

        # ── Tier 4: Functional nature / LP (weight 6) ──
        w = EVIDENCE_TIERS['functional']
        role = lp_classifications.get(key_planet, 'neutral')
        role_order = _LP_ROLE_ORDER.get(role, 3)
        # Domain override: 7th lord maraka is GOOD for marriage (it's the marriage house lord)
        _lp_domain_override = False
        if domain in ('marriage_timing', 'marriage_problems') and role == 'maraka':
            _kp_houses = [h for h, l in house_lords.items() if l == key_planet]
            if 7 in _kp_houses:
                evidence_for.append((w * 0.5, f'LP: {key_planet} is 7th lord — marriage significator'))
                _lp_domain_override = True
        if not _lp_domain_override:
            if role_order >= 5:  # yogakaraka or auspicious
                evidence_for.append((w, f'LP: {key_planet} is {role} for {lagna}'))
            elif role_order >= 4:  # blemished auspicious
                evidence_for.append((w * 0.6, f'LP: {key_planet} is {role} for {lagna}'))
            elif role_order <= 1:  # maraka or direly_evil
                evidence_against.append((w, f'LP: {key_planet} is {role} for {lagna}'))
            elif role_order == 2:  # inauspicious
                evidence_against.append((w * 0.6, f'LP: {key_planet} is {role} for {lagna}'))

        # ── Tier 5: Yoga activation (weight 5) ──
        w = EVIDENCE_TIERS['yoga']
        if key_planet == yogakaraka:
            evidence_for.append((w, f'Yogakaraka: {key_planet} for {lagna}'))
        for ya in yoga_activation:
            if key_planet in ya:
                evidence_for.append((w * 0.7, f'Active yoga: {ya}'))
                break
        # Check detected yogas involving key_planet
        yoga_counted = False
        for dy in detected_yogas:
            dy_planets = dy.get('planets', [])
            if key_planet in dy_planets:
                yt = dy.get('type', '')
                if yt in ('raja_yoga', 'neechabhanga', 'viparita_raja'):
                    evidence_for.append((w * 0.8, f'Detected {dy["yoga"]}'))
                    yoga_counted = True
                    break
                elif yt == 'dhana_yoga' and house_num in (2, 11):
                    evidence_for.append((w * 0.7, f'Detected {dy["yoga"]}'))
                    yoga_counted = True
                    break
                elif dy.get('outcome') == 'negative':
                    evidence_against.append((w * 0.5, f'Detected {dy["yoga"]}'))
                    yoga_counted = True
                    break

        # ── Tier 5b: D-10 Dashamsha career evidence (weight 4) ──
        d10_data = stages.get('d10', {})
        if d10_data.get('d10_available') and domain in ('career_rise', 'career_fall'):
            w = EVIDENCE_TIERS['d10']
            d10_findings = d10_data.get('findings', [])
            for df in d10_findings:
                conf = df.get('confidence', 0.7)
                if 'success' in df.get('implication', '').lower() or 'peak' in df.get('implication', '').lower():
                    evidence_for.append((w * conf, f'D-10: {df["factor"]}'))
                elif 'challenge' in df.get('implication', '').lower() or 'limits' in df.get('implication', '').lower():
                    evidence_against.append((w * conf, f'D-10: {df["factor"]}'))
                else:
                    evidence_for.append((w * conf * 0.7, f'D-10: {df["factor"]}'))

        # ── Tier 5c: Arudha Pada evidence (weight 3) ──
        arudha_data = stages.get('arudha', {})
        arudha_findings = arudha_data.get('findings', [])
        if arudha_findings:
            w = EVIDENCE_TIERS['arudha']
            for af in arudha_findings:
                impl = af.get('implication', '').lower()
                af_conf = af.get('confidence', 0.7)
                if 'power' in impl or 'authority' in impl or 'lasting' in impl:
                    evidence_for.append((w * af_conf, f'Arudha: {af["factor"]}'))
                elif 'loss' in impl or 'stress' in impl or 'challenge' in impl:
                    evidence_against.append((w * af_conf, f'Arudha: {af["factor"]}'))

        # ── Tier 6: Static strength (weight 3) ──
        w = EVIDENCE_TIERS['static']
        if pdata.get('strength') == 'strong':
            evidence_for.append((w, f'Static: {key_planet} has strong shadbala'))
        elif pdata.get('strength') == 'weak':
            evidence_against.append((w, f'Static: {key_planet} is weak'))
        if pdata.get('combust'):
            evidence_against.append((w * 0.7, f'Static: {key_planet} is combust'))
        if pdata.get('mks'):
            evidence_against.append((w * 1.2, f'Static: {key_planet} in Marana Karaka Sthana'))

        # ── Tier 6b: Ashtakavarga transit quality (weight 2) ──
        avk = stages.get('ashtakavarga_scores', {})
        if key_planet in avk:
            w = EVIDENCE_TIERS['ashtakavarga']
            kp_avk = avk[key_planet]
            quality = kp_avk.get('quality', '')
            if quality in ('excellent', 'good'):
                evidence_for.append((w, f'Ashtakavarga: {key_planet} transit has {kp_avk.get("bindus", "?")} bindus ({quality})'))
            elif quality in ('difficult', 'very_difficult'):
                evidence_against.append((w, f'Ashtakavarga: {key_planet} transit has {kp_avk.get("bindus", "?")} bindus ({quality})'))

        # ── Tier 6c: Multi-Dasha (informational only) ──
        # Yogini name-based quality (Mangala/Siddha=good, Sankata/Ulka=bad) does NOT
        # reliably predict domain outcomes — ignores functional role. Leaders with
        # "difficult" Yogini during career rise are common. Evidence scoring disabled.

        # ── Tier 7: Case-study pattern matching (Phase 4D, weight 4) ──
        pattern_matches = []
        if domain:
            # Check positive and negative domain patterns
            for dom in [domain]:
                pm = _match_case_patterns(dom, house_num, key_planet)
                pattern_matches.extend(pm)
            # Also check fall/problem patterns for the opposite signal
            neg_domain = {'career_rise': 'career_fall',
                          'marriage_timing': 'marriage_problems',
                          }.get(domain, '')
            if neg_domain:
                pm = _match_case_patterns(neg_domain, house_num, key_planet)
                pattern_matches.extend(pm)
            # Methodology patterns always apply
            pm = _match_case_patterns('methodology', house_num, key_planet)
            pattern_matches.extend(pm)

            for boost, desc, outcome, pname in pattern_matches:
                w_pat = 4 * boost / 0.15  # normalize: max pattern boost 0.15 -> weight 4
                w_pat = min(w_pat, 4)
                if outcome == 'positive':
                    evidence_for.append((w_pat, desc))
                elif outcome == 'negative':
                    evidence_against.append((w_pat, desc))
                else:  # mixed
                    evidence_for.append((w_pat * 0.5, f'{desc} (mixed)'))

        # ── Contradiction resolution (Phase 4B) ──
        total_for = sum(w for w, _ in evidence_for)
        total_against = sum(w for w, _ in evidence_against)
        max_possible = sum(EVIDENCE_TIERS.values())  # 40

        contradictions = []
        if evidence_for and evidence_against:
            # Check if higher-tier evidence contradicts lower
            highest_for = max(w for w, _ in evidence_for) if evidence_for else 0
            highest_against = max(w for w, _ in evidence_against) if evidence_against else 0
            if highest_for >= 7 and highest_against >= 7:
                contradictions.append('High-tier evidence conflicts — D-9 is tiebreaker')
            elif highest_for > highest_against:
                contradictions.append(f'Higher tier supports positive ({highest_for:.0f} vs {highest_against:.0f})')
            elif highest_against > highest_for:
                contradictions.append(f'Higher tier supports negative ({highest_against:.0f} vs {highest_for:.0f})')

        # Net confidence calculation
        net = total_for - total_against
        confidence = 0.5 + (net / max_possible) * 0.45
        confidence = max(0.15, min(confidence, 0.95))

        # Direction
        if net > 2:
            direction = 'positive'
        elif net < -2:
            direction = 'negative'
        else:
            direction = 'mixed'

        # Count equivalent "confirmations" for backward compat
        confirmations = len(evidence_for)

        descs = [d for _, d in evidence_for] + [f'AGAINST: {d}' for _, d in evidence_against]

        return {
            'direction': direction,
            'confidence': round(confidence, 2),
            'confirmations': confirmations,
            'descs': descs,
            'evidence_for': evidence_for,
            'evidence_against': evidence_against,
            'contradictions': contradictions,
            'net_score': round(net, 1),
            'pattern_matches': pattern_matches,
        }

    # Career prediction
    tenth_lord = house_lords.get(10, '')
    tenth_data = planets.get(tenth_lord, {})
    tenth_house_planets = verified['houses'].get(10, [])
    career_ev = _evidence_assessment(10, tenth_lord, domain='career_rise')
    career_notes = []

    # ── Career Period Quality Assessment ──
    # Dasha lord's LP nature directly impacts career direction
    _md_for_career = dasha_data.get('current_mahadasha', {})
    _md_lord_c = _md_for_career.get('lord', '') if _md_for_career else ''
    _career_danger = 0
    _career_danger_notes = []
    _ad_for_career = dasha_data.get('current_antardasha', {})
    _ad_lord_c = _ad_for_career.get('lord', '') if _ad_for_career else ''
    if _md_lord_c:
        _md_lp_c = lp_classifications.get(_md_lord_c, 'neutral')
        _md_lp_order_c = _LP_ROLE_ORDER.get(_md_lp_c, 3)
        _md_houses_c = _effective_houses(_md_lord_c, house_lords, verified)

        # Positive dasha quality
        if _md_lord_c == yogakaraka:
            career_ev['evidence_for'].append((8, f'Yogakaraka {_md_lord_c} dasha — peak career period'))
        elif _md_lp_order_c >= 5:  # auspicious
            career_ev['evidence_for'].append((5, f'{_md_lord_c} dasha (LP: {_md_lp_c}) supports career'))
        elif _md_lp_order_c >= 4:  # auspicious_blemished
            career_ev['evidence_for'].append((3, f'{_md_lord_c} dasha (LP: {_md_lp_c}) moderately supports career'))
        # Lagna lord dasha boost — lagna lord period supports all endeavors
        if _md_lord_c == house_lords.get(1, ''):
            _ll_data = planets.get(_md_lord_c, {})
            if _ll_data.get('dignity') in ('exalted', 'own_sign') or _ll_data.get('strength') == 'strong':
                career_ev['evidence_for'].append((5, f'Lagna lord {_md_lord_c} dasha — strong self supports career'))
            elif _md_lp_order_c >= 3:  # not maraka/inauspicious
                career_ev['evidence_for'].append((3, f'Lagna lord {_md_lord_c} dasha — self-directed period'))
        # MD lord placed in kendra/trikona → career relevance
        if _md_lord_c in planets:
            _md_career_h = planets[_md_lord_c].get('house', 0)
            if _md_career_h in KENDRA and _md_career_h != 1:  # in angular house (not lagna itself)
                career_ev['evidence_for'].append((4, f'MD lord {_md_lord_c} in kendra house {_md_career_h}'))
            elif _md_career_h in TRIKONA and _md_career_h != 1:  # in trine
                career_ev['evidence_for'].append((3, f'MD lord {_md_lord_c} in trikona house {_md_career_h}'))

    # Raja Yoga involving lagna lord + 10th lord = strongest career indicator (BPHS)
    # Raja Yoga fructifies only in yoga-lord's dasha — check activation (BPHS)
    _lagna_lord_c = house_lords.get(1, '')
    _detected_raja_c = [dy for dy in detected_yogas if dy.get('type') == 'raja_yoga']
    for _dry_c in _detected_raja_c:
        _dry_c_pl = _dry_c.get('planets', [])
        _yoga_activated = any(p in (_md_lord_c, _ad_lord_c) for p in _dry_c_pl)
        if tenth_lord in _dry_c_pl and _lagna_lord_c in _dry_c_pl:
            if _yoga_activated:
                career_ev['evidence_for'].append((6, f'Raja Yoga: {_lagna_lord_c}+{tenth_lord} ACTIVATED in current dasha'))
            else:
                career_ev['evidence_for'].append((2, f'Raja Yoga: {_lagna_lord_c}+{tenth_lord} (promise only — not activated in dasha)'))
            break
        elif tenth_lord in _dry_c_pl:
            if _yoga_activated:
                career_ev['evidence_for'].append((3, f'Raja Yoga involving 10th lord {tenth_lord} — activated'))
            else:
                career_ev['evidence_for'].append((1, f'Raja Yoga involving 10th lord {tenth_lord} — promise only'))
            break

    # ── D-9 Career 10th Lord Check ──
    _career_d9 = stages.get('navamsha', {}).get('career_d9')
    if _career_d9 == 'confirmed':
        career_ev['evidence_for'].append((4.8, 'D-9: career 10th lord confirmed in Navamsha'))
    elif _career_d9 == 'negated':
        career_ev['evidence_against'].append((4.8, 'D-9: career 10th lord negated in Navamsha'))

    # ── 10th Lord in Dusthana ──
    _tenth_lord_house = tenth_data.get('house', 0)
    if _tenth_lord_house in DUSTHANA:
        # Guard: malefic in 6th (upachaya) does well — reduce weight
        if tenth_lord in NATURAL_MALEFICS and _tenth_lord_house == 6:
            career_ev['evidence_against'].append((1, f'10th lord {tenth_lord} in 6th (upachaya — malefic okay)'))
        else:
            career_ev['evidence_against'].append((2, f'10th lord {tenth_lord} in dusthana house {_tenth_lord_house}'))

    # ── Malefics in 10th House Scoring ──
    _yogakaraka_lagna = YOGAKARAKA.get(lagna, '')
    for _p10 in tenth_house_planets:
        _p10_dig = planets.get(_p10, {}).get('dignity', '')
        if _p10 == _yogakaraka_lagna:
            # Yogakaraka in 10th is strongly positive regardless of malefic nature
            career_ev['evidence_for'].append((3, f'Yogakaraka {_p10} in 10th house'))
        elif _p10 == 'Saturn':
            # Saturn is natural karaka of 10th — presence in 10th is not inherently negative
            if _p10_dig in ('exalted', 'own_sign'):
                career_ev['evidence_for'].append((2, f'Saturn exalted/own in 10th — Shasha Yoga, strong authority'))
            elif _p10_dig == 'debilitated':
                career_ev['evidence_against'].append((2, f'Saturn debilitated in 10th — career instability'))
            # Otherwise neutral — Saturn as karaka in own karaka house
        elif _p10 in ('Rahu', 'Ketu'):
            if _p10_dig in ('exalted', 'own_sign'):
                career_ev['evidence_for'].append((1.5, f'{_p10} exalted/own in 10th — structured authority'))
            else:
                career_ev['evidence_against'].append((1.5, f'Malefic {_p10} in 10th house'))
        elif _p10 == 'Mars':
            if _p10_dig in ('exalted', 'own_sign'):
                career_ev['evidence_for'].append((3, f'Mars exalted/own in 10th — Ruchaka strength'))
            else:
                career_ev['evidence_against'].append((1.5, f'Mars in 10th (not exalted/own)'))
        elif _p10 == 'Sun':
            career_ev['evidence_for'].append((2, 'Sun in 10th — digbala, authority'))

    # 8th house ownership = transformation/upheaval regardless of LP classification
    # Classical: 8th lord dasha brings sudden change even when planet also owns trikona
    if _md_lord_c and 8 in _md_houses_c:
        career_ev['evidence_against'].append((4, f'MD lord {_md_lord_c} owns 8th house — career transformation risk'))

    if _md_lord_c:
        # Negative: maraka/direly_evil dasha = career danger
        if _md_lp_order_c <= 0:  # direly_evil
            _career_danger += 10
            _career_danger_notes.append(f'{_md_lord_c} dasha — direly evil, career disruption')
        elif _md_lp_order_c <= 1:  # maraka
            _career_danger += 8
            _career_danger_notes.append(f'{_md_lord_c} dasha — maraka, career challenges')
        if 8 in _md_houses_c and _md_lp_order_c <= 2:
            _career_danger += 5
            _career_danger_notes.append(f'{_md_lord_c} owns 8th house — career transformation')

        # Rahu/Ketu dispositor — natural malefic nodes need strong dispositor support
        if _md_lord_c in ('Rahu', 'Ketu') and _md_lord_c in planets:
            _cd_sign = planets[_md_lord_c].get('rashi', '')
            _cd_disp = RASHI_LORDS.get(_cd_sign, '')
            if _cd_disp:
                _cd_lp = lp_classifications.get(_cd_disp, 'neutral')
                _cd_lp_order = _LP_ROLE_ORDER.get(_cd_lp, 3)
                if _cd_lp_order <= 1:
                    _career_danger += 6
                    _career_danger_notes.append(f'{_md_lord_c} dispositor {_cd_disp} is {_cd_lp}')
                elif _cd_lp_order < 4:
                    # Dispositor lacks auspicious support — node period carries inherent risk
                    _career_danger += 2
                    _career_danger_notes.append(f'{_md_lord_c} as natural malefic — dispositor {_cd_disp} ({_cd_lp}) lacks strong support')

        # 12th lord MD = losses, expenditure, seclusion (BPHS ch.34)
        if 12 in _md_houses_c and _md_lp_order_c <= 3:
            _md_in_kt = False
            if _md_lord_c in planets:
                _md_house_pos = planets[_md_lord_c].get('house', 0)
                _md_in_kt = _md_house_pos in KENDRA or _md_house_pos in TRIKONA
            if _md_in_kt:
                _career_danger += 1
                _career_danger_notes.append(f'{_md_lord_c} owns 12th — losses (mitigated by kendra/trikona placement)')
            else:
                _career_danger += 3
                _career_danger_notes.append(f'{_md_lord_c} owns 12th house — losses, withdrawal, seclusion')

    # AD lord career danger — 8th lord AD is strongest career threat
    if _ad_lord_c:
        _ad_lp_c = lp_classifications.get(_ad_lord_c, 'neutral')
        _ad_lp_order_c = _LP_ROLE_ORDER.get(_ad_lp_c, 3)
        _ad_houses_c = [h for h, l in house_lords.items() if l == _ad_lord_c]
        if 8 in _ad_houses_c:
            _career_danger += 5
            _career_danger_notes.append(f'AD lord {_ad_lord_c} owns 8th house — career upheaval')
        if 6 in _ad_houses_c and _ad_lp_order_c <= 1:
            _career_danger += 2
            _career_danger_notes.append(f'AD lord {_ad_lord_c} owns 6th — enemies/obstacles')
        if 12 in _ad_houses_c and _ad_lp_order_c <= 1:
            _career_danger += 2
            _career_danger_notes.append(f'AD lord {_ad_lord_c} owns 12th — losses/withdrawal')
        # AD maraka override: in auspicious/yogakaraka MD, maraka AD brings reversal
        # (BV Raman, Hindu Predictive Astrology ch.20)
        # Guard: only applies when MD itself is auspicious — if MD is already inauspicious,
        # the AD maraka is redundant (danger already captured by MD checks)
        if any(h in (2, 7) for h in _ad_houses_c) and _ad_lp_order_c <= 1 and _md_lp_order_c >= 4:
            _maraka_houses = [h for h in _ad_houses_c if h in (2, 7)]
            # Double maraka (owns both 2nd+7th) = strongest death-inflicting planet (BPHS ch.44)
            _ad_maraka_penalty = 7 if len(_maraka_houses) == 2 else 5
            _career_danger += _ad_maraka_penalty
            _career_danger_notes.append(f'AD lord {_ad_lord_c} owns maraka house(s) {_maraka_houses} — reversal in sub-period')

    # MD-AD natural enmity — conflicting sub-period brings friction
    # (Parashara on planetary friendships: enemy dasha-antardasha = obstacles)
    if _md_lord_c and _ad_lord_c and _md_lord_c != _ad_lord_c:
        if _ad_lord_c in NATURAL_ENEMIES.get(_md_lord_c, set()):
            _career_danger += 2
            _career_danger_notes.append(f'MD {_md_lord_c} and AD {_ad_lord_c} are natural enemies — sub-period friction')

    # Exalted MD lord mitigates maraka/dusthana danger — classical principle:
    # exaltation strength partially overcomes negative house ownership
    if _md_lord_c and _career_danger > 0 and _md_lord_c in planets:
        if planets[_md_lord_c].get('dignity') == 'exalted':
            _career_danger = max(0, _career_danger - 3)
            _career_danger_notes.append(f'{_md_lord_c} exalted — mitigates danger')

    # Always add career danger to evidence_against (so recalculation incorporates it)
    if _career_danger_notes:
        for _cdn in _career_danger_notes:
            career_ev['evidence_against'].append((_career_danger / max(len(_career_danger_notes), 1), _cdn))
        career_notes.extend(_career_danger_notes)

    # career_danger >= 8 threshold: a single maraka (8) or direly_evil (10) dasha,
    # or combined factors (e.g. maraka MD + 8th-owner AD = 8+5=13) override net evidence.
    # Rationale: BV Raman ch.20 — maraka dasha overrides all positive indicators.
    # Exaltation mitigates by 3 (BPHS: uccha bala partially overcomes negative ownership).
    if _md_lord_c and _career_danger >= 8:
        career_ev['direction'] = 'negative'
        career_ev['confidence'] = round(max(0.35, 0.5 + _career_danger * 0.02), 2)
        career_ev['net_score'] = round(-_career_danger, 1)
    else:
        # ── Recalculate net_score/direction from all evidence including danger ──
        _c_for = sum(w for w, _ in career_ev['evidence_for'])
        _c_against = sum(w for w, _ in career_ev['evidence_against'])
        _c_net = _c_for - _c_against
        _c_max = sum(EVIDENCE_TIERS.values())
        career_ev['net_score'] = round(_c_net, 1)
        career_ev['confidence'] = round(max(0.15, min(0.95, 0.5 + (_c_net / _c_max) * 0.45)), 2)
        if _c_net > 2:
            career_ev['direction'] = 'positive'
        elif _c_net < -2:
            career_ev['direction'] = 'negative'
        else:
            career_ev['direction'] = 'mixed'

    if tenth_data.get('strength') == 'strong':
        career_notes.append(f'10th lord {tenth_lord} is strong — career success likely')
    elif tenth_data.get('strength') == 'weak':
        career_notes.append(f'10th lord {tenth_lord} is weak — career requires extra effort')
    if tenth_house_planets:
        career_notes.append(f'Planets in 10th: {", ".join(tenth_house_planets)}')
    amk = stages.get('karakas', {}).get('chara_karakas', {}).get('Amatya Karaka', '')
    if amk:
        amk_data = planets.get(amk, {})
        amk_house = amk_data.get('house', 0)
        if amk_house in KENDRA:
            career_notes.append(f'Amatya Karaka {amk} in Kendra — strong career manifestation')
        career_notes.append(f'Career direction influenced by {amk} (AmK)')
    # D-10 career confirmation
    d10_s = stages.get('d10', {})
    if d10_s.get('d10_available'):
        for df in d10_s.get('findings', []):
            career_notes.append(f'D-10: {df["factor"]}')
    # Argala on 10th house — planetary intervention on career (Sanjay Rath, Crux of Vedic Astrology)
    _argala_10 = _argala_analysis(10, verified)
    if _argala_10['subhargala']:
        career_ev['evidence_for'].append((2, f'Benefic argala on 10th: {", ".join(p for p, _, _ in _argala_10["subhargala"])}'))
    if _argala_10['papargala']:
        career_ev['evidence_against'].append((2, f'Malefic argala on 10th: {", ".join(p for p, _, _ in _argala_10["papargala"])}'))
    # A10 (Rajyapada) career image — add evidence scoring (weight 2.4)
    a10_sign = stages.get('arudha', {}).get('arudha_padas', {}).get('A10')
    if a10_sign:
        _a10_loc = 'dusthana' if a10_sign in DUSTHANA else ('kendra' if a10_sign in KENDRA else 'other')
        career_notes.append(f'A10 (career image) in house {a10_sign} ({_a10_loc})')
        if a10_sign in KENDRA:
            career_ev['evidence_for'].append((1.5, f'A10 in kendra (house {a10_sign})'))
        # Recalculate after A10 (only if not in danger-override mode)
        if not (_md_lord_c and _career_danger >= 8):
            _c_for = sum(w for w, _ in career_ev['evidence_for'])
            _c_against = sum(w for w, _ in career_ev['evidence_against'])
            _c_net = _c_for - _c_against
            _c_max = sum(EVIDENCE_TIERS.values())
            career_ev['net_score'] = round(_c_net, 1)
            career_ev['confidence'] = round(max(0.15, min(0.95, 0.5 + (_c_net / _c_max) * 0.45)), 2)
            if _c_net > 2:
                career_ev['direction'] = 'positive'
            elif _c_net < -2:
                career_ev['direction'] = 'negative'
            else:
                career_ev['direction'] = 'mixed'
    if career_ev['contradictions']:
        career_notes.append(f'Contradictions: {"; ".join(career_ev["contradictions"])}')
    if career_ev.get('pattern_matches'):
        career_notes.append(f'Case patterns: {"; ".join(n for _, _, _, n in career_ev["pattern_matches"])}')
    career_notes.append(f'Evidence ({career_ev["confirmations"]} for, {len(career_ev["evidence_against"])} against): '
                        f'{"; ".join(career_ev["descs"][:5])}')

    predictions.append({
        'area': 'Career',
        'summary': '. '.join(career_notes),
        'house': 10,
        'key_planets': list(set([tenth_lord] + tenth_house_planets + ([amk] if amk else []))),
        'confirmations': career_ev['confirmations'],
        'confidence': career_ev['confidence'],
        'direction': career_ev['direction'],
        'net_score': career_ev['net_score'],
        'case_patterns': [n for _, _, _, n in career_ev.get('pattern_matches', [])],
    })

    # Marriage prediction
    seventh_lord = house_lords.get(7, '')
    seventh_data = planets.get(seventh_lord, {})
    seventh_planets = verified['houses'].get(7, [])
    marriage_ev = _evidence_assessment(7, seventh_lord, domain='marriage_timing')
    marriage_notes = []

    # ── Marriage quality adjustment — malefics in 7th ──
    _malefics_in_7th = [p for p in seventh_planets if p in NATURAL_MALEFICS]
    if _malefics_in_7th:
        for _m7 in _malefics_in_7th:
            marriage_ev['evidence_against'].append((6, f'Malefic {_m7} in 7th — relationship stress'))
    # 7th lord as natural malefic with dusthana ownership
    if seventh_lord in NATURAL_MALEFICS:
        marriage_ev['evidence_against'].append((4, f'7th lord {seventh_lord} is a natural malefic'))
        _7l_houses = [h for h, l in house_lords.items() if l == seventh_lord]
        if any(h in DUSTHANA for h in _7l_houses):
            marriage_ev['evidence_against'].append((3, f'7th lord {seventh_lord} also owns dusthana'))
    # Recalculate marriage direction after adjustments
    if _malefics_in_7th or seventh_lord in NATURAL_MALEFICS:
        _m_for = sum(w for w, _ in marriage_ev['evidence_for'])
        _m_against = sum(w for w, _ in marriage_ev['evidence_against'])
        _m_net = _m_for - _m_against
        _m_max = sum(EVIDENCE_TIERS.values())
        marriage_ev['confidence'] = round(max(0.15, min(0.95, 0.5 + (_m_net / _m_max) * 0.45)), 2)
        marriage_ev['net_score'] = round(_m_net, 1)
        if _m_net > 2:
            marriage_ev['direction'] = 'positive'
        elif _m_net < -2:
            marriage_ev['direction'] = 'negative'
        else:
            marriage_ev['direction'] = 'mixed'

    # ── Marriage dasha timing override ──
    _md_marriage = dasha_data.get('current_mahadasha', {})
    _md_lord_m = _md_marriage.get('lord', '') if _md_marriage else ''
    _ad_marriage = dasha_data.get('current_antardasha', {})
    _ad_lord_m = _ad_marriage.get('lord', '') if _ad_marriage else ''
    _marriage_dasha_boost = False
    # Venus dasha = strongest marriage timing indicator
    if _md_lord_m == 'Venus':
        _venus_lp = lp_classifications.get('Venus', 'neutral')
        _venus_order = _LP_ROLE_ORDER.get(_venus_lp, 3)
        marriage_ev['evidence_for'].append((8, 'Venus Mahadasha — strongest marriage timing'))
        if _venus_order >= 5:
            marriage_ev['evidence_for'].append((4, f'Venus is {_venus_lp} — auspicious marriage period'))
        _marriage_dasha_boost = True
    # Lagna lord dasha — marriage can occur during self-focused periods
    if _md_lord_m == house_lords.get(1, '') and not _marriage_dasha_boost:
        marriage_ev['evidence_for'].append((4, f'Lagna lord {_md_lord_m} dasha — self-actualization supports marriage'))
        _marriage_dasha_boost = True
    # 7th lord dasha — activates marriage, but malefics bring conflict
    if _md_lord_m == seventh_lord and not _marriage_dasha_boost:
        _NATURAL_MALEFICS_M = {'Sun', 'Mars', 'Saturn', 'Rahu', 'Ketu'}
        if _md_lord_m in _NATURAL_MALEFICS_M:
            marriage_ev['evidence_against'].append((5, f'Malefic 7th lord {_md_lord_m} dasha — activates marriage conflict'))
        else:
            marriage_ev['evidence_for'].append((7, f'7th lord {_md_lord_m} dasha — direct marriage activation'))
        _marriage_dasha_boost = True
    # Rahu/Ketu MD: check if dispositor activates marriage houses (7th, 5th, 1st)
    if _md_lord_m in ('Rahu', 'Ketu') and not _marriage_dasha_boost:
        _disp_m = _dispositor_of(_md_lord_m, verified)
        if _disp_m:
            _disp_m_houses = [h for h, l in house_lords.items() if l == _disp_m]
            if 7 in _disp_m_houses:
                marriage_ev['evidence_for'].append((5, f'{_md_lord_m} dispositor {_disp_m} owns 7th — marriage activation via dispositor'))
                _marriage_dasha_boost = True
            elif _disp_m == 'Venus':
                marriage_ev['evidence_for'].append((4, f'{_md_lord_m} dispositor is Venus — natural marriage karaka'))
                _marriage_dasha_boost = True
            elif 5 in _disp_m_houses:
                marriage_ev['evidence_for'].append((4, f'{_md_lord_m} dispositor {_disp_m} owns 5th — romance via dispositor'))
                _marriage_dasha_boost = True
    # AD lord owns 5th (romance) or 7th (marriage) — sub-period timing
    if _ad_lord_m:
        _ad_m_houses = _effective_houses(_ad_lord_m, house_lords, verified)
        if 7 in _ad_m_houses:
            marriage_ev['evidence_for'].append((6, f'AD lord {_ad_lord_m} owns 7th — marriage sub-period'))
        elif 5 in _ad_m_houses:
            marriage_ev['evidence_for'].append((5, f'AD lord {_ad_lord_m} owns 5th — romance sub-period'))
        # Jupiter AD supports marriage (natural benefic for partnerships)
        if _ad_lord_m == 'Jupiter':
            marriage_ev['evidence_for'].append((3, 'Jupiter antardasha — benefic marriage support'))
    # Recalculate after dasha marriage evidence
    if _marriage_dasha_boost or _ad_lord_m:
        _vm_for = sum(w for w, _ in marriage_ev['evidence_for'])
        _vm_against = sum(w for w, _ in marriage_ev['evidence_against'])
        _vm_net = _vm_for - _vm_against
        _vm_max = sum(EVIDENCE_TIERS.values())
        marriage_ev['net_score'] = round(_vm_net, 1)
        marriage_ev['confidence'] = round(max(0.15, min(0.95, 0.5 + (_vm_net / _vm_max) * 0.45)), 2)
        if _vm_net > 2:
            marriage_ev['direction'] = 'positive'
        elif _vm_net < -2:
            marriage_ev['direction'] = 'negative'
        else:
            marriage_ev['direction'] = 'mixed'

    if seventh_data.get('strength') == 'strong':
        marriage_notes.append(f'7th lord {seventh_lord} is strong — good marriage potential')
    if 'Venus' in seventh_planets or 'Jupiter' in seventh_planets:
        marriage_notes.append('Benefic in 7th house — harmonious partnership')
    elif any(p in seventh_planets for p in ['Saturn', 'Mars', 'Rahu', 'Ketu']):
        marriage_notes.append('Malefic influence on 7th — challenges in relationships')
    dk = stages.get('karakas', {}).get('chara_karakas', {}).get('Dara Karaka', '')
    if dk:
        dk_data = planets.get(dk, {})
        marriage_notes.append(f'Dara Karaka (spouse) is {dk} ({dk_data.get("strength", "moderate")})')
    d9_7th = stages.get('navamsha', {}).get('d9_7th_assessment', '')
    if d9_7th == 'favorable':
        marriage_notes.append('D-9 confirms favorable marriage')
    elif d9_7th == 'challenged':
        marriage_notes.append('D-9 indicates marriage challenges')
    # Upapada Lagna (UL) — marriage sustenance + lord strength
    ul_sign = stages.get('arudha', {}).get('arudha_padas', {}).get('UL')
    if ul_sign:
        marriage_notes.append(f'Upapada Lagna (UL) in house {ul_sign}')
        _ul_lord = house_lords.get(ul_sign, '')
        if _ul_lord:
            _ul_lord_dig = planets.get(_ul_lord, {}).get('dignity', '')
            if _ul_lord_dig in ('exalted', 'own_sign'):
                marriage_ev['evidence_for'].append((3, f'UL lord {_ul_lord} strong ({_ul_lord_dig})'))
            elif _ul_lord_dig == 'debilitated':
                marriage_ev['evidence_against'].append((3, f'UL lord {_ul_lord} debilitated'))
    # A7 (Darapada) — spouse perception
    a7_sign = stages.get('arudha', {}).get('arudha_padas', {}).get('A7')
    if a7_sign:
        marriage_notes.append(f'A7 (Darapada) in house {a7_sign}')
    if marriage_ev['contradictions']:
        marriage_notes.append(f'Contradictions: {"; ".join(marriage_ev["contradictions"])}')
    if marriage_ev.get('pattern_matches'):
        marriage_notes.append(f'Case patterns: {"; ".join(n for _, _, _, n in marriage_ev["pattern_matches"])}')
    marriage_notes.append(f'Evidence ({marriage_ev["confirmations"]} for, {len(marriage_ev["evidence_against"])} against): '
                          f'{"; ".join(marriage_ev["descs"][:5])}')

    predictions.append({
        'area': 'Marriage & Relationships',
        'summary': '. '.join(marriage_notes),
        'house': 7,
        'key_planets': list(set([seventh_lord] + seventh_planets + ([dk] if dk else []))),
        'confirmations': marriage_ev['confirmations'],
        'confidence': marriage_ev['confidence'],
        'direction': marriage_ev['direction'],
        'net_score': marriage_ev['net_score'],
        'case_patterns': [n for _, _, _, n in marriage_ev.get('pattern_matches', [])],
    })

    # Wealth prediction
    second_lord = house_lords.get(2, '')
    eleventh_lord = house_lords.get(11, '')
    ninth_lord = house_lords.get(9, '')
    wealth_ev = _evidence_assessment(2, second_lord, domain='wealth')
    wealth_notes = []

    second_strong = planets.get(second_lord, {}).get('strength') == 'strong'
    eleventh_strong = planets.get(eleventh_lord, {}).get('strength') == 'strong'
    ninth_strong = planets.get(ninth_lord, {}).get('strength') == 'strong'
    if second_strong and eleventh_strong:
        wealth_notes.append(f'Both wealth lords ({second_lord}, {eleventh_lord}) are strong — Dhana Yoga potential')
    elif second_strong or eleventh_strong:
        wealth_notes.append('Partial wealth yoga — moderate financial growth')
    if ninth_strong:
        wealth_notes.append(f'9th lord {ninth_lord} strong — fortune supports wealth')
    # Argala analysis on 2nd house (wealth) — Sanjay Rath
    wealth_argala = _argala_analysis(2, verified)
    if wealth_argala['subhargala']:
        argala_planets = [f'{p[0]} from house {p[1]}' for p in wealth_argala['subhargala']]
        wealth_notes.append(f'Subhargala on wealth: {", ".join(argala_planets)}')
    if wealth_argala['papargala']:
        argala_planets = [f'{p[0]} from house {p[1]}' for p in wealth_argala['papargala']]
        wealth_notes.append(f'Papargala on wealth: {", ".join(argala_planets)}')
    jup_data = planets.get('Jupiter', {})
    if jup_data.get('strength') == 'strong':
        wealth_notes.append('Jupiter strong — natural abundance indicator')

    # ── Wealth dasha quality: MD lord placed in wealth houses ──
    _md_wealth = dasha_data.get('current_mahadasha', {})
    _md_lord_w = _md_wealth.get('lord', '') if _md_wealth else ''
    if _md_lord_w and _md_lord_w in planets:
        _md_w_house = planets[_md_lord_w].get('house', 0)
        _md_w_lp = lp_classifications.get(_md_lord_w, 'neutral')
        _md_w_houses = _effective_houses(_md_lord_w, house_lords, verified)
        _disp_note = ''
        if _md_lord_w in ('Rahu', 'Ketu') and _md_w_houses:
            _disp_note = f' (via dispositor {_dispositor_of(_md_lord_w, verified)})'
        # MD lord placed in wealth house (2, 5, 9, 11)
        if _md_w_house in {2, 5, 9, 11}:
            wealth_ev['evidence_for'].append((6, f'MD lord {_md_lord_w} placed in wealth house {_md_w_house}'))
        # MD lord owns/activates wealth houses (2=dhana, 5=purva-punya, 9=bhagya, 11=labha)
        _w_houses_owned = [h for h in _md_w_houses if h in {2, 5, 9, 11}]
        if _w_houses_owned:
            wealth_ev['evidence_for'].append((5, f'MD lord {_md_lord_w} activates wealth houses {_w_houses_owned}{_disp_note}'))
        # 8th house lord dasha can bring sudden gains
        if 8 in _md_w_houses:
            wealth_ev['evidence_for'].append((3, f'8th lord dasha ({_md_lord_w}) — potential sudden gains{_disp_note}'))
        # Recalculate wealth direction
        _wf = sum(w for w, _ in wealth_ev['evidence_for'])
        _wa = sum(w for w, _ in wealth_ev['evidence_against'])
        _wn = _wf - _wa
        _wm = sum(EVIDENCE_TIERS.values())
        wealth_ev['net_score'] = round(_wn, 1)
        wealth_ev['confidence'] = round(max(0.15, min(0.95, 0.5 + (_wn / _wm) * 0.45)), 2)
        if _wn > 2:
            wealth_ev['direction'] = 'positive'
        elif _wn < -2:
            wealth_ev['direction'] = 'negative'
        else:
            wealth_ev['direction'] = 'mixed'

    # ── A2 (Dhana Pada) for wealth ──
    _a2_house = stages.get('arudha', {}).get('arudha_padas', {}).get('A2')
    if _a2_house:
        if _a2_house in {2, 5, 9, 11}:
            wealth_ev['evidence_for'].append((2.1, f'A2 (Dhana Pada) in wealth house {_a2_house}'))
        elif _a2_house in DUSTHANA:
            wealth_ev['evidence_against'].append((2.1, f'A2 (Dhana Pada) in dusthana house {_a2_house}'))
        # Recalculate after A2
        _wf2 = sum(w for w, _ in wealth_ev['evidence_for'])
        _wa2 = sum(w for w, _ in wealth_ev['evidence_against'])
        _wn2 = _wf2 - _wa2
        wealth_ev['net_score'] = round(_wn2, 1)
        wealth_ev['confidence'] = round(max(0.15, min(0.95, 0.5 + (_wn2 / sum(EVIDENCE_TIERS.values())) * 0.45)), 2)
        if _wn2 > 2:
            wealth_ev['direction'] = 'positive'
        elif _wn2 < -2:
            wealth_ev['direction'] = 'negative'
        else:
            wealth_ev['direction'] = 'mixed'

    if wealth_ev['contradictions']:
        wealth_notes.append(f'Contradictions: {"; ".join(wealth_ev["contradictions"])}')
    if wealth_ev.get('pattern_matches'):
        wealth_notes.append(f'Case patterns: {"; ".join(n for _, _, _, n in wealth_ev["pattern_matches"])}')
    wealth_notes.append(f'Evidence ({wealth_ev["confirmations"]} for, {len(wealth_ev["evidence_against"])} against): '
                        f'{"; ".join(wealth_ev["descs"][:5])}')

    predictions.append({
        'area': 'Wealth & Finance',
        'summary': '. '.join(wealth_notes),
        'house': 2,
        'key_planets': [second_lord, eleventh_lord, ninth_lord],
        'confirmations': wealth_ev['confirmations'],
        'confidence': wealth_ev['confidence'],
        'direction': wealth_ev['direction'],
        'net_score': wealth_ev['net_score'],
        'case_patterns': [n for _, _, _, n in wealth_ev.get('pattern_matches', [])],
    })

    # Health prediction with Maraka awareness (BV Raman + LP)
    lagna_lord = house_lords.get(1, '')
    eighth_lord = house_lords.get(8, '')
    health_ev = _evidence_assessment(1, lagna_lord, domain='health')
    health_notes = []

    if planets.get(lagna_lord, {}).get('strength') == 'strong':
        health_notes.append(f'Lagna lord {lagna_lord} is strong — generally good constitution')
    else:
        health_notes.append(f'Lagna lord {lagna_lord} needs strengthening')
    if 6 in (stages.get('strength', {}).get('weak_houses', [])):
        health_notes.append('6th house weak — immune system needs attention')

    # ── Health Period Danger Assessment (BV Raman + LP + Classical) ──
    # Separates "constitutional strength" from "period danger"
    maraka_2nd = house_lords.get(2, '')
    maraka_7th = house_lords.get(7, '')
    md_lord = dasha_data.get('current_mahadasha', {}).get('lord', '') if dasha_data.get('current_mahadasha') else ''
    ad_lord = dasha_data.get('current_antardasha', {}).get('lord', '') if dasha_data.get('current_antardasha') else ''
    md_role = lp_classifications.get(md_lord, 'neutral')
    _md_houses = _effective_houses(md_lord, house_lords, verified) if md_lord else []
    _ad_houses = _effective_houses(ad_lord, house_lords, verified) if ad_lord else []
    lagna_data = planets.get(lagna_lord, {})
    eighth_data = planets.get(eighth_lord, {})

    danger_score = 0
    danger_notes = []

    # 1. MD lord as LP-confirmed maraka (2nd/7th lord where LP agrees)
    if md_lord in (maraka_2nd, maraka_7th):
        md_lp_order = _LP_ROLE_ORDER.get(md_role, 3)
        if md_lp_order <= 2:  # LP confirms maraka/direly_evil/inauspicious
            danger_score += 10
            danger_notes.append(f'Maraka Dasha: {md_lord} (LP: {md_role})')

    # 2. MD lord owns 8th house (death/transformation)
    if 8 in _md_houses:
        danger_score += 9
        danger_notes.append(f'8th lord dasha: {md_lord}')

    # 3. MD lord owns 6th or 12th
    if 6 in _md_houses:
        danger_score += 5
        danger_notes.append(f'6th lord dasha: {md_lord} — disease activation')
    if 12 in _md_houses:
        danger_score += 4
        danger_notes.append(f'12th lord dasha: {md_lord} — loss/hospitalization')

    # 4. AD lord as maraka or 8th lord
    if ad_lord:
        ad_lp = lp_classifications.get(ad_lord, 'neutral')
        ad_lp_order = _LP_ROLE_ORDER.get(ad_lp, 3)
        if ad_lord in (maraka_2nd, maraka_7th) and ad_lp_order <= 2:
            danger_score += 8
            danger_notes.append(f'Maraka antardasha: {ad_lord}')
        if 8 in _ad_houses:
            danger_score += 8
            danger_notes.append(f'8th lord antardasha: {ad_lord}')
        if 6 in _ad_houses:
            danger_score += 4
            danger_notes.append(f'6th lord antardasha: {ad_lord}')

    # 5. MD lord LP = maraka/direly_evil (if not already counted)
    if md_role in ('direly_evil', 'maraka') and not danger_notes:
        danger_score += 6
        danger_notes.append(f'MD lord {md_lord} LP: {md_role}')

    # 6. MD lord placed in dusthana or maraka sthana
    if md_lord and md_lord in planets:
        md_house_pos = planets[md_lord].get('house', 0)
        if md_house_pos in DUSTHANA:
            danger_score += 4
            danger_notes.append(f'MD lord {md_lord} placed in dusthana house {md_house_pos}')
        elif md_house_pos in MARAKA:
            danger_score += 5
            danger_notes.append(f'MD lord {md_lord} placed in maraka sthana house {md_house_pos}')

    # 7. AD lord placed in 8th house
    if ad_lord and ad_lord in planets:
        ad_house_pos = planets[ad_lord].get('house', 0)
        if ad_house_pos == 8:
            danger_score += 5
            danger_notes.append(f'AD lord {ad_lord} placed in 8th house')

    # 8. Lagna lord debilitated
    if lagna_data.get('dignity') == 'debilitated':
        danger_score += 5
        danger_notes.append(f'Lagna lord {lagna_lord} debilitated')

    # 9. 8th lord weak/debilitated
    if eighth_data.get('strength') == 'weak' or eighth_data.get('dignity') == 'debilitated':
        danger_score += 4
        danger_notes.append(f'8th lord {eighth_lord} weak/debilitated')

    # 10. Natural malefics in or aspecting lagna
    _first_house_planets = verified['houses'].get(1, [])
    _malefics_in_1 = [p for p in _first_house_planets if p in NATURAL_MALEFICS]
    for m in _malefics_in_1:
        danger_score += 3
        danger_notes.append(f'Malefic {m} in lagna')
    for m_name in NATURAL_MALEFICS:
        if m_name in planets and m_name not in _malefics_in_1:
            m_h = planets[m_name].get('house', 0)
            if m_h > 0:
                _asp = GRAHA_DRISHTI.get(m_name, [7])
                _asp_houses = [(m_h + a - 1) % 12 + 1 for a in _asp]
                if 1 in _asp_houses:
                    danger_score += 3
                    danger_notes.append(f'Malefic {m_name} aspects lagna from house {m_h}')

    # 11. Rahu/Ketu dispositor check
    if md_lord in ('Rahu', 'Ketu') and md_lord in planets:
        _md_sign = planets[md_lord].get('rashi', '')
        _dispositor = RASHI_LORDS.get(_md_sign, '')
        if _dispositor:
            _disp_lp = lp_classifications.get(_dispositor, 'neutral')
            if _LP_ROLE_ORDER.get(_disp_lp, 3) <= 1:
                danger_score += 6
                danger_notes.append(f'{md_lord} dispositor {_dispositor} is {_disp_lp}')

    # Override health direction based on danger score
    if danger_score >= 8:
        health_ev['direction'] = 'negative'
        health_ev['confidence'] = round(min(0.90, 0.5 + danger_score * 0.02), 2)
        for dn in danger_notes:
            health_ev['evidence_against'].append((danger_score / max(len(danger_notes), 1), dn))
        health_ev['net_score'] = round(-danger_score, 1)
        health_notes.extend(danger_notes)
    elif danger_score >= 5:
        # Auspicious/yogakaraka dasha mitigates moderate static danger
        _md_lp_health = _LP_ROLE_ORDER.get(lp_classifications.get(md_lord, 'neutral'), 3)
        if _md_lp_health >= 5 and lagna_data.get('dignity') in ('exalted', 'own_sign'):
            # Strong lagna lord + auspicious dasha → static danger doesn't override
            health_notes.extend(danger_notes)
        else:
            if health_ev['direction'] == 'positive':
                health_ev['direction'] = 'mixed'
            health_ev['confidence'] = round(max(0.35, min(0.55, health_ev['confidence'] - 0.10)), 2)
            health_ev['net_score'] = round(health_ev.get('net_score', 0) - danger_score * 0.5, 1)
            for dn in danger_notes:
                health_ev['evidence_against'].append((danger_score / max(len(danger_notes), 1), dn))
            health_notes.extend(danger_notes)
    elif danger_score == 0 and lagna_data.get('dignity') in ('exalted', 'own_sign'):
        # No period danger + strong lagna lord → positive floor
        if health_ev['direction'] == 'mixed':
            health_ev['direction'] = 'positive'
            health_ev['confidence'] = max(health_ev['confidence'], 0.6)

    if transit_data.get('sade_sati'):
        health_notes.append('Sade Sati active — mental health and stress management important')

    # ── Mental Health Assessment ──
    # Mercury (mind significator) affliction + Moon weakness = mental health risk
    _mercury = planets.get('Mercury', {})
    _moon = planets.get('Moon', {})
    _mental_danger = 0
    _mental_notes = []
    # Mercury debilitated or weak
    if _mercury.get('dignity') == 'debilitated' or _mercury.get('strength') == 'weak':
        _mental_danger += 4
        _mental_notes.append(f'Mercury (mind) is {_mercury.get("dignity", _mercury.get("strength", "afflicted"))}')
    # Moon weak or afflicted
    if _moon.get('strength') == 'weak' or _moon.get('dignity') == 'debilitated':
        _mental_danger += 4
        _mental_notes.append(f'Moon is {_moon.get("dignity", _moon.get("strength", "weak"))}')
    # Saturn aspects or conjoins Moon (depression indicator)
    _saturn = planets.get('Saturn', {})
    _moon_h = _moon.get('house', 0)
    _saturn_h = _saturn.get('house', 0)
    if _moon_h > 0 and _saturn_h > 0:
        if _moon_h == _saturn_h:
            _mental_danger += 5
            _mental_notes.append('Saturn conjoins Moon — depression/anxiety indicator')
        else:
            _sat_asp = GRAHA_DRISHTI.get('Saturn', [3, 7, 10])
            _sat_asp_h = [(_saturn_h + a - 1) % 12 + 1 for a in _sat_asp]
            if _moon_h in _sat_asp_h:
                _mental_danger += 4
                _mental_notes.append(f'Saturn aspects Moon from house {_saturn_h}')
    # Mercury in dusthana (6, 8, 12) — disturbed mind
    _merc_h = _mercury.get('house', 0)
    if _merc_h in DUSTHANA:
        _mental_danger += 3
        _mental_notes.append(f'Mercury in dusthana house {_merc_h}')
    # Rahu/Ketu on Mercury or Moon (psychic disturbance)
    _rahu_h = planets.get('Rahu', {}).get('house', 0)
    _ketu_h = planets.get('Ketu', {}).get('house', 0)
    if _rahu_h == _moon_h or _ketu_h == _moon_h:
        _mental_danger += 4
        _mental_notes.append('Rahu/Ketu conjoins Moon — mental turbulence')
    if _rahu_h == _merc_h or _ketu_h == _merc_h:
        _mental_danger += 3
        _mental_notes.append('Rahu/Ketu conjoins Mercury — confused thinking')
    # Mercury dasha when Mercury is afflicted = activated mental health risk
    _mercury_dasha_active = md_lord == 'Mercury'
    if _mercury_dasha_active and _mental_danger >= 4:
        _mental_danger += 5
        _mental_notes.append('Mercury dasha activates mental health vulnerability')
    # Only override if Mercury dasha is active (timing indicator) AND significant
    if _mercury_dasha_active and _mental_danger >= 8:
        health_ev['direction'] = 'negative'
        health_ev['confidence'] = round(min(0.85, 0.5 + _mental_danger * 0.02), 2)
        health_ev['net_score'] = round(-_mental_danger, 1)
        health_notes.extend(_mental_notes)
    elif _mental_danger >= 6:
        health_notes.extend(_mental_notes)  # note but don't override

    if health_ev.get('pattern_matches'):
        health_notes.append(f'Case patterns: {"; ".join(n for _, _, _, n in health_ev["pattern_matches"])}')
    health_notes.append(f'Evidence ({health_ev["confirmations"]} for, {len(health_ev["evidence_against"])} against)')

    predictions.append({
        'area': 'Health',
        'summary': '. '.join(health_notes),
        'house': 1,
        'key_planets': [lagna_lord, eighth_lord],
        'confidence': health_ev['confidence'],
        'direction': health_ev['direction'],
        'net_score': health_ev['net_score'],
        'case_patterns': [n for _, _, _, n in health_ev.get('pattern_matches', [])],
    })

    # Spiritual prediction (12th house = moksha, 9th = dharma)
    twelfth_lord = house_lords.get(12, '')
    ninth_lord_sp = house_lords.get(9, '')
    spiritual_ev = _evidence_assessment(12, twelfth_lord, domain='spiritual')
    spiritual_notes = []
    # Ketu in 12th or 9th = strong spiritual indicator
    _ketu_h = planets.get('Ketu', {}).get('house', 0)
    if _ketu_h in {9, 12}:
        spiritual_ev['evidence_for'].append((6, f'Ketu in house {_ketu_h} — moksha karaka in spiritual house'))
    # Jupiter in 5th, 9th, or 12th = spiritual wisdom
    _jup_h = planets.get('Jupiter', {}).get('house', 0)
    if _jup_h in {5, 9, 12}:
        spiritual_ev['evidence_for'].append((4, f'Jupiter in house {_jup_h} — wisdom and dharma'))
    # MD lord owns 12th house — spiritual activation
    _md_sp = dasha_data.get('current_mahadasha', {})
    _md_lord_sp = _md_sp.get('lord', '') if _md_sp else ''
    if _md_lord_sp:
        _md_sp_houses = [h for h, l in house_lords.items() if l == _md_lord_sp]
        if 12 in _md_sp_houses:
            spiritual_ev['evidence_for'].append((8, f'{_md_lord_sp} dasha activates 12th house (moksha)'))
        if 9 in _md_sp_houses:
            spiritual_ev['evidence_for'].append((6, f'{_md_lord_sp} dasha activates 9th house (dharma)'))
    # Recalculate
    _sp_for = sum(w for w, _ in spiritual_ev['evidence_for'])
    _sp_against = sum(w for w, _ in spiritual_ev['evidence_against'])
    _sp_net = _sp_for - _sp_against
    _sp_max = sum(EVIDENCE_TIERS.values())
    spiritual_ev['net_score'] = round(_sp_net, 1)
    spiritual_ev['confidence'] = round(max(0.15, min(0.95, 0.5 + (_sp_net / _sp_max) * 0.45)), 2)
    if _sp_net > 2:
        spiritual_ev['direction'] = 'positive'
    elif _sp_net < -2:
        spiritual_ev['direction'] = 'negative'
    else:
        spiritual_ev['direction'] = 'mixed'
    spiritual_notes.append(f'12th lord: {twelfth_lord}, 9th lord: {ninth_lord_sp}')
    predictions.append({
        'area': 'Spiritual',
        'summary': '. '.join(spiritual_notes),
        'house': 12,
        'key_planets': [twelfth_lord, ninth_lord_sp],
        'confidence': spiritual_ev['confidence'],
        'direction': spiritual_ev['direction'],
        'net_score': spiritual_ev['net_score'],
        'case_patterns': [n for _, _, _, n in spiritual_ev.get('pattern_matches', [])],
    })

    # Yoga summary
    yogas = stages.get('yogas_summary', {})
    yoga_count = yogas.get('count', 0)
    raja_yoga_count = yogas.get('raja_yoga_count', 0)
    doshas = stages.get('doshas_summary', {})

    # Overall confidence using evidence hierarchy
    avg_conf = sum(p['confidence'] for p in predictions) / max(len(predictions), 1)
    avg_net = sum(p.get('net_score', 0) for p in predictions) / max(len(predictions), 1)

    # Confidence label based on weighted evidence hierarchy
    if avg_conf >= 0.80:
        conf_label = 'very high (strong multi-tier evidence alignment)'
    elif avg_conf >= 0.65:
        conf_label = 'high (dasha + D-9 or transit support)'
    elif avg_conf >= 0.50:
        conf_label = 'moderate (some evidence, contradictions present)'
    else:
        conf_label = 'low — contradictory evidence or missing dasha support'

    # LP-specific insight: overall chart assessment
    lp_insight = None
    yk = YOGAKARAKA.get(lagna)
    if yk and md_lord == yk:
        lp_insight = f'Currently in Yogakaraka {yk} Mahadasha — peak period for {lagna} Lagna'
    elif md_role in ('direly_evil', 'maraka'):
        lp_insight = f'Currently in {md_role} {md_lord} Mahadasha — difficult period, patience needed'

    return {
        'predictions': predictions,
        'yoga_count': yoga_count,
        'raja_yoga_count': raja_yoga_count,
        'active_yogas': yoga_activation,
        'doshas': doshas,
        'all_findings': all_findings,
        'overall_confidence': round(avg_conf, 2),
        'confirmation_level': conf_label,
        'avg_net_score': round(avg_net, 1),
        'lp_insight': lp_insight,
        'evidence_hierarchy': 'Dasha(10) > D1+D9(8) > Double Transit(7) > LP Functional(6) > Yoga(5) > Static(3) > Transit(1)',
    }


# ── Main Pipeline ───────────────────────────────────────────────────────────
def interpret_chart(chart_data: dict) -> dict:
    """
    Run the full 7-stage interpretation pipeline on a computed chart.

    Args:
        chart_data: Output from engine.compute_chart() (as dict)

    Returns:
        Structured interpretation with predictions and confidence levels.
    """
    # Stage 1: Verify and structure
    verified = stage1_verify(chart_data)
    if 'error' in verified:
        return verified

    # Stage 2: Strength assessment
    strength = stage2_strength(chart_data, verified)

    # Stage 2B: Laghu Parashari functional classification
    # Store vimshottari for LP dasha-bhukti analysis
    verified['_vimshottari'] = chart_data.get('vimshottari', [])
    functional = stage2b_functional(verified)

    # Stage 3: Navamsha cross-check
    navamsha = stage3_navamsha(chart_data, verified)

    # Stage 3B: Comprehensive Yoga Detection
    yoga_data = stage3b_yogas(verified)

    # Stage 4: Karaka identification
    karakas = stage4_karakas(chart_data, verified)

    # Stage 5: Dasha analysis
    dasha = stage5_dasha(chart_data, verified)

    # Stage 6: Transit layer
    transits = stage6_transits(chart_data, verified)

    # Stage 6B: Arudha Pada analysis (Sanjay Rath)
    arudha = stage_arudha(verified)

    # Stage 6C: D-10 Dashamsha career analysis (KN Rao)
    # Store MD lord for D-10 dasha placement check
    md_info = dasha.get('current_mahadasha', {}) or {}
    verified['_vimshottari_md'] = md_info.get('lord', '')
    d10 = stage_d10(chart_data, verified)

    # Stage 6D: Enhanced Ashtakavarga transit scoring
    avk_scores = {}
    sav = chart_data.get('ashtakavarga_sav', [])
    bav = chart_data.get('ashtakavarga_bav', {})
    if sav or bav:
        raw_transits = chart_data.get('transits', {})
        if isinstance(raw_transits, dict):
            # dict format: {planet: {rashi: ...}}
            for tp_name, tp_data in raw_transits.items():
                tp_sign = tp_data.get('rashi', '') if isinstance(tp_data, dict) else ''
                if tp_name and tp_sign:
                    score = _ashtakavarga_transit_score(tp_name, tp_sign, bav, sav)
                    if score:
                        avk_scores[tp_name] = score
        elif isinstance(raw_transits, list):
            # list format: [{body, rashi, ...}]
            for tp in raw_transits:
                tp_name = tp.get('body', '')
                tp_sign = tp.get('rashi', '')
                if tp_name and tp_sign:
                    score = _ashtakavarga_transit_score(tp_name, tp_sign, bav, sav)
                    if score:
                        avk_scores[tp_name] = score

    # Yoga/dosha summaries (merge engine-provided with our detection)
    yogas_summary = {
        'count': yoga_data['yoga_count'],
        'raja_yoga_count': yoga_data['raja_yoga_count'],
        'dhana_yoga_count': yoga_data['dhana_yoga_count'],
        'notable': yoga_data['notable'],
        'yogas': yoga_data['yogas'],
    }
    doshas_summary = chart_data.get('doshas', {})

    # Stage 7: Synthesis (with evidence hierarchy)
    stages = {
        'strength': strength,
        'functional': functional,
        'navamsha': navamsha,
        'yogas': yoga_data,
        'karakas': karakas,
        'dasha': dasha,
        'transits': transits,
        'arudha': arudha,
        'd10': d10,
        'ashtakavarga_scores': avk_scores,
        'yogas_summary': yogas_summary,
        'doshas_summary': doshas_summary,
    }
    synthesis = stage7_synthesis(verified, stages)

    return {
        'chart_summary': {
            'lagna': verified['lagna'],
            'birth_info': f"{verified.get('birth_date', '')} {verified.get('birth_time', '')} at {verified.get('place_name', '')}",
            'strong_planets': strength['strong_planets'],
            'weak_planets': strength['weak_planets'],
            'vargottama': navamsha.get('vargottama_planets', []),
            'yogakaraka': functional.get('yogakaraka'),
        },
        'stages': {
            'strength': {'strong': strength['strong_planets'], 'weak': strength['weak_planets'],
                        'findings': strength['findings']},
            'functional': {'classifications': functional['classifications'],
                          'yogakaraka': functional.get('yogakaraka'),
                          'findings': functional['findings']},
            'navamsha': {'vargottama': navamsha.get('vargottama_planets', []),
                        'findings': navamsha['findings']},
            'yogas': {'count': yoga_data['yoga_count'],
                     'raja_yogas': yoga_data['raja_yoga_count'],
                     'dhana_yogas': yoga_data['dhana_yoga_count'],
                     'list': [y['yoga'] for y in yoga_data['yogas']],
                     'findings': yoga_data['findings']},
            'karakas': {'assignments': karakas.get('chara_karakas', {}),
                       'findings': karakas['findings']},
            'dasha': {'current': dasha.get('current_mahadasha'),
                     'sub_period': dasha.get('current_antardasha'),
                     'sub_sub_period': dasha.get('current_pratyantardasha'),
                     'other_systems': dasha.get('other_systems_count', 0),
                     'findings': dasha['findings']},
            'transits': {'findings': transits['findings']},
            'arudha': {'padas': arudha.get('arudha_padas', {}),
                      'findings': arudha.get('findings', [])},
            'd10': {'available': d10.get('d10_available', False),
                   'd10_lagna': d10.get('d10_lagna'),
                   'findings': d10.get('findings', [])},
            'ashtakavarga': {'transit_scores': avk_scores},
        },
        'predictions': synthesis['predictions'],
        'yogas': yogas_summary,
        'active_yogas': synthesis.get('active_yogas', []),
        'doshas': doshas_summary,
        'overall_confidence': synthesis['overall_confidence'],
        'confirmation_level': synthesis.get('confirmation_level', ''),
        'avg_net_score': synthesis.get('avg_net_score', 0),
        'lp_insight': synthesis.get('lp_insight'),
        'evidence_hierarchy': synthesis.get('evidence_hierarchy'),
        'methodology': 'Composite Pipeline: PVR 7-Stage + LP + KN Rao PACDARES/Double Transit + Sanjay Rath Jaimini/Arudha + BV Raman Maraka/Ashtakavarga + D-10 Dashamsha + Master Reasoning Framework',
        'methodology_sources': [
            'Laghu Parashari (Jataka Chandrika) — functional benefic/malefic classification for all 12 lagnas',
            'KN Rao — PACDARES framework, Double Transit (98% marriage accuracy), Composite Approach',
            'Sanjay Rath — Jaimini Karakas (AK/DK/AmK), Arudha Padas, Argala',
            'BV Raman — Maraka rules, Ashtakavarga transit scoring, Hindu Predictive Astrology',
            'Master Reasoning Framework — 7-tier evidence hierarchy, contradiction resolution',
        ],
        'all_findings': synthesis['all_findings'],
    }


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == '--ipc':
        chart_data = json.loads(sys.stdin.read())
        result = interpret_chart(chart_data)
        print(json.dumps(result, indent=2, default=str))
    else:
        # Test with Delhi chart
        sys.path.insert(0, '.')
        from engine import compute_chart
        from dataclasses import asdict
        chart = compute_chart(
            2000, 1, 1, 12, 0, 0,
            place_name="Delhi", latitude=28.6139, longitude=77.2090,
            timezone_offset=5.5,
            analyses=['yogas', 'raja_yogas', 'doshas', 'ashtakavarga', 'karakas', 'panchanga', 'all_dashas'],
        )
        chart_dict = asdict(chart)
        result = interpret_chart(chart_dict)
        print(json.dumps(result, indent=2, default=str))
