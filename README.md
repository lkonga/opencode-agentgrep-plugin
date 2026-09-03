# opencode-agentgrep

**v0.3.0** — standalone OpenCode backend plugin exposing the
[`agentgrep`](https://github.com/1jehuang/agentgrep) CLI (pinned **v0.1.6**) as
native `Hooks.tool` `ToolDefinition`s, plus a separate TUI facade. The default
model-facing registry exposes exactly **one** tool — the canonical
**`agentgrep`** (modes `grep`/`find`/`outline`/`trace`) — and the config hook
automatically replaces OpenCode's native `grep`/`glob` tools. It is a plain
package: **no fork patches, no opencode-patches, no OpenCode-core dependency**,
installable from npm or loaded from a local directory via `file://`.

## Architecture

Two independent load targets:

- **Server plugin** — `index.ts` is the loader entrypoint whose **only** export
  is the default plugin function returning `{ tool, config,
  "experimental.chat.system.transform" }`. OpenCode's plugin loader treats
  every module export as a plugin instance (`Object.values(mod)`) and throws
  for any non-function, non-`{server}` export, so nothing else may be exported
  from this file.
- **TUI facade** — `tui.ts` is a tiny, separate TUI plugin loaded **only** from
  `tui.json` (never from `plugin` in opencode.json): unique id `agentgrep` +
  a `tui()` function, **no `server` export**. It makes the plugin visible in
  the TUI Plugins screen and registers at most a harmless `/agentgrep` command
  showing a status toast. (TUI load status is not live server tool
  availability — that is the server plugin's concern.) It never duplicates the
  server tool and never accesses secrets.

Module layout (all `agentgrep-*.ts` are non-entrypoint helpers; only `index.ts`
is loaded by OpenCode):

| Module | Responsibility |
|---|---|
| `agentgrep-types.ts` | Contract: tool-id constants, plugin options, `pickAgentGrepInput` public-only allowlist, mode/glob normalization. Pure. |
| `agentgrep-args.ts` | Exact-file scope translation, find term splitting, pure argv builder, permission operation patterns. Pure. |
| `agentgrep-paths.ts` | Canonical root resolution, project containment, native `external_directory` asks. |
| `agentgrep-exec.ts` | Executable resolution + bounded spawn (timeout / output cap / process-tree kill). |
| `agentgrep-policy.ts` | Config-hook policy: authoritative `grep`/`glob` deny at global **and** per-agent permission level, plus legacy `tools=false`. |
| `agentgrep-tools.ts` | zod v4 schemas, shared execute orchestration, registry builder. |
| `agentgrep-guidance.ts` | Idempotent local-code-search system guidance. Pure. |
| `agentgrep-compact.ts` | Post-execution grep region compaction (`max_regions`). Pure. |
| `agentgrep-context*.ts` | Best-effort harness context (`--context-json`): provider, schema, build, SDK shims, SQLite fallback, tempfile, caps, byte measurement, output sanitize. |
| `agentgrep-core.ts` | Compatibility barrel re-exporting all helpers (tests/adapters keep one import surface). Not a plugin entrypoint. |
| `scripts/` | Pinned CLI installer + two real-`oc` smoke scripts. |
| `*.test.ts` | Deterministic suites: pure argv/schema; real `ToolDefinition.execute` through a fake CLI harness (permission/traversal/symlink/timeout/output-cap); focused harness-context suite; TUI facade shape; optional real-CLI smoke. |

## Dependencies

- **`agentgrep` CLI v0.1.6** — pinned to commit `b01b804008ab0662fa14e6b60b10bff61716e6f1`
  (tag `v0.1.6`), installed by `scripts/install-agentgrep.sh`. Every mode shells
  out to the local binary with **no network**.
- **OpenCode plugin API** — pins `@opencode-ai/plugin@1.18.21` (`tool` /
  `tool.schema` zod v4 shapes the server registry recognizes) and
  `@opencode-ai/sdk@1.18.21` (optional lazy v2 client for the guarded
  harness-context SDK calls). Development requires a Bun runtime.
- **Explicitly NOT required:** opencode-patches and OpenCode core sources.
  There is no `patch-registry`/`build-opencode` entry and no fork rebuild —
  restarting `oc` is the only reload step.

## Install

1. **Build the CLI** (user-local, no sudo, no host packages):

   ```bash
   bash scripts/install-agentgrep.sh
   ```

   Latest pinned installs verify: `~/.local/bin/agentgrep --version` →
   `agentgrep 0.1.6`. The installer is idempotent (`AGENTGREP_SKIP_BUILD=1` +
   existing binary skips the build) and **refuses a mismatched clone** — an
   existing tag that does not resolve to the pinned commit aborts the build.

2. **Enable the plugin**. npm (recommended):

   ```jsonc
   {
     "plugin": ["@lkonga/opencode-agentgrep"]
   }
   ```

   …or a local directory `file://` plugin (no npm needed; resolves through
   `package.json` `"main"` → `./index.ts`):

   ```jsonc
   {
     "plugin": ["file:///home/lkonga/codes/opencode-plugins/opencode-agentgrep"]
   }
   ```

3. **TUI facade** (optional) — in the active `tui.json`:

   ```jsonc
   {
     "tui": ["file:///…/opencode-agentgrep/tui.ts"]
   }
   ```

4. **Restart OpenCode** after installing, changing tuple options, or removing
   the plugin — plugins load at server start; the TUI entry additionally needs
   a TUI-side reload.

## Configuring (portable tuple options)

The plugin tuple's second element is a portable options object:

| Option | Type | Default | Description |
|---|---|---|---|
| `replaceNativeSearch` | `boolean` | `true` | Disable OpenCode's native `grep`/`glob` tools in the merged config. Set exactly `false` to keep them (reversible). |
| `compatibilityAliases` | `"find" \| "file_grep" \| "Grep"[]` | `[]` | Exact tool ids to register **in addition** to canonical `agentgrep`. `find` is never registered implicitly. |

Examples:

```jsonc
{ "plugin": [["@lkonga/opencode-agentgrep", { "replaceNativeSearch": false }]] }
{ "plugin": [["@lkonga/opencode-agentgrep", { "compatibilityAliases": ["find", "file_grep", "Grep"] }]] }
```

The two options are **independent**: `replaceNativeSearch:false` keeps the
native tools but does **not** register aliases; `compatibilityAliases`
registers aliases without changing native-tool behavior.

## Native grep/glob replacement — automatic and reversible

The plugin's `config` hook makes the replacement **total by default** via the
authoritative policy in `agentgrep-policy.ts`:

1. **Permission-level denies** — `config.permission.grep: "deny"` and
   `config.permission.glob: "deny"` are applied at the **global** permission
   block **and in every explicitly configured agent's** permission block
   (agents can supersede global permissions, so each is hardened individually;
   existing denials are never weakened, unrelated settings are preserved).
   This excludes grep/glob from model-request tool payloads even though the
   built-in registry always advertises them via `/experimental/tool`.
2. **Legacy guards** — `config.tools.grep = false` / `config.tools.glob = false`
   is kept as a secondary guard (still honored by `resolveTools`).

Everything is **fully reversible**:

- Set `["…", { "replaceNativeSearch": false }]` — native `grep`/`glob` stay
  available for that install.
- Remove the plugin entry (or uninstall) — OpenCode's upstream defaults return
  untouched; the plugin never modifies OpenCode sources.

`permission.agentgrep` is separate: it remains the **execution authorization**
for the plugin's own canonical calls.

## Registry and canonical modes

The default registry exposes exactly **one** tool id:

| Id | Purpose |
|---|---|
| `agentgrep` | Canonical local code-search tool. Accepts all modes: `grep` (exact), `find` (ranked file discovery), `outline` (file structure), `trace` (relationship DSL). |

**Canonical-only is the intentional, user-mandated default.** The plugin
exposes only `agentgrep` by default — a deliberate design choice, not an
unresolved gap. JCode's inherent multi-alias behavior (implicit `find`,
`grep`, `file_grep`, `Grep`) is intentionally **not** adopted.

Explicit compatibility aliases (exact case only, via `compatibilityAliases`):

- `find` is a **purpose-built, forced-find ToolDefinition**: its schema has no
  `mode` arg and any `mode` passed is ignored — the id always executes
  agentgrep `find`.
- `file_grep` / `Grep` reuse the mode-flexible canonical schema. All alias
  descriptions label themselves compatibility-only and point at the canonical
  `agentgrep` mode that matches their role.

**`grep` and `glob` ids are deliberately absent** from the registry: the config
hook disables the native tools, so a grep/glob-id alias would be unreachable
and would silently never fire.

## Tool schema (public args)

The schema mirrors jcode's public `parameters_schema` exactly (key order fixed
on `agentgrep`):

| Arg | Type | Notes |
|---|---|---|
| `mode` | enum `grep\|find\|outline\|trace` | Defaults to `grep`. `smart` is **not** public. |
| `query` | string? | Required for grep (literal unless `regex=true`); optional ranking terms for find. |
| `file` | string? | Single file to inspect. Required for outline. |
| `terms` | string \| string[]? | Trace DSL terms (e.g. `subject:auth_status relation:rendered`), or query parts for find. |
| `regex` | boolean? | grep only: treat query as a regex. |
| `path` | string? | Directory **or file** to search. File-valued → searches only that exact file. Defaults to the session directory. |
| `glob` | string? | File glob filter such as `**/*.rs`. Match-all forms are normalized away. |
| `type` | string? | **Public name** (jcode wire name) — NOT `file_type`. ripgrep type filter (rs, py, js, ts, md…). |
| `max_files` | int? | find/trace result bound; CLI-side defaults 10/5. |
| `max_regions` | int? | trace: CLI-side default 6; grep: post-execution result cap, default 200. |
| `paths_only` | boolean? | Return only matching paths where supported. |

Deliberately internal fields (`pattern`, `file_path`, `include`, `file_type`,
`max_items`, `hidden`, `no_ignore`, `full_region`, `debug_plan`,
`debug_score`, and raw mode `smart`) are accepted **only** by lower-level
helpers — never advertised in the schema, and rejected at the model boundary.

## Behavior and security guardrails

- **Public-only input normalization.** `pickAgentGrepInput` closes the raw
  model input into a canonical **public-only** object *before* any roots,
  patterns, permission asks, metadata, or provider/context work: only the
  allowlisted keys (`mode, query, file, terms, regex, path, glob, type,
  max_files, max_regions, paths_only`) pass; every reserved/internal/unknown
  key is discarded; raw `mode: "smart"` is **rejected** (the model-facing
  boundary accepts `grep|find|outline|trace` only). Rejected input performs no
  permission ask and spawns nothing. Public `type` is mapped to the internal
  `file_type`; raw `file_type` never is.
- **Exact-file containment.** A file-valued `path` (or `file` used as a
  grep/find/trace scope) is translated to a canonical **parent-root +
  glob-escaped-basename** scope (`--path <parent> --glob <basename>`, jcode
  `resolved_search_scope`) — the search hits **only that canonical file and
  never a sibling**. Only *existing* files trigger this (jcode `is_file()`);
  the basename is glob-escaped (`a[1].ts` can never match `a1.ts`).
- **Positional/argv safety.** argv is assembled by the pure
  `buildAgentGrepArgs` and passed to `Bun.spawn` as an array — **no shell
  interpolation ever**. Flags are emitted only where the CLI accepts them
  (no unknown-flag clap errors). Positionals starting with `-` use the clap
  end-of-options marker (`--`); hyphen-leading **named-option values** (`type`,
  `glob`) are rejected with a clear no-spawn error, since v0.1.6 cannot accept
  them.
- **Result caps.** Runs are killed after a default **30s** timeout
  (`AGENTGREP_TIMEOUT_MS`) and output is capped at **200000 chars**
  (`AGENTGREP_MAX_OUTPUT_CHARS`), with process-tree kill on either bound and
  abort honored — there is no unbounded scan. Bounds are also enforced
  CLI-side where flags exist: find `--max-files 10`, trace `--max-files 5` +
  `--max-regions 6`. grep has no CLI result-count flag, so its output is
  additionally compacted post-execution to `max_regions` match lines
  (omitted → **200**, note appended when truncated).
- **Permission flow.** Every invocation asks the canonical `agentgrep`
  permission with the operation pattern(s) (find splits terms identically to
  the argv positionals) and `always: ["*"]`. Relative roots resolve against
  `ctx.directory`; existing symlinks/traversal are canonicalized before
  containment checks. Roots escaping `ctx.directory`/the project worktree
  require the native `external_directory` permission (canonical parent-dir
  glob + filepath/parentDir metadata, duplicate asks coalesced per parent dir).
  **Denials reject execute** (never converted to tool results) — a denied call
  can never spawn the agentgrep process, nor trigger SDK/SQLite/stat work.
- **Context fallback / redaction.** See "Session harness context" — the
  best-effort `--context-json` (trace/outline only) fails **closed** to "no
  context", its tempfile is 0700-dir/0600-`wx`-file, cleanup is guaranteed in
  `finally`, and every returned stream is scrubbed while a context file is
  active (whole-stream redaction on context-JSON signatures; exact temp path →
  `[context-json]`). With no usable context the behavior is byte-for-byte
  unchanged.

Mode behaviors (jcode parity): find splits `query`/string `terms` on
whitespace into positional terms (array terms flatten+split per element);
scoped-only find (no terms but a real glob/type/path/file scope) bridges the
CLI's required positional with an empty term; match-all globs (`*`, `**`,
`**/*`, `./*`, `./**`, `./**/*`) are normalized to "no filter" (v0.1.6 returns
false empties for some of those forms); outline resolves `file` against a
directory-valued `path` root, while a file-valued `path` IS the outline target.

## Session harness context (best-effort `--context-json`)

For **trace and outline** executions only (never grep/find, matching jcode),
the plugin builds a best-effort harness context JSON and passes it to the CLI
as `--context-json` — derived **only** from the *current session's* explicit
message/tool data, bounded every step, and **fail-closed** (any doubt → flag
omitted; trace/outline still run with normal bounded defaults).

Precedence:

1. **`session.context`** — v2 post-compaction active-context endpoint,
   preferred when available (on 1.18.21 the injected v1 client lacks it, so a
   v2 client is lazily created from `PluginInput.serverUrl`; every call is
   guarded, a missing/unreachable server is a graceful null).
2. **`session.messages`** — bounded cursor pagination + shape normalization.
3. **Guarded SQLite fallback** — read-only (`readonly` + `PRAGMA query_only`),
   exact known paths only, realpath/regular-file validated under the data
   root, conservative session-id whitelist + canonical directory match,
   parameterized queries, bounded rows/bytes, never recursive.

Only explicit known shapes surface paths (snapshot.files, local file
attachments, completed read/agentgrep/find/glob tool inputs, v2 `outputPaths`,
symbols parsed from AgentGrep outline/trace result lines) — validated by
canonical containment within the search root, outside paths dropped, safe
relative paths serialized. **Never** copied: freeform prompts, credentials,
environment, arbitrary DB contents, arbitrary tool output. All hard caps are
testable constants in `agentgrep-context-caps.ts`; byte caps use
`Buffer.byteLength` (true UTF-8), enforced early and globally; dedupe/sort are
deterministic.

Residual gaps (honest, not full jcode parity): on 1.18.21 the injected v1
client lacks `session.context` and the lazy v2 client has no auth headers, so
in practice messages or SQLite supply the data; no bash/shell-exposure
parsing; compaction framing is approximated from visible markers; confidence
values use jcode's profiles where the source matches and own explicit reasons
elsewhere. This is the documented best-effort subset, not jcode's full
`context.rs` behavior.

## System guidance hook

The default plugin attaches an **idempotent** `experimental.chat.system.transform`
hook (keyed on a stable marker — never duplicated) appending a LOCAL-only
code-search hint: use `agentgrep` for exact search (mode=grep), outlines
(mode=outline), traces (mode=trace), and ranked discovery (mode=find); never
call `find`/`grep`/`glob`/`Grep`/`file_grep` or use callmux for **local**
repository search (external MCP/web tasks are explicitly carved out). It is a
hint, not enforcement — the model still decides which tools to call.

## Executable resolution and environment

Resolution order: **1.** `$AGENTGREP_BIN` → **2.** `~/.local/bin/agentgrep`
(the installer's documented packaged default) → **3.** `$PATH`. If none is
found the tool returns a clear, actionable error naming the installer and the
`AGENTGREP_BIN` escape hatch.

| Variable | Default | Description |
|---|---|---|
| `AGENTGREP_BIN` | — | Explicit binary path (checked first). |
| `AGENTGREP_TIMEOUT_MS` | `30000` | Run timeout; the child tree is killed on expiry. |
| `AGENTGREP_MAX_OUTPUT_CHARS` | `200000` | Per-stream output cap; the child tree is killed on exceed. |
| `AGENTGREP_CONTEXT_DEBUG` | unset | `1` → harness-context diagnostics on stderr (counts/sources only — never paths, JSON content, or temp paths). |
| `AGENTGREP_INSTALL_DIR` | `~/.local/bin` | Installer prefix. |
| `AGENTGREP_BUILD_DIR` / `AGENTGREP_SKIP_BUILD` | — | Installer reuse/idempotence knobs. |

## Verification (build/test locality)

The thin client is for source edits and short calls only — run the build and
test suites on **g5kc** after syncing the checkout (exclude `node_modules`),
e.g.:

```bash
rsync -a --delete --exclude node_modules --exclude .git ./ g5kc:/tmp/opencode-agentgrep-verify/
ssh g5kc 'cd /tmp/opencode-agentgrep-verify && bun install && bun test && bunx tsc --noEmit && bash -n scripts/*.sh'
```

- `bun test` — deterministic suites pass without a binary (fake CLI harness);
  the real-CLI smoke runs automatically when `~/.local/bin/agentgrep` (or
  `AGENTGREP_BIN`) exists.
- `bunx tsc --noEmit` — strict typecheck over entry, sources, tests.
- `bash -n scripts/*.sh` — shell lint on installer + smokes.

**End-to-end smokes** (real `oc run`; exit 0 pass, 1 fail, 2 SKIP when a
required model is unset):

```bash
OC_SMOKE_MODEL=provider/model bash scripts/smoke-oc-context.sh     # harness-context E2E (real model, active credentials)
bash scripts/smoke-oc-selection.sh                                 # deterministic, self-contained selection smoke (no model needed)
```

- **`smoke-oc-context.sh`** (requires `OC_SMOKE_MODEL` and active
  model/provider credentials) proves `--context-json` is passed to the CLI,
  the file is valid JSON + mode 0600 at runtime, it is copied before cleanup,
  the tempdir is removed, and exact-file containment holds while context is
  present (file-scoped trace argv still `--path <parent> --glob <basename>`).
- **`smoke-oc-selection.sh`** (two runs: exact grep + ranked find) is
  **deterministic and self-contained**: it owns a script-local
  OpenAI-compatible **capture** model/server, so no `OC_SMOKE_MODEL` or active
  provider credentials are needed. It still runs two **real, fresh** `oc run`s
  and inspects the **actual outbound main-model request payload** (captured on
  the local server): canonical `agentgrep` must be present while native
  `grep`/`glob` — and the forbidden **compatibility search IDs** (`find`,
  `file_grep`, `Grep`) — are absent; the captured responses return
  **deterministic** agentgrep tool calls for explicit `mode=grep` and
  `mode=find`; every local code-search call is canonical `agentgrep` with the
  phase's mode and ≥1 call carries the phase's expected query/terms;
  local-search calls per run are bounded (1..`OC_SMOKE_MAX_CALLS`, default
  **8**) as a deterministic loop sanity check; no bare
  `find`/`grep`/`glob`/`Grep`/`file_grep`, no callmux, and **no shell
  bypass** (`bash` commands invoking `rg`/`grep`/`find`); the controlled fake
  CLI runs ≥1 and ≤`OC_SMOKE_MAX_CALLS` times with phase-matching
  subcommands; the expected result reaches the model. Pass does **not** rely
  on injecting `tools.grep`/`tools.glob` — the plugin's config hook does the
  replacement.

Smoke knobs — **context**: `OC_SMOKE_MODEL` (required), `OC_SMOKE_TIMEOUT`
(default `300`). **Selection**: `OC_SMOKE_TIMEOUT` (default `300`),
`OC_SMOKE_TIMEOUT_MS` (fake agentgrep CLI timeout, default `30000`),
`OC_SMOKE_MAX_CALLS` (default `8`), `OC_SMOKE_PREFLIGHT_PORT` (optional
registry-preflight override; otherwise collision-safe), and
`OC_SMOKE_KEEP_SANDBOX=1` (leave the sandbox for inspection).

**Hermeticity.** `smoke-oc-context.sh` is **not hermetic by design**: it runs
a real `oc run` against the **active** OpenCode config and needs live
model/provider credentials (`OC_SMOKE_MODEL`). `smoke-oc-selection.sh` is
**hermetic**: no external provider or credential use — it serves its own local
OpenAI-compatible capture model/server — though it still starts a fresh real
OpenCode server/run, so a throwaway session in the normal data store remains
the inherent cost of a real `oc run`. Both inject configuration without
mutating config files and use a fresh in-process server
(`OPENCODE_SHARED_SERVER=0`) so the plugin loads with the run's environment.
The selection smoke puts its controlled permissions in
`OPENCODE_CONFIG_CONTENT` and unsets ambient `OPENCODE_PERMISSION`; real
sandbox paths are redacted from diagnostics.

## Disabling and uninstalling

- **Disable the plugin** (keep it installed): remove its entry from `plugin`
  in the active config (and the `tui` entry for the facade), then restart.
  Native `grep`/`glob` return to OpenCode's upstream defaults automatically.
- **Keep the plugin but restore native search**: use the portable tuple
  `["@lkonga/opencode-agentgrep", { "replaceNativeSearch": false }]`, then
  restart. Drop compatibility ids by emptying/removing `compatibilityAliases`.
- **Uninstall**: delete the `plugin` (and `tui`) entries, restart, and
  optionally remove the CLI binary (`rm ~/.local/bin/agentgrep`) — or keep it
  for reuse; nothing in OpenCode depends on it once the plugin is disabled.

## Development

```bash
bun install        # fetches @opencode-ai/plugin@1.18.21 + @opencode-ai/sdk + devDeps
bun test           # deterministic suites (+ real-CLI smoke when a binary is present)
bun test agentgrep-context.test.ts   # focused harness-context suite
bunx tsc --noEmit  # strict typecheck
```

After any plugin change, **restart `oc`** (or start a new session) — there is
no fork binary to rebuild; agentgrep is not in `patch-registry` /
`build-opencode`.

## License

MIT — see [LICENSE](LICENSE).
