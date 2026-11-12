#!/usr/bin/env bash
set -euo pipefail

# Restore one day of the NanoClaw R2 backup into a local folder and verify it.
# Usage: restore-day.sh DATE|latest DEST [NAME...]
#        restore-day.sh --old-style DATE DEST   (a day from before the switch, copied as is)
# DEST must not exist yet, or be an empty folder. r2_delta.py checks the arguments.
# R2_REMOTE defaults to the backup's own remote; set it to restore through another.

R2_REMOTE="${R2_REMOTE:-r2-backup-writeonly}"
R2_BUCKET="${R2_BUCKET:-nanoclaw-backup}"
export R2_REMOTE R2_BUCKET

if [ $# -lt 2 ]; then
    echo "usage: $0 DATE|latest DEST [NAME...]" >&2
    echo "       $0 --old-style DATE DEST" >&2
    exit 2
fi

if ! command -v rclone &>/dev/null; then
    echo "restore-day: rclone not installed (brew install rclone)" >&2
    exit 1
fi
if ! command -v python3 &>/dev/null; then
    echo "restore-day: python3 not found" >&2
    exit 1
fi
exec python3 "$(cd "$(dirname "$0")" && pwd)/r2_delta.py" restore "$@"
