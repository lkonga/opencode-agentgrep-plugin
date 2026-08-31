// agentgrep — standalone OpenCode plugin. Execute/bounds/smoke tests:
// ToolDefinition.execute through a fake CLI harness (permission asks, argv,
// canonical path threading), OpenCode-native permission & path semantics,
// bounded execution (timeout/abort/output cap), and optional real-CLI smoke
// (skipped when no agentgrep binary is installed).

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import {
  buildAgentGrepArgs,
  buildAgentGrepTools,
  exactFileScope,
  runAgentGrep,
  tryResolveAgentGrepBin,
  canonicalizePath,
  resolveModelRoots,
  isInsideProject,
  askExternalDirectoryIfNeeded,
  AGENTGREP_DEFAULT_TIMEOUT_MS,
  AGENTGREP_DEFAULT_MAX_OUTPUT_CHARS,
} from "./agentgrep-core"

// ── Fake agentgrep CLI harness ───────────────────────────────────────────────
// A tiny bash stand-in for the real `agentgrep` binary. It records its argv to
// $AG_RECORD (one invocation per line, args tab-separated) and emits canned
// mode-shaped output so ToolDefinition.execute smokes + permission tests run
// without the Rust binary. All fake bins live under one disposable temp dir.

const FAKE_BIN_BODY = `
printf '%s\n' "$(printf '%s\t' "$@")" >> "\${AG_RECORD:-/dev/null}"
mode="$1"
case "$mode" in
  outline)
    echo "STRUCTURE: alpha (line 1)"
    echo "STRUCTURE: beta (line 2)"
    ;;
  find)
    echo "FILES: session-store.ts"
    ;;
  *)
    echo "MATCH: a.ts:2: q"
    ;;
esac
`

function writeBin(dir: string, name: string, body: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`)
  fs.chmodSync(file, 0o755)
  return file
}

function readRecord(file: string): string[][] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").filter(Boolean))
}

interface AskRecord {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}

function makeCtx(overrides: {
  directory?: string
  worktree?: string
  ask?: (req: any) => Promise<void>
} = {}): { ctx: ToolContext; asks: AskRecord[] } {
  const asks: AskRecord[] = []
  const ctx: ToolContext = {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test",
    directory: overrides.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "ag-ctx-")),
    worktree: overrides.worktree ?? "/",
    abort: new AbortController().signal,
    metadata: () => {},
    ask:
      overrides.ask ??
      (async (req: any) => {
        asks.push({ ...req })
      }),
  }
  return { ctx, asks }
}

function asResult(res: ToolResult): { output: string; metadata: Record<string, any> } {
  expect(typeof res).toBe("object")
  return res as unknown as { output: string; metadata: Record<string, any> }
}

const harness = { dir: "", bin: "", sleepBin: "", bigBin: "", record: "" }

beforeAll(() => {
  harness.dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-harness-"))
  harness.bin = writeBin(harness.dir, "agentgrep-fake", FAKE_BIN_BODY)
  harness.sleepBin = writeBin(harness.dir, "agentgrep-sleep", `sleep 30`)
  harness.bigBin = writeBin(harness.dir, "agentgrep-big", `yes "xxxxxxxxxxxxxxxxxxxxxxxxxxxx" | head -c 2000000`)
  harness.record = path.join(harness.dir, "record.txt")
})

afterAll(() => {
  fs.rmSync(harness.dir, { recursive: true, force: true })
})

// ── Real ToolDefinition.execute smoke (fake bin, always runs) ────────────────

describe("ToolDefinition.execute smoke (fake agentgrep bin)", () => {
  const tools = buildAgentGrepTools()
  const savedBin = process.env.AGENTGREP_BIN
  const savedRecord = process.env.AG_RECORD

  beforeAll(() => {
    process.env.AGENTGREP_BIN = harness.bin
    process.env.AG_RECORD = harness.record
  })
  afterAll(() => {
    if (savedBin === undefined) delete process.env.AGENTGREP_BIN
    else process.env.AGENTGREP_BIN = savedBin
    if (savedRecord === undefined) delete process.env.AG_RECORD
    else process.env.AG_RECORD = savedRecord
  })

  function lastArgv(): string[] {
    const rec = readRecord(harness.record)
    return rec[rec.length - 1] ?? []
  }

  test("grep: execute resolves relative path, asks agentgrep, spawns the CLI", async () => {
    const { ctx, asks } = makeCtx()
    try {
      fs.writeFileSync(harness.record, "")
      const res = asResult(await tools.agentgrep.execute({ mode: "grep", query: "auth", path: "src" }, ctx))
      expect(res.output).toContain("MATCH: a.ts")
      expect(res.metadata.ok).toBe(true)
      expect(res.metadata.mode).toBe("grep")

      const argv = lastArgv()
      expect(argv[0]).toBe("grep")
      expect(argv[1]).toBe("auth")
      const pathIdx = argv.indexOf("--path")
      expect(pathIdx).toBeGreaterThan(-1)
      expect(argv[pathIdx + 1]).toBe(path.join(fs.realpathSync(ctx.directory), "src"))

      const ask = asks.find((a) => a.permission === "agentgrep")
      expect(ask).toBeTruthy()
      expect(ask!.patterns).toEqual(["auth"])
      expect(ask!.always).toEqual(["*"])
      expect(ask!.metadata.mode).toBe("grep")
      // in-project root → no external_directory ask
      expect(asks.some((a) => a.permission === "external_directory")).toBe(false)
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("grep: file-valued path spawns parent --path + basename --glob (sibling isolation)", async () => {
    const { ctx, asks } = makeCtx()
    try {
      fs.mkdirSync(path.join(ctx.directory, "src"), { recursive: true })
      fs.writeFileSync(path.join(ctx.directory, "src", "a.ts"), "// a\n")
      fs.writeFileSync(path.join(ctx.directory, "src", "b.ts"), "// b\n")
      fs.writeFileSync(harness.record, "")
      const res = asResult(
        await tools.agentgrep.execute({ mode: "grep", query: "auth", path: "src/a.ts" }, ctx),
      )
      expect(res.metadata.ok).toBe(true)

      const argv = lastArgv()
      expect(argv[0]).toBe("grep")
      expect(argv[1]).toBe("auth")
      const pathIdx = argv.indexOf("--path")
      expect(argv[pathIdx + 1]).toBe(path.join(fs.realpathSync(ctx.directory), "src"))
      const globIdx = argv.indexOf("--glob")
      expect(argv[globIdx + 1]).toBe("a.ts")

      // The canonical file root is inside the project → no external ask.
      expect(asks.some((a) => a.permission === "external_directory")).toBe(false)
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("find: execute forces find mode, splits multiword terms, threads glob + canonical path", async () => {
    const { ctx, asks } = makeCtx()
    try {
      fs.mkdirSync(path.join(ctx.directory, "src"), { recursive: true })
      fs.writeFileSync(harness.record, "")
      const res = asResult(
        await tools.find.execute({ query: "session store", glob: "*.ts", path: "src" }, ctx),
      )
      expect(res.metadata.ok).toBe(true)
      expect(res.metadata.mode).toBe("find")

      const argv = lastArgv()
      expect(argv[0]).toBe("find")
      // multiword query split into positionals — permission patterns match
      expect(argv.slice(1, 3)).toEqual(["session", "store"])
      expect(argv).toContain("--max-files")
      expect(argv[argv.indexOf("--max-files") + 1]).toBe("10")
      const globIdx = argv.indexOf("--glob")
      expect(argv[globIdx + 1]).toBe("*.ts")
      const pathIdx = argv.indexOf("--path")
      expect(argv[pathIdx + 1]).toBe(path.join(fs.realpathSync(ctx.directory), "src"))

      const ask = asks.find((a) => a.permission === "agentgrep")
      expect(ask!.patterns).toEqual(["session", "store"])
      expect(ask!.always).toEqual(["*"])
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("find: scoped-only call (no terms) spawns with empty query positional, no throw", async () => {
    const { ctx } = makeCtx()
    try {
      fs.writeFileSync(harness.record, "")
      const res = asResult(await tools.find.execute({ glob: "*.ts" }, ctx))
      expect(res.metadata.ok).toBe(true)
      // The fake-bin tab-record drops the empty positional; the pure args test
      // proves the ["find", "", ...] bridging. Here: spawned, find mode, scope threaded.
      const argv = lastArgv()
      expect(argv[0]).toBe("find")
      expect(argv[argv.indexOf("--max-files") + 1]).toBe("10")
      expect(argv[argv.indexOf("--glob") + 1]).toBe("*.ts")
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("outline: execute resolves file against a directory-valued path root", async () => {
    const { ctx, asks } = makeCtx()
    try {
      fs.mkdirSync(path.join(ctx.directory, "src"), { recursive: true })
      fs.writeFileSync(path.join(ctx.directory, "src", "mod.ts"), "export function alpha() {}\n")
      fs.writeFileSync(harness.record, "")
      const res = asResult(
        await tools.agentgrep.execute({ mode: "outline", file: "mod.ts", path: "src" }, ctx),
      )
      expect(res.output).toContain("STRUCTURE: alpha")
      expect(res.metadata.ok).toBe(true)

      const argv = lastArgv()
      expect(argv[0]).toBe("outline")
      // `file` resolved against the directory-valued `path`; --path is that
      // canonical path root.
      expect(argv[1]).toBe(path.join(fs.realpathSync(ctx.directory), "src", "mod.ts"))
      const pathIdx = argv.indexOf("--path")
      expect(argv[pathIdx + 1]).toBe(path.join(fs.realpathSync(ctx.directory), "src"))

      const ask = asks.find((a) => a.permission === "agentgrep")
      expect(ask!.patterns).toEqual(["mod.ts"])
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("outline: file-valued path is the exact outline target (jcode semantics)", async () => {
    const { ctx } = makeCtx()
    try {
      fs.mkdirSync(path.join(ctx.directory, "src"), { recursive: true })
      fs.writeFileSync(path.join(ctx.directory, "src", "mod.ts"), "export function alpha() {}\n")
      fs.writeFileSync(harness.record, "")
      const res = asResult(
        await tools.agentgrep.execute({ mode: "outline", path: "src/mod.ts" }, ctx),
      )
      expect(res.metadata.ok).toBe(true)
      const argv = lastArgv()
      expect(argv[1]).toBe(path.join(fs.realpathSync(ctx.directory), "src", "mod.ts"))
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("file_grep alias executes with grep semantics", async () => {
    const { ctx } = makeCtx()
    try {
      fs.writeFileSync(harness.record, "")
      const res = asResult(await tools.file_grep.execute({ query: "x" }, ctx))
      expect(res.metadata.ok).toBe(true)
      expect(lastArgv()[0]).toBe("grep")
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("invalid arguments become a friendly result (no spawn)", async () => {
    const { ctx } = makeCtx()
    try {
      fs.writeFileSync(harness.record, "")
      const res = asResult(await tools.agentgrep.execute({ mode: "grep" }, ctx))
      expect(res.metadata.ok).toBe(false)
      expect(res.output).toContain("invalid arguments")
      expect(readRecord(harness.record)).toEqual([])
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("missing executable returns actionable result (no spawn)", async () => {
    const { ctx } = makeCtx()
    const prev = process.env.AGENTGREP_BIN
    const savedPath = process.env.PATH
    try {
      process.env.AGENTGREP_BIN = "/nonexistent/agentgrep-bin"
      process.env.PATH = "/nonexistent-agentgrep-path"
      fs.writeFileSync(harness.record, "")
      const res = asResult(await tools.agentgrep.execute({ mode: "grep", query: "x" }, ctx))
      expect(res.metadata.ok).toBe(false)
      expect(res.output).toContain("executable unavailable")
      expect(readRecord(harness.record)).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.AGENTGREP_BIN
      else process.env.AGENTGREP_BIN = prev
      process.env.PATH = savedPath
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })
})

// ── Permission & path semantics (OpenCode-native) ────────────────────────────

describe("permission & path semantics", () => {
  const tools = buildAgentGrepTools()
  const savedBin = process.env.AGENTGREP_BIN
  const savedRecord = process.env.AG_RECORD

  beforeAll(() => {
    process.env.AGENTGREP_BIN = harness.bin
    process.env.AG_RECORD = harness.record
  })
  afterAll(() => {
    if (savedBin === undefined) delete process.env.AGENTGREP_BIN
    else process.env.AGENTGREP_BIN = savedBin
    if (savedRecord === undefined) delete process.env.AG_RECORD
    else process.env.AG_RECORD = savedRecord
  })

  function projectFixture(): { base: string; proj: string; outside: string } {
    // realpath the base so every canonicalized expectation is stable even when
    // the system temp dir is reached through a symlink (e.g. /tmp on macOS).
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ag-perm-")))
    const proj = path.join(base, "proj")
    const outside = path.join(base, "outside")
    fs.mkdirSync(proj)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, "x.ts"), "// outside\n")
    return { base, proj, outside }
  }

  test("in-project relative path: no external_directory ask", async () => {
    const { base, proj } = projectFixture()
    try {
      const { ctx, asks } = makeCtx({ directory: proj, worktree: proj })
      fs.writeFileSync(harness.record, "")
      const res = asResult(await tools.agentgrep.execute({ mode: "grep", query: "x", path: "." }, ctx))
      expect(res.metadata.ok).toBe(true)
      expect(asks.some((a) => a.permission === "external_directory")).toBe(false)
      expect(asks.some((a) => a.permission === "agentgrep")).toBe(true)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("external relative path: external_directory ask with native glob + metadata", async () => {
    const { base, proj, outside } = projectFixture()
    try {
      const { ctx, asks } = makeCtx({ directory: proj, worktree: proj })
      fs.writeFileSync(harness.record, "")
      const res = asResult(await tools.agentgrep.execute({ mode: "grep", query: "x", path: "../outside" }, ctx))
      // permission granted → the (fake) CLI still runs
      expect(res.metadata.ok).toBe(true)

      const ext = asks.find((a) => a.permission === "external_directory")
      expect(ext).toBeTruthy()
      expect(ext!.patterns).toEqual([path.join(outside, "*")])
      expect(ext!.always).toEqual([path.join(outside, "*")])
      expect(ext!.metadata.filepath).toBe(outside)
      expect(ext!.metadata.parentDir).toBe(outside)

      const argv = readRecord(harness.record).pop()!
      expect(argv[argv.indexOf("--path") + 1]).toBe(outside)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("denied agentgrep permission: rejection propagates and prevents spawn", async () => {
    const { base, proj } = projectFixture()
    try {
      const { ctx } = makeCtx({
        directory: proj,
        worktree: proj,
        ask: async (req: any) => {
          if (req.permission === "agentgrep") throw new Error("PermissionDeniedError")
        },
      })
      fs.writeFileSync(harness.record, "")
      await expect(tools.agentgrep.execute({ mode: "grep", query: "x", path: "." }, ctx)).rejects.toThrow(
        /PermissionDeniedError/,
      )
      expect(readRecord(harness.record)).toEqual([])
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("denied external_directory permission: rejection propagates before spawn", async () => {
    const { base, proj } = projectFixture()
    try {
      const { ctx } = makeCtx({
        directory: proj,
        worktree: proj,
        ask: async (req: any) => {
          if (req.permission === "external_directory") throw new Error("PermissionRejectedError")
        },
      })
      fs.writeFileSync(harness.record, "")
      await expect(tools.agentgrep.execute({ mode: "grep", query: "x", path: "../outside" }, ctx)).rejects.toThrow(
        /PermissionRejectedError/,
      )
      expect(readRecord(harness.record)).toEqual([])
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("traversal that stays inside the project boundary: no external ask", async () => {
    const { base, proj } = projectFixture()
    try {
      const nested = path.join(proj, "a", "b")
      fs.mkdirSync(nested, { recursive: true })
      const { ctx, asks } = makeCtx({ directory: proj, worktree: proj })
      fs.writeFileSync(harness.record, "")
      const res = asResult(await tools.agentgrep.execute({ mode: "grep", query: "x", path: "a/../a/b" }, ctx))
      expect(res.metadata.ok).toBe(true)
      expect(asks.some((a) => a.permission === "external_directory")).toBe(false)
      const argv = readRecord(harness.record).pop()!
      expect(argv[argv.indexOf("--path") + 1]).toBe(path.join(proj, "a", "b"))
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("symlink inside project pointing outside: canonicalized → external ask", async () => {
    const { base, proj, outside } = projectFixture()
    try {
      fs.symlinkSync(outside, path.join(proj, "link"), "dir")
      const { ctx, asks } = makeCtx({ directory: proj, worktree: proj })
      fs.writeFileSync(harness.record, "")
      const res = asResult(await tools.agentgrep.execute({ mode: "grep", query: "x", path: "link" }, ctx))
      expect(res.metadata.ok).toBe(true)
      const ext = asks.find((a) => a.permission === "external_directory")
      expect(ext).toBeTruthy()
      // realpath resolves the symlink to the outside directory
      expect(ext!.metadata.filepath).toBe(fs.realpathSync(outside))
      expect(ext!.metadata.parentDir).toBe(fs.realpathSync(outside))
      const argv = readRecord(harness.record).pop()!
      expect(argv[argv.indexOf("--path") + 1]).toBe(fs.realpathSync(outside))
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("nonexistent leaf outside project: canonicalized via nearest existing ancestor", async () => {
    const { base, proj, outside } = projectFixture()
    try {
      const { ctx, asks } = makeCtx({ directory: proj, worktree: proj })
      fs.writeFileSync(harness.record, "")
      const res = asResult(await tools.agentgrep.execute({ mode: "grep", query: "x", path: "../outside/missing" }, ctx))
      expect(res.metadata.ok).toBe(true)
      const ext = asks.find((a) => a.permission === "external_directory")
      expect(ext).toBeTruthy()
      expect(ext!.metadata.filepath).toBe(path.join(outside, "missing"))
      expect(ext!.metadata.parentDir).toBe(outside)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("outline file outside project triggers exactly ONE external ask for shared parent", async () => {
    const { base, proj, outside } = projectFixture()
    try {
      fs.writeFileSync(path.join(outside, "mod.ts"), "export function alpha() {}\n")
      const { ctx, asks } = makeCtx({ directory: proj, worktree: proj })
      fs.writeFileSync(harness.record, "")
      // path root AND outline file both resolve into `outside` — one ask, not two.
      const res = asResult(
        await tools.agentgrep.execute({ mode: "outline", file: "../outside/mod.ts", path: "../outside" }, ctx),
      )
      expect(res.metadata.ok).toBe(true)
      const exts = asks.filter((a) => a.permission === "external_directory")
      expect(exts.length).toBe(1)
      expect(exts[0].metadata.parentDir).toBe(outside)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("worktree containment: path inside worktree but outside directory needs no external ask", async () => {
    const { base, proj } = projectFixture()
    try {
      const wt = path.join(base, "wt")
      fs.mkdirSync(wt)
      fs.writeFileSync(path.join(wt, "x.ts"), "// wt\n")
      const { ctx, asks } = makeCtx({ directory: proj, worktree: wt })
      fs.writeFileSync(harness.record, "")
      const res = asResult(await tools.agentgrep.execute({ mode: "grep", query: "x", path: "../wt" }, ctx))
      expect(res.metadata.ok).toBe(true)
      expect(asks.some((a) => a.permission === "external_directory")).toBe(false)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("pure helpers: isInsideProject + canonicalizePath match native semantics", () => {
    const { base, proj, outside } = projectFixture()
    try {
      const bounds = { directory: proj, worktree: proj }
      expect(isInsideProject(path.join(proj, "src", "a.ts"), bounds)).toBe(true)
      expect(isInsideProject(proj, bounds)).toBe(true)
      expect(isInsideProject(outside, bounds)).toBe(false)
      // "/" worktree matches nothing outside the directory
      expect(isInsideProject(outside, { directory: proj, worktree: "/" })).toBe(false)
      expect(canonicalizePath(path.join(proj, "src", "nope.ts"))).toBe(path.join(proj, "src", "nope.ts"))
      // nonexistent leaf canonicalizes via nearest existing ancestor
      expect(canonicalizePath(path.join(base, "missing", "x"))).toBe(path.join(base, "missing", "x"))
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("resolveModelRoots: outline file resolves against a directory-valued path root", () => {
    const { base, proj } = projectFixture()
    try {
      const roots = resolveModelRoots({ mode: "outline", file: "mod.ts", path: "src" }, "outline", proj)
      expect(roots.path!.full).toBe(path.join(proj, "src"))
      expect(roots.path!.kind).toBe("directory")
      expect(roots.outline!.full).toBe(path.join(proj, "src", "mod.ts"))
      expect(roots.outline!.kind).toBe("file")

      const onlyPath = resolveModelRoots({ mode: "grep", query: "x" }, "grep", proj)
      expect(onlyPath.path!.full).toBe(proj)
      expect(onlyPath.outline).toBeUndefined()
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("resolveModelRoots: file-valued path is classified as an exact-file root", () => {
    const { base, proj } = projectFixture()
    try {
      fs.mkdirSync(path.join(proj, "src"))
      fs.writeFileSync(path.join(proj, "src", "a.ts"), "// a\n")
      const roots = resolveModelRoots({ mode: "grep", path: "src/a.ts" }, "grep", proj)
      expect(roots.path!.full).toBe(path.join(proj, "src", "a.ts"))
      expect(roots.path!.kind).toBe("file")
      expect(roots.path!.dir).toBe(path.join(proj, "src"))

      // outline with a file-valued path: the file IS the outline target
      const oroots = resolveModelRoots({ mode: "outline", path: "src/a.ts" }, "outline", proj)
      expect(oroots.outline!.full).toBe(path.join(proj, "src", "a.ts"))
      expect(oroots.outline!.kind).toBe("file")
      expect(oroots.path).toBeUndefined()
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("askExternalDirectoryIfNeeded: coalesces duplicate parent dirs", async () => {
    const { base, proj, outside } = projectFixture()
    try {
      const asks: AskRecord[] = []
      const ctx: ToolContext = {
        sessionID: "s",
        messageID: "m",
        agent: "a",
        directory: proj,
        worktree: proj,
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async (req: any) => {
          asks.push({ ...req })
        },
      }
      await askExternalDirectoryIfNeeded(ctx, {
        path: { full: outside, kind: "directory", dir: outside },
        outline: { full: path.join(outside, "m.ts"), kind: "file", dir: outside },
      })
      expect(asks.length).toBe(1)
      expect(asks[0].permission).toBe("external_directory")
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

// ── Bounded execution (agentgrep-exec) ───────────────────────────────────────

describe("bounded execution (agentgrep-exec)", () => {
  test("default bounds constants are exported", () => {
    expect(AGENTGREP_DEFAULT_TIMEOUT_MS).toBe(30_000)
    expect(AGENTGREP_DEFAULT_MAX_OUTPUT_CHARS).toBe(200_000)
  })

  test("timeout kills the child (runAgentGrep with explicit timeoutMs)", async () => {
    const res = await runAgentGrep(["grep", "x"], { bin: harness.sleepBin, timeoutMs: 150 })
    expect(res.timedOut).toBe(true)
    expect(res.exit).not.toBe(0)
  })

  test("AGENTGREP_TIMEOUT_MS env default is honored", async () => {
    const prev = process.env.AGENTGREP_TIMEOUT_MS
    process.env.AGENTGREP_TIMEOUT_MS = "150"
    try {
      const res = await runAgentGrep(["grep", "x"], { bin: harness.sleepBin })
      expect(res.timedOut).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.AGENTGREP_TIMEOUT_MS
      else process.env.AGENTGREP_TIMEOUT_MS = prev
    }
  })

  test("pre-aborted signal never spawns", async () => {
    const ctl = new AbortController()
    ctl.abort()
    const saved = process.env.AGENTGREP_BIN
    process.env.AGENTGREP_BIN = harness.bin
    try {
      const res = await runAgentGrep(["grep", "x"], { signal: ctl.signal })
      expect(res.aborted).toBe(true)
      expect(res.exit).toBe(-1)
    } finally {
      if (saved === undefined) delete process.env.AGENTGREP_BIN
      else process.env.AGENTGREP_BIN = saved
    }
  })

  test("mid-run abort kills the child", async () => {
    const ctl = new AbortController()
    const p = runAgentGrep(["grep", "x"], { bin: harness.sleepBin, signal: ctl.signal })
    setTimeout(() => ctl.abort(), 150)
    const res = await p
    expect(res.aborted).toBe(true)
  })

  test("output cap truncates stdout and kills the child", async () => {
    const res = await runAgentGrep(["grep", "x"], { bin: harness.bigBin, maxOutputChars: 200 })
    expect(res.truncated).toBe(true)
    expect(res.boundKilled).toBe("stdout")
    expect(res.stdout.length).toBeLessThanOrEqual(200)
  })

  test("large output without a cap setting still obeys the default cap", async () => {
    const res = await runAgentGrep(["grep", "x"], { bin: harness.bigBin })
    expect(res.truncated).toBe(true)
    expect(res.stdout.length).toBeLessThanOrEqual(AGENTGREP_DEFAULT_MAX_OUTPUT_CHARS)
  })
})

// ── Real CLI smoke (skipped when no binary; uses the real agentgrep v0.1.6) ──

const smokeBin = tryResolveAgentGrepBin()
const smoke = smokeBin ? describe : describe.skip
const smokeLabel = smokeBin
  ? `agentgrep CLI smoke (bin: ${smokeBin})`
  : `agentgrep CLI smoke (SKIPPED: no agentgrep binary — set AGENTGREP_BIN or run scripts/install-agentgrep.sh)`

smoke(smokeLabel, () => {
  test("grep finds an exact term in a temp fixture", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-smoke-grep-"))
    try {
      fs.writeFileSync(path.join(dir, "a.ts"), "export function auth_status() {}\n// nothing here\n")
      fs.writeFileSync(path.join(dir, "b.md"), "plain doc\n")
      const argv = buildAgentGrepArgs({ mode: "grep", query: "auth_status", path: dir })
      const res = await runAgentGrep(argv, { bin: smokeBin!, cwd: dir })
      expect(res.exit).toBe(0)
      expect(res.stdout).toContain("a.ts")
      expect(res.stdout).not.toContain("b.md")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("grep with a file-valued path searches ONLY that file (sibling isolation)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-smoke-file-"))
    try {
      const a = path.join(dir, "a.ts")
      const b = path.join(dir, "b.ts")
      fs.writeFileSync(a, "export function auth_status() {}\n")
      fs.writeFileSync(b, "export function auth_status() {}\n")
      const scope = exactFileScope(a, "file")
      const argv = buildAgentGrepArgs({ mode: "grep", query: "auth_status", path: a, __fileScope: scope! })
      const res = await runAgentGrep(argv, { bin: smokeBin!, cwd: dir })
      expect(res.exit).toBe(0)
      expect(res.stdout).toContain("a.ts")
      expect(res.stdout).not.toContain("b.ts")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("grep match-all glob forms are normalized → unfiltered, never false-empty", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-smoke-glob-"))
    try {
      fs.writeFileSync(path.join(dir, "a.ts"), "export function auth_status() {}\n")
      fs.writeFileSync(path.join(dir, "b.ts"), "export function auth_status() {}\n")
      // "./*" is a false-empty glob in agentgrep v0.1.6 — normalization must drop it.
      const argv = buildAgentGrepArgs({ mode: "grep", query: "auth_status", glob: "./*", path: dir })
      const res = await runAgentGrep(argv, { bin: smokeBin!, cwd: dir })
      expect(res.exit).toBe(0)
      expect(res.stdout).toContain("a.ts")
      expect(res.stdout).toContain("b.ts")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("find discovers the fixture file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-smoke-find-"))
    try {
      fs.writeFileSync(path.join(dir, "session-store.ts"), "// session persistence\n")
      const argv = buildAgentGrepArgs({ mode: "find", terms: ["session"], path: dir })
      const res = await runAgentGrep(argv, { bin: smokeBin!, cwd: dir })
      expect(res.exit).toBe(0)
      expect(res.stdout).toContain("session-store.ts")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("find glob-only (empty query positional) lists scope-filtered files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-smoke-findglob-"))
    try {
      fs.writeFileSync(path.join(dir, "a.ts"), "// a\n")
      fs.writeFileSync(path.join(dir, "b.md"), "// b\n")
      const argv = buildAgentGrepArgs({ mode: "find", glob: "*.ts", path: dir })
      const res = await runAgentGrep(argv, { bin: smokeBin!, cwd: dir })
      expect(res.exit).toBe(0)
      expect(res.stdout).toContain("a.ts")
      expect(res.stdout).not.toContain("b.md")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("find in an empty scope returns correct empty output (exit 0, top files: 0)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-smoke-empty-"))
    try {
      const argv = buildAgentGrepArgs({ mode: "find", query: "session", path: dir })
      const res = await runAgentGrep(argv, { bin: smokeBin!, cwd: dir })
      expect(res.exit).toBe(0)
      expect(res.stdout).toContain("top files: 0")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("outline lists structure items of a fixture file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-smoke-outline-"))
    try {
      fs.writeFileSync(
        path.join(dir, "mod.ts"),
        "export function alpha() {}\nexport function beta() {}\nexport const value = 1\n",
      )
      const argv = buildAgentGrepArgs({ mode: "outline", file: "mod.ts", path: dir })
      const res = await runAgentGrep(argv, { bin: smokeBin!, cwd: dir })
      expect(res.exit).toBe(0)
      expect(res.stdout.length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
