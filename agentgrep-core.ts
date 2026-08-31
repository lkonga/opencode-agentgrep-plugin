// agentgrep-core — compatibility barrel / orchestrator for the standalone
// agentgrep plugin. Re-exports every public helper from the focused modules so
// tests and adapters keep a single import surface (this is the ONLY reason
// this file still exists — the former ~700-line monolith was split into):
//
//   agentgrep-types.ts  — contract/types + mode/term/glob normalization
//   agentgrep-args.ts   — exact-file scope translation + argv builder +
//                         permission operation patterns
//   agentgrep-tools.ts  — OpenCode schemas (tool.schema zod v4), execute
//                         orchestration, and the tool registry
//   agentgrep-paths.ts  — canonical roots, project containment, external asks
//   agentgrep-exec.ts   — binary resolution + bounded execution
//
// ⚠️ LOADER CONSTRAINT (why only index.ts is the plugin entrypoint):
// OpenCode's plugin loader treats EVERY module export as a plugin instance
// (getLegacyPlugins iterates Object.values(mod)) and throws
// "Plugin export is not a function" for any non-function, non-{server} export.
// index.ts therefore exports ONLY the default plugin function, and it imports
// `buildAgentGrepTools` from THIS barrel — never from agentgrep-tools.ts
// directly. This barrel has many exports by design (it is never loaded by
// OpenCode as a plugin entrypoint).
//
// Behavior/safety contract (see the module docs for the full rationale):
//   - Everything shells out WITHOUT shell interpolation: argv is assembled by
//     the pure `buildAgentGrepArgs` and passed to Bun.spawn as an array.
//   - The model-facing registry intentionally has NO `grep` id and NO `glob`
//     id — tools.grep=false / tools.glob=false filter every tool with those
//     exact ids, so a bare grep/glob id could never fire.
//   - Permission asks use the canonical `agentgrep` permission with the split
//     operation patterns and the native `external_directory` asks; denials
//     propagate before any spawn.

export {
  AGENTGREP_ALIASES,
  AGENTGREP_CANONICAL_ID,
  AGENTGREP_FIND_ID,
  resolveAgentGrepToolID,
  normalizeAgentGrepMode,
  normalizeMatchAllGlob,
} from "./agentgrep-types"
export type { AgentGrepInput, AgentGrepMode } from "./agentgrep-types"

export {
  buildAgentGrepArgs,
  exactFileScope,
  findSplitTerms,
  operationPatterns,
} from "./agentgrep-args"

export { buildAgentGrepTools } from "./agentgrep-tools"

export {
  askExternalDirectoryIfNeeded,
  canonicalizePath,
  isInsideProject,
  isWithinPath,
  resolveModelRoots,
} from "./agentgrep-paths"
export type { ProjectBounds, ResolvedRoot, ResolvedRoots } from "./agentgrep-paths"

export {
  agentGrepDefaultBin,
  findAgentGrepOnPath,
  resolveAgentGrepBin,
  runAgentGrep,
  tryResolveAgentGrepBin,
  AGENTGREP_DEFAULT_MAX_OUTPUT_CHARS,
  AGENTGREP_DEFAULT_TIMEOUT_MS,
} from "./agentgrep-exec"
export type { AgentGrepExecOptions, AgentGrepExecResult } from "./agentgrep-exec"
