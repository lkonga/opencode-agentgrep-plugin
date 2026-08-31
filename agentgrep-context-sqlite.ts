// agentgrep-context-sqlite — guarded SQLite fallback for the harness context
// adapter. Used ONLY when the SDK context/messages paths cannot provide usable
// current-session message/part data.
//
// Safety contract (mirrors the remediation requirements):
//   - bun:sqlite opened read-only (`readonly: true`) plus `PRAGMA query_only`.
//   - Discovers ONLY exact known OpenCode DB locations, in order:
//       1. $OPENCODE_DATA_HOME/opencode.db
//       2. $XDG_DATA_HOME/opencode/opencode.db
//       3. ~/.local/share/opencode/opencode.db
//     No recursive search. Each candidate is realpath'd and must be a regular
//     file under its corresponding data root.
//   - The session id must match a conservative whitelist.
//   - Queries touch ONLY the fixed session/message/part tables, ONLY for the
//     current session, ONLY with parameterized `WHERE session_id = ?`.
//   - The session row's canonical `directory` must match ctx.directory or
//     ctx.worktree (canonical comparison) before any message/part read.
//   - Row counts and accumulated `data` bytes are bounded.
//   - Every error is caught; the DB is always closed.
//
// Output: an array of v1-shaped `{ info, parts }` records reconstructed from
// the message/part rows, ready for the pure schema normalizer. The v1 `data`
// JSON columns hold the message/part minus id/sessionID/messageID, so records
// are rebuilt exactly as the SDK would return them.
//
// ⚠️ NOT a plugin entrypoint. Only index.ts is loaded by OpenCode.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import {
  CONTEXT_CAP_SQL_BYTES,
  CONTEXT_CAP_SQL_ROWS,
  CONTEXT_SESSION_ID_RE,
} from "./agentgrep-context-caps"
import { utf8ByteLength } from "./agentgrep-context-bytes"
import { isWithinPath } from "./agentgrep-paths"

export interface SqliteCandidate {
  dbPath: string
  /** The data root that must canonically contain the DB (its parent dir). */
  dataRoot: string
  source: "OPENCODE_DATA_HOME" | "XDG_DATA_HOME" | "HOME"
}

/**
 * Pure candidate list (exact known locations, in precedence order).
 * `homeOverride` is a test seam (defaults to os.homedir()).
 */
export function openCodeDbCandidates(homeOverride?: string): SqliteCandidate[] {
  const candidates: SqliteCandidate[] = []
  const dataHome = process.env.OPENCODE_DATA_HOME
  if (dataHome && dataHome.trim() !== "") {
    const root = dataHome.trim()
    candidates.push({ dbPath: path.join(root, "opencode.db"), dataRoot: root, source: "OPENCODE_DATA_HOME" })
  }
  const xdg = process.env.XDG_DATA_HOME
  if (xdg && xdg.trim() !== "") {
    const root = path.join(xdg.trim(), "opencode")
    candidates.push({ dbPath: path.join(root, "opencode.db"), dataRoot: root, source: "XDG_DATA_HOME" })
  }
  const home = homeOverride ?? os.homedir()
  const root = path.join(home, ".local", "share", "opencode")
  candidates.push({ dbPath: path.join(root, "opencode.db"), dataRoot: root, source: "HOME" })
  return candidates
}

/**
 * Validate a candidate and return its CANONICAL db path (realpath), or null
 * when unusable. The data root must be a real directory and the DB must be a
 * real regular file whose canonical path sits under the canonical data root —
 * this rejects an inside-root symlink that points outside (realpath resolves
 * the link target, which then fails containment).
 */
export function validateSqliteCandidate(candidate: SqliteCandidate): string | null {
  try {
    const rootReal = fs.realpathSync(candidate.dataRoot)
    const rootStat = fs.statSync(rootReal)
    if (!rootStat.isDirectory()) return null
    const dbReal = fs.realpathSync(candidate.dbPath)
    const dbStat = fs.statSync(dbReal)
    if (!dbStat.isFile()) return null
    if (!isWithinPath(rootReal, dbReal)) return null
    return dbReal
  } catch {
    return null
  }
}

/** Conservative session-id whitelist. */
export function isValidSessionID(sessionID: string | undefined | null): sessionID is string {
  return typeof sessionID === "string" && CONTEXT_SESSION_ID_RE.test(sessionID)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function parseDataJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw === "") return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Verify the session's canonical directory matches ctx.directory or
 * ctx.worktree. Returns true only on an exact canonical match.
 */
export function sessionDirectoryMatches(
  sessionDir: string | null | undefined,
  ctxDirectories: Array<string | undefined>,
): boolean {
  if (!sessionDir) return false
  let canonical: string
  try {
    canonical = fs.realpathSync(sessionDir)
  } catch {
    return false
  }
  for (const dir of ctxDirectories) {
    if (!dir) continue
    try {
      if (fs.realpathSync(dir) === canonical) return true
    } catch {
      // unreadable ctx dir — keep checking others
    }
  }
  return false
}

export interface SqliteReadResult {
  /** v1-shaped `{ info, parts }` records, oldest first. */
  messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
  /** True when row/byte bounds cut the read short. */
  truncated: boolean
}

/**
 * Read bounded current-session messages+parts from the DB. The path must be
 * the CANONICAL (realpath) path returned by `validateSqliteCandidate`; it is
 * re-realpath'd and re-verified as a regular file IMMEDIATELY before open
 * (synchronous, no interleaving), so a TOCTOU symlink swap cannot redirect the
 * open. Opened read-only + `PRAGMA query_only`. Never throws.
 */
export function readSessionMessagesFromSqlite(
  dbPath: string,
  sessionID: string,
  ctxDirectories: Array<string | undefined>,
): SqliteReadResult {
  const empty: SqliteReadResult = { messages: [], truncated: false }
  let db: Database | null = null
  try {
    // Revalidate immediately before open: realpath + regular file. All
    // synchronous — no window for the canonical path to be swapped.
    let canonical: string
    try {
      canonical = fs.realpathSync(dbPath)
    } catch {
      return empty
    }
    try {
      if (!fs.statSync(canonical).isFile()) return empty
    } catch {
      return empty
    }
    db = new Database(canonical, { readonly: true })
    db.exec("PRAGMA query_only = ON")

    // 1. Session row: verify the directory before touching messages.
    const sessionRow = db
      .query<{ directory: string | null }, [string]>("SELECT directory FROM session WHERE id = ?")
      .get(sessionID)
    if (!sessionRow) return empty
    if (!sessionDirectoryMatches(sessionRow.directory, ctxDirectories)) return empty

    // 2. Bounded messages.
    const messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = []
    let bytes = 0
    let truncated = false

    const msgRows = db
      .query<
        { id: string; session_id: string; time_created: number | null; data: string },
        [string, number]
      >(
        "SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC LIMIT ?",
      )
      .all(sessionID, CONTEXT_CAP_SQL_ROWS + 1)
    if (msgRows.length > CONTEXT_CAP_SQL_ROWS) {
      truncated = true
      msgRows.length = CONTEXT_CAP_SQL_ROWS
    }
    const partsByMessage = new Map<string, Array<Record<string, unknown>>>()

    const partRows = db
      .query<
        { id: string; message_id: string; session_id: string; time_created: number | null; data: string },
        [string, number]
      >(
        "SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC LIMIT ?",
      )
      .all(sessionID, CONTEXT_CAP_SQL_ROWS + 1)
    if (partRows.length > CONTEXT_CAP_SQL_ROWS) {
      truncated = true
      partRows.length = CONTEXT_CAP_SQL_ROWS
    }

    for (const row of msgRows) {
      bytes += utf8ByteLength(row.data)
      if (bytes > CONTEXT_CAP_SQL_BYTES) {
        truncated = true
        break
      }
      const data = parseDataJson(row.data)
      if (!data) continue
      const info: Record<string, unknown> = { id: row.id, sessionID: row.session_id, ...data }
      if (row.time_created !== null) {
        info.time = { ...(isRecord(info.time) ? info.time : {}), created: row.time_created }
      }
      messages.push({ info, parts: [] })
      partsByMessage.set(row.id, messages[messages.length - 1].parts)
    }

    if (!truncated) {
      for (const row of partRows) {
        const bucket = partsByMessage.get(row.message_id)
        if (!bucket) continue
        bytes += utf8ByteLength(row.data)
        if (bytes > CONTEXT_CAP_SQL_BYTES) {
          truncated = true
          break
        }
        const data = parseDataJson(row.data)
        if (!data) continue
        bucket.push({ id: row.id, sessionID: row.session_id, messageID: row.message_id, ...data })
      }
    }

    return { messages, truncated }
  } catch {
    return empty
  } finally {
    try {
      db?.close()
    } catch {
      // close is best-effort
    }
  }
}

/**
 * Full guarded fallback: discover → validate (canonical path) → revalidate →
 * session check → bounded read. Returns the bounded raw messages (or null when
 * unusable). Never throws.
 */
export function sqliteFallbackMessages(
  sessionID: string,
  ctxDirectories: Array<string | undefined>,
  homeOverride?: string,
): SqliteReadResult | null {
  if (!isValidSessionID(sessionID)) return null
  for (const candidate of openCodeDbCandidates(homeOverride)) {
    // Validation returns the canonical realpath'd db path (containment + file).
    const canonical = validateSqliteCandidate(candidate)
    if (!canonical) continue
    const result = readSessionMessagesFromSqlite(canonical, sessionID, ctxDirectories)
    if (result.messages.length > 0 || result.truncated) return result
  }
  return null
}