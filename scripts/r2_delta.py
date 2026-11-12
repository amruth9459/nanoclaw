#!/usr/bin/env python3
# Delta uploads of NanoClaw backup sources to R2, plus restore planning.
# Called by backup.sh and restore-day.sh. rclone is only ever run with the verbs
# copy, copyto, lsjson and lsf, so nothing here removes a remote object.

import calendar
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zlib

DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")
STAMP_RE = re.compile(r"^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$")
# Restore names at most this many missing files; its summary line counts all of them.
MAX_FAILED_LINES = 20
# 3 runs in a row = 45 min at the 900 s launchd interval.
MOVED_RUNS_ERROR = 3


def log(msg):
    line = "[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    path = os.environ.get("LOG_FILE")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)
    else:
        sys.stderr.write(line)


def rclone(args, capture=False):
    path = os.environ.get("LOG_FILE")
    errf = open(path, "ab") if path else None
    try:
        p = subprocess.run(["rclone"] + args,
                           stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                           stderr=errf)
    finally:
        if errf:
            errf.close()
    return p.returncode, p.stdout


def odd(path):
    return "\r" in path or "\n" in path


def shown(path):
    return json.dumps(path) if odd(path) else path


def remote_base():
    return "%s:%s" % (os.environ.get("R2_REMOTE", "r2-backup-writeonly"),
                      os.environ.get("R2_BUCKET", "nanoclaw-backup"))


def config():
    date = os.environ.get("BACKUP_DATE", "")
    state = os.environ.get("BACKUP_STATE_DIR", "")
    if not DATE_RE.match(date) or not state:
        sys.exit("r2_delta: BACKUP_DATE and BACKUP_STATE_DIR must be set")
    return {"date": date, "state": state}


def source_name(suffix):
    return (suffix[:-1] if suffix.endswith("/") else suffix).replace("/", "_")


def json_line(obj):
    return json.dumps(obj, separators=(",", ":")) + "\n"


def write_atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def entry_line(path, entry):
    size, key, day = entry
    obj = {"p": path, "s": size, "k": key}
    if day is not None:
        obj["d"] = day
    return json_line(obj)


def load_manifest(mode, suffix, path, with_day):
    entries = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                e = json.loads(line)
                p, s, k, d = e["p"], e["s"], e["k"], e.get("d")
                if not isinstance(p, str) or type(s) is not int or not isinstance(k, str):
                    raise ValueError("bad entry")
                if with_day and not (isinstance(d, str) and DATE_RE.match(d)):
                    raise ValueError("bad day")
                entries[p] = (s, k, d if with_day else None)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError, KeyError, TypeError):
        log("WARN: %s %s: manifest unreadable, starting fresh" % (mode, suffix))
        return {}
    return entries


def item_key(it, keymode):
    # rclone prints ModTime in the local zone; keys keep it in UTC so a change
    # of zone does not make every file look new.
    stamp = it["ModTime"]
    m = STAMP_RE.match(stamp)
    if m:
        y, mo, d, h, mi, s, frac, zone = m.groups()
        secs = calendar.timegm((int(y), int(mo), int(d), int(h), int(mi), int(s)))
        if zone != "Z":
            offset = int(zone[1:3]) * 3600 + int(zone[4:6]) * 60
            secs -= offset if zone[0] == "+" else -offset
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(secs)) + ".%sZ" % (frac or "").ljust(9, "0")
    if keymode == "md5":
        return (it.get("Hashes") or {}).get("md5") or "m:" + stamp
    return stamp


def lsjson_args(keymode, recurse=True):
    args = ["lsjson"] + (["-R"] if recurse else []) + ["--files-only", "--no-mimetype"]
    if keymode == "md5":
        args += ["--hash", "--hash-type", "md5"]
    return args


def list_source(src, keymode, filters):
    rc, out = rclone(lsjson_args(keymode) + filters + [src], capture=True)
    try:
        items = json.loads(out)
    except ValueError:
        return {}, False, rc
    listed = {}
    for it in items:
        if it.get("IsDir"):
            continue
        listed[it["Path"]] = (it["Size"], item_key(it, keymode))
    return listed, rc == 0, rc


def same_version(it, entry, keymode):
    # Size alone is not enough: latest/ (and a retry under snapshots/) already
    # holds the previous version, which often has the same size. Mtimes compare
    # exactly: `rclone backend features` gives 1 ns precision for both the local
    # and the s3 backend.
    return it is not None and (it["Size"], item_key(it, keymode)) == entry


def write_lines(path, lines):
    with open(path, "wb") as f:
        for line in lines:
            f.write(line.encode("utf-8") + b"\n")


def current_keys(args):
    rc, out = rclone(args, capture=True)
    try:
        items = json.loads(out)
    except ValueError:
        return {}
    return {i["Path"]: i for i in items if not i.get("IsDir")}


def upload(src, dest, changed, listed, keymode, tmpdir):
    confirmed = set()
    normal = sorted(p for p in changed if not odd(p))
    if normal:
        listfile = os.path.join(tmpdir, "files")
        write_lines(listfile, normal)
        # Same --transfers and --checkers as ~/nanoclaw/scripts/backup.sh. With
        # --no-traverse nothing lists the bucket first, so without
        # --s3-no-check-bucket rclone asks R2 to create it, and the backup key may not.
        rc, _ = rclone(["copy", src, dest, "--files-from-raw", listfile, "--no-traverse",
                        "--no-check-dest", "--s3-no-check-bucket", "--retries", "1",
                        "--transfers", "8", "--checkers", "16", "--quiet"])
        if rc == 0:
            confirmed.update(normal)
        else:
            # -R matters: without it rclone drops every nested path from a
            # --files-from-raw listing.
            there = current_keys(lsjson_args(keymode) + ["--files-from-raw", listfile,
                                                         "--no-traverse", dest])
            confirmed.update(p for p in normal if same_version(there.get(p), listed[p], keymode))
    for p in sorted(p for p in changed if odd(p)):
        one_src = src.rstrip("/") + "/" + p
        one_dest = dest.rstrip("/") + "/" + p
        rc, _ = rclone(["copyto", one_src, one_dest, "--s3-no-check-bucket", "--retries", "1"])
        if rc == 0:
            confirmed.add(p)
            continue
        there = list(current_keys(lsjson_args(keymode, False) + [one_dest]).values())
        if len(there) == 1 and same_version(there[0], listed[p], keymode):
            confirmed.add(p)

    # Files under store/ and data/ are written by live processes: a path whose
    # key moved while it uploaded may hold either version at the destination.
    moved = set()
    again = sorted(p for p in confirmed if not odd(p))
    if again:
        listfile = os.path.join(tmpdir, "relist")
        write_lines(listfile, again)
        now = current_keys(lsjson_args(keymode) + ["--files-from-raw", listfile,
                                                   "--no-traverse", src])
        moved.update(p for p in again if not same_version(now.get(p), listed[p], keymode))
    for p in sorted(p for p in confirmed if odd(p)):
        now = list(current_keys(lsjson_args(keymode, False) + [src.rstrip("/") + "/" + p]).values())
        if len(now) != 1 or not same_version(now[0], listed[p], keymode):
            moved.add(p)
    return confirmed - moved, moved


def plan(listed, prev):
    changed = {}
    for p, (size, key) in listed.items():
        old = prev.get(p)
        if old is not None and old[0] == size and old[1] == key:
            continue
        changed[p] = size
    return changed


def report(cfg, mode, suffix, name, listed, changed, confirmed, moved, stats):
    # A file rewritten faster than it uploads never lands: count its runs in a row.
    counter = os.path.join(cfg["state"], "moved", "%s-%s.json" % (mode, name))
    try:
        with open(counter, encoding="utf-8") as f:
            before = json.load(f)
        if not isinstance(before, dict) or not all(type(v) is int for v in before.values()):
            before = {}
    except (OSError, ValueError):
        before = {}
    runs = {p: before.get(p, 0) + 1 for p in moved}
    if runs != before:
        write_atomic(counter, json.dumps(runs).encode("utf-8"))
    stuck = sorted(p for p in moved if runs[p] >= MOVED_RUNS_ERROR)

    for p in sorted(moved):
        if runs[p] < MOVED_RUNS_ERROR:
            log("WARN: %s %s: changed during upload, retry next run %s" % (mode, suffix, shown(p)))
    failed = sorted(p for p in changed if p not in confirmed and p not in moved)
    nbytes = sum(changed[p] for p in confirmed)
    log("%s %s: listed %d, changed %d, uploaded %d, failed %d, bytes %d"
        % (mode, suffix, len(listed), len(changed), len(confirmed), len(failed) + len(stuck), nbytes))
    lines = ["changed during upload on %d runs in a row, never landed %s" % (runs[p], shown(p))
             for p in stuck]
    lines += ["failed %s" % shown(p) for p in failed]
    for line in lines[:MAX_FAILED_LINES]:
        log("ERROR: %s %s: %s" % (mode, suffix, line))
    if len(lines) > MAX_FAILED_LINES:
        log("ERROR: %s %s: and %d more failed" % (mode, suffix, len(lines) - MAX_FAILED_LINES))
    stats["files"] += len(confirmed)
    stats["bytes"] += nbytes
    if lines:
        stats["errors"] += 1


def run_latest(cfg, src, suffix, name, keymode, listed, tmpdir, stats):
    path = os.path.join(cfg["state"], "latest", name + ".jsonl")
    prev = load_manifest("latest", suffix, path, False)
    changed = plan(listed, prev)
    confirmed, moved = set(), set()
    if changed:
        dest = "%s/latest/%s" % (remote_base(), suffix)
        confirmed, moved = upload(src, dest, changed, listed, keymode, tmpdir)
    if confirmed:
        new = dict(prev)
        for p in confirmed:
            new[p] = (listed[p][0], listed[p][1], None)
        write_atomic(path, "".join(entry_line(p, new[p]) for p in sorted(new)).encode("utf-8"))
    report(cfg, "latest", suffix, name, listed, changed, confirmed, moved, stats)


def run_snap(cfg, src, suffix, name, keymode, listed, complete, tmpdir, stats):
    date = cfg["date"]
    datefile = os.path.join(cfg["state"], "snap", name + ".date")
    try:
        with open(datefile, encoding="utf-8") as f:
            last = f.read().strip()
    except OSError:
        last = None
    if last is not None and not DATE_RE.match(last):
        log("WARN: snap %s: date file unreadable, treating as no snapshot yet" % suffix)
        last = None
    if last == date:
        return
    if last is not None and last > date:
        log("ERROR: snap %s: last snapshot %s is newer than %s, skipped" % (suffix, last, date))
        stats["errors"] += 1
        return
    path = os.path.join(cfg["state"], "snap", name + ".jsonl")
    prev = load_manifest("snap", suffix, path, True)
    # A path uploaded today stays as is until tomorrow: a day manifest on the
    # remote may already name that copy.
    changed = {p: s for p, s in plan(listed, prev).items() if p not in prev or prev[p][2] != date}
    confirmed, moved = set(), set()
    if changed:
        dest = "%s/snapshots/%s/%s" % (remote_base(), date, suffix)
        confirmed, moved = upload(src, dest, changed, listed, keymode, tmpdir)
    new = {}
    for p, (size, key) in listed.items():
        if p in confirmed:
            new[p] = (size, key, date)
        elif p in prev:
            new[p] = prev[p]
    if not complete:
        for p, v in prev.items():
            new.setdefault(p, v)
    report(cfg, "snap", suffix, name, listed, changed, confirmed, moved, stats)
    closed = complete and confirmed == set(changed)

    # finish sends the queued manifest. It is queued before the state below, so
    # a crash never leaves state naming a manifest that nobody will send.
    if confirmed or closed:
        box = os.path.join(cfg["state"], "outbox", date)
        os.makedirs(box, mode=0o700, exist_ok=True)
        header = {"v": 1, "source": name, "suffix": suffix, "date": date, "keymode": keymode,
                  "files": len(new), "bytes": sum(e[0] for e in new.values())}
        body = json_line(header) + "".join(json_line({"p": p, "s": s, "k": k, "d": d})
                                           for p, (s, k, d) in sorted(new.items()))
        write_atomic(os.path.join(box, name + ".jsonl.gz"),
                     gzip.compress(body.encode("utf-8"), mtime=0))
    if new != prev:
        write_atomic(path, "".join(entry_line(p, new[p]) for p in sorted(new)).encode("utf-8"))
    if closed:
        write_atomic(datefile, (date + "\n").encode("utf-8"))


def run_source(src, suffix, keymode, filters):
    cfg = config()
    if keymode not in ("md5", "mtime"):
        sys.exit("r2_delta: keymode must be md5 or mtime")
    name = source_name(suffix)
    for sub in ("latest", "snap", "tmp", "moved"):
        os.makedirs(os.path.join(cfg["state"], sub), mode=0o700, exist_ok=True)
    stats = {"files": 0, "bytes": 0, "errors": 0}
    tmpdir = tempfile.mkdtemp(dir=os.path.join(cfg["state"], "tmp"))
    try:
        listed, complete, rc = list_source(src, keymode, filters)
        if not complete:
            log("ERROR: %s listing incomplete (rclone exit %d)" % (suffix, rc))
            stats["errors"] += 1
        run_latest(cfg, src, suffix, name, keymode, listed, tmpdir, stats)
        run_snap(cfg, src, suffix, name, keymode, listed, complete, tmpdir, stats)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    print("%d %d %d" % (stats["files"], stats["bytes"], stats["errors"]))


def read_sources(path):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    names = d["names"]
    if type(d["v"]) is not int or d["v"] != 1 or not DATE_RE.match(d["date"]) \
            or not isinstance(names, list) \
            or not all(isinstance(n, str) for n in names):
        raise ValueError("bad sources list")
    return d["date"], names


def finish(suffixes):
    cfg = config()
    date, state = cfg["date"], cfg["state"]
    errors = 0
    owner = {}
    for s in suffixes:
        n = source_name(s)
        if n in owner and owner[n] != s:
            log("ERROR: sources %s and %s share the state name %s" % (owner[n], s, n))
            errors += 1
        else:
            owner[n] = s
    index = os.path.join(state, "sources.json")
    try:
        last, known = read_sources(index)
    except (OSError, ValueError, KeyError, TypeError):
        last, known = None, []
    if last is not None and last > date:
        log("ERROR: sources list is dated %s, later than %s, not written" % (last, date))
        errors += 1
    else:
        if last != date:
            known = []
        names = sorted(set(known) | set(owner))
        if names and (last != date or names != sorted(known)):
            box = os.path.join(state, "outbox", date)
            os.makedirs(box, mode=0o700, exist_ok=True)
            body = json.dumps({"v": 1, "date": date, "names": names}).encode("utf-8")
            write_atomic(os.path.join(box, "sources.json"), body)
            write_atomic(index, body)

    outbox = os.path.join(state, "outbox")
    days = sorted(d for d in os.listdir(outbox) if DATE_RE.match(d)) if os.path.isdir(outbox) else []
    os.makedirs(os.path.join(state, "tmp"), mode=0o700, exist_ok=True)
    tmpdir = tempfile.mkdtemp(dir=os.path.join(state, "tmp"))
    try:
        for day in days:
            box = os.path.join(outbox, day)
            files = sorted(f for f in os.listdir(box)
                           if f.endswith(".jsonl.gz") or f == "sources.json")
            if files:
                listfile = os.path.join(tmpdir, "send")
                write_lines(listfile, files)
                rc, _ = rclone(["copy", box, "%s/manifests/%s/" % (remote_base(), day),
                                "--files-from-raw", listfile, "--no-traverse", "--no-check-dest",
                                "--s3-no-check-bucket"])
                if rc != 0:
                    log("ERROR: manifests for %s not sent (rclone exit %d), kept for the next run"
                        % (day, rc))
                    errors += 1
                    continue
                for f in files:
                    os.unlink(os.path.join(box, f))
            if not os.listdir(box):
                os.rmdir(box)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    sys.exit(1 if errors else 0)


class Refused(Exception):
    pass


def bad_path(p):
    # An empty segment also catches a leading /.
    return not p or "\0" in p or any(seg in ("", ".", "..") for seg in p.split("/"))


def parse_day_manifest(path, date):
    with gzip.open(path, "rb") as f:
        lines = f.read().decode("utf-8").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if not lines:
        raise Refused("empty manifest")
    try:
        header = json.loads(lines[0])
        suffix, keymode = header["suffix"], header["keymode"]
        if type(header["v"]) is not int or header["v"] != 1 or not isinstance(suffix, str) \
                or keymode not in ("md5", "mtime"):
            raise ValueError("bad header")
    except (ValueError, KeyError, TypeError):
        raise Refused("bad header")
    stem = os.path.basename(path)[:-len(".jsonl.gz")]
    if header.get("source") != stem or header.get("date") != date:
        raise Refused("header says source %s, day %s; the file is %s in %s"
                      % (json.dumps(header.get("source")), json.dumps(header.get("date")),
                         json.dumps(stem), date))
    if bad_path(suffix.rstrip("/")):
        raise Refused("suffix %s is not a safe relative path" % json.dumps(suffix))
    entries = []
    seen = set()
    for line in lines[1:]:
        try:
            e = json.loads(line)
            p, s, k, d = e["p"], e["s"], e["k"], e["d"]
            if not isinstance(p, str) or type(s) is not int or s < 0 or not isinstance(k, str) \
                    or not isinstance(d, str) or not DATE_RE.match(d):
                raise ValueError("bad entry")
        except (ValueError, KeyError, TypeError):
            raise Refused("bad entry line")
        if bad_path(p):
            raise Refused("path %s is not a safe relative path" % json.dumps(p))
        if d > date:
            raise Refused("entry %s points at %s, later than %s" % (json.dumps(p), d, date))
        if p in seen:
            raise Refused("path %s is listed twice" % json.dumps(p))
        seen.add(p)
        entries.append((p, s, k, d))
    # A manifest cut short still parses; its header says how much it held.
    files, nbytes = header.get("files"), header.get("bytes")
    held = sum(e[1] for e in entries)
    if type(files) is not int or type(nbytes) is not int or files != len(entries) or nbytes != held:
        raise Refused("header says %r files, %r bytes; found %d, %d"
                      % (files, nbytes, len(entries), held))
    return suffix.rstrip("/"), keymode, entries


def refuse_taken(dest):
    # Files already in DEST would be counted as restored.
    try:
        taken = os.path.lexists(dest) and bool(os.listdir(dest))
    except OSError:
        taken = True
    if taken:
        sys.stderr.write("restore: DEST exists and is not an empty folder\n")
        sys.exit(2)
    # Found now, not after the manifests are fetched: DEST would be inside a file.
    up = os.path.dirname(dest)
    while not os.path.lexists(up):
        up = os.path.dirname(up)
    if not os.path.isdir(up):
        sys.stderr.write("restore: %s is not a folder\n" % up)
        sys.exit(2)


def restore_old_style(date, dest):
    refuse_taken(dest)
    base = remote_base()
    mdir = "%s/manifests/%s/" % (base, date)
    rc, out = rclone(["lsf", mdir], capture=True)
    if rc not in (0, 3):
        sys.exit("restore: could not list %s (rclone exit %d)" % (mdir, rc))
    if out.strip():
        sys.stderr.write("restore: %s has day manifests; restore it without --old-style\n" % date)
        sys.exit(2)
    sdir = "%s/snapshots/%s/" % (base, date)
    rc, out = rclone(["lsf", sdir], capture=True)
    if rc not in (0, 3) or not out.strip():
        sys.exit("restore: nothing found for %s" % date)
    rc, _ = rclone(["copy", sdir, dest])
    if rc != 0:
        sys.exit("restore: copy of snapshots/%s/ failed (rclone exit %d)" % (date, rc))
    print("copied snapshots/%s/ as is, unverified; it is a whole day only if from before "
          "the switch" % date)


def restore(date, dest, names):
    refuse_taken(dest)
    base = remote_base()
    if date == "latest":
        if names:
            sys.stderr.write("restore: NAME cannot be used with latest\n")
            sys.exit(2)
        rc, _ = rclone(["copy", base + "/latest/", dest])
        if rc != 0:
            sys.exit("restore: copy of latest/ failed (rclone exit %d)" % rc)
        print("copied latest/ as is (no manifest to verify against)")
        sys.exit(0)

    mdir = "%s/manifests/%s/" % (base, date)
    rc, out = rclone(["lsf", "--files-only", mdir], capture=True)
    # rclone exits 3 when the folder is not there (rclone docs, "Exit Code").
    if rc not in (0, 3):
        sys.exit("restore: could not list %s (rclone exit %d)" % (mdir, rc))
    in_day = out.decode("utf-8").splitlines()
    found = set(l for l in in_day if l.endswith(".jsonl.gz"))
    indexed = "sources.json" in in_day
    # Without manifests the day folder cannot be told apart from a changes-only one, so
    # copying it as is takes --old-style.
    if not found and not indexed:
        sys.exit("restore: no day manifests for %s: the backup did not run that day, or its "
                 "manifests are still queued on the backup machine. For a day from before the "
                 "switch, rerun with --old-style." % date)
    wanted = sorted(set(n + ".jsonl.gz" for n in names)) if names else sorted(found)
    for w in wanted:
        if w not in found:
            sys.exit("restore: no day manifest %s for %s" % (w, date))

    work = tempfile.mkdtemp()
    try:
        listfile = os.path.join(work, "wanted")
        write_lines(listfile, wanted + (["sources.json"] if indexed else []))
        rc, _ = rclone(["copy", mdir, work, "--files-from-raw", listfile, "--no-traverse"])
        if rc != 0:
            sys.exit("restore: could not fetch manifests (rclone exit %d)" % rc)
        parsed = []
        for w in wanted:
            try:
                parsed.append(parse_day_manifest(os.path.join(work, w), date))
            except (Refused, OSError, UnicodeDecodeError, EOFError, zlib.error) as e:
                sys.stderr.write("refused: %s: %s\n" % (w, e))
                sys.exit(2)
        sources = None
        if indexed:
            try:
                sdate, sources = read_sources(os.path.join(work, "sources.json"))
                if sdate != date or not sources:
                    raise ValueError("dated %s, %d names" % (sdate, len(sources)))
            except (OSError, ValueError, KeyError, TypeError) as e:
                sys.stderr.write("refused: sources.json: bad sources list (%s)\n" % e)
                sys.exit(2)

        os.makedirs(dest, exist_ok=True)
        for suffix, keymode, entries in parsed:
            by_day = {}
            for p, s, k, d in entries:
                by_day.setdefault(d, []).append(p)
            for d in sorted(by_day):
                src = "%s/snapshots/%s/%s" % (base, d, suffix)
                target = os.path.join(dest, suffix)
                normal = sorted(p for p in by_day[d] if not odd(p))
                if normal:
                    write_lines(listfile, normal)
                    rclone(["copy", src, target, "--files-from-raw", listfile, "--no-traverse"])
                for p in sorted(p for p in by_day[d] if odd(p)):
                    rclone(["copyto", src + "/" + p, target + "/" + p])

        # rclone lists the folder, so names match the manifest even where
        # rclone encodes control characters in file names.
        good = nbytes = bad = 0
        for suffix, keymode, entries in parsed:
            target = os.path.join(dest, suffix)
            there = current_keys(lsjson_args(keymode) + [target]) if os.path.isdir(target) else {}
            for p, s, k, d in entries:
                if same_version(there.get(p), (s, k), keymode):
                    good += 1
                    nbytes += s
                else:
                    bad += 1
                    if bad <= MAX_FAILED_LINES:
                        sys.stderr.write("missing or different: %s/%s\n" % (suffix, shown(p)))
        print("restored %d files, %d bytes, %d missing or different" % (good, nbytes, bad))
        incomplete = False
        if not names:
            if sources is None:
                sys.stderr.write("restore: no list of sources for %s, so a missing source "
                                 "would go unseen\n" % date)
                incomplete = True
            for n in sources or []:
                if n + ".jsonl.gz" not in found:
                    sys.stderr.write("restore: no day manifest for %s\n" % n)
                    incomplete = True
        sys.exit(1 if bad or incomplete else 0)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(argv):
    if len(argv) >= 5 and argv[1] == "push":
        run_source(argv[2], argv[3], argv[4], argv[5:])
    elif len(argv) >= 2 and argv[1] == "finish":
        finish(argv[2:])
    elif len(argv) >= 5 and argv[1:3] == ["restore", "--old-style"]:
        if len(argv) != 5 or not DATE_RE.match(argv[3]) or argv[4][:1] in ("", "-"):
            sys.stderr.write("restore: --old-style takes one DATE (YYYY-MM-DD) and DEST\n")
            sys.exit(2)
        # rclone reads name:path as a remote; an absolute path is always local.
        restore_old_style(argv[3], os.path.abspath(argv[4]))
    elif len(argv) >= 4 and argv[1] == "restore" and argv[2] != "--old-style":
        if argv[2] != "latest" and not DATE_RE.match(argv[2]):
            sys.stderr.write("restore: DATE must look like YYYY-MM-DD, or be latest\n")
            sys.exit(2)
        if any(a[:1] in ("", "-") for a in argv[3:]):
            sys.stderr.write("restore: DEST and NAME cannot be empty or start with -; "
                             "--old-style goes before DATE\n")
            sys.exit(2)
        restore(argv[2], os.path.abspath(argv[3]), argv[4:])
    else:
        sys.stderr.write("usage: r2_delta.py push SRC SUFFIX KEYMODE [FILTERS...]\n"
                         "       r2_delta.py finish [SUFFIX...]\n"
                         "       r2_delta.py restore DATE|latest DEST [NAME...]\n"
                         "       r2_delta.py restore --old-style DATE DEST\n")
        sys.exit(2)


if __name__ == "__main__":
    main(sys.argv)
