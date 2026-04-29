#!/usr/bin/env python3
"""Fast local audio transcription using mlx-whisper (Apple Silicon native).

Usage: transcribe.py <audio_file> [--model turbo]
Output: transcription text to stdout

Models (auto-downloaded on first use):
  turbo  — mlx-community/whisper-turbo (fastest, good accuracy)
  large  — mlx-community/whisper-large-v3-mlx (best accuracy, slower)
  small  — mlx-community/whisper-small-mlx (lightest, fast)
"""

import sys
import os

def main():
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio_file> [--model turbo|large|small]", file=sys.stderr)
        sys.exit(1)

    audio_file = sys.argv[1]
    if not os.path.exists(audio_file):
        print(f"File not found: {audio_file}", file=sys.stderr)
        sys.exit(1)

    model_name = "turbo"
    if "--model" in sys.argv:
        idx = sys.argv.index("--model")
        if idx + 1 < len(sys.argv):
            model_name = sys.argv[idx + 1]

    models = {
        "turbo": "mlx-community/whisper-turbo",
        "large": "mlx-community/whisper-large-v3-mlx",
        "small": "mlx-community/whisper-small-mlx",
    }
    model_path = models.get(model_name, model_name)

    import mlx_whisper
    result = mlx_whisper.transcribe(
        audio_file,
        path_or_hf_repo=model_path,
    )
    print(result["text"].strip())

if __name__ == "__main__":
    main()
