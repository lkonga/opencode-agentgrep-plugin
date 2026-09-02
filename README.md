# opencode-agentgrep

**v0.3.0** — Standalone OpenCode backend plugin exposing the
[`agentgrep`](https://github.com/1jehuang/agentgrep) CLI (pinned **v0.1.6**) as
native `Hooks.tool` `ToolDefinition`s. The default model-facing registry
exposes exactly **one** tool: the canonical **`agentgrep`** (exact grep, file
outlines, relationship traces, plus mode=find for ranked file discovery —
**no separate `find` id**). The config hook automatically disables the native
`grep`/`glob` tools (`tools.grep=false`, `tools.glob=false`) while preserving
unrelated merged config. Explicit compatibility aliases (`find`, `file_grep`,
`Grep`) are registered only through the portable `compatibilityAliases` tuple
option. A **system guidance hook** (attached to
`experimental.chat.system.transform`) idempotently tells the model to use
`agentgrep` for local repo code search and never call the unavailable native
grep/glob or the compatibility aliases; external MCP/web tasks calling callmux
are untouched. A separate **TUI facade** (`tui.ts`) makes the plugin visible in
the TUI Plugins screen. The harness context adapter seeds trace/smart/outline
with a **best-effort current-session harness context** (`--context-json`).

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
     "plugin": ["@lkonga/opencode-agentgrep"]
   }
   ```

   The plugin's config hook automatically disables `tools.grep=false` and
   `tools.glob=false` (deep-merged with your existing config). If you need
   to keep the native tools, use the portable tuple opt-out:

   ```jsonc
   {
     "plugin": [["@lkonga/opencode-agentgrep", { "replaceNativeSearch": false }]]
   }
   ```

   To register explicit compatibility aliases without enabling native tools:

   ```jsonc
   {
     "plugin": [["@lkonga/opencode-agentgrep", { "compatibilityAliases": ["find", "file_grep", "Grep"] }]]
   }
   ```

   …or a local directory `file://` plugin (no npm needed):

   ```jsonc
   {
     "plugin": ["file:///home/lkonga/codes/opencode-plugins/opencode-agentgrep"]
   }
   ```

   A directory `file://` plugin resolves through `package.json` `"main"` →
   `./index.ts`. Restart OpenCode after installing or changing the plugin.

   **Portable tuple options** (second element of the plugin tuple):

   | Option | Type | Default | Description |
   |---|---|---|---|
   | `replaceNativeSearch` | `boolean` | `true` | Disable the native `grep`/`glob` tools in the merged config. Set exactly `false` to keep them. |
   | `compatibilityAliases` | `string[]` | `[]` | Exact tool ids to register in addition to canonical `agentgrep`. Accepted values: `"find"`, `"file_grep"`, `"Grep"`. |

3. **Native-tool replacement is automatic.** The plugin's `config` hook sets
   `tools.grep=false` / `tools.glob=false` in the merged config (preserving
   unrelated tool settings), so the replacement is total by default. Opt out
   with the exact portable tuple `["...", {"replaceNativeSearch": false}]`.
   Note that opting out of the native replacement does **not** enable
   compatibility aliases — those are controlled independently by
   `compatibilityAliases`.

## Requirements

- OpenCode (plugin API) — the plugin pins `@opencode-ai/plugin@1.18.21` for
  `tool` / `tool.schema` (zod v4 shapes the server registry recognizes) and
  declares `@opencode-ai/sdk@1.18.21` (for the optional lazy v2 client used by
  the harness-context adapter).
- The `agentgrep` v0.1.6 binary (installed by `scripts/install-agentgrep.sh`,
  or set `AGENTGREP_BIN` to a prebuilt binary). grep/find/outline/trace always
  shell out to the local binary with no network; the harness-context adapter
  additionally makes **guarded SDK calls to the OpenCode server** (the
  post-compaction `session.context` endpoint and bounded `session.messages`
  pagination) as a best-effort enhancement — those calls fail closed to
  "no context" when the server is unreachable.

## Module layout (IMPORTANT)

OpenCode's plugin loader treats **every module export** as a plugin instance:
`getLegacyPlugins` iterates `Object.values(mod)` and throws
`TypeError("Plugin export is not a function")` for any export that is not a
plugin function (or a `{ server }` record). A `.ts` plugin whose entrypoint
also exports constants/helpers therefore fails to load at startup.

- **`index.ts`** — the loader entrypoint. Its **only** export is the default
  plugin function (`async () => ({ tool, config, "experimental.chat.system.transform" })`).
  Nothing else may be exported from this file.
- **`tui.ts`** — separate **TUI facade** (loaded only from `tui.json`): unique
  id + `tui()` function, no `server` export; provides a harmless `/agentgrep`
  status command/toast and shows in the TUI Plugins screen.
- **`agentgrep-core.ts`** — compatibility **barrel / orchestrator** that
  re-exports every public helper from the focused modules, so tests and
  adapters keep a single import surface. (Not a plugin entrypoint.)
- **`agentgrep-types.ts`** — contract: tool-id constants, `AgentGrepInput` /
  `AgentGrepMode`, plugin options (`replaceNativeSearch`, `compatibilityAliases`),
  sanitization, mode normalization, and match-all glob normalization. Pure.
- **`agentgrep-guidance.ts`** — idempotent LOCAL-only code-search system
  guidance (marker + text + `applyAgentGrepSystemGuidance`). Pure.
- **`agentgrep-args.ts`** — exact-file scope translation, find term splitting,
  the pure `buildAgentGrepArgs` argv builder, and the permission operation
  patterns (which MUST match the split argv positionals). Pure.
- **`agentgrep-tools.ts`** — OpenCode schemas (`tool.schema` zod v4),
  descriptions, the shared execute orchestration (permission asks → canonical
  roots → argv → bounded spawn), and the registry builder (default
  `agentgrep` only; explicit compatibility aliases opt-in).
- **`agentgrep-paths.ts`** — canonical root resolution, project containment,
  and native-shaped `external_directory` requests.
- **`agentgrep-exec.ts`** — executable resolution and bounded process
  execution.
- **`agentgrep-context.ts`** — harness-context **orchestrator**: provider
  factory, precedence (context → messages → SQLite), fail-closed.
- **`agentgrep-context-schema.ts`** — pure shape normalization + bounded
  ingestion (`{ info, parts }`, `{ data: [...] }`, arrays, projected v2).
- **`agentgrep-context-build.ts`** — harness JSON builder: containment,
  symbols from structured outline/trace lines, freshness/mtime, dedupe/sort,
  caps.
- **`agentgrep-context-sdk.ts`** — SDK shims, feature detection, bounded
  pagination, lazy v2 client from `PluginInput.serverUrl`.
- **`agentgrep-context-sqlite.ts`** — guarded read-only SQLite fallback
  (exact-session + directory verification, bounded).
- **`agentgrep-context-temp.ts`** — secure tempfile lifecycle (0700 dir, 0600
  `wx` file, cleanup in `finally`).
- **`agentgrep-context-caps.ts`** — hard cap constants.
- **`agentgrep-context-bytes.ts`** — bounded UTF-8 byte measurement (byte caps
  use `Buffer.byteLength`, never `String.length`; deep/cyclic/oversized records
  are rejected before serialization).
- **`agentgrep-context-sanitize.ts`** — scrubs the internal `--context-json`
  temp path / serialized context from ToolResult streams (whole-stream
  redaction on context-JSON signatures).
- **`agentgrep.test.ts` / `agentgrep-execute.test.ts` / `agentgrep-context.test.ts` / `agentgrep-tui.test.ts`**
  — deterministic suites (pure argv/schema; real `ToolDefinition.execute`
  through a fake CLI harness + permission/traversal/symlink + timeout/output-cap;
  the focused harness-context suite; TUI facade shape; optional real-CLI smoke).
- **`scripts/install-agentgrep.sh`** — pinned, idempotent CLI installer.
- **`scripts/smoke-oc-context.sh`** — end-to-end real-`oc` smoke proving
  `--context-json` is passed, the context file is valid/0600, it is copied
  before cleanup, the tempdir is removed, and exact-file containment holds.
- **`scripts/smoke-oc-selection.sh`** — end-to-end real-`oc` smoke proving the
  model selects canonical `agentgrep` (never find/grep/Grep/file_grep/callmux)
  for BOTH exact lexical search (mode=grep) and ranked file discovery (mode=find),
  using the regression input `passthroughStream`.

## Schema & parity (jcode v0.1.6)

### Default model-facing registry

The default registry exposes exactly **one** tool id:

| Id | Purpose |
|----|---------|
| `agentgrep` | Canonical local code-search tool. Accepts all modes: `grep` (exact), `outline` (file structure), `trace` (relationship DSL), and `find` (ranked file discovery). |

**Explicit compatibility aliases** (`find`, `file_grep`, `Grep` — exact case)
are registered only when requested through the portable tuple option
`compatibilityAliases`, e.g. `["...", {"compatibilityAliases":["find","file_grep","Grep"]}]`
or find-only `["...", {"compatibilityAliases":["find"]}]`. `find` is **never**
registered implicitly — there is no first-class `find` id. The `find` alias is
a **purpose-built, forced-find ToolDefinition**: its schema has no `mode` arg
and any `mode` passed by the model is ignored (the id always executes agentgrep
`find`). `file_grep`/`Grep` reuse the mode-flexible canonical schema. All alias
descriptions explicitly label themselves compatibility-only and point at the
canonical `agentgrep` mode that matches their role.

**`grep` id and `glob` id are deliberately absent** — the plugin's config hook
sets `tools.grep=false` / `tools.glob=false` (unless `replaceNativeSearch:false`),
and OpenCode's `tools` config filter removes any tool with those exact ids from
the model-facing registry, so a grep/glob-id plugin alias would be unreachable
and would silently never fire.
The native `grep` and `glob` tools are disabled through `tools=false` config
semantics (the plugin's config hook writes `tools.grep=false` /
`tools.glob=false` into the merged config), NOT via permission deny rules —
the `permission.agentgrep` setting remains an execution authorization and is
separate from tool visibility.

**Native opt-out vs aliases are independent**: `replaceNativeSearch:false`
keeps the native `grep`/`glob` tools enabled but does **not** register any
compatibility aliases; `compatibilityAliases` registers aliases without
changing native-tool behavior.

**Canonical-only is the intentional user-mandated default.** The plugin exposes
only `agentgrep` by default — this is a deliberate design choice, not an
unresolved gap. The `find`, `Grep`, and `file_grep` compatibility aliases are
**never** enabled unless explicitly requested via `compatibilityAliases`. JCode's
inherent multi-alias behavior (where `find`, `grep`, `file_grep`, and `Grep` are
registered implicitly) is intentionally not adopted. Aliases remain explicit
opt-in compatibility helpers only, kept available for model migration scenarios;
they are not a bug to be fixed.

### Tool schema

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

The `find` mode is a mode of the canonical `agentgrep` tool (no separate `find`
id by default) and uses the same schema surface above. An explicitly requested
`find` compatibility alias is a **purpose-built, forced-find ToolDefinition**
with a separate schema (no `mode` arg — the id always pins `find` mode).

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
- **Best-effort session context (`--context-json`), trace/smart/outline only.**
  Current-session exposures (see "Session harness context" below) seed the
  planner; the internal temp path is argv-only, the context is fail-closed, and
  exact-file containment stays exact while context is present. grep/find never
  receive `--context-json`.

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
  the config hook disables the native `grep`/`glob` tools through `tools=false`
  semantics; `replaceNativeSearch:false` is the explicit portable opt-out. The
  default registry exposes **only `agentgrep`**; the explicit compatibility
  aliases (`find`, `file_grep`, `Grep`) are registered only through
  `compatibilityAliases`. The `find` alias is a purpose-built forced-find
  ToolDefinition; `file_grep`/`Grep` reuse the mode-flexible schema.

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
| `AGENTGREP_CONTEXT_DEBUG` | unset | `1` → harness-context diagnostics on stderr (counts/sources only — never paths, JSON content, or temp paths). |
| `AGENTGREP_INSTALL_DIR` | `~/.local/bin` | Installer prefix. |
| `AGENTGREP_BUILD_DIR` / `AGENTGREP_SKIP_BUILD` | — | Installer reuse/idempotence knobs. |

Smoke-script knobs (both `scripts/smoke-oc-context.sh` and
`scripts/smoke-oc-selection.sh`): `OC_SMOKE_MODEL` (required, skip=exit 2 when
unset), `OC_SMOKE_TIMEOUT` (default `300`), `OC_SMOKE_TIMEOUT_MS` (CLI run
timeout for the fake binary), `OC_SMOKE_KEEP_SANDBOX=1` (leave the sandbox for
inspection).

## Local code-search selection guidance (system prompt hook)

The default plugin attaches an **idempotent** `experimental.chat.system.transform`
hook that appends a concise, LOCAL-only code-search hint to the system prompt:

- use `agentgrep` for exact search (mode=grep), file outlines (mode=outline),
  and relationship traces (mode=trace); it can also do ranked discovery with
  mode=find;
- never call tools named `find`, `grep`, `glob`, `Grep`, or `file_grep` for
  local repository search;
- never use callmux or result retrieval for **local repository** search — the
  guidance explicitly carves out external MCP/web tasks, where callmux remains
  available.

The hook appends the guidance text only once (keyed on a stable marker), so
repeated invocations never duplicate it. It is a hint, not an enforcement
mechanism — the model still decides which tools to call.

## TUI facade (`tui.ts`)

`tui.ts` is a tiny, separate TUI plugin loaded **only from `tui.json`** (never
from `plugin` in opencode.json). It:

- carries the mandatory unique id `agentgrep` and a `tui()` function, and has
  **no `server` export**;
- makes the plugin visible in the TUI **Plugins screen** (TUI-side load status
  only — not live server tool availability, which is a server-plugin concern);
- registers at most a harmless `/agentgrep` slash command that shows a status
  toast explaining the canonical server tool / config; it never duplicates the
  server tool and never accesses secrets.

To load it, the **active config** `tui.json` needs an entry for this plugin
path (the parent adds this after branch/config safety inspection):

```jsonc
{
  "tui": ["file:///…/opencode-agentgrep/tui.ts"]
}
```

## Session harness context (best-effort `--context-json`)

For **trace / smart / outline** executions (only — never grep/find, matching
jcode) the plugin now builds a **best-effort harness context JSON** and passes
it to the CLI as `--context-json`. It is derived **only** from the *current
session's* explicit message/tool data, is bounded every step of the way, and is
**fail-closed**: if it cannot produce a trustworthy, in-scope context it simply
omits the flag (trace/outline still run with the CLI's normal bounded
defaults). This is **not full jcode parity** — see "Residual gaps" below.

### Precedence

1. **`session.context`** — the v2 post-compaction **active context** endpoint
   ("all messages after the last compaction"), preferred when available and
   usable. On the injected v1 client (1.18.21) this method does not exist, so a
   v2 SDK client is **lazily** created from `PluginInput.serverUrl` in a
   compatibility-safe way (creation and every call are guarded; a missing/
   unreachable server or absent dependency is a graceful null).
2. **`session.messages`** — bounded cursor pagination + shape normalization
   (v1 `{ info, parts }`, `{ data: [...] }`, plain arrays, projected v2
   messages).
3. **Guarded SQLite fallback** — only when both SDK paths yield nothing. The
   known OpenCode DB is opened read-only (`bun:sqlite` `readonly` + `PRAGMA
   query_only`), found only at exact known locations
   (`$OPENCODE_DATA_HOME/opencode.db`, `$XDG_DATA_HOME/opencode/opencode.db`,
   `~/.local/share/opencode/opencode.db`), realpath/regular-file validated
   under the corresponding data root (no recursive search). The session must
   match a conservative id whitelist, its canonical `directory` must match
   `ctx.directory`/`ctx.worktree`, and only `session`/`message`/`part` rows for
   the **current** session are read, always with parameterized
   `WHERE session_id = ?`, with bounded rows/bytes. Every error is caught and
   the DB is always closed.

### What the context contains (and only that)

Paths are surfaced **only** from explicit known shapes and validated by
canonical containment within the search root (symlinks resolved); outside paths
are dropped and safe **relative** paths are serialized:

- assistant `snapshot.files` (v2);
- local user file attachments represented as filesystem / `file://` paths;
- completed tool inputs for `read` (explicit `file_path` + range),
  `agentgrep`/`grep`/`file_grep`/`Grep` (explicit `file`/`file_path` for
  outline, `path` for trace/smart), `find`/`glob` (explicit `path`), and v2
  explicit `outputPaths`;
- symbols parsed only from AgentGrep **outline/trace structured result lines**
  (bounded/truncated);
- mtime/freshness reasons from **bounded** stat calls, and
  active-context/recent/older/**compacted** markers only when the data actually
  supports them.

**Never** copied into context: freeform prompts, credentials, environment,
arbitrary DB contents, or arbitrary tool output text.

### Privacy, boundaries & safety

- **Current-session only.** The adapter uses exactly `ctx.sessionID`; any
  record **or part** (v1 parts, v2 user files / tool content / snapshots) that
  *explicitly* declares another session is skipped before any path extraction.
  The SQLite fallback additionally verifies the session directory.
- **Fail-closed.** Malformed / missing / throwing / oversized / out-of-session
  inputs degrade to **no context** (null). Every hard cap is exported as a
  testable constant in `agentgrep-context-caps.ts` (pages, messages/parts,
  source bytes, JSON bytes, unique paths, known files/regions/symbols, focus
  files, line ranges, string lengths, SQL rows/bytes, stat calls). Caps named
  in **bytes** are measured as UTF-8 (`Buffer.byteLength`), never
  `String.length`; caps are enforced **early and globally** (before mapping/
  serializing/scanning beyond the bound, including across all message parts).
  Dedupe and sort are deterministic.
- **Secure tempfile + output sanitization.** The context JSON is written to a
  0700 temp dir (`mkdtemp` under `os.tmpdir()`), file opened `wx` (exclusive)
  mode 0600, byte capped before creation; the internal path is passed **only**
  as `--context-json` argv (never in permission asks, `ToolResult`, metadata,
  or logs), and the whole temp dir is removed in a `finally` on success, error,
  nonzero exit, timeout, and abort. Every stream returned by execute is
  scrubbed while a context file is active: a child that echoes the exact
  context JSON (or its `known_files`/`known_regions`/`known_symbols`/
  `focus_files` + `version:1` signature) is redacted whole, and an exact temp
  path is replaced with `[context-json]`. With no usable context the behavior
  is byte-for-byte unchanged.

### Residual gaps (honest, not full parity)

- **Preferred `session.context` is a best-effort path**; on 1.18.21 the
  injected v1 client lacks it and the lazily-created v2 client has no auth
  headers, so in practice the **messages path or the SQLite fallback** usually
  supplies the data.
- **No bash/shell exposure parsing** (jcode parses `cat`/`sed`/`git`/output
  hits; we deliberately do not touch freeform shell commands).
- **Compaction framing** is approximated from visible compaction markers /
  the active-context source, not from OpenCode's internal compaction state.
- **Confidence values** reuse jcode's profiles/reasons where the source
  matches; genuinely new sources use their own explicit reason strings and
  modest confidences. We do not claim jcode's exact tuning.
- This covers the documented best-effort **subset**, not jcode's full
  `context.rs` behavior.

## Development

```bash
bun install        # fetches @opencode-ai/plugin@1.18.21 + @opencode-ai/sdk + devDeps
bun test           # deterministic suites + real-CLI smoke when a binary is present
bun test agentgrep-context.test.ts   # focused harness-context suite
bunx tsc --noEmit  # strict typecheck over entry, sources and tests
bash -n scripts/install-agentgrep.sh
bash -n scripts/smoke-oc-context.sh
bash -n scripts/smoke-oc-selection.sh
```

The real-CLI smoke tests run automatically when `~/.local/bin/agentgrep` (or
`AGENTGREP_BIN`) exists, and are skipped otherwise — they use only local temp
workspaces and never touch the network. The deterministic suite runs a fake
CLI harness so it passes without a binary.

**End-to-end context smoke** (real `oc run`, requires a model):

```bash
OC_SMOKE_MODEL=provider/model bash scripts/smoke-oc-context.sh
```

**End-to-end selection smoke** (real `oc run`, requires a model):

```bash
OC_SMOKE_MODEL=provider/model bash scripts/smoke-oc-selection.sh
```

The selection smoke proves the model selects the canonical `agentgrep` tool
(never bare `find`/`grep`/`glob`/`Grep`/`file_grep`/`callmux`) for local
repository code search, using BOTH exact lexical search and ranked file
discovery. It uses a controlled fake agentgrep binary and captures `--format
json` events to assert tool selection. Exits 2 (SKIP) when `OC_SMOKE_MODEL` is
unset, 0 on pass, 1 on failure. No secrets are printed and no temp files are
left behind.

**The context smoke is NOT hermetic by design.** It runs a real `oc run` against the
ACTIVE OpenCode config and reads the existing provider/credential
configuration **read-only** (it injects only the plugin + permissions via
`OPENCODE_CONFIG_CONTENT`/`OPENCODE_PERMISSION` and never mutates config
files). It creates a throwaway session in the normal OpenCode data store, which
is the inherent cost of a real `oc run`. The selection smoke follows the same
pattern. Diagnostics (recorded argv, log tail, events) have the real sandbox
path redacted.

## License

MIT — see [LICENSE](LICENSE).
