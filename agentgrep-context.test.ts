// agentgrep-context — focused harness-context test suite: shape normalization,
// SDK shims + bounded pagination, harness JSON building (containment, symbols,
// freshness, compaction, dedupe, caps), guarded SQLite fallback, secure
// tempfile lifecycle, provider precedence, and the tools.ts integration locks
// (--context-json argv, hidden-smart, exact-file containment with context,
// cleanup on every outcome, no temp leakage).

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import {
  // caps
  CONTEXT_CAP_JSON_BYTES,
  CONTEXT_CAP_MESSAGES,
  CONTEXT_CAP_PAGES,
  CONTEXT_CAP_PARTS,
  CONTEXT_CAP_SOURCE_BYTES,
  CONTEXT_CAP_KNOWN_FILES,
  CONTEXT_CAP_KNOWN_REGIONS,
  CONTEXT_CAP_KNOWN_SYMBOLS,
  CONTEXT_CAP_FOCUS_FILES,
  CONTEXT_CAP_LINE_RANGE,
  CONTEXT_CAP_STRING_LEN,
  CONTEXT_CAP_SQL_ROWS,
  // bytes
  boundedUtf8Bytes,
  utf8ByteLength,
  // schema
  normalizeContextMessages,
  unwrapResult,
  type NormalizedContextMessage,
  // build
  buildHarnessContext,
  serializeHarnessContext,
  resolveContextRelativePath,
  tuneFreshness,
  FreshnessCache,
  type HarnessContext,
  // sdk
  fetchSessionMessages,
  fetchSessionContext,
  hasSessionContext,
  v1MessagesOf,
  createV2ClientFromServerUrl,
  _setV2ClientModule,
  // sqlite
  openCodeDbCandidates,
  validateSqliteCandidate,
  isValidSessionID,
  sqliteFallbackMessages,
  // temp
  writeContextTempFile,
  withContextTempFile,
  // sanitize
  sanitizeContextOutput,
  hasContextJsonSignature,
  CONTEXT_REDACTED_OUTPUT,
  CONTEXT_TEMP_PLACEHOLDER,
  // provider + tools
  createAgentGrepContextProvider,
  buildAgentGrepTools,
  buildAgentGrepArgs,
  exactFileScope,
  type AgentGrepContextProvider,
} from "./agentgrep-core"

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ag-ctx-root-")))
const OTHER = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ag-ctx-other-")))
const files = {
  a: path.join(ROOT, "src", "a.ts"),
  b: path.join(ROOT, "src", "b.ts"),
  out: path.join(OTHER, "secret.ts"),
}
let baselineTempDirs = 0

beforeAll(() => {
  fs.mkdirSync(path.join(ROOT, "src"), { recursive: true })
  fs.writeFileSync(files.a, "export function alpha() {}\n// a\n")
  fs.writeFileSync(files.b, "export function beta() {}\n// b\n")
  fs.mkdirSync(OTHER, { recursive: true })
  fs.writeFileSync(files.out, "export function secret() {}\n")
  baselineTempDirs = countContextTempDirs()
})

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.rmSync(OTHER, { recursive: true, force: true })
})

function countContextTempDirs(): number {
  let n = 0
  try {
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (entry.startsWith("agentgrep-context-")) n++
    }
  } catch {
    // ignore
  }
  return n
}

function ctxFor(directory: string): ToolContext {
  return {
    sessionID: "ses_test_1",
    messageID: "m1",
    agent: "test",
    directory,
    worktree: "/",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

function rel(p: string): string {
  return path.relative(ROOT, p).split(path.sep).join("/")
}

// v1 helpers
function v1Msg(sessionID: string, parts: unknown[], ts = 1_000_000): { info: Record<string, unknown>; parts: unknown[] } {
  return {
    info: { id: `m_${sessionID}_${ts}`, sessionID, role: "assistant", time: { created: ts }, model: { providerID: "p", modelID: "m" } },
    parts,
  }
}
function v1ReadPart(filePath: string, startLine: number, endLine: number): Record<string, unknown> {
  // sessionID intentionally omitted: parts without an explicit sessionID are
  // accepted (the message already keys them to the session).
  return {
    id: "p_read",
    messageID: "m",
    type: "tool",
    callID: "c",
    tool: "read",
    state: { status: "completed", input: { file_path: filePath, start_line: startLine, end_line: endLine }, output: "ignored", title: "t", metadata: {}, time: { start: 0, end: 1 } },
  }
}
function v1OutlinePart(filePath: string, output: string): Record<string, unknown> {
  return {
    id: "p_out",
    messageID: "m",
    type: "tool",
    callID: "c",
    tool: "agentgrep",
    state: { status: "completed", input: { mode: "outline", file: filePath }, output, title: "t", metadata: {}, time: { start: 0, end: 1 } },
  }
}

// v2 helpers
function v2Assistant(parts: unknown[], snapshotFiles?: string[], ts = 2_000_000): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    id: "va1",
    type: "assistant",
    agent: "primary",
    model: { id: "m", providerID: "p" },
    time: { created: ts },
    content: parts,
  }
  if (snapshotFiles) msg.snapshot = { files: snapshotFiles }
  return msg
}
function v2ReadTool(filePath: string): Record<string, unknown> {
  return {
    type: "tool",
    id: "t1",
    name: "read",
    state: { status: "completed", input: { file_path: filePath }, content: [], structured: {} },
    time: { created: 2_000_000 },
  }
}
function v2TraceTool(pathHint: string | undefined, output: string, outputPaths?: string[]): Record<string, unknown> {
  return {
    type: "tool",
    id: "t2",
    name: "agentgrep",
    state: {
      status: "completed",
      input: { mode: "trace", ...(pathHint ? { path: pathHint } : {}) },
      content: [{ type: "text", text: output }],
      ...(outputPaths ? { outputPaths } : {}),
      structured: {},
    },
    time: { created: 2_000_000 },
  }
}

function asHarness(ctx: HarnessContext): HarnessContext {
  return ctx
}

/**
 * Runtime-narrow a `ToolResult` (string | object) to the object form. The
 * plugin always returns the object form, but TypeScript keeps the `string`
 * branch alive in intersections, so a plain `as ToolResult & {...}` cast
 * leaves `.output`/`.metadata` possibly-missing. This guard throws (fail the
 * test) if the result is not an object with metadata.
 */
function objectResult(res: ToolResult): { output: string; metadata: Record<string, unknown> } {
  if (typeof res !== "string") {
    const obj = res
    if (typeof obj.metadata === "object" && obj.metadata !== null) {
      return { output: obj.output, metadata: obj.metadata }
    }
  }
  throw new Error("expected an object ToolResult with metadata")
}

// ── Caps ─────────────────────────────────────────────────────────────────────

describe("context caps are exported and sane", () => {
  test("all hard caps are positive and bounded", () => {
    for (const cap of [
      CONTEXT_CAP_JSON_BYTES,
      CONTEXT_CAP_MESSAGES,
      CONTEXT_CAP_PAGES,
      CONTEXT_CAP_KNOWN_FILES,
      CONTEXT_CAP_KNOWN_REGIONS,
      CONTEXT_CAP_KNOWN_SYMBOLS,
      CONTEXT_CAP_FOCUS_FILES,
      CONTEXT_CAP_LINE_RANGE,
      CONTEXT_CAP_STRING_LEN,
      CONTEXT_CAP_SQL_ROWS,
    ]) {
      expect(typeof cap).toBe("number")
      expect(cap).toBeGreaterThan(0)
    }
    expect(CONTEXT_CAP_JSON_BYTES).toBeLessThanOrEqual(512_000)
  })
})

// ── Shape normalization (pure) ───────────────────────────────────────────────

describe("normalizeContextMessages (pure shapes)", () => {
  test("v1 { info, parts } with a local file attachment normalizes attachmentPaths", () => {
    const out = normalizeContextMessages([v1Msg("s1", [{ id: "f", sessionID: "s1", messageID: "m", type: "file", mime: "text", url: "file:///tmp/a.ts" }])], {
      sessionID: "s1",
    })
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0].parts[0].attachmentPaths).toEqual(["file:///tmp/a.ts"])
  })

  test("v2 projected assistant message with snapshot.files normalizes", () => {
    const out = normalizeContextMessages([v2Assistant([], [rel(files.a)])], { sessionID: "s1" })
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0].parts[0].snapshotFiles).toEqual([rel(files.a)])
  })

  test("{ data: [...] } envelope is flattened", () => {
    const out = normalizeContextMessages({ data: [v2Assistant([v2ReadTool(files.a)])] }, { sessionID: "s1" })
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0].parts[0].filePath).toBe(files.a)
  })

  test("records that EXPLICITLY belong to another session are skipped", () => {
    const out = normalizeContextMessages(
      [v1Msg("s1", []), v1Msg("other-session", []), v1Msg("s1", [])],
      { sessionID: "s1" },
    )
    expect(out.messages).toHaveLength(2)
    expect(out.skipped).toBe(1)
  })

  test("records without a sessionID are accepted (keyed by the endpoint already)", () => {
    const out = normalizeContextMessages([{ id: "x", type: "user", time: { created: 1 }, text: "hi" }], {
      sessionID: "s1",
    })
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0].sessionID).toBeUndefined()
  })

  test("malformed / missing / unreadable input never throws", () => {
    for (const bad of [null, undefined, "junk", 42, {}, { data: "nope" }, [{}, "x", null]]) {
      expect(() => normalizeContextMessages(bad, { sessionID: "s1" })).not.toThrow()
      const out = normalizeContextMessages(bad as never, { sessionID: "s1" })
      expect(Array.isArray(out.messages)).toBe(true)
    }
  })

  test("bounded by CONTEXT_CAP_MESSAGES", () => {
    const many = Array.from({ length: CONTEXT_CAP_MESSAGES + 50 }, (_, i) => v1Msg("s1", [], i))
    const out = normalizeContextMessages(many, { sessionID: "s1" })
    expect(out.messages.length).toBeLessThanOrEqual(CONTEXT_CAP_MESSAGES)
  })

  test("v2 tool part with completed read input derives explicit file_path", () => {
    const out = normalizeContextMessages([v2Assistant([v2ReadTool(files.a)])], { sessionID: "s1" })
    expect(out.messages[0].parts[0].filePath).toBe(files.a)
    expect(out.messages[0].parts[0].tool).toBe("read")
  })

  test("fromActiveContext flag is threaded", () => {
    const out = normalizeContextMessages([v2Assistant([])], { sessionID: "s1", fromActiveContext: true })
    expect(out.messages[0].fromActiveContext).toBe(true)
  })
})

// ── unwrapResult ─────────────────────────────────────────────────────────────

describe("unwrapResult", () => {
  test("hey-api fields envelope unwraps data", () => {
    expect(unwrapResult({ data: [1], error: undefined, response: {} })).toEqual([1])
  })
  test("bare { data: [...] } payload stays intact", () => {
    expect(unwrapResult({ data: [1, 2] })).toEqual({ data: [1, 2] })
  })
  test("plain array passes through", () => {
    expect(unwrapResult([1, 2])).toEqual([1, 2])
  })
})

// ── Early / global caps + session filtering + UTF-8 bytes ────────────────────

describe("early/global caps in normalizeContextMessages", () => {
  test("global part cap across ALL messages stops ingestion (no per-message bypass)", () => {
    // One message alone would exceed the global parts budget.
    const hugeMsg = v1Msg("s1", Array.from({ length: CONTEXT_CAP_PARTS + 500 }, (_, i) => ({
      id: `p${i}`,
      sessionID: "s1",
      messageID: "m",
      type: "file",
      mime: "text",
      url: "file://" + files.a,
    })))
    const out = normalizeContextMessages([hugeMsg], { sessionID: "s1" })
    const totalParts = out.messages.reduce((n, m) => n + m.parts.length, 0)
    expect(totalParts).toBeLessThanOrEqual(CONTEXT_CAP_PARTS)
    expect(out.truncated).toBe(true)
  })

  test("oversized single record is rejected BEFORE deep serialization (byte cap)", () => {
    // A record whose serialized UTF-8 size exceeds the remaining source budget
    // must be rejected (oversized) — never fully serialized for counting.
    const blob = "x".repeat(CONTEXT_CAP_SOURCE_BYTES + 1024)
    const out = normalizeContextMessages([{ info: { id: "m", sessionID: "s1" }, parts: [{ type: "text", text: blob }] }], { sessionID: "s1" })
    expect(out.messages).toHaveLength(0)
    expect(out.truncated).toBe(true)
  })

  test("deeply nested records are rejected by the bounded byte guard", () => {
    let deep: unknown = "leaf"
    for (let i = 0; i < 300; i++) deep = { next: deep }
    const { oversized } = boundedUtf8Bytes(deep, CONTEXT_CAP_SOURCE_BYTES)
    expect(oversized).toBe(true)
    // Cyclic records must not hang the walk.
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(boundedUtf8Bytes(cyclic, CONTEXT_CAP_SOURCE_BYTES).oversized).toBe(true)
  })

  test("oversized v2 content records are rejected early (fail-closed zero messages)", () => {
    // A malicious 100k-content record exceeds the bounded structural guard
    // (container-entry cap) BEFORE normalization, so it is rejected whole:
    // zero messages, truncated=true, no throw. We do NOT weaken the source
    // guard to keep a partial message.
    const content = Array.from({ length: 100_000 }, (_, i) => ({ type: "text", text: `x${i}` }))
    const out = normalizeContextMessages([v2Assistant(content)], { sessionID: "s1" })
    expect(out.messages).toHaveLength(0)
    expect(out.truncated).toBe(true)
  })
})

describe("current-session filtering is COMPLETE (parts + nested records)", () => {
  test("v1 parts explicitly declaring another session cannot contribute paths", () => {
    const out = normalizeContextMessages(
      [
        v1Msg("s1", [
          { id: "f", sessionID: "other-session", messageID: "m", type: "file", mime: "text", url: "file://" + files.a },
        ]),
      ],
      { sessionID: "s1" },
    )
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0].parts).toHaveLength(0)
    expect(out.skipped).toBe(1)
  })

  test("v2 tool content + snapshot records from another session cannot contribute", () => {
    const out = normalizeContextMessages(
      [
        v2Assistant(
          [{ type: "tool", id: "t", name: "read", sessionID: "other", state: { status: "completed", input: { file_path: files.a }, content: [], structured: {} }, time: { created: 1 } }],
          ["src/b.ts"],
          1,
        ),
      ],
      { sessionID: "s1" },
    )
    // The tool part is dropped (other session); the snapshot has no sessionID
    // and remains (it is keyed by the endpoint already).
    expect(out.messages[0].parts.some((p) => p.kind === "tool")).toBe(false)
    expect(out.messages[0].parts.some((p) => p.kind === "snapshot")).toBe(true)
  })

  test("v2 user file attachments from another session are skipped", () => {
    const out = normalizeContextMessages(
      [
        {
          id: "u",
          type: "user",
          time: { created: 1 },
          text: "hi",
          files: [{ uri: "file://" + files.a, mime: "text/plain", sessionID: "other" }],
        },
      ],
      { sessionID: "s1" },
    )
    expect(out.messages[0].parts).toHaveLength(0)
    expect(out.skipped).toBe(1)
  })

  test("mixed payload: cross-session parts never reach the builder", () => {
    const mixed = normalizeContextMessages(
      [
        v1Msg("s1", [
          v1ReadPart(files.a, 1, 2),
          { id: "evil", sessionID: "other-session", messageID: "m", type: "file", mime: "text", url: "file://" + files.out },
        ]),
        v1Msg("other-session", [v1ReadPart(files.b, 1, 2)]),
      ],
      { sessionID: "s1" },
    )
    // only message 1 survives, only its own-session part survives
    expect(mixed.messages).toHaveLength(1)
    expect(mixed.messages[0].parts).toHaveLength(1)
    expect(mixed.messages[0].parts[0].filePath).toBe(files.a)
    // outside path must never enter the harness
    const ctx = buildHarnessContext({ searchRoot: ROOT, messages: mixed.messages })!
    expect(JSON.stringify(ctx)).not.toContain("secret.ts")
    expect(JSON.stringify(ctx)).not.toContain("src/b.ts")
  })
})

describe("UTF-8 byte caps (not String.length)", () => {
  test("boundedUtf8Bytes measures multibyte correctly", () => {
    // é is 2 UTF-8 bytes, 1 code unit.
    expect(utf8ByteLength("é")).toBe(2)
    const emoji = "😀" // 4 UTF-8 bytes, 2 code units
    expect(utf8ByteLength(emoji)).toBe(4)
    expect(boundedUtf8Bytes({ text: "é".repeat(10) }, 100).bytes).toBe(2 * 10 + 10 /* {"text":""} */ + 1)
  })

  test("byte cap triggers on multibyte content at the boundary", () => {
    const cap = CONTEXT_CAP_JSON_BYTES
    // Half the cap in é (2 bytes/char): String.length would say half-cap chars,
    // but the byte cap must be respected.
    const half = Math.floor(cap / 4)
    const json = JSON.stringify({ text: "é".repeat(half) })
    expect(utf8ByteLength(json)).toBeLessThanOrEqual(cap)
    // A touch more pushes it over in bytes.
    const over = JSON.stringify({ text: "é".repeat(cap) })
    expect(utf8ByteLength(over)).toBeGreaterThan(cap)
    // writeContextTempFile must refuse the over-budget multibyte JSON.
    expect(writeContextTempFile(over)).toBeNull()
  })

  test("source byte accumulation uses UTF-8 bytes", () => {
    const multibyte = { info: { id: "m", sessionID: "s1" }, parts: [{ type: "text", text: "é".repeat(CONTEXT_CAP_SOURCE_BYTES) }] }
    const out = normalizeContextMessages([multibyte], { sessionID: "s1" })
    // 2 bytes per char → 2× cap in bytes → oversized → no message.
    expect(out.messages).toHaveLength(0)
    expect(out.truncated).toBe(true)
  })
})

// ── Output sanitization (no temp path / context content in ToolResult) ──────

describe("sanitizeContextOutput", () => {
  const tempPath = "/tmp/sandbox/tmp/agentgrep-context-abc/context.json"
  const contextJson = JSON.stringify({
    version: 1,
    known_files: [{ path: "src/a.ts", structure_confidence: 0.5, body_confidence: 0.4, current_version_confidence: 0.6, prune_confidence: 0.3, source_strength: "snippet", reasons: [] }],
  })

  test("legit AgentGrep output passes through unchanged", () => {
    const legit = "1. src/a.ts\nstructure:\n  - function alpha @ 1-1 (1 lines)\n"
    const res = sanitizeContextOutput(legit, { tempPath, contextJson })
    expect(res.redacted).toBe(false)
    expect(res.text).toBe(legit)
  })

  test("exact serialized context echoed → whole stream redacted", () => {
    const res = sanitizeContextOutput(`here is the file: ${contextJson}`, { tempPath, contextJson })
    expect(res.redacted).toBe(true)
    expect(res.text).toBe(CONTEXT_REDACTED_OUTPUT)
  })

  test("context JSON signature (known_* keys + version) → whole stream redacted", () => {
    const leak = '{"version":1,"known_files":[],"known_regions":[],"known_symbols":[],"focus_files":[]}'
    const res = sanitizeContextOutput(`echo: ${leak}`, { tempPath, contextJson })
    expect(res.redacted).toBe(true)
    expect(res.text).toBe(CONTEXT_REDACTED_OUTPUT)
    expect(hasContextJsonSignature(leak)).toBe(true)
    expect(hasContextJsonSignature("1. src/a.ts")).toBe(false)
  })

  test("exact temp path in a stream → replaced with the fixed placeholder", () => {
    const res = sanitizeContextOutput(`argv: --context-json ${tempPath}`, { tempPath, contextJson })
    expect(res.redacted).toBe(true)
    expect(res.text).toContain(CONTEXT_TEMP_PLACEHOLDER)
    expect(res.text).not.toContain(tempPath)
  })

  test("inactive context → never redacts", () => {
    const text = "anything"
    expect(sanitizeContextOutput(text, { tempPath: null, contextJson: null })).toEqual({ text, redacted: false })
  })
})

// ── SDK shims + bounded pagination ───────────────────────────────────────────

describe("SDK shims (feature detection + bounded pagination)", () => {
  test("hasSessionContext detects v2 tree and injected session.context", () => {
    expect(hasSessionContext({ v2: { session: { context: async () => [] } } })).toBe(true)
    expect(hasSessionContext({ session: { context: async () => [] } as never })).toBe(true)
    expect(hasSessionContext({ session: { messages: async () => [] } })).toBe(false)
    expect(hasSessionContext(null)).toBe(false)
  })

  test("v2 cursor pagination uses the real { data, cursor:{next} } shape and pages >1", async () => {
    // Installed @opencode-ai/sdk 1.18.21: client.v2.session.messages
    // ({ sessionID, limit, order, cursor }) → SessionMessagesResponse
    // { data: SessionMessage[], cursor: { previous?, next? } }.
    const calls: Array<{ cursor?: string; order?: string }> = []
    const client = {
      v2: {
        session: {
          messages: async (args: { sessionID: string; limit?: number; order?: "asc" | "desc"; cursor?: string }) => {
            calls.push({ cursor: args.cursor, order: args.order })
            const cur = args.cursor ?? "start"
            return {
              data: [{ info: { id: `m-${cur}`, sessionID: "s1" }, parts: [] }],
              cursor: { previous: cur === "start" ? undefined : "p0", next: cur === "start" ? "c1" : cur === "c1" ? "c2" : "c2" },
            }
          },
        },
      },
    }
    const { payload, pagesFetched } = await fetchSessionMessages(client as never, "s1", { perPage: 1, maxPages: 10 })
    // Deterministically follows cursor.next c1 → c2 → c2(repeated): 3 pages.
    expect(pagesFetched).toBe(3)
    expect(calls.length).toBe(pagesFetched)
    // First page has no cursor; subsequent pages pass the previous next cursor.
    expect(calls[0].cursor).toBeUndefined()
    expect(calls[1].cursor).toBe("c1")
    expect(calls[2].cursor).toBe("c2")
    // Order is pinned to "asc" for a stable timeline.
    for (const c of calls) expect(c.order).toBe("asc")
    // Every fetched page was consumed exactly once — none dropped.
    expect(payload).toHaveLength(3)
  })

  test("v2 cursor loop guard stops when the server echoes the same cursor", async () => {
    const client = {
      v2: {
        session: {
          messages: async () => ({
            data: [{ info: { id: "m-loop", sessionID: "s1" }, parts: [] }],
            cursor: { next: "same-cursor" }, // never advances
          }),
        },
      },
    }
    const { payload, pagesFetched } = await fetchSessionMessages(client as never, "s1", { perPage: 1, maxPages: 50 })
    // One follow-up page is fetched, then the repeated cursor breaks the loop
    // instead of looping forever.
    expect(pagesFetched).toBe(2)
    expect(pagesFetched).toBeLessThan(50)
    expect(payload).toHaveLength(2)
  })

  test("v2 pagination stops before exceeding the global message budget", async () => {
    // A malicious server returns far more items per page than the cap; the
    // SDK must not push them all.
    const { CONTEXT_CAP_MESSAGES } = await import("./agentgrep-context-caps")
    const client = {
      v2: {
        session: {
          messages: async () => ({
            data: Array.from({ length: CONTEXT_CAP_MESSAGES * 2 }, (_, i) => ({
              info: { id: `m${i}`, sessionID: "s1" },
              parts: [],
            })),
            cursor: { next: "more" },
          }),
        },
      },
    }
    const { payload, pagesFetched, truncated } = await fetchSessionMessages(client as never, "s1", { perPage: 500 })
    expect(pagesFetched).toBe(1)
    expect(truncated).toBe(true)
    expect(payload).toHaveLength(CONTEXT_CAP_MESSAGES)
  })

  test("v1 single page via path/query shape", async () => {
    const seen: unknown[] = []
    const client = {
      session: {
        messages: async (args: { path: { id: string }; query?: { limit?: number } }) => {
          seen.push(args)
          return [{ info: { id: "m", sessionID: "s1" }, parts: [] }]
        },
      },
    }
    const { payload, pagesFetched } = await fetchSessionMessages(client as never, "s1", { perPage: 50 })
    expect(pagesFetched).toBe(1)
    expect(seen).toHaveLength(1)
    expect(payload).toHaveLength(1)
  })

  test("throwing fetchers degrade to SAFE categories (never raw error text)", async () => {
    const secret = "credential leaked: sk-secret-abcdef path=/tmp/ctx.json session=ses_x"
    const client = {
      v2: {
        session: {
          messages: async () => { throw new Error(secret) },
          context: async () => { throw new Error(secret) },
        },
      },
    }
    const msgRes = await fetchSessionMessages(client as never, "s1")
    expect(msgRes.pagesFetched).toBe(0)
    expect(msgRes.error).toBe("messages_request_failed")
    expect(JSON.stringify(msgRes)).not.toContain("secret")
    const ctxRes = await fetchSessionContext(client as never, "s1")
    expect(ctxRes.payload).toBeNull()
    expect(ctxRes.error).toBe("context_request_failed")
    expect(JSON.stringify(ctxRes)).not.toContain("secret")
    expect(JSON.stringify(ctxRes)).not.toContain("/tmp/ctx.json")
  })

  test("v1MessagesOf narrows a v1-shaped namespace and rejects unusable ones", () => {
    const v1ns = { messages: async () => [] }
    expect(v1MessagesOf(v1ns as never)).toBe(v1ns)
    expect(v1MessagesOf(undefined)).toBeNull()
    expect(v1MessagesOf({} as never)).toBeNull()
    expect(v1MessagesOf({ context: async () => [] } as never)).toBeNull()
  })

  test("SDK methods are invoked ON their namespace (this-binding regression)", async () => {
    // Real hey-api SDK client methods rely on `this._client`. Extracting the
    // method (`const fn = client.session.messages; fn(...)`) calls it detached
    // and throws `this is undefined`. The shims must call on the namespace.
    const messagesClient = {
      session: {
        messages(this: unknown, _args: unknown) {
          if (this == null) throw new Error("detached: this is undefined")
          return [
            {
              info: { id: "m1", sessionID: "s1", role: "user", time: { created: 1 }, model: { providerID: "p", modelID: "m" } },
              parts: [{ id: "f1", sessionID: "s1", messageID: "m1", type: "file", mime: "text", url: "file://" + files.a }],
            },
          ]
        },
      },
    }
    const { payload, pagesFetched } = await fetchSessionMessages(messagesClient as never, "s1")
    expect(pagesFetched).toBe(1)
    expect(payload).toHaveLength(1)

    const contextClient = {
      v2: {
        session: {
          context(this: unknown, _args: { sessionID: string }) {
            if (this == null) throw new Error("detached: this is undefined")
            return [v2Assistant([v2ReadTool(files.a)])]
          },
        },
      },
    }
    const raw = await fetchSessionContext(contextClient as never, "s1")
    expect(raw.payload).not.toBeNull()

    // v2 cursor messages must also keep `this`.
    const v2MessagesClient = {
      v2: {
        session: {
          messages(this: unknown, _args: { sessionID: string }) {
            if (this == null) throw new Error("detached: this is undefined")
            return { data: [{ info: { id: "m1", sessionID: "s1" }, parts: [] }] }
          },
        },
      },
    }
    const v2res = await fetchSessionMessages(v2MessagesClient as never, "s1")
    expect(v2res.pagesFetched).toBe(1)
    expect(v2res.payload).toHaveLength(1)
  })

  test("createV2ClientFromServerUrl honors the test-seam factory", async () => {
    let created = false
    _setV2ClientModule({
      createOpencodeClient: (cfg: unknown) => {
        created = true
        expect((cfg as { baseUrl?: string }).baseUrl).toContain("localhost")
        return { session: {}, v2: { session: { context: async () => [] } } }
      },
    })
    try {
      const client = await createV2ClientFromServerUrl(new URL("http://localhost:4096"))
      expect(client).toBeTruthy()
      expect(created).toBe(true)
    } finally {
      _setV2ClientModule(null)
    }
  })

  test("createV2ClientFromServerUrl returns null without a URL", async () => {
    expect(await createV2ClientFromServerUrl(undefined)).toBeNull()
  })
})

// ── Path resolution / containment ────────────────────────────────────────────

describe("resolveContextRelativePath (containment + symlinks)", () => {
  test("in-root absolute path serializes as safe relative path", () => {
    expect(resolveContextRelativePath(files.a, ROOT)).toBe("src/a.ts")
  })

  test("relative path resolves against the search root", () => {
    expect(resolveContextRelativePath("src/a.ts", ROOT)).toBe("src/a.ts")
    expect(resolveContextRelativePath("./src/a.ts", ROOT)).toBe("src/a.ts")
  })

  test("file:// urls convert to paths", () => {
    expect(resolveContextRelativePath("file://" + files.a, ROOT)).toBe("src/a.ts")
  })

  test("outside paths are rejected (never included)", () => {
    expect(resolveContextRelativePath(files.out, ROOT)).toBeNull()
    expect(resolveContextRelativePath("../other/secret.ts", ROOT)).toBeNull()
    expect(resolveContextRelativePath("/etc/passwd", ROOT)).toBeNull()
  })

  test("symlink pointing outside the root is canonicalized and rejected", () => {
    const link = path.join(ROOT, "escape")
    fs.symlinkSync(OTHER, link, "dir")
    try {
      expect(resolveContextRelativePath("escape/secret.ts", ROOT)).toBeNull()
      expect(resolveContextRelativePath(link, ROOT)).toBeNull()
    } finally {
      fs.rmSync(link, { recursive: true, force: true })
    }
  })

  test("garbage candidates are rejected", () => {
    expect(resolveContextRelativePath("", ROOT)).toBeNull()
    expect(resolveContextRelativePath(".", ROOT)).toBeNull()
    expect(resolveContextRelativePath("..", ROOT)).toBeNull()
    expect(resolveContextRelativePath("a\u0000b", ROOT)).toBeNull()
  })
})

// ── Harness building (exposures, symbols, freshness, dedupe) ─────────────────

describe("buildHarnessContext (exposures + tuning)", () => {
  function msgWith(parts: NormalizedContextMessage["parts"], ts?: number, fromActive = false): NormalizedContextMessage {
    return { id: "m", index: 0, parts, timestamp: ts, fromActiveContext: fromActive }
  }

  test("read exposure → known_file + known_region", () => {
    const out = buildHarnessContext({
      searchRoot: ROOT,
      messages: [
        msgWith([
          {
            kind: "tool",
            tool: "read",
            filePath: files.a,
            lineStart: 1,
            lineEnd: 2,
          },
        ], 1_000_000),
      ],
    })!
    expect(out.known_files.some((f) => f.path === "src/a.ts" && f.reasons.includes("read_tool_exposure"))).toBe(true)
    expect(out.known_regions.some((r) => r.path === "src/a.ts" && r.start_line === 1 && r.end_line === 2)).toBe(true)
    expect(out.focus_files).toContain("src/a.ts")
  })

  test("snapshot.files and file:// attachments become known_files + focus", () => {
    const out = buildHarnessContext({
      searchRoot: ROOT,
      messages: [
        msgWith([
          { kind: "file", attachmentPaths: ["file://" + files.a] },
          { kind: "snapshot", snapshotFiles: ["src/b.ts"] },
        ]),
      ],
    })!
    expect(out.focus_files).toEqual(["src/a.ts", "src/b.ts"])
    expect(out.known_files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("outline tool part → known_file + symbols from structured output", () => {
    const out = buildHarnessContext({
      searchRoot: ROOT,
      messages: [
        msgWith([
          {
            kind: "tool",
            tool: "agentgrep",
            toolMode: "outline",
            filePath: files.a,
            toolOutput: "structure:\n  - function alpha @ 1-1 (1 lines)\n  - function beta @ 2-2 (1 lines)\n",
          },
        ]),
      ],
    })!
    expect(out.known_files.some((f) => f.path === "src/a.ts" && f.source_strength === "outline_only")).toBe(true)
    expect(out.known_symbols.some((s) => s.symbol === "alpha" && s.kind === "function")).toBe(true)
    expect(out.known_symbols.some((s) => s.symbol === "beta" && s.kind === "function")).toBe(true)
  })

  test("trace tool part → ranked files, structure symbols, region headers + bodies", () => {
    const output = [
      "1. src/a.ts",
      "structure:",
      "- fn alpha @ 1-5",
      "regions:",
      "- handle_auth @ 2-6",
      "full region:",
      "snippet:",
    ].join("\n")
    const out = buildHarnessContext({
      searchRoot: ROOT,
      messages: [msgWith([{ kind: "tool", tool: "agentgrep", toolMode: "trace", toolOutput: output, toolPath: files.a }])],
    })!
    expect(out.focus_files).toContain("src/a.ts")
    expect(out.known_files.some((f) => f.path === "src/a.ts" && f.reasons.includes("agentgrep_trace_file"))).toBe(true)
    expect(out.known_symbols.some((s) => s.symbol === "alpha" && s.kind === "fn")).toBe(true)
    expect(out.known_symbols.some((s) => s.symbol === "handle_auth")).toBe(true)
    expect(out.known_regions.some((r) => r.path === "src/a.ts" && r.start_line === 2 && r.end_line === 6)).toBe(true)
  })

  test("grep output path:line hits → files + regions", () => {
    const out = buildHarnessContext({
      searchRoot: ROOT,
      messages: [
        msgWith([
          {
            kind: "tool",
            tool: "agentgrep",
            toolMode: "grep",
            toolOutput: `${files.a}:3:export function alpha`,
          },
        ]),
      ],
    })!
    expect(out.known_files.some((f) => f.path === "src/a.ts")).toBe(true)
    expect(out.known_regions.some((r) => r.start_line === 3 && r.end_line === 3)).toBe(true)
  })

  test("find output ranked headers → known_files (safe known format)", () => {
    const out = buildHarnessContext({
      searchRoot: ROOT,
      messages: [
        msgWith([
          { kind: "tool", tool: "agentgrep", toolMode: "find", toolOutput: "1. src/a.ts\n2. src/b.ts\n" },
        ]),
      ],
    })!
    expect(out.known_files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("v2 explicit outputPaths → known_files + focus", () => {
    const out = buildHarnessContext({
      searchRoot: ROOT,
      messages: [
        msgWith([{ kind: "tool", tool: "agentgrep", toolMode: "trace", outputPaths: ["src/a.ts"] }]),
      ],
    })!
    expect(out.focus_files).toContain("src/a.ts")
    expect(out.known_files.some((f) => f.path === "src/a.ts" && f.reasons.includes("agentgrep_result_path"))).toBe(true)
  })

  test("freeform tool output text is NEVER copied into context", () => {
    const out = buildHarnessContext({
      searchRoot: ROOT,
      messages: [
        msgWith([
          {
            kind: "tool",
            tool: "agentgrep",
            toolMode: "trace",
            toolOutput: "ARBITRARY OUTPUT\npassword=hunter2\n",
          },
        ]),
      ],
    })
    const json = serializeHarnessContext(out) ?? ""
    expect(json).not.toContain("hunter2")
    expect(json).not.toContain("ARBITRARY OUTPUT")
  })

  test("freshness reasons are derived from bounded stat comparisons", () => {
    const old = path.join(ROOT, "old.ts")
    const fresh = path.join(ROOT, "new.ts")
    fs.writeFileSync(old, "// old\n")
    fs.writeFileSync(fresh, "// new\n")
    const past = Date.now() - 60_000
    fs.utimesSync(old, new Date(past), new Date(past))
    const now = Date.now()
    fs.utimesSync(fresh, new Date(now), new Date(now))
    try {
      // old file mtime (past) is before exposure (past+30s) → unchanged.
      const { reasons: unchanged } = tuneFreshness("old.ts", ROOT, past + 30_000, new FreshnessCache())
      expect(unchanged).toContain("file_unchanged_since_seen")
      // fresh file (now) has mtime after exposure (now-5s) → changed.
      const { reasons: changed } = tuneFreshness("new.ts", ROOT, now - 5_000, new FreshnessCache())
      expect(changed).toContain("file_changed_since_seen")
      // No exposure time → no claim.
      const { reasons: none } = tuneFreshness("old.ts", ROOT, undefined, new FreshnessCache())
      expect(none).toEqual([])
    } finally {
      fs.rmSync(old, { force: true })
      fs.rmSync(fresh, { force: true })
    }
  })

  test("compacted_history marker appears only before a compaction boundary", () => {
    const pre = buildHarnessContext({
      searchRoot: ROOT,
      messages: [
        { id: "c", index: 0, parts: [{ kind: "compaction", compaction: true }] },
        { id: "post", index: 1, parts: [{ kind: "tool", tool: "read", filePath: files.a, lineStart: 1, lineEnd: 1 }] },
      ],
    })!
    // single post-compaction message → tail marker
    expect(pre.known_files[0].reasons).toContain("active_context_tail")

    const both = buildHarnessContext({
      searchRoot: ROOT,
      messages: [
        { id: "old", index: 0, parts: [{ kind: "tool", tool: "read", filePath: files.a, lineStart: 1, lineEnd: 1 }] },
        { id: "c", index: 1, parts: [{ kind: "compaction", compaction: true }] },
        { id: "post", index: 2, parts: [{ kind: "tool", tool: "read", filePath: files.a, lineStart: 1, lineEnd: 1 }] },
      ],
    })!
    const oldEntry = both.known_files.find((f) => f.reasons.includes("compacted_history"))
    expect(oldEntry).toBeTruthy()
  })

  test("active-context source (post-compaction) is representable", () => {
    const out = buildHarnessContext({
      searchRoot: ROOT,
      messages: [
        { id: "a", index: 0, parts: [{ kind: "tool", tool: "read", filePath: files.a, lineStart: 1, lineEnd: 1 }], fromActiveContext: true },
      ],
    })!
    expect(out.known_files[0].reasons).toContain("active_context_tail")
  })

  test("deterministic dedupe + sort (merged confidences, sorted lists)", () => {
    const mk = () =>
      buildHarnessContext({
        searchRoot: ROOT,
        messages: [
          {
            id: "m",
            index: 0,
            parts: [
              { kind: "tool", tool: "read", filePath: files.a, lineStart: 1, lineEnd: 1 },
              { kind: "tool", tool: "read", filePath: files.a, lineStart: 1, lineEnd: 1 },
              { kind: "tool", tool: "agentgrep", toolMode: "outline", filePath: files.b, toolOutput: "- fn zeta @ 1-2\n- fn alpha @ 4-6\n" },
            ],
          },
        ],
      })!
    const first = JSON.stringify(mk())
    const second = JSON.stringify(mk())
    expect(second).toBe(first)
    const ctx = mk()
    expect(ctx.known_files.length).toBe(2)
    expect(ctx.known_files[0].path).toBe("src/a.ts")
    expect(ctx.known_files[1].path).toBe("src/b.ts")
    expect(ctx.known_symbols.map((s) => s.symbol)).toEqual(["alpha", "zeta"])
  })

  test("empty exposures → null (fail-closed no context)", () => {
    expect(
      buildHarnessContext({
        searchRoot: ROOT,
        messages: [{ id: "m", index: 0, parts: [{ kind: "text" }] }],
      }),
    ).toBeNull()
  })

  test("region line ranges are clamped to CONTEXT_CAP_LINE_RANGE", () => {
    const out = buildHarnessContext({
      searchRoot: ROOT,
      messages: [
        { id: "m", index: 0, parts: [{ kind: "tool", tool: "read", filePath: files.a, lineStart: 1, lineEnd: 1_000_000 }] },
      ],
    })!
    const region = out.known_regions[0]
    expect(region.end_line - region.start_line + 1).toBeLessThanOrEqual(CONTEXT_CAP_LINE_RANGE)
  })

  test("symbols are truncated to CONTEXT_CAP_STRING_LEN", () => {
    const longSymbol = "- fn " + "x".repeat(CONTEXT_CAP_STRING_LEN * 2) + " @ 1-2"
    const out = buildHarnessContext({
      searchRoot: ROOT,
      messages: [
        { id: "m", index: 0, parts: [{ kind: "tool", tool: "agentgrep", toolMode: "outline", filePath: files.a, toolOutput: longSymbol }] },
      ],
    })!
    expect(out!.known_symbols[0].symbol.length).toBeLessThanOrEqual(CONTEXT_CAP_STRING_LEN)
  })

  test("serialization omits empty arrays and enforces the JSON byte cap", () => {
    const json = serializeHarnessContext(
      asHarness({ version: 1, known_files: [], known_regions: [], known_symbols: [], focus_files: [] }),
    )
    expect(json).toBeNull()
    expect(serializeHarnessContext(null)).toBeNull()
    // Over-budget serialization → null.
    const huge = buildHarnessContext({
      searchRoot: ROOT,
      messages: Array.from({ length: 30 }, (_, i) => ({
        id: `m${i}`,
        index: i,
        parts: [
          {
            kind: "tool",
            tool: "read",
            filePath: files.a,
            lineStart: 1,
            lineEnd: 1 + i,
            // unreachable: build caps sizes; force over-budget via many focus entries below
          } as never,
        ],
      })),
    })
    const bigCtx = huge ? { ...huge, known_symbols: Array.from({ length: 3000 }, (_, i) => ({ path: "p", symbol: "s".repeat(300) + i, structure_confidence: 0.1, body_confidence: 0.1, current_version_confidence: 0.1, prune_confidence: 0.1, source_strength: "x", reasons: [] })) } : null
    if (bigCtx) {
      expect(serializeHarnessContext(bigCtx as HarnessContext)).toBeNull()
    } else {
      expect(bigCtx).toBeNull()
    }
  })

  test("per-list caps bound known files/regions/symbols/focus", () => {
    const out = buildHarnessContext({
      searchRoot: ROOT,
      messages: [
        {
          id: "m",
          index: 0,
          parts: Array.from({ length: CONTEXT_CAP_KNOWN_FILES + 20 }, (_, i) => ({
            kind: "tool",
            tool: "read",
            filePath: path.join(ROOT, "src", `f${i}.ts`),
            lineStart: 1,
            lineEnd: 1,
          })),
        },
      ],
    })!
    expect(out.known_files.length).toBeLessThanOrEqual(CONTEXT_CAP_KNOWN_FILES)
  })
})

// ── SQLite fallback ──────────────────────────────────────────────────────────

describe("SQLite fallback (guarded, exact-session)", () => {
  const saved = { dataHome: process.env.OPENCODE_DATA_HOME, xdg: process.env.XDG_DATA_HOME }

  function makeDbFixture(): { dir: string; db: string; close: () => void } {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ag-db-")))
    const db = path.join(dir, "opencode.db")
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    const d = new Database(db, { create: true })
    d.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT, title TEXT NOT NULL, version TEXT NOT NULL, slug TEXT NOT NULL, project_id TEXT NOT NULL, workspace_id TEXT, cost REAL NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0, tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0)`)
    d.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`)
    d.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`)
    d.exec(`CREATE INDEX part_session_idx ON part(session_id)`)
    d.exec(`CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id)`)
    const fixture = { dir, db, close: () => d.close() }
    d.close()
    return fixture
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  test("discovery order: OPENCODE_DATA_HOME → XDG_DATA_HOME → HOME", () => {
    process.env.OPENCODE_DATA_HOME = "/datahome"
    process.env.XDG_DATA_HOME = "/xdg"
    const list = openCodeDbCandidates("/home")
    expect(list.map((c) => c.source)).toEqual(["OPENCODE_DATA_HOME", "XDG_DATA_HOME", "HOME"])
    expect(list[0].dbPath).toBe(path.join("/datahome", "opencode.db"))
    expect(list[1].dbPath).toBe(path.join("/xdg", "opencode", "opencode.db"))
    expect(list[2].dbPath).toBe(path.join("/home", ".local", "share", "opencode", "opencode.db"))
  })

  test("validation returns the canonical db path; rejects non-files and outside-root paths", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ag-val-")))
    try {
      const notFile = { dbPath: dir, dataRoot: dir, source: "HOME" as const }
      expect(validateSqliteCandidate(notFile)).toBeNull()
      const dbPath = path.join(dir, "opencode.db")
      fs.writeFileSync(dbPath, "x")
      expect(validateSqliteCandidate({ dbPath, dataRoot: dir, source: "HOME" as const })).toBe(dbPath)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("inside-root symlink pointing OUTSIDE the data root is rejected", () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ag-val2-")))
    try {
      const outside = path.join(base, "outside")
      const root = path.join(base, "root")
      fs.mkdirSync(outside)
      fs.mkdirSync(root)
      const realDb = path.join(outside, "opencode.db")
      fs.writeFileSync(realDb, "x")
      // The candidate dbPath is INSIDE the data root but is a symlink to the
      // outside file — realpath resolves the target, containment must fail.
      const symlinkDb = path.join(root, "opencode.db")
      fs.symlinkSync(realDb, symlinkDb, "file")
      expect(validateSqliteCandidate({ dbPath: symlinkDb, dataRoot: root, source: "HOME" as const })).toBeNull()
      // And sqliteFallbackMessages must never open it (fail-closed null).
      const prev = process.env.OPENCODE_DATA_HOME
      process.env.OPENCODE_DATA_HOME = root
      try {
        expect(sqliteFallbackMessages("ses_a", [base], undefined)).toBeNull()
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_DATA_HOME
        else process.env.OPENCODE_DATA_HOME = prev
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("isValidSessionID is conservative", () => {
    expect(isValidSessionID("ses_abc123")).toBe(true)
    expect(isValidSessionID("")).toBe(false)
    expect(isValidSessionID("../etc")).toBe(false)
    expect(isValidSessionID("a b")).toBe(false)
    expect(isValidSessionID("x".repeat(200))).toBe(false)
    expect(isValidSessionID(undefined)).toBe(false)
  })

  test("reads ONLY the exact current session + verifies session directory", () => {
    const { dir, db, close } = makeDbFixture()
    try {
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
      const d = new Database(db)
      d.exec(`INSERT INTO session (id, directory, path, title, version, slug, project_id) VALUES ('cur', '${ROOT.replaceAll("'", "''")}', NULL, 't', '1', 's', 'p')`)
      d.exec(`INSERT INTO session (id, directory, path, title, version, slug, project_id) VALUES ('other', '${OTHER.replaceAll("'", "''")}', NULL, 't', '1', 's', 'p')`)
      d.exec(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('m1', 'cur', 1, 1, '{"role":"assistant"}')`)
      d.exec(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('m2', 'other', 1, 1, '{"role":"assistant"}')`)
      d.exec(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('p1', 'm1', 'cur', 1, 1, '{"type":"tool","tool":"read","state":{"status":"completed","input":{"file_path":"${files.a.replaceAll("'", "''")}"}}}')`)
      d.exec(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('p2', 'm2', 'other', 1, 1, '{"type":"text"}')`)
      d.close()
      close()

      const prev = process.env.OPENCODE_DATA_HOME
      process.env.OPENCODE_DATA_HOME = dir
      try {
        const result = sqliteFallbackMessages("cur", [ROOT], undefined)
        expect(result).not.toBeNull()
        expect(result!.messages).toHaveLength(1)
        expect(result!.messages[0].info.sessionID).toBe("cur")
        expect(result!.messages[0].parts).toHaveLength(1)
        expect((result!.messages[0].parts[0] as Record<string, unknown>).tool).toBe("read")
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_DATA_HOME
        else process.env.OPENCODE_DATA_HOME = prev
      }
    } finally {
      close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("directory mismatch (session belongs elsewhere) → fail-closed empty", () => {
    const { dir, db, close } = makeDbFixture()
    try {
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
      const d = new Database(db)
      d.exec(`INSERT INTO session (id, directory, path, title, version, slug, project_id) VALUES ('cur', '${OTHER.replaceAll("'", "''")}', NULL, 't', '1', 's', 'p')`)
      d.exec(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('m1', 'cur', 1, 1, '{"role":"assistant"}')`)
      d.close()
      close()

      const prev = process.env.OPENCODE_DATA_HOME
      process.env.OPENCODE_DATA_HOME = dir
      try {
        const result = sqliteFallbackMessages("cur", [ROOT], undefined)
        expect(result).toBeNull()
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_DATA_HOME
        else process.env.OPENCODE_DATA_HOME = prev
      }
    } finally {
      close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("bounded rows: more rows than CONTEXT_CAP_SQL_ROWS never read", () => {
    const { dir, db, close } = makeDbFixture()
    try {
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
      const d = new Database(db)
      d.exec(`INSERT INTO session (id, directory, path, title, version, slug, project_id) VALUES ('cur', '${ROOT.replaceAll("'", "''")}', NULL, 't', '1', 's', 'p')`)
      const stmt = d.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, '{"role":"assistant"}')`)
      d.exec("BEGIN")
      for (let i = 0; i < CONTEXT_CAP_SQL_ROWS + 50; i++) stmt.run(`m${i}`, "cur", i, i)
      d.exec("COMMIT")
      d.close()
      close()

      const prev = process.env.OPENCODE_DATA_HOME
      process.env.OPENCODE_DATA_HOME = dir
      try {
        const result = sqliteFallbackMessages("cur", [ROOT], undefined)!
        expect(result.messages.length).toBeLessThanOrEqual(CONTEXT_CAP_SQL_ROWS)
        expect(result.truncated).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_DATA_HOME
        else process.env.OPENCODE_DATA_HOME = prev
      }
    } finally {
      close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── Secure tempfile ──────────────────────────────────────────────────────────

describe("secure context tempfile", () => {
  test("writes 0600 file under a 0700 dir, capped bytes", () => {
    const json = JSON.stringify({ version: 1, known_files: [{ path: "a.ts" }] })
    const tmp = writeContextTempFile(json)
    expect(tmp).not.toBeNull()
    try {
      const mode = fs.statSync(tmp!.path).mode & 0o777
      expect(mode).toBe(0o600)
      const dirMode = fs.statSync(path.dirname(tmp!.path)).mode & 0o777
      expect(dirMode).toBe(0o700)
      expect(fs.readFileSync(tmp!.path, "utf8")).toBe(json)
    } finally {
      tmp!.cleanup()
    }
    expect(fs.existsSync(path.dirname(tmp!.path))).toBe(false)
  })

  test("oversized / empty JSON → null (no file, no dir)", () => {
    const before = countContextTempDirs()
    expect(writeContextTempFile(null)).toBeNull()
    expect(writeContextTempFile("")).toBeNull()
    expect(writeContextTempFile("x".repeat(CONTEXT_CAP_JSON_BYTES + 1))).toBeNull()
    expect(countContextTempDirs()).toBe(before)
  })

  test("withContextTempFile cleans up on success", async () => {
    const before = countContextTempDirs()
    const seen = await withContextTempFile("{}", async (p) => {
      expect(fs.existsSync(p)).toBe(true)
      return p
    })
    expect(typeof seen).toBe("string")
    // The temp dir is already removed before withContextTempFile resolves.
    expect(fs.existsSync(path.dirname(seen!))).toBe(false)
    expect(countContextTempDirs()).toBe(before)
  })

  test("withContextTempFile cleans up on throw", async () => {
    const before = countContextTempDirs()
    await expect(
      withContextTempFile("{}", async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(countContextTempDirs()).toBe(before)
  })

  test("withContextTempFile returns null (fn not called) for unusable JSON", async () => {
    let called = false
    const res = await withContextTempFile(null, async () => {
      called = true
      return "x"
    })
    expect(res).toBeNull()
    expect(called).toBe(false)
  })
})

// ── Provider precedence ──────────────────────────────────────────────────────

describe("createAgentGrepContextProvider (precedence + fail-closed)", () => {
  function fakePluginInput(client: unknown): never {
    return {
      client,
      directory: ROOT,
      worktree: ROOT,
      project: {},
      experimental_workspace: { register() {} },
      serverUrl: new URL("http://localhost:4096"),
      $: undefined,
    } as never
  }

  test("SDK context (post-compaction active) is preferred over messages", async () => {
    const contextClient = {
      v2: {
        session: {
          context: async () => [
            v2Assistant([v2ReadTool(files.a)], [rel(files.b)], 2_000_000),
          ],
        },
      },
    }
    const provider = createAgentGrepContextProvider(fakePluginInput(contextClient))
    const json = await provider.getHarnessJson({ mode: "trace", terms: ["subject:x"] }, ctxFor(ROOT), ROOT)
    expect(json).not.toBeNull()
    expect(json).toContain("src/a.ts")
  })

  test("messages fallback when context is absent", async () => {
    const messagesClient = {
      session: {
        messages: async () => [v1Msg("ses_test_1", [v1ReadPart(files.a, 1, 3)])],
      },
    }
    const provider = createAgentGrepContextProvider(fakePluginInput(messagesClient))
    const json = await provider.getHarnessJson({ mode: "trace", terms: ["subject:x"] }, ctxFor(ROOT), ROOT)
    expect(json).not.toBeNull()
    expect(json).toContain("src/a.ts")
  })

  test("context endpoint returning unusable data falls through to messages", async () => {
    const client = {
      v2: { session: { context: async () => null } },
      session: {
        messages: async () => [v1Msg("ses_test_1", [v1ReadPart(files.a, 1, 3)])],
      },
    }
    const provider = createAgentGrepContextProvider(fakePluginInput(client))
    const json = await provider.getHarnessJson({ mode: "trace", terms: ["subject:x"] }, ctxFor(ROOT), ROOT)
    expect(json).not.toBeNull()
  })

  test("SQLite fallback engages when the SDK paths yield nothing", async () => {
    const client = { v2: { session: { context: async () => null } }, session: {} }
    const { dir, db, close } = (() => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ag-db2-")))
      const db = path.join(dir, "opencode.db")
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
      const d = new Database(db, { create: true })
      d.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT, title TEXT NOT NULL, version TEXT NOT NULL, slug TEXT NOT NULL, project_id TEXT NOT NULL, workspace_id TEXT, cost REAL NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0, tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0)`)
      d.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`)
      d.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`)
      d.exec(`INSERT INTO session (id, directory, path, title, version, slug, project_id) VALUES ('ses_test_1', '${ROOT.replaceAll("'", "''")}', NULL, 't', '1', 's', 'p')`)
      d.exec(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('m1', 'ses_test_1', 1, 1, '{"role":"assistant"}')`)
      d.exec(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('p1', 'm1', 'ses_test_1', 1, 1, '{"type":"tool","tool":"read","state":{"status":"completed","input":{"file_path":"${files.a.replaceAll("'", "''")}"}}}')`)
      d.close()
      return { dir, db, close: () => {} }
    })()
    const savedDataHome = process.env.OPENCODE_DATA_HOME
    process.env.OPENCODE_DATA_HOME = dir
    try {
      const provider = createAgentGrepContextProvider(fakePluginInput(client))
      const json = await provider.getHarnessJson({ mode: "trace", terms: ["subject:x"] }, ctxFor(ROOT), ROOT)
      expect(json).not.toBeNull()
      expect(json).toContain("src/a.ts")
    } finally {
      if (savedDataHome === undefined) delete process.env.OPENCODE_DATA_HOME
      else process.env.OPENCODE_DATA_HOME = savedDataHome
      fs.rmSync(dir, { recursive: true, force: true })
      close()
    }
  })

  test("grep/find modes never build context (jcode parity)", async () => {
    const client = { v2: { session: { context: async () => [v2Assistant([v2ReadTool(files.a)])] } } }
    const provider = createAgentGrepContextProvider(fakePluginInput(client))
    expect(await provider.getHarnessJson({ mode: "grep", query: "x" }, ctxFor(ROOT), ROOT)).toBeNull()
    expect(await provider.getHarnessJson({ mode: "find", query: "x" }, ctxFor(ROOT), ROOT)).toBeNull()
  })

  test("fail-closed: throws/malformed/missing degrade to null", async () => {
    const bad = { v2: { session: { context: async () => { throw new Error("x") } } } }
    const provider = createAgentGrepContextProvider(fakePluginInput(bad))
    await expect(provider.getHarnessJson({ mode: "trace", terms: ["a"] }, ctxFor(ROOT), ROOT)).resolves.toBeNull()
    await expect(
      createAgentGrepContextProvider(null).getHarnessJson({ mode: "trace", terms: ["a"] }, ctxFor(ROOT), ROOT),
    ).resolves.toBeNull()
  })
})

// ── tools.ts integration ─────────────────────────────────────────────────────

describe("tools.ts context integration (execute)", () => {
  const harness = { dir: "", bin: "", record: "", ctxCopy: "" }
  const saved = { bin: process.env.AGENTGREP_BIN, record: process.env.AG_RECORD, copy: process.env.AG_CTX_COPY }

  const FAKE_BIN = `
printf '%s\\n' "$(printf '%s\\t' "$@")" >> "\${AG_RECORD:-/dev/null}"
prev=""
for a in "$@"; do
  if [ "$prev" = "--context-json" ] && [ -n "$a" ]; then
    if [ -f "$a" ]; then
      printf 'CTX_MODE:%s\\nCTX_SIZE:%s\\n' "$(stat -c %a "$a")" "$(stat -c %s "$a")" >> "\${AG_RECORD:-/dev/null}"
      cp "$a" "\${AG_CTX_COPY:-/dev/null}" 2>/dev/null
    fi
  fi
  prev="$a"
done
case "$1" in
  outline) printf 'STRUCTURE: fn alpha @ 1-3\\n';;
  trace) printf 'TRACE: ok\\n';;
  find) printf 'FILES: x.ts\\n';;
  *) printf 'MATCH: x.ts:1: q\\n';;
esac
`

  beforeAll(() => {
    harness.dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-ctx-harness-"))
    harness.bin = path.join(harness.dir, "agentgrep-fake")
    fs.writeFileSync(harness.bin, `#!/usr/bin/env bash\n${FAKE_BIN}\n`)
    fs.chmodSync(harness.bin, 0o755)
    harness.record = path.join(harness.dir, "record.txt")
    harness.ctxCopy = path.join(harness.dir, "ctx-copy.json")
    process.env.AGENTGREP_BIN = harness.bin
    process.env.AG_RECORD = harness.record
    process.env.AG_CTX_COPY = harness.ctxCopy
  })
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(harness.dir, { recursive: true, force: true })
  })

  function readRecord(): string[] {
    if (!fs.existsSync(harness.record)) return []
    return fs.readFileSync(harness.record, "utf8").split("\n").filter(Boolean)
  }

  function contextAwareTools(): { tools: ReturnType<typeof buildAgentGrepTools>; dir: string } {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ag-ctx-exec-")))
    fs.writeFileSync(path.join(dir, "a.ts"), "export function alpha() {}\n")
    const client = {
      v2: { session: { context: async () => [v2Assistant([v2ReadTool(path.join(dir, "a.ts"))])] } },
    }
    const pluginInput = {
      client,
      directory: dir,
      worktree: dir,
      project: {},
      experimental_workspace: { register() {} },
      serverUrl: new URL("http://localhost:4096"),
      $: undefined,
    } as never
    return { tools: buildAgentGrepTools(pluginInput), dir }
  }

  function assertNoTempLeak(text: string, asks: unknown[]): void {
    expect(text).not.toContain("agentgrep-context-")
    expect(JSON.stringify(asks)).not.toContain("agentgrep-context-")
    expect(JSON.stringify(asks)).not.toContain("context.json")
  }

  test("trace execute passes --context-json; temp cleaned up; no leakage", async () => {
    const { tools, dir } = contextAwareTools()
    const asks: unknown[] = []
    const ctx: ToolContext = {
      sessionID: "ses_test_2",
      messageID: "m",
      agent: "test",
      directory: dir,
      worktree: "/",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async (req: unknown) => {
        asks.push(req)
      },
    }
    try {
      fs.writeFileSync(harness.record, "")
      fs.rmSync(harness.ctxCopy, { force: true })
      const res = objectResult(await tools.agentgrep.execute({ mode: "trace", terms: ["subject:x"] }, ctx))
      expect(res.metadata.ok).toBe(true)
      const record = readRecord()
      const ctxIdx = record.findIndex((l) => l.startsWith("trace\t"))
      expect(ctxIdx).toBeGreaterThan(-1)
      expect(record[ctxIdx]).toContain("--context-json")
      // context file was real, valid JSON, 0600 at write time
      const modeLine = record.find((l) => l.startsWith("CTX_MODE:"))
      expect(modeLine).toBe("CTX_MODE:600")
      expect(fs.existsSync(harness.ctxCopy)).toBe(true)
      const copied = JSON.parse(fs.readFileSync(harness.ctxCopy, "utf8"))
      expect(copied.version).toBe(1)
      expect(JSON.stringify(copied)).toContain("a.ts")
      assertNoTempLeak(res.output, asks)
      // temp dir is gone after execute
      expect(countContextTempDirs()).toBe(baselineTempDirs)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("outline execute also passes --context-json", async () => {
    const { tools, dir } = contextAwareTools()
    const ctx = ctxFor(dir)
    try {
      fs.writeFileSync(harness.record, "")
      const res = objectResult(await tools.agentgrep.execute({ mode: "outline", file: "a.ts" }, ctx))
      expect(res.metadata.ok).toBe(true)
      const rec = readRecord().find((l) => l.startsWith("outline\t"))
      expect(rec).toContain("--context-json")
      expect(countContextTempDirs()).toBe(baselineTempDirs)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("grep and find never receive --context-json", async () => {
    const { tools, dir } = contextAwareTools()
    const ctx = ctxFor(dir)
    try {
      fs.writeFileSync(harness.record, "")
      await tools.agentgrep.execute({ mode: "grep", query: "x" }, ctx)
      let rec = readRecord().find((l) => l.startsWith("grep\t"))
      expect(rec).not.toContain("--context-json")

      fs.writeFileSync(harness.record, "")
      await tools.agentgrep.execute({ mode: "find", query: "x" }, ctx)
      rec = readRecord().find((l) => l.startsWith("find\t"))
      expect(rec).not.toContain("--context-json")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("cleanup happens on nonzero exit and ToolResult represents failure", async () => {
    const { tools, dir } = contextAwareTools()
    const ctx = ctxFor(dir)
    const failBin = path.join(harness.dir, "agentgrep-fail")
    fs.writeFileSync(failBin, "#!/usr/bin/env bash\nprintf 'boom on stderr\\n' >&2\nexit 7\n")
    fs.chmodSync(failBin, 0o755)
    const prevBin = process.env.AGENTGREP_BIN
    process.env.AGENTGREP_BIN = failBin
    try {
      fs.writeFileSync(harness.record, "")
      const res = objectResult(await tools.agentgrep.execute({ mode: "trace", terms: ["subject:x"] }, ctx))
      expect(res.metadata.ok).toBe(false)
      expect(res.metadata.exit).toBe(7)
      expect(res.output).toContain("failed (exit 7)")
      // context temp cleaned up even though the CLI failed
      expect(countContextTempDirs()).toBe(baselineTempDirs)
    } finally {
      process.env.AGENTGREP_BIN = prevBin
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("malicious fake bin echoing argv: temp path is scrubbed from ToolResult", async () => {
    const { tools, dir } = contextAwareTools()
    const ctx = ctxFor(dir)
    const echoBin = path.join(harness.dir, "agentgrep-echo-argv")
    fs.writeFileSync(echoBin, "#!/usr/bin/env bash\nprintf 'argv: %s\\n' \"$*\"\n")
    fs.chmodSync(echoBin, 0o755)
    const prevBin = process.env.AGENTGREP_BIN
    process.env.AGENTGREP_BIN = echoBin
    try {
      fs.writeFileSync(harness.record, "")
      const res = objectResult(await tools.agentgrep.execute({ mode: "trace", terms: ["subject:x"] }, ctx))
      expect(res.metadata.ok).toBe(true)
      // The raw temp path must never reach the model; only the fixed placeholder.
      expect(res.output).toContain(CONTEXT_TEMP_PLACEHOLDER)
      expect(res.output).not.toContain("agentgrep-context-")
      expect(res.output).not.toContain("context.json")
      expect(countContextTempDirs()).toBe(baselineTempDirs)
    } finally {
      process.env.AGENTGREP_BIN = prevBin
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("malicious fake bin cat'ing the context JSON to stdout/stderr: whole stream redacted", async () => {
    const { tools, dir } = contextAwareTools()
    const ctx = ctxFor(dir)
    const leakBin = path.join(harness.dir, "agentgrep-leak-ctx")
    // Leak the exact context file to stdout and stderr, then exit 3.
    fs.writeFileSync(
      leakBin,
      "#!/usr/bin/env bash\nprev=''\nfor a in \"$@\"; do [ \"$prev\" = '--context-json' ] && [ -n \"$a\" ] && { cat \"$a\"; cat \"$a\" >&2; }; prev=\"$a\"; done\nexit 3\n",
    )
    fs.chmodSync(leakBin, 0o755)
    const prevBin = process.env.AGENTGREP_BIN
    process.env.AGENTGREP_BIN = leakBin
    try {
      fs.writeFileSync(harness.record, "")
      const res = objectResult(await tools.agentgrep.execute({ mode: "trace", terms: ["subject:x"] }, ctx))
      expect(res.metadata.ok).toBe(false)
      expect(res.metadata.exit).toBe(3)
      expect(res.metadata.contextRedacted).toBe(true)
      // No JSON keys / context content survived — the stream was redacted whole.
      expect(res.output).not.toContain("known_files")
      expect(res.output).not.toContain("focus_files")
      expect(res.output).not.toContain("src/a.ts")
      expect(res.output).toContain(CONTEXT_REDACTED_OUTPUT)
      expect(countContextTempDirs()).toBe(baselineTempDirs)
    } finally {
      process.env.AGENTGREP_BIN = prevBin
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("cleanup happens on timeout", async () => {
    const { tools, dir } = contextAwareTools()
    const ctx = ctxFor(dir)
    const sleepBin = path.join(harness.dir, "agentgrep-sleep")
    fs.writeFileSync(sleepBin, "#!/usr/bin/env bash\nsleep 30\n")
    fs.chmodSync(sleepBin, 0o755)
    const prevBin = process.env.AGENTGREP_BIN
    const prevTimeout = process.env.AGENTGREP_TIMEOUT_MS
    process.env.AGENTGREP_BIN = sleepBin
    process.env.AGENTGREP_TIMEOUT_MS = "150"
    try {
      const res = objectResult(await tools.agentgrep.execute({ mode: "trace", terms: ["subject:x"] }, ctx))
      expect(res.metadata.timedOut).toBe(true)
      expect(countContextTempDirs()).toBe(baselineTempDirs)
    } finally {
      process.env.AGENTGREP_BIN = prevBin
      if (prevTimeout === undefined) delete process.env.AGENTGREP_TIMEOUT_MS
      else process.env.AGENTGREP_TIMEOUT_MS = prevTimeout
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("cleanup happens on abort", async () => {
    const { tools, dir } = contextAwareTools()
    const ctl = new AbortController()
    const ctx: ToolContext = { ...ctxFor(dir), abort: ctl.signal }
    const sleepBin = path.join(harness.dir, "agentgrep-sleep2")
    fs.writeFileSync(sleepBin, "#!/usr/bin/env bash\nsleep 30\n")
    fs.chmodSync(sleepBin, 0o755)
    const prevBin = process.env.AGENTGREP_BIN
    process.env.AGENTGREP_BIN = sleepBin
    try {
      const p = tools.agentgrep.execute({ mode: "trace", terms: ["subject:x"] }, ctx)
      setTimeout(() => ctl.abort(), 150)
      const res = objectResult(await p)
      expect(res.metadata.aborted).toBe(true)
      expect(countContextTempDirs()).toBe(baselineTempDirs)
    } finally {
      process.env.AGENTGREP_BIN = prevBin
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("internal smart execute keeps smart until argv building (query splits into DSL terms)", async () => {
    const { tools, dir } = contextAwareTools()
    const ctx = ctxFor(dir)
    try {
      fs.writeFileSync(harness.record, "")
      const res = objectResult(await tools.agentgrep.execute({ mode: "smart", query: "subject:a relation:b" }, ctx))
      expect(res.metadata.ok).toBe(true)
      const rec = readRecord().find((l) => l.startsWith("trace\t"))
      // smart+query → CLI subcommand trace with split DSL terms + context
      expect(rec).toContain("trace\t")
      expect(rec).toContain("subject:a")
      expect(rec).toContain("relation:b")
      expect(rec).toContain("--context-json")
      // never a "smart" subcommand
      expect(readRecord().some((l) => l.startsWith("smart\t"))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("exact-file containment remains exact while context is present", async () => {
    const { tools, dir } = contextAwareTools()
    const ctx = ctxFor(dir)
    try {
      fs.writeFileSync(path.join(dir, "b.ts"), "export function beta() {}\n")
      fs.writeFileSync(harness.record, "")
      const res = objectResult(await tools.agentgrep.execute({ mode: "trace", terms: ["subject:x"], path: "a.ts" }, ctx))
      expect(res.metadata.ok).toBe(true)
      const rec = readRecord().find((l) => l.startsWith("trace\t"))
      const parts = rec!.split("\t")
      const pathIdx = parts.indexOf("--path")
      expect(parts[pathIdx + 1]).toBe(dir) // parent dir
      const globIdx = parts.indexOf("--glob")
      expect(parts[globIdx + 1]).toBe("a.ts") // basename glob
      expect(rec).toContain("--context-json")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("find file/type/glob-only locks survive with context available", async () => {
    const { tools, dir } = contextAwareTools()
    const ctx = ctxFor(dir)
    try {
      fs.writeFileSync(harness.record, "")
      await tools.agentgrep.execute({ mode: "find", glob: "*.ts" }, ctx)
      const globOnly = readRecord().find((l) => l.startsWith("find\t"))
      expect(globOnly).toContain("--glob")
      expect(globOnly).not.toContain("--context-json")

      fs.writeFileSync(harness.record, "")
      await tools.agentgrep.execute({ mode: "find", file_type: "ts" }, ctx)
      const typeOnly = readRecord().find((l) => l.startsWith("find\t"))
      expect(typeOnly).toContain("--type")
      expect(typeOnly).not.toContain("--context-json")

      fs.writeFileSync(harness.record, "")
      await tools.agentgrep.execute({ mode: "find", path: "a.ts" }, ctx)
      const fileOnly = readRecord().find((l) => l.startsWith("find\t"))
      expect(fileOnly).toContain("--glob")
      expect(fileOnly).toContain("--path")
      expect(fileOnly).not.toContain("--context-json")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("no-context fallback: plugin without PluginInput runs without --context-json", async () => {
    const { tools, dir } = contextAwareTools()
    const noInputTools = buildAgentGrepTools()
    const ctx = ctxFor(dir)
    try {
      fs.writeFileSync(harness.record, "")
      const res = objectResult(await noInputTools.agentgrep.execute({ mode: "trace", terms: ["subject:x"] }, ctx))
      expect(res.metadata.ok).toBe(true)
      const rec = readRecord().find((l) => l.startsWith("trace\t"))
      expect(rec).not.toContain("--context-json")
      void tools
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("outline existing-file path behavior locks (file-valued path is the target)", async () => {
    const { tools, dir } = contextAwareTools()
    const ctx = ctxFor(dir)
    try {
      fs.writeFileSync(harness.record, "")
      const res = objectResult(await tools.agentgrep.execute({ mode: "outline", path: "a.ts" }, ctx))
      expect(res.metadata.ok).toBe(true)
      const rec = readRecord().find((l) => l.startsWith("outline\t"))
      expect(rec).toContain(path.join(dir, "a.ts"))
      expect(rec).toContain("--context-json")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── Pure argv parity locks (context flag only on trace/outline) ──────────────

describe("buildAgentGrepArgs --context-json parity", () => {
  test("trace emits --context-json only when __contextJson set", () => {
    expect(buildAgentGrepArgs({ mode: "trace", terms: ["subject:x"] })).not.toContain("--context-json")
    const argv = buildAgentGrepArgs({ mode: "trace", terms: ["subject:x"], __contextJson: "/tmp/ctx.json" })
    expect(argv[argv.length - 2]).toBe("--context-json")
    expect(argv[argv.length - 1]).toBe("/tmp/ctx.json")
  })

  test("smart emits --context-json via resolved trace (CLI subcommand trace)", () => {
    const argv = buildAgentGrepArgs({ mode: "smart", query: "subject:a relation:b", __contextJson: "/tmp/c.json" })
    expect(argv[0]).toBe("trace")
    expect(argv).toContain("subject:a")
    expect(argv).toContain("--context-json")
  })

  test("outline emits --context-json; grep/find never do", () => {
    expect(buildAgentGrepArgs({ mode: "outline", file: "a.ts", __contextJson: "/tmp/c.json" })).toContain("--context-json")
    expect(buildAgentGrepArgs({ mode: "grep", query: "x", __contextJson: "/tmp/c.json" })).not.toContain("--context-json")
    expect(buildAgentGrepArgs({ mode: "find", query: "x", __contextJson: "/tmp/c.json" })).not.toContain("--context-json")
  })

  test("public schema still exposes type (never file_type) and no smart; no __contextJson/__fileScope", () => {
    const tools = buildAgentGrepTools()
    const keys = Object.keys(tools.agentgrep.args ?? {})
    expect(keys).toContain("type")
    expect(keys).not.toContain("file_type")
    expect(keys).not.toContain("smart")
    expect(keys).not.toContain("__contextJson")
    expect(keys).not.toContain("__fileScope")
    const modeShape = (tools.agentgrep.args as Record<string, any>).mode
    const enumShape = modeShape?.unwrap?.() ?? modeShape
    expect(enumShape?.options ?? []).toEqual(["grep", "find", "outline", "trace"])
  })

  test("exactFileScope still wins when __contextJson present", () => {
    const scope = exactFileScope("/r/src/a.ts", "file", "user-*.rs")
    expect(scope).toEqual({ root: "/r/src", glob: "a.ts" })
    const argv = buildAgentGrepArgs({ mode: "grep", query: "q", __fileScope: scope!, __contextJson: "/tmp/c.json" })
    expect(argv).toContain("--glob")
    expect(argv[argv.indexOf("--glob") + 1]).toBe("a.ts")
    // grep never gets the context flag even with __contextJson set
    expect(argv).not.toContain("--context-json")
  })
})