"""
Chart Reader — Reads Jagannatha Hora PDF exports and runs interpretation.

Extracts birth data and planet positions from JHora PDF files,
computes full charts via PyJHora engine, and runs the 7-stage
interpretation pipeline.

Usage:
    python3 chart_reader.py <file_or_folder> [--raw] [--all]
    python3 chart_reader.py /path/to/chart.pdf
    python3 chart_reader.py /path/to/Horoscopes/        # reads all PDFs
    python3 chart_reader.py /path/to/chart.pdf --raw     # show raw extracted data
"""
import sys, os, re, json, argparse, datetime
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))

# ── Rashi abbreviation map (JHora uses 2-letter codes) ───────────────────────
RASHI_ABBREV = {
    'Ar': 'Aries', 'Ta': 'Taurus', 'Ge': 'Gemini', 'Cn': 'Cancer',
    'Le': 'Leo', 'Vi': 'Virgo', 'Li': 'Libra', 'Sc': 'Scorpio',
    'Sg': 'Sagittarius', 'Cp': 'Capricorn', 'Aq': 'Aquarius', 'Pi': 'Pisces',
}

RASHI_FULL = list(RASHI_ABBREV.values())

# ── Nakshatra abbreviation map ───────────────────────────────────────────────
NAKSHATRA_ABBREV = {
    'Aswi': 'Ashwini', 'Bhar': 'Bharani', 'Krit': 'Krittika', 'Rohi': 'Rohini',
    'Mrig': 'Mrigashira', 'Ardr': 'Ardra', 'Puna': 'Punarvasu', 'Push': 'Pushya',
    'Asre': 'Ashlesha', 'Magh': 'Magha', 'PPha': 'Purva Phalguni',
    'UPha': 'Uttara Phalguni', 'Hast': 'Hasta', 'Chit': 'Chitra',
    'Swat': 'Swati', 'Visa': 'Vishakha', 'Anu': 'Anuradha', 'Anu ': 'Anuradha',
    'Jye': 'Jyeshtha', 'Mool': 'Mula', 'PSha': 'Purva Ashadha',
    'USha': 'Uttara Ashadha', 'Srav': 'Shravana', 'Dhan': 'Dhanishta',
    'Sata': 'Shatabhisha', 'PBha': 'Purva Bhadrapada',
    'UBha': 'Uttara Bhadrapada', 'Reva': 'Revati',
}

# Bodies we care about (in order)
PLANET_NAMES = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn', 'Rahu', 'Ketu']
LAGNA_AND_PLANETS = ['Lagna'] + PLANET_NAMES


def parse_jhora_pdf(pdf_path: str) -> dict:
    """Parse a Jagannatha Hora PDF export and extract chart data."""
    import fitz
    doc = fitz.open(pdf_path)

    # Extract text from all pages
    full_text = ''
    for page in doc:
        full_text += page.get_text() + '\n'
    doc.close()

    result = {
        'file': os.path.basename(pdf_path),
        'name': '',
        'birth_date': '',
        'birth_time': '',
        'timezone_offset': 5.5,
        'place_name': '',
        'latitude': 0.0,
        'longitude': 0.0,
        'year': 0, 'month': 0, 'day': 0,
        'hour': 0, 'minute': 0, 'second': 0,
        'lagna_rashi': '',
        'planets': {},
        'navamsha': {},
        'chara_karakas': {},
        'vimsottari_dasha': [],
        'ayanamsa': 'LAHIRI',
    }

    lines = full_text.split('\n')

    # ── Extract name ─────────────────────────────────────────────────────
    # First non-empty line after "Please enter your name"
    for i, line in enumerate(lines):
        if 'Please enter your name' in line:
            for j in range(i + 1, min(i + 3, len(lines))):
                name = lines[j].strip()
                if name and name not in ('Please', ''):
                    result['name'] = name
                    break
            break

    # ── Extract birth date/time ──────────────────────────────────────────
    # Format: "December 7, 1993"
    date_pattern = re.compile(
        r'(January|February|March|April|May|June|July|August|September|October|November|December)\s+'
        r'(\d{1,2}),?\s+(\d{4})'
    )
    time_pattern = re.compile(r'(\d{1,2}):(\d{2}):(\d{2})\s*(?:(am|pm)\s*)?\((\d+):(\d{2})\s*(East|West)\s*of\s*GMT\)')

    for line in lines[:20]:  # Birth data is in the first few lines
        dm = date_pattern.search(line)
        if dm:
            month_names = ['January', 'February', 'March', 'April', 'May', 'June',
                           'July', 'August', 'September', 'October', 'November', 'December']
            result['month'] = month_names.index(dm.group(1)) + 1
            result['day'] = int(dm.group(2))
            result['year'] = int(dm.group(3))
            result['birth_date'] = f"{result['year']}-{result['month']:02d}-{result['day']:02d}"

        tm = time_pattern.search(line)
        if tm:
            hour = int(tm.group(1))
            ampm = tm.group(4)
            if ampm == 'pm' and hour < 12:
                hour += 12
            elif ampm == 'am' and hour == 12:
                hour = 0
            result['hour'] = hour
            result['minute'] = int(tm.group(2))
            result['second'] = int(tm.group(3))
            tz_h = int(tm.group(5))
            tz_m = int(tm.group(6))
            tz_offset = tz_h + tz_m / 60.0
            if tm.group(7) == 'West':
                tz_offset = -tz_offset
            result['timezone_offset'] = tz_offset
            result['birth_time'] = f"{result['hour']:02d}:{result['minute']:02d}:{result['second']:02d}"

    # ── Extract coordinates and place ────────────────────────────────────
    coord_pattern = re.compile(
        r'(\d+)\s*E\s*(\d+)[\'°]\s*(\d+)?[\'"]?\s*,\s*'
        r'(\d+)\s*N\s*(\d+)[\'°]\s*(\d+)?[\'"]?\s*'
        r'\(([^)]+)\)'
    )
    for line in lines[:20]:
        cm = coord_pattern.search(line)
        if cm:
            lon_d, lon_m = int(cm.group(1)), int(cm.group(2))
            lon_s = int(cm.group(3)) if cm.group(3) else 0
            lat_d, lat_m = int(cm.group(4)), int(cm.group(5))
            lat_s = int(cm.group(6)) if cm.group(6) else 0
            result['longitude'] = lon_d + lon_m / 60.0 + lon_s / 3600.0
            result['latitude'] = lat_d + lat_m / 60.0 + lat_s / 3600.0
            result['place_name'] = cm.group(7).strip()
            break

    # ── Extract planet positions ─────────────────────────────────────────
    # JHora PDFs split each planet across multiple lines:
    # Line 0: "Sun - BK" or "Lagna "
    # Line 1: " 22 Sc 19' 38.28" Jye" or " 3 Sg 02' 44.89"" (nakshatra may be separate)
    # Line 2: nakshatra (if not on line 1) or pada number
    # Line 3: pada number or rasi abbrev
    # Line 4: rasi abbrev or navamsa abbrev
    # Line 5: navamsa abbrev

    planet_header = re.compile(
        r'^(Lagna|Sun|Moon|Mars|Mercury|Jupiter|Venus|Saturn|Rahu|Ketu)\s*(?:-\s*(\w+))?\s*$'
    )
    degree_line = re.compile(
        r'^\s*(\d+)\s+(\w{2})\s+(\d+)[\'°]\s*([\d.]+)[\'"]?\s*(?:"?\s*(\w+))?\s*$'
    )

    i = 0
    while i < len(lines):
        hm = planet_header.match(lines[i].strip())
        if hm:
            body = hm.group(1)
            karaka = hm.group(2) or ''

            # Next line should have degree data
            if i + 1 < len(lines):
                dm = degree_line.match(lines[i + 1])
                if dm:
                    deg = int(dm.group(1))
                    rashi_abbr = dm.group(2)
                    minutes = int(dm.group(3))
                    seconds = float(dm.group(4))
                    nakshatra_abbr = dm.group(5) or ''

                    # Read remaining fields from subsequent lines
                    offset = 2
                    if not nakshatra_abbr and i + offset < len(lines):
                        nakshatra_abbr = lines[i + offset].strip()
                        offset += 1

                    pada = 1
                    if i + offset < len(lines):
                        try:
                            pada = int(lines[i + offset].strip())
                            offset += 1
                        except ValueError:
                            pass

                    rasi_abbr = ''
                    if i + offset < len(lines):
                        val = lines[i + offset].strip()
                        if val in RASHI_ABBREV:
                            rasi_abbr = val
                            offset += 1

                    navamsa_abbr = ''
                    if i + offset < len(lines):
                        val = lines[i + offset].strip()
                        if val in RASHI_ABBREV:
                            navamsa_abbr = val
                            offset += 1

                    rashi = RASHI_ABBREV.get(rashi_abbr, rashi_abbr)
                    navamsa_rashi = RASHI_ABBREV.get(navamsa_abbr, navamsa_abbr)
                    nakshatra = NAKSHATRA_ABBREV.get(nakshatra_abbr.strip(), nakshatra_abbr.strip())
                    total_degrees = deg + minutes / 60.0 + seconds / 3600.0

                    entry = {
                        'body': body,
                        'rashi': rashi,
                        'degrees': total_degrees,
                        'nakshatra': nakshatra,
                        'pada': pada,
                        'retro': False,
                        'navamsa_rashi': navamsa_rashi,
                    }

                    if karaka:
                        result['chara_karakas'][body] = karaka

                    if body == 'Lagna':
                        result['lagna_rashi'] = rashi
                        result['planets']['Lagna'] = entry
                    else:
                        result['planets'][body] = entry

                    i += offset
                    continue
        i += 1

    # ── Check retrograde (R) marker ──────────────────────────────────────
    retro_pattern = re.compile(r'(Mars|Mercury|Jupiter|Venus|Saturn|Rahu|Ketu)\s*\(R\)')
    for line in lines:
        rm = retro_pattern.search(line)
        if rm and rm.group(1) in result['planets']:
            result['planets'][rm.group(1)]['retro'] = True

    # Also check for "(R)" in the longitude lines
    for line in lines:
        for planet in PLANET_NAMES:
            if planet in line and '(R)' in line:
                if planet in result['planets']:
                    result['planets'][planet]['retro'] = True

    # ── Extract Vimsottari dasha periods ─────────────────────────────────
    # JHora PDF format (line-by-line):
    #   "Sun"              ← MD header: planet name alone
    #   "Sun 1993-06-21"   ← First AD: same planet + date (confirms MD)
    #   "Moon1993-10-11"   ← AD: planet+date on one line
    #   "Jup"              ← AD: planet name alone (date on next line)
    #   "1995-07-10"       ← Date for above AD
    #
    # Key: MD header is detected when planet alone on line AND next line
    # starts with the SAME planet name + date.

    dasha_abbrev = {
        'Sun': 'Sun', 'Moon': 'Moon', 'Mars': 'Mars', 'Rah': 'Rahu',
        'Jup': 'Jupiter', 'Sat': 'Saturn', 'Merc': 'Mercury',
        'Ket': 'Ketu', 'Ven': 'Venus',
    }
    planet_re = re.compile(r'^(Sun|Moon|Mars|Rah|Jup|Sat|Merc|Ket|Ven)\s*$')
    ad_inline_re = re.compile(r'(Sun|Moon|Mars|Rah|Jup|Sat|Merc|Ket|Ven)\s*(\d{4}-\d{2}-\d{2})')
    date_re = re.compile(r'^(\d{4}-\d{2}-\d{2})\s*$')

    # Find vimsottari section boundaries
    vim_start = None
    vim_end = None
    for i, line in enumerate(lines):
        if 'Vimsottari Dasa' in line and 'Tribhagi' not in line:
            vim_start = i + 1
        elif vim_start and not vim_end:
            # End at next dasa section or page break
            if ('Dasa' in line or 'dasa' in line) and 'Vimsottari' not in line:
                vim_end = i
                break

    if vim_start:
        if not vim_end:
            vim_end = min(vim_start + 200, len(lines))

        current_md = None
        i = vim_start
        while i < vim_end:
            line = lines[i].strip()

            # Check for planet name alone on line
            pm = planet_re.match(line)
            if pm:
                planet = pm.group(1)
                # Look ahead: is next line "same_planet date" → MD header
                # Or just a date → split AD entry
                if i + 1 < vim_end:
                    next_line = lines[i + 1].strip()
                    next_ad = ad_inline_re.match(next_line)
                    next_date = date_re.match(next_line)

                    if next_ad and next_ad.group(1) == planet:
                        # MD header confirmed (first AD = same planet)
                        current_md = dasha_abbrev.get(planet, planet)
                        # The next line will be processed as an AD entry
                        i += 1
                        continue
                    elif next_date:
                        # Split AD: planet on this line, date on next
                        ad_lord = dasha_abbrev.get(planet, planet)
                        result['vimsottari_dasha'].append({
                            'md': current_md,
                            'ad': ad_lord,
                            'start': next_date.group(1),
                        })
                        i += 2
                        continue
                    else:
                        # Duplicate MD header (e.g. "Jup\nJup\n2034-06-21")
                        # Check if line after next is a date
                        if i + 2 < vim_end:
                            next_next = lines[i + 2].strip()
                            nn_date = date_re.match(next_next)
                            nn_ad = ad_inline_re.match(next_next)
                            if planet_re.match(next_line) and next_line == line:
                                # Duplicate MD header followed by date
                                current_md = dasha_abbrev.get(planet, planet)
                                if nn_date:
                                    ad_lord = dasha_abbrev.get(planet, planet)
                                    result['vimsottari_dasha'].append({
                                        'md': current_md,
                                        'ad': ad_lord,
                                        'start': nn_date.group(1),
                                    })
                                    i += 3
                                    continue
                                i += 2
                                continue
                i += 1
                continue

            # Check for inline AD: "Moon1993-10-11" or "Mars 1994-04-07"
            am = ad_inline_re.match(line)
            if am:
                ad_lord = dasha_abbrev.get(am.group(1), am.group(1))
                result['vimsottari_dasha'].append({
                    'md': current_md,
                    'ad': ad_lord,
                    'start': am.group(2),
                })

            i += 1

    # Detect ayanamsa from filename
    fname = os.path.basename(pdf_path).lower()
    if 'pushya' in fname:
        result['ayanamsa'] = 'PUSHYA_PAKSHA'
    elif 'true lahiri' in fname:
        result['ayanamsa'] = 'TRUE_LAHIRI'
    elif 'kp' in fname:
        result['ayanamsa'] = 'KP'
    elif 'tajaka' in fname:
        result['ayanamsa'] = 'TAJAKA'
    else:
        result['ayanamsa'] = 'LAHIRI'

    return result


def _convert_parsed_dasha_to_engine_format(parsed_dasha: list) -> list:
    """Convert PDF-parsed dasha entries to the format interpret.py expects.

    Input format: [{'md': 'Rahu', 'ad': 'Mercury', 'start': '2024-06-02'}, ...]
    Output format: [{'lord': 'Rahu/Mercury', 'start_date': '2024-06-02',
                     'end_date': '2026-12-22', 'level': 'antar', 'years': 2.5}, ...]
    """
    if not parsed_dasha:
        return []

    result = []
    # Group by MD lord to build maha entries
    md_groups = {}
    for entry in parsed_dasha:
        md = entry['md']
        if md not in md_groups:
            md_groups[md] = []
        md_groups[md].append(entry)

    # Build maha-level entries
    md_starts = {}
    for md, entries in md_groups.items():
        if entries:
            first_start = entries[0]['start']
            md_starts[md] = first_start

    # Sort MD by start date
    sorted_mds = sorted(md_starts.items(), key=lambda x: x[1])

    for idx, (md, md_start) in enumerate(sorted_mds):
        # MD end = next MD start, or +20 years
        if idx + 1 < len(sorted_mds):
            md_end = sorted_mds[idx + 1][1]
        else:
            # Approximate: add max dasha years
            from datetime import timedelta
            s = datetime.date.fromisoformat(md_start)
            md_end = (s + timedelta(days=365 * 20)).isoformat()

        result.append({
            'lord': md,
            'start_date': md_start,
            'end_date': md_end,
            'level': 'maha',
            'years': 0,
        })

    # Build antar-level entries
    for i, entry in enumerate(parsed_dasha):
        start = entry['start']
        # End date = next entry's start, or MD end
        if i + 1 < len(parsed_dasha):
            end = parsed_dasha[i + 1]['start']
        else:
            from datetime import timedelta
            s = datetime.date.fromisoformat(start)
            end = (s + timedelta(days=365 * 3)).isoformat()

        sd = datetime.date.fromisoformat(start)
        ed = datetime.date.fromisoformat(end)
        years = (ed - sd).days / 365.25

        result.append({
            'lord': f"{entry['md']}/{entry['ad']}",
            'start_date': start,
            'end_date': end,
            'level': 'antar',
            'years': round(years, 3),
        })

    return result


def _build_rasi_from_parsed(parsed: dict) -> list:
    """Build rasi list from PDF-parsed planet data."""
    rasi = []
    if parsed.get('lagna_rashi'):
        lagna_entry = parsed['planets'].get('Lagna', {})
        rasi.append({
            'body': 'Lagna',
            'rashi': parsed['lagna_rashi'],
            'degrees': lagna_entry.get('degrees', 0),
            'nakshatra': lagna_entry.get('nakshatra'),
            'pada': lagna_entry.get('pada'),
            'retro': False,
        })
    for name in PLANET_NAMES:
        if name in parsed['planets']:
            p = parsed['planets'][name]
            rasi.append({
                'body': name,
                'rashi': p['rashi'],
                'degrees': p['degrees'],
                'nakshatra': p.get('nakshatra'),
                'pada': p.get('pada'),
                'retro': p.get('retro', False),
            })
    return rasi


def find_current_dasha(dasha_periods: list, ref_date: str = None) -> dict:
    """Find current Vimsottari MD and AD from parsed dasha periods."""
    if not dasha_periods:
        return {}

    if ref_date is None:
        ref_date = datetime.date.today().isoformat()

    ref = datetime.date.fromisoformat(ref_date)
    current_md = None
    current_ad = None

    for i, period in enumerate(dasha_periods):
        start = datetime.date.fromisoformat(period['start'])
        if start <= ref:
            current_md = period['md']
            current_ad = period['ad']
        elif start > ref:
            break

    return {'md': current_md, 'ad': current_ad}


def build_chart_data(parsed: dict) -> dict:
    """Build chart_data dict compatible with interpret_chart().

    Two strategies:
    1. If PyJHora available and birth data complete → compute full chart
    2. Otherwise → build from parsed PDF data (limited but functional)
    """

    # Try PyJHora computation first (gives dashas, transits, ashtakavarga, etc.)
    if (parsed['year'] and parsed['latitude'] and parsed['longitude']):
        try:
            from engine import compute_chart
            from dataclasses import asdict

            result = compute_chart(
                year=parsed['year'], month=parsed['month'], day=parsed['day'],
                hour=parsed['hour'], minute=parsed['minute'], second=parsed['second'],
                place_name=parsed['place_name'],
                latitude=parsed['latitude'], longitude=parsed['longitude'],
                timezone_offset=parsed['timezone_offset'],
                ayanamsa='LAHIRI',  # Always use Lahiri for interpretation
                divisional_charts=[9, 10],
                analyses=['all'],
            )
            if result:
                chart = asdict(result)
                chart['_source'] = 'pyjhora_computed'
                chart['_parsed_name'] = parsed['name']

                # Override engine vimsottari with PDF-parsed dasha data
                # (JHora PDF's dasha periods are more trustworthy than re-computation
                #  since the user generated them with exact settings)
                if parsed.get('vimsottari_dasha'):
                    chart['vimshottari'] = _convert_parsed_dasha_to_engine_format(
                        parsed['vimsottari_dasha']
                    )
                    chart['_dasha_source'] = 'pdf_parsed'

                # Check lagna agreement
                pdf_lagna = parsed.get('lagna_rashi', '')
                engine_lagna = ''
                for p in chart.get('rasi', []):
                    if p.get('body') == 'Lagna':
                        engine_lagna = p.get('rashi', '')
                        break
                if pdf_lagna and engine_lagna and pdf_lagna != engine_lagna:
                    if parsed['ayanamsa'] == 'LAHIRI':
                        # Same ayanamsa but lagna differs — use PDF positions
                        print(f'  WARNING: Lagna mismatch — PDF={pdf_lagna}, engine={engine_lagna}')
                        print(f'  Using PDF positions (from your JHora chart)')
                        chart['rasi'] = _build_rasi_from_parsed(parsed)
                        chart['_positions_source'] = 'pdf_parsed'
                    else:
                        # Different ayanamsa — expected mismatch, use engine's LAHIRI computation
                        print(f'  NOTE: Lagna differs (PDF={pdf_lagna} [{parsed["ayanamsa"]}], engine={engine_lagna} [LAHIRI])')
                        print(f'  Using engine LAHIRI computation for interpretation')

                return chart
        except Exception as e:
            print(f'  PyJHora computation failed: {e}')
            print(f'  Falling back to PDF-parsed positions...')

    # Fallback: build from parsed positions
    rasi = []
    if parsed.get('lagna_rashi'):
        lagna_entry = parsed['planets'].get('Lagna', {})
        rasi.append({
            'body': 'Lagna',
            'rashi': parsed['lagna_rashi'],
            'degrees': lagna_entry.get('degrees', 0),
            'nakshatra': lagna_entry.get('nakshatra'),
            'pada': lagna_entry.get('pada'),
            'retro': False,
        })

    for name in PLANET_NAMES:
        if name in parsed['planets']:
            p = parsed['planets'][name]
            rasi.append({
                'body': name,
                'rashi': p['rashi'],
                'degrees': p['degrees'],
                'nakshatra': p.get('nakshatra'),
                'pada': p.get('pada'),
                'retro': p.get('retro', False),
            })

    # Build navamsha from parsed data
    navamsha = []
    for name in LAGNA_AND_PLANETS:
        if name in parsed['planets'] and 'navamsa_rashi' in parsed['planets'][name]:
            navamsha.append({
                'body': name,
                'rashi': parsed['planets'][name]['navamsa_rashi'],
                'degrees': 15.0,  # Default mid-sign
            })

    # Build vimsottari from parsed dasha
    vimsottari = []
    for period in parsed.get('vimsottari_dasha', []):
        vimsottari.append({
            'level': 'AD',
            'lord': period['ad'],
            'start': period['start'],
            'md_lord': period['md'],
        })

    chart_data = {
        'rasi': rasi,
        'navamsha': navamsha,
        'vimshottari': vimsottari,
        'birth_date': parsed['birth_date'],
        'birth_time': parsed['birth_time'],
        'place_name': parsed['place_name'],
        '_source': 'pdf_parsed',
        '_parsed_name': parsed['name'],
    }

    return chart_data


def interpret_from_pdf(pdf_path: str, verbose: bool = True) -> dict:
    """Full pipeline: PDF → parse → compute → interpret."""
    from interpret import interpret_chart

    if verbose:
        print(f'\n{"="*70}')
        print(f'Reading: {os.path.basename(pdf_path)}')
        print(f'{"="*70}')

    # Parse PDF
    parsed = parse_jhora_pdf(pdf_path)

    if verbose:
        print(f'Name:     {parsed["name"]}')
        print(f'Born:     {parsed["birth_date"]} at {parsed["birth_time"]}')
        print(f'Place:    {parsed["place_name"]} ({parsed["latitude"]:.4f}N, {parsed["longitude"]:.4f}E)')
        print(f'Lagna:    {parsed["lagna_rashi"]}')
        print(f'Ayanamsa: {parsed["ayanamsa"]}')
        print(f'Planets:  {len(parsed["planets"])} found')

        # Show current dasha
        current = find_current_dasha(parsed['vimsottari_dasha'])
        if current:
            print(f'Dasha:    {current.get("md", "?")} MD / {current.get("ad", "?")} AD')

    # Build chart data
    chart_data = build_chart_data(parsed)

    if verbose:
        source = chart_data.get('_source', 'unknown')
        print(f'Source:   {source}')

    # Run interpretation
    result = interpret_chart(chart_data)

    if verbose and 'error' not in result:
        print(f'\n--- Interpretation ---')
        print(f'Lagna:      {result["chart_summary"]["lagna"]}')
        print(f'Strong:     {", ".join(result["chart_summary"]["strong_planets"])}')
        print(f'Weak:       {", ".join(result["chart_summary"]["weak_planets"])}')
        print(f'Yogakaraka: {result["chart_summary"].get("yogakaraka", "None")}')
        print(f'Confidence: {result["overall_confidence"]:.2f}')
        print(f'Yogas:      {result["yogas"]["count"]} ({result["yogas"]["raja_yoga_count"]} raja, {result["yogas"]["dhana_yoga_count"]} dhana)')

        if result.get('active_yogas'):
            print(f'\nActive Yogas:')
            for y in result['active_yogas'][:10]:
                print(f'  - {y}')

        print(f'\n--- Predictions ---')
        for pred in result.get('predictions', []):
            direction_mark = '+' if pred['direction'] == 'positive' else '-' if pred['direction'] == 'negative' else '~'
            print(f'  [{direction_mark}] {pred["area"]:25s}  '
                  f'direction={pred["direction"]:8s}  '
                  f'confidence={pred["confidence"]:.2f}  '
                  f'net={pred.get("net_score", 0):.1f}')
            if pred.get('summary'):
                # Wrap summary
                summary = pred['summary'][:200]
                print(f'      {summary}')

        # LP insight
        if result.get('lp_insight'):
            print(f'\n--- Laghu Parashari Insight ---')
            lp = result['lp_insight']
            if isinstance(lp, dict):
                for k, v in lp.items():
                    if isinstance(v, str):
                        print(f'  {k}: {v[:150]}')
                    elif isinstance(v, dict):
                        print(f'  {k}:')
                        for kk, vv in v.items():
                            print(f'    {kk}: {vv}')

    elif 'error' in result:
        print(f'\nERROR: {result["error"]}')

    return {
        'parsed': parsed,
        'chart_data': chart_data,
        'interpretation': result,
    }


def read_all_charts(folder: str, filter_person: str = None, verbose: bool = True):
    """Read all PDF charts in a folder."""
    folder = Path(folder)
    pdfs = sorted(folder.glob('*.pdf'))

    if not pdfs:
        print(f'No PDF files found in {folder}')
        return []

    # Group by person (first word/prefix before " -")
    groups = {}
    for pdf in pdfs:
        name = pdf.stem
        # Extract person prefix: "AS", "ILC", "SSB", "SCS", "Amruth", "Jatakam"
        prefix = name.split(' - ')[0].split(' ')[0]
        if prefix not in groups:
            groups[prefix] = []
        groups[prefix].append(pdf)

    print(f'Found {len(pdfs)} PDF files for {len(groups)} person(s): {", ".join(groups.keys())}')

    results = []
    for prefix, files in groups.items():
        if filter_person and prefix.lower() != filter_person.lower():
            continue

        # Pick the best file for interpretation (prefer "Horoscope" or "Lahiri")
        best = None
        for f in files:
            fname = f.stem.lower()
            if 'horoscope' in fname:
                best = f
                break
            if 'lahiri' in fname and 'true' not in fname and not best:
                best = f

        if not best:
            # Pick first non-Tajaka, non-KP file
            for f in files:
                fname = f.stem.lower()
                if 'tajaka' not in fname and 'kp' not in fname:
                    best = f
                    break

        if not best:
            best = files[0]

        print(f'\n{"#"*70}')
        print(f'# {prefix} — using: {best.name}')
        print(f'# Other files: {", ".join(f.stem for f in files if f != best)}')
        print(f'{"#"*70}')

        result = interpret_from_pdf(str(best), verbose=verbose)
        results.append(result)

    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Read Jagannatha Hora PDF charts and interpret')
    parser.add_argument('path', help='PDF file or folder containing PDFs')
    parser.add_argument('--raw', action='store_true', help='Show raw parsed data')
    parser.add_argument('--all', action='store_true', help='Process all files (not just best per person)')
    parser.add_argument('--person', type=str, help='Filter by person prefix (e.g. AS, ILC)')
    parser.add_argument('--json', action='store_true', help='Output as JSON')
    args = parser.parse_args()

    path = Path(args.path)

    if path.is_dir():
        results = read_all_charts(str(path), filter_person=args.person)
    elif path.is_file() and path.suffix.lower() == '.pdf':
        if args.raw:
            parsed = parse_jhora_pdf(str(path))
            print(json.dumps(parsed, indent=2, default=str))
        else:
            result = interpret_from_pdf(str(path))
            if args.json:
                # Strip non-serializable data
                print(json.dumps(result['interpretation'], indent=2, default=str))
    else:
        print(f'Error: {path} is not a PDF file or directory')
        sys.exit(1)
