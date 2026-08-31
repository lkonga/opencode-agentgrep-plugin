// agentgrep-context-bytes — bounded UTF-8 byte measurement for context data.
//
// Every cap that is named in BYTES (source accumulation, harness serialization,
// tempfile JSON, SQLite rows) must count UTF-8 bytes (`Buffer.byteLength` /
// TextEncoder), never `String.length` code units. Counting bytes naively via
// `JSON.stringify(...).length` allocates an unbounded copy for arbitrarily
// deep/large records, so this module:
//   1. runs a bounded structural guard FIRST (depth + container-entry caps +
//      total-string-char cap + cycle detection) that rejects oversized/deep/
//      cyclic records before any serialization, and
//   2. only then serializes (allocation is bounded by the guard) and measures
//      the exact UTF-8 byte length.
//
// All bounds are exported testable constants. The guard is fail-closed: any
// abnormality reports `oversized` so callers degrade to "no context" instead of
// allocating unboundedly.
//
// ⚠️ NOT a plugin entrypoint. Only index.ts is loaded by OpenCode.

/** Max JSON nesting depth accepted for byte counting (deeper → oversized). */
export const MAX_JSON_DEPTH = 64

/** Max total container entries (array items + object keys) accepted. */
export const MAX_JSON_ENTRIES = 200_000

/**
 * Max total string chars scanned in the guard. `chars <= bytes`, so once chars
 * exceed the byte budget the record is definitely over budget and we skip
 * serialization entirely.
 */
export const MAX_JSON_STRING_CHARS = 16 * 1024 * 1024

export interface BoundedBytes {
  /** Exact UTF-8 byte length of the serialization (when within bounds). */
  bytes: number
  /** True when the value exceeded depth/entry/string/byte limits (fail-closed). */
  oversized: boolean
}

/**
 * Bounded structural guard: iterative walk (no recursion), cycle-safe, caps
 * depth, container entries, and total string chars. Returns false when the
 * record is too deep/large/cyclic to serialize safely.
 */
function walkGuard(value: unknown, maxBytes: number): boolean {
  const stack: Array<{ v: unknown; depth: number }> = [{ v: value, depth: 0 }]
  const seen = new WeakSet<object>()
  let entries = 0
  let stringChars = 0
  while (stack.length > 0) {
    const { v, depth } = stack.pop()!
    if (depth > MAX_JSON_DEPTH) return false
    if (Array.isArray(v)) {
      if (seen.has(v)) return false // cycle → oversized
      seen.add(v)
      entries += v.length
      if (entries > MAX_JSON_ENTRIES) return false
      for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i], depth: depth + 1 })
    } else if (v !== null && typeof v === "object") {
      if (seen.has(v)) return false
      seen.add(v)
      let keys: string[]
      try {
        keys = Object.keys(v)
      } catch {
        return false
      }
      entries += keys.length
      if (entries > MAX_JSON_ENTRIES) return false
      for (let i = keys.length - 1; i >= 0; i--) {
        stringChars += keys[i].length
        if (stringChars > maxBytes || stringChars > MAX_JSON_STRING_CHARS) return false
        let child: unknown
        try {
          child = (v as Record<string, unknown>)[keys[i]]
        } catch {
          return false // getter threw → oversized
        }
        stack.push({ v: child, depth: depth + 1 })
      }
    } else if (typeof v === "string") {
      stringChars += v.length
      if (stringChars > maxBytes || stringChars > MAX_JSON_STRING_CHARS) return false
    }
  }
  return true
}

/**
 * Exact UTF-8 byte count of `JSON.stringify(value)`, guarded so oversized,
 * deep, cyclic, or getter-throwing records report `oversized` WITHOUT a large
 * serialization allocation. Never throws.
 */
export function boundedUtf8Bytes(value: unknown, maxBytes: number): BoundedBytes {
  const cap = Math.max(1, maxBytes)
  if (!walkGuard(value, cap)) return { bytes: cap + 1, oversized: true }
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    return { bytes: cap + 1, oversized: true }
  }
  const bytes = Buffer.byteLength(json)
  return { bytes, oversized: bytes > cap }
}

/** Exact UTF-8 byte length of an existing string (no allocation). */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text)
}