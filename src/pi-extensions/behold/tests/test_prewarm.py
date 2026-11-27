"""The prewarm turns the roster's composition cost from a sum into a max.

These pin the two properties that make it safe: the second wave is generated from the
first wave's ANSWERS (a lane whose plain digest reproduces its recorded digest never pays
a second spawn), and a warm-up that fails is a miss rather than an error — the build then
pays its own subprocess exactly as before.
"""
from behold import cli as cli_mod
from behold.sources import mode_composed


def fake_digest(*, matching):
    calls = []

    def runner(cwd, key, recorded_path=None, permit=None, timeout=None):
        calls.append((cwd, key, recorded_path))
        if key in matching:
            return {"available": True, "digest": "match" if recorded_path is None else "match"}
        return {"available": True, "digest": "plain-differs" if recorded_path is None else "path-matches"}

    return calls, runner


def test_second_wave_only_for_lanes_whose_plain_digest_differs(monkeypatch):
    calls, runner = fake_digest(matching={"a"})
    monkeypatch.setattr(mode_composed, "composed_digest", runner)

    receipt = mode_composed.prewarm([
        ("/repo", "a", "/repo/.pi/modes/a.json", "match"),
        ("/repo", "b", "/repo/.pi/modes/b.json", "path-matches"),
    ], workers=2)

    assert receipt == {"warmed": 3, "failed": 0, "plain": 2, "override": 1}
    # Exactly one plain call per lane, and the override call for `b` alone.
    assert [c for c in calls if c[2] is None] == [("/repo", "a", None), ("/repo", "b", None)]
    assert [c for c in calls if c[2] is not None] == [("/repo", "b", "/repo/.pi/modes/b.json")]


def test_a_lane_with_no_recorded_path_never_asks_for_an_override(monkeypatch):
    calls, runner = fake_digest(matching=set())
    monkeypatch.setattr(mode_composed, "composed_digest", runner)

    receipt = mode_composed.prewarm([("/repo", "a", None, None)], workers=2)

    assert receipt == {"warmed": 1, "failed": 0, "plain": 1, "override": 0}
    assert calls == [("/repo", "a", None)]


def test_a_warmup_that_raises_is_a_miss_not_an_error(monkeypatch):
    def runner(*args, **kwargs):
        raise RuntimeError("node vanished")

    monkeypatch.setattr(mode_composed, "composed_digest", runner)

    receipt = mode_composed.prewarm([("/repo", "a", None, None)], workers=2)

    assert receipt["failed"] == 1
    assert receipt["warmed"] == 0


def test_duplicate_lanes_are_warmed_once(monkeypatch):
    calls, runner = fake_digest(matching={"a"})
    monkeypatch.setattr(mode_composed, "composed_digest", runner)

    receipt = mode_composed.prewarm([
        ("/repo", "a", None, None),
        ("/repo/", "a", None, None),  # same path once absolute: one pair
    ], workers=2)

    assert receipt["plain"] == 1
    assert len(calls) == 1


def test_workers_clamp_and_the_env_switch(monkeypatch):
    monkeypatch.delenv(cli_mod.BUILD_WORKERS_ENV, raising=False)
    assert cli_mod.build_workers(29) == min(cli_mod.DEFAULT_BUILD_WORKERS, 29)
    assert cli_mod.build_workers(3) == 3

    monkeypatch.setenv(cli_mod.BUILD_WORKERS_ENV, "1")
    assert cli_mod.build_workers(29) == 1, "one worker restores the old sequential path"

    monkeypatch.setenv(cli_mod.BUILD_WORKERS_ENV, "999")
    assert cli_mod.build_workers(4) == 4, "clamped to what there is to do"

    monkeypatch.setenv(cli_mod.BUILD_WORKERS_ENV, "not-a-number")
    assert cli_mod.build_workers(29) == min(cli_mod.DEFAULT_BUILD_WORKERS, 29), "a bad value falls back"


def test_specs_never_raise_for_an_unresolvable_lane():
    class Exploding:
        def __getattr__(self, name):
            raise RuntimeError("no snapshot")

    assert cli_mod.composed_specs([{"pane_id": "w1:p1"}], Exploding()) == []
