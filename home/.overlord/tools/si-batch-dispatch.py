#!/usr/bin/env python3
"""si-batch-dispatch.py — run a batch of worker jobs, serialized per REPOSITORY.

Why this exists
---------------
The 2026-11-17 push serialized jobs by the *cwd* each worker was spawned in. FT-74's worker had cwd
`~/Documents/Fleet` and did its work inside the yellowstone tree; its `git commit --amend` raced an
FT-72 lane in that shared checkout and replaced that lane's commit **subject**. A cwd is where a
lane starts, not where it writes, so a cwd-keyed lock protects nothing: two jobs writing one
repository from two different cwds both found the lock free. `~/Documents/Fleet` is not even a git
repository, so the FT-74 and FT-72 jobs shared one *fake* resource name and neither held the
checkout they were both writing.

What this file keys on
---------------------
* A job DECLARES the repository it will write (`"repo"`). A job that intends to commit
  (`"commits": true`) is REFUSED without one. The declaration is required rather than inferred
  because the one thing a dispatcher cannot know is where an agent will decide to write.
* The declaration is RESOLVED, never taken literally: `git rev-parse --path-format=absolute
  --git-common-dir` gives the repository's common git dir, so every worktree of one repository
  shares one lock. Two worktrees are not isolation for a commit: they share refs and the object
  database, which is what a rewrite corrupts.
* The lock itself is a lockfile INSIDE the repository — `<common-dir>/si-batch-dispatch.lock` — so
  it is outside the working tree (never in `git status`, cannot be committed) and travels with the
  repository rather than with whichever dispatcher happened to start the job. Holding is `flock`,
  so the kernel releases it when the holder dies: no stale lock, no cleanup tool, no pid guessing.
* A job's cwd repository is locked as well, even when it declared a different one. Writing outside
  the declaration is a defect, and the second lock is what makes that defect *wait* instead of
  racing.
* Lock acquisition is all-or-nothing and in sorted order, so two jobs that need each other's
  repositories in opposite order cannot deadlock — a job with any busy lock takes none and retries.

Usage
-----
  si-batch-dispatch.py --jobs SPEC.json [--concurrency N] [--check]
  si-batch-dispatch.py --jobs SPEC.json --briefs-only

  --check         resolve and print every job's lock set; spawn nothing. Run this first.
  --briefs-only   write each job's brief and exit; spawn nothing.
  --spawn CMD     the spawner to use (default ~/.overlord/tools/spawn-lane); tests stub it.
  --root DIR      where briefs and REPORT.md live (default: spec's "root", or this script's dir).

Job spec (JSON)
---------------
  {
    "workspace": "w1K",
    "concurrency": 3,
    "timeout": 2700,
    "root": "/home/bitnom/.local/state/si-batch-20261117",
    "doc": "/home/bitnom/Documents/Assistant/Fleet TODOs.md",
    "jobs": [
      {"slug": "ft74", "label": "si-ft74-build",
       "cwd": "/home/bitnom/Documents/Fleet",
       "repo": "/home/bitnom/Code/yellowstone",     <- the repository it may write
       "commits": true,                              <- true requires "repo"
       "heading": "FT-74", "intent": "..."}
    ]
  }

Completion is the job's REPORT.md, as before: the dispatcher never reads a screen and never trusts a
status field. Corrections are forward-only; see docs/operations.md, "A collision is corrected
forward".
"""
from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_SPAWN = "/home/bitnom/.overlord/tools/spawn-lane"
DEFAULT_DOC = "/home/bitnom/Documents/Assistant/Fleet TODOs.md"
LOCK_NAME = "si-batch-dispatch.lock"

RULES = """\
## Rules you must not break

- Never signal a process by a command-line pattern (`pkill -f ...` kills the fleet, including the
  shell that typed it). A pid read from `ps`, `proc-find.py`, or `pane-signal.sh` only.
- Never hand-edit `~/.pi/agent/mode-approvals.json`; it is the interactive prompt's cache.
- Do not read another lane's screen with `herdr agent read` — use its session file, `behold roster`,
  or a DM. If you must, use `~/.overlord/tools/pane-read --reason "<why>"` and never in a loop.
- A status field, a counter, or an exit code is not evidence that an outcome happened. Judge
  delivery by the target's own session record.
- Stay in your item. Do not modify another issue's section of the doc, another space's config, or
  anything outside the repositories named in your brief.
- Landing work means: tests or a live proof, then commit and push with the mirror gate green
  (`bash test/verify-mirror-live.sh` from the yellowstone repo root).
- **A collision is corrected forward.** Never force-push a shared branch to hide one. If your commit
  replaced another lane's, land a new commit that restores it and says what happened, and record the
  incident — rewriting published history to look tidy destroys the only evidence of the collision.
"""


# --------------------------------------------------------------------------- git


def git(args: list[str], cwd: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], capture_output=True, text=True, cwd=cwd, timeout=120)


def resolve_common_dir(path: str) -> str | None:
    """The repository's common git dir for `path`, or None if it is not inside a repository.

    The common dir is the right identity for a lock: every worktree of one repository resolves to
    the same path, which is what makes a worktree a convenience rather than an isolation boundary.
    """
    if not path or not Path(path).exists():
        return None
    res = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=path)
    if res.returncode != 0:
        return None
    common = res.stdout.strip()
    return common or None


def resolve_toplevel(path: str) -> str | None:
    if not path or not Path(path).exists():
        return None
    res = git(["rev-parse", "--path-format=absolute", "--show-toplevel"], cwd=path)
    if res.returncode != 0:
        return None
    top = res.stdout.strip()
    return top or None


def head_of(common_dir: str) -> str:
    """HEAD as seen from a repository, for the record: the lock is not evidence a write happened."""
    res = git(["--git-dir", common_dir, "rev-parse", "--short", "HEAD"])
    return res.stdout.strip() if res.returncode == 0 else "(no HEAD)"


# --------------------------------------------------------------------------- lock


class RepoLock:
    """An flock on a lockfile inside the repository's own git dir.

    flock, not a pidfile: the kernel drops it when the holder dies, so a killed dispatcher cannot
    leave a lock that only a human can clear. The file records who holds it so a waiter can say so
    by name instead of "busy".
    """

    def __init__(self, common_dir: str):
        self.common_dir = common_dir
        self.path = Path(common_dir) / LOCK_NAME
        self.fd: int | None = None

    def try_acquire(self, holder: dict) -> bool:
        try:
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o644)
        except OSError:
            return False
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            os.close(fd)
            if exc.errno in (errno.EACCES, errno.EAGAIN):
                return False
            raise
        try:
            os.ftruncate(fd, 0)
            os.write(fd, (json.dumps(holder) + "\n").encode())
            os.fsync(fd)
        except OSError:
            pass
        self.fd = fd
        return True

    def holder(self) -> str:
        try:
            return self.path.read_text().strip() or "unknown holder"
        except OSError:
            return "unknown holder"

    def release(self) -> None:
        if self.fd is None:
            return
        try:
            os.ftruncate(self.fd, 0)
            fcntl.flock(self.fd, fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            os.close(self.fd)
            self.fd = None


# --------------------------------------------------------------------------- jobs


@dataclass
class Job:
    slug: str
    label: str
    cwd: str
    heading: str
    intent: str
    repo: str | None = None
    commits: bool = False
    # filled during preparation
    lock_dirs: list[str] = field(default_factory=list)
    locks: list[RepoLock] = field(default_factory=list)
    heads: dict[str, str] = field(default_factory=dict)
    waiting_for: str = ""
    refusal: str = ""

    @classmethod
    def from_dict(cls, raw: dict) -> "Job":
        return cls(
            slug=raw["slug"], label=raw["label"], cwd=raw["cwd"],
            heading=raw.get("heading", raw["slug"]), intent=raw.get("intent", ""),
            repo=raw.get("repo") or None, commits=bool(raw.get("commits", False)),
        )

    def prepare(self) -> None:
        """Resolve the declared repository and the cwd repository into a lock set.

        The declaration is what the job is *allowed* to write; the cwd repository is where it
        *starts*. Both are locked, because the FT-74 failure was exactly a job whose cwd and work
        were in different repositories.
        """
        declared = resolve_common_dir(self.repo) if self.repo else None
        if self.repo and declared is None:
            self.refusal = (f"declared repo {self.repo!r} does not resolve to a git repository "
                            f"(git rev-parse --git-common-dir failed)")
            return
        if self.commits and not self.repo:
            self.refusal = ("commits=true but no repo declared — a job that intends to commit must "
                            "name the repository it will commit into")
            return
        cwd_repo = resolve_common_dir(self.cwd)
        dirs: list[str] = []
        if declared:
            dirs.append(declared)
        if cwd_repo and cwd_repo not in dirs:
            dirs.append(cwd_repo)
        self.lock_dirs = sorted(dirs)
        self.heads = {d: head_of(d) for d in self.lock_dirs}


# --------------------------------------------------------------------------- logging


class Log:
    def __init__(self, root: Path):
        self.root = root
        self.path = root / "dispatch.log"

    def __call__(self, msg: str) -> None:
        line = f"{time.strftime('%H:%M:%SZ', time.gmtime())} {msg}"
        print(line, flush=True)
        with self.path.open("a") as fh:
            fh.write(line + "\n")


# --------------------------------------------------------------------------- brief


def write_brief(root: Path, doc: str, job: Job) -> Path:
    d = root / job.slug
    d.mkdir(parents=True, exist_ok=True)
    report = d / "REPORT.md"
    if job.commits:
        repo_section = (
            f"Declared repository: `{job.repo}` — this job **intends to commit**, so the dispatcher\n"
            f"holds that repository's exclusive lock for the whole job and refused to start it\n"
            f"without the declaration. Its cwd is `{job.cwd}`, which is not where it writes.\n")
    elif job.repo:
        repo_section = (
            f"Declared repository: `{job.repo}` — the dispatcher holds its lock for this job's\n"
            f"duration. Its cwd is `{job.cwd}`.\n")
    else:
        repo_section = (
            "No repository declared, so this job **must not commit or push anywhere**. If it turns\n"
            "out that it must, stop and report that instead: the dispatcher refuses undeclared\n"
            "commit jobs on purpose, and writing into an unlocked repository is how the FT-74\n"
            "amendment replaced an FT-72 lane's commit subject on 2026-11-17.\n")

    text = f"""# {job.heading} — worker brief

You are `{job.label}`, a worker in the self-improvement space. One issue, end to end.

## The item

`{doc}` — find the heading `## {job.heading}` and read the whole entry, including every note the
operator has appended to it. The notes are instructions, and they are newer than the body.

## What is wanted

{job.intent}

## The repository this job may write

{repo_section}
Work where your item does, not where you were spawned. A pull request, a commit or a push into any
repository you did not declare is a defect even when it is correct — another lane is writing the
same tree, and the lock only covers what was declared.

## Deliverable

Write `{report}` as your **last act**, and only after the work it describes is done. It must
contain: what you found (with the evidence you actually observed), what you changed (paths and
commit shas), how you proved it (the command and its outcome, or the live observation), what you
could not do and why, and what a successor must know. A report that claims success without a
command or a record behind it is worse than no report.

Work in `{job.cwd}`.

{RULES}"""
    (d / "brief.md").write_text(text)
    return d / "brief.md"


# --------------------------------------------------------------------------- spawn


def spawn(spawn_cmd: str, workspace: str, job: Job, brief_path: Path, root: Path) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    # Named for the spawner's own use (tests read them; a real spawner may ignore them). They are
    # not a contract for the lane: the lane learns its repo from the brief.
    env["SI_DISPATCH_SLUG"] = job.slug
    env["SI_DISPATCH_REPORT"] = str(root / job.slug / "REPORT.md")
    env["SI_DISPATCH_REPO"] = job.repo or ""
    return subprocess.run(
        [spawn_cmd, "--workspace", workspace, "--label", job.label, "--role", "worker",
         "--cwd", job.cwd, "--prompt-file", str(brief_path), "--json"],
        capture_output=True, text=True, timeout=300, env=env,
    )


# --------------------------------------------------------------------------- run


def prepare_all(jobs: list[Job], log: Log) -> tuple[list[Job], list[Job]]:
    ok: list[Job] = []
    refused: list[Job] = []
    for job in jobs:
        job.prepare()
        if job.refusal:
            log(f"REFUSE {job.slug} ({job.label}) {job.refusal}")
            refused.append(job)
            continue
        if not job.lock_dirs:
            log(f"NOTE {job.slug} ({job.label}) no repository declared and cwd is not a git "
                f"repository — this job runs UNLOCKED; it must not commit")
        else:
            resolved = ", ".join(resolve_toplevel(d) or d for d in job.lock_dirs)
            log(f"RESOLVE {job.slug} ({job.label}) cwd={job.cwd} declared={job.repo or '(none)'} "
                f"lock={resolved}")
            if job.repo and resolve_common_dir(job.cwd) and \
                    resolve_common_dir(job.cwd) != resolve_common_dir(job.repo):
                log(f"NOTE {job.slug} cwd repository differs from the declared repository — both "
                    f"are locked, and a write to the cwd one is a defect")
        ok.append(job)
    return ok, refused


def try_take(job: Job, log: Log) -> bool:
    """All-or-nothing, in sorted order: no partial sets, so no deadlock between two jobs."""
    locks: list[RepoLock] = []
    holder = {"slug": job.slug, "label": job.label, "pid": os.getpid(),
              "since": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    for d in job.lock_dirs:
        lock = RepoLock(d)
        if lock.try_acquire(holder):
            locks.append(lock)
            continue
        waiter = lock.holder()
        for held in locks:
            held.release()
        note = f"{d} (held by {waiter})"
        if job.waiting_for != note:
            log(f"WAIT {job.slug} ({job.label}) for {note}")
            job.waiting_for = note
        return False
    job.locks = locks
    job.waiting_for = ""
    return True


def release(job: Job) -> None:
    for lock in job.locks:
        lock.release()
    job.locks = []


def run(spec: dict, args) -> int:
    root = Path(args.root or spec.get("root") or Path(__file__).resolve().parent)
    root.mkdir(parents=True, exist_ok=True)
    log = Log(root)
    doc = spec.get("doc") or DEFAULT_DOC
    workspace = spec.get("workspace", "w1K")
    concurrency = int(args.concurrency or spec.get("concurrency", 3))
    timeout = int(args.timeout or spec.get("timeout", 45 * 60))
    spawn_cmd = args.spawn or spec.get("spawn") or DEFAULT_SPAWN
    jobs = [Job.from_dict(raw) for raw in spec["jobs"]]

    if args.check or args.briefs_only:
        ok, refused = prepare_all(jobs, log)
        for job in ok:
            if not args.check:
                log(f"BRIEF {job.slug} {write_brief(root, doc, job)}")
        if args.check:
            for job in ok:
                print(json.dumps({
                    "slug": job.slug, "cwd": job.cwd, "declared_repo": job.repo,
                    "commits": job.commits,
                    "lock_dirs": job.lock_dirs,
                    "lock_paths": [str(Path(d) / LOCK_NAME) for d in job.lock_dirs],
                    "heads": job.heads,
                }))
            for job in refused:
                print(json.dumps({"slug": job.slug, "refused": job.refusal}))
        return 1 if refused else 0

    started = time.time()
    pending, refused = prepare_all(jobs, log)
    active: dict[str, tuple[float, Job]] = {}
    failed = [job.slug for job in refused]
    log(f"dispatch start: {len(pending)} jobs, concurrency {concurrency}, root {root}")

    while pending or active:
        while pending and len(active) < concurrency:
            pick = None
            for i, job in enumerate(pending):
                if try_take(job, log):
                    pick = i
                    break
            if pick is None:
                break
            job = pending.pop(pick)
            path = write_brief(root, doc, job)
            report = root / job.slug / "REPORT.md"
            if report.exists():
                report.unlink()
            res = spawn(spawn_cmd, workspace, job, path, root)
            if res.returncode != 0:
                err = (res.stderr or res.stdout or "").strip().splitlines()
                log(f"SPAWN-FAIL {job.slug} ({job.label}) rc={res.returncode} "
                    f"{err[-1] if err else ''}")
                release(job)
                failed.append(job.slug)
                continue
            active[job.slug] = (time.time(), job)
            log(f"START {job.slug} lane={job.label} cwd={job.cwd} "
                f"repo={job.repo or '(none)'} locks={len(job.locks)}")

        time.sleep(float(args.poll or 20))

        for slug in list(active):
            began, job = active[slug]
            report = root / slug / "REPORT.md"
            done = report.exists() and report.stat().st_mtime >= began - 5
            late = time.time() - began > timeout
            if not done and not late:
                continue
            if done:
                log(f"DONE {slug} ({job.label}) report={report.stat().st_size}B "
                    f"after {int(time.time() - began)}s")
            else:
                log(f"TIMEOUT {slug} ({job.label}) after {timeout}s — no REPORT.md")
                failed.append(slug)
            for d in job.lock_dirs:
                after = head_of(d)
                before = job.heads.get(d, "?")
                state = "unchanged" if after == before else f"{before}->{after}"
                log(f"HEAD {slug} {resolve_toplevel(d) or d} {state}")
            release(job)
            del active[slug]

    log(f"dispatch end: {len(jobs) - len(failed)}/{len(jobs)} ok, failed={failed} "
        f"elapsed={int(time.time() - started)}s")
    return 0 if not failed else 1


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Dispatch batch jobs, one lock per repository.")
    ap.add_argument("--jobs", required=True, help="job spec JSON file ('-' for stdin)")
    ap.add_argument("--root", help="state dir for briefs, REPORT.md and dispatch.log")
    ap.add_argument("--concurrency", type=int, help="jobs running at once (default 3)")
    ap.add_argument("--timeout", type=int, help="seconds per job before TIMEOUT (default 2700)")
    ap.add_argument("--spawn", help=f"spawner command (default {DEFAULT_SPAWN})")
    ap.add_argument("--poll", type=float, help="seconds between checks (default 20)")
    ap.add_argument("--check", action="store_true", help="print resolved lock sets, spawn nothing")
    ap.add_argument("--briefs-only", action="store_true", help="write briefs, spawn nothing")
    args = ap.parse_args(argv)

    text = sys.stdin.read() if args.jobs == "-" else Path(args.jobs).read_text()
    return run(json.loads(text), args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
