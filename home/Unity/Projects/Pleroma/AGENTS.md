# Pleroma space

This directory is the **Pleroma space** — the Unity game project. A lane whose cwd is here works on
the game: scenes, prefabs, scripts, shaders, materials, animation, build and player settings, and the
tests that cover them. Harness configuration (modes, profiles, skills, hooks, extensions, `AGENTS.md`
files) belongs to the yellowstone space; machine administration belongs to sysops. Work on another
application belongs to that application's space.

`~/AGENTS.md` is the fleet core and applies here in full. This file adds the game contract and does
not restate the core. `.pi/modes/{leader,worker}.json` carry the role duties, so a lane started with a
bare `pil` gets this directory's context but no role.

## The project

- Unity **6000.6.11f1** (revision `34837772f4f8`), URP 3D template, entry scene
  `Assets/Scenes/SampleScene.unity`. Unity **Personal** licence; studio **Evil Boy Games**.
- The editor and the licence are the operator's. A lane does not reinstall, re-license, or upgrade the
  editor as a side effect of another task.
- **This project is a git repository (branch `main`, local only — nothing has been pushed to a
  remote yet).** The worktree procedure applies: one worktree per worker. Large binary assets go
  through Git LFS (`.gitattributes`; policy in `Docs/asset-policy.md`) — do not commit a large
  binary asset outside LFS.

## Unity specifics that are not preferences

- **`.meta` files travel with their asset.** Never delete, regenerate or hand-edit a `.meta` on its own;
  a missing one re-imports an asset under a new GUID and silently breaks every reference to it.
- **Generated directories are never edited or committed** (once a repo exists): `Library/`, `Temp/`,
  `Logs/`, `obj/`, `UserSettings/`, and generated `*.csproj`/`*.sln`.
- **Scenes and prefabs are structured documents, not text to hand-merge.** Editing YAML by hand is a
  legitimate repair only when you can state the object it belongs to; otherwise change it through the
  editor.
- **A compile is not a play test.** A gameplay change is verified in play mode, or by an EditMode or
  PlayMode test that would fail without it. Report which one, and what it observed.
- **Serialization stays Force Text** so scene and prefab diffs are readable. Turning it off is a
  project-wide decision, not a local fix.

## Ask before

- changing the Unity version, the render pipeline, or the active build target;
- adding or removing packages in `Packages/manifest.json`;
- editing player-facing `ProjectSettings` (company and product name, quality, graphics, input,
  scripting defines) — these are the operator's product decisions;
- importing large or licensed binary assets;
- deleting an asset, scene or prefab that anything else might reference.

## Never

- Run a long editor operation on a machine the operator is using without stating what it will occupy.
- Report a scene, prefab or play-mode result you did not observe. "It compiles" is not a result.
- Signal a process by command-line pattern (`pkill -f 'Unity'` matches the shell running it); signal a
  pid read from `ps`, or use `~/.overlord/tools/proc-find.py`.
