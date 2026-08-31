// agentgrep-context-build — turns bounded normalized session messages
// (`agentgrep-context-schema.ts`) into jcode's AgentGrep harness JSON
// (`HarnessContext`), honoring privacy/containment and hard caps.
//
// Only paths derived from EXPLICIT known shapes survive:
//   - assistant snapshot.files (v2)
//   - local user file attachments represented as filesystem / `file://` paths
//   - completed tool parts for read / agentgrep / grep / file_grep / Grep /
//     find / glob, using only explicit `path`/`file`/`file_path` keys and known
//     structured output formats (outline structure items, trace sections,
//     `path:line:` grep hits, ranked find headers, v2 explicit outputPaths).
//
// Every candidate path is canonicalized (symlinks resolved; nonexistent leaves
// via nearest existing ancestor) and must be canonically contained within the
// effective search root. Paths serialize as safe RELATIVE paths; anything that
// escapes the root is dropped. No freeform prompts, credentials, environment,
// arbitrary DB contents, or arbitrary output text is ever copied into context.
//
// Symbols are parsed only from AgentGrep outline/trace structured result lines,
// bounded and truncated. mtime/freshness come from bounded stat() calls, and
// active-context/recent/older/compacted markers are only emitted when the data
// actually supports them ("Do not claim more than data proves").
//
// Deterministic output: dedupe merges confidence maxima + reason unions and
// sorts every list. If nothing usable survives → null (no context). Errors
// never throw here.
//
// ⚠️ NOT a plugin entrypoint. Only index.ts is loaded by OpenCode.

import path from "node:path"
import fs from "node:fs"
import { canonicalizePath, isWithinPath } from "./agentgrep-paths"
import { boundedUtf8Bytes, utf8ByteLength } from "./agentgrep-context-bytes"
import {
  CONTEXT_CAP_FOCUS_FILES,
  CONTEXT_CAP_JSON_BYTES,
  CONTEXT_CAP_KNOWN_FILES,
  CONTEXT_CAP_KNOWN_REGIONS,
  CONTEXT_CAP_KNOWN_SYMBOLS,
  CONTEXT_CAP_LINE_RANGE,
  CONTEXT_CAP_MTIME_STATS,
  CONTEXT_CAP_OUTPUT_LINES,
  CONTEXT_CAP_STRING_LEN,
  CONTEXT_CAP_UNIQUE_PATHS,
} from "./agentgrep-context-caps"
import type { NormalizedContextMessage, NormalizedContextPart } from "./agentgrep-context-schema"

// ── Harness context shapes (jcode AgentGrepHarnessContext parity) ────────────

export interface HarnessKnownFile {
  path: string
  structure_confidence: number
  body_confidence: number
  current_version_confidence: number
  prune_confidence: number
  source_strength: string
  reasons: string[]
}

export interface HarnessKnownRegion {
  path: string
  start_line: number
  end_line: number
  body_confidence: number
  current_version_confidence: number
  prune_confidence: number
  source_strength: string
  reasons: string[]
}

export interface HarnessKnownSymbol {
  path: string
  symbol: string
  kind?: string
  structure_confidence: number
  body_confidence: number
  current_version_confidence: number
  prune_confidence: number
  source_strength: string
  reasons: string[]
}

export interface HarnessContext {
  version: 1
  known_files: HarnessKnownFile[]
  known_regions: HarnessKnownRegion[]
  known_symbols: HarnessKnownSymbol[]
  focus_files: string[]
}

export interface BuildOpts {
  messages: NormalizedContextMessage[]
  /** Canonical absolute search root; relative context paths serialize against it. */
  searchRoot: string
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

function trunc(s: string, max = CONTEXT_CAP_STRING_LEN): string {
  return s.length > max ? s.slice(0, max) : s
}

function mergeReasons(target: string[], extra: string[]): void {
  for (const r of extra) {
    if (!target.includes(r)) target.push(r)
  }
}

// ── Path resolution / containment ────────────────────────────────────────────

function trimQuotes(s: string): string {
  return s.trim().replace(/^["']+|["']+$/g, "")
}

/** Convert a `file://` URL into a filesystem absolute path (or null). */
function fileUrlToPath(raw: string): string | null {
  const t = raw.trim()
  if (t.startsWith("file://")) {
    try {
      const u = new URL(t)
      if (u.protocol !== "file:") return null
      return decodeURIComponent(u.pathname)
    } catch {
      return null
    }
  }
  return null
}

/**
 * Resolve + canonicalize + containment-check a candidate path string against
 * the canonical search root. Returns a safe RELATIVE path (posix separators)
 * on success, or null when the candidate is unusable / escapes the root.
 */
export function resolveContextRelativePath(candidate: string, searchRoot: string): string | null {
  const rawFile = fileUrlToPath(candidate) ?? trimQuotes(candidate)
  if (!rawFile || rawFile === "") return null
  const cleaned = rawFile.startsWith("./") ? rawFile.slice(2) : rawFile
  if (cleaned === "" || cleaned === "." || cleaned === "..") return null
  if (cleaned.includes("\u0000")) return null
  const target = path.isAbsolute(cleaned) ? cleaned : path.resolve(searchRoot, cleaned)
  let canonical: string
  try {
    canonical = canonicalizePath(target)
  } catch {
    return null
  }
  if (!isWithinPath(searchRoot, canonical)) return null
  if (canonical === searchRoot) return null
  let rel = path.relative(searchRoot, canonical)
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null
  return trunc(rel.split(path.sep).join("/"))
}

// ── Freshness (bounded stat) ─────────────────────────────────────────────────

/** A bounded mtime cache over relative context paths. */
export class FreshnessCache {
  private stats = 0
  private readonly map = new Map<string, number | undefined>()

  mtimeMs(relPath: string, absoluteForStat: string): number | undefined {
    if (this.map.has(relPath)) return this.map.get(relPath)
    if (this.stats >= CONTEXT_CAP_MTIME_STATS) {
      this.map.set(relPath, undefined)
      return undefined
    }
    this.stats++
    let mtime: number | undefined
    try {
      mtime = fs.statSync(absoluteForStat).mtimeMs
    } catch {
      mtime = undefined
    }
    this.map.set(relPath, mtime)
    return mtime
  }
}

/**
 * jcode freshness multiplier + reasons. `exposureTime` is epoch ms; when it is
 * undefined or the stat fails we refuse to claim a freshness reason (we cannot
 * prove change/unchanged without both sides of the comparison).
 */
export function tuneFreshness(
  relPath: string,
  searchRoot: string,
  exposureTime: number | undefined,
  cache: FreshnessCache,
): { multiplier: number; reasons: string[] } {
  if (exposureTime === undefined) return { multiplier: 0.7, reasons: [] }
  const abs = path.join(searchRoot, relPath)
  const mtime = cache.mtimeMs(relPath, abs)
  if (mtime === undefined) return { multiplier: 0.72, reasons: [] }
  if (mtime <= exposureTime) return { multiplier: 1.0, reasons: ["file_unchanged_since_seen"] }
  const deltaSec = (mtime - exposureTime) / 1000
  const reasons = ["file_changed_since_seen"]
  if (deltaSec <= 5) return { multiplier: 0.92, reasons }
  if (deltaSec <= 600) return { multiplier: 0.68, reasons }
  if (deltaSec <= 3600 * 6) return { multiplier: 0.45, reasons }
  return { multiplier: 0.25, reasons }
}

// ── Memory / position tuning ─────────────────────────────────────────────────

export interface ExposureMeta {
  totalMessages: number
  index: number
  /** Index of the last compaction marker + 1; -1 when no compaction observed. */
  compactionCutoff: number
  fromActiveContext: boolean
  /** Epoch ms of the exposing message, when known. */
  exposureTime?: number
}

/**
 * jcode memory tuning: compacted_history for exposures before a compaction
 * marker, active_context_tail for the tail (or any exposure from the
 * post-compaction active-context endpoint), recent_context / older_context by
 * position ratio otherwise.
 */
function memoryTuning(meta: ExposureMeta): { multiplier: number; reasons: string[] } {
  if (meta.compactionCutoff >= 0 && meta.index < meta.compactionCutoff) {
    return { multiplier: 0.42, reasons: ["compacted_history"] }
  }
  const positionRatio = meta.totalMessages <= 1 ? 1.0 : (meta.index + 1) / meta.totalMessages
  if (meta.fromActiveContext || positionRatio >= 0.85) {
    return { multiplier: 1.0, reasons: ["active_context_tail"] }
  }
  if (positionRatio >= 0.6) return { multiplier: 0.88, reasons: ["recent_context"] }
  return { multiplier: 0.72, reasons: ["older_context"] }
}

// ── Accumulator (bounded, deduping, deterministic) ───────────────────────────

class Accumulator {
  readonly files = new Map<string, HarnessKnownFile>()
  readonly regions = new Map<string, HarnessKnownRegion>()
  readonly symbols = new Map<string, HarnessKnownSymbol>()
  readonly focus = new Set<string>()
  uniquePaths = 0

  pushFile(file: HarnessKnownFile): void {
    const existing = this.files.get(file.path)
    if (existing) {
      existing.structure_confidence = Math.max(existing.structure_confidence, file.structure_confidence)
      existing.body_confidence = Math.max(existing.body_confidence, file.body_confidence)
      existing.current_version_confidence = Math.max(existing.current_version_confidence, file.current_version_confidence)
      existing.prune_confidence = Math.max(existing.prune_confidence, file.prune_confidence)
      mergeReasons(existing.reasons, file.reasons)
      return
    }
    if (this.files.size >= CONTEXT_CAP_KNOWN_FILES) return
    this.files.set(file.path, file)
  }

  pushRegion(region: HarnessKnownRegion): void {
    const key = `${region.path}|${region.start_line}|${region.end_line}`
    const existing = this.regions.get(key)
    if (existing) {
      existing.body_confidence = Math.max(existing.body_confidence, region.body_confidence)
      existing.current_version_confidence = Math.max(existing.current_version_confidence, region.current_version_confidence)
      existing.prune_confidence = Math.max(existing.prune_confidence, region.prune_confidence)
      mergeReasons(existing.reasons, region.reasons)
      return
    }
    if (this.regions.size >= CONTEXT_CAP_KNOWN_REGIONS) return
    this.regions.set(key, region)
  }

  pushSymbol(symbol: HarnessKnownSymbol): void {
    const key = `${symbol.path}|${symbol.symbol}|${symbol.kind ?? ""}`
    const existing = this.symbols.get(key)
    if (existing) {
      existing.structure_confidence = Math.max(existing.structure_confidence, symbol.structure_confidence)
      existing.body_confidence = Math.max(existing.body_confidence, symbol.body_confidence)
      existing.current_version_confidence = Math.max(existing.current_version_confidence, symbol.current_version_confidence)
      existing.prune_confidence = Math.max(existing.prune_confidence, symbol.prune_confidence)
      mergeReasons(existing.reasons, symbol.reasons)
      return
    }
    if (this.symbols.size >= CONTEXT_CAP_KNOWN_SYMBOLS) return
    this.symbols.set(key, symbol)
  }

  pushFocus(relPath: string): void {
    if (this.focus.has(relPath)) return
    if (this.uniquePaths >= CONTEXT_CAP_UNIQUE_PATHS) return
    this.uniquePaths++
    if (this.focus.size < CONTEXT_CAP_FOCUS_FILES) this.focus.add(relPath)
  }

  toContext(): HarnessContext {
    const sortStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
    const knownFiles = [...this.files.values()].sort((a, b) => sortStr(a.path, b.path))
    const knownRegions = [...this.regions.values()].sort((a, b) => {
      const byPath = sortStr(a.path, b.path)
      if (byPath !== 0) return byPath
      return a.start_line - b.start_line || a.end_line - b.end_line
    })
    const knownSymbols = [...this.symbols.values()].sort((a, b) => {
      const byPath = sortStr(a.path, b.path)
      if (byPath !== 0) return byPath
      return sortStr(a.symbol, b.symbol)
    })
    const focusFiles = [...this.focus].sort(sortStr)
    return {
      version: 1,
      known_files: knownFiles,
      known_regions: knownRegions,
      known_symbols: knownSymbols,
      focus_files: focusFiles,
    }
  }

  get isEmpty(): boolean {
    return (
      this.files.size === 0 &&
      this.regions.size === 0 &&
      this.symbols.size === 0 &&
      this.focus.size === 0
    )
  }
}

// ── Structured-output parsers (bounded, jcode-aligned) ───────────────────────

const STRUCTURE_ITEM_RE = /^-\s+([A-Za-z0-9_-]+)\s+(.+?)\s+@\s*(\d+)-(\d+)/
const REGION_HEADER_RE = /^-\s+(.+?)\s+@\s*(\d+)-(\d+)/
const RANKED_FILE_RE = /^\d+\.\s+(.+)$/
const PATH_LINE_RE = /^([^:\n]+):(\d+):/

/**
 * Scan up to CONTEXT_CAP_OUTPUT_LINES lines WITHOUT materializing the full
 * split array (a huge output string must not allocate an unbounded array).
 * Each line is trimmed.
 */
function boundedLines(text: string | undefined): string[] {
  if (!text) return []
  const lines: string[] = []
  let start = 0
  for (let n = 0; n < CONTEXT_CAP_OUTPUT_LINES; n++) {
    const nl = text.indexOf("\n", start)
    const line = nl === -1 ? text.slice(start) : text.slice(start, nl)
    lines.push(line.trim())
    if (nl === -1) break
    start = nl + 1
  }
  return lines
}

function boundedStart(s: number): number {
  return Math.max(1, Math.floor(s))
}
function boundedEnd(start: number, end: number): number {
  const s = Math.max(1, Math.floor(start))
  const e = Math.max(s, Math.floor(end))
  return Math.min(e, s + CONTEXT_CAP_LINE_RANGE - 1)
}

// ── Tuning helpers ───────────────────────────────────────────────────────────

function tuneFile(
  known: HarnessKnownFile,
  meta: ExposureMeta,
  cache: FreshnessCache,
  searchRoot: string,
): HarnessKnownFile {
  const mem = memoryTuning(meta)
  const fresh = tuneFreshness(known.path, searchRoot, meta.exposureTime, cache)
  known.structure_confidence = clamp(known.structure_confidence * (0.75 + 0.25 * mem.multiplier))
  known.body_confidence = clamp(known.body_confidence * mem.multiplier)
  known.prune_confidence = clamp(known.prune_confidence * mem.multiplier)
  known.current_version_confidence = clamp(known.current_version_confidence * fresh.multiplier)
  mergeReasons(known.reasons, mem.reasons)
  mergeReasons(known.reasons, fresh.reasons)
  return known
}

function tuneRegion(
  known: HarnessKnownRegion,
  meta: ExposureMeta,
  cache: FreshnessCache,
  searchRoot: string,
): HarnessKnownRegion {
  const mem = memoryTuning(meta)
  const fresh = tuneFreshness(known.path, searchRoot, meta.exposureTime, cache)
  known.body_confidence = clamp(known.body_confidence * mem.multiplier)
  known.prune_confidence = clamp(known.prune_confidence * mem.multiplier)
  known.current_version_confidence = clamp(known.current_version_confidence * fresh.multiplier)
  mergeReasons(known.reasons, mem.reasons)
  mergeReasons(known.reasons, fresh.reasons)
  return known
}

function tuneSymbol(
  known: HarnessKnownSymbol,
  meta: ExposureMeta,
  cache: FreshnessCache,
  searchRoot: string,
): HarnessKnownSymbol {
  const mem = memoryTuning(meta)
  const fresh = tuneFreshness(known.path, searchRoot, meta.exposureTime, cache)
  known.structure_confidence = clamp(known.structure_confidence * (0.75 + 0.25 * mem.multiplier))
  known.body_confidence = clamp(known.body_confidence * mem.multiplier)
  known.prune_confidence = clamp(known.prune_confidence * mem.multiplier)
  known.current_version_confidence = clamp(known.current_version_confidence * fresh.multiplier)
  mergeReasons(known.reasons, mem.reasons)
  mergeReasons(known.reasons, fresh.reasons)
  return known
}

// ── Collectors (per normalized part) ─────────────────────────────────────────

function collectPartExposures(
  part: NormalizedContextPart,
  searchRoot: string,
  acc: Accumulator,
  meta: ExposureMeta,
  cache: FreshnessCache,
): void {
  // Local user file attachments (file:// or filesystem paths).
  for (const raw of part.attachmentPaths ?? []) {
    const rel = resolveContextRelativePath(raw, searchRoot)
    if (!rel) continue
    acc.pushFocus(rel)
    acc.pushFile(
      tuneFile(
        {
          path: rel,
          structure_confidence: 0.3,
          body_confidence: 0.25,
          current_version_confidence: 0.7,
          prune_confidence: 0.3,
          source_strength: "full_region",
          reasons: ["user_file_attachment"],
        },
        meta,
        cache,
        searchRoot,
      ),
    )
  }
  // v2 user-message file uris — file:// only.
  for (const raw of part.userFileUris ?? []) {
    if (!raw.startsWith("file://")) continue
    const rel = resolveContextRelativePath(raw, searchRoot)
    if (!rel) continue
    acc.pushFocus(rel)
    acc.pushFile(
      tuneFile(
        {
          path: rel,
          structure_confidence: 0.3,
          body_confidence: 0.25,
          current_version_confidence: 0.7,
          prune_confidence: 0.3,
          source_strength: "full_region",
          reasons: ["user_file_attachment"],
        },
        meta,
        cache,
        searchRoot,
      ),
    )
  }
  // Assistant snapshot.files — structural only.
  for (const raw of part.snapshotFiles ?? []) {
    const rel = resolveContextRelativePath(raw, searchRoot)
    if (!rel) continue
    acc.pushFocus(rel)
    acc.pushFile(
      tuneFile(
        {
          path: rel,
          structure_confidence: 0.3,
          body_confidence: 0.2,
          current_version_confidence: 0.5,
          prune_confidence: 0.3,
          source_strength: "snippet",
          reasons: ["assistant_snapshot_file"],
        },
        meta,
        cache,
        searchRoot,
      ),
    )
  }
  // Explicit v2 completed-tool outputPaths.
  for (const raw of part.outputPaths ?? []) {
    const rel = resolveContextRelativePath(raw, searchRoot)
    if (!rel) continue
    acc.pushFocus(rel)
    acc.pushFile(
      tuneFile(
        {
          path: rel,
          structure_confidence: 0.4,
          body_confidence: 0.2,
          current_version_confidence: 0.7,
          prune_confidence: 0.4,
          source_strength: "match_line_only",
          reasons: ["agentgrep_result_path"],
        },
        meta,
        cache,
        searchRoot,
      ),
    )
  }

  if (part.kind !== "tool") return

  // read → explicit file_path + bounded range (jcode collect_read_exposure).
  if (part.tool === "read" && part.filePath) {
    const rel = resolveContextRelativePath(part.filePath, searchRoot)
    if (!rel) return
    acc.pushFocus(rel)
    const start = part.lineStart ?? 1
    const end = part.lineEnd ?? start
    acc.pushRegion(
      tuneRegion(
        {
          path: rel,
          start_line: boundedStart(start),
          end_line: boundedEnd(start, end),
          body_confidence: 0.85,
          current_version_confidence: 0.88,
          prune_confidence: 0.78,
          source_strength: "full_region",
          reasons: ["read_tool_exposure", "session_local_history"],
        },
        meta,
        cache,
        searchRoot,
      ),
    )
    acc.pushFile(
      tuneFile(
        {
          path: rel,
          structure_confidence: 0.55,
          body_confidence: 0.45,
          current_version_confidence: 0.88,
          prune_confidence: 0.4,
          source_strength: "snippet",
          reasons: ["read_tool_exposure"],
        },
        meta,
        cache,
        searchRoot,
      ),
    )
    return
  }

  // agentgrep family.
  if (part.tool === "agentgrep" || part.tool === "grep" || part.tool === "file_grep" || part.tool === "Grep") {
    if (part.toolMode === "outline" && part.filePath) {
      const rel = resolveContextRelativePath(part.filePath, searchRoot)
      if (!rel) return
      acc.pushFocus(rel)
      acc.pushFile(
        tuneFile(
          {
            path: rel,
            structure_confidence: 0.95,
            body_confidence: 0.15,
            current_version_confidence: 0.82,
            prune_confidence: 0.86,
            source_strength: "outline_only",
            reasons: ["agentgrep_outline_result"],
          },
          meta,
          cache,
          searchRoot,
        ),
      )
      collectOutlineSymbols(part.toolOutput, rel, searchRoot, acc, meta, cache)
      return
    }
    if (part.toolMode === "trace" || part.toolMode === "smart") {
      collectTraceExposure(part.toolOutput, part.toolPath, searchRoot, acc, meta, cache)
      return
    }
    if (part.toolMode === "find") {
      collectFindExposure(part.toolOutput, part.toolPath, searchRoot, acc, meta, cache)
      return
    }
    collectGrepExposure(part.toolOutput, part.toolPath, searchRoot, acc, meta, cache)
    return
  }

  if (part.tool === "find") {
    collectFindExposure(part.toolOutput, part.toolPath, searchRoot, acc, meta, cache)
    return
  }

  if (part.tool === "glob" && part.toolPath) {
    const rel = resolveContextRelativePath(part.toolPath, searchRoot)
    if (rel) acc.pushFocus(rel)
  }
}

// ── Structured-output parsers (bounded, jcode-aligned) ───────────────────────

/**
 * Outline structure items → symbols. Mirrors jcode parse_structure_item_line +
 * collect_outline_symbols.
 */
function collectOutlineSymbols(
  output: string | undefined,
  relPath: string,
  searchRoot: string,
  acc: Accumulator,
  meta: ExposureMeta,
  cache: FreshnessCache,
): void {
  for (const line of boundedLines(output)) {
    if (line === "") continue
    const m = STRUCTURE_ITEM_RE.exec(line)
    if (!m) continue
    const label = trunc(m[2].trim())
    if (label === "") continue
    acc.pushSymbol(
      tuneSymbol(
        {
          path: relPath,
          symbol: label,
          kind: m[1],
          structure_confidence: 0.92,
          body_confidence: 0.1,
          current_version_confidence: 0.82,
          prune_confidence: 0.8,
          source_strength: "outline_only",
          reasons: ["agentgrep_outline_structure"],
        },
        meta,
        cache,
        searchRoot,
      ),
    )
  }
}

/**
 * Trace/smart output: ranked file headers, "structure:" items, "regions:"
 * headers + region finalization. Mirrors jcode collect_trace_exposure.
 */
function collectTraceExposure(
  output: string | undefined,
  pathHint: string | undefined,
  searchRoot: string,
  acc: Accumulator,
  meta: ExposureMeta,
  cache: FreshnessCache,
): void {
  if (pathHint) {
    const rel = resolveContextRelativePath(pathHint, searchRoot)
    if (rel) acc.pushFocus(rel)
  }

  let currentFile: string | undefined
  let section: "structure" | "regions" | undefined
  let pendingRegion: { path: string; start: number; end: number; label: string } | undefined

  for (const line of boundedLines(output)) {
    if (line === "") continue

    const ranked = RANKED_FILE_RE.exec(line)
    if (ranked) {
      const rel = resolveContextRelativePath(ranked[1].trim(), searchRoot)
      if (rel) {
        currentFile = rel
        acc.pushFocus(rel)
        acc.pushFile(
          tuneFile(
            {
              path: rel,
              structure_confidence: 0.72,
              body_confidence: 0.2,
              current_version_confidence: 0.78,
              prune_confidence: 0.62,
              source_strength: "trace_summary",
              reasons: ["agentgrep_trace_file"],
            },
            meta,
            cache,
            searchRoot,
          ),
        )
      }
      section = undefined
      pendingRegion = undefined
      continue
    }

    if (line.startsWith("best answer likely in ")) {
      const rel = resolveContextRelativePath(line.slice("best answer likely in ".length).trim(), searchRoot)
      if (rel) acc.pushFocus(rel)
      continue
    }

    if (line === "structure:") {
      section = "structure"
      pendingRegion = undefined
      continue
    }
    if (line === "regions:") {
      section = "regions"
      pendingRegion = undefined
      continue
    }

    const filePath = currentFile
    if (!filePath) continue

    if (section === "structure") {
      const m = STRUCTURE_ITEM_RE.exec(line)
      if (m) {
        acc.pushSymbol(
          tuneSymbol(
            {
              path: filePath,
              symbol: trunc(m[2].trim()),
              kind: m[1],
              structure_confidence: 0.82,
              body_confidence: 0.12,
              current_version_confidence: 0.78,
              prune_confidence: 0.66,
              source_strength: "trace_structure",
              reasons: ["agentgrep_trace_structure"],
            },
            meta,
            cache,
            searchRoot,
          ),
        )
      }
      continue
    }

    if (section === "regions") {
      const header = REGION_HEADER_RE.exec(line)
      if (header) {
        pendingRegion = {
          path: filePath,
          start: Number(header[2]),
          end: Number(header[3]),
          label: trunc(header[1].trim()),
        }
        acc.pushSymbol(
          tuneSymbol(
            {
              path: filePath,
              symbol: pendingRegion.label,
              structure_confidence: 0.86,
              body_confidence: 0.28,
              current_version_confidence: 0.8,
              prune_confidence: 0.68,
              source_strength: "trace_region",
              reasons: ["agentgrep_trace_region_header"],
            },
            meta,
            cache,
            searchRoot,
          ),
        )
        continue
      }
      // `kind: x` refines the pending region's classification. KnownRegion has
      // no serialized kind field, so we only skip the line (jcode reads it but
      // never serializes it into the harness JSON).
      if (line.startsWith("kind: ")) {
        continue
      }
      if ((line === "full region:" || line === "snippet:") && pendingRegion) {
        const r = pendingRegion
        const full = line === "full region:"
        acc.pushRegion(
          tuneRegion(
            {
              path: r.path,
              start_line: boundedStart(r.start),
              end_line: boundedEnd(r.start, r.end),
              body_confidence: full ? 0.9 : 0.48,
              current_version_confidence: 0.72,
              prune_confidence: full ? 0.82 : 0.52,
              source_strength: full ? "full_region" : "snippet",
              reasons: ["agentgrep_trace_region_body"],
            },
            meta,
            cache,
            searchRoot,
          ),
        )
        pendingRegion = undefined
      }
    }
  }
}

/** grep-mode output: `path:line:` match hits (known structured format). */
function collectGrepExposure(
  output: string | undefined,
  pathHint: string | undefined,
  searchRoot: string,
  acc: Accumulator,
  meta: ExposureMeta,
  cache: FreshnessCache,
): void {
  if (pathHint) {
    const rel = resolveContextRelativePath(pathHint, searchRoot)
    if (rel) acc.pushFocus(rel)
  }
  for (const line of boundedLines(output)) {
    const m = PATH_LINE_RE.exec(line)
    if (!m) continue
    const rel = resolveContextRelativePath(m[1].trim(), searchRoot)
    if (!rel) continue
    const lineNo = Number(m[2])
    acc.pushFocus(rel)
    acc.pushFile(
      tuneFile(
        {
          path: rel,
          structure_confidence: 0.28,
          body_confidence: 0.22,
          current_version_confidence: 0.68,
          prune_confidence: 0.18,
          source_strength: "match_line_only",
          reasons: ["agentgrep_grep_hit"],
        },
        meta,
        cache,
        searchRoot,
      ),
    )
    acc.pushRegion(
      tuneRegion(
        {
          path: rel,
          start_line: lineNo,
          end_line: lineNo,
          body_confidence: 0.26,
          current_version_confidence: 0.68,
          prune_confidence: 0.2,
          source_strength: "match_line_only",
          reasons: ["agentgrep_grep_hit"],
        },
        meta,
        cache,
        searchRoot,
      ),
    )
  }
}

/** find-mode output: ranked file headers (known structured format). */
function collectFindExposure(
  output: string | undefined,
  pathHint: string | undefined,
  searchRoot: string,
  acc: Accumulator,
  meta: ExposureMeta,
  cache: FreshnessCache,
): void {
  if (pathHint) {
    const rel = resolveContextRelativePath(pathHint, searchRoot)
    if (rel) acc.pushFocus(rel)
  }
  for (const line of boundedLines(output)) {
    const m = RANKED_FILE_RE.exec(line)
    if (!m) continue
    const rel = resolveContextRelativePath(m[1].trim(), searchRoot)
    if (!rel) continue
    acc.pushFocus(rel)
    acc.pushFile(
      tuneFile(
        {
          path: rel,
          structure_confidence: 0.5,
          body_confidence: 0.2,
          current_version_confidence: 0.72,
          prune_confidence: 0.4,
          source_strength: "trace_summary",
          reasons: ["agentgrep_find_result"],
        },
        meta,
        cache,
        searchRoot,
      ),
    )
  }
}

// ── Main builder ─────────────────────────────────────────────────────────────

/**
 * Build the harness context from bounded normalized messages. Returns null when
 * nothing usable survived or the search root is unusable (fail-closed).
 */
export function buildHarnessContext(opts: BuildOpts): HarnessContext | null {
  const { messages, searchRoot } = opts
  if (!searchRoot || typeof searchRoot !== "string") return null
  let rootCanonical: string
  try {
    rootCanonical = canonicalizePath(path.resolve(searchRoot))
  } catch {
    return null
  }
  try {
    if (!fs.statSync(rootCanonical).isDirectory()) return null
  } catch {
    return null
  }

  const acc = new Accumulator()
  const cache = new FreshnessCache()
  const total = messages.length

  // Compaction boundary: index after the LAST compaction marker.
  let compactionCutoff = -1
  for (let i = 0; i < total; i++) {
    if (messages[i].parts.some((p) => p.compaction === true)) compactionCutoff = i + 1
  }

  for (let i = 0; i < total; i++) {
    const msg = messages[i]
    const meta: ExposureMeta = {
      totalMessages: total,
      index: i,
      compactionCutoff,
      fromActiveContext: msg.fromActiveContext === true,
      exposureTime: msg.timestamp,
    }
    for (const part of msg.parts) {
      try {
        collectPartExposures(part, rootCanonical, acc, meta, cache)
      } catch {
        // A single malformed part never poisons the whole context.
      }
    }
  }

  if (acc.isEmpty) return null
  return acc.toContext()
}

/**
 * Serialize a harness context to JSON, omitting empty arrays (jcode
 * `skip_serializing_if`) and returning null when it exceeds the UTF-8 byte cap
 * or when nothing is present to serialize. Fail-closed: an over-budget or
 * exposure-free context is NO context. The byte cap is measured with the
 * bounded serializer (no unbounded allocation) before `JSON.stringify`.
 */
export function serializeHarnessContext(ctx: HarnessContext | null): string | null {
  if (!ctx) return null
  if (
    ctx.known_files.length === 0 &&
    ctx.known_regions.length === 0 &&
    ctx.known_symbols.length === 0 &&
    ctx.focus_files.length === 0
  ) {
    return null
  }
  const obj: Record<string, unknown> = { version: 1 }
  if (ctx.known_files.length > 0) obj.known_files = ctx.known_files
  if (ctx.known_regions.length > 0) obj.known_regions = ctx.known_regions
  if (ctx.known_symbols.length > 0) obj.known_symbols = serializeSymbols(ctx.known_symbols)
  if (ctx.focus_files.length > 0) obj.focus_files = ctx.focus_files
  const bounded = boundedUtf8Bytes(obj, CONTEXT_CAP_JSON_BYTES)
  if (bounded.oversized) return null
  let json: string
  try {
    json = JSON.stringify(obj)
  } catch {
    return null
  }
  if (utf8ByteLength(json) > CONTEXT_CAP_JSON_BYTES) return null
  return json
}

function serializeSymbols(symbols: HarnessKnownSymbol[]): unknown[] {
  return symbols.map((s) => {
    const o: Record<string, unknown> = { path: s.path, symbol: s.symbol }
    if (s.kind !== undefined) o.kind = s.kind
    o.structure_confidence = s.structure_confidence
    o.body_confidence = s.body_confidence
    o.current_version_confidence = s.current_version_confidence
    o.prune_confidence = s.prune_confidence
    o.source_strength = s.source_strength
    o.reasons = s.reasons
    return o
  })
}