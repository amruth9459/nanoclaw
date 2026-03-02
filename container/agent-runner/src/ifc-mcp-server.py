#!/usr/bin/env python3
"""IFC MCP Server — Exposes IfcOpenShell query tools to the agent via stdio.

Based on smartaec/ifcMCP (Apache-2.0) by Jia-Rui Lin, adapted for NanoClaw's
stdio MCP transport. Provides 7 IFC query tools for interactive building analysis.

Registered as a second MCP server in agent-runner/src/index.ts.
The agent calls these as mcp__ifc__get_entities, mcp__ifc__query_spaces, etc.
"""
import json
import os
import sys
from pathlib import Path

try:
    import ifcopenshell
    import ifcopenshell.util.element as element_util
except ImportError:
    # Graceful degradation — server starts but tools return errors
    ifcopenshell = None

# FastMCP for stdio transport
try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    # Fallback: try older import path
    try:
        from fastmcp import FastMCP
    except ImportError:
        print("Neither mcp nor fastmcp installed", file=sys.stderr)
        sys.exit(1)

mcp = FastMCP("ifc")

# ── Model cache ──────────────────────────────────────────────────

_model_cache: dict[str, object] = {}


def _open(file_path: str):
    """Open and cache an IFC model."""
    if not ifcopenshell:
        raise RuntimeError("ifcopenshell not installed")
    resolved = str(Path(file_path).resolve())
    if resolved not in _model_cache:
        if not Path(resolved).exists():
            raise FileNotFoundError(f"IFC file not found: {resolved}")
        _model_cache[resolved] = ifcopenshell.open(resolved)
    return _model_cache[resolved]


def _get_psets(element) -> dict:
    """Get all property sets as flat dict."""
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


def _get_location(element) -> dict | None:
    """Get element placement coordinates."""
    try:
        placement = element.ObjectPlacement
        if placement and hasattr(placement, "RelativePlacement"):
            loc = placement.RelativePlacement
            if hasattr(loc, "Location") and loc.Location:
                coords = loc.Location.Coordinates
                return {"x": round(coords[0], 2), "y": round(coords[1], 2),
                        "z": round(coords[2], 2) if len(coords) > 2 else 0}
    except Exception:
        pass
    return None


def _get_container_name(element) -> str:
    """Get spatial container name (storey/space)."""
    try:
        container = element_util.get_container(element)
        if container:
            return str(getattr(container, "Name", ""))
    except Exception:
        pass
    return ""


# ── Tools ────────────────────────────────────────────────────────

@mcp.tool()
def get_entities(file_path: str, entity_type: str) -> str:
    """Get all IFC entities of a specific type. Returns globalId, name, and type for each.

    Common entity_type values: IfcWall, IfcDoor, IfcWindow, IfcSpace,
    IfcColumn, IfcBeam, IfcSlab, IfcStair, IfcRailing, IfcFlowTerminal,
    IfcFlowSegment, IfcBuildingStorey.

    Args:
        file_path: Path to the IFC file
        entity_type: IFC entity class name (e.g. "IfcWall", "IfcDoor")
    """
    model = _open(file_path)
    entities = model.by_type(entity_type)
    results = []
    for e in entities:
        entry = {
            "globalId": e.GlobalId,
            "name": str(getattr(e, "Name", "") or ""),
            "type": e.is_a(),
        }
        tag = getattr(e, "Tag", None)
        if tag:
            entry["tag"] = str(tag)
        results.append(entry)
    return json.dumps({"count": len(results), "entities": results}, indent=2)


@mcp.tool()
def get_entity_properties(file_path: str, global_id: str) -> str:
    """Get all properties and quantities of an IFC entity by its GlobalId.

    Args:
        file_path: Path to the IFC file
        global_id: The GlobalId of the entity
    """
    model = _open(file_path)
    element = model.by_guid(global_id)
    if not element:
        return json.dumps({"error": f"Entity not found: {global_id}"})

    result = {
        "globalId": element.GlobalId,
        "name": str(getattr(element, "Name", "") or ""),
        "type": element.is_a(),
        "properties": _get_psets(element),
        "location": _get_location(element),
        "container": _get_container_name(element),
    }
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
def get_property(file_path: str, global_ids: str, property_name: str) -> str:
    """Get a specific named property for one or more entities.

    Args:
        file_path: Path to the IFC file
        global_ids: Comma-separated GlobalIds
        property_name: Property name to retrieve (e.g. "FireRating", "IsExternal", "LoadBearing")
    """
    model = _open(file_path)
    ids = [gid.strip() for gid in global_ids.split(",")]
    results = []
    for gid in ids:
        try:
            element = model.by_guid(gid)
            if not element:
                results.append({"globalId": gid, "error": "not found"})
                continue
            props = _get_psets(element)
            value = props.get(property_name)
            results.append({
                "globalId": gid,
                "name": str(getattr(element, "Name", "") or ""),
                property_name: value if value is not None else "not set",
            })
        except Exception as e:
            results.append({"globalId": gid, "error": str(e)})
    return json.dumps(results, indent=2, default=str)


@mcp.tool()
def query_spaces(file_path: str) -> str:
    """Get all spaces (rooms) in the IFC model with their areas and storeys.

    Args:
        file_path: Path to the IFC file
    """
    model = _open(file_path)
    spaces = model.by_type("IfcSpace")
    results = []
    for space in spaces:
        entry = {
            "globalId": space.GlobalId,
            "name": str(getattr(space, "Name", "") or ""),
            "longName": str(getattr(space, "LongName", "") or ""),
            "storey": _get_container_name(space),
        }
        # Try to get area
        try:
            qtos = element_util.get_psets(space, qtos_only=True)
            for qto_name, props in qtos.items():
                area = props.get("NetFloorArea") or props.get("GrossFloorArea")
                if area:
                    entry["area_m2"] = round(float(area), 2)
                    entry["area_sqft"] = round(float(area) * 10.764, 1)
                    break
        except Exception:
            pass
        results.append(entry)
    return json.dumps({"count": len(results), "spaces": results}, indent=2)


@mcp.tool()
def get_entities_in_spatial(file_path: str, global_id: str) -> str:
    """Get all entities contained in a spatial structure element.
    Works with IfcBuildingStorey, IfcSpace, IfcBuilding, IfcSite.

    Args:
        file_path: Path to the IFC file
        global_id: GlobalId of the spatial container
    """
    model = _open(file_path)
    spatial = model.by_guid(global_id)
    if not spatial:
        return json.dumps({"error": f"Entity not found: {global_id}"})

    results = []
    try:
        # Direct containment
        for rel in getattr(spatial, "ContainsElements", []):
            for element in rel.RelatedElements:
                results.append({
                    "globalId": element.GlobalId,
                    "name": str(getattr(element, "Name", "") or ""),
                    "type": element.is_a(),
                })
    except Exception as e:
        return json.dumps({"error": str(e)})

    return json.dumps({
        "container": str(getattr(spatial, "Name", "")),
        "count": len(results),
        "entities": results,
    }, indent=2)


@mcp.tool()
def get_openings_on_wall(file_path: str, global_id: str) -> str:
    """Get all openings (doors, windows) on a specific wall.

    Args:
        file_path: Path to the IFC file
        global_id: GlobalId of the wall
    """
    model = _open(file_path)
    wall = model.by_guid(global_id)
    if not wall:
        return json.dumps({"error": f"Wall not found: {global_id}"})

    openings = []
    try:
        for rel in getattr(wall, "HasOpenings", []):
            opening = rel.RelatedOpeningElement
            # Find what fills the opening (door/window)
            for fill_rel in getattr(opening, "HasFillings", []):
                filling = fill_rel.RelatedBuildingElement
                entry = {
                    "globalId": filling.GlobalId,
                    "name": str(getattr(filling, "Name", "") or ""),
                    "type": filling.is_a(),
                }
                if hasattr(filling, "OverallWidth") and filling.OverallWidth:
                    entry["width_m"] = round(float(filling.OverallWidth), 3)
                if hasattr(filling, "OverallHeight") and filling.OverallHeight:
                    entry["height_m"] = round(float(filling.OverallHeight), 3)
                openings.append(entry)
    except Exception as e:
        return json.dumps({"error": str(e)})

    return json.dumps({
        "wall": str(getattr(wall, "Name", "")),
        "count": len(openings),
        "openings": openings,
    }, indent=2)


@mcp.tool()
def get_model_summary(file_path: str) -> str:
    """Get a high-level summary of an IFC model: project info, storeys, entity counts.

    Args:
        file_path: Path to the IFC file
    """
    model = _open(file_path)

    # Project info
    projects = model.by_type("IfcProject")
    project = {}
    if projects:
        p = projects[0]
        project = {
            "name": str(getattr(p, "Name", "") or ""),
            "description": str(getattr(p, "Description", "") or ""),
        }

    # Storeys
    storeys = []
    for s in model.by_type("IfcBuildingStorey"):
        storeys.append({
            "globalId": s.GlobalId,
            "name": str(getattr(s, "Name", "") or ""),
            "elevation": round(float(s.Elevation), 2) if s.Elevation else None,
        })

    # Entity counts for key types
    key_types = [
        "IfcWall", "IfcDoor", "IfcWindow", "IfcSpace", "IfcColumn",
        "IfcBeam", "IfcSlab", "IfcStair", "IfcRailing", "IfcRoof",
        "IfcFlowTerminal", "IfcFlowSegment", "IfcEnergyConversionDevice",
        "IfcElectricDistributionBoard",
    ]
    counts = {}
    for t in key_types:
        n = len(model.by_type(t))
        if n > 0:
            counts[t] = n

    return json.dumps({
        "schema": model.schema,
        "project": project,
        "storeys": storeys,
        "entity_counts": counts,
        "total_entities": len(list(model)),
    }, indent=2)


# ── Main ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Run as stdio MCP server (NanoClaw transport)
    mcp.run(transport="stdio")
