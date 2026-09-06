# AR-001 round 1

## Summary
The slug now carries the source file's whole path inside the raw root, behind a new
`lib.target_paths()` seam that `compile_file` calls, and `scripts/migrate_wiki_slugs.py`
renames an existing wiki onto those ids. Verified: gate exits 0, METRIC 0 (was -1338).

## What changed
- `services/wiki_compile/lib.py`: added `slug_for(file_key)` (joins the normalised path
  components with `__`, falls back to a sha1 digest when a component already contains the
  separator or the name would exceed 120 chars) and `target_paths(domain, file_path)`,
  which returns `(compiled/<category>/<slug>.md, .wiki_meta/<slug>.json)` and does no I/O
  (the gate calls it 3,406 times against the *live* wiki's domain, so it must not mkdir).
  `compile_file` calls the seam instead of building the slug inline, and records
  `metadata["title"]` (the source stem) because the id is no longer a human title.
  `generate_index` prefers that title and otherwise takes the last slug component.
  The namespace stays flat on purpose: `scripts/brain-digest.py` and `scripts/brain-themes.py`
  both do `META_DIR.glob("*.json")` and key on `id`, and a file directly in the raw root
  keeps its old slug, which is why the 14 Jyotish ids do not move.
- `services/wiki_compile/test_wiki_compile.py`: two existing tests asserted the literal
  compiled path `zettelkasten/20260622_hooks.md`, which is exactly the name this problem
  renames, so the literal (only) became `zettelkasten/zettelkasten__20260622_hooks.md`;
  each test's intent is unchanged. Added `test_same_stem_in_two_folders_keeps_two_articles`
  (the defect: two `skill.md` in different folders shared one meta) and
  `test_target_paths_is_pure` (the seam must not create the wiki dir).
- `scripts/migrate_wiki_slugs.py`: new. Builds the whole old->new plan first with a global
  `taken` set, renames articles through temp names in two phases, rewrites each meta with
  `created`/`version`/`confidence` preserved, splits a merged meta across the articles that
  exist for it (each article takes the source whose category matches its folder), rewrites
  `compiled/index.md` link targets, and deletes `.compile_state.json` so the next compile
  rewrites every article. `--dry-run` writes nothing; a second run is a no-op.
- `services/wiki_compile/lib.py` (`build_knowledge_graph`): an entity's `sources` recorded
  `raw_file.name` and were then `set()`ed, which is the same flat namespace one layer over
  (78 files called SKILL.md collapsed to one source). Now records the path relative to the
  raw root. Its only consumer, `scripts/brain-disambiguate.py:190`, uses `sources[0]` as a
  display string in a prompt, so a longer string is safe (read-verified, not run).
- `scripts/brain-digest.py`: it emitted `[[slug]]` as an Obsidian wikilink, and the slug now
  carries the note's folders so it names no vault note. Uses the meta's `title` instead.
  Verified by reading: its other use of the id is `decided_match`, a substring test
  (`if d["key"] in low`), so the keys already stored in `Brain/decided.md` still match the
  longer slug; `load_meta_index` uses `id` only as an in-run dict key, and `brain-themes.py`
  never reads `id` at all. Neither script was executed (both make paid model calls).
- `.gitignore`: ignore `.autoresearcher/` (the gate copies the wiki there).

## Evidence
Gate before (verbatim):
```
brain: 3406 source files, 648 compiled-path collisions, 690 meta-path collisions; worst: skill.md x78, description.md x28, readme.md x25, claude.md x20, readme.md x12
jyotish: 14 source files, 0 compiled-path collisions, 0 meta-path collisions
unit tests: 6 passed in 0.21s
PROBLEM: lib.target_paths() seam missing (legacy formula used for the count)
PROBLEM: scripts/migrate_wiki_slugs.py missing
METRIC=-1338
```
New test red before the change (import of the seam that did not exist yet):
```
E   ImportError: cannot import name 'target_paths' from 'services.wiki_compile.lib'
```
Gate after (verbatim, exit 0):
```
brain: 3406 source files, 0 compiled-path collisions, 0 meta-path collisions; worst: none
jyotish: 14 source files, 0 compiled-path collisions, 0 meta-path collisions
unit tests: 8 passed in 0.39s
migration dry-run: 0 dry run: nothing written
migration real run on copy: 0 migrated /Users/amrut/autoresearcher/work/AR-001/.autoresearcher/wiki-copy.qmj2mwh0
migrated metas: 2785, duplicate ids: 0, unreadable/mismatched: 0
METRIC=0
```
Migration on my own copy under `.autoresearcher/` (the live wiki was only ever read;
`~/nanoclaw/data/brain-wiki/.wiki_meta` still has its 2726 files and no `compiled` file moved):
```
  2726 metas, 2784 articles
  2777 articles renamed, 2785 metas written, 2719 old metas removed
  650 merged sources dropped (they recompile into their own articles), 0 articles left in place
dry run: nothing written
```
sha256 of the copy tree before and after the dry run: `dd78a5d0...1867f7` both times.
After the real run on that copy:
```
metas 2785 dup 0 bad 0 metas-without-article 1
articles 2784 tmp leftovers 0
products__claw-empire__tools__taste-skill__skill.json | created True | version 166 | sources ['Products/claw-empire/tools/taste-skill/skill.md']
```
Gate re-run after the consumer changes: identical output, exit 0.
Rerun of the migration on the migrated copy: `0 articles renamed, 0 metas written, 0 old metas removed`, exit 0.

Deliberate limitation (not a defect the gate hides): a meta that merged 78 sources has only
as many articles on disk as it had categories, so only those sources keep their `created`
and `version`. The other 650 sources are dropped from `sources` and get their own meta on
the next compile with `created` = now. Keeping all 78 would re-inflate
`calculate_confidence`, which is half of the original bug.

## Next lever
Run a real `--force` compile of the Brain domain against a *copy* of the wiki
(`cp -R ~/nanoclaw/data/brain-wiki .autoresearcher/`, point `make_domain(base=...)` at it)
and diff article count against the 3,406 source files: the gate proves the target paths are
distinct but never actually writes them, so nothing yet proves 3,406 articles land on disk
(entity extraction over the whole vault takes minutes, which is why it was out of scope here).

## Blockers
none. The live wiki at `~/nanoclaw/data/brain-wiki/` still holds old-style ids; a human has
to run `python3 scripts/migrate_wiki_slugs.py --wiki ~/nanoclaw/data/brain-wiki` (dry-run
first) and then `python3 scripts/compile_brain_wiki.py --force`, in that order, with
`brain-watch.py` stopped. Until that happens the compiled wiki and the new code disagree.
