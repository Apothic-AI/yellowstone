"""behold CLI — ``behold roster``.

Exit codes
----------
0   roster rendered
2   usage error (argparse; also an unknown flag such as ``--include-todo-subjects``)
3   source error (snapshot missing/unreadable/unsupported protocol, capture failed)
4   guard violation (a write or network attempt was refused)

The guard is installed for the whole run. There is no default live *discovery*: the roster
is built from one herdr snapshot plus the stores that already exist on disk, and the
snapshot is either captured directly (``herdr api snapshot``), read from a file
(``--snapshot FILE``) or read from a fixture tree (``--root DIR``).

A bare ``behold roster`` is the live run: it captures the topology from herdr and reads
the real stores. ``--snapshot FILE`` alone reads **one** file and nothing else from the
host. ``--root DIR`` reads a fixture tree.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import time
from typing import Any, Callable, Sequence

from . import cache as cache_mod
from . import field as F
from . import guard, identity, lane as lane_mod, render, util, watch
from . import admission
from .sources import Paths, SourceError, fleet_state, herdr, herdr_capture, pi_state

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_SOURCE = 3
EXIT_GUARD = 4

#: How the cache participates in a run.
CACHE_MODES = ("auto", "on", "off")

#: Run modes. ``fixture`` is a tree, ``snapshot`` is one file, ``live`` is the real stores.
RUN_MODES = ("fixture", "snapshot", "live")

#: A topology read from a file is called stale once it is older than this. The file's
#: mtime is weak provenance, so the roster says "stale" rather than "current".
TOPOLOGY_STALE_S = 300.0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="behold",
        description="Read-only, derive-on-demand fleet roster (P1+P2 foundation).",
    )
    parser.add_argument("--version", action="version", version=f"behold {render.VERSION}")
    sub = parser.add_subparsers(dest="command")

    roster = sub.add_parser("roster", help="derive the roster and print it")
    roster.add_argument("--snapshot", help="herdr snapshot JSON (fixture or captured)")
    roster.add_argument("--herdr", action="store_true",
                        help="capture the live topology with `herdr api snapshot` "
                             "(the default when neither --snapshot nor --root is given)")
    roster.add_argument("--root", help="data root containing herdr/, proc/, pil/, instances/, state/")
    roster.add_argument("--live", action="store_true",
                        help="use the real store paths (the default for a bare run)")
    roster.add_argument("--cache", choices=CACHE_MODES, default="auto",
                        help="cache: auto (live runs only), on (always), off (never)")
    roster.add_argument("--cache-db",
                        help="cache database path (default: $BEHOLD_CACHE_DB or "
                             "~/.local/state/behold/behold.db)")
    roster.add_argument("--markdown", action="store_true", help="render Markdown instead of JSON")
    roster.add_argument("--full", action="store_true", help="with --markdown: every field for every lane")
    roster.add_argument("--lane", help="single lane by pane id")
    roster.add_argument("--filter", action="append", default=[], metavar="KEY=OP",
                        help="repeatable, e.g. --filter 'H-5.value.status=working'")
    roster.add_argument("--sort", action="append", default=[], metavar="KEY[:desc]",
                        help="repeatable; default lane key")
    roster.add_argument("--proc-root", help="explicit /proc tree to read (default: disabled; host /proc is not read)")

    roster.add_argument("--as-of", help="evaluate ages at this ISO timestamp instead of now (single-run only)")
    roster.add_argument("--watch", action="store_true", help="re-derive on input change (bounded)")
    roster.add_argument("--watch-iterations", type=int, default=2)
    roster.add_argument("--watch-interval", type=float, default=0.5)
    roster.add_argument("--watch-max-seconds", type=float, default=30.0)
    roster.add_argument("--events-file", help="herdr events file to watch (snapshot fields only)")
    roster.add_argument("--verbose", action="store_true", help="include per-source timings in stderr")
    # Deny lists are fixed by the decision; the flags exist so a test can *tighten* them.
    roster.add_argument("--deny-workspace", action="append", default=[],
                        help="additional held workspace id (never removes a default)")
    roster.add_argument("--deny-pane", action="append", default=[],
                        help="additional reserved pane id (never removes a default)")
    return parser


def _run_mode(args: argparse.Namespace) -> str:
    """Which kind of run this is. The bare command is a live run."""
    if args.root:
        return "fixture"
    if args.live or not args.snapshot:
        return "live"
    return "snapshot"


def _cache_mode(args: argparse.Namespace, mode: str) -> str:
    """Resolve ``--cache auto`` against the run mode.

    ``auto`` opens the cache for a live run only: an offline run (a fixture tree, or one
    snapshot file) must not touch the operator's cache unless the operator asks for it.
    """
    if args.cache in ("on", "off"):
        return args.cache
    return "on" if mode == "live" else "off"


def _cache_path(args: argparse.Namespace) -> str:
    if args.cache_db:
        return os.path.abspath(os.path.expanduser(args.cache_db))
    return cache_mod.default_db_path()


def _paths_from_args(args: argparse.Namespace) -> Paths:
    mode = _run_mode(args)
    if mode == "fixture":
        paths = Paths.for_root(args.root)
        if args.proc_root:
            paths.proc_root = args.proc_root
        return paths
    if mode == "live":
        paths = Paths.for_live()
        if args.snapshot:
            paths.snapshot = args.snapshot
        if args.proc_root:
            paths.proc_root = args.proc_root
        return paths
    # A snapshot-only run reads the snapshot and nothing from the host: no /proc, no pil
    # records, no agent dir. Host inputs are opt-in, and /proc is only read when a root or
    # --proc-root names it.
    paths = Paths(root=None)
    paths.snapshot = args.snapshot
    paths.proc_root = args.proc_root or ""
    return paths


class Runner:
    """One derivation run: snapshot + caches + lanes. Reusable by ``--watch``."""

    def __init__(self, args: argparse.Namespace, policy: guard.Policy, *,
                 snapshot: herdr.Snapshot | None = None,
                 capture: herdr_capture.CaptureResult | None = None,
                 clock: Callable[[], float] = time.time):
        self.args = args
        self.policy = policy
        self.paths = _paths_from_args(args)
        self.mode = _run_mode(args)
        #: The wall clock this run reads. It is injected so that a watch can be driven
        #: by a synthetic one: the map's freshness and the topology's age are claims
        #: about time, and a test has to be able to move time.
        self.clock = clock
        # A watched document must age: with --watch the clock is live on every iteration, so
        # a fixed as_of is refused rather than silently frozen.
        self.as_of = util.parse_iso(args.as_of) if args.as_of else self.clock()
        self.as_of_iso = util.iso(self.as_of)
        self.cache_mode = _cache_mode(args, self.mode)
        self.cache_requested = args.cache
        self.cache_path = _cache_path(args)
        self.cache: cache_mod.Cache | None = None
        #: The receipt of the capture this run's topology came from. A watch iteration
        #: that reuses a capture keeps the receipt: the capture happened, and the
        #: document should keep saying so.
        self.capture: herdr_capture.CaptureResult | None = capture
        self.cache_ingest: dict[str, Any] | None = None
        self.deny_file: str | None = None
        #: The admission map for this run: the deny ids plus the topology's pane->tab
        #: and pane->workspace mapping. It is published for the reporter and used by the
        #: ingester, so both refuse exactly the lanes the roster refuses.
        self.admission: admission.AdmissionMap | None = None
        # The cache is opened before the snapshot is loaded: a capture writes its topology
        # into the cache, so the cache has to exist first.
        self._cache_open()
        if snapshot is not None:
            # A watch iteration reuses the snapshot the first runner captured: herdr is
            # asked once per run, not once per iteration. The snapshot keeps its own
            # observation, so reusing it is not observing it again: the map this
            # iteration publishes is stamped with the moment the topology was really
            # seen, and it ages from there.
            self.snapshot = snapshot
        else:
            self.snapshot = self._load_snapshot()
        # The admission map is built BEFORE the topology is cached: the cached topology
        # is filtered by the policy's holds and the map's placement, so a held
        # workspace's, a reserved tab's or a reserved pane's metadata is never written.
        self.admission = self._build_admission()
        self._cache_store_topology(self.snapshot.raw, self.snapshot.source)
        # Admission-gated pil access: no directory walk, one candidate file per admitted lane,
        # and a denied lane never reaches the open at all.
        self.pil = identity.PilAccess(self.paths.pil_dir or None, policy)
        self.models = pi_state.model_catalog(self.paths.models_store, policy)
        recent = str(self.paths.state_dir) + "/dagr/recent" if self.paths.state_dir else None
        self.dagr = fleet_state.load_dagr_runs(recent, policy)
        self.beads = fleet_state.load_beads(self.paths.beads_file, policy)

    # -- the snapshot -------------------------------------------------------------------

    def _load_snapshot(self) -> herdr.Snapshot:
        """The one snapshot the whole roster is built on.

        Three ways in, in this order: an explicit ``--herdr`` capture, a file
        (``--snapshot FILE`` or the fixture tree), or — when neither is given — a live
        capture from herdr.
        """
        if self.args.herdr:
            return self._capture_snapshot()
        if self.paths.snapshot:
            if not os.path.exists(self.paths.snapshot):
                raise SourceError(f"snapshot not found: {self.paths.snapshot}")
            snapshot = herdr.load(self.paths.snapshot, self.policy)
            snapshot.observation = self._file_observation()
            return snapshot
        return self._capture_snapshot()

    def _file_observation(self) -> herdr.Observation:
        """The observation of a topology that was **read from a file**.

        The file's mtime is when the topology was written, and it is the only moment a
        file can offer — anyone can set an mtime, so this provenance is weak, and the
        roster says so rather than calling the file current.

        The **observation** is the moment this run read the file: that is what the
        admission map is stamped with, because the map says "this placement was observed
        then". A watch iteration that reuses the file keeps the first read's moment.
        """
        mtime = os.path.getmtime(self.paths.snapshot) if self.paths.snapshot else None
        observed_at = self.clock()
        kind = "fixture_tree" if self.mode == "fixture" else "snapshot_file"
        return herdr.Observation(
            kind=kind,
            at_epoch=observed_at,
            at=util.iso(observed_at),
            source="file_mtime",
            source_epoch=mtime)

    def _capture_snapshot(self) -> herdr.Snapshot:
        """Capture the live topology with ``herdr api snapshot``.

        One child process, one exact argv, no shell, a bounded timeout. The document is
        parsed in memory: it is never written to a temporary file first.
        """
        result = herdr_capture.capture(clock=self.clock)
        self.capture = result
        if not result.ok:
            detail = f" ({result.stderr})" if result.stderr else ""
            raise SourceError(f"{result.error}: {result.message}{detail}")
        assert result.document is not None
        self.policy.record_spawn(herdr_capture.PURPOSE, " ".join(result.argv))
        # The captured document has no file behind it: the roster must not pretend there
        # is a snapshot path to re-read.
        self.paths.snapshot = None
        try:
            document, notes = herdr_capture.normalize_snapshot(result.document)
        except herdr_capture.SnapshotShapeError as exc:
            raise SourceError(f"herdr-unreadable-snapshot: {exc}") from exc
        result.notes = notes
        snapshot = herdr.parse_document(
            document, result.source, self.policy, bytes_=result.bytes)
        # The capture's own clock is the provenance: this process asked herdr, so the
        # moment it asked is the moment the topology was seen. A watch iteration that
        # reuses this snapshot keeps it — reusing a capture is not observing it again.
        snapshot.observation = herdr.Observation(
            kind="live_capture",
            at_epoch=result.captured_at_epoch,
            at=result.captured_at,
            source="capture_clock",
            source_epoch=result.captured_at_epoch)
        return snapshot

    # -- admission ---------------------------------------------------------------------

    def _build_admission(self) -> admission.AdmissionMap:
        """The admission map for this run, built from the topology and the deny policy.

        The topology contributes the pane->tab and pane->workspace mapping, so that the
        ingester can refuse a lane inside a reserved tab **before** it opens the lane's
        record -- the tab id never has to be read out of the record to be enforced.

        The map is stamped with the moment the topology was **observed**, not with the
        moment the map was written. That is the whole point: the map says "this
        placement was observed then", and a map that is re-stamped on every publication
        makes an old topology look fresh forever. A watch iteration that reuses a
        snapshot therefore publishes a map that ages from the capture, and once it is
        older than the map's lifetime the readers refuse it — which is the bound the
        map's own documentation promises.
        """
        panes: list[dict[str, Any]] = []
        for record in list(self.snapshot.panes) + list(self.snapshot.agents):
            if isinstance(record, dict):
                panes.append(record)
        observed = self.snapshot.observation
        moment = observed.at_epoch if observed.at_epoch is not None else self.clock()
        return admission.build_map(
            policy=self.policy,
            panes=panes,
            topology_revision=self._topology_revision(panes),
            captured_at_epoch=moment,
            captured_at=observed.at or util.iso(moment))

    def _topology_revision(self, panes: list[dict[str, Any]]) -> str:
        """A fingerprint of the topology this run read.

        The herdr snapshot carries no document-level revision, but every pane carries
        one. The fingerprint is over the handles and the per-pane revisions, so it
        changes when the topology changes -- which is what the admission map's freshness
        check needs.
        """
        parts = []
        for record in panes:
            parts.append("|".join(str(record.get(key) or "") for key in
                                   ("pane_id", "workspace_id", "tab_id", "revision")))
        digest = hashlib.sha256("\n".join(sorted(parts)).encode("utf-8")).hexdigest()
        return digest[:16]

    def topology_provenance(self) -> dict[str, Any]:
        """Where the topology came from, and how old it is.

        A live capture's provenance is the capture itself: this process made the call, so
        the moment it was made is known and cannot be forged. A snapshot **file** has
        only its mtime, which anyone can set, so its provenance is marked weak and the
        file can be stale -- and the roster says so rather than calling it current.

        A **reused** topology keeps the provenance it was read with. A watch iteration
        that reuses a capture reports that capture's kind, that capture's moment, and an
        age that **grows**: the topology was not seen again, and saying otherwise would
        be the same lie the map's freshness bound exists to prevent.
        """
        now = self.clock()
        observed = self.snapshot.observation
        source_epoch = observed.source_epoch
        if observed.kind == "unknown" or source_epoch is None:
            return {
                "kind": "unknown",
                "captured_at": None,
                "captured_at_source": None,
                "age_s": None,
                "stale": None,
                "protocol": self.snapshot.protocol,
                "source": self.snapshot.source,
                "note": "the topology's provenance is unknown",
            }
        age = max(0.0, now - float(source_epoch))
        stale = age > TOPOLOGY_STALE_S
        if observed.kind == "live_capture":
            note = ("the roster made this capture in this run: the moment is the "
                    "capture's own clock, not a file's mtime")
        else:
            note = ("the topology's age is the file's mtime: weak provenance, because "
                    "an mtime can be set by anyone. A stale file is reported as stale "
                    "rather than called current")
        return {
            "kind": observed.kind,
            "captured_at": observed.at,
            "captured_at_source": observed.source,
            "age_s": round(age, 3),
            "stale": stale,
            "stale_after_s": TOPOLOGY_STALE_S,
            "protocol": self.snapshot.protocol,
            "source": self.snapshot.source,
            "note": note,
        }

    # -- the cache ----------------------------------------------------------------------

    def _cache_scope(self) -> Any:
        """The narrow write scope for the cache file family."""
        path = self.cache_path
        deny = cache_mod.deny_file_path(path)
        return guard.cache_write_scope(
            [path, path + "-wal", path + "-shm", path + "-journal",
             deny,
             # The admission map is published atomically: a temp file and a rename. The
             # temp file's name carries this process's pid, so the scope names it
             # exactly -- no pattern, no other file in the directory.
             f"{deny}.tmp.{os.getpid()}"],
            dirs=[os.path.dirname(path)] if os.path.dirname(path) else [])

    def _cache_open(self) -> None:
        if self.cache_mode == "off":
            return
        cache = cache_mod.Cache(self.cache_path)
        try:
            with self._cache_scope():
                cache.connect()
        except cache_mod.CacheError:
            # A cache written by another schema version is a hard error, not a warning:
            # the operator must know that what is on disk is not what this build expects.
            raise
        except Exception:
            cache.close()
            raise
        self.cache = cache

    def _cache_store_topology(self, document: dict[str, Any] | None, source: str) -> None:
        """Store the topology this run used.

        The row records where the topology came from — a live capture or a file — so a
        reader can tell a fresh capture from a snapshot taken out of band.

        The payload is **filtered before it is written**: the policy's holds and the
        admission map's placement decide what may be persisted, so the shared cache
        never holds the metadata of a lane the roster itself refuses. The roster's own
        output is derived from the full document, not from the cached one.
        """
        if self.cache is None or not isinstance(document, dict):
            return
        protocol = document.get("protocol")
        if not isinstance(protocol, int) or isinstance(protocol, bool):
            return
        observed = time.time()
        with self._cache_scope():
            self.cache.upsert_herdr_snapshot(
                protocol=protocol,
                seq=int(observed * 1000),
                observed_at=util.iso(observed) or "",
                observed_at_epoch=observed,
                payload=document,
                source=source,
                policy=self.policy,
                admission=self.admission)

    def ingest_cache(self) -> None:
        """Apply the pi extension's spool records to the cache.

        The deny policy is applied **before** each spool file is opened, so a held
        workspace's or a reserved pane's record is never read, let alone stored.
        """
        if self.cache is None:
            return
        inbox = cache_mod.inbox_dir_for(self.cache_path)
        with self._cache_scope():
            self.cache_ingest = self.cache.ingest_inbox(
                inbox, admission_map=self.admission, policy=self.policy)

    def publish_admission(self) -> None:
        """Publish the admission map for the reporter.

        The reporter cannot know Behold's deny list, so the roster publishes it beside
        the cache: the deny ids **and** the topology's pane->tab mapping. A reporter
        that honors the file never writes a record for a lane the roster would refuse;
        the ingest refuses such a record anyway, before opening it.
        """
        if self.cache is None or self.admission is None:
            return
        with self._cache_scope():
            self.deny_file = cache_mod.write_deny_file(self.cache_path, self.admission)

    def cache_summary(self) -> cache_mod.CacheSummary:
        # The cache freshness is judged against the real clock, not against --as-of: the
        # frozen clock of a fixture run says nothing about how old a cached value is.
        return cache_mod.summarize(
            self.cache, mode=self.cache_requested, enabled=self.cache is not None)

    def close(self) -> None:
        """Close the cache connection this runner owns."""
        if self.cache is not None:
            self.cache.close()
            self.cache = None

    def context(self) -> lane_mod.Context:
        return lane_mod.Context(
            paths=self.paths,
            policy=self.policy,
            snapshot=self.snapshot,
            as_of=self.as_of,
            as_of_iso=self.as_of_iso,
            pil=self.pil,
            models=self.models,
            dagr=self.dagr,
            beads=self.beads,
            # The reporter cache, when it is enabled: the lane's P-11 joins against it.
            runtime_cache=self.cache,
            cache_freshness_s=cache_mod.DEFAULT_FRESHNESS_S,
        )

    def dependency_paths(self, built: list[Any]) -> list[str]:
        """Every store this derivation actually read, so watch can invalidate per source.

        V2 returned only the snapshot and session paths, so a profile/todos/settings/models/
        beads/cron/dagr-only change produced no new document. These are the same paths the
        adapters open, derived per lane from the admitted instance.
        """
        paths: list[str] = []
        if self.paths.snapshot:
            paths.append(self.paths.snapshot)
        if self.paths.beads_file:
            paths.append(self.paths.beads_file)
        if self.paths.models_store:
            paths.append(self.paths.models_store)
        if self.paths.state_dir:
            paths.append(os.path.join(self.paths.state_dir, "cron", "tasks.json"))
            paths.append(os.path.join(self.paths.state_dir, "dagr", "recent"))
        for built_lane in built:
            ident = built_lane.identity
            if ident is None or ident.session is None:
                continue
            paths.append(ident.session.path)
            if ident.pil and ident.pil.get("file"):
                paths.append(ident.pil["file"])
            if not ident.trusted:
                continue
            instance = pi_state.instance_from_agent_dir(
                ident.env.get("PI_CODING_AGENT_DIR"), self.paths.instances_dir)
            if instance and self.paths.instances_dir:
                base = os.path.join(self.paths.instances_dir, instance)
                paths.extend([
                    os.path.join(base, "pi-profile.json"),
                    os.path.join(base, "pi-profile-state.json"),
                    os.path.join(base, "pi-todo-state.json"),
                    os.path.join(base, "settings.json"),
                ])
            if self.paths.profiles_dir:
                for name in ("leader", "worker", "ask"):
                    paths.append(os.path.join(self.paths.profiles_dir, f"{name}.json"))
            if self.paths.global_mode_dir:
                paths.append(os.path.join(self.paths.global_mode_dir, "leader.json"))
                paths.append(os.path.join(self.paths.global_mode_dir, "worker.json"))
        # dedupe, keep order
        seen: set[str] = set()
        unique = []
        for path in paths:
            if path and path not in seen:
                seen.add(path)
                unique.append(path)
        return unique

    def lanes_and_inputs(self) -> tuple[list[dict[str, Any]], list[str], dict[str, str]]:
        started = time.perf_counter()
        ctx = self.context()
        agents = self.snapshot.agents
        if self.args.lane:
            agents = [a for a in agents if a.get("pane_id") == self.args.lane]
        built = [lane_mod.build_lane(agent, ctx) for agent in agents]
        lanes = [b.to_dict() for b in built]
        lanes = render.apply_filters(lanes, self.args.filter)
        lanes = render.apply_sort(lanes, self.args.sort)
        ctx.state_only_wall_ms = (time.perf_counter() - started) * 1000.0
        self.last_ctx = ctx
        inputs = self.dependency_paths(built)
        sessions: dict[str, str] = {}
        for b in built:
            if b.identity and b.identity.session:
                sessions[b.pane_id or ""] = b.identity.session.path
        return lanes, inputs, sessions

    def document(self, lanes: list[dict[str, Any]], ctx: lane_mod.Context) -> dict[str, Any]:
        # Role/global/profile aggregates are derived ONLY from lanes that were admitted and
        # whose ownership is verified. With none, the answer is a typed noaccess — never a
        # directory scan of every instance (which V2 did, reading held state).
        admitted_trusted = []
        for lane in lanes:
            ident = lane.get("identity") or {}
            if lane["admission"]["admitted"] and ident.get("trusted"):
                m3 = lane["fields"].get("M-3") or {}
                inst = (m3.get("value") or {}).get("instance") if isinstance(m3.get("value"), dict) else None
                if inst:
                    admitted_trusted.append(inst)
        trusted_instances = sorted(set(admitted_trusted))
        if trusted_instances:
            # Handles are derived from admitted+verified lanes FIRST; the reader is given that
            # list and constructs one path per name. It never lists the instances root, so a
            # held or foreign instance is never opened.
            global_profile = pi_state.global_profile_active(
                self.paths.instances_dir, trusted_instances, self.policy)
            global_profile["derived_from"] = {
                "lanes": "admitted+verified only",
                "instances": trusted_instances,
                "handle_source": "verified process agent-dir basename; no directory listing",
            }
            m4_state = global_profile.get("state", "present")
        else:
            global_profile = {
                "activeProfile": None,
                "state": "unknown",
                "reason": "noaccess: no admitted+trusted lane to attribute a global setting from",
                "scope": "global_file",
            }
            m4_state = "unknown"
        global_block = {
            "M-4": {
                "key": "M-4",
                "state": m4_state,
                "class": "authoritative",
                "scope": "global_file",
                "value": global_profile,
                "note": ("pi-profile-state.json is ONE global file for the machine; it is never a "
                         "lane field, and it is only read when an admitted, verified lane "
                         "attributes it"),
                "privacy": 1,
            },
            "goal_config": fleet_state.goals_file(self.paths.agent_dir, self.policy),
            "beads_export": {"path": self.paths.beads_file,
                             "issues": len(self.beads)},
            "dagr_index": {"runs": len(self.dagr)},
        }
        generated = util.iso(time.time())
        document = render.document(
            lanes=lanes,
            ctx=ctx,
            guard_receipt=self.policy.receipt(),
            diagnostics=ctx.diagnostics,
            generated_at=generated,
            filters=self.args.filter,
            sorts=self.args.sort or ["key"],
            global_block=global_block,
            wall_ms=getattr(ctx, "state_only_wall_ms", 0.0),
            cache=self.cache_summary().to_dict(),
        )
        if self.capture is not None:
            # The capture's own receipt: what ran, how long it took, and every note the
            # normalizer made about the document it was given.
            document["behold"]["capture"] = self.capture.to_dict()
        # The topology's provenance: where it came from, how old it is, and whether it
        # can be called current. A roster that reads a file is not reading "now".
        document["behold"]["topology"] = self.topology_provenance()
        if self.admission is not None:
            document["behold"]["admission"] = {
                "version": self.admission.version,
                "captured_at": self.admission.captured_at,
                "topology_revision": self.admission.topology_revision,
                "denied_workspaces": list(self.admission.denied_workspaces),
                "reserved_panes": list(self.admission.reserved_panes),
                "reserved_tabs": list(self.admission.reserved_tabs),
                "panes": len(self.admission.pane_tab),
                # The map's own age: the map is stamped with the moment the topology was
                # observed, so a watch iteration reports the age of the observation,
                # not the age of the republication.
                "age_s": round(self.admission.age_s(self.clock()), 3),
                "stale": self.admission.is_stale(self.clock()),
                "ingest": self.cache_ingest,
            }
        return document


def _emit(text: str) -> None:
    """stdout only. The roster itself writes no file; the shell redirects if the operator
    wants one.

    The earlier ``--output`` flag was removed because a writable path inside the guarded
    process is a symlink/sibling-escape surface, and no in-process write is needed to produce
    the deliverable. The cache is the one file behold writes, and it is not a deliverable:
    it is Behold's own state, in Behold's own directory, and it can be deleted.
    """
    sys.stdout.write(text)
    if not text.endswith("\n"):
        sys.stdout.write("\n")


def main(argv: Sequence[str] | None = None, *,
         clock: Callable[[], float] = time.time) -> int:
    parser = build_parser()
    raw = list(sys.argv[1:] if argv is None else argv)
    if not raw:
        raw = ["roster"]
    elif raw[0] not in ("roster", "--version", "-h", "--help"):
        raw = ["roster", *raw]
    args = parser.parse_args(raw)
    if args.command in (None, "roster"):
        try:
            return _run_roster(args, clock=clock)
        except guard.ReadOnlyViolation as exc:
            sys.stderr.write(f"behold: read-only guard refused an action: {exc}\n")
            return EXIT_GUARD
        except guard.NetworkViolation as exc:
            sys.stderr.write(f"behold: network guard refused an action: {exc}\n")
            return EXIT_GUARD
        except SourceError as exc:
            sys.stderr.write(f"behold: {exc}\n")
            return EXIT_SOURCE
        except guard.DeniedRead as exc:
            sys.stderr.write(f"behold: denied read: {exc}\n")
            return EXIT_GUARD
        except ValueError as exc:
            # A malformed --filter / --sort expression is a usage error, not a crash.
            sys.stderr.write(f"behold: {exc}\n")
            return EXIT_USAGE
    return EXIT_USAGE


class WatchDeriver:
    """The watch's per-iteration derivation.

    A fresh :class:`Runner` per iteration: every cached source (snapshot, models,
    settings, dagr index, beads export, runs, task files) is re-materialized, and the
    clock is read again, so both the data and the ages in the document are current.

    The **topology** is reused: herdr is asked once per run, not once per iteration.
    The reused snapshot keeps the observation it was read with, so the admission map
    this iteration publishes is stamped with the moment the topology was really seen.
    Re-using a capture is not observing it again, and the map must not pretend
    otherwise — otherwise a long-lived watch would keep an old topology looking fresh
    and the map's own 300-second bound would never apply.

    It is a class rather than a closure so that a test can drive the watch with a
    synthetic clock: the map's freshness and the topology's age are claims about time.
    """

    def __init__(self, args: argparse.Namespace, policy: guard.Policy,
                 runner: Runner, *, clock: Callable[[], float] = time.time):
        self.args = args
        self.policy = policy
        self.runner = runner
        self.clock = clock

    def __call__(self) -> tuple[dict[str, Any], list[str], dict[str, str]]:
        fresh = Runner(self.args, self.policy, snapshot=self.runner.snapshot,
                       capture=self.runner.capture, clock=self.clock)
        try:
            fresh.publish_admission()
            fresh.ingest_cache()
            lanes, inputs, sessions = fresh.lanes_and_inputs()
            ctx = fresh.last_ctx
            return fresh.document(lanes, ctx), inputs, sessions
        finally:
            fresh.close()


def _run_roster(args: argparse.Namespace, *,
                clock: Callable[[], float] = time.time) -> int:
    if args.watch and args.as_of:
        sys.stderr.write(
            "behold: --as-of is a single-run override and cannot be combined with --watch "
            "(a watched document must age)\n")
        return EXIT_USAGE
    if args.herdr and args.snapshot:
        sys.stderr.write(
            "behold: --herdr captures the live topology and --snapshot reads a file; "
            "they are mutually exclusive\n")
        return EXIT_USAGE
    policy = guard.Policy(
        denied_workspaces=guard.DENIED_WORKSPACES | frozenset(args.deny_workspace),
        denied_panes=guard.DENIED_PANES | frozenset(args.deny_pane),
    )
    with guard.enforce():
        runner = Runner(args, policy, clock=clock)
        # The admission map is published BEFORE the ingest: the ingest refuses a
        # refused lane's record before opening it, and it needs the map that describes
        # this run's topology.
        runner.publish_admission()
        runner.ingest_cache()
        if not args.watch:
            lanes, _inputs, _sessions = runner.lanes_and_inputs()
            ctx = runner.last_ctx
            doc = runner.document(lanes, ctx)
            _emit(render.to_markdown(doc, full=args.full, lane_key=args.lane) if args.markdown
                  else render.to_json(doc))
            runner.close()
            return EXIT_OK

        derive = WatchDeriver(args, policy, runner, clock=clock)

        def emit(doc: dict[str, Any], step: watch.WatchStep) -> None:
            doc["behold"]["watch"] = step.to_dict()
            text = render.to_markdown(doc, full=args.full, lane_key=args.lane) if args.markdown \
                else render.to_json(doc)
            _emit(text)

        steps = watch.run_watch(
            derive=derive,
            emit=emit,
            config=watch.WatchConfig(
                iterations=args.watch_iterations,
                interval_s=args.watch_interval,
                max_seconds=args.watch_max_seconds,
                events_file=args.events_file,
            ),
        )
        if args.verbose:
            for step in steps:
                sys.stderr.write(f"behold: watch {step.to_dict()}\n")
        runner.close()
        return EXIT_OK
    return EXIT_OK


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
