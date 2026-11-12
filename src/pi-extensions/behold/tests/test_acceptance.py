"""Acceptance tests: identity, active branch, fields, coverage, privacy, provenance."""

from __future__ import annotations

import json
import os
import unittest

from tests.helpers import AS_OF, FIXTURE_ROOT, SENTINELS, field, full_text, lanes, require_fixtures, roster_json


class TestFleetRenders(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_fixtures()
        cls.doc = roster_json()
        cls.by = lanes(cls.doc)

    def test_lanes_render(self):
        self.assertEqual(len(self.doc["lanes"]), 61)
        self.assertEqual(self.doc["behold"]["snapshot"]["protocol"], 22)

    def test_every_lane_has_every_field_id(self):
        expected = {
            "H-1", "H-2", "H-3", "H-4", "H-5", "H-6",
            "P-1", "P-2", "P-3", "P-4", "P-5", "P-6", "P-7", "P-8", "P-9", "P-10", "P-11",
            "T-1", "T-2", "T-3", "T-4", "T-5", "T-6", "T-7", "T-8",
            "R-1", "R-2", "R-3", "R-4", "R-5", "R-6", "R-7",
            "M-1", "M-2", "M-3", "M-5", "M-6", "M-7",
            "G-1", "G-2", "G-3", "G-4", "D-1", "D-2", "C-1", "C-2",
            "E-1", "E-2", "S-1", "S-2", "S-3", "S-4",
            "J-1", "J-2", "J-3", "B-1", "B-2",
        }
        for pane, lane in self.by.items():
            self.assertEqual(set(lane["fields"]), expected, pane)

    def test_every_field_carries_state_class_and_privacy(self):
        for lane in self.doc["lanes"]:
            for key, value in lane["fields"].items():
                self.assertIn(value["state"], {
                    "present", "unknown", "absent", "error", "conflict", "stale",
                    "expired", "held", "withheld", "divergent", "inferred"}, (lane["key"], key))
                self.assertIn(value["class"], {"authoritative", "derived", "inferred", "last_observed"})
                self.assertIn(value["privacy"], (0, 1, 2))
                if value["class"] == "derived" and value["state"] == "present":
                    self.assertTrue(value["method"], f"derived {key} has no method")
                if value["state"] in ("unknown", "absent", "error", "conflict", "held"):
                    self.assertTrue(value["reason"], f"{key} {value['state']} has no reason")

    def test_no_numeric_zero_for_missing(self):
        # A missing value must never be a number; only a real reading may be 0.
        for lane in self.doc["lanes"]:
            for key, value in lane["fields"].items():
                if value["state"] in ("unknown", "absent", "error", "held", "withheld"):
                    self.assertIsNone(value["value"], (lane["key"], key))


class TestActiveBranch(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_fixtures()
        cls.doc = roster_json()
        cls.by = lanes(cls.doc)

    def test_branching_lane_excludes_abandoned_branch(self):
        lane = self.by["w1A:p2"]
        totals = field(lane, "T-4")
        self.assertEqual(totals["state"], "present")
        self.assertEqual(totals["value"]["totalTokens"], 2550.0)
        self.assertIn("branch-blind", totals["note"] or "")

    def test_leaf_and_chain_are_reported(self):
        lane = self.by["w1A:p2"]
        p4 = field(lane, "P-4")["value"]
        self.assertEqual(p4["chain_state"], "ok")
        self.assertEqual(p4["entries_on_chain"], 7)
        self.assertEqual(p4["entries_in_file"], 10)
        self.assertEqual(p4["leaf_source"], "last_file_entry")
        self.assertEqual(p4["validated_against_filename"], True)

    def test_multi_mb_session_branch_chain(self):
        lane = self.by["w1D:p1"]
        p4 = field(lane, "P-4")["value"]
        self.assertEqual(p4["chain_state"], "ok")
        self.assertGreater(p4["entries_in_file"], 2300)
        self.assertLess(p4["entries_on_chain"], p4["entries_in_file"])
        self.assertLess(field(lane, "T-4")["value"]["totalTokens"], 3_000_000)

    def test_selected_vs_physical_model_diverges(self):
        lane = self.by["w1F:p2"]
        p2 = field(lane, "P-2")
        self.assertEqual(p2["state"], "divergent")
        self.assertEqual(p2["value"]["selected"], "router-1")
        self.assertEqual(p2["value"]["physical"], "acme-fast-1")

    def test_compaction_and_usage_entries_counted(self):
        lane = self.by["w1F:p2"]
        totals = field(lane, "T-4")["value"]
        self.assertEqual(totals["compaction_usage_entries"], 1)
        self.assertEqual(totals["cache_warm_entries"], 1)
        self.assertIn("mystery-kind", totals["usage_kinds"])
        self.assertEqual(totals["usage_kinds"]["cache_warm"], 1)


class TestIdentity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_fixtures()
        cls.doc = roster_json()
        cls.by = lanes(cls.doc)

    def test_verified_lane(self):
        ident = self.by["w1A:p1"]["identity"]
        self.assertEqual(ident["state"], "verified")
        self.assertTrue(ident["trusted"])
        checks = {c["name"]: c for c in ident["checks"]}
        self.assertTrue(checks["pin.header_id"]["ok"])
        self.assertTrue(checks["pil.lookup"]["ok"])
        self.assertTrue(checks["proc.triple"]["ok"])
        self.assertIn("boot_id", ident["proc"])

    def test_stale_pin_falls_back_to_pane_matched_pil_record(self):
        ident = self.by["w1B:p1"]["identity"]
        self.assertEqual(ident["state"], "session_pin_stale_used_pil_record")
        self.assertIn("pin.vs_pil", {c["name"] for c in ident["checks"]})
        self.assertTrue(any("pin_session" in d for d in ident["disagreements"]))
        # V3: a witness disagreement means not trusted, so no join and no profile preload.
        self.assertFalse(ident["trusted"])
        self.assertIn("witness_disagreement", ident["untrusted_because"])
        # The rendered session is the pil one, not the stale pin file.
        self.assertIn("lane record", ident["session_source"])
        p5 = field(self.by["w1B:p1"], "P-5")["value"]
        self.assertIn("launch-B", p5["path"])
        self.assertNotIn("0000000000ff", p5["path"])

    def test_never_falls_back_to_newest_session_in_directory(self):
        # The stale pin's directory also contains the lane's real session; choosing "newest"
        # or "the pin" blindly would both be wrong, and neither happens.
        ident = self.by["w1B:p1"]["identity"]
        self.assertNotEqual(ident["session_id"], "aaaaaaaa-0000-4000-8000-0000000000ff")

    def test_two_spellings_are_one_lane(self):
        lane = self.by["w1H:p2"]
        p5 = field(lane, "P-5")["value"]
        self.assertGreaterEqual(p5["spellings"], 1)
        self.assertEqual(os.path.realpath(p5["reported_path"]), os.path.realpath(p5["path"]))
        self.assertEqual(sum(1 for k in self.by if k == "w1H:p2"), 1)

    def test_no_session_source_is_not_guessed(self):
        lane = self.by["w1C:p2"]
        self.assertEqual(lane["identity"]["state"], "no_session_source")
        self.assertFalse(lane["identity"]["trusted"])
        self.assertEqual(field(lane, "T-1")["state"], "unknown")
        self.assertIn("no_validated_session", lane["identity"]["untrusted_because"])
        # State that needs no session and no child is still read.
        self.assertEqual(field(lane, "R-7")["state"], "present")
        self.assertEqual(field(lane, "M-5")["state"], "present")

    def test_dead_lane_keeps_its_session_and_loses_liveness_only(self):
        ident = self.by["w1E:p1"]["identity"]
        self.assertEqual(ident["state"], "verified")
        self.assertFalse(ident["proc"]["available"])
        self.assertTrue(any(c["name"] == "proc.triple" and c["ok"] is False for c in ident["checks"]))
        self.assertEqual(field(self.by["w1E:p1"], "T-7")["state"], "unknown")

    def test_partial_final_jsonl_line_is_tolerated_and_reported(self):
        doc = self.doc
        entry = [d for d in doc["diagnostics"] if d["lane"] == "w1D:p2"]
        self.assertTrue(any(d["detail"] == "partial_final_line_ignored" for d in entry), entry)
        lane = self.by["w1D:p2"]
        self.assertEqual(field(lane, "T-1")["state"], "present")
        self.assertEqual(field(lane, "P-2")["value"]["physical"], "acme-fast-1")


class TestTokensAndHonesty(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_fixtures()
        cls.doc = roster_json()
        cls.by = lanes(cls.doc)

    def test_context_percent_uses_catalog_denominator(self):
        lane = self.by["w1A:p1"]
        self.assertEqual(field(lane, "T-1")["value"], 31500.0)
        self.assertEqual(field(lane, "T-2")["value"], 200000)
        self.assertEqual(field(lane, "T-3")["value"], 15.75)
        self.assertEqual(field(lane, "T-3")["class"], "derived")

    def test_missing_context_window_is_unknown_not_assumed(self):
        lane = self.by["w1G:p1"]
        self.assertEqual(field(lane, "T-2")["state"], "unknown")
        self.assertEqual(field(lane, "T-3")["state"], "unknown")
        self.assertIn("refusing", field(lane, "T-3")["reason"])

    def test_ttft_is_explicitly_unknown(self):
        for pane in ("w1A:p1", "w1F:p2"):
            ttft = field(self.by[pane], "T-8")
            self.assertEqual(ttft["state"], "unknown")
            self.assertIn("not", ttft["reason"])

    def test_tps_derived_or_unknown(self):
        present = field(self.by["w1A:p1"], "T-7")
        self.assertEqual(present["state"], "present")
        self.assertIn("durationMs", present["method"])
        legacy = field(self.by["w1F:p2"], "T-7")
        self.assertEqual(legacy["state"], "unknown")

    def test_cache_counts_and_rate(self):
        cache = field(self.by["w1A:p1"], "T-5")["value"]
        self.assertEqual(cache["cacheRead"], 50000.0)
        self.assertAlmostEqual(cache["hit_rate_pct"], 95.79, places=2)
        self.assertAlmostEqual(cache["hit_rate_ratio"], 50000 / 52200, places=5)

    def test_turn_span_is_labelled_not_live(self):
        p8 = field(self.by["w1A:p1"], "P-8")
        self.assertEqual(p8["state"], "present")
        self.assertIn("last observed", p8["note"])

    def test_cost_is_estimated_flagged(self):
        cost = field(self.by["w1A:p1"], "T-6")
        self.assertEqual(cost["state"], "present")
        self.assertTrue(cost["value"]["estimated"])
        self.assertEqual(cost["privacy"], 1)


class TestRepoAndState(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_fixtures()
        cls.doc = roster_json()
        cls.by = lanes(cls.doc)

    def test_repo_fields_are_typed_unknown_not_numbers(self):
        # V3 removed the git adapter: no count may be invented, and the reason is a stable code.
        for key in ("R-1", "R-3", "R-4", "R-6"):
            value = field(self.by["w1A:p1"], key)
            self.assertEqual(value["state"], "unknown", key)
            self.assertEqual(value["reason"], "repo-adapter-not-isolated", key)
            self.assertIsNone(value["value"], key)

    def test_jj_detected_without_invoking(self):
        r5 = field(self.by["w1G:p1"], "R-5")
        self.assertEqual(r5["state"], "present")
        self.assertTrue(r5["value"]["jj_workspace"])
        self.assertEqual(r5["value"]["jj_bookmark"], "master:: @n")
        r6 = field(self.by["w1G:p1"], "R-6")
        self.assertEqual(r6["state"], "unknown")
        self.assertEqual(r6["reason"], "repo-adapter-not-isolated")

    def test_repo_adapter_reason_is_used_everywhere(self):
        for lane in self.doc["lanes"]:
            for key in ("R-1", "R-3", "R-4", "R-6"):
                value = lane["fields"][key]
                if value["state"] == "unknown":
                    self.assertEqual(value["reason"], "repo-adapter-not-isolated",
                                     (lane["key"], key))
        # ... and R-7 still reports detection, which needs no child.
        self.assertEqual(field(self.by["w1A:p1"], "R-7")["value"], "git")

    def test_mode_drift_recomputed(self):
        m2 = field(self.by["w1A:p1"], "M-2")
        self.assertEqual(m2["state"], "present")
        self.assertEqual(m2["value"]["state"], "matched")

    def test_global_profile_is_not_a_lane_field(self):
        for lane in self.doc["lanes"]:
            self.assertNotIn("M-4", lane["fields"])
            self.assertNotIn("activeProfile", json.dumps(lane["fields"]))
            self.assertNotIn("global_activeProfile", json.dumps(lane["fields"]))
        self.assertIn("M-4", self.doc["global"])
        self.assertEqual(self.doc["global"]["M-4"]["value"]["activeProfile"], "worker")

    def test_profile_declared_selected_distinct(self):
        m3 = field(self.by["w1A:p1"], "M-3")["value"]
        self.assertEqual(m3["declared"]["profile"], "leader")
        self.assertEqual(m3["selected"]["value"], "leader")
        self.assertEqual(m3["resolved"]["skill_count"], 2)
        self.assertIn("process-start", m3["declared"]["source"])
        # exactly one allowlisted env key is emitted, and no other env value anywhere
        self.assertEqual(set(m3["declared"]), {"profile", "source", "may_be_stale_after"})

    def test_todo_conflict_rendered(self):
        d1 = field(self.by["w1F:p1"], "D-1")
        self.assertEqual(d1["state"], "conflict")
        self.assertIn("CONFLICT", d1["reason"])
        self.assertEqual(d1["value"]["session_store_total"], 3)
        self.assertEqual(d1["value"]["instance_store_total"], 5)

    def test_todo_subjects_never_exported(self):
        self.assertEqual(field(self.by["w1A:p1"], "D-2")["state"], "withheld")

    def test_goal_counts_without_text(self):
        g1 = field(self.by["w1A:p1"], "G-1")
        self.assertEqual(g1["state"], "present")
        self.assertEqual(g1["value"]["count"], 2)
        self.assertEqual(g1["value"]["by_status"], {"active": 1, "queued": 1})
        self.assertEqual(field(self.by["w1A:p1"], "G-2")["value"], 1)

    def test_text_only_goal_is_unknown(self):
        g1 = field(self.by["w1F:p2"], "G-1")
        self.assertEqual(g1["state"], "unknown")
        self.assertIn("withheld", g1["reason"])

    def test_crons_are_names_not_prompts(self):
        c1 = field(self.by["w1A:p1"], "C-1")
        self.assertEqual(c1["state"], "present")
        self.assertEqual(c1["value"]["count"], 1)
        self.assertEqual(c1["value"]["tasks"][0]["id"], "task_alpha")
        self.assertIn("skipped", c1["note"])

    def test_dagr_attribution_and_staleness(self):
        g3 = field(self.by["w1A:p1"], "G-3")["value"]
        self.assertEqual(g3["runs"][0]["run_id"], "run-1")
        self.assertEqual(field(self.by["w1A:p1"], "G-4")["value"]["stale"], False)
        g4_jj = field(self.by["w1G:p1"], "G-4")["value"]
        self.assertTrue(g4_jj["stale"])

    def test_beads_join_is_explicit_metadata_only(self):
        b1 = field(self.by["w1A:p1"], "B-1")["value"]
        self.assertEqual(b1["count"], 2)
        self.assertEqual({i["id"] for i in b1["issues"]}, {"bd-1", "bd-2"})
        self.assertEqual(b1["by_status"], {"in_progress": 1, "open": 1})
        self.assertEqual(b1["rejected"]["owner_only"], 1)
        self.assertEqual(b1["rejected"]["label_only"], 1)
        self.assertEqual(b1["join"], "metadata.agent_pane+metadata.agent_session")

    def test_beads_refuses_without_validated_session(self):
        b1 = field(self.by["w1C:p2"], "B-1")
        self.assertEqual(b1["state"], "unknown")
        self.assertIn("identity_untrusted", b1["reason"])
        self.assertIn("no_validated_session", b1["reason"])

    def test_extensions_inferred_and_limitation_stated(self):
        e1 = field(self.by["w1A:p1"], "E-1")
        self.assertEqual(e1["state"], "inferred")
        self.assertIn("inert", e1["reason"])
        self.assertIn("bash", e1["value"]["tool_names"])

    def test_skills_paths_only(self):
        s1 = field(self.by["w1A:p1"], "S-1")["value"]
        self.assertEqual(s1["loaded_count"], 2)
        self.assertEqual(s1["loaded"][0]["name"], "beads")
        self.assertEqual(s1["loaded"][0]["path"], "/synthetic/skills/beads/SKILL.md")
        self.assertEqual(field(self.by["w1A:p1"], "S-2")["state"], "withheld")

    def test_prompts_configured_vs_loaded(self):
        s3 = field(self.by["w1A:p1"], "S-3")["value"]
        self.assertEqual(s3["configured_paths"],
                         ["/synthetic/prompts/alpha.md", "/synthetic/prompts/review.md"])
        self.assertTrue(s3["loaded_is_not_proof_of_bodies"])
        self.assertEqual(field(self.by["w1A:p1"], "S-4")["state"], "withheld")

    def test_jobs_are_last_observed(self):
        j1 = field(self.by["w1A:p1"], "J-1")
        self.assertEqual(j1["state"], "stale")
        self.assertEqual(j1["class"], "last_observed")
        self.assertGreaterEqual(j1["value"]["log_count"], 1)
        self.assertIn("bash_bg", json.dumps(j1["value"]["tool_calls"]))
        j2 = field(self.by["w1A:p1"], "J-2")
        self.assertEqual(j2["state"], "stale")
        self.assertIn("monitor", json.dumps(j2["value"]["calls"]))
        j3 = field(self.by["w1A:p1"], "J-3")
        self.assertEqual(j3["state"], "unknown")
        self.assertIn("no persistable", j3["reason"])

    def test_presence_depth_is_deferred_not_faked(self):
        m7 = field(self.by["w1A:p1"], "M-7")
        self.assertEqual(m7["state"], "unknown")
        self.assertIn("P3", m7["reason"])

    def test_rooms_membership_names_only(self):
        m6 = field(self.by["w1A:p1"], "M-6")["value"]
        self.assertIn("leaders", m6["rooms"])
        self.assertEqual(m6["registry_count"], 1)

    def test_missing_fields_render_their_own_state(self):
        lane = self.by["w1H:p1"]
        self.assertEqual(field(lane, "H-4")["state"], "absent")
        h5 = field(lane, "H-5")["value"]
        self.assertEqual(h5["restore_error"], "terminal_restore_failed")
        self.assertIsNone(h5["completion_seq"])


class TestPrivacy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_fixtures()
        cls.doc = roster_json()
        cls.text = full_text(cls.doc)

    def test_no_sentinel_leaks(self):
        leaked = [name for name, sentinel in SENTINELS.items() if sentinel in self.text]
        self.assertEqual(leaked, [], f"class-2 sentinels leaked into output: {leaked}")

    def test_held_workspace_is_denied_before_reads(self):
        lane = None
        for candidate in self.doc["lanes"]:
            if candidate["key"] == "w2:p1":
                lane = candidate
        self.assertIsNotNone(lane)
        self.assertFalse(lane["admission"]["admitted"])
        self.assertEqual(lane["admission"]["reason"], "held_workspace:w2")
        self.assertIsNone(lane["identity"])
        self.assertEqual(field(lane, "P-5")["state"], "held")
        self.assertEqual(field(lane, "T-1")["value"], None)
        # Nothing about the lane is rendered — not even snapshot metadata: the refusal is the
        # only fact emitted, plus the handle that names it.
        for key, value in lane["fields"].items():
            self.assertEqual(value["state"], "held", key)
            self.assertIsNone(value["value"], key)
        self.assertIsNone(lane["handles"]["name"])
        self.assertIsNone(lane["handles"]["agent_status"])

    def test_reserved_pane_is_denied(self):
        lane = [c for c in self.doc["lanes"] if c["key"] == "wE:t19"][0]
        self.assertFalse(lane["admission"]["admitted"])
        self.assertEqual(lane["admission"]["reason"], "reserved_pane:wE:t19")
        self.assertEqual(field(lane, "M-3")["state"], "held")

    def test_denial_receipt(self):
        denials = self.doc["behold"]["guard"]["denials"]
        # One lane admission each, plus the pil-record index refusing the same lane a second
        # time (it is consulted per lane and, defensively, when the directory is indexed).
        self.assertGreaterEqual(denials.get("held_workspace:w2", 0), 1)
        self.assertGreaterEqual(denials.get("reserved_pane:wE:t19", 0), 1)
        # V3 covers the real topology: the reserved tab is denied too.
        self.assertEqual(set(denials),
                         {"held_workspace:w2", "reserved_pane:wE:t19", "reserved_tab:wE:t19"})

    def test_no_private_export_flags_exist(self):
        from behold import cli
        parser = cli.build_parser()
        roster_parser = parser._subparsers._group_actions[0].choices["roster"]
        options = {opt for action in roster_parser._actions for opt in action.option_strings}
        for forbidden in ("--include-todo-subjects", "--include-goals", "--include-prompts",
                          "--include-notes", "--include-messages"):
            self.assertNotIn(forbidden, options)

    def test_unknown_private_flag_is_a_usage_error(self):
        from tests.helpers import roster
        code, out, err = roster("--include-todo-subjects")
        self.assertEqual(code, 2, (out, err))

    def test_env_values_are_allowlisted_only(self):
        # The fixture environment carries SENTINEL_ENV_VALUE under an unrelated key.
        self.assertNotIn(SENTINELS["env_value"], self.text)


if __name__ == "__main__":
    unittest.main()
