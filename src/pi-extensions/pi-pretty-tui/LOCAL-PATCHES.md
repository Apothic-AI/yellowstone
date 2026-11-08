# Local fork of `pi-pretty-tui`

Vendored copy of [`pi-pretty-tui`](https://github.com/ykn0309/pi-pretty-tui) `@ 0.3.0`,
tracked in `~/.pi/agent/settings.json` as a local path package:

```
"../../Code/apothic-monorepo-workspace/tooling/pi-pretty-tui"
```

It exists because the npm release cannot coexist with
[bizzy](../bizzy) (background tasks), which is also installed in the same agent.

Current base: `0.3.0` (the release whose development baseline is Pi 1.3.0). It loads and
renders on Pi 1.4.0, which is what this agent runs.

## The conflict

bizzy owns the `bash` tool: it replaces Pi's definition so long-running commands can
background themselves (`run_in_background`, the auto-background timeout, Ctrl+Shift+B,
`/bg`). pretty-tui also registered a tool named `bash`.

Verified on Pi 1.4.0, the failure is *not* that the loser extension refuses to load.
`detectExtensionConflicts` in Pi's resource loader runs after every extension has loaded and
records a diagnostic per duplicate name, but `addExtensionConflictDiagnostics` explicitly
keeps all extensions loaded and lets load order decide the definition:

```js
// Keep all extensions loaded. Conflicts are reported as diagnostics,
// and precedence is handled by load order.
extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
```

The real damage is silent. `ExtensionRunner.getToolDefinition()` returns the *first*
extension's definition for a name, so when pretty-tui loads before bizzy it wins `bash`
outright and bizzy's schema disappears from what the model sees — `run_in_background` is
simply not in the tool's parameters any more, while bizzy still executes the calls. Reproduced
with a stand-in owner: pre-fix, `bash` resolved to pretty-tui's stock definition and
`run_in_background` was absent; post-fix, the owner's description and parameters survive and
pretty-tui still supplies the drawing. A `try`/`catch` around `pi.registerTool` cannot fix
this, because nothing throws.

## The change

Every built-in tool pretty-tui renders is **render-only**. `pi.registerToolRenderer` composes
instead of competing: resolvers run in extension load order, `next()` chains to the remaining
resolvers and finally to whichever extension owns the tool, and Pi's interactive mode feeds
the resolved object straight into `ToolExecutionComponent`. So claiming one tool name changes
only how that tool draws:

- pretty-tui registers **zero** tools, so it can never take a name from another extension;
- `bash` still renders pretty (`renderShell: "self"`) while bizzy's schema, description,
  prompt guidelines, and execution are untouched;
- every other tool resolves exactly as before.

Two pieces, both in `extensions/index.ts`:

1. A helper above `export default function prettyTui`:

   ```ts
   function registerRenderedTool(pi: ExtensionAPI, tool: { name?: string }, renderers: ToolRenderers): void {
     const toolName = tool.name;
     if (!toolName) throw new Error("registerRenderedTool needs a named tool definition");
     pi.registerToolRenderer((name, next) =>
       name === toolName ? { ...next(), ...renderers } : next(),
     );
   }
   ```

   The `{ ...next(), ...renderers }` merge is required, not cosmetic: the resolver's return
   value *is* the definition Pi renders with, so returning our renderers alone drops the
   owner's `name`, `description`, `parameters`, `label`, and any extra fields.

2. Upstream `0.3.0` funnels all seven built-ins (`read`, `bash`, `edit`, `write`, `grep`,
   `find`, `ls`) through one `registerStyledTool(definition)` helper, so the patch is a
   single call site: its `pi.registerTool({ ...definition, renderCall, renderResult })`
   becomes

   ```ts
   registerRenderedTool(pi, definition, {
     ...(definition.renderShell ? { renderShell: definition.renderShell } : {}),
     renderCall: (...args: any[]) => select("renderCall", args),
     renderResult: (...args: any[]) => select("renderResult", args),
   });
   ```

   `ToolRenderers` is `Pick<ToolDefinition, "renderShell" | "renderCall" | "renderResult">`,
   so the native/pretty `select()` swap keeps working unchanged.

The `0.2.8` base needed the same helper wired into seven separate call sites; `0.3.0`'s
refactor into `registerStyledTool` collapsed them into one, so this patch is now smaller than
it was.

Verified against Pi 1.4.0 by loading both extensions through Pi's real `loadExtensions()`:
pretty-tui contributes 7 renderer resolvers and **0** tools, bizzy keeps
`bash`, `bash_bg`, `jobs`, `agent_bg`, `monitor`, `detectExtensionConflicts` reports nothing,
and `read`/`bash`/`edit`/`write`/`grep`/`find`/`ls` resolve to pretty-tui renderers with
`renderShell: self` while `codemode` and everything else falls through to its owner.

## Upgrading from npm

1. Copy the new release over this tree, keeping `LOCAL-PATCHES.md` and `tsconfig.json`:

   ```bash
   npm pack pi-pretty-tui@<version> --pack-destination /tmp
   tar xzf /tmp/pi-pretty-tui-<version>.tgz -C /tmp
   cp -R /tmp/package/extensions/. extensions/
   cp /tmp/package/package.json /tmp/package/README*.md /tmp/package/LICENSE .
   ```

2. Re-apply the patch: add `type ToolRenderers` to the `@earendil-works/pi-coding-agent`
   import, add the `registerRenderedTool` helper above `export default function prettyTui`,
   and swap the `pi.registerTool(...)` call inside `registerStyledTool` for
   `registerRenderedTool(...)` as shown above. If a release ever reintroduces a direct
   `pi.registerTool` for one of the seven built-ins, convert that call site the same way.

3. Typecheck. The npm tarball ships no `tsconfig.json` and no `node_modules`, so this
   vendored copy carries its own `tsconfig.json` and `tsc` needs the Pi packages plus
   `@types/node` on its resolution path. Point a throwaway install at it and remove the
   link afterwards:

   ```bash
   npm i --prefix /tmp/pt-typecheck @types/node@22 typescript \
     @earendil-works/pi-coding-agent@<host pi version> @earendil-works/pi-tui@<host pi version>
   ln -sfn /tmp/pt-typecheck/node_modules node_modules
   /home/bitnom/.local/share/pnpm/tsc -p tsconfig.json   # or npx tsc
   rm -f node_modules
   ```

   `npm test` in `package.json` is upstream's script and references `tests/regression.mjs`,
   which the npm tarball does not ship; run it from an upstream checkout instead. Then start
   `pi` and confirm both extensions load with no `extension_error`.
