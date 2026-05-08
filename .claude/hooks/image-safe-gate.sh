#!/bin/bash
# Image Safe Gate — PreToolUse hook for Claude Code
# Prevents API "Could not process image" 400s by intercepting Read calls
# on oversized/unsafe images and redirecting to a normalized cached copy.
#
# Anthropic Vision API limits we enforce:
#   - longest edge <= 1568px (server downscales anyway; we do it locally)
#   - <= 1.15 megapixels
#   - <= 4.5 MB on disk
#   - aspect ratio between 1:200 and 200:1
#
# Behavior:
#   - Non-Read tools or non-image paths: allow (output {}).
#   - Image within limits: allow.
#   - Image over limits: ensure a normalized copy exists in the cache, then
#     deny the original Read with a permissionDecisionReason that names the
#     safe path. Claude retries against the safe path automatically.
#
# Cache: ~/.claude/cache/safe-images/<sha256-of-abspath-and-mtime>.png

set -euo pipefail

INPUT=$(cat)

RESULT=$(INPUT_JSON="$INPUT" python3 <<'PYEOF'
import json, os, sys, hashlib

raw = os.environ.get("INPUT_JSON", "")
try:
    data = json.loads(raw)
except Exception:
    print("{}")
    sys.exit(0)

tool = data.get("tool_name", "")
tin = data.get("tool_input", {}) or {}
path = tin.get("file_path", "")

# Only gate Read on real image files
IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif", ".bmp", ".tif", ".tiff"}
if tool != "Read" or not path:
    print("{}"); sys.exit(0)

ext = os.path.splitext(path)[1].lower()
if ext not in IMG_EXTS:
    print("{}"); sys.exit(0)

# File must exist; if not, let Read handle the error naturally.
if not os.path.isfile(path):
    print("{}"); sys.exit(0)

# Decide if it's risky without importing PIL up front (cheap pre-check).
size = os.path.getsize(path)
SIZE_LIMIT = 4_500_000   # 4.5 MB
EDGE_LIMIT = 1568
PIXEL_LIMIT = 1_150_000  # 1.15 MP
RATIO_LIMIT = 200.0

risky_by_size = size > SIZE_LIMIT

# Check dimensions. Use PIL if available; otherwise allow (fail-open is OK
# because the real backstop is API-side; we only handle the common case).
try:
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    with Image.open(path) as im:
        w, h = im.size
except Exception:
    # If we can't read it, let Read try; nothing useful we can do here.
    print("{}"); sys.exit(0)

longest = max(w, h)
shortest = max(min(w, h), 1)
pixels = w * h
ratio = longest / shortest

risky = (
    risky_by_size
    or longest > EDGE_LIMIT
    or pixels > PIXEL_LIMIT
    or ratio > RATIO_LIMIT
)

if not risky:
    print("{}"); sys.exit(0)

# Build a stable cache key from absolute path + mtime + size.
abspath = os.path.abspath(path)
try:
    mtime = int(os.path.getmtime(path))
except Exception:
    mtime = 0
key_src = f"{abspath}|{mtime}|{size}".encode()
key = hashlib.sha256(key_src).hexdigest()[:24]

cache_dir = os.path.expanduser("~/.claude/cache/safe-images")
os.makedirs(cache_dir, exist_ok=True)
safe_path = os.path.join(cache_dir, f"{key}.png")

if not os.path.exists(safe_path):
    try:
        with Image.open(path) as im:
            # Flatten to RGB on white if image has alpha or palette, to avoid
            # ICC/alpha quirks that sometimes trip the API.
            if im.mode in ("RGBA", "LA", "P"):
                im = im.convert("RGBA")
                bg = Image.new("RGB", im.size, (255, 255, 255))
                bg.paste(im, mask=im.split()[-1] if im.mode == "RGBA" else None)
                im = bg
            elif im.mode != "RGB":
                im = im.convert("RGB")

            # Downscale so the longest edge <= EDGE_LIMIT and pixels <= PIXEL_LIMIT.
            scale = 1.0
            if longest > EDGE_LIMIT:
                scale = EDGE_LIMIT / longest
            new_w = max(1, int(w * scale))
            new_h = max(1, int(h * scale))
            if new_w * new_h > PIXEL_LIMIT:
                scale2 = (PIXEL_LIMIT / (new_w * new_h)) ** 0.5
                new_w = max(1, int(new_w * scale2))
                new_h = max(1, int(new_h * scale2))
            if (new_w, new_h) != (w, h):
                im = im.resize((new_w, new_h), Image.LANCZOS)

            tmp = safe_path + ".tmp"
            im.save(tmp, format="PNG", optimize=True)
            os.replace(tmp, safe_path)
    except Exception as e:
        # If normalization fails, allow the original Read — the API may still
        # accept it, or fail with its own clearer error.
        sys.stderr.write(f"image-safe-gate: normalize failed for {path}: {e}\n")
        print("{}"); sys.exit(0)

reason = (
    f"Original image is too large for the vision API "
    f"({w}x{h}, {pixels/1_000_000:.1f}MP, {size/1_000_000:.1f}MB). "
    f"A safe normalized copy is at: {safe_path} — call Read on that path instead."
)

out = {
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }
}
print(json.dumps(out))
PYEOF
)

echo "$RESULT"
