// agentgrep-context-schema — PURE shape normalization + bounded ingestion for
// the harness context adapter. No fs, no network, no SDK imports: it turns the
// many possible session-message shapes (v1 `{info, parts}` arrays, v2 projected
// messages, `{ data: [...] }` envelopes) into a single bounded
// `NormalizedContextMessage[]` that the builder (`agentgrep-context-build.ts`)
// turns into jcode's harness JSON.
//
// Only paths that appear under explicit `path`/`file`/`file_path` keys, local
// `file://` attachments, assistant snapshot.files, and v2 explicit outputPaths
// survive as candidate paths. Tool OUTPUT text is carried out only so the
// structured outline/trace/find/grep parsers can read known result shapes; the
// builder never copies freeform output text itself.
//
// Caps are EARLY and GLOBAL: message count, total parts across ALL messages,
// and total UTF-8 source bytes are enforced while ingesting — before mapping,
// serializing, or scanning beyond the bound. v1 parts arrays and v2 content/
// files arrays are scanned only up to bounded prefixes, and records are byte-
// counted with a bounded serializer (never an unbounded `JSON.stringify`).
//
// Cross-session safety: any message OR part that EXPLICITLY declares a
// `sessionID` different from the caller's is skipped BEFORE path extraction.
// Records/parts that carry no sessionID are accepted because they were already
// keyed by the caller's session.
//
// Errors are never thrown: malformed/missing/unreadable input degrades to an
// empty (bounded) result so the caller can fall through gracefully.
//
// ⚠️ NOT a plugin entrypoint. Only index.ts is loaded by OpenCode.

import {
  CONTEXT_CAP_MESSAGES,
  CONTEXT_CAP_PARTS,
  CONTEXT_CAP_SOURCE_BYTES,
} from "./agentgrep-context-caps"
import { boundedUtf8Bytes } from "./agentgrep-context-bytes"

export interface NormalizedContextPart {
  /**
   * Part kind: "text" | "file" | "tool" | "snapshot" | "patch" | "compaction"
   * | "other". Only the kinds above ever carry derived context data.
   */
  kind: string
  /** Explicit single path from a known key (read `file_path`, outline `file`). */
  filePath?: string
  /** Explicit path from a completed tool's `path` key (trace path hint, glob). */
  toolPath?: string
  /** Tool id when this part is a completed tool part. */
  tool?: string
  /** Detected agentgrep-family mode: "grep"|"find"|"outline"|"trace"|"smart". */
  toolMode?: string
  /** Bounded structured-output text (outline/trace/find/grep result lines). */
  toolOutput?: string
  /** Bounded read range (start_line). */
  lineStart?: number
  /** Bounded read range (end_line). */
  lineEnd?: number
  /** Local file attachment paths (file:// or filesystem paths). */
  attachmentPaths?: string[]
  /** Assistant snapshot.files (v2). */
  snapshotFiles?: string[]
  /** Explicit v1 PatchPart.files. */
  patchFiles?: string[]
  /** v2 user-message file uris (only file:// considered by the builder). */
  userFileUris?: string[]
  /** Explicit v2 completed-tool outputPaths. */
  outputPaths?: string[]
  /** True when this part is a compaction boundary marker. */
  compaction?: boolean
}

export interface NormalizedContextMessage {
  id: string
  /** Present when the source record explicitly declared it. */
  sessionID?: string
  role?: string
  /** Stable ordinal (source order) used for exposure position tuning. */
  index: number
  /** Epoch ms when the source exposed it (for freshness). */
  timestamp?: number
  /** True when sourced from the post-compaction "active context" endpoint. */
  fromActiveContext?: boolean
  parts: NormalizedContextPart[]
}

export interface NormalizeResult {
  messages: NormalizedContextMessage[]
  /** Count of records/parts skipped (other-session or malformed). */
  skipped: number
  /** True when bounds forced us to stop ingesting (source truncated). */
  truncated: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

/** True when an explicit sessionID mismatches the current session. */
function belongsToOtherSession(record: unknown, currentSession: string, stats: IngestStats): boolean {
  if (!isRecord(record)) return false
  const declared = str(record.sessionID)
  if (declared !== undefined && declared !== currentSession) {
    stats.skipped++
    return true
  }
  return false
}

/** Bounded per-message helpers (assistant content / user files / tool text). */
const MAX_V2_CONTENT_SCAN = 10_000
const MAX_V2_FILES_SCAN = 1_000
const MAX_V2_TOOL_TEXT_SCAN = 500
const MAX_V1_PARTS_SCAN = 10_000

/**
 * The set of tool ids (and safe aliases) whose completed-state inputs/outputs
 * we trust for explicit path extraction. Find/grep/glob/agentgrep family.
 */
const PATH_TOOL_IDS = new Set([
  "read",
  "agentgrep",
  "grep",
  "file_grep",
  "Grep",
  "find",
  "glob",
])

function boundedOut(text: unknown, maxLen: number): string | undefined {
  const s = str(text)
  if (s === undefined || s === "") return undefined
  return s.length > maxLen ? s.slice(0, maxLen) : s
}

interface IngestPartsBudget {
  /** Remaining global parts across ALL messages. */
  parts: number
}

interface IngestStats {
  skipped: number
  /** Set when a cap forced us to drop parts/messages mid-ingestion. */
  truncated: boolean
}

function normalizeV1InfoPartsPair(
  info: unknown,
  partsRaw: unknown,
  currentSession: string,
  budget: IngestPartsBudget,
  stats: IngestStats,
): NormalizedContextMessage | null {
  if (!isRecord(info)) return null
  const id = str(info.id) ?? "unknown"
  const sessionID = str(info.sessionID)
  const role = str(info.role)
  const timestamp = isRecord(info.time) ? num(info.time.created) : undefined
  const parts: NormalizedContextPart[] = []
  if (Array.isArray(partsRaw)) {
    const maxParts = Math.min(partsRaw.length, MAX_V1_PARTS_SCAN)
    for (let i = 0; i < maxParts; i++) {
      if (budget.parts <= 0) {
        stats.truncated = true
        break
      }
      const part = normalizeV1Part(partsRaw[i], currentSession, budget, stats)
      if (part) parts.push(part)
    }
  }
  return { id, sessionID, role, index: 0, timestamp, parts }
}

function normalizeV1Part(
  raw: unknown,
  currentSession: string,
  budget: IngestPartsBudget,
  stats: IngestStats,
): NormalizedContextPart | null {
  if (!isRecord(raw)) return null
  if (belongsToOtherSession(raw, currentSession, stats)) return null
  const type = str(raw.type) ?? "other"
  let part: NormalizedContextPart
  if (type === "file") {
    // Local user file attachment: url may be `file://` or a filesystem path;
    // source.path is an explicit path. Bounded.
    const urls: string[] = []
    if (typeof raw.url === "string") urls.push(raw.url)
    const source = isRecord(raw.source) && typeof raw.source.path === "string" ? raw.source.path : undefined
    const attachmentPaths = [...urls]
    if (source) attachmentPaths.push(source)
    part = { kind: "file" }
    if (attachmentPaths.length > 0) part.attachmentPaths = attachmentPaths.slice(0, 4)
  } else if (type === "tool") {
    if (!isRecord(raw.state) || str(raw.state.status) !== "completed") {
      return null
    }
    const tool = str(raw.tool) ?? "tool"
    if (!PATH_TOOL_IDS.has(tool)) return null
    const input = isRecord(raw.state.input) ? raw.state.input : {}
    const output = boundedOut(raw.state.output, 200_000)
    part = normalizeToolInput(tool, input, output)
  } else if (type === "snapshot") {
    // v1 snapshot part carries only a string hash — no file list. Nothing safe.
    return null
  } else if (type === "patch") {
    const patchFiles = Array.isArray(raw.files)
      ? raw.files.slice(0, 100).filter((f): f is string => typeof f === "string")
      : undefined
    part = { kind: "patch" }
    if (patchFiles && patchFiles.length > 0) part.patchFiles = patchFiles
  } else if (type === "compaction") {
    part = { kind: "compaction", compaction: true }
  } else {
    return null
  }
  budget.parts--
  return part
}

function v1ReadRange(input: Record<string, unknown>): { lineStart: number; lineEnd: number } | undefined {
  const start = num(input.start_line) ?? num(input.offset)
  if (start === undefined) return undefined
  const end = num(input.end_line)
  if (end !== undefined) return { lineStart: Math.max(1, start), lineEnd: Math.max(Math.max(1, start), end) }
  const limit = num(input.limit) ?? 200
  const s = Math.max(1, start)
  return { lineStart: s, lineEnd: s + Math.max(0, limit) - 1 }
}

function normalizeToolInput(tool: string, input: Record<string, unknown>, output?: string): NormalizedContextPart {
  const part: NormalizedContextPart = { kind: "tool", tool }
  const filePath = str(input.file_path) ?? str(input.file) ?? str(input.filePath)
  const pathVal = str(input.path)
  const mode = str(input.mode)

  if (tool === "read") {
    if (filePath) part.filePath = filePath
    const range = v1ReadRange(input)
    if (range) {
      part.lineStart = range.lineStart
      part.lineEnd = range.lineEnd
    }
    // read output is freeform — never captured.
    return part
  }

  if (tool === "agentgrep" || tool === "grep" || tool === "file_grep" || tool === "Grep") {
    if (mode === "outline") {
      part.toolMode = "outline"
      const outlineFile = filePath ?? str(input.query)
      if (outlineFile) part.filePath = outlineFile
      if (output) part.toolOutput = output
      return part
    }
    if (mode === "trace" || mode === "smart") {
      part.toolMode = mode
      if (pathVal) part.toolPath = pathVal
      if (output) part.toolOutput = output
      return part
    }
    if (mode === "find") {
      part.toolMode = "find"
      if (pathVal) part.toolPath = pathVal
      if (output) part.toolOutput = output
      return part
    }
    // plain grep mode → path:line match hits from structured output only.
    part.toolMode = "grep"
    if (pathVal) part.toolPath = pathVal
    if (output) part.toolOutput = output
    return part
  }

  if (tool === "find") {
    part.toolMode = "find"
    if (pathVal) part.toolPath = pathVal
    // find's ranked output is a known structured format (parse by builder).
    if (output) part.toolOutput = output
    return part
  }

  if (tool === "glob") {
    part.toolMode = "glob"
    // Only an explicit path key is trusted for glob; pattern output is skipped.
    if (pathVal) part.toolPath = pathVal
    return part
  }

  return part
}

/**
 * Normalize a single v2 projected session message into a NormalizedContextMessage.
 * These records (SessionMessageUser/Assistant/Synthetic/System/Shell/
 * Compaction) rarely carry a sessionID, so cross-session filtering only applies
 * when one is explicitly present — at the message level AND on nested file/
 * content records before any path extraction.
 */
function normalizeV2Message(
  raw: unknown,
  index: number,
  currentSession: string,
  budget: IngestPartsBudget,
  stats: IngestStats,
): NormalizedContextMessage | null {
  if (!isRecord(raw)) return null
  if (belongsToOtherSession(raw, currentSession, stats)) return null
  const type = str(raw.type)
  const id = str(raw.id) ?? "unknown"
  const timestamp = isRecord(raw.time) ? num(raw.time.created) : undefined
  const base = { id, index, timestamp, sessionID: str(raw.sessionID) }

  if (type === "user") {
    const uris: string[] = []
    if (Array.isArray(raw.files)) {
      const maxFiles = Math.min(raw.files.length, MAX_V2_FILES_SCAN)
      for (let i = 0; i < maxFiles; i++) {
        const f = raw.files[i]
        if (!isRecord(f)) continue
        if (belongsToOtherSession(f, currentSession, stats)) continue
        const uri = str(f.uri)
        if (uri) uris.push(uri)
      }
    }
    const msg: NormalizedContextMessage = { ...base, parts: [] }
    if (uris.length > 0 && budget.parts > 0) {
      msg.parts.push({ kind: "file", userFileUris: uris.slice(0, 20) })
      budget.parts--
    } else if (uris.length > 0) {
      stats.truncated = true // file attachment dropped by the parts budget
    }
    return msg
  }

  if (type === "assistant") {
    const snapshotFilesRaw = isRecord(raw.snapshot) && Array.isArray(raw.snapshot.files)
      ? (raw.snapshot.files as unknown[])
      : undefined
    const snapshotFiles = snapshotFilesRaw
      ? snapshotFilesRaw.slice(0, 200).filter((f): f is string => typeof f === "string")
      : undefined
    const parts: NormalizedContextPart[] = []
    if (Array.isArray(raw.content)) {
      const maxContent = Math.min(raw.content.length, MAX_V2_CONTENT_SCAN)
      for (let i = 0; i < maxContent; i++) {
        if (budget.parts <= 0) {
          stats.truncated = true
          break
        }
        const c = raw.content[i]
        if (!isRecord(c)) continue
        if (belongsToOtherSession(c, currentSession, stats)) continue
        if (str(c.type) !== "tool" || !str(c.name)) continue
        const tool = str(c.name)!
        if (!PATH_TOOL_IDS.has(tool)) continue
        const state = isRecord(c.state) ? c.state : {}
        if (str(state.status) !== "completed") continue
        if (belongsToOtherSession(state, currentSession, stats)) continue
        const input = isRecord(state.input) ? state.input : {}
        const outputPaths = Array.isArray(state.outputPaths)
          ? state.outputPaths.slice(0, 200).filter((p): p is string => typeof p === "string")
          : undefined
        const text = extractV2ToolText(state.content)
        const p = normalizeToolInput(tool, input, text)
        if (outputPaths && outputPaths.length > 0) p.outputPaths = outputPaths
        // v2 completed tool attachments are explicit file uris.
        if (Array.isArray(state.attachments)) {
          const uris: string[] = []
          const maxAtt = Math.min(state.attachments.length, MAX_V2_FILES_SCAN)
          for (let j = 0; j < maxAtt; j++) {
            const a = state.attachments[j]
            if (!isRecord(a)) continue
            if (belongsToOtherSession(a, currentSession, stats)) continue
            const uri = str(a.uri)
            if (uri) uris.push(uri)
          }
          if (uris.length > 0) p.attachmentPaths = p.attachmentPaths ? [...p.attachmentPaths, ...uris] : uris
        }
        parts.push(p)
        budget.parts--
      }
    }
    const msg: NormalizedContextMessage = { ...base, parts }
    if (snapshotFiles && snapshotFiles.length > 0 && budget.parts > 0) {
      msg.parts.push({ kind: "snapshot", snapshotFiles })
      budget.parts--
    } else if (snapshotFiles && snapshotFiles.length > 0) {
      stats.truncated = true // snapshot dropped by the parts budget
    }
    return msg
  }

  if (type === "compaction") {
    const msg: NormalizedContextMessage = { ...base, parts: [] }
    if (budget.parts > 0) {
      msg.parts.push({ kind: "compaction", compaction: true })
      budget.parts--
    } else {
      stats.truncated = true
    }
    return msg
  }

  // synthetic/system/shell carry sessionID; shell output is skipped entirely
  // (bash command parsing is not in the safe tool set).
  return { ...base, parts: [] }
}

function extractV2ToolText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  let out = ""
  const maxItems = Math.min(content.length, MAX_V2_TOOL_TEXT_SCAN)
  for (let i = 0; i < maxItems; i++) {
    const item = content[i]
    if (!isRecord(item)) continue
    if (str(item.type) === "text") {
      const t = str(item.text)
      if (t) {
        out += t + "\n"
        if (out.length > 200_000) break
      }
    }
  }
  return out === "" ? undefined : (out.length > 200_000 ? out.slice(0, 200_000) : out)
}

/** Unwrap a hey-api "fields"-style result envelope ({data,error,response,...}). */
export function unwrapResult(raw: unknown): unknown {
  if (isRecord(raw) && "data" in raw && ("error" in raw || "request" in raw || "response" in raw)) {
    return raw.data
  }
  return raw
}

/**
 * Turn any supported messages payload into a flat list of raw per-message
 * records, preserving order. Accepts:
 *   - `{ data: [...] }` envelopes
 *   - plain arrays of `{ info, parts }` (v1 via SDK, both shapes)
 *   - plain arrays of v2 projected session messages
 *   - a single `{ info, parts }`
 */
function flattenRecordList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (!isRecord(raw)) return []
  if (Array.isArray(raw.data)) return raw.data
  if ("info" in raw && "parts" in raw) return [raw]
  return []
}

/**
 * Pure, bounded normalizer. Never throws. Applies per-message/part shape
 * detection, explicit cross-session filtering, and EARLY GLOBAL caps:
 *   - message count (CONTEXT_CAP_MESSAGES)
 *   - total parts across ALL messages (CONTEXT_CAP_PARTS), decremented while
 *     mapping v1 parts / v2 content, so oversized arrays stop being scanned
 *     before normalization
 *   - total UTF-8 source bytes (CONTEXT_CAP_SOURCE_BYTES), measured with a
 *     bounded serializer so deep/large records are rejected without
 *     unbounded allocation
 *
 * `fromActiveContext` marks the whole batch as post-compaction active-context
 * data (the v2 context endpoint is documented as "all messages after the last
 * compaction") so the builder can emit truthful markers without overclaiming.
 */
export function normalizeContextMessages(
  raw: unknown,
  opts: { sessionID: string; fromActiveContext?: boolean },
): NormalizeResult {
  const out: NormalizedContextMessage[] = []
  const stats: IngestStats = { skipped: 0, truncated: false }
  let truncated = false
  let bytes = 0
  const partsBudget: IngestPartsBudget = { parts: CONTEXT_CAP_PARTS }

  const records = flattenRecordList(raw)
  for (const record of records) {
    if (out.length >= CONTEXT_CAP_MESSAGES) {
      truncated = true
      break
    }
    if (partsBudget.parts <= 0) {
      truncated = true
      break
    }
    const remaining = CONTEXT_CAP_SOURCE_BYTES - bytes
    if (remaining <= 0) {
      truncated = true
      break
    }
    const { bytes: recBytes, oversized } = boundedUtf8Bytes(record, remaining)
    if (oversized) {
      truncated = true
      break
    }
    bytes += recBytes
    const msg = normalizeOne(record, opts.sessionID, partsBudget, stats)
    if (!msg) {
      stats.skipped++
      continue
    }
    if (msg.sessionID !== undefined && msg.sessionID !== opts.sessionID) {
      stats.skipped++
      continue
    }
    msg.index = out.length
    msg.fromActiveContext = msg.fromActiveContext ?? opts.fromActiveContext
    out.push(msg)
  }
  return { messages: out, skipped: stats.skipped, truncated: truncated || stats.truncated }
}

function normalizeOne(
  record: unknown,
  currentSession: string,
  budget: IngestPartsBudget,
  stats: IngestStats,
): NormalizedContextMessage | null {
  if (!isRecord(record)) return null
  // v2 projected messages have a `type` at the top level AND no `info`.
  if (!("info" in record) && "type" in record) {
    return normalizeV2Message(record, 0, currentSession, budget, stats)
  }
  // v1 { info, parts }
  const info = record.info
  const parts = record.parts
  if (isRecord(info)) return normalizeV1InfoPartsPair(info, parts, currentSession, budget, stats)
  return null
}