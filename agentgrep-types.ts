// agentgrep-types — the standalone agentgrep plugin's contract: tool-id
// constants, the normalized input shape, mode normalization, and glob
// normalization. Pure and dependency-free (no exec/paths/plugin imports) so
// every other module can build on it without cycles.
//
// The split of the former monolithic agentgrep-core.ts:
//   agentgrep-types.ts  — contract/types + mode/term/glob normalization (this)
//   agentgrep-args.ts   — exact-file scope translation + argv builder +
//                         permission operation patterns
//   agentgrep-tools.ts  — OpenCode schemas (tool.schema zod v4), execute
//                         orchestration, and the tool registry
//   agentgrep-core.ts   — compatibility barrel re-exporting all of the above
//                         (tests/adapters keep a single import surface)
//   agentgrep-paths.ts  — canonical roots, containment, external asks
//   agentgrep-exec.ts   — binary resolution + bounded execution
//
// ⚠️ This module is NOT a plugin entrypoint. Only index.ts may be loaded by
// OpenCode, and it must export exactly one thing (the default plugin fn).

export const AGENTGREP_CANONICAL_ID = "agentgrep"
export const AGENTGREP_FIND_ID = "find"

/** Compatibility alias ids that may be registered explicitly (exact case). */
export const AGENTGREP_ALIASES = [AGENTGREP_FIND_ID, "file_grep", "Grep"] as const
export type AgentGrepCompatibilityAlias = (typeof AGENTGREP_ALIASES)[number]

/**
 * Portable plugin tuple options. OpenCode passes these as the plugin function's
 * second argument. Unknown keys and malformed values are ignored.
 */
export interface AgentGrepPluginOptions {
  /**
   * Disable OpenCode's native `grep` and `glob` tools in the merged config.
   * Defaults to true. Set exactly false to keep the native tools available.
   */
  replaceNativeSearch?: boolean
  /**
   * Exact compatibility tool ids to register in addition to canonical
   * `agentgrep`. Defaults to none; `find` is never registered implicitly.
   */
  compatibilityAliases?: readonly AgentGrepCompatibilityAlias[]
}

export interface ResolvedAgentGrepPluginOptions {
  replaceNativeSearch: boolean
  compatibilityAliases: readonly AgentGrepCompatibilityAlias[]
}

/** Sanitize the untyped second plugin argument into a closed, typed policy. */
export function sanitizeAgentGrepPluginOptions(options?: unknown): ResolvedAgentGrepPluginOptions {
  const source = options !== null && typeof options === "object" && !Array.isArray(options)
    ? options as Record<string, unknown>
    : {}
  const requested = Array.isArray(source.compatibilityAliases)
    ? source.compatibilityAliases
    : []

  return {
    replaceNativeSearch: source.replaceNativeSearch !== false,
    compatibilityAliases: AGENTGREP_ALIASES.filter((alias) => requested.includes(alias)),
  }
}

/**
 * Pure helper mirroring jcode's normalization for callers/adapters.
 * Maps grep-ish ids to the canonical tool id and the optional compatibility
 * `find` id to itself. Returns null for unrelated ids so callers can fall
 * through to their own handling.
 */
export function resolveAgentGrepToolID(id: string): string | null {
  if (id === AGENTGREP_CANONICAL_ID || id === "grep" || id === "file_grep" || id === "Grep") {
    return AGENTGREP_CANONICAL_ID
  }
  if (id === AGENTGREP_FIND_ID) return AGENTGREP_FIND_ID
  return null
}

export type AgentGrepMode = "grep" | "find" | "outline" | "trace"

/**
 * Infer a concrete mode when one is not given by the caller.
 *
 * The PUBLIC modes are grep|find|outline|trace (jcode's parameters_schema
 * enum). `smart` is accepted ONLY as an internal hidden compatibility alias
 * for `trace` (agentgrep v0.1.6 declares `smart` as a visible_alias of trace,
 * and jcode's input accepts `mode == "smart"`), and additionally enables
 * jcode's internal query-splitting fallback for trace terms.
 */
export function normalizeAgentGrepMode(mode?: string | null): AgentGrepMode {
  switch (mode) {
    case "grep":
    case "find":
    case "outline":
    case "trace":
      return mode
    case "smart":
      // agentgrep v0.1.6 exposes `smart` as a visible_alias of `trace`.
      return "trace"
    case undefined:
    case null:
      return "grep"
    default:
      throw new Error(`unknown agentgrep mode "${mode}" (expected grep|find|outline|trace)`)
  }
}

export interface AgentGrepInput {
  mode?: AgentGrepMode | "smart"
  // grep/trace positionals — jcode aliases: query / pattern
  query?: string
  pattern?: string
  terms?: string[] | string
  // outline positional — jcode aliases: file / file_path
  file?: string
  file_path?: string
  // common options (file_type is the internal name; the public schema key is `type`)
  regex?: boolean
  file_type?: string
  max_files?: number
  max_regions?: number
  max_items?: number
  paths_only?: boolean
  hidden?: boolean
  no_ignore?: boolean
  full_region?: "auto" | "always" | "never"
  debug_plan?: boolean
  debug_score?: boolean
  // jcode aliases: glob / include
  glob?: string
  include?: string
  path?: string
  /**
   * Internal, set by the execute path after canonical root resolution: an
   * exact-file scope (canonical parent dir + basename glob). When present it
   * replaces both `path` and `glob` in the emitted argv. Never exposed in the
   * public zod schema.
   */
  __fileScope?: { root: string; glob: string }
  /**
   * Internal: absolute path to a harness context JSON file written by the
   * secure temp helper, threaded into argv ONLY as `--context-json`. Only
   * trace/smart/outline executions set/pass it. Never exposed in the public
   * zod schema and never surfaced through permission asks / results / metadata.
   */
  __contextJson?: string
}

/** Match-all glob forms that must mean "no filter" (jcode is_match_all_glob). */
const MATCH_ALL_GLOBS = new Set(["*", "**", "**/*", "./*", "./**", "./**/*"])

/**
 * Normalize a user glob: trim it, drop empty values, and collapse match-all
 * forms (the bare star forms `*`, `**`, `**`/`*`, `./*`, `./**`, `./**`/`*`)
 * to "no filter". The agentgrep v0.1.6 CLI returns false empties for some of
 * those forms (e.g. `./*`), so they must not reach the CLI as --glob.
 */
export function normalizeMatchAllGlob(glob?: string | null): string | undefined {
  if (!glob) return undefined
  const trimmed = glob.trim()
  if (trimmed === "") return undefined
  if (MATCH_ALL_GLOBS.has(trimmed)) return undefined
  return trimmed
}
