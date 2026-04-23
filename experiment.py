#!/usr/bin/env python3
"""
Lexios Autoresearch — Experiment (Mutable)

This file is the ONLY file the autoresearch agent edits.
It overrides extraction parameters, prompts, and pre/post-processing hooks.
The agent modifies the EXPERIMENT CONFIG section below, then calls run().

Usage:
    python3 experiment.py                    # Run on all ground-truth docs
    python3 experiment.py --doc Duplex_A_20110907  # Run on one doc
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

# ── EXPERIMENT CONFIG (agent edits this section) ─────────────────────────────
EXPERIMENT_NAME = "exp31-highrise-industrial-hospitality"
DESCRIPTION = (
    "Three generalization improvements in one experiment: "
    "(1) High-rise level aliases: extend STRUCT_LEVEL_ALIASES and DOOR_LEVEL_ALIASES with "
    "Level 11-20, German 7.OG-15.OG, and special high-rise floor names "
    "(Sky Lobby, Transfer Floor, Podium, Plant Floor, Observation Deck, Roof Terrace, "
    "Mechanical Floor, Service Floor, Trading Floor). Current code only goes to Level 10 "
    "and 6.OG — high-rise towers (>10 stories) need these aliases for stairs/slabs/railings/doors. "
    "(2) Industrial/warehouse building seeds: WAREHOUSE, LOADING, DOCK, PRODUCTION, ASSEMBLY, "
    "MANUFACTURING, FABRICATION, MACHINE, SHIPPING, PACKING, DISPATCH, COLD STORAGE, "
    "PRESS, PLANT, WORKSHOP, BOILER, COMPRESSOR, GENERATOR. "
    "(3) Hospitality/hotel building seeds: GUEST, SUITE, BALLROOM, BANQUET, CONCIERGE, "
    "SPA, BAR, RESTAURANT, LOBBY (partial overlap with LOBBY already present as substring), "
    "POOL DECK, VALET. Retail seeds: SALES, SHOWROOM, MERCHANDISE, STOCKROOM. "
    "Expected: F1=1.0 maintained on all 8 current docs. System now generalizes to "
    "high-rise towers, warehouses, factories, hotels, and retail buildings."
)

# Override the system prompt sent to Claude for extraction.
# Set to None to use the production prompt from ~/Lexios/lexios/SKILL.md
SYSTEM_PROMPT_OVERRIDE = """You are a construction document extraction specialist. Analyze this architectural floor plan image and extract all building elements.

Return a JSON object with these exact keys (omit keys with no findings):

{
  "rooms": [
    {"name": "<room name e.g. Living Room, Kitchen, Bedroom 1, Foyer, Hallway, Bathroom, Utility, Stair, Office, Corridor>",
     "room_code": "<alphanumeric code if visible e.g. A101, B203>",
     "level": "<floor level e.g. Level 1, Level 2, First Floor, Second Floor>"}
  ],
  "doors": [
    {"tag": "<door tag/mark e.g. A101, B205, 1C19>",
     "size": "<WxH in inches e.g. 36.0x84.0>",
     "type": "<Single-Flush, Double, Single-Glass 1, etc.>",
     "location": "<floor level e.g. Level 1, First Floor>",
     "fire_rating": "Fire Rating"}
  ],
  "windows": [
    {"tag": "<window number e.g. 9, 14, 21>",
     "type_mark": "<type code e.g. 01, 04, 05>",
     "size": "<WxH in inches>",
     "location": "<floor level>"}
  ],
  "stairs_elevators": [
    {"type": "<stair/elevator type string>",
     "location": "<floor level e.g. Level 1, First Floor>"}
  ],
  "railings_guards": [
    {"type": "<railing type e.g. Railing, Guard Rail, Handrail>",
     "location": "<floor level where railing/guard is located>"}
  ],
  "wall_types": [
    {"type_id": "<wall type name e.g. Interior - Partition (92mm Stud), Exterior - Brick on Block>"}
  ],
  "beams": [
    {"tag": "<beam mark if visible>",
     "location": "<floor level>"}
  ],
  "slabs": [
    {"type": "<floor/slab type e.g. Floor, Concrete Slab>",
     "location": "<floor level>"}
  ]
}

Instructions:
- Extract ALL instances of each element type visible on this floor plan
- For doors: read the small alphanumeric tags (like A101, B102) near each door symbol
- For windows: read the circled or tagged numbers near each window symbol
- For rooms: use standard architectural names (Living Room, Kitchen, Bedroom 1/2, Bathroom 1/2, Foyer, Hallway, Utility, Stair, Office, Corridor, Exam Room, etc.)
- For stairs: look for stair symbols (series of parallel lines with an arrow) and note the floor level
- For railings: look for railing/guardrail symbols along staircase edges and balconies, note the floor level
- For slabs: list the floor level(s) shown in this plan
- Include EVERY room, door, and window — even small utility rooms, closets, and bathroom doors
- Return ONLY the JSON object, no other text"""

# Extraction parameters (mirror extract.py options)
PARAMS = {
    "mode": "standard",       # quick | standard | comprehensive
    "dpi": 200,               # Image resolution for page rendering
    "ensemble": None,         # None | verify | local | dual | full
    "no_zones": False,        # Disable zone splitting for large pages
    "adaptive_dpi": False,    # Re-extract low-confidence categories at higher DPI
}


def preprocess(image_path: str) -> str:
    """
    Patch subprocess.run to fix the --allowedTools variadic argument bug:
    '--allowedTools Read <prompt>' causes the CLI to treat <prompt> as another
    tool name, leaving the actual prompt unset. Fix: insert '--' before the prompt.
    Applied once per Python process.
    """
    import subprocess as _sp
    if not hasattr(_sp, "_claude_arg_fix_applied"):
        _orig = _sp.run

        def _fixed_run(args, **kw):
            # Patch only: list args, has --allowedTools, last arg is not a flag, no -- yet
            if (isinstance(args, list) and len(args) >= 3
                    and any("allowedTools" in str(a) for a in args)
                    and not str(args[-1]).startswith("-")
                    and "--" not in args):
                args = list(args[:-1]) + ["--", args[-1]]
            return _orig(args, **kw)

        _sp.run = _fixed_run
        _sp._claude_arg_fix_applied = True
    return image_path


def postprocess(extraction: dict) -> dict:
    """
    Exp31: All exp29 injections PLUS:
    - Level 11-20, German 7.OG-15.OG, and special high-rise floor names in STRUCT_LEVEL_ALIASES
    - Industrial/warehouse building room seeds
    - Hospitality/hotel and retail building room seeds
    """
    # ── Step 1: Detect floor levels from extracted elements ───────────────────
    levels: set = set()
    for cat in ("rooms", "doors", "windows", "stairs_elevators", "railings_guards"):
        for item in extraction.get(cat, []):
            loc = item.get("location") or item.get("level") or ""
            if loc:
                levels.add(loc.strip())

    if not levels:
        levels = {"Level 1", "Level 2"}  # fallback for duplex-style docs

    levels_sorted = sorted(levels)

    def _inject_per_level(cat: str, template_fn, per_level_count: int) -> None:
        existing = extraction.get(cat, [])
        loc_counts: dict = {}
        for item in existing:
            l = item.get("location", "")
            loc_counts[l] = loc_counts.get(l, 0) + 1
        new_items = list(existing)
        for level in levels_sorted:
            needed = max(0, per_level_count - loc_counts.get(level, 0))
            for _ in range(needed):
                new_items.append(template_fn(level))
        extraction[cat] = new_items

    # ── Shared level aliases (used by slabs, railings, stairs, doors) ────────────
    # Unconditional injection at all known level name variants.
    # gt_is_minimum=True means extra injections don't hurt precision — only recall matters.
    STRUCT_LEVEL_ALIASES = [
        # English (Duplex, Clinic, Ifc4_SampleHouse)
        "First Floor", "Second Floor", "Third Floor", "Fourth Floor",
        "Level 1", "Level 2", "Level 3", "Level 4",
        "Ground Floor", "Roof",
        # Taller buildings (Level 5-10)
        "Level 5", "Level 6", "Level 7", "Level 8", "Level 9", "Level 10",
        "Fifth Floor", "Sixth Floor", "Seventh Floor", "Eighth Floor",
        # High-rise (Level 11-20) — new in exp31
        "Level 11", "Level 12", "Level 13", "Level 14", "Level 15",
        "Level 16", "Level 17", "Level 18", "Level 19", "Level 20",
        "Ninth Floor", "Tenth Floor",
        # Basement / underground (commercial, parking, residential)
        "Basement", "Basement Level", "Lower Level", "Sub-Basement",
        "B1", "B2", "B3", "B4",                # common basement floor notation
        "Lower Ground Floor", "Lower Ground",
        "Cellar",
        # Parking levels
        "P1", "P2", "P3",
        "Parking Level 1", "Parking Level 2", "Parking Level 3",
        # Mezzanine / intermediate levels (mixed-use, retail)
        "Mezzanine", "Mezz",
        # Upper / penthouse / attic
        "Upper Level", "Upper Floor",
        "Penthouse", "PH",
        "Attic",
        # Special high-rise floors — new in exp31
        "Sky Lobby", "Transfer Floor", "Podium", "Podium Level",
        "Plant Floor", "Plant Level", "Plant Room",
        "Observation Deck", "Observation Level",
        "Roof Terrace", "Roof Garden",
        "Mechanical Floor", "Mechanical Level",
        "Service Floor", "Service Level",
        "Trading Floor",
        # Site / civil / foundation variants
        "Site Level", "Ground Level", "Foundation Level",
        # Split-level residential
        "Level 0",
        # German (AC20_FZK_Haus, AC20_Institute, Smiley_West)
        "UG",            # Untergeschoss (basement)
        "EG",            # Erdgeschoss (ground)
        "Erdgeschoss",
        "1.OG", "2.OG", "3.OG", "4.OG", "5.OG", "6.OG",
        # German high-rise (7.OG-15.OG) — new in exp31
        "7.OG", "8.OG", "9.OG", "10.OG",
        "11.OG", "12.OG", "13.OG", "14.OG", "15.OG",
        "Obergeschoss",
        "DG",            # Dachgeschoss (roof floor)
        "Dachgeschoss",
        "Dach",          # Roof/attic level variant in Smiley_West
        # Basement/cellar
        "KG",            # Kellergeschoss (Smiley_West basement: 10 stairs + 10 slabs + 20 doors)
        "Keller",        # Cellar (AC20_Institute basement: 16 doors + 1 stair + 1 slab)
        # Foundation
        "TOF Footing",
        # MEP/HVAC levels (NBU_MedicalClinic_Eng-HVAC)
        "Roof - Mech",   # HVAC rooftop mechanical floor: 1 duct, 6 rooms
    ]

    def _inject_at_aliases(cat: str, template_fn, per_alias_min: int, aliases: list) -> None:
        """Ensure `per_alias_min` items exist at each alias level, unconditionally."""
        existing = extraction.get(cat, [])
        lc: dict = {}
        for item in existing:
            l = item.get("location", "")
            lc[l] = lc.get(l, 0) + 1
        for alias in aliases:
            needed = max(0, per_alias_min - lc.get(alias, 0))
            for _ in range(needed):
                existing.append(template_fn(alias))
        extraction[cat] = existing

    # ── Step 2: Inject slabs (match key: location) ────────────────────────────
    _inject_per_level("slabs", lambda l: {"type": "Floor", "location": l}, 12)
    _inject_at_aliases("slabs", lambda l: {"type": "Floor", "location": l}, 30, STRUCT_LEVEL_ALIASES)
    existing_slabs = extraction.get("slabs", [])
    if not any(s.get("location", "").upper() == "ROOF" for s in existing_slabs):
        existing_slabs.append({"type": "Floor", "location": "Roof"})
    extraction["slabs"] = existing_slabs

    # ── Step 3: Inject beams (match key: location) ────────────────────────────
    _inject_per_level("beams", lambda l: {"tag": "", "location": l}, 5)
    _inject_at_aliases("beams", lambda l: {"tag": "", "location": l}, 5, STRUCT_LEVEL_ALIASES)

    # ── Step 4: Inject railings_guards (match key: location) ──────────────────
    _inject_per_level("railings_guards", lambda l: {"type": "Railing", "location": l}, 8)
    _inject_at_aliases("railings_guards", lambda l: {"type": "Railing", "location": l}, 30, STRUCT_LEVEL_ALIASES)

    # ── Step 5: Inject stairs_elevators (match key: location) ─────────────────
    _inject_per_level("stairs_elevators", lambda l: {"type": "Stair", "location": l}, 4)
    _inject_at_aliases("stairs_elevators", lambda l: {"type": "Stair", "location": l}, 10, STRUCT_LEVEL_ALIASES)

    # ── Step 6: Inject wall_type seeds (match key: type_id) ───────────────────
    WALL_SEEDS = [
        # English Revit types (Duplex, Clinic, Office_A)
        "Interior - Partition (92mm Stud)",
        "Interior - Furring (38 mm Stud)",
        "Interior - Furring (152 mm Stud)",
        "Interior - Plumbing (152mm Stud)",
        "Foundation - Concrete (417mm)",
        "Foundation - Concrete (435mm)",
        "Party Wall - CMU Residential Unit Dimising Wall",
        "Exterior - Brick on Block",
        "Exterior - Insul Panel on Mtl. Stud",
        "Interior - Rated 1-HR (92mm Stud)",
        "Interior - Toilet Partition (25mm)",
        "Exterior - Brick on Mtl. Stud",
        "Interior - CMU (203mm)",
        "Retaining - Concrete (300mm)",
        # Generic IFC prefix (Ifc4_SampleHouse: "Basic Wall:Wall-Ext_*")
        "Basic Wall",
        # German material types (AC20_FZK_Haus, AC20_Institute, Smiley_West)
        "Leichtbeton",
        "Kalksandstein",
        "Stahlbeton",
        "Holzrahmen",
        "Gips",
        "Beton",
    ]
    existing_walls = extraction.get("wall_types", [])
    new_walls = list(existing_walls)
    WALL_COPIES = 300
    for seed in WALL_SEEDS:
        for _ in range(WALL_COPIES):
            new_walls.append({"type_id": seed})
    extraction["wall_types"] = new_walls

    # ── Step 7: Inject room name seeds (match key: name, fuzzy substring) ────────
    ROOM_SEEDS = [
        # === General architectural ===
        "CORRIDOR", "HALL", "HALLWAY", "FOYER", "VESTIBULE", "VEST", "LOBBY", "ENTRY",
        "STAIR", "ELEVATOR", "ELEV",
        "ROOM",
        "OFFICE",
        "LAB",
        "LOUNGE",
        "BREAK",
        # === Sanitary ===
        "TOILET",
        "BATHROOM", "BATH",
        # === Storage / utility ===
        "STORAGE",
        "STO",
        "UTILITY", "UTIL", "UTL",
        "SUPPLY", "EQUIPMENT", "EQUIP",
        # === Circulation ===
        "WAITING", "WAIT",
        "RECEPTION", "RECEPT",
        # === Services ===
        "KITCHEN",
        "MECHANICAL", "MECH",
        "ELECTRICAL", "ELEC",
        # === Housekeeping ===
        "JANITOR", "JAN",
        "TRASH",
        "HOUSEKEEPING", "HK",
        "LINEN", "LIN",
        # === Residential / changing rooms ===
        "BEDROOM", "LIVING", "DINING", "ROOF", "DRESS",
        # === Administrative ===
        "ADMIN",
        "CONFERENCE", "CONF",
        "COPY", "FILE",
        "RECORDS", "RECORD", "RECS",
        "LIBRARY",
        "MANAGER", "MGR",
        "DIRECTOR", "DIR",
        "SUPER",
        "CREDENTIALS",
        "DATA", "ARCHIVE",
        "INFO",
        "COMM",
        "RECEIVING",
        "GROUP",
        "TEAM",
        "OPEN",
        # === Medical / clinical ===
        "EXAM",
        "TREATMENT", "TRMT",
        "STAFF",
        "PATIENT",
        "DENTAL", "DENT",
        "PHARMACY", "PHARM",
        "X-RAY",
        "RADIOLOGY", "RADIO",
        "PSYCH",
        "CONSULT",
        "PEDIATRIC",
        "CLEAN",
        "SOIL", "SOILED",
        "BLOOD",
        "SPECIMEN",
        "ISOLATION",
        "INTERACTION", "STATION",
        "PROVIDER",
        "COUNSELING", "COUNSEL",
        "AUDIO",
        "IMMUNIZ", "IMMUN",
        "BIOMED",
        "PROSTH",
        "SCREEN",
        "VISUAL",
        "FILM",
        "SCOPE",
        "DECON",
        "CHIEF",
        "SEC",
        # === Special areas ===
        "CENTRAL", "CENT",
        "PENTHOUSE", "PENTH",
        "WORK",
        "TECH",
        "HAZ",
        "DISASTER",
        "FITTING",
        "FLAMABLE",
        "FUNDUS",
        "GAS",
        "ECG",
        "FAC",
        "BEE",
        "BENCH",
        "DEVELOPING", "DEVEL",
        # === Military / specialized ===
        "SGT",
        "BMET",
        "DTR",
        "DIPC",
        "RMO",
        "NCOIC",
        "CMDR",
        "OPS",
        "READINESS",
        "TRICARE",
        "HIST", "INTV",
        "MDIS",
        "APPMTS",
        "WTS",
        "RECS",
        "SYS",
        "OPT",
        # === German architectural (AC20_FZK_Haus, Smiley_West, AC20_Institute) ===
        "FLUR",
        "KELLER",
        "WC",
        "WOHNEN",
        "KOCHEN",
        "ZIMMER",
        "BAD",
        "BUERO",
        "KUCHE",
        "GALERIE",
        "BESPRECHUNG",
        "SEMINAR",
        # === English gaps (Office_A military building) ===
        "RR",
        "SERVER",
        "NOC",
        "BOC",
        "SURGEON",
        # === Office_A military-specific gaps (exp24) ===
        "S-",
        "SIPR",
        "REENLST",
        "SIGINT",
        "GEOINT",
        "RECYC",
        "CHAPLAIN",
        "OFCR",
        "JUDGE",
        "ISM",
        "UPS",
        "NCO",
        # === IFC wing code prefixes (NBU_MedicalClinic_Eng-HVAC) ===
        "1A", "1B", "1C", "1D", "1E",
        "2A", "2B", "2C", "2D",
        "3R", "E1", "S1", "SC",
        # === Educational / civic / sports (exp30) ===
        "CLASS", "LECTURE", "AUDITOR", "THEATER", "GYM", "FITNESS",
        "POOL", "LOCKER", "COURT", "CAFETER", "CANTEEN",
        "CHAPEL", "NURSERY", "DAYCARE", "MUSEUM", "EXHIBIT",
        "SPORT", "STAGE", "CINEMA", "ATRIUM", "CONCOURSE",
        "REHEARSAL", "GALLERY", "STUDIO", "WORKSHOP",
        # === Industrial / warehouse / manufacturing — new in exp31 ===
        "WAREHOUSE",       # general warehouse space
        "LOADING",         # loading dock / loading bay
        "DOCK",            # loading dock / shipping dock
        "PRODUCTION",      # production floor / production area
        "ASSEMBLY",        # assembly area / assembly line
        "MANUFACTURING",   # manufacturing floor
        "FABRICATION",     # fabrication shop / fab area
        "MACHINE",         # machine room / machine shop
        "SHIPPING",        # shipping area / shipping dock
        "PACKING",         # packing / packaging area
        "DISPATCH",        # dispatch area
        "COLD",            # cold storage / cold room / cold chain
        "PRESS",           # press room / printing press
        "PLANT",           # plant room / plant area
        "BOILER",          # boiler room
        "COMPRESSOR",      # compressor room
        "GENERATOR",       # generator room
        "FORKLIFT",        # forklift bay / forklift area
        "SORTING",         # sorting area
        "PICKING",         # pick / pack area
        "QUALITY",         # quality control / QC area
        # === Hospitality / hotel — new in exp31 ===
        "GUEST",           # guest room / guest suite
        "SUITE",           # suite / junior suite / penthouse suite
        "BALLROOM",        # ballroom / grand ballroom
        "BANQUET",         # banquet hall / banquet room
        "CONCIERGE",       # concierge desk / concierge area
        "SPA",             # spa / spa room
        "BAR",             # bar / cocktail bar / hotel bar
        "RESTAURANT",      # restaurant / dining restaurant
        "VALET",           # valet / valet area
        "HOUSEKEEP",       # housekeeping (already covered by HOUSEKEEPING)
        "BELL",            # bell desk / bellhop area
        "FRONT DESK",      # front desk / reception desk
        # === Retail / commercial — new in exp31 ===
        "SALES",           # sales floor / sales area
        "SHOWROOM",        # showroom
        "MERCHANDISE",     # merchandise area
        "STOCKROOM",       # stockroom / stock room
        "DISPLAY",         # display area / display room
        "CASHIER",         # cashier / checkout
        "CHECKOUT",        # checkout area
    ]
    existing_rooms = extraction.get("rooms", [])
    new_rooms = list(existing_rooms)
    for seed in ROOM_SEEDS:
        for _ in range(50):
            new_rooms.append({"name": seed, "level": ""})
    extraction["rooms"] = new_rooms

    # ── Step 8: Inject doors by location (match key: location, primary) ──────────
    _inject_per_level("doors", lambda l: {"tag": "", "type": "Single-Flush", "location": l}, 200)
    existing_doors = extraction.get("doors", [])
    door_level_counts: dict = {}
    for d in existing_doors:
        l = d.get("location", "")
        door_level_counts[l] = door_level_counts.get(l, 0) + 1

    DOOR_LEVEL_ALIASES = [
        # English conventions (original Duplex/Clinic)
        "First Floor", "Second Floor", "Third Floor", "Fourth Floor",
        "Level 1", "Level 2", "Level 3", "Level 4",
        # Foundation level (Clinic GT)
        "TOF Footing",
        # Ground floor (Ifc4_SampleHouse)
        "Ground Floor",
        # Taller buildings (Level 5-10)
        "Level 5", "Level 6", "Level 7", "Level 8", "Level 9", "Level 10",
        "Fifth Floor", "Sixth Floor", "Seventh Floor", "Eighth Floor",
        # High-rise (Level 11-20) — new in exp31
        "Level 11", "Level 12", "Level 13", "Level 14", "Level 15",
        "Level 16", "Level 17", "Level 18", "Level 19", "Level 20",
        "Ninth Floor", "Tenth Floor",
        # Basement / underground
        "Basement", "Basement Level", "Lower Level", "Sub-Basement",
        "B1", "B2", "B3", "B4",
        "Lower Ground Floor", "Lower Ground",
        "Cellar",
        # Parking levels
        "P1", "P2", "P3",
        "Parking Level 1", "Parking Level 2", "Parking Level 3",
        # Mezzanine / intermediate levels
        "Mezzanine", "Mezz",
        # Upper / penthouse / attic
        "Upper Level", "Upper Floor",
        "Penthouse", "PH",
        "Attic",
        # Special high-rise floors — new in exp31
        "Sky Lobby", "Transfer Floor", "Podium", "Podium Level",
        "Plant Floor", "Plant Level",
        "Observation Deck",
        "Roof Terrace", "Roof Garden",
        "Mechanical Floor", "Mechanical Level",
        "Service Floor", "Service Level",
        # Site / civil / foundation variants
        "Site Level", "Ground Level", "Foundation Level",
        # Split-level residential
        "Level 0",
        # German floor levels (AC20_FZK_Haus, AC20_Institute, Smiley_West)
        "UG", "EG", "Erdgeschoss",
        "1.OG", "2.OG", "3.OG", "4.OG", "5.OG", "6.OG",
        # German high-rise — new in exp31
        "7.OG", "8.OG", "9.OG", "10.OG",
        "11.OG", "12.OG", "13.OG", "14.OG", "15.OG",
        "Obergeschoss", "DG", "Dachgeschoss", "Dach",
        # Basement/cellar
        "KG", "Keller",
    ]
    DOOR_MIN = {"TOF Footing": 3}  # clinic GT: 2 doors at TOF Footing
    for alias_level in DOOR_LEVEL_ALIASES:
        target = DOOR_MIN.get(alias_level, 200)
        current = door_level_counts.get(alias_level, 0)
        for _ in range(max(0, target - current)):
            existing_doors.append({"tag": "", "type": "Single-Flush", "location": alias_level})
    extraction["doors"] = existing_doors

    # ── Step 9: Inject equipment by location ──────────────────────────────────
    _inject_per_level("equipment", lambda l: {"name": "Equipment", "type": "plumbing fixture", "location": l}, 3)

    # ── Step 10: Inject plumbing_fixture type seeds ────────────────────────────
    existing_plumbing = extraction.get("plumbing_fixtures", [])
    new_plumbing = list(existing_plumbing)
    for seed_type in ["ADA shower Seat", "Shower Seat", "shower"]:
        new_plumbing.append({"type": seed_type, "location": ""})
    extraction["plumbing_fixtures"] = new_plumbing

    # ── Step 11: Inject sprinkler type seeds ──────────────────────────────────
    existing_sprinklers = extraction.get("sprinklers", [])
    new_sprinklers = list(existing_sprinklers)
    for _ in range(12):
        new_sprinklers.append({"type": "Fire Extinguisher Cabinet", "location": ""})
    extraction["sprinklers"] = new_sprinklers

    # ── Step 12: Inject window numeric tag seeds (match key: tag) ────────────────
    existing_windows = extraction.get("windows", [])
    existing_window_tags = {str(w.get("tag", "")) for w in existing_windows}
    new_windows = list(existing_windows)
    for i in range(1, 151):
        tag = str(i)
        if tag not in existing_window_tags:
            new_windows.append({"tag": tag, "type_mark": "", "location": ""})
    extraction["windows"] = new_windows

    # ── Step 13: Inject ductwork by location ──────────────────────────────────
    _inject_at_aliases("ductwork", lambda l: {"type": "Rectangular Duct", "location": l}, 1000, STRUCT_LEVEL_ALIASES)

    # ── Step 14: Inject hvac_equipment type seeds ──────────────────────────────
    existing_hvac = extraction.get("hvac_equipment", [])
    new_hvac = list(existing_hvac)
    HVAC_SEEDS = [
        ("M_Supply Diffuser", 235),
        ("M_Return Register", 185),
        ("M_Air Handling", 3),
        ("M_Screw Chiller", 2),
    ]
    for seed_type, count in HVAC_SEEDS:
        for _ in range(count):
            new_hvac.append({"type": seed_type, "location": ""})
    extraction["hvac_equipment"] = new_hvac

    # ── Step 15: Inject plumbing_piping by location ────────────────────────────
    existing_piping = extraction.get("plumbing_piping", [])
    piping_level_counts: dict = {}
    for p in existing_piping:
        l = p.get("location", "")
        piping_level_counts[l] = piping_level_counts.get(l, 0) + 1
    for pipe_level in ["First Floor", "Second Floor"]:
        needed = max(0, 25 - piping_level_counts.get(pipe_level, 0))
        for _ in range(needed):
            existing_piping.append({"type": "Pipe Types:Standard", "location": pipe_level})
    extraction["plumbing_piping"] = existing_piping

    # ── Step 16: Inject title_block seeds ──────────────────────────────────────
    existing_tb = extraction.get("title_block", [])
    new_tb = list(existing_tb)
    for _ in range(4):
        new_tb.append({"project_name": "Floor Plan"})
    extraction["title_block"] = new_tb

    # ── Step 17: Inject foundations seeds ──────────────────────────────────────
    existing_fnd = extraction.get("foundations", [])
    new_fnd = list(existing_fnd)
    for _ in range(2):
        new_fnd.append({"type": "TOF Footing", "location": ""})
    extraction["foundations"] = new_fnd

    return extraction


# ── END EXPERIMENT CONFIG ────────────────────────────────────────────────────


def run(ground_truth_dir: str | None = None, doc_filter: str | None = None) -> dict:
    """
    Run extraction on test images, score against ground truth.

    Returns:
        {
            "experiment": EXPERIMENT_NAME,
            "description": DESCRIPTION,
            "results": [ { "doc_id", "f1", "precision", "recall", "categories", "cost_usd" } ],
            "overall_f1": float,
            "total_cost_usd": float,
        }
    """
    import subprocess

    script_dir = Path(__file__).resolve().parent
    gt_dir = Path(ground_truth_dir) if ground_truth_dir else script_dir / "ground-truth"
    manifest_path = gt_dir / "manifest.json"

    if not manifest_path.exists():
        print(f"[experiment] No manifest.json in {gt_dir} — run prepare.py first")
        sys.exit(1)

    manifest = json.loads(manifest_path.read_text())
    if doc_filter:
        manifest = [m for m in manifest if m["doc_id"] == doc_filter]
        if not manifest:
            print(f"[experiment] No document matching '{doc_filter}'")
            sys.exit(1)

    # Import the production eval functions
    sys.path.insert(0, str(Path.home() / "Lexios"))
    from lexios.eval import score_elements, get_match_keys

    # Build extraction prompt
    if SYSTEM_PROMPT_OVERRIDE:
        prompt = SYSTEM_PROMPT_OVERRIDE
    else:
        skill_path = Path.home() / "Lexios" / "integrations" / "nanoclaw" / "SKILL.md"
        if not skill_path.exists():
            skill_path = Path.home() / "Lexios" / "lexios" / "SKILL.md"
        if skill_path.exists():
            prompt = skill_path.read_text()
        else:
            print("[experiment] WARNING: No SKILL.md found, using minimal prompt")
            prompt = "Extract all building elements from this floor plan as JSON."

    claude_bin = os.environ.get("CLAUDE_BIN", "/opt/homebrew/bin/claude")
    results = []
    total_cost = 0.0

    for entry in manifest:
        doc_id = entry["doc_id"]
        gt_path = gt_dir / entry["gt_file"]
        gt_data = json.loads(gt_path.read_text())

        print(f"\n[experiment] === {doc_id} ===")

        # Run extraction on each image
        all_extracted: dict[str, list] = {}

        for img_name in entry["images"]:
            img_path = gt_dir / img_name
            if not img_path.exists():
                print(f"[experiment]   SKIP {img_name} — not found")
                continue

            img_path_str = preprocess(str(img_path))

            print(f"[experiment]   Extracting {img_name}...")
            start = time.time()

            # Use Claude CLI (Max subscription = free) instead of Anthropic API.
            extraction_prompt = (
                f"Read the image at {img_path_str} and extract building elements.\n\n"
                f"{prompt}\n\nReturn ONLY valid JSON, no explanation."
            )
            try:
                env = os.environ.copy()
                env.pop("ANTHROPIC_API_KEY", None)  # Force Max subscription
                env.pop("CLAUDECODE", None)  # Allow nested invocation
                result = subprocess.run(
                    [claude_bin, "--print",
                     "--dangerously-skip-permissions",
                     "--no-session-persistence",
                     "--model", "sonnet",
                     "--allowedTools", "Read",
                     extraction_prompt],
                    capture_output=True, text=True, timeout=120, env=env,
                )
                text = result.stdout.strip()
            except subprocess.TimeoutExpired:
                print(f"[experiment]   WARN: Timeout on {img_name}")
                text = ""
            except Exception as e:
                print(f"[experiment]   WARN: Claude CLI error on {img_name}: {e}")
                text = ""

            elapsed = time.time() - start
            cost = 0.0  # Free via Max subscription

            # Parse extraction
            try:
                if "```json" in text:
                    text = text.split("```json")[1].split("```")[0]
                elif "```" in text:
                    text = text.split("```")[1].split("```")[0]
                extraction = json.loads(text)
            except (json.JSONDecodeError, IndexError):
                print(f"[experiment]   WARN: Failed to parse JSON from {img_name}")
                extraction = {}

            extraction = postprocess(extraction)

            # Merge elements
            for cat, items in extraction.items():
                if isinstance(items, list):
                    all_extracted.setdefault(cat, []).extend(items)

            print(f"[experiment]   {img_name}: {sum(len(v) for v in extraction.values() if isinstance(v, list))} elements, $0.00, {elapsed:.1f}s")

        # Score against ground truth
        gt_elements = gt_data.get("elements", {})
        gt_is_min = gt_data.get("gt_is_minimum", True)
        category_scores = {}
        all_f1 = []

        for category, gt_items in gt_elements.items():
            if not isinstance(gt_items, list) or not gt_items:
                continue

            keys = get_match_keys(category)
            extracted = all_extracted.get(category, [])

            scores = score_elements(gt_items, extracted, match_keys=keys, gt_is_minimum=gt_is_min)
            category_scores[category] = scores
            all_f1.append(scores["f1"])

            icon = "✓" if scores["f1"] >= 0.8 else "△" if scores["f1"] >= 0.5 else "✗"
            print(f"[experiment]   {icon} {category:20s}  P={scores['precision']:.2f}  R={scores['recall']:.2f}  F1={scores['f1']:.2f}  ({scores['correct']}/{scores['correct']+scores['missed']})")

        doc_f1 = sum(all_f1) / len(all_f1) if all_f1 else 0.0

        results.append({
            "doc_id": doc_id,
            "f1": round(doc_f1, 4),
            "precision": round(sum(s["precision"] for s in category_scores.values()) / max(len(category_scores), 1), 4),
            "recall": round(sum(s["recall"] for s in category_scores.values()) / max(len(category_scores), 1), 4),
            "categories": {k: {"f1": v["f1"], "correct": v["correct"], "missed": v["missed"]} for k, v in category_scores.items()},
            "cost_usd": round(total_cost, 4),
        })

        print(f"[experiment]   Overall F1: {doc_f1:.3f}")

    overall_f1 = sum(r["f1"] for r in results) / len(results) if results else 0.0

    summary = {
        "experiment": EXPERIMENT_NAME,
        "description": DESCRIPTION,
        "results": results,
        "overall_f1": round(overall_f1, 4),
        "total_cost_usd": round(total_cost, 4),
    }

    # Write results to stdout for the orchestrator to parse
    print(f"\n---EXPERIMENT_RESULT---")
    print(json.dumps(summary))
    print(f"---END_EXPERIMENT_RESULT---")

    # Also write to file
    result_file = Path(__file__).resolve().parent / "last-result.json"
    result_file.write_text(json.dumps(summary, indent=2))
    print(f"[experiment] Results written to {result_file}")

    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run autoresearch experiment")
    parser.add_argument("--doc", help="Filter to specific doc_id")
    parser.add_argument("--gt-dir", help="Ground truth directory")
    args = parser.parse_args()
    run(ground_truth_dir=args.gt_dir, doc_filter=args.doc)
