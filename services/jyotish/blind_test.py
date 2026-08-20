"""
BLIND TEST — Independent celebrity charts NOT used in pipeline development.
Sources: AstroSage (A-rated), Lagna360, verified Vedic astrology databases.
All positions are sidereal (Lahiri ayanamsa).

Excludes: Indira Gandhi (in training set), Steve Jobs (DD), Elon Musk (DD).

Batch 1 (BLIND-001 to BLIND-014): Modi, Obama, Tendulkar, A.Bachchan, Nixon, R.Gandhi,
  M.Jackson, M.Gandhi, Elvis, Diana, B.Gates, J.Bezos.
Batch 2 (BLIND-015 to BLIND-029): Einstein, M.Ali, Thatcher, Trump, Oprah, Churchill,
  Vivekananda, Nehru, Dhirubhai Ambani, Vajpayee, JFK, M.Monroe, Bruce Lee, Senna, Lincoln.
Batch 3 (BLIND-030 to BLIND-044): Focus on Health, Marriage, Wealth, Career Fall domains.
  Y.Singh, Schwarzenegger, A.Jolie, Rajinikanth, Aishwarya, JFK(marriage), E.Taylor,
  Zuckerberg, Buffett, Oprah(wealth), M.Ambani, Trump(impeach), Clinton, T.Woods, M.Stewart.
Batch 4 (BLIND-045 to BLIND-049): Held-out validation — Career Fall focus.
  PV Narasimha Rao, Mussolini, Sanjay Gandhi, A.Bachchan(bankruptcy), Jayalalithaa(prison).
"""
import sys, os, json
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from interpret import interpret_chart

# Domain → prediction area mapping (same as backtest.py)
DOMAIN_TO_AREA = {
    'career_rise': 'Career',
    'career_fall': 'Career',
    'death': 'Health',
    'health': 'Health',
    'mental_health': 'Mental Health',
    'wealth': 'Wealth & Finance',
    'marriage_timing': 'Marriage & Relationships',
    'spiritual': 'Spiritual',
}

EXPECTED_DIRECTION = {
    ('career_rise', 'positive'): 'positive',
    ('career_fall', 'positive'): 'negative',
    ('death', 'positive'): 'negative',
    ('health', 'negative'): 'negative',
    ('wealth', 'positive'): 'positive',
    ('marriage_timing', 'positive'): 'positive',
}

import datetime
today_year = datetime.date.today().year

BLIND_CASES = [
    # ── Career Rise ──
    {
        'id': 'BLIND-001', 'name': 'Narendra Modi — PM of India 2014',
        'source': 'astrosage_A', 'lagna': 'Scorpio',
        'planets': {'Sun': 'Virgo', 'Moon': 'Scorpio', 'Mars': 'Scorpio', 'Mercury': 'Virgo',
                    'Jupiter': 'Aquarius', 'Venus': 'Leo', 'Saturn': 'Leo', 'Rahu': 'Pisces', 'Ketu': 'Virgo'},
        'domain': 'career_rise', 'known_outcome': 'positive',
        'dasha_lord': 'Moon', 'antardasha_lord': 'Rahu',
    },
    {
        'id': 'BLIND-002', 'name': 'Barack Obama — US President 2008',
        'source': 'astrosage_A', 'lagna': 'Capricorn',
        'planets': {'Sun': 'Cancer', 'Moon': 'Taurus', 'Mars': 'Leo', 'Mercury': 'Cancer',
                    'Jupiter': 'Capricorn', 'Venus': 'Gemini', 'Saturn': 'Capricorn', 'Rahu': 'Leo', 'Ketu': 'Aquarius'},
        'domain': 'career_rise', 'known_outcome': 'positive',
        'dasha_lord': 'Jupiter', 'antardasha_lord': 'Moon',
    },
    {
        'id': 'BLIND-003', 'name': 'Sachin Tendulkar — Cricket debut 1989',
        'source': 'astrosage_A', 'lagna': 'Leo',
        'planets': {'Sun': 'Aries', 'Moon': 'Sagittarius', 'Mars': 'Capricorn', 'Mercury': 'Pisces',
                    'Jupiter': 'Capricorn', 'Venus': 'Aries', 'Saturn': 'Taurus', 'Rahu': 'Sagittarius', 'Ketu': 'Gemini'},
        'domain': 'career_rise', 'known_outcome': 'positive',
        'dasha_lord': 'Moon', 'antardasha_lord': 'Ketu',
    },
    {
        'id': 'BLIND-004', 'name': 'Amitabh Bachchan — Bollywood superstar 1975-82',
        'source': 'astrosage_A', 'lagna': 'Aquarius',
        'planets': {'Sun': 'Virgo', 'Moon': 'Libra', 'Mars': 'Virgo', 'Mercury': 'Virgo',
                    'Jupiter': 'Cancer', 'Venus': 'Virgo', 'Saturn': 'Taurus', 'Rahu': 'Leo', 'Ketu': 'Aquarius'},
        'domain': 'career_rise', 'known_outcome': 'positive',
        'dasha_lord': 'Saturn', 'antardasha_lord': 'Mercury',
    },

    # ── Career Fall ──
    {
        'id': 'BLIND-005', 'name': 'Richard Nixon — Watergate resignation 1974',
        'source': 'astrosage_A', 'lagna': 'Leo',
        'planets': {'Sun': 'Sagittarius', 'Moon': 'Capricorn', 'Mars': 'Sagittarius', 'Mercury': 'Sagittarius',
                    'Jupiter': 'Sagittarius', 'Venus': 'Aquarius', 'Saturn': 'Taurus', 'Rahu': 'Pisces', 'Ketu': 'Virgo'},
        'domain': 'career_fall', 'known_outcome': 'positive',
        'dasha_lord': 'Saturn', 'antardasha_lord': 'Rahu',
    },

    # ── Death ──
    {
        'id': 'BLIND-006', 'name': 'Rajiv Gandhi — assassinated 1991',
        'source': 'astrosage_A', 'lagna': 'Virgo',
        'planets': {'Sun': 'Leo', 'Moon': 'Leo', 'Mars': 'Virgo', 'Mercury': 'Leo',
                    'Jupiter': 'Leo', 'Venus': 'Leo', 'Saturn': 'Gemini', 'Rahu': 'Cancer', 'Ketu': 'Capricorn'},
        'domain': 'death', 'known_outcome': 'positive',
        'dasha_lord': 'Rahu', 'antardasha_lord': 'Mercury',
    },
    {
        'id': 'BLIND-007', 'name': 'Michael Jackson — death 2009',
        'source': 'astrosage_A', 'lagna': 'Leo',
        'planets': {'Sun': 'Leo', 'Moon': 'Aquarius', 'Mars': 'Aries', 'Mercury': 'Leo',
                    'Jupiter': 'Libra', 'Venus': 'Cancer', 'Saturn': 'Scorpio', 'Rahu': 'Libra', 'Ketu': 'Aries'},
        'domain': 'death', 'known_outcome': 'positive',
        'dasha_lord': 'Ketu', 'antardasha_lord': 'Venus',
    },
    {
        'id': 'BLIND-008', 'name': 'Mahatma Gandhi — assassinated 1948',
        'source': 'astrosage_A', 'lagna': 'Libra',
        'planets': {'Sun': 'Virgo', 'Moon': 'Cancer', 'Mars': 'Libra', 'Mercury': 'Libra',
                    'Jupiter': 'Aries', 'Venus': 'Libra', 'Saturn': 'Scorpio', 'Rahu': 'Cancer', 'Ketu': 'Capricorn'},
        'domain': 'death', 'known_outcome': 'positive',
        'dasha_lord': 'Jupiter', 'antardasha_lord': 'Venus',
    },
    {
        'id': 'BLIND-009', 'name': 'Elvis Presley — death 1977',
        'source': 'astrosage_A', 'lagna': 'Aries',
        'planets': {'Sun': 'Sagittarius', 'Moon': 'Aquarius', 'Mars': 'Virgo', 'Mercury': 'Sagittarius',
                    'Jupiter': 'Libra', 'Venus': 'Capricorn', 'Saturn': 'Aquarius', 'Rahu': 'Capricorn', 'Ketu': 'Cancer'},
        'domain': 'death', 'known_outcome': 'positive',
        'dasha_lord': 'Saturn', 'antardasha_lord': 'Moon',
    },
    {
        'id': 'BLIND-010', 'name': 'Princess Diana — death 1997',
        'source': 'astrosage_A', 'lagna': 'Scorpio',
        'planets': {'Sun': 'Gemini', 'Moon': 'Aquarius', 'Mars': 'Leo', 'Mercury': 'Gemini',
                    'Jupiter': 'Capricorn', 'Venus': 'Taurus', 'Saturn': 'Capricorn', 'Rahu': 'Leo', 'Ketu': 'Aquarius'},
        'domain': 'death', 'known_outcome': 'positive',
        'dasha_lord': 'Jupiter', 'antardasha_lord': 'Rahu',
    },

    # ── Health ──
    {
        'id': 'BLIND-011', 'name': 'Amitabh Bachchan — near-death accident 1982',
        'source': 'astrosage_A', 'lagna': 'Aquarius',
        'planets': {'Sun': 'Virgo', 'Moon': 'Libra', 'Mars': 'Virgo', 'Mercury': 'Virgo',
                    'Jupiter': 'Cancer', 'Venus': 'Virgo', 'Saturn': 'Taurus', 'Rahu': 'Leo', 'Ketu': 'Aquarius'},
        'domain': 'health', 'known_outcome': 'negative',
        'dasha_lord': 'Saturn', 'antardasha_lord': 'Sun',
    },

    # ── Marriage ──
    {
        'id': 'BLIND-012', 'name': 'Princess Diana — marriage to Charles 1981',
        'source': 'astrosage_A', 'lagna': 'Scorpio',
        'planets': {'Sun': 'Gemini', 'Moon': 'Aquarius', 'Mars': 'Leo', 'Mercury': 'Gemini',
                    'Jupiter': 'Capricorn', 'Venus': 'Taurus', 'Saturn': 'Capricorn', 'Rahu': 'Leo', 'Ketu': 'Aquarius'},
        'domain': 'marriage_timing', 'known_outcome': 'positive',
        'dasha_lord': 'Mars', 'antardasha_lord': 'Jupiter',
    },

    # ── Wealth ──
    {
        'id': 'BLIND-013', 'name': 'Bill Gates — Microsoft IPO + peak wealth',
        'source': 'astrosage_A', 'lagna': 'Gemini',
        'planets': {'Sun': 'Libra', 'Moon': 'Pisces', 'Mars': 'Virgo', 'Mercury': 'Virgo',
                    'Jupiter': 'Leo', 'Venus': 'Libra', 'Saturn': 'Libra', 'Rahu': 'Scorpio', 'Ketu': 'Taurus'},
        'domain': 'wealth', 'known_outcome': 'positive',
        'dasha_lord': 'Venus', 'antardasha_lord': '',
    },
    {
        'id': 'BLIND-014', 'name': 'Jeff Bezos — Amazon founding + peak wealth',
        'source': 'astrosage_A', 'lagna': 'Pisces',
        'planets': {'Sun': 'Sagittarius', 'Moon': 'Sagittarius', 'Mars': 'Capricorn', 'Mercury': 'Sagittarius',
                    'Jupiter': 'Pisces', 'Venus': 'Aquarius', 'Saturn': 'Capricorn', 'Rahu': 'Gemini', 'Ketu': 'Sagittarius'},
        'domain': 'wealth', 'known_outcome': 'positive',
        'dasha_lord': 'Moon', 'antardasha_lord': '',
    },

    # ═══════════════════════════════════════════════════════════════════════
    # BATCH 2 — 15 NEW blind charts (added 2026-04-22)
    # Sources: AstroSage (Lahiri ayanamsa), cross-checked with Lagna360
    # ═══════════════════════════════════════════════════════════════════════

    # ── Career Rise ──
    {
        'id': 'BLIND-015', 'name': 'Albert Einstein — Nobel Prize in Physics 1921',
        'source': 'astrosage_R', 'lagna': 'Gemini',
        'planets': {'Sun': 'Pisces', 'Moon': 'Scorpio', 'Mars': 'Capricorn', 'Mercury': 'Pisces',
                    'Jupiter': 'Aquarius', 'Venus': 'Pisces', 'Saturn': 'Pisces', 'Rahu': 'Capricorn', 'Ketu': 'Cancer'},
        'domain': 'career_rise', 'known_outcome': 'positive',
        'dasha_lord': 'Sun', 'antardasha_lord': 'Venus',
    },
    {
        'id': 'BLIND-016', 'name': 'Muhammad Ali — Heavyweight Champion 1964',
        'source': 'astrosage_A', 'lagna': 'Cancer',
        'planets': {'Sun': 'Capricorn', 'Moon': 'Aquarius', 'Mars': 'Aries', 'Mercury': 'Capricorn',
                    'Jupiter': 'Taurus', 'Venus': 'Capricorn', 'Saturn': 'Aries', 'Rahu': 'Leo', 'Ketu': 'Aquarius'},
        'domain': 'career_rise', 'known_outcome': 'positive',
        'dasha_lord': 'Jupiter', 'antardasha_lord': 'Venus',
    },
    {
        'id': 'BLIND-017', 'name': 'Margaret Thatcher — Prime Minister 1979',
        'source': 'astrosage_A', 'lagna': 'Libra',
        'planets': {'Sun': 'Virgo', 'Moon': 'Leo', 'Mars': 'Virgo', 'Mercury': 'Libra',
                    'Jupiter': 'Sagittarius', 'Venus': 'Scorpio', 'Saturn': 'Libra', 'Rahu': 'Cancer', 'Ketu': 'Capricorn'},
        'domain': 'career_rise', 'known_outcome': 'positive',
        'dasha_lord': 'Rahu', 'antardasha_lord': 'Saturn',
    },
    {
        'id': 'BLIND-018', 'name': 'Donald Trump — US President elected 2016',
        'source': 'astrosage_R', 'lagna': 'Leo',
        'planets': {'Sun': 'Taurus', 'Moon': 'Scorpio', 'Mars': 'Leo', 'Mercury': 'Gemini',
                    'Jupiter': 'Virgo', 'Venus': 'Cancer', 'Saturn': 'Cancer', 'Rahu': 'Taurus', 'Ketu': 'Scorpio'},
        'domain': 'career_rise', 'known_outcome': 'positive',
        'dasha_lord': 'Rahu', 'antardasha_lord': 'Mars',
    },
    {
        'id': 'BLIND-019', 'name': 'Oprah Winfrey — Show launch national 1986',
        'source': 'astrosage_R', 'lagna': 'Capricorn',
        'planets': {'Sun': 'Capricorn', 'Moon': 'Scorpio', 'Mars': 'Scorpio', 'Mercury': 'Capricorn',
                    'Jupiter': 'Taurus', 'Venus': 'Capricorn', 'Saturn': 'Libra', 'Rahu': 'Capricorn', 'Ketu': 'Cancer'},
        'domain': 'career_rise', 'known_outcome': 'positive',
        'dasha_lord': 'Venus', 'antardasha_lord': '',
    },
    {
        'id': 'BLIND-020', 'name': 'Winston Churchill — PM during WWII 1940',
        'source': 'astrosage_R', 'lagna': 'Virgo',
        'planets': {'Sun': 'Scorpio', 'Moon': 'Pisces', 'Mars': 'Scorpio', 'Mercury': 'Libra',
                    'Jupiter': 'Cancer', 'Venus': 'Scorpio', 'Saturn': 'Pisces', 'Rahu': 'Aquarius', 'Ketu': 'Leo'},
        'domain': 'career_rise', 'known_outcome': 'positive',
        'dasha_lord': 'Jupiter', 'antardasha_lord': '',
    },
    {
        'id': 'BLIND-021', 'name': 'Swami Vivekananda — Chicago Parliament speech 1893',
        'source': 'astrosage_R', 'lagna': 'Sagittarius',
        'planets': {'Sun': 'Sagittarius', 'Moon': 'Virgo', 'Mars': 'Aries', 'Mercury': 'Capricorn',
                    'Jupiter': 'Libra', 'Venus': 'Capricorn', 'Saturn': 'Virgo', 'Rahu': 'Scorpio', 'Ketu': 'Taurus'},
        'domain': 'career_rise', 'known_outcome': 'positive',
        'dasha_lord': 'Jupiter', 'antardasha_lord': '',
    },
    {
        'id': 'BLIND-022', 'name': 'Jawaharlal Nehru — First PM of India 1947',
        'source': 'astrosage_A', 'lagna': 'Cancer',
        'planets': {'Sun': 'Scorpio', 'Moon': 'Cancer', 'Mars': 'Virgo', 'Mercury': 'Libra',
                    'Jupiter': 'Sagittarius', 'Venus': 'Libra', 'Saturn': 'Leo', 'Rahu': 'Gemini', 'Ketu': 'Sagittarius'},
        'domain': 'career_rise', 'known_outcome': 'positive',
        'dasha_lord': 'Moon', 'antardasha_lord': 'Sun',
    },
    {
        'id': 'BLIND-023', 'name': 'Dhirubhai Ambani — Reliance IPO wealth explosion 1977',
        'source': 'astrosage_R', 'lagna': 'Sagittarius',
        'planets': {'Sun': 'Sagittarius', 'Moon': 'Sagittarius', 'Mars': 'Leo', 'Mercury': 'Scorpio',
                    'Jupiter': 'Virgo', 'Venus': 'Scorpio', 'Saturn': 'Capricorn', 'Rahu': 'Aquarius', 'Ketu': 'Leo'},
        'domain': 'wealth', 'known_outcome': 'positive',
        'dasha_lord': 'Rahu', 'antardasha_lord': '',
    },
    {
        'id': 'BLIND-024', 'name': 'Atal Bihari Vajpayee — PM of India 1998',
        'source': 'astrosage_A', 'lagna': 'Scorpio',
        'planets': {'Sun': 'Sagittarius', 'Moon': 'Scorpio', 'Mars': 'Pisces', 'Mercury': 'Sagittarius',
                    'Jupiter': 'Sagittarius', 'Venus': 'Scorpio', 'Saturn': 'Libra', 'Rahu': 'Cancer', 'Ketu': 'Capricorn'},
        'domain': 'career_rise', 'known_outcome': 'positive',
        'dasha_lord': 'Rahu', 'antardasha_lord': 'Sun',
    },

    # ── Death ──
    {
        'id': 'BLIND-025', 'name': 'JFK — assassinated 1963',
        'source': 'astrosage_R', 'lagna': 'Virgo',
        'planets': {'Sun': 'Taurus', 'Moon': 'Leo', 'Mars': 'Aries', 'Mercury': 'Aries',
                    'Jupiter': 'Taurus', 'Venus': 'Taurus', 'Saturn': 'Cancer', 'Rahu': 'Sagittarius', 'Ketu': 'Gemini'},
        'domain': 'death', 'known_outcome': 'positive',
        'dasha_lord': 'Jupiter', 'antardasha_lord': 'Saturn',
    },
    {
        'id': 'BLIND-026', 'name': 'Marilyn Monroe — death 1962',
        'source': 'astrosage_A', 'lagna': 'Cancer',
        'planets': {'Sun': 'Taurus', 'Moon': 'Capricorn', 'Mars': 'Aquarius', 'Mercury': 'Taurus',
                    'Jupiter': 'Aquarius', 'Venus': 'Aries', 'Saturn': 'Libra', 'Rahu': 'Gemini', 'Ketu': 'Sagittarius'},
        'domain': 'death', 'known_outcome': 'positive',
        'dasha_lord': 'Jupiter', 'antardasha_lord': 'Moon',
    },
    {
        'id': 'BLIND-027', 'name': 'Bruce Lee — death 1973',
        'source': 'astrosage_A', 'lagna': 'Scorpio',
        'planets': {'Sun': 'Scorpio', 'Moon': 'Libra', 'Mars': 'Libra', 'Mercury': 'Libra',
                    'Jupiter': 'Aries', 'Venus': 'Libra', 'Saturn': 'Aries', 'Rahu': 'Virgo', 'Ketu': 'Pisces'},
        'domain': 'death', 'known_outcome': 'positive',
        'dasha_lord': 'Saturn', 'antardasha_lord': 'Rahu',
    },
    {
        'id': 'BLIND-028', 'name': 'Ayrton Senna — death in racing accident 1994',
        'source': 'astrosage_R', 'lagna': 'Capricorn',
        'planets': {'Sun': 'Pisces', 'Moon': 'Sagittarius', 'Mars': 'Capricorn', 'Mercury': 'Aquarius',
                    'Jupiter': 'Sagittarius', 'Venus': 'Aquarius', 'Saturn': 'Sagittarius', 'Rahu': 'Virgo', 'Ketu': 'Pisces'},
        'domain': 'death', 'known_outcome': 'positive',
        'dasha_lord': 'Rahu', 'antardasha_lord': 'Rahu',
    },
    {
        'id': 'BLIND-029', 'name': 'Abraham Lincoln — assassination 1865',
        'source': 'astrosage_R', 'lagna': 'Scorpio',
        'planets': {'Sun': 'Aquarius', 'Moon': 'Capricorn', 'Mars': 'Libra', 'Mercury': 'Aquarius',
                    'Jupiter': 'Pisces', 'Venus': 'Pisces', 'Saturn': 'Scorpio', 'Rahu': 'Libra', 'Ketu': 'Aries'},
        'domain': 'death', 'known_outcome': 'positive',
        'dasha_lord': 'Jupiter', 'antardasha_lord': 'Saturn',
    },

    # ══════════════════════════════════════════════════════════════════════
    # BATCH 3 — 15 NEW blind charts (added 2026-04-22)
    # Focus: HEALTH crises, MARRIAGE timing, WEALTH events, CAREER FALL
    # Sources: AstroSage (celebrity.astrosage.com), Lagna360, AstroLinked
    # All positions sidereal (Lahiri ayanamsa)
    # ══════════════════════════════════════════════════════════════════════

    # ── HEALTH CRISES (4 charts) ──

    # Yuvraj Singh: Cancer diagnosis (A-rated, AstroSage). Born 12 Dec 1981, 21:45, Chandigarh.
    # Diagnosed with mediastinal seminoma during 2011 World Cup. Saturn MD / Venus AD.
    {
        'id': 'BLIND-030', 'name': 'Yuvraj Singh — cancer diagnosis 2011',
        'source': 'astrosage_A', 'lagna': 'Cancer',
        'planets': {'Sun': 'Scorpio', 'Moon': 'Gemini', 'Mars': 'Virgo', 'Mercury': 'Scorpio',
                    'Jupiter': 'Libra', 'Venus': 'Capricorn', 'Saturn': 'Virgo', 'Rahu': 'Cancer', 'Ketu': 'Capricorn'},
        'domain': 'health', 'known_outcome': 'negative',
        'dasha_lord': 'Saturn', 'antardasha_lord': 'Venus',
    },

    # Arnold Schwarzenegger: Heart valve surgery (R-rated, AstroSage). Born 30 Jul 1947, 4:10, Graz.
    # Open-heart surgery (Ross procedure) April 1997. Rahu MD / Rahu AD.
    {
        'id': 'BLIND-031', 'name': 'Arnold Schwarzenegger — heart surgery 1997',
        'source': 'astrosage_R', 'lagna': 'Gemini',
        'planets': {'Sun': 'Cancer', 'Moon': 'Sagittarius', 'Mars': 'Taurus', 'Mercury': 'Gemini',
                    'Jupiter': 'Libra', 'Venus': 'Cancer', 'Saturn': 'Cancer', 'Rahu': 'Taurus', 'Ketu': 'Scorpio'},
        'domain': 'health', 'known_outcome': 'negative',
        'dasha_lord': 'Rahu', 'antardasha_lord': 'Rahu',
    },

    # Angelina Jolie: Preventive double mastectomy (R-rated, AstroSage "765 Notable Horoscopes").
    # Born 4 Jun 1975, 9:06 AM, Los Angeles. BRCA1 gene; mastectomy May 2013. Venus MD / Saturn AD.
    {
        'id': 'BLIND-032', 'name': 'Angelina Jolie — double mastectomy 2013',
        'source': 'astrosage_R', 'lagna': 'Gemini',
        'planets': {'Sun': 'Taurus', 'Moon': 'Pisces', 'Mars': 'Pisces', 'Mercury': 'Taurus',
                    'Jupiter': 'Pisces', 'Venus': 'Cancer', 'Saturn': 'Gemini', 'Rahu': 'Scorpio', 'Ketu': 'Taurus'},
        'domain': 'health', 'known_outcome': 'negative',
        'dasha_lord': 'Venus', 'antardasha_lord': 'Saturn',
    },

    # Rajinikanth: Kidney transplant (R-rated, AstroSage). Born 12 Dec 1950, Bangalore.
    # Kidney transplant in USA, May 2016. Saturn MD / Rahu AD.
    {
        'id': 'BLIND-033', 'name': 'Rajinikanth — kidney transplant 2016',
        'source': 'astrosage_R', 'lagna': 'Leo',
        'planets': {'Sun': 'Scorpio', 'Moon': 'Capricorn', 'Mars': 'Capricorn', 'Mercury': 'Sagittarius',
                    'Jupiter': 'Aquarius', 'Venus': 'Sagittarius', 'Saturn': 'Virgo', 'Rahu': 'Pisces', 'Ketu': 'Virgo'},
        'domain': 'health', 'known_outcome': 'negative',
        'dasha_lord': 'Saturn', 'antardasha_lord': 'Rahu',
    },

    # ── MARRIAGE TIMING (3 charts) ──

    # Aishwarya Rai: Marriage to Abhishek Bachchan (R-rated, AstroSage).
    # Born 1 Nov 1973, 4:05 AM, Mangalore. Married 20 Apr 2007. Venus MD / Saturn AD.
    {
        'id': 'BLIND-034', 'name': 'Aishwarya Rai — marriage to Abhishek 2007',
        'source': 'astrosage_R', 'lagna': 'Virgo',
        'planets': {'Sun': 'Libra', 'Moon': 'Sagittarius', 'Mars': 'Aries', 'Mercury': 'Scorpio',
                    'Jupiter': 'Capricorn', 'Venus': 'Sagittarius', 'Saturn': 'Gemini', 'Rahu': 'Sagittarius', 'Ketu': 'Gemini'},
        'domain': 'marriage_timing', 'known_outcome': 'positive',
        'dasha_lord': 'Venus', 'antardasha_lord': 'Saturn',
    },

    # JFK: Marriage to Jackie Kennedy (A-rated, AstroSage "The Times Select Horoscopes").
    # Born 29 May 1917, 3:00 PM, Brookline MA. Married 12 Sep 1953. Rahu MD / Mercury AD.
    {
        'id': 'BLIND-035', 'name': 'JFK — marriage to Jackie Kennedy 1953',
        'source': 'astrosage_A', 'lagna': 'Virgo',
        'planets': {'Sun': 'Taurus', 'Moon': 'Leo', 'Mars': 'Aries', 'Mercury': 'Aries',
                    'Jupiter': 'Taurus', 'Venus': 'Taurus', 'Saturn': 'Cancer', 'Rahu': 'Sagittarius', 'Ketu': 'Gemini'},
        'domain': 'marriage_timing', 'known_outcome': 'positive',
        'dasha_lord': 'Rahu', 'antardasha_lord': 'Mercury',
    },

    # Elizabeth Taylor: Marriage to Richard Burton (R-rated, AstroSage).
    # Born 27 Feb 1932, 2:30 AM, London. Married 15 Mar 1964 (5th of 8 marriages). Mercury MD.
    {
        'id': 'BLIND-036', 'name': 'Elizabeth Taylor — marriage to Burton 1964',
        'source': 'astrosage_R', 'lagna': 'Scorpio',
        'planets': {'Sun': 'Aquarius', 'Moon': 'Libra', 'Mars': 'Aquarius', 'Mercury': 'Aquarius',
                    'Jupiter': 'Cancer', 'Venus': 'Pisces', 'Saturn': 'Capricorn', 'Rahu': 'Pisces', 'Ketu': 'Virgo'},
        'domain': 'marriage_timing', 'known_outcome': 'positive',
        'dasha_lord': 'Mercury', 'antardasha_lord': '',
    },

    # ── WEALTH EVENTS (4 charts) ──

    # Mark Zuckerberg: Facebook IPO (R-rated, AstroSage). Born 14 May 1984, White Plains NY.
    # Facebook IPO 18 May 2012, $104B valuation. Mercury MD / Venus AD.
    {
        'id': 'BLIND-037', 'name': 'Mark Zuckerberg — Facebook IPO 2012',
        'source': 'astrosage_R', 'lagna': 'Capricorn',
        'planets': {'Sun': 'Aries', 'Moon': 'Libra', 'Mars': 'Libra', 'Mercury': 'Aries',
                    'Jupiter': 'Sagittarius', 'Venus': 'Aries', 'Saturn': 'Libra', 'Rahu': 'Taurus', 'Ketu': 'Scorpio'},
        'domain': 'wealth', 'known_outcome': 'positive',
        'dasha_lord': 'Mercury', 'antardasha_lord': 'Venus',
    },

    # Warren Buffett: Berkshire Hathaway wealth peak (R-rated, AstroSage).
    # Born 30 Aug 1930, 3:00 PM, Omaha. Moon MD drove massive wealth during 1986-1996.
    {
        'id': 'BLIND-038', 'name': 'Warren Buffett — Berkshire wealth accumulation 1990s',
        'source': 'astrosage_R', 'lagna': 'Scorpio',
        'planets': {'Sun': 'Leo', 'Moon': 'Scorpio', 'Mars': 'Gemini', 'Mercury': 'Virgo',
                    'Jupiter': 'Gemini', 'Venus': 'Virgo', 'Saturn': 'Sagittarius', 'Rahu': 'Aries', 'Ketu': 'Libra'},
        'domain': 'wealth', 'known_outcome': 'positive',
        'dasha_lord': 'Moon', 'antardasha_lord': '',
    },

    # Oprah Winfrey: First Black female billionaire (R-rated, AstroSage).
    # Born 29 Jan 1954, 4:30 AM, Kosciusko MS. Forbes billionaire list 2003. Venus MD / Ketu AD.
    {
        'id': 'BLIND-039', 'name': 'Oprah Winfrey — billionaire Forbes 2003',
        'source': 'astrosage_R', 'lagna': 'Capricorn',
        'planets': {'Sun': 'Capricorn', 'Moon': 'Scorpio', 'Mars': 'Scorpio', 'Mercury': 'Capricorn',
                    'Jupiter': 'Taurus', 'Venus': 'Capricorn', 'Saturn': 'Libra', 'Rahu': 'Capricorn', 'Ketu': 'Cancer'},
        'domain': 'wealth', 'known_outcome': 'positive',
        'dasha_lord': 'Venus', 'antardasha_lord': 'Ketu',
    },

    # Mukesh Ambani: Reliance Jio / richest Indian (R-rated, AstroSage).
    # Born 19 Apr 1957, 19:53, Aden. Became Asia's richest person. Jupiter MD.
    {
        'id': 'BLIND-040', 'name': 'Mukesh Ambani — richest Indian peak wealth 2020',
        'source': 'astrosage_R', 'lagna': 'Scorpio',
        'planets': {'Sun': 'Aries', 'Moon': 'Sagittarius', 'Mars': 'Taurus', 'Mercury': 'Aries',
                    'Jupiter': 'Leo', 'Venus': 'Aries', 'Saturn': 'Scorpio', 'Rahu': 'Libra', 'Ketu': 'Aries'},
        'domain': 'wealth', 'known_outcome': 'positive',
        'dasha_lord': 'Jupiter', 'antardasha_lord': '',
    },

    # ── CAREER FALL (4 charts) ──

    # Donald Trump: First impeachment (R-rated, AstroSage). Born 14 Jun 1946, 9:51 AM, Queens NY.
    # Impeached 18 Dec 2019 for abuse of power. Saturn MD / Saturn AD.
    {
        'id': 'BLIND-041', 'name': 'Donald Trump — first impeachment 2019',
        'source': 'astrosage_R', 'lagna': 'Leo',
        'planets': {'Sun': 'Taurus', 'Moon': 'Scorpio', 'Mars': 'Leo', 'Mercury': 'Gemini',
                    'Jupiter': 'Virgo', 'Venus': 'Cancer', 'Saturn': 'Cancer', 'Rahu': 'Taurus', 'Ketu': 'Scorpio'},
        'domain': 'career_fall', 'known_outcome': 'positive',
        'dasha_lord': 'Saturn', 'antardasha_lord': 'Saturn',
    },

    # Bill Clinton: Impeachment (A-rated, AstroSage). Born 19 Aug 1946, 8:53 AM, Hope AR.
    # Impeached 19 Dec 1998 for perjury/obstruction. Jupiter MD / Ketu AD.
    {
        'id': 'BLIND-042', 'name': 'Bill Clinton — impeachment 1998',
        'source': 'astrosage_A', 'lagna': 'Virgo',
        'planets': {'Sun': 'Leo', 'Moon': 'Aries', 'Mars': 'Virgo', 'Mercury': 'Cancer',
                    'Jupiter': 'Libra', 'Venus': 'Virgo', 'Saturn': 'Cancer', 'Rahu': 'Taurus', 'Ketu': 'Scorpio'},
        'domain': 'career_fall', 'known_outcome': 'positive',
        'dasha_lord': 'Jupiter', 'antardasha_lord': 'Ketu',
    },

    # Tiger Woods: Sex scandal / career fall (R-rated, AstroSage). Born 30 Dec 1975, 22:50, Long Beach CA.
    # Scandal broke Nov 2009, lost sponsors, dropped from world #1. Sun MD / Venus AD.
    {
        'id': 'BLIND-043', 'name': 'Tiger Woods — scandal and career fall 2009',
        'source': 'astrosage_R', 'lagna': 'Virgo',
        'planets': {'Sun': 'Sagittarius', 'Moon': 'Scorpio', 'Mars': 'Taurus', 'Mercury': 'Capricorn',
                    'Jupiter': 'Pisces', 'Venus': 'Scorpio', 'Saturn': 'Cancer', 'Rahu': 'Libra', 'Ketu': 'Aries'},
        'domain': 'career_fall', 'known_outcome': 'positive',
        'dasha_lord': 'Sun', 'antardasha_lord': 'Venus',
    },

    # Martha Stewart: Prison sentence (R-rated, AstroSage). Born 3 Aug 1941, 13:33, Jersey City NJ.
    # Convicted March 2004, imprisoned Oct 2004 for insider trading cover-up. Rahu MD / Moon AD.
    {
        'id': 'BLIND-044', 'name': 'Martha Stewart — prison for fraud 2004',
        'source': 'astrosage_R', 'lagna': 'Libra',
        'planets': {'Sun': 'Cancer', 'Moon': 'Sagittarius', 'Mars': 'Pisces', 'Mercury': 'Cancer',
                    'Jupiter': 'Taurus', 'Venus': 'Leo', 'Saturn': 'Taurus', 'Rahu': 'Virgo', 'Ketu': 'Pisces'},
        'domain': 'career_fall', 'known_outcome': 'positive',
        'dasha_lord': 'Rahu', 'antardasha_lord': 'Moon',
    },

    # ── Batch 4: Held-Out Validation — Career Fall Focus ──

    # PV Narasimha Rao: Political fall 1996. Born 28 Jun 1921, 11:30 AM, Karimnagar.
    # Lost PM position, faced corruption charges. Mars MD / Venus AD.
    # Source: Sanjay Rath / AstroSage. Virgo lagna.
    {
        'id': 'BLIND-045', 'name': 'PV Narasimha Rao — political fall 1996',
        'source': 'srath_A', 'lagna': 'Virgo',
        'planets': {'Sun': 'Gemini', 'Moon': 'Pisces', 'Mars': 'Gemini', 'Mercury': 'Gemini',
                    'Jupiter': 'Leo', 'Venus': 'Aries', 'Saturn': 'Leo', 'Rahu': 'Libra', 'Ketu': 'Aries'},
        'domain': 'career_fall', 'known_outcome': 'positive',
        'dasha_lord': 'Mars', 'antardasha_lord': 'Venus',
    },

    # Mussolini: Deposed July 1943. Born 29 Jul 1883, 14:10, Predappio, Italy.
    # Grand Council vote removed him from power. Saturn MD / Mars AD.
    # Source: Astrodatabank AA rating. Libra lagna (Scorpio in some refs but AA says Libra).
    {
        'id': 'BLIND-046', 'name': 'Mussolini — deposed and arrested 1943',
        'source': 'astrodatabank_AA', 'lagna': 'Libra',
        'planets': {'Sun': 'Cancer', 'Moon': 'Taurus', 'Mars': 'Taurus', 'Mercury': 'Cancer',
                    'Jupiter': 'Gemini', 'Venus': 'Gemini', 'Saturn': 'Taurus', 'Rahu': 'Libra', 'Ketu': 'Aries'},
        'domain': 'career_fall', 'known_outcome': 'positive',
        'dasha_lord': 'Saturn', 'antardasha_lord': 'Mars',
    },

    # Sanjay Gandhi: Electoral defeat 1977. Born 14 Dec 1946, 09:27 AM, New Delhi.
    # Landslide loss in post-Emergency elections. Moon MD / Jupiter AD.
    # Source: Frank Clifford (baby book record), Lagna360. Capricorn lagna.
    {
        'id': 'BLIND-047', 'name': 'Sanjay Gandhi — electoral defeat 1977',
        'source': 'lagna360_A', 'lagna': 'Capricorn',
        'planets': {'Sun': 'Scorpio', 'Moon': 'Leo', 'Mars': 'Sagittarius', 'Mercury': 'Scorpio',
                    'Jupiter': 'Libra', 'Venus': 'Libra', 'Saturn': 'Cancer', 'Rahu': 'Taurus', 'Ketu': 'Scorpio'},
        'domain': 'career_fall', 'known_outcome': 'positive',
        'dasha_lord': 'Moon', 'antardasha_lord': 'Jupiter',
    },

    # Amitabh Bachchan: ABCL bankruptcy 1997. Same chart as BLIND-004 but fall dasha.
    # Mercury MD / Moon AD during financial collapse.
    # Source: AstroSage A. Aquarius lagna.
    {
        'id': 'BLIND-048', 'name': 'Amitabh Bachchan — ABCL bankruptcy 1997',
        'source': 'astrosage_A', 'lagna': 'Aquarius',
        'planets': {'Sun': 'Virgo', 'Moon': 'Libra', 'Mars': 'Virgo', 'Mercury': 'Virgo',
                    'Jupiter': 'Cancer', 'Venus': 'Virgo', 'Saturn': 'Taurus', 'Rahu': 'Leo', 'Ketu': 'Aquarius'},
        'domain': 'career_fall', 'known_outcome': 'positive',
        'dasha_lord': 'Mercury', 'antardasha_lord': 'Moon',
    },

    # Jayalalithaa: Imprisoned 2014. Same chart as ADV-008 but fall event (not comeback).
    # Convicted Sep 2014 in disproportionate assets case. Jupiter MD/AD.
    # Source: Agyat.one AA. Taurus lagna.
    {
        'id': 'BLIND-049', 'name': 'Jayalalithaa — imprisoned for corruption 2014',
        'source': 'agyat_AA', 'lagna': 'Taurus',
        'planets': {'Sun': 'Aquarius', 'Moon': 'Leo', 'Mars': 'Leo', 'Mercury': 'Aquarius',
                    'Jupiter': 'Sagittarius', 'Venus': 'Pisces', 'Saturn': 'Cancer', 'Rahu': 'Aries', 'Ketu': 'Libra'},
        'domain': 'career_fall', 'known_outcome': 'positive',
        'dasha_lord': 'Jupiter', 'antardasha_lord': 'Jupiter',
    },
]


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


def run_blind_test(verbose=True, use_llm=False, model='gemini-2.0-flash', use_cache=True):
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

    total = len(BLIND_CASES)
    correct = 0
    incorrect = 0
    errors = 0
    by_domain = defaultdict(lambda: {'correct': 0, 'incorrect': 0, 'total': 0})

    for case in BLIND_CASES:
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
                      f'conf={conf:.2f} net={net:.1f}  |  {case["name"]}')
                if not is_correct:
                    # Show evidence
                    summary = pred.get('summary', '')[:200]
                    print(f'         summary: {summary}')

        except Exception as e:
            errors += 1
            if verbose:
                print(f'  ERROR {cid}: {e}')

    evaluated = correct + incorrect
    accuracy = correct / evaluated if evaluated > 0 else 0

    print(f'\n{"="*70}')
    print(f'BLIND TEST RESULTS (independent charts, not in training set)')
    print(f'{"="*70}')
    print(f'Total: {total}  |  Evaluated: {evaluated}  |  Errors: {errors}')
    print(f'Accuracy: {correct}/{evaluated} = {accuracy:.1%}')
    print()
    print('--- By Domain ---')
    for d, s in sorted(by_domain.items()):
        acc = s['correct'] / s['total'] if s['total'] > 0 else 0
        print(f'  {d:20s}: {s["correct"]}/{s["total"]} = {acc:.0%}')

    if use_llm:
        print_cost_summary()

    return {'accuracy': accuracy, 'correct': correct, 'evaluated': evaluated, 'by_domain': dict(by_domain)}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Blind test for Jyotish interpretation pipeline')
    parser.add_argument('--llm', action='store_true', help='Use LLM synthesis instead of rule-based stage7')
    parser.add_argument('--hybrid', action='store_true', help='Use hybrid mode: rule engine + LLM override')
    parser.add_argument('--model', default='gemini-2.0-flash',
                        help='LLM model (gemini-2.0-flash, gemini-2.5-flash, claude-sonnet, claude-haiku, claude-opus)')
    parser.add_argument('--no-cache', action='store_true', help='Disable LLM response cache')
    args = parser.parse_args()
    mode = 'hybrid' if args.hybrid else (True if args.llm else False)
    run_blind_test(use_llm=mode, model=args.model, use_cache=not args.no_cache)
