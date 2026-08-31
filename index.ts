// agentgrep — standalone OpenCode server plugin exposing the `agentgrep` CLI
// (v0.1.6) as Hooks.tool ToolDefinitions.
//
// ⚠️ THIS FILE IS THE LOADER ENTRYPOINT AND HAS EXACTLY ONE EXPORT.
// OpenCode's plugin loader treats EVERY module export as a plugin instance
// (getLegacyPlugins iterates Object.values(mod)) and throws
// "Plugin export is not a function" for any non-function, non-{server} export.
// That means constants and helpers must NOT be exported from here — doing so
// breaks plugin loading at startup. All implementation helpers live in the
// focused `agentgrep-*.ts` modules (see README.md for the module layout), and
// the TUI facade lives in a separate `tui.ts` (loaded only from tui.json).
//
// Default model-facing registry: canonical `agentgrep` (exact grep/outline/
// trace, and mode=find) + the first-class `find` shortcut (ranked file
// discovery). Legacy compatibility aliases `file_grep`/`Grep` are opt-in via
// `$AGENTGREP_LEGACY_ALIASES=1`. `PluginInput` is threaded into
// `buildAgentGrepTools` so the harness context adapter can feature-detect the
// injected SDK client and, when needed, lazily build a v2 client from
// `input.serverUrl`.
//
// Architecture constraint (see agentgrep-core.ts for the full rationale): the
// model-facing registry intentionally has NO `grep` id — OpenCode's
// `tools.grep=false` permission gate filters every tool whose id is exactly
// `grep`, so a bare `grep` id could never fire. Native grep/glob are disabled
// by user config (`tools.grep=false` / `tools.glob=false`), not by this plugin.
//
// System guidance: the `experimental.chat.system.transform` hook appends an
// idempotent, LOCAL-only code-search hint (use `agentgrep` for exact/outline/
// trace, `find` only for ranked discovery; never grep/glob/Grep/file_grep;
// never callmux for local repo search — external MCP/web tasks are untouched).
//
// Everything shells out WITHOUT shell interpolation: argv is assembled by the
// pure `buildAgentGrepArgs` helper and passed to Bun.spawn as an array. No
// command strings are ever built by string concatenation.

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { applyAgentGrepSystemGuidance, buildAgentGrepTools } from "./agentgrep-core"

export default (async (input: PluginInput) => ({
  tool: buildAgentGrepTools(input),
  "experimental.chat.system.transform": async (_input, output) => {
    output.system = applyAgentGrepSystemGuidance(output.system)
  },
})) satisfies Plugin
