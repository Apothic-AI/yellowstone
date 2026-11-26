# beady-eye upstream PRs

Fork: `https://github.com/Apothic-AI/beady-eye` · clone `~/Code/beady-eye` (upstream remote wired, base `fa8516c`).
**Opened 2026-11-01T17:07Z on the operator's go: https://github.com/CodeForBreakfast/beady-eye/pull/537** (collector fix only; the session-kind change stays withdrawn). Authorisation: harness work is standing, but an outbound PR in the operator's name is escalated — the overlord asked, the operator said go.

---

## OPENED — PR #537, branch `fix/herdr-pane-fields` (commit `f9c9035`)

**Title**: Read herdr's current agent name and terminal title

**Body**:

> herdr 0.9.5 reports an agent's name in `name` and the row it is drawing in `terminal_title`. bdi's collector still asks for `display_agent` and `title`, and both are declared `#[serde(default)]`, so a current herdr silently deserializes them to `None`.
>
> Measured on a live 49-pane fleet: `display_agent: null` and `title: null` on **all 49 panes**, while `herdr agent list` reported a name and a terminal title for each of them. The effect is that every lane's name is blank and every caption falls back to nothing, which makes the dashboard read as an idle fleet. It is not a join problem — the collector never sees the fields.
>
> The change adds `name` and `terminal_title` to the collector's `Agent` struct and gives `Pane` a `name` field. `title` falls back to `terminal_title`, so captions draw again. The agent's name deliberately does **not** go into `display_agent`: that field means "the pane's own claim about the bead it is working" (`collect/agents.rs`), and a lane name is not such a claim. A provider that still sends `display_agent` or `title` keeps working.
>
> Tests: a new parse test against herdr's current wire shape (`name`, `terminal_title`, `kind: "path"` session); the fixture-based "pane that reported nothing" row now carries the title herdr reports, and that expectation is updated with the change.
>
> Verification: `cargo test --lib` on this branch produces **the identical failure set to `main`** — 42 failures, all present before the change, all environment-dependent (e.g. `collect::changes::tests::…` panics with `bdi is watching: Os { code: 2, kind: NotFound }`), 2444 passing. No new failures.
>
> Diff: 3 files, +45/−5.

**As opened** (kept for the record; the PR body led with the fact that this breaks every bdi user on current herdr, not just this fleet):

```bash
cd ~/Code/beady-eye && git push -u origin fix/herdr-pane-fields
gh pr create --repo CodeForBreakfast/beady-eye \
  --head Apothic-AI:fix/herdr-pane-fields \
  --title "Read herdr's current agent name and terminal title" \
  --body-file <this section>
```

---

## WITHDRAWN — branch `fix/session-kind-path`

I recommended this upstream as "one line". The suite says otherwise, so it is not being proposed as-is.

The change made `Pane::agent_session_id()` accept `kind: "path"` as well as `kind: "id"`, so a bead could name a pi lane's session. One test failed, and it is a **deliberate** upstream invariant, not an oversight:

```rust
/// A session of another kind is not the agent's id, so it never matches
/// the one a bead names, even where the two read the same.
#[test]
fn a_session_of_another_kind_is_not_the_agent_session_a_bead_names() {
    let live = panes(r#"{"pane_id":"w:p1", … "agent":"claude",
        "agent_session":{"agent":"claude","kind":"path","source":"herdr:claude",
                         "value":"sess-mine"}}"#);

    let joined = join_one(r#"{"agent_session":"sess-mine"}"#, &live);

    assert_eq!(joined.agents, BTreeMap::new());
}
```

So upstream intends the agent-session join key to be an *id*, and a path-kind session to be inert. Reversing that is a behaviour change to a join rule, not a bug fix, and the maintainers would be right to want a rationale beyond "our fleet uses paths".

If it is ever revisited, the reviewable form is an opt-in rather than a default: a `[join] agent_session_kinds` setting defaulting to `["id"]`, plumbed into the five `agent_session_id()`/`live_agent_session()` call sites in `join.rs`, leaving the existing test true by default. That is a real change — config surface, validation, docs, and a test for both settings — not a one-liner, and it buys this fleet nothing: the `agent_pane` stamp is the more durable key here (a session path goes stale at every restart; a pane id only on a move).

Branch exists locally as `fix/session-kind-path` (`fabb4ed`) with the test added; it is not pushed. Delete it or keep it as a starting point — the analysis above is the useful part.

---

## What the fleet would need, if the ready PR is ever merged

Nothing. The change only affects what bdi displays; it creates no joins and needs no metadata. A bdi built from this branch would show lane names and captions immediately on the next `bdi` run, with no lane restarts and no config change. The `agent_pane` stamp remains the attribution mechanism either way.