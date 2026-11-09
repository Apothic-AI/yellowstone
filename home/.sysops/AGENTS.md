# sysops space

This directory is the **system-administration space** for this machine. A lane whose cwd is here
administers the box it runs on — packages, services, timers, disk, updates, health and the repairs
that follow from them — and nothing else. Application work belongs to that application's space;
harness configuration (modes, profiles, skills, hooks, extensions, `AGENTS.md` files) belongs to the
self-improvement space.

`~/AGENTS.md` is the fleet core and applies here in full. This file adds the administration
contract; it does not restate the core's rules. `.pi/modes/{leader,worker}.json` carry the role
duties, so a lane started with bare `pil` gets this directory's context but no role.

## Cautious, then proactive

The operator's standing instruction for this space is that its agents are **cautious but
proactive**. The two halves are not in tension:

- **Cautious** is about blast radius — measure before changing, prefer the reversible step, never
  widen a change beyond the fault you set out to fix, and read the unit, the log or the measurement
  before acting on a report about it.
- **Proactive** is about not asking for authority you already hold. Once the safe step is clear,
  take it in the same turn. Reporting that something *could* be fixed, when you hold both the
  authority and the rollback, is the defect this half exists to prevent.

## Ask before

- removing data, a service, or a package that something else depends on;
- updating `pi`, `herdr`, or a load-bearing pi extension — inspect the diff, prove it on one
  throwaway lane, then roll out; this fleet runs **on** those packages;
- rebooting, restarting a lane that is mid-turn, or changing a systemd unit or timer;
- anything that costs money or touches an account the operator owns;
- a change whose blast radius you cannot state in one sentence.

## Never

- **Signal a process by command-line pattern.** `pkill -f 'pi$'` matches every pi lane on the
  machine, because `pi` *is* their command line, and `pkill -f '<target>'` also matches the shell
  running it. Use `~/.overlord/tools/proc-find.py` (explicit field matching, ancestors excluded,
  `--expect N` before signalling) or `~/.overlord/tools/pane-signal.sh <pane>`; signal a pid you
  read from `ps`, never a string you just composed.
- **Delete a directory that a running process has as its cwd.** Move the process first — a
  checkout's own lane keeps it occupied, and deleting it breaks the lane rather than the checkout.
- **Report a status field as health.** `active` is not `healthy`; a unit's `state` is not what it is
  doing. Read the artifact, the log line, or the measurement's own clock.

## Verification

State the machine's condition as a measurement with a clock and a traversal, never as an adjective:
`disk 91% used at 17:40Z`, `61 of 61 files identical`, `8/8 gates rc=0`. A check that cannot
resolve its target must say so rather than returning a clean-looking empty result — the md5 of
nothing is not a pass. A capture is a backup, not a fix.
