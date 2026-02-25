#!/bin/bash
# Extract frame from video/GIF for analysis
# Usage: extract-frame <video-file> [output.jpg] [timestamp]
# Examples:
#   extract-frame video.mp4                    # Extract frame at 1 second to /tmp/frame.jpg
#   extract-frame video.mp4 frame.jpg         # Extract to specific file
#   extract-frame video.mp4 frame.jpg 00:00:05 # Extract at 5 seconds

VIDEO_FILE="$1"
OUTPUT_FILE="${2:-/tmp/frame.jpg}"
TIMESTAMP="${3:-00:00:01}"

if [ -z "$VIDEO_FILE" ]; then
    echo "Usage: extract-frame <video-file> [output.jpg] [timestamp]"
    echo ""
    echo "Examples:"
    echo "  extract-frame video.mp4                    # Extract frame at 1 second"
    echo "  extract-frame video.mp4 frame.jpg          # Extract to specific file"
    echo "  extract-frame video.mp4 frame.jpg 00:00:05 # Extract at 5 seconds"
    exit 1
fi

if [ ! -f "$VIDEO_FILE" ]; then
    echo "Error: Video file not found: $VIDEO_FILE"
    exit 1
fi

# Extract single frame using ffmpeg
ffmpeg -ss "$TIMESTAMP" -i "$VIDEO_FILE" -vframes 1 -q:v 2 "$OUTPUT_FILE" -y 2>/dev/null

if [ $? -eq 0 ] && [ -f "$OUTPUT_FILE" ]; then
    echo "$OUTPUT_FILE"
else
    echo "Error: Failed to extract frame from video"
    exit 1
fi
