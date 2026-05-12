---
name: jyotish
description: Vedic astrology chart computation library (PyJHora + pyswisseph). Available only to groups that have chart_reader.py and chart PDFs mounted under /workspace/group/scripts/ and /workspace/group/charts/. Other groups will not have the scripts to use this. Trigger: "chart", "horoscope", "dasha", "transit", "nakshatra", "navamsa", "vimsottari".
---

# Jyotish (Vedic Astrology Computation)

## Availability

The `PyJHora` and `pyswisseph` Python packages are installed system-wide in the container, but the scripts and chart data they operate on (`chart_reader.py`, `interpret.py`, `engine.py`, horoscope PDFs) live ONLY in the group folder of groups authorized to use them. If you don't see `/workspace/group/scripts/chart_reader.py`, this skill is not active for you — ignore it.

## When Active

Use these scripts to parse JHora PDF exports and run the 7-stage interpretation pipeline:

```bash
python3 /workspace/group/scripts/chart_reader.py /workspace/group/charts/<pdf-filename>.pdf
```

Or in Python:

```python
import sys
sys.path.insert(0, '/workspace/group/scripts')
from chart_reader import parse_jhora_pdf, build_chart_data
from interpret import interpret_chart

parsed = parse_jhora_pdf('/workspace/group/charts/Amruth Horoscope - 1-32935f66d2599b93.pdf')
chart = build_chart_data(parsed)
result = interpret_chart(chart)
# result has: predictions, yogas, lp_classification, stage_results, dasha_analysis
```

The `interpret_chart()` output covers:
- **predictions**: Career, Marriage & Relationships, Wealth & Finance, Health, Spiritual — each with direction (positive/negative), confidence, net_score, summary
- **yogas**: list of detected yogas (Raja, Dhana, Kemadruma, Harsha/Viparita, Neecha Bhanga, etc.)
- **lp_classification**: Laghu Parashari planet classifications
- **stage_results**: intermediate analysis from each of the 7 stages

## Notes

- Charts use Lahiri ayanamsa by default (JHora's "True Lahiri" works for Nagpur and similar)
- Birth time precision matters — even 5 min shift moves dasha boundaries and house cusps
- `interpret.py` is ~3950 lines; check existing logic before modifying
- For follow-up Q&A without recomputation, prefer reading the group's MEMORY.md which has pre-extracted chart data

## Privacy

When this skill is active in an isolated group, treat all chart data, names, birth times, and discussion content as strictly private. Do NOT reference astrology, jyotish, charts, or planetary positions in any message preview, notification title, or push body. Inside the conversation, speak freely.
