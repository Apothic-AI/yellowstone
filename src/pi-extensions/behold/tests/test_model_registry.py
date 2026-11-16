"""T-2's denominator comes from the catalogue pi resolves against, not from one file.

The live defect this covers: ``models-store.json`` is provider-keyed at its top level
(``{"subrouter-deepseek-flash": {"models": [...]}}``), while the loader only understood a
``{"providers": {...}}`` wrapper, and it read *only* that store — which carries no
``subrouter-*`` provider at all. Result: `T-2`/`T-3` unknown on every live lane, so
`leader-board.py` had to read pane footers to get a context percentage.

Each test below fails on the pre-change loader for a stated reason.
"""

from __future__ import annotations

import os
import unittest

from behold import guard
from behold.sources import pi_state
from behold.sources import Paths as pi_state_paths
from tests.helpers import FIXTURE_ROOT, field, lanes, require_fixtures, roster_json


def _write(path: str, payload: str) -> str:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(payload)
    return path


class TestCatalogueShapes(unittest.TestCase):
    def test_provider_keyed_store_parses(self):
        """The live ``models-store.json`` shape: providers at the TOP level."""
        path = _write(os.path.join(self.tmp, "store-provider-keyed.json"),
                      '{"subrouter-deepseek-flash": {"models": ['
                      '{"id": "deepseek-v4.1-flash-1017", "contextWindow": 1000000}]}}')
        catalog = pi_state.model_catalog(path, guard.Policy())
        self.assertIn(("subrouter-deepseek-flash", "deepseek-v4.1-flash-1017"), catalog)
        window = catalog[("subrouter-deepseek-flash", "deepseek-v4.1-flash-1017")]["contextWindow"]
        self.assertEqual(window, 1000000)

    def test_wrapped_registry_parses(self):
        """``models.json``: the ``{"providers": {...}}`` wrapper pi writes."""
        path = _write(os.path.join(self.tmp, "registry.json"),
                      '{"providers": {"regp": {"models": ['
                      '{"id": "reg-only-2", "contextWindow": 512000}]}}}')
        catalog = pi_state.model_catalog(path, guard.Policy())
        self.assertEqual(catalog[("regp", "reg-only-2")]["contextWindow"], 512000)
        self.assertEqual(catalog[("regp", "reg-only-2")]["source"], "registry.json")

    def test_registry_wins_over_store_for_the_same_pair(self):
        """Order is the caller's: the first file to declare a pair answers it."""
        registry = _write(os.path.join(self.tmp, "r.json"),
                          '{"providers": {"p": {"models": [{"id": "m", "contextWindow": 111}]}}}')
        store = _write(os.path.join(self.tmp, "s.json"),
                       '{"p": {"models": [{"id": "m", "contextWindow": 999}]}}')
        self.assertEqual(pi_state.model_catalog([registry, store], guard.Policy())[("p", "m")]["contextWindow"], 111)
        self.assertEqual(pi_state.model_catalog([store, registry], guard.Policy())[("p", "m")]["contextWindow"], 999)

    def test_missing_file_contributes_nothing_and_is_not_a_default(self):
        missing = os.path.join(self.tmp, "nope.json")
        self.assertEqual(pi_state.model_catalog(missing, guard.Policy()), {})
        self.assertEqual(pi_state.model_catalog([missing], guard.Policy()), {})

    def test_unreadable_file_is_skipped_not_fatal(self):
        bad = _write(os.path.join(self.tmp, "bad.json"), "{not json")
        good = _write(os.path.join(self.tmp, "good.json"),
                      '{"providers": {"p": {"models": [{"id": "m", "contextWindow": 7}]}}}')
        catalog = pi_state.model_catalog([bad, good], guard.Policy())
        self.assertEqual(catalog[("p", "m")]["contextWindow"], 7)

    def test_context_max_names_the_answering_file(self):
        catalog = pi_state.model_catalog(
            _write(os.path.join(self.tmp, "models.json"),
                   '{"providers": {"p": {"models": [{"id": "m", "contextWindow": 424242}]}}}'),
            guard.Policy())
        window, label, source = pi_state.context_max(catalog, "p", "m")
        self.assertEqual(window, 424242.0)
        self.assertEqual(label, "p/m")
        self.assertEqual(source, "models.json")

    def test_context_max_absent_is_unknown_without_a_source(self):
        window, _label, source = pi_state.context_max({}, "p", "m")
        self.assertIsNone(window)
        self.assertIsNone(source)

    def setUp(self):
        import tempfile
        self.tmp = tempfile.mkdtemp(prefix="models-")


class TestFixtureTreeAndLivePaths(unittest.TestCase):
    """The two files are both catalogues, and live mode must name both.

    The production defect was ``Paths.for_live(models_store=None)`` plus a loader that
    understood one shape: the roster had no catalogue at all, so T-2/T-3 were unknown on
    every live lane and the leader board read pane footers for a context percentage.
    """

    def test_both_fixture_catalogues_are_merged(self):
        require_fixtures()
        catalog = pi_state.model_catalog(
            [os.path.join(FIXTURE_ROOT, "models.json"),
             os.path.join(FIXTURE_ROOT, "models-store.json")],
            guard.Policy())
        # registry-only model, present in models.json and nowhere else
        self.assertIn(("regp", "reg-only-2"), catalog)
        window, _label, source = pi_state.context_max(catalog, "regp", "reg-only-2")
        self.assertEqual(window, 512000.0)
        self.assertEqual(source, "models.json")
        # store-only model, still answered by the store
        window, label, source = pi_state.context_max(catalog, "acme", "acme-large-1")
        self.assertEqual(window, 200000.0)
        self.assertEqual(label, "acme/acme-large-1")
        self.assertEqual(source, "models-store.json")

    def test_live_paths_name_both_files(self):
        paths = pi_state_paths().for_live(home="/home/example")
        self.assertEqual(paths.models_registry, "/home/example/.pi/agent/models.json")
        self.assertEqual(paths.models_store, "/home/example/.pi/agent/models-store.json")
        self.assertIn("models_registry", paths.to_dict())

    def test_a_lane_on_an_absent_model_stays_unknown(self):
        """kappa-jj runs ``acme-legacy-1``, which neither catalogue declares."""
        require_fixtures()
        lane = lanes(roster_json())["w1G:p1"]
        t2 = field(lane, "T-2")
        self.assertEqual(t2["state"], "unknown", t2)
        self.assertIn("not in the model catalog", t2["reason"])
        self.assertIn("models-store.json", t2["source"])
        self.assertEqual(field(lane, "T-3")["state"], "unknown")

if __name__ == "__main__":
    unittest.main()
