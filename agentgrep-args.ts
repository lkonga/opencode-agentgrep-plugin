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
 * Escape glob metacharacters so a basename is matched LITERALLY by the
 * AgentGrep v0.1.6 CLI's globset-backed `--glob` (proven against v0.1.6:
 * `a\*.ts` matches only `a*.ts`, `a\[1\].ts` only `a[1].ts`, `a\{b\}.ts`
 * only `a{b}.ts`, `a\\b.ts` only `a\b.ts`). `\` is the globset escape char;
 * every metachar that could over-match a sibling is escaped.
 */
export function globEscape(basename: string): string {
  return basename.replace(/[\\*?[\]{}]/g, (c) => `\\${c}`)
}

/**
 * Translate an exact-file root into a CLI-safe scope: search the canonical
 * parent directory restricted to the file's basename (jcode
 * resolved_search_scope). A directory root is never translated. The user glob
 * is deliberately ignored for file scopes — the exact file wins (jcode parity).
 *
 * The basename is glob-escaped so the emitted `--glob` matches ONLY the literal
 * file, never a sibling whose name happens to match a wildcard (e.g. `a*.ts`
 * must not match `a1.ts`, `a[1].ts` must not match `a1.ts`, `a\b.ts` must not
 * match `ab.ts`).
 */
export function exactFileScope(
  full: string,
  kind: "file" | "directory",
  _userGlob?: string,
): { root: string; glob: string } | null {
  if (kind !== "file") return null
  return { root: path.dirname(full), glob: globEscape(path.basename(full)) }
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

/** Names that begin with `-` and must never reach the CLI unquoted. */
function hasLeadingDash(value: string | undefined | null): boolean {
  return value !== undefined && value !== null && value.startsWith("-") && value.trim() !== ""
}

/** Internal `type` normalization: public `type` (schema key) wins over file_type. */
function normalizeFileType(input: AgentGrepInput): string | undefined {
  if (typeof input.type === "string") return input.type
  return input.file_type
}

/**
 * Reject a named-option VALUE that starts with `-`. AgentGrep v0.1.6 (clap)
 * cannot accept hyphen-leading values for named options (`--type -rs` and
 * `--glob --foo` both fail with "unexpected argument", and the `--` tip only
 * applies to positionals — proven against v0.1.6). Such a value can never be a
 * legitimate ripgrep file type or glob filter, so it is rejected with a clear
 * no-spawn error rather than risking argv misinterpretation.
 */
function assertNamedValueSafe(value: string | undefined, field: string): void {
  if (hasLeadingDash(value)) {
    throw new Error(
      `${field} value ${JSON.stringify(value)} starts with "-" and cannot be passed safely to the ` +
        `agentgrep CLI (v0.1.6 named options reject hyphen-leading values). Remove the leading dash.`,
    )
  }
}

/**
 * Does this find call carry a real narrowing scope (path, file, type, or a
 * normalized non-match-all glob)? Mirrors jcode's find requirement check: a
 * match-all glob does NOT count as a scope after normalization.
 */
function findHasNarrowingScope(input: AgentGrepInput): boolean {
  const pathVal = input.path ? String(input.path).trim() : ""
  const fileVal = input.file ?? input.file_path
  const typeVal = normalizeFileType(input)?.trim() ?? ""
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
 *
 * Leading-dash safety (proven against AgentGrep v0.1.6):
 *   - Named-option VALUES (`type`, `glob`) that start with `-` are REJECTED
 *     with a clear error — v0.1.6 cannot take hyphen-leading named-option
 *     values and the `--` tip only applies to positionals.
 *   - POSITIONAL values (`query`/`pattern`, find `terms`, outline
 *     `file`/`file_path`, trace `terms`) that start with `-` use the clap
 *     end-of-options marker `--`: v0.1.6 supports `--` after the subcommand
 *     for grep/find/outline/trace. When a `--` is required, ALL flags are
 *     emitted before it and the positionals after it (everything after `--`
 *     is positional, so the flags must precede it).
 */
export function buildAgentGrepArgs(input: AgentGrepInput): string[] {
  const rawMode = input.mode
  const mode = normalizeAgentGrepMode(rawMode)

  // An exact-file scope (set by the execute path) replaces path + glob: the
  // search must hit only that canonical file, never a sibling.
  const fileScope = input.__fileScope
  const rootPath = fileScope ? fileScope.root : input.path
  const glob = fileScope ? fileScope.glob : normalizeMatchAllGlob(input.glob ?? input.include)

  // Reject hyphen-leading named-option values that v0.1.6 cannot accept —
  // only where the flag is actually emitted (outline drops type/glob).
  if (mode !== "outline") {
    assertNamedValueSafe(normalizeFileType(input), "type")
    if (!fileScope) assertNamedValueSafe(input.glob ?? input.include, "glob")
  }

  const positionals: string[] = []
  const flags: string[] = []

  switch (mode) {
    case "grep": {
      const query = input.query ?? input.pattern
      if (!query || String(query).trim() === "") throw new Error("grep mode requires `query` (alias `pattern`)")
      positionals.push(String(query).trim())
      if (input.regex) flags.push("--regex")
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
        positionals.push("")
      } else {
        positionals.push(...terms)
      }
      break
    }
    case "outline": {
      const file = input.file ?? input.file_path
      if (!file) throw new Error("outline mode requires `file` (alias `file_path`)")
      positionals.push(String(file))
      break
    }
    case "trace": {
      positionals.push(...traceTerms(input))
      break
    }
  }

  // Mode-specific option block (only where the CLI accepts the flag):
  //   outline: --max-items            trace: --max-regions, --full-region
  if (mode === "outline" && input.max_items !== undefined) flags.push("--max-items", String(input.max_items))
  if (mode === "trace") {
    const maxRegions = input.max_regions ?? TRACE_DEFAULT_MAX_REGIONS
    flags.push("--max-regions", String(maxRegions))
  }
  if (mode === "trace" && input.full_region) flags.push("--full-region", input.full_region)

  // Shared options (grep/find/trace; outline accepts none of these).
  const fileType = normalizeFileType(input)
  if (fileType && mode !== "outline") flags.push("--type", fileType)
  if (mode === "find" || mode === "trace") {
    const maxFiles =
      input.max_files ??
      (mode === "find" ? FIND_DEFAULT_MAX_FILES : TRACE_DEFAULT_MAX_FILES)
    flags.push("--max-files", String(maxFiles))
  }
  if (input.paths_only && mode !== "outline") flags.push("--paths-only")
  if (input.hidden && mode !== "outline") flags.push("--hidden")
  if (input.no_ignore && mode !== "outline") flags.push("--no-ignore")
  if (mode === "trace" && input.debug_plan) flags.push("--debug-plan")
  if ((mode === "find" || mode === "trace") && input.debug_score) flags.push("--debug-score")
  if (glob && mode !== "outline") flags.push("--glob", glob)
  if (rootPath) flags.push("--path", rootPath)

  // JCODE parity: the harness context JSON is only accepted by trace (incl.
  // its `smart` alias) and outline subcommands — never grep/find. The path is
  // purely internal; it can never influence the permission or path flows.
  if (input.__contextJson && (mode === "trace" || mode === "outline")) {
    flags.push("--context-json", input.__contextJson)
  }

  const args: string[] = [mode]
  if (positionals.some(hasLeadingDash)) {
    // End-of-options marker: flags first, `--`, then the positionals. Proven
    // for grep/find/outline/trace on AgentGrep v0.1.6.
    args.push(...flags, "--", ...positionals)
  } else {
    args.push(...positionals, ...flags)
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
