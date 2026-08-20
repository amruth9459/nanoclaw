"""
Extract auto-generated transcripts from PVR Narasimha Rao's YouTube videos.
Uses yt-dlp to download subtitles, then chunks for RAG indexing.

Channels/playlists:
- @pvr108 main channel
- Boston class playlists (209 lessons)
"""
import os
import sys
import json
import subprocess
import re
from pathlib import Path

OUTPUT_DIR = os.path.expanduser("~/nanoclaw/groups/main/output/jyotish")
TRANSCRIPT_DIR = os.path.expanduser("~/nanoclaw/data/jyotish-knowledge/pvr-youtube")
VENV_BIN = os.path.expanduser("~/nanoclaw/services/jyotish/.venv/bin")
YT_DLP = os.path.join(VENV_BIN, "yt-dlp")

# PVR's playlists
PLAYLISTS = [
    # Boston Vedic Astrology Lessons 1-100
    ("boston-lessons-1-100", "https://www.youtube.com/playlist?list=PL8yOO2xYRcZt_P1ah4p2DJEOyEOVFJ3Bg"),
]

# Individual important videos from @pvr108 channel
CHANNEL_URL = "https://www.youtube.com/@pvr108/videos"


def get_playlist_videos(playlist_url):
    """Get video IDs and titles from a playlist using yt-dlp."""
    try:
        result = subprocess.run(
            [YT_DLP, "--flat-playlist", "--print", "%(id)s\t%(title)s", playlist_url],
            capture_output=True, text=True, timeout=120
        )
        videos = []
        for line in result.stdout.strip().split("\n"):
            if "\t" in line:
                vid_id, title = line.split("\t", 1)
                videos.append((vid_id, title))
        return videos
    except Exception as e:
        print(f"  Error listing playlist: {e}")
        return []


def get_channel_videos(channel_url, max_videos=200):
    """Get video IDs from a channel."""
    try:
        result = subprocess.run(
            [YT_DLP, "--flat-playlist", "--print", "%(id)s\t%(title)s",
             "--playlist-end", str(max_videos), channel_url],
            capture_output=True, text=True, timeout=180
        )
        videos = []
        for line in result.stdout.strip().split("\n"):
            if "\t" in line:
                vid_id, title = line.split("\t", 1)
                videos.append((vid_id, title))
        return videos
    except Exception as e:
        print(f"  Error listing channel: {e}")
        return []


def download_transcript(video_id, output_path):
    """Download auto-generated English transcript for a video."""
    if os.path.exists(output_path):
        return True

    try:
        # Try auto-generated English subs first, then any available
        result = subprocess.run(
            [YT_DLP,
             "--write-auto-subs", "--sub-langs", "en",
             "--skip-download",
             "--sub-format", "vtt",
             "-o", output_path.replace(".vtt", ""),
             f"https://www.youtube.com/watch?v={video_id}"],
            capture_output=True, text=True, timeout=60
        )
        # Check if VTT file was created
        vtt_path = output_path.replace(".vtt", ".en.vtt")
        if os.path.exists(vtt_path):
            os.rename(vtt_path, output_path)
            return True
        # Try alternate naming
        for f in Path(os.path.dirname(output_path)).glob(f"*{video_id}*.vtt"):
            os.rename(str(f), output_path)
            return True
        return False
    except Exception as e:
        print(f"    Transcript error: {e}")
        return False


def parse_vtt(vtt_path):
    """Parse VTT subtitle file to plain text, deduplicating repeated lines."""
    with open(vtt_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Remove VTT headers and timestamps
    lines = content.split("\n")
    text_lines = []
    seen = set()

    for line in lines:
        line = line.strip()
        # Skip headers, timestamps, empty lines
        if not line or line.startswith("WEBVTT") or line.startswith("Kind:") or \
           line.startswith("Language:") or re.match(r"^\d{2}:\d{2}", line) or \
           re.match(r"^[\d\-:\.> ]+$", line):
            continue
        # Strip HTML tags
        clean = re.sub(r'<[^>]+>', '', line).strip()
        if clean and clean not in seen:
            seen.add(clean)
            text_lines.append(clean)

    return " ".join(text_lines)


def chunk_transcript(text, source_name, max_chunk=3000):
    """Chunk transcript text with overlap for context."""
    chunks = []
    words = text.split()
    chunk_words = max_chunk // 5  # ~5 chars per word
    overlap = chunk_words // 10  # 10% overlap

    i = 0
    chunk_idx = 0
    while i < len(words):
        end = min(i + chunk_words, len(words))
        chunk_text = " ".join(words[i:end])
        title = f"{source_name} - Part {chunk_idx + 1}"
        chunks.append((title, chunk_text))
        chunk_idx += 1
        i = end - overlap if end < len(words) else end

    return chunks


def main():
    os.makedirs(TRANSCRIPT_DIR, exist_ok=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    total_chunks = 0
    total_videos = 0

    # Process playlists
    for playlist_name, playlist_url in PLAYLISTS:
        print(f"\nPlaylist: {playlist_name}")
        videos = get_playlist_videos(playlist_url)
        print(f"  Found {len(videos)} videos")

        for vid_id, title in videos:
            safe_title = re.sub(r'[^\w\-]', '_', title)[:80]
            vtt_path = os.path.join(TRANSCRIPT_DIR, f"{playlist_name}_{vid_id}.vtt")

            print(f"  [{vid_id}] {title[:60]}...", end=" ", flush=True)

            if download_transcript(vid_id, vtt_path):
                text = parse_vtt(vtt_path)
                if len(text) > 200:
                    source = f"PVR {playlist_name.replace('-', ' ').title()} - {title}"
                    chunks = chunk_transcript(text, source)
                    for i, (ctitle, content) in enumerate(chunks):
                        chunk_path = os.path.join(
                            OUTPUT_DIR,
                            f"pvr-yt-{playlist_name}-{vid_id}-chunk-{i:03d}.txt"
                        )
                        with open(chunk_path, "w") as f:
                            f.write(f"# {ctitle}\n\n{content}")
                    total_chunks += len(chunks)
                    total_videos += 1
                    print(f"OK ({len(text)} chars, {len(chunks)} chunks)")
                else:
                    print("SKIP (too short)")
            else:
                print("NO SUBS")

    # Process main channel
    print(f"\nChannel: @pvr108")
    channel_videos = get_channel_videos(CHANNEL_URL)
    print(f"  Found {len(channel_videos)} videos")

    # Filter to jyotish-related videos (skip non-astrology content)
    jyotish_keywords = ['astrology', 'jyotish', 'dasha', 'chart', 'horoscope', 'planetary',
                        'divisional', 'varga', 'transit', 'yoga', 'karana', 'navamsa',
                        'prediction', 'remedial', 'graha', 'rashi', 'nakshatra', 'muhurtha',
                        'tithi', 'karaka', 'arudha', 'annual', 'tajaka', 'saham', 'lagna',
                        'bhava', 'house', 'lesson', 'masterclass', 'technique']

    for vid_id, title in channel_videos:
        title_lower = title.lower()
        # Include all videos (PVR's channel is astrology-focused)
        vtt_path = os.path.join(TRANSCRIPT_DIR, f"pvr108_{vid_id}.vtt")

        print(f"  [{vid_id}] {title[:60]}...", end=" ", flush=True)

        if download_transcript(vid_id, vtt_path):
            text = parse_vtt(vtt_path)
            if len(text) > 200:
                source = f"PVR YouTube - {title}"
                chunks = chunk_transcript(text, source)
                for i, (ctitle, content) in enumerate(chunks):
                    chunk_path = os.path.join(
                        OUTPUT_DIR,
                        f"pvr-yt-pvr108-{vid_id}-chunk-{i:03d}.txt"
                    )
                    with open(chunk_path, "w") as f:
                        f.write(f"# {ctitle}\n\n{content}")
                total_chunks += len(chunks)
                total_videos += 1
                print(f"OK ({len(text)} chars, {len(chunks)} chunks)")
            else:
                print("SKIP (too short)")
        else:
            print("NO SUBS")

    print(f"\n{'='*60}")
    print(f"Done. {total_videos} videos transcribed, {total_chunks} chunks created")
    print(f"Transcripts: {TRANSCRIPT_DIR}")
    print(f"Chunks: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
