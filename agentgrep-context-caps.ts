// agentgrep-context-caps — hard caps for the harness context adapter, exported
// as testable constants. Every bounded decision in the context pipeline (SDK
// pagination, shape ingestion, source/output bytes, path/region/symbol counts,
// tempfile JSON bytes, SQLite rows/bytes, stat calls, string truncation) flows
// through these so a single oversized exposure can never grow unbounded and
// malformed/oversized data always degrades to "no context" (never to context
// that exceeds its bound).
//
// ⚠️ This module is NOT a plugin entrypoint. Only index.ts may be loaded by
// OpenCode as a plugin, and it exports exactly one thing (the default fn).

/** Max SDK pagination pages fetched before giving up. */
export const CONTEXT_CAP_PAGES = 5

/** Max normalized context messages ingested across all sources. */
export const CONTEXT_CAP_MESSAGES = 400

/** Max normalized context parts ingested (v1 `{info, parts}` side). */
export const CONTEXT_CAP_PARTS = 1200

/**
 * Max bytes of raw message/part source JSON considered while ingesting. The
 * normalizer counts the serialized length of every record it accepts and stops
 * (fail-closed → truncate / no context above this) before reaching remote or
 * diskside data beyond the bound.
 */
export const CONTEXT_CAP_SOURCE_BYTES = 4_000_000

/** Max serialized harness-context JSON bytes we will write to the tempfile. */
export const CONTEXT_CAP_JSON_BYTES = 512_000

/** Max distinct unique candidate paths accepted before we stop adding focus files. */
export const CONTEXT_CAP_UNIQUE_PATHS = 500

/** Max known_files entries after dedupe. */
export const CONTEXT_CAP_KNOWN_FILES = 250

/** Max known_regions entries after dedupe. */
export const CONTEXT_CAP_KNOWN_REGIONS = 250

/** Max known_symbols entries after dedupe. */
export const CONTEXT_CAP_KNOWN_SYMBOLS = 500

/** Max focus_files entries. */
export const CONTEXT_CAP_FOCUS_FILES = 100

/**
 * Max line span tolerated for any single known_region range
 * (end_line - start_line + 1). Larger ranges are clamped to this bound.
 */
export const CONTEXT_CAP_LINE_RANGE = 10_000

/** Max chars for any single serialized context string field (symbol, path suffix). */
export const CONTEXT_CAP_STRING_LEN = 500

/** Max structured output lines scanned for outline/trace/grep/find parsing. */
export const CONTEXT_CAP_OUTPUT_LINES = 20_000

/** Max distinct bounded stat()/mtime calls made while deriving freshness. */
export const CONTEXT_CAP_MTIME_STATS = 300

/** Max SQLite message rows read in the fallback (per table). */
export const CONTEXT_CAP_SQL_ROWS = 2_000

/** Max accumulated `data` JSON bytes read from SQLite before stopping. */
export const CONTEXT_CAP_SQL_BYTES = 4_000_000

/** Conservative session-id whitelist (jcode-style opaque ids, no separators). */
export const CONTEXT_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/