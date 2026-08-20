"""Jyotish domain — categorise/entity/relationship/claim functions for Vedic
astrology knowledge. Imported by both the legacy compile_jyotish_wiki.py
entrypoint and any future caller. Behaviour identical to the original script.
"""
from __future__ import annotations

import re
from pathlib import Path

from ..lib import Domain


JYOTISH_ENTITIES = {
    "planet": [
        "Sun", "Moon", "Mars", "Mercury", "Jupiter", "Venus", "Saturn", "Rahu", "Ketu",
        "Surya", "Chandra", "Mangal", "Kuja", "Budha", "Guru", "Brihaspati", "Shukra", "Shani",
    ],
    "sign": [
        "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
        "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces",
        "Mesha", "Vrishabha", "Mithuna", "Karka", "Simha", "Kanya",
        "Tula", "Vrischika", "Dhanu", "Makara", "Kumbha", "Meena",
    ],
    "house": [
        "Lagna", "1st house", "2nd house", "3rd house", "4th house", "5th house",
        "6th house", "7th house", "8th house", "9th house", "10th house", "11th house", "12th house",
        "Kendra", "Trikona", "Dusthana", "Upachaya", "Maraka",
    ],
    "yoga": [
        "Gajakesari", "Hamsa", "Malavya", "Ruchaka", "Bhadra", "Sasa",
        "Raja Yoga", "Dhana Yoga", "Viparita Raja Yoga", "Neecha Bhanga",
        "Guru Chandala", "Kala Sarpa", "Manglik", "Grahan Yoga",
        "Budh-Aditya", "Lakshmi Yoga", "Dharma-Karmadhipati",
    ],
    "dasha": [
        "Vimshottari", "Narayana", "Chara Dasha", "Kalachakra", "Yogini",
        "Ashtottari", "Moola", "Sade Sati", "Mahadasha", "Antardasha",
    ],
    "concept": [
        "Shadbala", "Vimsopaka", "Ashtakavarga", "BAV", "SAV",
        "Navamsa", "Dasamsa", "Karakamsha", "Arudha Pada",
        "Atma Karaka", "Amatya Karaka", "Dara Karaka",
        "PACDARES", "Double Transit", "Panchanga", "Saham",
    ],
    "person": [
        "PVR Narasimha Rao", "PVR", "KN Rao", "Sanjay Rath",
        "Parashara", "Jaimini", "Varahamihira",
    ],
    "text": [
        "BPHS", "Brihat Parashara Hora Shastra", "Uttara Kalamrita",
        "Phaladeepika", "Brihat Jataka", "Jaimini Sutras", "Saravali",
    ],
}

JYOTISH_RELATIONSHIPS = {
    "rules": r"(?:rules?|governs?|signifies|indicates|represents)",
    "aspects": r"(?:aspects?|aspecting|aspected by)",
    "exalted_in": r"(?:exalted? in|exaltation)",
    "debilitated_in": r"(?:debilitated? in|debilitation|fall)",
    "owns": r"(?:owns?|lord of|lordship)",
    "friends_with": r"(?:friends? with|friendly to|friend)",
    "enemies_with": r"(?:enemies? with|enemy of|inimical)",
    "causes": r"(?:causes?|produces?|creates?|gives?|brings?)",
    "cancels": r"(?:cancels?|cancellation|negates?|neutralizes?)",
    "strengthens": r"(?:strengthens?|supports?|benefits?|protects?)",
    "weakens": r"(?:weakens?|afflicts?|damages?|harms?)",
}


def categorize(file_path: Path) -> str:
    name = file_path.stem.lower()
    if any(x in name for x in ["planet", "graha", "sun", "moon", "mars", "mercury",
                                 "jupiter", "venus", "saturn", "rahu", "ketu"]):
        return "planets"
    if any(x in name for x in ["house", "bhava", "kendra", "trikona"]):
        return "houses"
    if any(x in name for x in ["yoga", "dosha", "manglik", "kala-sarpa"]):
        return "yogas"
    if any(x in name for x in ["dasha", "vimshottari", "narayana", "chara"]):
        return "dashas"
    if any(x in name for x in ["transit", "gochara", "sade-sati"]):
        return "transits"
    if any(x in name for x in ["divisional", "varga", "navamsa", "dasamsa"]):
        return "divisional"
    if any(x in name for x in ["compatibility", "marriage", "koota", "ashtakoota"]):
        return "compatibility"
    if any(x in name for x in ["remedy", "mantra", "gemstone"]):
        return "remedies"
    if any(x in name for x in ["pvr", "methodology", "pipeline", "prediction"]):
        return "methodology"
    return "general"


def extract_entities(content: str) -> list[dict]:
    entities = []
    seen: set[str] = set()
    for etype, keywords in JYOTISH_ENTITIES.items():
        for kw in keywords:
            if kw.lower() in content.lower() and kw not in seen:
                seen.add(kw)
                entities.append({"type": etype, "name": kw})
    return entities


def extract_relationships(content: str, entities: list[dict]) -> list[dict]:
    relationships = []
    entity_names = [e["name"] for e in entities]
    for rtype, pattern in JYOTISH_RELATIONSHIPS.items():
        for match in re.finditer(pattern, content, re.IGNORECASE):
            ctx_start = max(0, match.start() - 100)
            ctx = content[ctx_start:match.end() + 100]
            local_match_start = match.start() - ctx_start
            source = target = None
            for name in entity_names:
                if name.lower() in ctx[:local_match_start].lower():
                    source = name
                if name.lower() in ctx[match.end() - ctx_start:].lower():
                    target = name
            if source and target and source != target:
                relationships.append({
                    "type": rtype, "source": source, "target": target,
                    "confidence": 0.7,
                })
    return relationships[:20]


def extract_claims(content: str) -> list[dict]:
    claims = []
    patterns = [
        r"(?:Score|score)[\s:]+(\d+)/(\d+)",
        r"(\d+)\s+(?:years?|months?|days?)\s+(?:period|cycle|transit|dasha)",
        r"(?:houses?|bhava)\s+(\d+(?:\s*,\s*\d+)*)",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, content):
            claims.append({"raw": match.group(0), "pattern": pattern[:30]})
    return claims[:10]


def make_domain(base: Path) -> Domain:
    return Domain(
        name="jyotish",
        base=base,
        title_label="Jyotish",
        categorize=categorize,
        extract_entities=extract_entities,
        extract_relationships=extract_relationships,
        extract_claims=extract_claims,
    )
