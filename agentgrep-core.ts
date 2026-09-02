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
//     id. The server plugin's config hook disables OpenCode's native tools by
//     default; explicit compatibility aliases never include those bare ids.
//   - Permission asks use the canonical `agentgrep` permission with the split
//     operation patterns and the native `external_directory` asks; denials
//     propagate before any spawn.

export {
  AGENTGREP_ALIASES,
  AGENTGREP_CANONICAL_ID,
  AGENTGREP_FIND_ID,
  AGENTGREP_INPUT_ALLOWLIST,
  pickAgentGrepInput,
  resolveAgentGrepToolID,
  normalizeAgentGrepMode,
  normalizeMatchAllGlob,
  sanitizeAgentGrepPluginOptions,
} from "./agentgrep-types"
export type {
  AgentGrepCompatibilityAlias,
  AgentGrepInput,
  AgentGrepMode,
  AgentGrepPluginOptions,
  ResolvedAgentGrepPluginOptions,
} from "./agentgrep-types"

export {
  AGENTGREP_GUIDANCE_MARKER,
  agentgrepSystemGuidance,
  applyAgentGrepSystemGuidance,
} from "./agentgrep-guidance"

export {
  buildAgentGrepArgs,
  exactFileScope,
  findSplitTerms,
  globEscape,
  operationPatterns,
} from "./agentgrep-args"

export { compactGrepRegions, GREP_DEFAULT_MAX_REGIONS } from "./agentgrep-compact"

export { buildAgentGrepTools } from "./agentgrep-tools"

export { applyAgentGrepPolicy } from "./agentgrep-policy"

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

// Harness context adapter (see agentgrep-context.ts for the full contract):
//   agentgrep-context.ts      — orchestrator (provider factory + precedence)
//   agentgrep-context-schema.ts — pure shape normalization + bounded ingestion
//   agentgrep-context-build.ts — harness JSON builder (containment, freshness,
//                                symbols, dedupe/sort, caps)
//   agentgrep-context-sdk.ts  — SDK shims, feature detection, bounded pagination
//   agentgrep-context-sqlite.ts — guarded read-only SQLite fallback
//   agentgrep-context-temp.ts — secure tempfile lifecycle
//   agentgrep-context-caps.ts — hard cap constants
export {
  createAgentGrepContextProvider,
} from "./agentgrep-context"
export type { AgentGrepContextProvider } from "./agentgrep-context"

export {
  normalizeContextMessages,
  unwrapResult,
} from "./agentgrep-context-schema"
export type {
  NormalizedContextMessage,
  NormalizedContextPart,
  NormalizeResult,
} from "./agentgrep-context-schema"

export {
  buildHarnessContext,
  FreshnessCache,
  resolveContextRelativePath,
  serializeHarnessContext,
  tuneFreshness,
} from "./agentgrep-context-build"
export type {
  HarnessContext,
  HarnessKnownFile,
  HarnessKnownRegion,
  HarnessKnownSymbol,
} from "./agentgrep-context-build"

export {
  createV2ClientFromServerUrl,
  fetchSessionContext,
  fetchSessionMessages,
  hasSessionContext,
  hasSessionMessages,
  normalizeSdkResult,
  v1MessagesOf,
} from "./agentgrep-context-sdk"
export type {
  ClientShim,
  SessionClientShim,
  V1SessionShim,
  V2SessionShim,
  SdkContextResult,
  SdkFetchError,
  SdkMessagesResult,
} from "./agentgrep-context-sdk"
// Test seam: swap the v2-client factory without touching the network/SDK.
export { _setV2ClientModule } from "./agentgrep-context-sdk"

export { boundedUtf8Bytes, utf8ByteLength } from "./agentgrep-context-bytes"
export type { BoundedBytes } from "./agentgrep-context-bytes"

export {
  CONTEXT_FRAGMENT_MIN,
  CONTEXT_REDACTED_OUTPUT,
  CONTEXT_TEMP_PLACEHOLDER,
  containsContextFragment,
  hasContextJsonSignature,
  sanitizeContextOutput,
} from "./agentgrep-context-sanitize"
export type { SanitizeOpts, SanitizeResult } from "./agentgrep-context-sanitize"

export {
  openCodeDbCandidates,
  sqliteFallbackMessages,
  validateSqliteCandidate,
  isValidSessionID,
  readSessionMessagesFromSqlite,
} from "./agentgrep-context-sqlite"
export type { SqliteCandidate, SqliteReadResult } from "./agentgrep-context-sqlite"

export { writeContextTempFile, withContextTempFile } from "./agentgrep-context-temp"
export type { ContextTempFile } from "./agentgrep-context-temp"

export * from "./agentgrep-context-caps"
