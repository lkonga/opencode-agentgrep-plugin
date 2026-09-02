// agentgrep-context-sanitize — redacts harness-context tempfile leakage from
// tool OUTPUT streams (stdout/stderr/exception messages). The internal
// `--context-json` path and its serialized content must NEVER surface in a
// ToolResult, permission ask, metadata, or log.
//
// While a context file is active, every stream returned by execute is passed
// through `sanitizeContextOutput`:
//   - a stream that contains the EXACT serialized context JSON,
//   - a stream containing a SAFE-TO-DETECT PARTIAL serialized fragment of it
//     (≥ CONTEXT_FRAGMENT_MIN contiguous chars, e.g. a truncated chunk missing
//     the version marker or the full exact JSON — detected with a double
//     polynomial rolling hash over fixed-size windows, so prefix/middle/suffix
//     leaks are caught), or
//   - a stream whose structure indicates the child echoed the context file
//     (`"version":1` plus a `known_*`/`focus_*` key or key prefix, or two
//     distinct context keys in close proximity WITHOUT the version marker),
// is REDACTED WHOLE (a fixed safe placeholder) — never partially recovered.
//   - otherwise, an exact temp-path match is replaced with `[context-json]`.
//
// Legit AgentGrep output (trace/find/outline/grep result lines) passes through
// unchanged, and ALL redaction is strictly inactive-context-no-op: when no
// context file is active the text is returned byte-for-byte untouched, even
// if it happens to look like harness JSON. Pure and dependency-free so tests
// can exercise it directly.
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

/**
 * Minimum contiguous chars of the serialized context JSON that count as a
 * safe-to-detect partial fragment. Shorter fragments are only caught by the
 * structural signature below. 64 chars is long enough that it never appears in
 * legit AgentGrep output by coincidence while still catching realistic
 * truncated echo chunks (stdio boundaries / the 200k output cap cut multi-KB
 * chunks, never 64-char substrings).
 */
export const CONTEXT_FRAGMENT_MIN = 64

const CONTEXT_JSON_KEYS = ['"known_files"', '"known_regions"', '"known_symbols"', '"focus_files"']
const CONTEXT_JSON_VERSION_RE = /"version"\s*:\s*1\b/
/** Truncated key prefix (e.g. `"known_fi`) — evidence the key name was cut. */
const CONTEXT_JSON_KEY_PREFIX_RE = /"(?:known_|focus_)/
/** Max distance between two distinct context keys to count as one echo line. */
const CONTEXT_KEY_PROXIMITY = 400

/**
 * True when the text structurally indicates the child echoed the harness
 * context JSON:
 *   - `"version":1` plus a full `known_*`/`focus_*` key OR a truncated key
 *     prefix (covers chunks where the key name was cut by the chunk boundary);
 *   - OR two DISTINCT full context keys within CONTEXT_KEY_PROXIMITY chars
 *     (covers middle/suffix chunks missing the version marker entirely).
 * Legit AgentGrep result lines never satisfy either rule.
 */
export function hasContextJsonSignature(text: string): boolean {
  if (CONTEXT_JSON_VERSION_RE.test(text) && CONTEXT_JSON_KEY_PREFIX_RE.test(text)) return true
  const positions: number[] = []
  for (const key of CONTEXT_JSON_KEYS) {
    const at = text.indexOf(key)
    if (at !== -1) positions.push(at)
  }
  if (positions.length < 2) return false
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      if (Math.abs(positions[i] - positions[j]) <= CONTEXT_KEY_PROXIMITY) return true
    }
  }
  return false
}

// ── Partial-fragment detection (double polynomial rolling hash) ───────────────
// A leaked prefix/middle/suffix of the serialized JSON of length ≥
// CONTEXT_FRAGMENT_MIN always contains SOME fixed-size window of the JSON; we
// hash every window of the context JSON once and test every window of the
// stream against that set. Two independent mod-prime hashes make accidental
// collisions negligible (and a false positive only over-redacts — the safe
// direction — while a context file is active).

const FRAGMENT_P1 = 2147483647 // 2^31 - 1 (Mersenne prime)
const FRAGMENT_P2 = 2147483629 // prime < 2^31
const FRAGMENT_B1 = 911382323
const FRAGMENT_B2 = 972663749

/** (a * b) mod p for a,b < p < 2^31 without 53-bit overflow. */
function mulmod(a: number, b: number, p: number): number {
  const ah = Math.floor(a / 65536)
  const al = a % 65536
  return ((((ah * b) % p) * 65536) % p + (al * b) % p) % p
}

function powmod(base: number, exp: number, p: number): number {
  let result = 1
  let b = base % p
  let e = exp
  while (e > 0) {
    if (e % 2 === 1) result = mulmod(result, b, p)
    b = mulmod(b, b, p)
    e = Math.floor(e / 2)
  }
  return result
}

/** Rolling hash of every `win`-length window of `s` (chars treated as codes). */
function windowHashes(s: string, win: number, base: number, p: number): number[] {
  const out: number[] = []
  const pow = powmod(base, win, p) // base^win — outgoing char after the shift
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (mulmod(h, base, p) + (s.charCodeAt(i) % p)) % p
    if (i >= win) {
      h = (h - mulmod(pow, s.charCodeAt(i - win) % p, p) + p) % p
    }
    if (i >= win - 1) out.push(h)
  }
  return out
}

/**
 * True when `text` contains any contiguous substring of `contextJson` of
 * length ≥ `minLen`. Pure, bounded (linear in both inputs), and exact for all
 * fragments ≥ `minLen` — prefix, middle, and suffix leaks alike. Returns false
 * when either input is shorter than `minLen`.
 */
export function containsContextFragment(
  text: string,
  contextJson: string,
  minLen = CONTEXT_FRAGMENT_MIN,
): boolean {
  if (text.length < minLen || contextJson.length < minLen) return false
  const setA = new Set(windowHashes(contextJson, minLen, FRAGMENT_B1, FRAGMENT_P1))
  const setB = new Set(windowHashes(contextJson, minLen, FRAGMENT_B2, FRAGMENT_P2))
  const textA = windowHashes(text, minLen, FRAGMENT_B1, FRAGMENT_P1)
  const textB = windowHashes(text, minLen, FRAGMENT_B2, FRAGMENT_P2)
  for (let i = 0; i < textA.length; i++) {
    if (setA.has(textA[i]) && setB.has(textB[i])) return true
  }
  return false
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
  // Partial serialized fragment (prefix/middle/suffix ≥ CONTEXT_FRAGMENT_MIN
  // contiguous chars, e.g. a truncated chunk missing the version marker) →
  // redact whole stream.
  if (opts.contextJson !== null && containsContextFragment(text, opts.contextJson)) {
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
