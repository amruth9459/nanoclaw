"""Source-walk tests for the wiki compiler.

The Brain vault keeps whole categories behind a symlink (Zettelkasten, Products,
most of Hermes and Lexios are directories in nanoclaw linked into the vault).
`Path.rglob` does not descend into a symlinked directory, so those categories
compiled to nothing and did so silently: the run reported success and the
category was simply absent from `compiled/`. These pin the walk itself, at the
level the failure was visible from — a compiled article on disk.

    python3 -m pytest services/wiki_compile/test_wiki_compile.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from services.wiki_compile.lib import (  # noqa: E402
    Domain,
    compile_all,
    iter_source_files,
    target_paths,
)


def _domain(tmp_path: Path, vault: Path) -> Domain:
    return Domain(
        name="t",
        base=tmp_path / "wiki",
        categorize=lambda p: p.parent.name.lower(),
        extract_entities=lambda c: [],
        extract_relationships=lambda c, e: [],
        extract_claims=lambda c: [],
        raw_dirs=[vault],
        skip_path_parts=["Daily"],
    )


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    v = tmp_path / "vault"
    (v / "Notes").mkdir(parents=True)
    (v / "Notes" / "kept.md").write_text("# Kept\n")
    (v / "Daily" / "sub").mkdir(parents=True)
    (v / "Daily" / "sub" / "digest.md").write_text("# Digest\n")

    outside = tmp_path / "outside" / "zettelkasten"
    outside.mkdir(parents=True)
    (outside / "20260622_hooks.md").write_text("# Hooks nudge\n")
    (outside / "20260701_cusp.md").write_text("# Cusp\n")
    (v / "Zettelkasten").symlink_to(outside)
    return v


def test_symlinked_category_compiles(tmp_path, vault):
    d = _domain(tmp_path, vault)
    compile_all(d)
    assert (d.compiled / "zettelkasten" / "zettelkasten__20260622_hooks.md").exists()
    assert "Hooks nudge" in (d.compiled / "zettelkasten" / "zettelkasten__20260622_hooks.md").read_text()


def test_skip_path_parts_still_prunes(tmp_path, vault):
    d = _domain(tmp_path, vault)
    compile_all(d)
    assert not (d.compiled / "sub").exists()


def test_cycle_terminates(tmp_path, vault):
    (vault / "Notes" / "loop").symlink_to(vault)
    found = iter_source_files([vault], "*.md", ["Daily"])
    assert sorted(p.name for p in found) == [
        "20260622_hooks.md", "20260701_cusp.md", "kept.md"]


def test_truncated_state_file_does_not_abort_the_run(tmp_path, vault):
    """brain-watch spawns its own compile, so two runs share .compile_state.json.
    A half-written file used to raise JSONDecodeError and end the run partway."""
    d = _domain(tmp_path, vault)
    d.ensure_dirs()
    d.state_path.write_text("")
    compile_all(d)
    assert (d.compiled / "zettelkasten" / "zettelkasten__20260622_hooks.md").exists()


def test_state_is_written_atomically(tmp_path, vault):
    d = _domain(tmp_path, vault)
    compile_all(d)
    assert not list(d.base.glob(".compile_state.*.tmp"))
    import json as _json
    _json.loads(d.state_path.read_text())


def test_same_file_by_two_paths_is_ingested_once(tmp_path, vault):
    (vault / "Alias").symlink_to(vault / "Zettelkasten")
    found = iter_source_files([vault], "*.md", ["Daily"])
    assert [p.name for p in found].count("20260622_hooks.md") == 1


def test_same_stem_in_two_folders_keeps_two_articles(tmp_path, vault):
    """The vault has 78 files called SKILL.md and 25 called README.md. With the
    slug built from the stem alone they shared one `.wiki_meta` entry, so the
    second file inherited the first's `created`/`version` and, inside one
    category, overwrote its article."""
    (vault / "Notes" / "a").mkdir(parents=True)
    (vault / "Notes" / "b").mkdir(parents=True)
    (vault / "Notes" / "a" / "skill.md").write_text("# Alpha\nalpha body\n")
    (vault / "Notes" / "b" / "skill.md").write_text("# Beta\nbeta body\n")
    d = _domain(tmp_path, vault)
    compile_all(d)

    bodies = [p.read_text() for p in d.compiled.rglob("*.md") if p.name != "index.md"]
    assert sum("alpha body" in b for b in bodies) == 1
    assert sum("beta body" in b for b in bodies) == 1

    ids = [json.loads(p.read_text())["id"] for p in d.meta_dir.rglob("*.json")]
    assert len(ids) == 5
    assert len(set(ids)) == 5
    assert all(json.loads(p.read_text())["version"] == 1 for p in d.meta_dir.rglob("*.json"))


def test_target_paths_is_pure(tmp_path, vault):
    """The gate calls this seam over the live wiki's domain, and compile_all
    calls it before it has decided to write anything."""
    d = _domain(tmp_path, vault)
    wiki_path, meta_path = target_paths(d, vault / "Notes" / "kept.md")
    assert not d.base.exists()
    assert wiki_path.suffix == ".md" and meta_path.suffix == ".json"
    assert wiki_path.stem == meta_path.stem
    assert meta_path.parent == d.meta_dir
