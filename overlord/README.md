# Overlord

`~/.overlord` is the working directory of the **overlord** herdr space: the
parent orchestrator that coordinates the coding-agent orchestrators running in
the other herdr spaces.

`AGENTS.md` beside this file is the instruction set for that role. This file is
the index it reads and updates.

The space carries two tabs, each hosting one pi agent: **`overlord`** (the
orchestrator that reads `AGENTS.md`) and **`comms`** (the operator-facing channel
for chat, email, SMS and voice). Both are created and checked by
`scripts/overlord.sh`.

## How the two files relate

- **[`AGENTS.md`](AGENTS.md)** — the role, its boundaries, and the hard-won
  operating rules: what to verify before prompting an agent, how to read agent
  state without fooling yourself, how to own a dagr run correctly, what never to
  do without being asked.
- **This file** — the live map: which herdr space corresponds to which directory
  here, and a dated record of when that map was last checked against reality.

Neither is a project record. Plans, code, test results and dagr run files belong
to the project that owns them; link to those rather than copying them here.

## The map

One direct child directory per herdr space, named `<workspace-id>-<label>`.
Each holds that space's orientation and its own orchestration records.

| herdr space | Context directory | Role |
|---|---|---|
| `<id>` — `<label>` | [`<id>-<label>/`](<id>-<label>/) | one line on what this space is for |

Start with no rows. The operator populates this table as spaces are brought
under orchestration; an empty table means the index has not been built yet, not
that there are no spaces.

## Conventions

**Workspace ids and labels are a dated snapshot, never a live truth.** herdr
assigns ids; operators rename spaces. Refresh topologically before addressing an
agent or acting on a space, and record the date of every observation in this
file. If a space is renamed or closed, update its row and its child directory
README — do not silently repurpose a directory for a different workspace.

**Record what kind of claim each entry is.** User instruction, live herdr
observation, agent self-report, and independently verified evidence are four
different things. Say which one you are relying on. `unknown` is not `idle`, and
a status field is not proof that code or a deployment is complete.

**A closed run is a historical record.** When a space is retired, keep its
directory and mark its row as removed, with the date and why. Deleting the
record destroys the only provenance the orchestration had.

**Keep the index honest about its own age.** The topology section below is a
claim about a moment. If it is stale, say so rather than letting a reader assume
it was just written.

## Topology

Record each verification here, newest first, with the date and what
`herdr workspace list` actually returned:

```
- **<date>Z** — live `herdr workspace list` returned N workspaces: ...
```

No entries yet: the index has not been verified against a running herdr since it
was created.

## Boundaries

- Do not copy credentials, tokens, personal account data, private activation
  URLs, or raw secrets into this tree. Reference them where they already live.
- Do not edit a project, prompt an agent, change herdr layout, or start and stop
  resources merely to keep this index current. The index follows the work; it
  does not cause it.
- The same authorization does not need to be given twice. Once the operator
  scopes the work, that scope stands until they change it.
