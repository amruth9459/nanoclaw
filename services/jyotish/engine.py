"""
Jyotish Calculation Engine — PyJHora wrapper with clean API.
Designed for NanoClaw integration. Matches Jagannatha Hora defaults.

Supports 55+ dasha systems, 100+ yogas, sahams, tajaka, and all JH analyses.
"""

import json
import re
import sys
import os
import io
from dataclasses import dataclass, field, asdict
from typing import Optional

# Suppress PyJHora's noisy sys.path prints during import
_real_stdout = sys.stdout
sys.stdout = io.StringIO()
try:
    from jhora.horoscope.chart import charts, strength, ashtakavarga as av_mod
    from jhora.horoscope.chart import house, yoga as yoga_mod, raja_yoga as rj_mod
    from jhora.horoscope.chart import dosha as dosha_mod, sphuta as sphuta_mod
    from jhora.horoscope.chart import arudhas as arudha_mod
    # Graha dashas (24 systems)
    from jhora.horoscope.dhasa.graha import vimsottari, ashtottari, yogini
    from jhora.horoscope.dhasa.graha import moola as moola_d, naisargika as naisargika_d
    from jhora.horoscope.dhasa.graha import buddhi_gathi, dwadasottari, chathuraaseethi_sama
    from jhora.horoscope.dhasa.graha import karana_chathuraaseethi_sama, panchottari
    from jhora.horoscope.dhasa.graha import shodasottari, sataatbika, dwisatpathi
    from jhora.horoscope.dhasa.graha import kaala as kaala_d, karaka as karaka_d
    from jhora.horoscope.dhasa.graha import rashmi as rashmi_d, tara as tara_d
    from jhora.horoscope.dhasa.graha import saptharishi_nakshathra, shastihayani, shattrimsa_sama
    from jhora.horoscope.dhasa.graha import tithi_ashtottari, tithi_yogini, yoga_vimsottari
    # Raasi dashas (17 + 8 already = 25 systems)
    from jhora.horoscope.dhasa.raasi import narayana, chara, sthira, kalachakra
    from jhora.horoscope.dhasa.raasi import shoola, sudasa, drig as drig_dhasa, trikona
    from jhora.horoscope.dhasa.raasi import brahma as brahma_d, chakra as chakra_d
    from jhora.horoscope.dhasa.raasi import niryaana, raashiyanka, varnada as varnada_d
    from jhora.horoscope.dhasa.raasi import yogardha, mandooka, paryaaya, sandhya
    from jhora.horoscope.dhasa.raasi import tara_lagna, lagnamsaka
    from jhora.horoscope.dhasa.raasi import navamsa as navamsa_d, padhanadhamsa
    from jhora.horoscope.dhasa.raasi import chathurvidha_utthara
    from jhora.horoscope.dhasa.raasi import lagna_kendraadhi, karaka_kendraadhi
    # Annual dashas
    from jhora.horoscope.dhasa.annual import mudda, patyayini
    # Transit & Sahams
    from jhora.horoscope.transit import saham as saham_mod, tajaka as tajaka_mod
    from jhora.horoscope.match.compatibility import Ashtakoota
    from jhora.panchanga import drik
    from jhora import utils, const
finally:
    sys.stdout = _real_stdout

# Match Jagannatha Hora defaults
drik.set_ayanamsa_mode('LAHIRI')
const.set_node_mode(False)  # Mean Node for Rahu/Ketu (JH default)

RASHI = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo',
         'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces']

PLANETS = {
    'L': 'Lagna', 0: 'Sun', 1: 'Moon', 2: 'Mars', 3: 'Mercury',
    4: 'Jupiter', 5: 'Venus', 6: 'Saturn', 7: 'Rahu', 8: 'Ketu'
}

NAKSHATRA = [
    'Ashwini','Bharani','Krittika','Rohini','Mrigashira','Ardra',
    'Punarvasu','Pushya','Ashlesha','Magha','Purva Phalguni','Uttara Phalguni',
    'Hasta','Chitra','Swati','Vishakha','Anuradha','Jyeshtha',
    'Mula','Purva Ashadha','Uttara Ashadha','Shravana','Dhanishta',
    'Shatabhisha','Purva Bhadrapada','Uttara Bhadrapada','Revati'
]

DASHA_LORDS = {0: 'Sun', 1: 'Moon', 2: 'Mars', 3: 'Rahu', 4: 'Jupiter',
               5: 'Saturn', 6: 'Mercury', 7: 'Ketu', 8: 'Venus'}


@dataclass
class PlanetPosition:
    body: str
    rashi: str
    rashi_idx: int
    degrees: float
    deg: int
    min: int
    sec: float
    nakshatra: Optional[str] = None
    pada: Optional[int] = None
    retro: bool = False

    @property
    def dms(self) -> str:
        return f"{self.deg}°{self.min:02d}'{self.sec:05.2f}\""

    def __str__(self):
        r = " (R)" if self.retro else ""
        n = f" [{self.nakshatra} P{self.pada}]" if self.nakshatra else ""
        return f"{self.body:10s} {self.rashi:13s} {self.dms}{r}{n}"


@dataclass
class DashaPeriod:
    lord: str
    start_date: str
    end_date: str
    years: float
    level: str = "maha"


@dataclass
class ChartData:
    """Complete chart computation result."""
    birth_date: str
    birth_time: str
    place_name: str
    latitude: float
    longitude: float
    timezone: float
    ayanamsa: str

    rasi: list[PlanetPosition] = field(default_factory=list)
    navamsa: list[PlanetPosition] = field(default_factory=list)
    dasamsa: list[PlanetPosition] = field(default_factory=list)
    divisional: dict = field(default_factory=dict)

    vimshottari: list[DashaPeriod] = field(default_factory=list)
    shadbala: dict = field(default_factory=dict)
    bhava_bala: list = field(default_factory=list)

    # Extended analyses
    ashtakavarga_bav: dict = field(default_factory=dict)
    ashtakavarga_sav: list = field(default_factory=list)
    yogas: list = field(default_factory=list)
    raja_yogas: list = field(default_factory=list)
    doshas: dict = field(default_factory=dict)
    arudha_padas: dict = field(default_factory=dict)
    sphutas: dict = field(default_factory=dict)
    special_lagnas: dict = field(default_factory=dict)
    chara_karakas: dict = field(default_factory=dict)
    sthira_karakas: dict = field(default_factory=dict)
    vimsopaka: dict = field(default_factory=dict)
    panchanga: dict = field(default_factory=dict)
    other_dashas: dict = field(default_factory=dict)
    sahams: dict = field(default_factory=dict)
    tajaka: dict = field(default_factory=dict)

    def to_json(self) -> str:
        d = asdict(self)
        return json.dumps({k: v for k, v in d.items() if v}, indent=2, default=str)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _deg_to_dms(deg: float) -> tuple[int, int, float]:
    d = int(deg)
    m = int((deg - d) * 60)
    s = round(((deg - d) * 60 - m) * 60, 2)
    return d, m, s


def _safe(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except Exception:
        return None


def _strip_html(text: str) -> str:
    return re.sub(r'<[^>]+>', '', text).strip()


def _fmt_pos(val) -> dict:
    """Format a (rashi_idx, deg) tuple into a readable dict."""
    if isinstance(val, (list, tuple)) and len(val) >= 2:
        ri = int(val[0]) % 12
        deg = float(val[1])
        d, m, s = _deg_to_dms(deg)
        return {'rashi': RASHI[ri], 'degrees': f"{d}°{m:02d}'{s:05.2f}\""}
    if isinstance(val, (int, float)):
        ri = int(val / 30) % 12
        deg = val % 30
        d, m, s = _deg_to_dms(deg)
        return {'rashi': RASHI[ri], 'degrees': f"{d}°{m:02d}'{s:05.2f}\""}
    return {'value': str(val)}


def _rasi_to_h_to_p_str(rasi_data: list) -> list[str]:
    """Convert rasi chart data to string format for ashtakavarga: ['4/6','','7',...]."""
    h_to_p = [''] * 12
    for entry in rasi_data:
        pid = entry[0]
        ri = entry[1][0]
        label = str(pid)
        if h_to_p[ri]:
            h_to_p[ri] += '/' + label
        else:
            h_to_p[ri] = label
    return h_to_p


def _planet_name(pid) -> str:
    if isinstance(pid, int):
        if pid < 12:
            return PLANETS.get(pid, RASHI[pid % 12])
        return str(pid)
    return PLANETS.get(pid, str(pid))


# ── Parsers ──────────────────────────────────────────────────────────────────

def _parse_positions(raw_data: list) -> list[PlanetPosition]:
    positions = []
    for entry in raw_data:
        body_id = entry[0]
        if body_id not in PLANETS:
            continue
        rashi_idx, deg = entry[1]
        d, m, s = _deg_to_dms(deg)
        name = PLANETS[body_id]
        abs_long = rashi_idx * 30 + deg
        nak_idx = int(abs_long / (360 / 27))
        pada = int((abs_long % (360 / 27)) / (360 / 108)) + 1
        nak_name = NAKSHATRA[nak_idx] if 0 <= nak_idx < 27 else None
        positions.append(PlanetPosition(
            body=name, rashi=RASHI[rashi_idx], rashi_idx=rashi_idx,
            degrees=round(deg, 4), deg=d, min=m, sec=s,
            nakshatra=nak_name, pada=pada if nak_name else None,
        ))
    return positions


def _parse_vimshottari(raw_dasha) -> list[DashaPeriod]:
    if not raw_dasha or not isinstance(raw_dasha, (list, tuple)) or len(raw_dasha) < 2:
        return []
    periods = []
    entries = raw_dasha[1] if len(raw_dasha) > 1 and isinstance(raw_dasha[1], list) else raw_dasha
    for entry in entries:
        if not isinstance(entry, (list, tuple)) or len(entry) < 3:
            continue
        lord_tuple, date_tuple, years = entry[0], entry[1], entry[2]
        if not isinstance(lord_tuple, (list, tuple)) or len(lord_tuple) < 2:
            continue
        l1, l2 = lord_tuple[0], lord_tuple[1]
        n1, n2 = DASHA_LORDS.get(l1, f'#{l1}'), DASHA_LORDS.get(l2, f'#{l2}')
        y, mo, d = int(date_tuple[0]), int(date_tuple[1]), int(date_tuple[2])
        start = f"{y}-{mo:02d}-{d:02d}"
        ey = y + int(years)
        emo = mo + int((years % 1) * 12)
        if emo > 12:
            ey += 1; emo -= 12
        end = f"{ey}-{emo:02d}-{d:02d}"
        level = "maha" if l1 == l2 else "antar"
        lord = n1 if l1 == l2 else f"{n1}/{n2}"
        periods.append(DashaPeriod(lord=lord, start_date=start, end_date=end,
                                   years=round(years, 3), level=level))
    return periods


def _parse_generic_dasha(raw) -> list[dict]:
    """Parse any dasha list: [(lord_pair, date_tuple, years), ...].
    Handles: plain lists, (flag, [entries...]) tuples, 3 or 4 element dates.
    """
    if not isinstance(raw, (list, tuple)):
        return []

    # Some modules return (flag, [entries...]) — unwrap
    entries = raw
    if (len(raw) == 2 and isinstance(raw[1], list)
            and not isinstance(raw[0], (list, tuple)) or
            (len(raw) == 2 and isinstance(raw[0], tuple)
             and isinstance(raw[1], list) and len(raw[0]) <= 4)):
        entries = raw[1]

    result = []
    for entry in entries:
        if not isinstance(entry, (list, tuple)) or len(entry) < 2:
            continue
        lord_raw = entry[0]
        date_raw = entry[1]
        years = entry[2] if len(entry) >= 3 else None

        # Parse lord
        if isinstance(lord_raw, (list, tuple)):
            parts = [_planet_name(l) for l in lord_raw]
            lord_str = parts[0] if len(parts) == 1 or (len(parts) == 2 and parts[0] == parts[1]) else '/'.join(parts)
            level = 'maha' if len(parts) >= 2 and parts[0] == parts[1] else 'antar'
        elif isinstance(lord_raw, (int, float)):
            lord_str = RASHI[int(lord_raw) % 12] if int(lord_raw) < 12 else _planet_name(int(lord_raw))
            level = 'maha'
        else:
            lord_str = str(lord_raw)
            level = 'maha'

        # Parse date — handle 3-element (y,m,d) and 4-element (y,m,d,hours)
        if isinstance(date_raw, (list, tuple)) and len(date_raw) >= 3:
            try:
                y, mo, d = int(date_raw[0]), int(date_raw[1]), int(float(date_raw[2]))
                d = max(1, min(d, 28))  # clamp day
                date_str = f"{y}-{mo:02d}-{d:02d}"
            except (ValueError, TypeError):
                date_str = str(date_raw)
        else:
            date_str = str(date_raw)

        d = {'lord': lord_str, 'start': date_str, 'level': level}
        if years is not None:
            d['years'] = round(float(years), 3) if isinstance(years, (int, float)) else str(years)
        result.append(d)
    return result


# ── Analysis Functions ───────────────────────────────────────────────────────

def _compute_yogas(jd, place, chart):
    try:
        raw = yoga_mod.get_yoga_details(jd, place, divisional_chart_factor=1, language='en')
        if isinstance(raw, tuple) and len(raw) >= 1:
            yoga_dict = raw[0]
            if isinstance(yoga_dict, dict):
                result = []
                for name, details in yoga_dict.items():
                    desc = _strip_html(str(details)) if isinstance(details, str) else str(details)
                    if isinstance(details, list):
                        for d in details:
                            if isinstance(d, str):
                                result.append({'yoga': name, 'details': _strip_html(d)})
                            else:
                                result.append({'yoga': name, 'details': str(d)})
                    else:
                        result.append({'yoga': name, 'details': desc[:300]})
                chart.yogas = result
                return
        if isinstance(raw, dict):
            chart.yogas = [{'yoga': k, 'details': _strip_html(str(v))[:300]} for k, v in raw.items()]
    except Exception as e:
        chart.yogas = [{'error': str(e)}]


def _compute_raja_yogas(jd, place, chart):
    try:
        raw = rj_mod.get_raja_yoga_details(jd, place, divisional_chart_factor=1, language='en')
        if isinstance(raw, tuple) and len(raw) >= 1:
            yoga_dict = raw[0] if isinstance(raw[0], dict) else raw
        elif isinstance(raw, dict):
            yoga_dict = raw
        else:
            chart.raja_yogas = [{'details': str(raw)[:300]}]
            return
        if isinstance(yoga_dict, dict):
            result = []
            for name, details in yoga_dict.items():
                if isinstance(details, list):
                    for d in details:
                        result.append({'yoga': name, 'details': _strip_html(str(d))[:300]})
                else:
                    result.append({'yoga': name, 'details': _strip_html(str(details))[:300]})
            chart.raja_yogas = result
    except Exception as e:
        chart.raja_yogas = [{'error': str(e)}]


def _compute_doshas(jd, place, chart):
    try:
        raw = dosha_mod.get_dosha_details(jd, place, language='en')
        if isinstance(raw, dict):
            chart.doshas = {k: _strip_html(str(v))[:500] for k, v in raw.items()}
        else:
            chart.doshas = {'result': _strip_html(str(raw))[:500]}
    except Exception as e:
        chart.doshas = {'error': str(e)}


def _compute_ashtakavarga(rasi_data, chart):
    try:
        h_to_p = _rasi_to_h_to_p_str(rasi_data)
        bav, sav, _ = av_mod.get_ashtaka_varga(h_to_p)
        planet_keys = ['Sun','Moon','Mars','Mercury','Jupiter','Venus','Saturn','Lagna']
        chart.ashtakavarga_sav = sav
        chart.ashtakavarga_bav = {
            planet_keys[i]: bav[i] for i in range(min(len(bav), len(planet_keys)))
        }
    except Exception as e:
        chart.ashtakavarga_sav = []
        chart.ashtakavarga_bav = {'error': str(e)}


def _compute_arudhas(rasi_data, chart):
    try:
        ba = arudha_mod.bhava_arudhas_from_planet_positions(rasi_data)
        if isinstance(ba, (list, tuple)):
            chart.arudha_padas = {
                f'A{i+1}': RASHI[int(v) % 12] for i, v in enumerate(ba) if isinstance(v, (int, float))
            }

        ga = _safe(arudha_mod.graha_arudhas_from_planet_positions, rasi_data)
        if ga and isinstance(ga, (list, tuple)):
            graha_ar = {}
            for i, v in enumerate(ga):
                name = PLANETS.get(i, f'P{i}')
                if isinstance(v, (int, float)):
                    graha_ar[name] = RASHI[int(v) % 12]
            if graha_ar:
                chart.arudha_padas['graha_arudhas'] = graha_ar
    except Exception as e:
        chart.arudha_padas = {'error': str(e)}


def _compute_sphutas(dob, tob, place, chart):
    dob_date = drik.Date(dob[0], dob[1], dob[2])
    sphuta_funcs = {
        'prana': sphuta_mod.prana_sphuta,
        'deha': sphuta_mod.deha_sphuta,
        'mrityu': sphuta_mod.mrityu_sphuta,
        'tri': sphuta_mod.tri_sphuta,
        'chatur': sphuta_mod.chatur_sphuta,
        'pancha': sphuta_mod.pancha_sphuta,
        'beeja': sphuta_mod.beeja_sphuta,
        'kshetra': sphuta_mod.kshetra_sphuta,
        'tithi': sphuta_mod.tithi_sphuta,
        'yoga': sphuta_mod.yoga_sphuta,
        'yogi': sphuta_mod.yogi_sphuta,
        'avayogi': sphuta_mod.avayogi_sphuta,
    }
    result = {}
    for name, fn in sphuta_funcs.items():
        val = _safe(fn, dob_date, tob, place)
        if val is not None:
            result[name] = _fmt_pos(val)
    chart.sphutas = result


def _compute_special_lagnas(jd, dob, tob, place, chart):
    result = {}

    # From drik module
    for name, fn in [('sree_lagna', drik.sree_lagna), ('indu_lagna', drik.indu_lagna),
                     ('bhrigu_bindhu', drik.bhrigu_bindhu_lagna),
                     ('kunda_lagna', drik.kunda_lagna), ('pranapada_lagna', drik.pranapada_lagna),
                     ('hora_lagna', drik.hora_lagna), ('ghati_lagna', drik.ghati_lagna),
                     ('bhava_lagna', drik.bhava_lagna), ('vighati_lagna', drik.vighati_lagna)]:
        val = _safe(fn, jd, place)
        if val is not None:
            result[name] = _fmt_pos(val)

    # Varnada Lagna from charts module
    val = _safe(charts.varnada_lagna, dob, tob, place)
    if val is not None:
        result['varnada_lagna'] = _fmt_pos(val)

    chart.special_lagnas = result


def _compute_karakas(rasi_data, chart):
    try:
        ck = house.chara_karakas(rasi_data)
        karaka_names = ['Atma Karaka','Amatya Karaka','Bhratru Karaka','Matru Karaka',
                       'Putra Karaka','Gnati Karaka','Dara Karaka','Pitru Karaka']
        if isinstance(ck, (list, tuple)):
            chart.chara_karakas = {
                karaka_names[i] if i < len(karaka_names) else f'Karaka_{i}': _planet_name(k)
                for i, k in enumerate(ck)
            }
    except Exception as e:
        chart.chara_karakas = {'error': str(e)}

    try:
        sk = house.sthira_karakas(rasi_data)
        if isinstance(sk, dict):
            chart.sthira_karakas = {str(k): _planet_name(v) for k, v in sk.items()}
        elif isinstance(sk, (list, tuple)):
            chart.sthira_karakas = {f'House_{i+1}': _planet_name(v) for i, v in enumerate(sk)}
    except Exception:
        pass


def _compute_vimsopaka(jd, place, chart):
    planet_keys = ['Sun','Moon','Mars','Mercury','Jupiter','Venus','Saturn','Rahu','Ketu']

    for name, fn in [('shadvarga', charts.vimsopaka_shadvarga_of_planets),
                     ('sapthavarga', charts.vimsopaka_sapthavarga_of_planets),
                     ('shodasavarga', charts.vimsopaka_shodhasavarga_of_planets)]:
        raw = _safe(fn, jd, place)
        if raw:
            vals = {}
            items = raw.items() if isinstance(raw, dict) else enumerate(raw)
            for i, v in items:
                pn = planet_keys[int(i)] if int(i) < len(planet_keys) else f'Planet_{i}'
                if isinstance(v, (list, tuple)) and len(v) >= 3:
                    vals[pn] = {'dignities': v[1], 'score': round(float(v[2]), 2)}
                elif isinstance(v, (int, float)):
                    vals[pn] = round(float(v), 2)
                else:
                    vals[pn] = str(v)
            chart.vimsopaka[name] = vals

    # Vaiseshikamsa
    raw = _safe(charts.vaiseshikamsa_shodhasavarga_of_planets, jd, place)
    if raw:
        vals = {}
        items = raw.items() if isinstance(raw, dict) else enumerate(raw)
        for i, v in items:
            pn = planet_keys[int(i)] if int(i) < len(planet_keys) else f'Planet_{i}'
            vals[pn] = str(v) if not isinstance(v, (int, float)) else round(float(v), 2)
        chart.vimsopaka['vaiseshikamsa'] = vals


def _compute_panchanga(jd, place, chart):
    result = {}

    # Tithi
    t = _safe(drik.tithi, jd, place)
    if t is not None:
        tithi_names = [
            'Pratipada','Dwitiya','Tritiya','Chaturthi','Panchami',
            'Shashthi','Saptami','Ashtami','Navami','Dashami',
            'Ekadashi','Dwadashi','Trayodashi','Chaturdashi','Purnima/Amavasya'
        ]
        if isinstance(t, (list, tuple)) and len(t) >= 2:
            idx = int(t[0])
            result['tithi'] = {
                'index': idx,
                'name': tithi_names[idx % 15],
                'paksha': 'Shukla' if idx < 15 else 'Krishna',
            }
        else:
            result['tithi'] = str(t)

    # Nakshatra
    n = _safe(drik.nakshatra, jd, place)
    if n is not None and isinstance(n, (list, tuple)) and len(n) >= 2:
        idx = int(n[0])
        result['nakshatra'] = {
            'index': idx,
            'name': NAKSHATRA[idx % 27],
            'pada': int(n[1]) if len(n) > 1 else None,
        }

    # Yoga
    y = _safe(drik.yogam, jd, place)
    if y is not None:
        yoga_names = [
            'Vishkambha','Priti','Ayushman','Saubhagya','Shobhana',
            'Atiganda','Sukarma','Dhriti','Shula','Ganda',
            'Vriddhi','Dhruva','Vyaghata','Harshana','Vajra',
            'Siddhi','Vyatipata','Variyan','Parigha','Shiva',
            'Siddha','Sadhya','Shubha','Shukla','Brahma',
            'Indra','Vaidhriti'
        ]
        if isinstance(y, (list, tuple)) and len(y) >= 1:
            idx = int(y[0])
            result['yoga'] = {'index': idx, 'name': yoga_names[idx % 27]}

    # Karana
    k = _safe(drik.karana, jd, place)
    if k is not None:
        result['karana'] = str(k)

    # Vaara
    v = _safe(drik.vaara, jd, place)
    if v is not None:
        vaara_names = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
        if isinstance(v, (int, float)):
            result['vaara'] = vaara_names[int(v) % 7]
        else:
            result['vaara'] = str(v)

    # Sunrise/Sunset
    sr = _safe(drik.sunrise, jd, place)
    if sr is not None:
        result['sunrise'] = str(sr)
    ss = _safe(drik.sunset, jd, place)
    if ss is not None:
        result['sunset'] = str(ss)

    chart.panchanga = result


def _compute_other_dashas(jd, dob, tob, place, chart):
    results = {}

    # ── Graha Dashas (24 systems) ──────────────────────────────────────────
    graha_dashas = [
        ('ashtottari', lambda: ashtottari.get_ashtottari_dhasa_bhukthi(jd, place)),
        ('yogini', lambda: yogini.get_dhasa_bhukthi(dob, tob, place)),
        ('moola', lambda: moola_d.get_dhasa_antardhasa(dob, tob, place)),
        ('naisargika', lambda: naisargika_d.get_dhasa_bhukthi(dob, tob, place)),
        ('buddhi_gathi', lambda: buddhi_gathi.get_dhasa_bhukthi(dob, tob, place)),
        ('dwadasottari', lambda: dwadasottari.get_dhasa_bhukthi(dob, tob, place)),
        ('chathuraaseethi_sama', lambda: chathuraaseethi_sama.get_dhasa_bhukthi(dob, tob, place)),
        ('karana_chathuraaseethi', lambda: karana_chathuraaseethi_sama.get_dhasa_bhukthi(dob, tob, place)),
        ('panchottari', lambda: panchottari.get_dhasa_bhukthi(dob, tob, place)),
        ('shodasottari', lambda: shodasottari.get_dhasa_bhukthi(dob, tob, place)),
        ('sataatbika', lambda: sataatbika.get_dhasa_bhukthi(dob, tob, place)),
        ('dwisatpathi', lambda: dwisatpathi.get_dhasa_bhukthi(dob, tob, place)),
        ('kaala', lambda: kaala_d.get_dhasa_antardhasa(dob, tob, place)),
        ('karaka', lambda: karaka_d.get_dhasa_antardhasa(dob, tob, place)),
        ('rashmi', lambda: rashmi_d.get_rashmi_dhasa_bhukthi(dob, tob, place)),
        ('tara', lambda: tara_d.get_dhasa_bhukthi(dob, tob, place)),
        ('saptharishi_nakshathra', lambda: saptharishi_nakshathra.get_dhasa_bhukthi(dob, tob, place)),
        ('shastihayani', lambda: shastihayani.get_dhasa_bhukthi(dob, tob, place)),
        ('shattrimsa_sama', lambda: shattrimsa_sama.get_dhasa_bhukthi(dob, tob, place)),
        ('tithi_ashtottari', lambda: tithi_ashtottari.get_dhasa_bhukthi(jd, place)),
        ('tithi_yogini', lambda: tithi_yogini.get_dhasa_bhukthi(dob, tob, place)),
        ('yoga_vimsottari', lambda: yoga_vimsottari.get_dhasa_bhukthi(jd, place)),
    ]
    for name, fn in graha_dashas:
        raw = _safe(fn)
        if raw:
            parsed = _parse_generic_dasha(raw)
            if parsed:
                results[name] = parsed

    # ── Raasi Dashas (25 systems) ──────────────────────────────────────────
    raasi_dashas = [
        ('narayana', lambda: narayana.narayana_dhasa_for_rasi_chart(dob, tob, place)),
        ('chara', lambda: chara.get_dhasa_antardhasa(dob, tob, place)),
        ('sthira', lambda: sthira.get_dhasa_antardhasa(dob, tob, place)),
        ('kalachakra', lambda: kalachakra.get_dhasa_bhukthi(dob, tob, place)),
        ('shoola', lambda: shoola.get_dhasa_bhukthi(dob, tob, place)),
        ('sudasa', lambda: sudasa.get_dhasa_bhukthi(dob, tob, place)),
        ('drig', lambda: drig_dhasa.drig_dhasa_bhukthi(dob, tob, place)),
        ('trikona', lambda: trikona.get_dhasa_antardhasa(dob, tob, place)),
        ('brahma', lambda: brahma_d.get_dhasa_antardhasa(dob, tob, place)),
        ('chakra', lambda: chakra_d.get_dhasa_antardhasa(dob, tob, place)),
        ('niryaana', lambda: niryaana.get_dhasa_bhukthi(dob, tob, place)),
        ('raashiyanka', lambda: raashiyanka.get_dhasa_bhukthi(dob, tob, place)),
        ('varnada', lambda: varnada_d.get_dhasa_antardhasa(dob, tob, place)),
        ('yogardha', lambda: yogardha.get_dhasa_antardhasa(dob, tob, place)),
        ('mandooka', lambda: mandooka.get_dhasa_antardhasa(dob, tob, place)),
        ('paryaaya', lambda: paryaaya.get_dhasa_antardhasa(dob, tob, place)),
        ('sandhya', lambda: sandhya.get_dhasa_antardhasa(dob, tob, place)),
        ('tara_lagna', lambda: tara_lagna.get_dhasa_antardhasa(dob, tob, place)),
        ('lagnamsaka', lambda: lagnamsaka.get_dhasa_antardhasa(dob, tob, place)),
        ('navamsa_dasha', lambda: navamsa_d.get_dhasa_antardhasa(dob, tob, place)),
        ('padhanadhamsa', lambda: padhanadhamsa.get_dhasa_antardhasa(dob, tob, place)),
        ('chathurvidha_utthara', lambda: chathurvidha_utthara.get_dhasa_antardhasa(dob, tob, place)),
        ('lagna_kendraadhi', lambda: lagna_kendraadhi.get_lagna_kendradhi_rasi_bhukthi(dob, tob, place)),
        ('karaka_kendraadhi', lambda: karaka_kendraadhi.get_karaka_kendradhi_rasi_bhukthi(dob, tob, place)),
    ]
    for name, fn in raasi_dashas:
        raw = _safe(fn)
        if raw:
            parsed = _parse_generic_dasha(raw)
            if parsed:
                results[name] = parsed

    # ── Annual Dashas (2 systems) ──────────────────────────────────────────
    import datetime
    current_age = max(1, datetime.date.today().year - dob[0])
    annual_dashas = [
        ('mudda', lambda: mudda.mudda_dhasa_bhukthi(jd, place, current_age)),
        ('varsha_vimsottari', lambda: mudda.varsha_vimsottari_dhasa_bhukthi(jd, place, years=current_age)),
        ('patyayini', lambda: patyayini.get_dhasa_bhukthi(jd, place)),
    ]
    for name, fn in annual_dashas:
        raw = _safe(fn)
        if raw:
            parsed = _parse_generic_dasha(raw)
            if parsed:
                results[name] = parsed

    chart.other_dashas = results


def _compute_sahams(rasi_data, jd, place, chart):
    """Compute all 36 Sahams (Arabic Parts / Lots)."""
    # Determine night birth from sunrise
    sr = _safe(drik.sunrise, jd, place)
    night = False
    if sr is not None and isinstance(sr, (int, float)):
        night = (jd % 1) < (sr % 1)  # rough check

    result = {}
    saham_fns = [
        'punya_saham', 'vidya_saham', 'yasas_saham', 'vivaha_saham',
        'rajya_saham', 'karma_saham', 'roga_saham', 'mrithyu_saham',
        'puthra_saham', 'bhratri_saham', 'maathri_saham', 'pithri_saham',
        'artha_saham', 'asha_saham', 'gaurava_saham', 'mitra_saham',
        'sathru_saham', 'paradesa_saham', 'paradara_saham', 'preethi_saham',
        'jeeva_saham', 'kali_saham', 'bandhu_saham', 'laabha_saham',
        'mahatmaya_saham', 'samartha_saham', 'santapa_saham', 'sastra_saham',
        'sraddha_saham', 'vanika_saham', 'vyaapaara_saham', 'karyasiddhi_saham',
        'bandhana_saham', 'apamrithyu_saham', 'jadya_saham', 'jalapatna_saham',
    ]
    for sname in saham_fns:
        fn = getattr(saham_mod, sname, None)
        if fn:
            try:
                # Some sahams don't take night_time_birth param
                import inspect
                params = inspect.signature(fn).parameters
                if 'night_time_birth' in params:
                    val = fn(rasi_data, night_time_birth=night)
                else:
                    val = fn(rasi_data)
                if val is not None and isinstance(val, (int, float)):
                    result[sname.replace('_saham', '')] = _fmt_pos(val)
            except Exception:
                pass
    chart.sahams = result


def _compute_tajaka(jd, dob, tob, place, chart):
    """Compute Tajaka (annual chart) for current year."""
    result = {}
    try:
        import datetime
        now = datetime.date.today()
        years_from_dob = now.year - dob[0]
        if years_from_dob < 1:
            years_from_dob = 1

        # Annual chart positions
        annual_raw = _safe(tajaka_mod.annual_chart, jd, place, 1, years_from_dob)
        if annual_raw and isinstance(annual_raw, (list, tuple)):
            # annual_chart returns (chart_list, ...) — unwrap
            annual = annual_raw[0] if isinstance(annual_raw[0], list) else annual_raw
            result['annual_chart'] = [
                {'planet': _planet_name(e[0]), 'rashi': RASHI[int(e[1][0]) % 12],
                 'degrees': round(float(e[1][1]), 4)}
                for e in annual if isinstance(e, (list, tuple)) and len(e) >= 2
                and isinstance(e[1], (list, tuple)) and len(e[1]) >= 2
            ]

        # Year lord
        yl = _safe(tajaka_mod.lord_of_the_year, jd, place, years_from_dob)
        if yl is not None:
            result['year_lord'] = _planet_name(int(yl))
            result['years_from_birth'] = years_from_dob

    except Exception:
        pass
    chart.tajaka = result


# ── Main Compute Function ────────────────────────────────────────────────────

def compute_chart(
    year: int, month: int, day: int,
    hour: int, minute: int, second: int = 0,
    place_name: str = "",
    latitude: float = 0.0,
    longitude: float = 0.0,
    timezone_offset: float = 0.0,
    ayanamsa: str = "LAHIRI",
    divisional_charts: list[int] | None = None,
    true_nodes: bool = False,
    analyses: list[str] | None = None,
) -> ChartData:
    """
    Compute a Jyotish chart with optional extended analyses.

    Args:
        analyses: Optional list. Options: 'yogas', 'raja_yogas', 'doshas',
            'ashtakavarga', 'arudhas', 'sphutas', 'special_lagnas', 'karakas',
            'vimsopaka', 'panchanga', 'all_dashas' (55 systems), 'sahams' (36),
            'tajaka' (annual chart), 'all' (everything).
    """
    drik.set_ayanamsa_mode(ayanamsa)
    const._use_true_nodes_for_rahu_ketu = true_nodes

    dob = (year, month, day)
    tob = (hour, minute, second)
    place = drik.Place(place_name, latitude, longitude, timezone_offset)
    jd = utils.julian_day_number(dob, tob)

    chart = ChartData(
        birth_date=f"{year}-{month:02d}-{day:02d}",
        birth_time=f"{hour:02d}:{minute:02d}:{second:02d}",
        place_name=place_name, latitude=latitude, longitude=longitude,
        timezone=timezone_offset, ayanamsa=ayanamsa,
    )

    # D-1 Rasi (always)
    rasi_data = charts.rasi_chart(jd, place)
    chart.rasi = _parse_positions(rasi_data)

    # Divisional charts
    for dcf in (divisional_charts or [9, 10]):
        try:
            pos = _parse_positions(charts.divisional_chart(jd, place, divisional_chart_factor=dcf))
            chart.divisional[f"D-{dcf}"] = [asdict(p) for p in pos]
            if dcf == 9: chart.navamsa = pos
            elif dcf == 10: chart.dasamsa = pos
        except Exception:
            pass

    # Vimshottari (always — primary timing)
    try:
        chart.vimshottari = _parse_vimshottari(vimsottari.get_vimsottari_dhasa_bhukthi(jd, place))
    except Exception:
        pass

    # Shadbala (always)
    try:
        sb = strength.shad_bala(jd, place)
        pnames = ['Sun','Moon','Mars','Mercury','Jupiter','Venus','Saturn']
        comps = ['Sthana','Dig','Kaala','Cheshta','Naisargika','Drik','Total']
        for i, pn in enumerate(pnames):
            if i < len(sb):
                vals = sb[i] if isinstance(sb[i], (list, tuple)) else [sb[i]]
                chart.shadbala[pn] = {comps[j]: round(v, 2) for j, v in enumerate(vals) if j < len(comps)}
    except Exception:
        pass

    # Bhava Bala (always)
    try:
        bb = strength.bhava_bala(jd, place)
        if isinstance(bb, (list, tuple)) and len(bb) > 0:
            first = bb[0]
            if isinstance(first, (list, tuple)):
                chart.bhava_bala = [round(v, 2) for v in first[:12]]
            else:
                chart.bhava_bala = [round(v, 2) for v in bb[:12]]
    except Exception:
        pass

    # Extended analyses
    req = set(analyses or [])
    do_all = 'all' in req

    if do_all or 'yogas' in req:
        _compute_yogas(jd, place, chart)
    if do_all or 'raja_yogas' in req:
        _compute_raja_yogas(jd, place, chart)
    if do_all or 'doshas' in req:
        _compute_doshas(jd, place, chart)
    if do_all or 'ashtakavarga' in req:
        _compute_ashtakavarga(rasi_data, chart)
    if do_all or 'arudhas' in req:
        _compute_arudhas(rasi_data, chart)
    if do_all or 'sphutas' in req:
        _compute_sphutas(dob, tob, place, chart)
    if do_all or 'special_lagnas' in req:
        _compute_special_lagnas(jd, dob, tob, place, chart)
    if do_all or 'karakas' in req:
        _compute_karakas(rasi_data, chart)
    if do_all or 'vimsopaka' in req:
        _compute_vimsopaka(jd, place, chart)
    if do_all or 'panchanga' in req:
        _compute_panchanga(jd, place, chart)
    if do_all or 'all_dashas' in req:
        _compute_other_dashas(jd, dob, tob, place, chart)
    if do_all or 'sahams' in req:
        _compute_sahams(rasi_data, jd, place, chart)
    if do_all or 'tajaka' in req:
        _compute_tajaka(jd, dob, tob, place, chart)

    return chart


def print_chart(chart: ChartData):
    print(f"\n{'='*60}")
    print(f"  {chart.place_name} | {chart.birth_date} {chart.birth_time}")
    print(f"  Lat: {chart.latitude} Lon: {chart.longitude} TZ: {chart.timezone}")
    print(f"  Ayanamsa: {chart.ayanamsa}")
    print(f"{'='*60}")

    print(f"\n  RASI (D-1)")
    for p in chart.rasi:
        print(f"  {p}")

    if chart.navamsa:
        print(f"\n  NAVAMSA (D-9)")
        for p in chart.navamsa:
            print(f"  {p}")

    if chart.vimshottari:
        print(f"\n  VIMSHOTTARI DASHA")
        for d in chart.vimshottari:
            if d.level == "maha":
                print(f"  {d.lord:10s}  {d.start_date} -> {d.end_date}  ({d.years} yrs)")

    if chart.shadbala:
        print(f"\n  SHADBALA")
        for planet, vals in chart.shadbala.items():
            total = vals.get('Total', 0)
            print(f"  {planet:10s} Total: {total}")

    if chart.ashtakavarga_sav:
        print(f"\n  SARVASHTAKAVARGA (SAV)")
        print(f"  {chart.ashtakavarga_sav}")

    if chart.yogas:
        print(f"\n  YOGAS ({len(chart.yogas)} found)")
        for y in chart.yogas[:10]:
            print(f"  {y.get('yoga', '?')}: {y.get('details', '')[:80]}")

    if chart.raja_yogas:
        print(f"\n  RAJA YOGAS ({len(chart.raja_yogas)} found)")
        for y in chart.raja_yogas[:10]:
            print(f"  {y.get('yoga', '?')}: {y.get('details', '')[:80]}")

    if chart.doshas:
        print(f"\n  DOSHAS")
        for k, v in chart.doshas.items():
            print(f"  {k}: {str(v)[:100]}")

    if chart.arudha_padas:
        print(f"\n  ARUDHA PADAS")
        for k, v in chart.arudha_padas.items():
            if k != 'graha_arudhas':
                print(f"  {k}: {v}")

    if chart.sphutas:
        print(f"\n  SPHUTAS ({len(chart.sphutas)} computed)")
        for k, v in chart.sphutas.items():
            print(f"  {k}: {v}")

    if chart.special_lagnas:
        print(f"\n  SPECIAL LAGNAS ({len(chart.special_lagnas)} computed)")
        for k, v in chart.special_lagnas.items():
            print(f"  {k}: {v}")

    if chart.chara_karakas:
        print(f"\n  CHARA KARAKAS")
        for k, v in chart.chara_karakas.items():
            print(f"  {k}: {v}")

    if chart.panchanga:
        print(f"\n  PANCHANGA")
        for k, v in chart.panchanga.items():
            print(f"  {k}: {v}")

    if chart.other_dashas:
        print(f"\n  OTHER DASHA SYSTEMS ({len(chart.other_dashas)})")
        for system, periods in chart.other_dashas.items():
            count = len(periods) if isinstance(periods, list) else 0
            print(f"  {system}: {count} periods")

    if chart.vimsopaka:
        print(f"\n  VIMSOPAKA")
        for name, vals in chart.vimsopaka.items():
            print(f"  {name}: {vals}")

    if chart.sahams:
        print(f"\n  SAHAMS ({len(chart.sahams)} computed)")
        for k, v in list(chart.sahams.items())[:10]:
            print(f"  {k}: {v}")

    if chart.tajaka:
        print(f"\n  TAJAKA (Annual Chart)")
        for k, v in chart.tajaka.items():
            if k == 'annual_chart':
                print(f"  annual_chart: {len(v)} planets")
            else:
                print(f"  {k}: {v}")


def compute_compatibility(
    boy_year: int, boy_month: int, boy_day: int,
    boy_hour: int, boy_minute: int, boy_second: int = 0,
    boy_place_name: str = "", boy_latitude: float = 0.0,
    boy_longitude: float = 0.0, boy_timezone: float = 0.0,
    girl_year: int = 0, girl_month: int = 0, girl_day: int = 0,
    girl_hour: int = 0, girl_minute: int = 0, girl_second: int = 0,
    girl_place_name: str = "", girl_latitude: float = 0.0,
    girl_longitude: float = 0.0, girl_timezone: float = 0.0,
    method: str = "North",
) -> dict:
    """
    Compute marriage compatibility (Ashtakoota / Koota Milan) between two charts.
    Returns detailed Porutham/Koota scores (max 36 for North Indian method).
    """
    def _get_nak_pada(year, month, day, hour, minute, second, lat, lon, tz):
        dob = (year, month, day)
        tob = (hour, minute, second)
        place = drik.Place("", lat, lon, tz)
        jd = utils.julian_day_number(dob, tob)
        rasi_data = charts.rasi_chart(jd, place)
        # Moon is planet 1
        for entry in rasi_data:
            if entry[0] == 1:  # Moon
                ri, deg = entry[1]
                abs_long = ri * 30 + deg
                nak_idx = int(abs_long / (360 / 27))
                pada = int((abs_long % (360 / 27)) / (360 / 108)) + 1
                return nak_idx + 1, pada  # 1-based nakshatra number
        return 1, 1

    boy_nak, boy_pad = _get_nak_pada(
        boy_year, boy_month, boy_day, boy_hour, boy_minute, boy_second,
        boy_latitude, boy_longitude, boy_timezone)
    girl_nak, girl_pad = _get_nak_pada(
        girl_year, girl_month, girl_day, girl_hour, girl_minute, girl_second,
        girl_latitude, girl_longitude, girl_timezone)

    ak = Ashtakoota(boy_nak, boy_pad, girl_nak, girl_pad, method=method)

    # Gather all porutham scores
    kootas = {}
    for name in ['varna', 'vasiya', 'tara', 'yoni', 'maitri',
                 'gana', 'bahut', 'naadi', 'nakshathra', 'raasi',
                 'raasi_adhipathi', 'rajju', 'vedha', 'dina',
                 'sthree_dheerga', 'mahendra']:
        fn = getattr(ak, f'{name}_porutham', None)
        if fn:
            try:
                val = fn()
                if isinstance(val, (list, tuple)):
                    kootas[name] = {'score': val[0] if len(val) > 0 else 0,
                                    'max': val[1] if len(val) > 1 else None,
                                    'details': str(val[2]) if len(val) > 2 else None}
                elif isinstance(val, (int, float)):
                    kootas[name] = {'score': val}
                elif isinstance(val, bool):
                    kootas[name] = {'match': val}
                else:
                    kootas[name] = {'result': str(val)}
            except Exception as e:
                kootas[name] = {'error': str(e)}

    total_raw = _safe(ak.compatibility_score)
    # compatibility_score returns list: [varna, vasiya, gana, tara, yoni, maitri, bahut, naadi, total, rajju, vedha, sthree, mahendra]
    total = 0
    if isinstance(total_raw, (list, tuple)):
        # Total is at index 8 (9th element)
        for v in total_raw:
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                total = v  # Last numeric value is the total
    elif isinstance(total_raw, (int, float)):
        total = total_raw

    return {
        'boy': {
            'nakshatra': NAKSHATRA[(boy_nak - 1) % 27],
            'nakshatra_number': boy_nak,
            'pada': boy_pad,
        },
        'girl': {
            'nakshatra': NAKSHATRA[(girl_nak - 1) % 27],
            'nakshatra_number': girl_nak,
            'pada': girl_pad,
        },
        'method': method,
        'total_score': round(float(total), 1),
        'max_score': 36,
        'kootas': kootas,
    }


def serve_ipc():
    request = json.loads(sys.stdin.read())
    req_type = request.pop('type', 'chart')
    if req_type == 'compatibility':
        result = compute_compatibility(**request)
        print(json.dumps(result, indent=2, default=str))
    elif req_type == 'interpret':
        # Run chart computation + 7-stage interpretation pipeline
        from interpret import interpret_chart
        chart = compute_chart(**request)
        chart_dict = {k: v for k, v in asdict(chart).items() if v}
        result = interpret_chart(chart_dict)
        print(json.dumps(result, indent=2, default=str))
    else:
        chart = compute_chart(**request)
        print(chart.to_json())


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--ipc":
        serve_ipc()
    elif len(sys.argv) > 1 and sys.argv[1] == "--test-compat":
        # Test compatibility between two sample charts
        result = compute_compatibility(
            boy_year=1990, boy_month=3, boy_day=15,
            boy_hour=10, boy_minute=30,
            boy_latitude=28.6139, boy_longitude=77.2090, boy_timezone=5.5,
            girl_year=1992, girl_month=7, girl_day=22,
            girl_hour=14, girl_minute=15,
            girl_latitude=28.6139, girl_longitude=77.2090, girl_timezone=5.5,
        )
        print(json.dumps(result, indent=2, default=str))
    else:
        chart = compute_chart(
            2000, 1, 1, 12, 0, 0,
            place_name="Delhi",
            latitude=28.6139, longitude=77.2090, timezone_offset=5.5,
            analyses=['all'],
        )
        print_chart(chart)
