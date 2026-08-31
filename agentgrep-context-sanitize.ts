// agentgrep-context-sanitize — redacts harness-context tempfile leakage from
// tool OUTPUT streams (stdout/stderr/exception messages). The internal
// `--context-json` path and its serialized content must NEVER surface in a
// ToolResult, permission ask, metadata, or log.
//
// While a context file is active, every stream returned by execute is passed
// through `sanitizeContextOutput`:
//   - a stream that contains the EXACT serialized context JSON, or
//   - a stream whose structure indicates the child echoed the context file
//     (`"known_files"`/`"known_regions"`/`"known_symbols"`/`"focus_files"`
//     alongside `"version":1`),
// is REDACTED WHOLE (a fixed safe placeholder) — never partially recovered.
//   - otherwise, an exact temp-path match is replaced with `[context-json]`.
//
// Legit AgentGrep output (trace/find/outline/grep result lines) passes through
// unchanged. Pure and dependency-free so tests can exercise it directly.
//
// ⚠️ NOT a plugin entrypoint. Only index.ts is loaded by OpenCode.

export interface SanitizeOpts {
  /** Absolute internal context tempfile path (may be null when inactive). */
  tempPath: string | null
  /** Exact serialized context JSON (may be null when inactive). */
  contextJson: string | null
}

export interface SanitizeResult {
  text: string
  /** True when anything was redacted (whole-stream or path replacement). */
  redacted: boolean
}

/** Fixed safe placeholder for a whole-stream redaction. */
export const CONTEXT_REDACTED_OUTPUT = "[agentgrep: output redacted — the tool echoed internal harness-context data]"

/** Fixed safe placeholder replacing the exact temp path. */
export const CONTEXT_TEMP_PLACEHOLDER = "[context-json]"

const CONTEXT_JSON_KEYS = ['"known_files"', '"known_regions"', '"known_symbols"', '"focus_files"']
const CONTEXT_JSON_VERSION_RE = /"version"\s*:\s*1\b/

/**
 * True when the text structurally indicates the child echoed the harness
 * context JSON: the `version: 1` marker plus at least one `known_*`/
 * `focus_files` key. These keys never appear in legit AgentGrep result lines.
 */
export function hasContextJsonSignature(text: string): boolean {
  if (!CONTEXT_JSON_VERSION_RE.test(text)) return false
  return CONTEXT_JSON_KEYS.some((key) => text.includes(key))
}

/**
 * Redact leakage from a stream. Never throws.
 *
 * TRUE NO-OP when context is inactive (both tempPath and contextJson null):
 * the text is returned byte-for-byte unchanged, including harness-like JSON —
 * structural signature redaction only applies while a context file is active.
 */
export function sanitizeContextOutput(text: string, opts: SanitizeOpts): SanitizeResult {
  const contextActive = opts.tempPath !== null || opts.contextJson !== null
  if (!contextActive) return { text, redacted: false }
  if (text === "") return { text, redacted: false }
  // Exact serialized context echoed → redact whole stream.
  if (opts.contextJson !== null && text.includes(opts.contextJson)) {
    return { text: CONTEXT_REDACTED_OUTPUT, redacted: true }
  }
  // Structural signature of the context file → redact whole stream (only while
  // context is active — see the no-op guard above).
  if (hasContextJsonSignature(text)) {
    return { text: CONTEXT_REDACTED_OUTPUT, redacted: true }
  }
  // Exact temp path present → replace just the path.
  if (opts.tempPath !== null && text.includes(opts.tempPath)) {
    return { text: text.split(opts.tempPath).join(CONTEXT_TEMP_PLACEHOLDER), redacted: true }
  }
  return { text, redacted: false }
}