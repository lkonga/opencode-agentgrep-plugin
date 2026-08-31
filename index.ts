// agentgrep — standalone OpenCode plugin exposing the `agentgrep` CLI (v0.1.6)
// as a Hooks.tool ToolDefinition (plus legacy aliases `file_grep`/`Grep` and a
// first-class `find` id).
//
// ⚠️ THIS FILE IS THE LOADER ENTRYPOINT AND HAS EXACTLY ONE EXPORT.
// OpenCode's plugin loader treats EVERY module export as a plugin instance
// (getLegacyPlugins iterates Object.values(mod)) and throws
// "Plugin export is not a function" for any non-function, non-{server} export.
// That means constants and helpers must NOT be exported from here — doing so
// breaks plugin loading at startup. All implementation helpers live in
// ./agentgrep-core.ts (imported by this entrypoint and by the unit tests /
// adapters). See README.md for the module layout.
//
// Architecture constraint (see agentgrep-core.ts for the full rationale): the
// model-facing registry intentionally has NO `grep` id — OpenCode's
// `tools.grep=false` permission gate filters every tool whose id is exactly
// `grep`, so a bare `grep` id could never fire. The canonical tool id is
// `agentgrep`, with two legacy aliases (`file_grep`, `Grep`) that do not
// collide with the denied id.
//
// Everything shells out WITHOUT shell interpolation: argv is assembled by the
// pure `buildAgentGrepArgs` helper and passed to Bun.spawn as an array. No
// command strings are ever built by string concatenation.

import { buildAgentGrepTools } from "./agentgrep-core"

export default async () => ({
  tool: buildAgentGrepTools(),
})
