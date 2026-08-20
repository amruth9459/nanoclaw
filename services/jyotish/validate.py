"""
Automated JH vs PyJHora comparison.
Reads .jhd files from Jagannatha Hora, parses birth data + pre-computed positions,
runs PyJHora, and compares planetary longitudes.
"""
import os
import sys
import glob
import json

# Add engine to path
sys.path.insert(0, os.path.dirname(__file__))
from engine import compute_chart, RASHI

JHD_DIR = os.path.expanduser(
    "~/Library/Containers/com.isaacmarovitz.Whisky/Bottles/"
    "432D26C5-8234-4BC1-A299-3AACF39B0D5D/drive_c/"
    "Program Files (x86)/Jagannatha Hora/data"
)

# JHD stores: Sun, Moon, Mars, Mercury, Jupiter, Venus, Saturn, Rahu, Lagna
# (NOT Ketu — the 9th value is the Ascendant, not Ketu)
PLANET_ORDER = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn', 'Rahu', 'Lagna']


def parse_jhd(filepath):
    """Parse a .jhd file. Returns dict with birth data and optional JH positions."""
    with open(filepath) as f:
        lines = [l.strip() for l in f.readlines() if l.strip()]

    if len(lines) < 7:
        return None

    month = int(lines[0])
    day = int(lines[1])
    year = int(lines[2])
    time_decimal = float(lines[3])
    tz_raw = float(lines[4])
    lon_raw = float(lines[5])
    lat = float(lines[6])

    # JH convention: negative longitude = east, negative tz = east of Greenwich
    longitude = abs(lon_raw)
    timezone_offset = abs(tz_raw)

    hour = int(time_decimal)
    minute = int((time_decimal - hour) * 60)
    second = int(((time_decimal - hour) * 60 - minute) * 60)

    result = {
        'month': month, 'day': day, 'year': year,
        'hour': hour, 'minute': minute, 'second': second,
        'latitude': lat, 'longitude': longitude,
        'timezone_offset': timezone_offset,
        'jh_positions': None,
        'jh_retro': None,
    }

    # Check for pre-computed positions (9 float values after a float8 value)
    # Format: ayanamsa_frac, Sun, Moon, Mars, Mercury, Jupiter, Venus, Saturn, Rahu, Ketu
    # Then a string of 0/1 for retrograde flags
    if len(lines) >= 17:
        try:
            val8 = float(lines[7])
            positions = []
            retro_line = None
            for i in range(8, min(17, len(lines))):
                try:
                    v = float(lines[i])
                    # Check if this looks like a longitude (0-360) or tz (-12 to 12)
                    if v < -15 or (v > 15 and v < 360):
                        positions.append(v)
                    else:
                        break
                except ValueError:
                    # Might be retro flags or place name
                    if all(c in '01' for c in lines[i]) and len(lines[i]) == 9:
                        retro_line = lines[i]
                    break

            if len(positions) == 9:
                result['jh_positions'] = dict(zip(PLANET_ORDER, positions))
                # Check for retrograde flags
                retro_idx = 8 + 9  # After the 9 positions
                if retro_idx < len(lines):
                    flags = lines[retro_idx]
                    if all(c in '01' for c in flags) and len(flags) == 9:
                        result['jh_retro'] = {
                            PLANET_ORDER[i]: flags[i] == '1'
                            for i in range(9)
                        }
                if retro_line:
                    result['jh_retro'] = {
                        PLANET_ORDER[i]: retro_line[i] == '1'
                        for i in range(9)
                    }
        except (ValueError, IndexError):
            pass

    return result


def run_comparison():
    """Compare all JHD charts against PyJHora."""
    jhd_files = sorted(glob.glob(os.path.join(JHD_DIR, "*.jhd")))
    if not jhd_files:
        print(f"No .jhd files found in {JHD_DIR}")
        return

    print(f"Found {len(jhd_files)} JH chart files\n")
    print(f"{'='*80}")

    total_tests = 0
    total_match = 0
    total_positions_compared = 0
    max_diff = 0
    diffs = []

    for jhd_file in jhd_files:
        name = os.path.basename(jhd_file).replace('.jhd', '')
        data = parse_jhd(jhd_file)
        if not data:
            print(f"\n  SKIP: {name} (couldn't parse)")
            continue

        print(f"\n  {name}")
        print(f"  {data['year']}-{data['month']:02d}-{data['day']:02d} "
              f"{data['hour']:02d}:{data['minute']:02d}:{data['second']:02d} "
              f"Lat:{data['latitude']} Lon:{data['longitude']} TZ:{data['timezone_offset']}")

        # Run PyJHora
        try:
            chart = compute_chart(
                year=data['year'], month=data['month'], day=data['day'],
                hour=data['hour'], minute=data['minute'], second=data['second'],
                place_name=name,
                latitude=data['latitude'],
                longitude=data['longitude'],
                timezone_offset=data['timezone_offset'],
            )
        except Exception as e:
            print(f"  ERROR: {e}")
            continue

        total_tests += 1

        # Print PyJHora positions (include Lagna for comparison)
        pyjhora_longs = {}
        for p in chart.rasi:
            abs_long = p.rashi_idx * 30 + p.degrees
            pyjhora_longs[p.body] = abs_long

        if data['jh_positions']:
            # Direct comparison with JH pre-computed positions
            print(f"  {'Planet':10s} {'JH Sidereal':>12s} {'PyJHora':>12s} {'Diff':>8s} {'Match':>6s}")
            print(f"  {'-'*50}")
            all_match = True
            for planet in PLANET_ORDER:
                jh_val = data['jh_positions'].get(planet)
                pj_val = pyjhora_longs.get(planet)
                if jh_val is not None and pj_val is not None:
                    diff = abs(jh_val - pj_val)
                    if diff > 180:
                        diff = 360 - diff
                    diff_arcmin = diff * 60
                    match = "OK" if diff_arcmin < 5 else "DIFF"
                    if diff_arcmin >= 5:
                        all_match = False
                    total_positions_compared += 1
                    if diff_arcmin < 5:
                        total_match += 1
                    if diff_arcmin > max_diff:
                        max_diff = diff_arcmin
                    diffs.append((name, planet, diff_arcmin))

                    jh_rashi = int(jh_val / 30)
                    jh_deg = jh_val % 30
                    pj_rashi = int(pj_val / 30)
                    pj_deg = pj_val % 30

                    print(f"  {planet:10s} {RASHI[jh_rashi]:>3s} {jh_deg:6.2f}° "
                          f"{RASHI[pj_rashi]:>3s} {pj_deg:6.2f}° "
                          f"{diff_arcmin:6.1f}' {match:>6s}")

            if all_match:
                print(f"  ** ALL POSITIONS MATCH (< 5 arcmin) **")
        else:
            # No JH reference, just print PyJHora output
            print(f"  (No JH pre-computed positions — PyJHora output only)")
            for planet in PLANET_ORDER:
                val = pyjhora_longs.get(planet)
                if val is not None:
                    rashi = int(val / 30)
                    deg = val % 30
                    print(f"  {planet:10s} {RASHI[rashi]:>13s} {deg:6.2f}°")

    # Summary
    print(f"\n{'='*80}")
    print(f"COMPARISON SUMMARY")
    print(f"{'='*80}")
    print(f"Charts tested:        {total_tests}")
    print(f"Positions compared:   {total_positions_compared}")
    print(f"Matching (< 5'):      {total_match}")
    if total_positions_compared:
        pct = total_match / total_positions_compared * 100
        print(f"Match rate:           {pct:.1f}%")
        print(f"Max difference:       {max_diff:.1f} arcmin")

    # Show worst mismatches
    if diffs:
        diffs.sort(key=lambda x: x[2], reverse=True)
        print(f"\nTop differences:")
        for name, planet, d in diffs[:10]:
            print(f"  {name:30s} {planet:10s} {d:.1f}'")


if __name__ == '__main__':
    run_comparison()
