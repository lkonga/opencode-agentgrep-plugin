# opencode-agentgrep

**v0.1.0** — Standalone OpenCode backend plugin exposing the
[`agentgrep`](https://github.com/1jehuang/agentgrep) CLI (pinned **v0.1.6**) as
native `Hooks.tool` `ToolDefinition`s: canonical `agentgrep`, legacy aliases
`file_grep` / `Grep`, and a first-class `find` id (the model-facing replacement
for the disabled native `glob` tool). It replaces an agent's first noisy burst
of `rg` + file listing + repeated reads with one compact, structured search
packet — grep, ranked file discovery, file outlines, and the trace DSL.

No fork patches, no opencode-patches dependency. The plugin is a plain package
that can be installed from npm or loaded from a local directory via `file://`.

## Quick start

1. **Build the CLI** (user-local, no sudo, no host packages):

   ```bash
   bash scripts/install-agentgrep.sh
   ```

   Pinned to `1jehuang/agentgrep` **v0.1.6** (`b01b804008ab0662fa14e6b60b10bff61716e6f1`),
   atomically installed to `$HOME/.local/bin/agentgrep` — the **documented
   packaged default** the plugin resolves after `$AGENTGREP_BIN` and before
   `$PATH`. Verify: `~/.local/bin/agentgrep --version` → `agentgrep 0.1.6`.
   The installer is idempotent (`AGENTGREP_SKIP_BUILD=1` + existing binary skips
   the build) and refuses a mismatched clone.

2. **Enable the plugin**. npm (recommended):

   ```jsonc
   {
     "plugin": ["@lkonga/opencode-agentgrep"],
     "tools": {
       "grep": false,
       "glob": false
     }
   }
   ```

   …or a local directory `file://` plugin (no npm needed):

   ```jsonc
   {
     "plugin": ["file:///home/lkonga/codes/opencode-plugins/opencode-agentgrep"],
     "tools": {
       "grep": false,
       "glob": false
     }
   }
   ```

   A directory `file://` plugin resolves through `package.json` `"main"` →
   `./index.ts`. Restart OpenCode after installing or changing the plugin.

3. **Disable the native search tools** so the replacement is total (leaving
   either enabled makes it partial). With swap: `swap tool disable grep` /
   `swap tool disable glob`.

## Requirements

- OpenCode (plugin API) — the plugin pins `@opencode-ai/plugin@1.18.21` for
  `tool` / `tool.schema` (zod v4 shapes the server registry recognizes).
- The `agentgrep` v0.1.6 binary (installed by `scripts/install-agentgrep.sh`,
  or set `AGENTGREP_BIN` to a prebuilt binary). No network is needed at
  runtime — everything shells out to the local binary.

## Module layout (IMPORTANT)

OpenCode's plugin loader treats **every module export** as a plugin instance:
`getLegacyPlugins` iterates `Object.values(mod)` and throws
`TypeError("Plugin export is not a function")` for any export that is not a
plugin function (or a `{ server }` record). A `.ts` plugin whose entrypoint
also exports constants/helpers therefore fails to load at startup.

- **`index.ts`** — the loader entrypoint. Its **only** export is the default
  plugin function (`async () => ({ tool })`). Nothing else may be exported
  from this file.
- **`agentgrep-core.ts`** — compatibility **barrel / orchestrator** that
  re-exports every public helper from the focused modules, so tests and
  adapters keep a single import surface. (Not a plugin entrypoint.)
- **`agentgrep-types.ts`** — contract: tool-id constants, `AgentGrepInput` /
  `AgentGrepMode`, mode normalization, and match-all glob normalization. Pure.
- **`agentgrep-args.ts`** — exact-file scope translation, find term splitting,
  the pure `buildAgentGrepArgs` argv builder, and the permission operation
  patterns (which MUST match the split argv positionals). Pure.
- **`agentgrep-tools.ts`** — OpenCode schemas (`tool.schema` zod v4),
  descriptions, the shared execute orchestration (permission asks → canonical
  roots → argv → bounded spawn), and the registry builder.
- **`agentgrep-paths.ts`** — canonical root resolution, project containment,
  and native-shaped `external_directory` requests.
- **`agentgrep-exec.ts`** — executable resolution and bounded process
  execution.
- **`agentgrep.test.ts` / `agentgrep-execute.test.ts`** — the deterministic
  suite (pure argv/schema + real `ToolDefinition.execute` through a fake CLI
  harness + permission/traversal/symlink + timeout/output-cap + optional
  real-CLI smoke).
- **`scripts/install-agentgrep.sh`** — pinned, idempotent CLI installer.

## Schema & parity (jcode v0.1.6)

The tool schema mirrors **jcode's public `parameters_schema`** exactly. Public
args on `agentgrep` (key order fixed):

| Arg | Type | Notes |
|---|---|---|
| `mode` | enum `grep\|find\|outline\|trace` | Defaults to `grep`. `smart` is NOT public. |
| `query` | string? | Required for grep (literal unless `regex=true`); optional ranking terms for find. |
| `file` | string? | Single file to inspect. Required for outline. |
| `terms` | string \| string[]? | Trace DSL terms (e.g. `subject:auth_status relation:rendered`), or query parts for find. |
| `regex` | boolean? | grep only: treat query as a regex. |
| `path` | string? | Directory **or file** to search. File-valued → searches only that exact file. Defaults to the session directory. |
| `glob` | string? | File glob filter such as `**/*.rs`. Match-all forms are normalized away. |
| `type` | string? | **Public name** (jcode wire name) — NOT `file_type`. ripgrep type filter (rs, py, js, ts, md…). |
| `max_files` | int? | find/trace result bound; CLI-side defaults 10/5. |
| `max_regions` | int? | trace region bound; CLI-side default 6. |
| `paths_only` | boolean? | Return only matching paths where supported. |

The `find` id exposes the find-relevant subset: `query, terms, path, glob,
type, max_files, paths_only` (no `mode` — the id itself forces find mode).

**Deliberately internal (accepted at runtime, never advertised in the schema):**
`pattern`, `file_path`, `include`, `hidden`, `no_ignore`, `full_region`,
`debug_plan`, `debug_score`, `max_items`, and the `smart` mode value. These are
jcode's serde-internal fields/aliases — accepted for compatibility, but the
model is only told about the public surface above. Nothing is publicly
conflated with jcode's hidden controls.

### Strict public `trace` vs hidden `smart`

- Public mode enum: **exactly** `grep|find|outline|trace` (jcode
  `parameters_schema`). No `smart`.
- `smart` is accepted **internally only** as a trace alias (agentgrep v0.1.6
  declares `smart` as a `visible_alias` of `trace`) and additionally enables
  jcode's internal query-splitting fallback: `smart` + multiword `query` →
  whitespace-split positional terms. Plain `trace` requires explicit `terms`.

### Mode-specific flag validity (CLI-accepted flags only)

| Flag | grep | find | outline | trace |
|---|---|---|---|---|
| `--regex` | ✓ | – | – | – |
| `--type` | ✓ | ✓ | – | ✓ |
| `--max-files` | – | ✓ | – | ✓ |
| `--max-regions` | – | – | – | ✓ |
| `--full-region` | – | – | – | ✓ |
| `--paths-only` | ✓ | ✓ | – | ✓ |
| `--hidden` / `--no-ignore` | ✓ | ✓ | – | ✓ |
| `--glob` | ✓ | ✓ | – | ✓ |
| `--path` | ✓ | ✓ | ✓ | ✓ |
| `--max-items` | – | – | ✓ (internal) | – |
| `--debug-plan` / `--debug-score` | – | debug-score | – | ✓ / ✓ |

`buildAgentGrepArgs` emits a flag only where the CLI accepts it, so argv never
triggers an unknown-flag clap error (e.g. `outline` + `--type` → clap exit 2).

## Behavioral guarantees

- **Exact-file grep path containment.** A file-valued `path` (or `file` used as
  a grep/find/trace scope) is translated to a canonical **parent-root +
  basename-glob** scope (`--path <parent> --glob <basename>`, jcode
  `resolved_search_scope`), so a search hits **only that canonical file and
  never a sibling**. Only *existing* files trigger this (jcode `is_file()`);
  nonexistent leaves stay directory roots.
- **Find multiword terms.** `query` / string `terms` split on whitespace into
  positional terms (jcode `query.split_whitespace()`); array terms flatten and
  split per element. **Permission operation patterns use the same split terms**.
- **Find scoped-only / scoped-empty.** A find with no terms but a real scope
  (glob/type/path/file) bridges the CLI's required positional with an empty
  term — it runs and returns scope-filtered files. An empty scope (empty dir,
  glob matching nothing) returns exit 0 with `top files: 0`. A find with
  neither terms nor a narrowing scope is a friendly "invalid arguments" result.
- **Match-all glob normalization.** `*`, `**`, `**/*`, `./*`, `./**`, `./**/*`
  mean "no filter" and are dropped before reaching the CLI — v0.1.6 returns
  false empties for some of those forms (e.g. `./*`).
- **Outline file-vs-path.** `file` resolves relative to a **directory-valued**
  `path` root; a **file-valued** `path` IS the outline target (jcode).
- **Bounded execution.** Runs are killed after a default **30s** timeout
  (`AGENTGREP_TIMEOUT_MS`) and output is capped at **200000 chars**
  (`AGENTGREP_MAX_OUTPUT_CHARS`), with process-tree kill on either bound and
  abort honored. Result bounds are also enforced **CLI-side where the CLI
  supports flags**: find defaults to `--max-files 10`, trace to `--max-files 5`
  + `--max-regions 6`. grep has no CLI result-count flag, so it relies on the
  wrapper output cap + timeout (the "truncation/caps" branch). There is no
  unbounded scan: every run is killed on the output cap or the timeout.
- **No shell interpolation.** argv is assembled by the pure
  `buildAgentGrepArgs` and passed to `Bun.spawn` as an array. `mode`, file
  paths, globs and terms can never leak through a shell.

## Permissions & safety

- Every invocation asks the canonical `agentgrep` permission with the
  operation pattern(s) (split search terms for find) and `always: ["*"]`.
- Relative roots resolve against `ctx.directory`; existing symlinks and
  traversal are canonicalized before containment checks. Roots outside
  `ctx.directory` and the valid project worktree require the native
  `external_directory` permission (canonical parent-dir glob + filepath/
  parentDir metadata, duplicate asks coalesced per parent dir).
- Denials **reject** execute (they are not converted to tool results), so a
  denied call never spawns the agentgrep process.
- The registry intentionally has **no `grep` id and no `glob` id**:
  `tools.grep=false` / `tools.glob=false` filter every tool with those exact
  ids, so grep/glob-id plugin aliases would be unreachable. `resolveAgentGrepToolID`
  maps legacy ids (`grep`/`file_grep`/`Grep` → `agentgrep`) for caller-side
  adapters — it is not a model-facing registry entry.

## Executable resolution

1. `$AGENTGREP_BIN` — prebuilt binary override.
2. `~/.local/bin/agentgrep` — packaged default (installer target).
3. `$PATH`.

If none is found the tool returns a clear, actionable error naming the
installer command and the `AGENTGREP_BIN` escape hatch.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `AGENTGREP_BIN` | — | Explicit binary path (checked first). |
| `AGENTGREP_TIMEOUT_MS` | `30000` | Run timeout; the child tree is killed on expiry. |
| `AGENTGREP_MAX_OUTPUT_CHARS` | `200000` | Per-stream output cap; the child tree is killed on exceed. |
| `AGENTGREP_INSTALL_DIR` | `~/.local/bin` | Installer prefix. |
| `AGENTGREP_BUILD_DIR` / `AGENTGREP_SKIP_BUILD` | — | Installer reuse/idempotence knobs. |

## Known limitation: `context-json` is NOT implemented

jcode writes a harness **context JSON** (`--context-json`) for trace/smart and
outline built from its *session tool-exposure history* (reads, prior agentgrep
calls, bash file touches, compaction state, file mtimes) to seed the trace
planner. OpenCode's plugin `ToolContext` has **no honest source for that data**
— there is no session-message/tool-call history API exposed to plugin tools, so
any reimplementation would fabricate semantics. This plugin therefore does NOT
pass `--context-json` and does **not** claim context-json parity with jcode.

**Deliberate follow-up:** if OpenCode exposes a session history API to plugin
tools, implement the harness context builder (jcode's `context.rs`) against it.
Until then, trace/outline run without the harness context — the CLI's defaults
(`--max-files`/`--max-regions`) keep results bounded either way.

## Development

```bash
bun install        # fetches @opencode-ai/plugin@1.18.21 (+ devDeps)
bun test           # deterministic suite + real-CLI smoke when a binary is present
bunx tsc --noEmit  # strict typecheck over entry, sources and tests
bash -n scripts/install-agentgrep.sh
```

The real-CLI smoke tests run automatically when `~/.local/bin/agentgrep` (or
`AGENTGREP_BIN`) exists, and are skipped otherwise — they use only local temp
workspaces and never touch the network. The deterministic suite runs a fake
CLI harness so it passes without a binary.

## License

MIT — see [LICENSE](LICENSE).
