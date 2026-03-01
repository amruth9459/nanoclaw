#!/usr/bin/env python3
"""Extract structured data from DWG/DXF files using ezdxf.
Outputs JSON with layers, text entities, dimensions, blocks, and spatial coordinates.
Also renders each layer to PNG for visual analysis.

Usage: lexios-dxf <filepath> [output_dir]
  filepath:   Path to .dxf or .dwg file
  output_dir: Directory for output files (default: /workspace/group/lexios-work)

Output files:
  dxf-extraction.json  - Structured data extraction
  dxf-layer-*.png      - Rendered layer images (if matplotlib available)
"""
import sys
import json
import os

try:
    import ezdxf
except ImportError:
    print(json.dumps({"error": "ezdxf not installed. Run: pip3 install ezdxf"}), file=sys.stderr)
    sys.exit(1)


def extract_text_from_entity(entity):
    """Extract text content from TEXT or MTEXT entity."""
    if entity.dxftype() == 'MTEXT':
        return entity.text if hasattr(entity, 'text') else str(entity.dxf.text) if hasattr(entity.dxf, 'text') else ''
    elif entity.dxftype() == 'TEXT':
        return str(entity.dxf.text) if hasattr(entity.dxf, 'text') else ''
    return ''


def get_position(entity):
    """Get XYZ position from an entity, handling various entity types."""
    try:
        if hasattr(entity.dxf, 'insert'):
            pos = entity.dxf.insert
            return [round(pos.x, 4), round(pos.y, 4), round(getattr(pos, 'z', 0), 4)]
        if hasattr(entity.dxf, 'start'):
            pos = entity.dxf.start
            return [round(pos.x, 4), round(pos.y, 4), round(getattr(pos, 'z', 0), 4)]
    except Exception:
        pass
    return None


def extract(filepath, output_dir):
    """Extract structured data from a DXF/DWG file."""
    try:
        doc = ezdxf.readfile(filepath)
    except Exception as e:
        return {"error": f"Failed to read file: {str(e)}"}

    msp = doc.modelspace()

    result = {
        "filename": os.path.basename(filepath),
        "file_format": "DXF" if filepath.lower().endswith('.dxf') else "DWG",
        "layers": [],
        "text_entities": [],
        "dimensions": [],
        "blocks": [],
        "lines": [],
        "spatial_bounds": None,
        "entity_counts": {},
    }

    # Extract layers
    for layer in doc.layers:
        layer_info = {
            "name": layer.dxf.name,
            "color": layer.dxf.color,
            "is_on": layer.is_on(),
            "is_locked": layer.is_locked(),
        }
        if hasattr(layer.dxf, 'linetype'):
            layer_info["linetype"] = layer.dxf.linetype
        result["layers"].append(layer_info)

    # Track spatial bounds
    min_x = min_y = min_z = float('inf')
    max_x = max_y = max_z = float('-inf')

    # Count entities by type
    type_counts = {}

    for entity in msp:
        etype = entity.dxftype()
        type_counts[etype] = type_counts.get(etype, 0) + 1

        # Extract text entities
        if etype in ('TEXT', 'MTEXT'):
            text = extract_text_from_entity(entity)
            if text:
                entry = {
                    "text": text,
                    "layer": entity.dxf.layer,
                }
                pos = get_position(entity)
                if pos:
                    entry["position"] = pos
                    min_x, min_y, min_z = min(min_x, pos[0]), min(min_y, pos[1]), min(min_z, pos[2])
                    max_x, max_y, max_z = max(max_x, pos[0]), max(max_y, pos[1]), max(max_z, pos[2])
                if hasattr(entity.dxf, 'height'):
                    entry["height"] = round(entity.dxf.height, 4)
                if hasattr(entity.dxf, 'rotation'):
                    entry["rotation"] = round(entity.dxf.rotation, 2)
                result["text_entities"].append(entry)

        # Extract dimensions
        elif etype == 'DIMENSION':
            dim = {"layer": entity.dxf.layer}
            try:
                if hasattr(entity.dxf, 'actual_measurement'):
                    dim["measurement"] = round(entity.dxf.actual_measurement, 4)
            except Exception:
                pass
            try:
                if hasattr(entity.dxf, 'text'):
                    dim["text_override"] = entity.dxf.text
            except Exception:
                pass
            result["dimensions"].append(dim)

        # Extract lines (sample — limit to first 500 for performance)
        elif etype == 'LINE' and len(result["lines"]) < 500:
            try:
                start = entity.dxf.start
                end = entity.dxf.end
                line_entry = {
                    "start": [round(start.x, 4), round(start.y, 4), round(getattr(start, 'z', 0), 4)],
                    "end": [round(end.x, 4), round(end.y, 4), round(getattr(end, 'z', 0), 4)],
                    "layer": entity.dxf.layer,
                }
                result["lines"].append(line_entry)
                for pt in [start, end]:
                    min_x, min_y = min(min_x, pt.x), min(min_y, pt.y)
                    max_x, max_y = max(max_x, pt.x), max(max_y, pt.y)
                    min_z = min(min_z, getattr(pt, 'z', 0))
                    max_z = max(max_z, getattr(pt, 'z', 0))
            except Exception:
                pass

        # Extract block references
        elif etype == 'INSERT':
            try:
                block_entry = {
                    "block_name": entity.dxf.name,
                    "layer": entity.dxf.layer,
                }
                pos = get_position(entity)
                if pos:
                    block_entry["position"] = pos
                if hasattr(entity.dxf, 'xscale'):
                    block_entry["scale"] = [
                        round(entity.dxf.xscale, 4),
                        round(entity.dxf.yscale, 4),
                        round(getattr(entity.dxf, 'zscale', 1), 4),
                    ]
                if hasattr(entity.dxf, 'rotation'):
                    block_entry["rotation"] = round(entity.dxf.rotation, 2)
                result["blocks"].append(block_entry)
            except Exception:
                pass

    result["entity_counts"] = type_counts

    # Set spatial bounds
    if min_x != float('inf'):
        result["spatial_bounds"] = {
            "min": [round(min_x, 4), round(min_y, 4), round(min_z, 4)],
            "max": [round(max_x, 4), round(max_y, 4), round(max_z, 4)],
        }

    # Write output
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, 'dxf-extraction.json')
    with open(output_path, 'w') as f:
        json.dump(result, f, indent=2)

    # Try to render layer PNGs using matplotlib
    try:
        render_layers(doc, output_dir)
    except Exception as e:
        result["render_note"] = f"Layer rendering skipped: {str(e)}"

    print(json.dumps({
        "success": True,
        "output": output_path,
        "layers": len(result["layers"]),
        "text_entities": len(result["text_entities"]),
        "dimensions": len(result["dimensions"]),
        "blocks": len(result["blocks"]),
        "lines": len(result["lines"]),
    }))


def render_layers(doc, output_dir):
    """Render the document to PNG using matplotlib backend."""
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        from ezdxf.addons.drawing import Frontend, RenderContext

        # Render full document
        fig = plt.figure(figsize=(16, 12), dpi=150)
        ax = fig.add_axes([0, 0, 1, 1])
        ctx = RenderContext(doc)
        out = Frontend(ctx, ax)
        out.draw_layout(doc.modelspace(), finalize=True)
        output_path = os.path.join(output_dir, 'dxf-render.png')
        fig.savefig(output_path, dpi=150, bbox_inches='tight')
        plt.close(fig)
    except ImportError:
        pass  # matplotlib not available
    except Exception:
        pass  # rendering failed, non-critical


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: lexios-dxf <filepath> [output_dir]"}))
        sys.exit(1)

    filepath = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else '/workspace/group/lexios-work'

    if not os.path.exists(filepath):
        print(json.dumps({"error": f"File not found: {filepath}"}))
        sys.exit(1)

    extract(filepath, output_dir)
