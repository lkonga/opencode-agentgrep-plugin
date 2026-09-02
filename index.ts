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
// Default model-facing registry: exactly one canonical `agentgrep` tool (modes
// grep/find/outline/trace). Compatibility ids are available only through the
// explicit `compatibilityAliases` plugin tuple option. `PluginInput` is threaded into
// `buildAgentGrepTools` so the harness context adapter can feature-detect the
// injected SDK client and, when needed, lazily build a v2 client from
// `input.serverUrl`.
//
// Architecture constraint (see agentgrep-core.ts for the full rationale): the
// model-facing registry intentionally has NO bare `grep` or `glob` id. The
// config hook disables OpenCode's native grep/glob tools by default while
// preserving unrelated tool settings. `replaceNativeSearch:false` is the
// explicit portable opt-out.
//
// Security: The config HOOK now applies an AUTHORITATIVE "deny" permission
// policy at BOTH the global config.permission level AND every explicitly
// configured agent's permission block (see agentgrep-policy.ts). This ensures
// grep/glob are excluded from model-request tool payloads even though the
// built-in tool registry always advertises them through /experimental/tool.
// The legacy `config.tools.grep = false` / `config.tools.glob = false` is
// preserved as a secondary guard.
//
// System guidance: the `experimental.chat.system.transform` hook appends an
// idempotent, LOCAL-only code-search hint (use `agentgrep` for exact/find/
// outline/trace; never find/grep/glob/Grep/file_grep;
// never callmux for local repo search — external MCP/web tasks are untouched).
//
// Everything shells out WITHOUT shell interpolation: argv is assembled by the
// pure `buildAgentGrepArgs` helper and passed to Bun.spawn as an array. No
// command strings are ever built by string concatenation.

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import {
  applyAgentGrepSystemGuidance,
  buildAgentGrepTools,
  sanitizeAgentGrepPluginOptions,
} from "./agentgrep-core"
import { applyAgentGrepPolicy } from "./agentgrep-policy"

export default (async (input: PluginInput, options?: unknown) => {
  const resolvedOptions = sanitizeAgentGrepPluginOptions(options)

  return {
    config: async (config) => {
      if (!resolvedOptions.replaceNativeSearch) return
      applyAgentGrepPolicy(config as Record<string, any>)
    },
    tool: buildAgentGrepTools(input, resolvedOptions),
    "experimental.chat.system.transform": async (_input, output) => {
      output.system = applyAgentGrepSystemGuidance(output.system)
    },
  }
}) satisfies Plugin
