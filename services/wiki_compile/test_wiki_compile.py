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

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from services.wiki_compile.lib import Domain, compile_all, iter_source_files  # noqa: E402


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
    assert (d.compiled / "zettelkasten" / "20260622_hooks.md").exists()
    assert "Hooks nudge" in (d.compiled / "zettelkasten" / "20260622_hooks.md").read_text()


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
    assert (d.compiled / "zettelkasten" / "20260622_hooks.md").exists()


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
