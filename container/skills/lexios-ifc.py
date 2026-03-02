#!/usr/bin/env python3
"""Extract structured data from IFC files using IfcOpenShell.
Maps IFC semantic classes to Lexios 101-type taxonomy.

Usage: python3 ifc.py <filepath> [output_dir]

Output files:
  ifc-extraction.json  - Structured data extraction
  ifc-render.png       - 2D floor plan rendering (if available)
"""
import sys
import json
import os
import re

try:
    import ifcopenshell
    import ifcopenshell.util.element as element_util
except ImportError:
    print(json.dumps({"error": "ifcopenshell not installed. Run: pip install ifcopenshell"}),
          file=sys.stderr)
    sys.exit(1)


def _safe_str(val) -> str:
    """Safely convert IFC value to string."""
    if val is None:
        return ""
    if isinstance(val, (list, tuple)):
        return ", ".join(str(v) for v in val)
    return str(val)


def _get_psets(element) -> dict:
    """Get all property sets for an element as flat dict."""
    try:
        psets = element_util.get_psets(element)
        flat = {}
        for pset_name, props in psets.items():
            for k, v in props.items():
                if k == "id":
                    continue
                flat[k] = v
        return flat
    except Exception:
        return {}


def _get_qtos(element) -> dict:
    """Get all quantity sets for an element as flat dict."""
    try:
        qtos = element_util.get_psets(element, qtos_only=True)
        flat = {}
        for qto_name, props in qtos.items():
            for k, v in props.items():
                if k == "id":
                    continue
                flat[k] = v
        return flat
    except Exception:
        return {}


def _get_location(element) -> str:
    """Get human-readable location from spatial containment."""
    try:
        container = element_util.get_container(element)
        if container:
            return _safe_str(getattr(container, "Name", "")) or _safe_str(getattr(container, "LongName", ""))
    except Exception:
        pass
    return ""


def _get_storey(element) -> str:
    """Get building storey name."""
    try:
        container = element_util.get_container(element)
        if container and container.is_a("IfcBuildingStorey"):
            return _safe_str(container.Name)
        # Walk up containment
        parent = element_util.get_aggregate(element)
        if parent and parent.is_a("IfcBuildingStorey"):
            return _safe_str(parent.Name)
    except Exception:
        pass
    return ""


def extract(filepath: str, output_dir: str) -> dict:
    """Extract structured data from an IFC file."""
    try:
        model = ifcopenshell.open(filepath)
    except Exception as e:
        return {"error": f"Failed to read IFC file: {e}"}

    result = {
        "filename": os.path.basename(filepath),
        "file_format": "IFC",
        "schema": model.schema,
        "project": {},
        "storeys": [],
        "spaces": [],
        "walls": [],
        "doors": [],
        "windows": [],
        "columns": [],
        "beams": [],
        "slabs": [],
        "stairs": [],
        "railings": [],
        "plumbing_fixtures": [],
        "hvac_equipment": [],
        "ductwork": [],
        "electrical_panels": [],
        "lighting_fixtures": [],
        "sprinklers": [],
        "piping": [],
        "entity_counts": {},
    }

    # Count entities by type
    type_counts = {}
    for entity in model:
        etype = entity.is_a()
        type_counts[etype] = type_counts.get(etype, 0) + 1
    result["entity_counts"] = type_counts

    # Project info
    projects = model.by_type("IfcProject")
    if projects:
        proj = projects[0]
        result["project"] = {
            "name": _safe_str(getattr(proj, "Name", "")),
            "description": _safe_str(getattr(proj, "Description", "")),
            "phase": _safe_str(getattr(proj, "Phase", "")),
        }

    # Building storeys
    for storey in model.by_type("IfcBuildingStorey"):
        entry = {
            "name": _safe_str(storey.Name),
            "elevation": None,
        }
        try:
            entry["elevation"] = round(float(storey.Elevation), 2)
        except Exception:
            pass
        result["storeys"].append(entry)

    # Spaces → rooms
    for space in model.by_type("IfcSpace"):
        entry = {
            "name": _safe_str(space.Name) or _safe_str(getattr(space, "LongName", "")),
            "long_name": _safe_str(getattr(space, "LongName", "")),
            "level": _get_storey(space),
        }
        qtos = _get_qtos(space)
        if qtos.get("NetFloorArea"):
            entry["area_sqft"] = round(float(qtos["NetFloorArea"]) * 10.764, 1)  # m² → sqft
        elif qtos.get("GrossFloorArea"):
            entry["area_sqft"] = round(float(qtos["GrossFloorArea"]) * 10.764, 1)
        psets = _get_psets(space)
        if psets.get("OccupancyType"):
            entry["function"] = _safe_str(psets["OccupancyType"])
        result["spaces"].append(entry)

    # Walls
    for wall in model.by_type("IfcWall"):
        entry = {
            "type": _safe_str(getattr(wall, "Name", "")),
            "location": _get_location(wall),
            "level": _get_storey(wall),
        }
        qtos = _get_qtos(wall)
        if qtos.get("Width"):
            entry["thickness"] = _safe_str(qtos["Width"])
        elif qtos.get("NominalWidth"):
            entry["thickness"] = _safe_str(qtos["NominalWidth"])
        psets = _get_psets(wall)
        if psets.get("FireRating"):
            entry["fire_rating"] = _safe_str(psets["FireRating"])
        if psets.get("IsExternal"):
            entry["is_external"] = bool(psets["IsExternal"])
        result["walls"].append(entry)

    # Doors
    for door in model.by_type("IfcDoor"):
        entry = {
            "tag": _safe_str(getattr(door, "Tag", "")) or _safe_str(getattr(door, "Name", "")),
            "location": _get_location(door),
            "level": _get_storey(door),
        }
        try:
            if door.OverallWidth:
                entry["width"] = round(float(door.OverallWidth) * 39.37, 1)  # m → inches
            if door.OverallHeight:
                entry["height"] = round(float(door.OverallHeight) * 39.37, 1)
            if entry.get("width") and entry.get("height"):
                entry["size"] = f"{entry['width']}x{entry['height']}"
        except Exception:
            pass
        psets = _get_psets(door)
        if psets.get("FireRating"):
            entry["fire_rating"] = _safe_str(psets["FireRating"])
        if psets.get("OperationType"):
            entry["type"] = _safe_str(psets["OperationType"])
        result["doors"].append(entry)

    # Windows
    for win in model.by_type("IfcWindow"):
        entry = {
            "tag": _safe_str(getattr(win, "Tag", "")) or _safe_str(getattr(win, "Name", "")),
            "location": _get_location(win),
            "level": _get_storey(win),
        }
        try:
            if win.OverallWidth:
                entry["width"] = round(float(win.OverallWidth) * 39.37, 1)
            if win.OverallHeight:
                entry["height"] = round(float(win.OverallHeight) * 39.37, 1)
            if entry.get("width") and entry.get("height"):
                entry["size"] = f"{entry['width']}x{entry['height']}"
        except Exception:
            pass
        psets = _get_psets(win)
        if psets.get("GlazingType"):
            entry["glazing"] = _safe_str(psets["GlazingType"])
        result["windows"].append(entry)

    # Columns
    for col in model.by_type("IfcColumn"):
        entry = {
            "tag": _safe_str(getattr(col, "Tag", "")) or _safe_str(getattr(col, "Name", "")),
            "location": _get_location(col),
            "level": _get_storey(col),
        }
        psets = _get_psets(col)
        if psets.get("LoadBearing"):
            entry["load_bearing"] = bool(psets["LoadBearing"])
        result["columns"].append(entry)

    # Beams
    for beam in model.by_type("IfcBeam"):
        entry = {
            "tag": _safe_str(getattr(beam, "Tag", "")) or _safe_str(getattr(beam, "Name", "")),
            "location": _get_location(beam),
            "level": _get_storey(beam),
        }
        qtos = _get_qtos(beam)
        if qtos.get("Length"):
            entry["span"] = _safe_str(round(float(qtos["Length"]), 2))
        result["beams"].append(entry)

    # Slabs
    for slab in model.by_type("IfcSlab"):
        entry = {
            "type": _safe_str(getattr(slab, "Name", "")),
            "location": _get_location(slab),
            "level": _get_storey(slab),
        }
        qtos = _get_qtos(slab)
        if qtos.get("Width") or qtos.get("Depth"):
            entry["thickness"] = _safe_str(qtos.get("Width") or qtos.get("Depth"))
        psets = _get_psets(slab)
        if psets.get("PredefinedType"):
            entry["slab_type"] = _safe_str(psets["PredefinedType"])
        result["slabs"].append(entry)

    # Stairs
    for stair in model.by_type("IfcStair"):
        entry = {
            "type": _safe_str(getattr(stair, "Name", "")),
            "location": _get_location(stair),
            "level": _get_storey(stair),
        }
        psets = _get_psets(stair)
        if psets.get("NumberOfRiser"):
            entry["risers"] = int(psets["NumberOfRiser"])
        if psets.get("NumberOfTreads"):
            entry["treads"] = int(psets["NumberOfTreads"])
        result["stairs"].append(entry)

    # Railings
    for rail in model.by_type("IfcRailing"):
        entry = {
            "type": _safe_str(getattr(rail, "Name", "")),
            "location": _get_location(rail),
            "level": _get_storey(rail),
        }
        qtos = _get_qtos(rail)
        if qtos.get("Length"):
            entry["length"] = _safe_str(round(float(qtos["Length"]), 2))
        result["railings"].append(entry)

    # MEP: Flow terminals (sinks, toilets, fixtures)
    for term in model.by_type("IfcFlowTerminal"):
        name = _safe_str(getattr(term, "Name", "")).lower()
        entry = {
            "type": _safe_str(getattr(term, "Name", "")),
            "location": _get_location(term),
            "level": _get_storey(term),
        }
        psets = _get_psets(term)
        if psets.get("Manufacturer"):
            entry["manufacturer"] = _safe_str(psets["Manufacturer"])

        # Classify by name heuristics
        if any(kw in name for kw in ("sink", "toilet", "wc", "lavatory", "tub",
                                      "shower", "urinal", "bidet", "faucet")):
            result["plumbing_fixtures"].append(entry)
        elif any(kw in name for kw in ("sprinkler", "fire")):
            result["sprinklers"].append(entry)
        elif any(kw in name for kw in ("light", "luminaire", "lamp", "fixture")):
            result["lighting_fixtures"].append(entry)
        elif any(kw in name for kw in ("diffuser", "register", "grille")):
            result["hvac_equipment"].append(entry)

    # MEP: Flow segments (pipes, ducts)
    for seg in model.by_type("IfcFlowSegment"):
        name = _safe_str(getattr(seg, "Name", "")).lower()
        entry = {
            "type": _safe_str(getattr(seg, "Name", "")),
            "location": _get_location(seg),
            "level": _get_storey(seg),
        }
        qtos = _get_qtos(seg)
        if qtos.get("Length"):
            entry["length"] = _safe_str(round(float(qtos["Length"]), 2))

        if any(kw in name for kw in ("pipe", "drain", "supply", "waste")):
            result["piping"].append(entry)
        elif any(kw in name for kw in ("duct", "vent")):
            result["ductwork"].append(entry)

    # MEP: Energy conversion devices (furnaces, boilers, heat pumps)
    for dev in model.by_type("IfcEnergyConversionDevice"):
        entry = {
            "type": _safe_str(getattr(dev, "Name", "")),
            "location": _get_location(dev),
            "level": _get_storey(dev),
        }
        psets = _get_psets(dev)
        if psets.get("NominalCapacity"):
            entry["capacity"] = _safe_str(psets["NominalCapacity"])
        result["hvac_equipment"].append(entry)

    # MEP: Distribution control elements (panels, switchgear)
    for panel in model.by_type("IfcElectricDistributionBoard"):
        entry = {
            "type": _safe_str(getattr(panel, "Name", "")),
            "location": _get_location(panel),
            "level": _get_storey(panel),
        }
        psets = _get_psets(panel)
        if psets.get("NominalCurrent"):
            entry["amperage"] = _safe_str(psets["NominalCurrent"])
        result["electrical_panels"].append(entry)

    # Write output
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, "ifc-extraction.json")
    with open(output_path, "w") as f:
        json.dump(result, f, indent=2)

    # Try to render a 2D view
    try:
        render_plan(model, output_dir)
    except Exception as e:
        result["render_note"] = f"Rendering skipped: {e}"

    # Summary
    counts = {
        "spaces": len(result["spaces"]),
        "walls": len(result["walls"]),
        "doors": len(result["doors"]),
        "windows": len(result["windows"]),
        "columns": len(result["columns"]),
        "beams": len(result["beams"]),
        "slabs": len(result["slabs"]),
        "stairs": len(result["stairs"]),
        "plumbing_fixtures": len(result["plumbing_fixtures"]),
        "hvac_equipment": len(result["hvac_equipment"]),
        "ductwork": len(result["ductwork"]),
        "electrical_panels": len(result["electrical_panels"]),
        "lighting_fixtures": len(result["lighting_fixtures"]),
        "sprinklers": len(result["sprinklers"]),
        "piping": len(result["piping"]),
    }

    print(json.dumps({
        "success": True,
        "output": output_path,
        "schema": model.schema,
        "storeys": len(result["storeys"]),
        **counts,
    }))

    return result


def render_plan(model, output_dir: str):
    """Render IFC model to 2D plan view PNG."""
    try:
        import ifcopenshell.geom
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.patches import Polygon
        from matplotlib.collections import PatchCollection
        import numpy as np

        settings = ifcopenshell.geom.settings()
        settings.set(settings.USE_WORLD_COORDS, True)

        fig, ax = plt.subplots(1, 1, figsize=(16, 12), dpi=150)
        patches = []

        for wall in model.by_type("IfcWall"):
            try:
                shape = ifcopenshell.geom.create_shape(settings, wall)
                verts = shape.geometry.verts
                # Extract XY coordinates (flatten Z)
                xs = verts[0::3]
                ys = verts[1::3]
                if xs and ys:
                    ax.plot(xs, ys, "k-", linewidth=0.5, alpha=0.6)
            except Exception:
                continue

        ax.set_aspect("equal")
        ax.set_title(f"IFC Plan View — {os.path.basename(output_dir)}")
        output_path = os.path.join(output_dir, "ifc-render.png")
        fig.savefig(output_path, dpi=150, bbox_inches="tight")
        plt.close(fig)
    except ImportError:
        pass  # Geometry processing not available
    except Exception:
        pass  # Rendering failed, non-critical


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python3 ifc.py <filepath> [output_dir]"}))
        sys.exit(1)

    filepath = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else "."

    if not os.path.exists(filepath):
        print(json.dumps({"error": f"File not found: {filepath}"}))
        sys.exit(1)

    extract(filepath, output_dir)
