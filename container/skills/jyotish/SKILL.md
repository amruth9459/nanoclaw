---
name: jyotish
description: Vedic astrology (Jyotish) chart calculation and interpretation using Swiss Ephemeris with Lahiri ayanamsa. Matches Jagannatha Hora accuracy.
allowed-tools: Bash, Read, Write
---

# Jyotish — Vedic Astrology Skill

## When to Use
- User asks for a birth chart, horoscope, or kundli
- User asks about planetary positions, dashas, transits, muhurta
- User asks about Vedic astrology concepts (rashis, nakshatras, yogas, doshas)
- User wants chart comparison or compatibility analysis

## Tool: `jyotish_calculate`

Call this MCP tool to compute a chart. Required parameters:
- `year`, `month`, `day` — birth date
- `hour`, `minute` — birth time (24-hour format)
- `place_name` — city name
- `latitude`, `longitude` — coordinates
- `timezone_offset` — hours from UTC (e.g., 5.5 for IST)

Optional:
- `ayanamsa` — default "LAHIRI" (matches JH). Options: LAHIRI, TRUE_CITRA, KP, RAMAN
- `divisional_charts` ��� list of D-chart factors. Default: [9, 10]
  - Shodasavarga: [2,3,4,7,9,10,12,16,20,24,27,30,40,45,60]

## What It Returns
- **D-1 Rasi chart** — all planet positions with rashi, degrees, nakshatra, pada
- **D-9 Navamsa** — soul chart
- **D-10 Dasamsa** — career chart
- **Vimshottari Dasha** ��� mahadasha + antardasha periods with dates
- **Shadbala** — six-fold planetary strength (Sthana, Dig, Kaala, Cheshta, Naisargika, Drik)
- **Bhava Bala** — house strengths

## Interpretation Guidelines

When interpreting charts, follow the Parashari system (BPHS) as taught by PVR Narasimha Rao and Sanjay Rath:

1. **Start with the Lagna** — the ascendant sign sets the framework
2. **Check Lagna lord** — its placement and strength
3. **Moon sign and nakshatra** — emotional nature, mind
4. **Yoga identification** — check for Rajayoga, Dhana yoga, Viparita Rajayoga
5. **Dasha analysis** — current and upcoming periods determine timing
6. **Divisional charts** — D-9 for marriage/dharma, D-10 for career
7. **Shadbala** — planets with high strength deliver results confidently
8. **Always correlate dashas with transits** for timing predictions

## Common Coordinates (IST +5.5)
- Mumbai: 19.0760, 72.8777
- Delhi: 28.6139, 77.2090
- Bangalore: 12.9716, 77.5946
- Chennai: 13.0827, 80.2707
- Kolkata: 22.5726, 88.3639
- Hyderabad: 17.3850, 78.4867
- Pune: 18.5204, 73.8567
