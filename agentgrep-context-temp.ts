// agentgrep-context-temp — secure tempfile lifecycle for the harness context
// JSON. Only trace/smart/outline executions ever get a context file.
//
// Security contract:
//   - The temp dir is created with `mkdtemp` under `os.tmpdir()` with mode
//     0700 (mkdtemp on POSIX already does; we chmod to be explicit).
//   - The context file is opened `wx` (exclusive — never overwrites) with mode
//     0600 and written once.
//   - The JSON is serialized and byte-capped BEFORE any file is created; an
//     over-budget or unserializable payload degrades to "no context file".
//   - The internal temp path is passed ONLY as `--context-json` argv; it is
//     never surfaced in ToolResult, metadata, permission asks, or logs.
//   - `withContextTempFile` removes the whole temp dir in a `finally`, so
//     success, error, nonzero exit, timeout, and abort all clean up.
//
// ⚠️ NOT a plugin entrypoint. Only index.ts is loaded by OpenCode.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { CONTEXT_CAP_JSON_BYTES } from "./agentgrep-context-caps"
import { utf8ByteLength } from "./agentgrep-context-bytes"

const TEMP_PREFIX = "agentgrep-context-"

export interface ContextTempFile {
  /** Absolute internal path to the context JSON file. */
  path: string
  /** Remove the whole temp dir (idempotent, never throws). */
  cleanup(): void
}

/**
 * Create a temp dir (0700) + context file (wx, 0600) for a serialized context
 * JSON. Returns null when the JSON is empty or exceeds the byte cap (callers
 * treat that as "no context", exactly like an empty harness). Never throws.
 */
export function writeContextTempFile(json: string | null | undefined): ContextTempFile | null {
  // Byte cap is UTF-8 bytes, not String.length code units.
  if (!json || json.length === 0 || utf8ByteLength(json) > CONTEXT_CAP_JSON_BYTES) return null
  let dir: string
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX))
    fs.chmodSync(dir, 0o700)
  } catch {
    return null
  }
  const filePath = path.join(dir, "context.json")
  let fd: number | undefined
  try {
    // wx: exclusive create — never touches an existing file. 0600 owner-only.
    fd = fs.openSync(filePath, "wx", 0o600)
    fs.writeFileSync(fd, json, { encoding: "utf8" })
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
  } catch {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // already closed
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
    return null
  }
  return {
    path: filePath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
  }
}

/**
 * Run `fn` with a live context temp file, guaranteeing cleanup afterwards on
 * success, thrown error, nonzero exit, timeout, or abort. Returns null when the
 * context JSON was unusable (then `fn` is not called at all).
 */
export async function withContextTempFile<T>(
  json: string | null | undefined,
  fn: (contextJsonPath: string) => Promise<T>,
): Promise<T | null> {
  const tmp = writeContextTempFile(json)
  if (!tmp) return null
  try {
    return await fn(tmp.path)
  } finally {
    tmp.cleanup()
  }
}