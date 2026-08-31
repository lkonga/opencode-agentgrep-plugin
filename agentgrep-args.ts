// agentgrep-args — pure scope translation and argv construction for the
// standalone agentgrep plugin: the exact-file scope helper, find term
// splitting, the CLI-safe argv builder, and the permission operation patterns
// (the permission patterns MUST match the split argv positionals).
//
// Pure by design (fs-free, except node:path string ops): the execute layer
// resolves/canonicalizes paths and hands the result back in as normalized
// input (`path` as a canonical absolute path, `__fileScope` for exact files),
// and this module turns it into an argv array safe for Bun.spawn — no shell
// interpolation ever.
//
// Module split of the former monolithic agentgrep-core.ts:
//   agentgrep-types.ts  — contract/types + mode/term/glob normalization
//   agentgrep-args.ts   — exact-file scope translation + argv builder +
//                         permission operation patterns (this)
//   agentgrep-tools.ts  — OpenCode schemas, execute, registry
//   agentgrep-core.ts   — compatibility barrel
//
// ⚠️ This module is NOT a plugin entrypoint. Only index.ts may be loaded by
// OpenCode, and it must export exactly one thing (the default plugin fn).

import path from "node:path"
import type { AgentGrepInput, AgentGrepMode } from "./agentgrep-types"
import { normalizeAgentGrepMode, normalizeMatchAllGlob } from "./agentgrep-types"

/**
 * Translate an exact-file root into a CLI-safe scope: search the canonical
 * parent directory restricted to the file's basename (jcode
 * resolved_search_scope). A directory root is never translated. The user glob
 * is deliberately ignored for file scopes — the exact file wins (jcode parity).
 */
export function exactFileScope(
  full: string,
  kind: "file" | "directory",
  _userGlob?: string,
): { root: string; glob: string } | null {
  if (kind !== "file") return null
  return { root: path.dirname(full), glob: path.basename(full) }
}

/**
 * find-mode positional terms: `query`/`pattern` (or a string `terms`) split on
 * whitespace, exactly like jcode's find `query_parts: query.split_whitespace()`.
 * Array `terms` are flattened and each element whitespace-split. The same split
 * list feeds the permission operation patterns (see operationPatterns).
 */
export function findSplitTerms(input: AgentGrepInput): string[] {
  const raw = input.query ?? input.pattern ?? (typeof input.terms === "string" ? input.terms : undefined)
  if (raw !== undefined) {
    return String(raw).split(/\s+/).filter(Boolean)
  }
  if (Array.isArray(input.terms)) {
    return input.terms.flatMap((t) => String(t).split(/\s+/)).filter(Boolean)
  }
  return []
}

/**
 * Does this find call carry a real narrowing scope (path, file, type, or a
 * normalized non-match-all glob)? Mirrors jcode's find requirement check: a
 * match-all glob does NOT count as a scope after normalization.
 */
function findHasNarrowingScope(input: AgentGrepInput): boolean {
  const pathVal = input.path ? String(input.path).trim() : ""
  const fileVal = input.file ?? input.file_path
  const typeVal = input.file_type ? String(input.file_type).trim() : ""
  if (pathVal !== "" || (fileVal && String(fileVal).trim() !== "") || typeVal !== "") return true
  return normalizeMatchAllGlob(input.glob ?? input.include) !== undefined
}

/** trace/smart positional terms: explicit `terms`, or a smart-mode query split. */
function traceTerms(input: AgentGrepInput): string[] {
  if (Array.isArray(input.terms) && input.terms.length > 0) return input.terms.map(String)
  if (input.mode === "smart" && input.query && String(input.query).trim() !== "") {
    return String(input.query).split(/\s+/).filter(Boolean)
  }
  throw new Error(
    input.mode === "smart"
      ? "trace/smart mode requires `terms` (or `query` in smart mode)"
      : "trace mode requires `terms` (non-empty array of trace DSL terms)",
  )
}

/** CLI result bounds applied when the caller does not supply them (jcode defaults). */
const FIND_DEFAULT_MAX_FILES = 10
const TRACE_DEFAULT_MAX_FILES = 5
const TRACE_DEFAULT_MAX_REGIONS = 6

/**
 * Pure args builder: turns normalized input into an argv array (starting at the
 * subcommand) safe for Bun.spawn — no shell interpolation ever. Flags are
 * emitted ONLY for modes the AgentGrep CLI accepts them in (see the per-mode
 * table in the README), so argv never triggers an unknown-flag clap error.
 */
export function buildAgentGrepArgs(input: AgentGrepInput): string[] {
  const rawMode = input.mode
  const mode = normalizeAgentGrepMode(rawMode)
  const args: string[] = [mode]

  // An exact-file scope (set by the execute path) replaces path + glob: the
  // search must hit only that canonical file, never a sibling.
  const fileScope = input.__fileScope
  const rootPath = fileScope ? fileScope.root : input.path
  const glob = fileScope ? fileScope.glob : normalizeMatchAllGlob(input.glob ?? input.include)

  switch (mode) {
    case "grep": {
      const query = input.query ?? input.pattern
      if (!query || String(query).trim() === "") throw new Error("grep mode requires `query` (alias `pattern`)")
      args.push(String(query).trim())
      if (input.regex) args.push("--regex")
      break
    }
    case "find": {
      const terms = findSplitTerms(input)
      if (terms.length === 0) {
        if (!findHasNarrowingScope(input)) {
          throw new Error("find mode requires `terms` or `query` (or a narrowing scope: glob/type/path)")
        }
        // The CLI requires ≥1 positional QUERY_PARTS; jcode allows empty
        // query_parts when a scope narrows the search. An empty-string
        // positional bridges the two so glob-only/type-only/path-only finds run.
        args.push("")
      } else {
        args.push(...terms)
      }
      break
    }
    case "outline": {
      const file = input.file ?? input.file_path
      if (!file) throw new Error("outline mode requires `file` (alias `file_path`)")
      args.push(String(file))
      break
    }
    case "trace": {
      args.push(...traceTerms(input))
      break
    }
  }

  // Mode-specific option block (only where the CLI accepts the flag):
  //   outline: --max-items            trace: --max-regions, --full-region
  if (mode === "outline" && input.max_items !== undefined) args.push("--max-items", String(input.max_items))
  if (mode === "trace") {
    const maxRegions = input.max_regions ?? TRACE_DEFAULT_MAX_REGIONS
    args.push("--max-regions", String(maxRegions))
  }
  if (mode === "trace" && input.full_region) args.push("--full-region", input.full_region)

  // Shared options (grep/find/trace; outline accepts none of these).
  if (input.file_type && mode !== "outline") args.push("--type", input.file_type)
  if (mode === "find" || mode === "trace") {
    const maxFiles =
      input.max_files ??
      (mode === "find" ? FIND_DEFAULT_MAX_FILES : TRACE_DEFAULT_MAX_FILES)
    args.push("--max-files", String(maxFiles))
  }
  if (input.paths_only && mode !== "outline") args.push("--paths-only")
  if (input.hidden && mode !== "outline") args.push("--hidden")
  if (input.no_ignore && mode !== "outline") args.push("--no-ignore")
  if (mode === "trace" && input.debug_plan) args.push("--debug-plan")
  if ((mode === "find" || mode === "trace") && input.debug_score) args.push("--debug-score")
  if (glob && mode !== "outline") args.push("--glob", glob)
  if (rootPath) args.push("--path", rootPath)

  // JCODE parity: the harness context JSON is only accepted by trace (incl.
  // its `smart` alias) and outline subcommands — never grep/find. The path is
  // purely internal; it can never influence the permission or path flows.
  if (input.__contextJson && (mode === "trace" || mode === "outline")) {
    args.push("--context-json", input.__contextJson)
  }

  return args
}

/** The canonical operation pattern(s) for the "agentgrep" permission ask. */
export function operationPatterns(mode: AgentGrepMode, input: AgentGrepInput): string[] {
  if (mode === "outline") {
    const file = input.file ?? input.file_path
    return file ? [String(file)] : []
  }
  if (mode === "find") {
    // Split identically to the argv positionals (findSplitTerms above).
    const terms = findSplitTerms(input)
    if (terms.length > 0) return terms
    // Scoped-only find: describe the scope in the ask.
    const glob = (input.glob ?? input.include ?? "").trim()
    const file = input.file ?? input.file_path
    const pathVal = input.path ? String(input.path) : undefined
    for (const candidate of [glob, file, pathVal]) {
      if (candidate && candidate.trim() !== "") return [String(candidate).trim()]
    }
    return []
  }
  if (mode === "trace") {
    if (Array.isArray(input.terms) && input.terms.length > 0) return input.terms.map(String)
    if (input.mode === "smart" && input.query && String(input.query).trim() !== "") {
      return String(input.query).split(/\s+/).filter(Boolean)
    }
    return []
  }
  // grep
  const query = input.query ?? input.pattern
  return query && String(query).trim() !== "" ? [String(query).trim()] : []
}
