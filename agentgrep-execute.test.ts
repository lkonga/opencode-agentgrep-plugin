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
  compactGrepRegions,
  GREP_DEFAULT_MAX_REGIONS,
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

  test("find mode: execute splits multiword terms, threads glob + canonical path", async () => {
    const { ctx, asks } = makeCtx()
    try {
      fs.mkdirSync(path.join(ctx.directory, "src"), { recursive: true })
      fs.writeFileSync(harness.record, "")
      const res = asResult(
        await tools.agentgrep.execute({ mode: "find", query: "session store", glob: "*.ts", path: "src" }, ctx),
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

  test("find mode: scoped-only call (no terms) spawns with empty query positional, no throw", async () => {
    const { ctx } = makeCtx()
    try {
      fs.writeFileSync(harness.record, "")
      const res = asResult(await tools.agentgrep.execute({ mode: "find", glob: "*.ts" }, ctx))
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

  test("explicit compatibility aliases (opt-in registry) execute with canonical mode semantics", async () => {
    const optInTools = buildAgentGrepTools(undefined, {
      replaceNativeSearch: true,
      compatibilityAliases: ["find", "file_grep", "Grep"],
    })
    const { ctx } = makeCtx()
    try {
      // find alias → find subcommand (purpose-built forced-find ToolDefinition)
      fs.writeFileSync(harness.record, "")
      const findRes = asResult(await optInTools.find.execute({ query: "session" }, ctx))
      expect(findRes.metadata.ok).toBe(true)
      expect(findRes.metadata.mode).toBe("find")
      expect(lastArgv()[0]).toBe("find")

      // find alias FORCES find mode even when the model passes a conflicting mode
      fs.writeFileSync(harness.record, "")
      const forcedFindRes = asResult(
        await optInTools.find.execute({ mode: "grep", query: "session" }, ctx),
      )
      expect(forcedFindRes.metadata.ok).toBe(true)
      expect(forcedFindRes.metadata.mode).toBe("find")
      expect(lastArgv()[0]).toBe("find")

      // file_grep alias → grep subcommand (mode defaults to grep)
      fs.writeFileSync(harness.record, "")
      const fgRes = asResult(await optInTools.file_grep.execute({ query: "x" }, ctx))
      expect(fgRes.metadata.ok).toBe(true)
      expect(lastArgv()[0]).toBe("grep")

      // Grep alias → grep subcommand
      fs.writeFileSync(harness.record, "")
      const gRes = asResult(await optInTools.Grep.execute({ query: "x" }, ctx))
      expect(gRes.metadata.ok).toBe(true)
      expect(lastArgv()[0]).toBe("grep")

      // find-only opt-in: ONLY find is added, no other aliases
      const findOnly = buildAgentGrepTools(undefined, {
        replaceNativeSearch: true,
        compatibilityAliases: ["find"],
      })
      expect(Object.keys(findOnly)).toEqual(["agentgrep", "find"])
      fs.writeFileSync(harness.record, "")
      const foRes = asResult(await findOnly.find.execute({ query: "session" }, ctx))
      expect(foRes.metadata.mode).toBe("find")
      expect(lastArgv()[0]).toBe("find")
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

// ── Security remediation (host-integrated execute tests) ─────────────────────
// Malicious model-supplied internal keys (__fileScope / __contextJson), public
// `type` normalization, and leading-dash injection are exercised THROUGH
// ToolDefinition.execute so argv, permission asks, and spawn behavior are all
// proven end-to-end.

describe("security remediation (execute-level)", () => {
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

  test("malicious __fileScope cannot redirect argv outside canonical path processing", async () => {
    const { ctx, asks } = makeCtx()
    try {
      fs.mkdirSync(path.join(ctx.directory, "src"), { recursive: true })
      fs.writeFileSync(path.join(ctx.directory, "src", "a.ts"), "// a\n")
      fs.writeFileSync(harness.record, "")
      // Model smuggles an internal __fileScope pointing at an arbitrary root.
      const res = asResult(
        await tools.agentgrep.execute(
          {
            mode: "grep",
            query: "auth",
            path: "src/a.ts",
            __fileScope: { root: "/etc", glob: "passwd" },
          },
          ctx,
        ),
      )
      expect(res.metadata.ok).toBe(true)

      const argv = lastArgv()
      // The canonical scope for src/a.ts (parent + escaped basename) wins.
      const pathIdx = argv.indexOf("--path")
      expect(pathIdx).toBeGreaterThan(-1)
      expect(argv[pathIdx + 1]).toBe(path.join(fs.realpathSync(ctx.directory), "src"))
      expect(argv[argv.indexOf("--glob") + 1]).toBe("a.ts")
      // The smuggled /etc scope never reaches argv.
      expect(argv.join(" ")).not.toContain("/etc")
      expect(argv.join(" ")).not.toContain("passwd")

      // Permission asks were computed from the canonical in-project root.
      expect(asks.some((a) => a.permission === "external_directory")).toBe(false)
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("malicious __fileScope cannot expose files outside ctx.directory (external file read)", async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ag-sec-escope-")))
    const proj = path.join(base, "proj")
    const outside = path.join(base, "outside")
    fs.mkdirSync(proj)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, "secrets.ts"), "PRIVATE=1\n")
    try {
      const { ctx } = makeCtx({ directory: proj, worktree: proj })
      fs.writeFileSync(harness.record, "")
      const res = asResult(
        await tools.agentgrep.execute(
          {
            mode: "grep",
            query: "auth",
            path: ".",
            __fileScope: { root: outside, glob: "secrets.ts" },
          },
          ctx,
        ),
      )
      expect(res.metadata.ok).toBe(true)
      const argv = lastArgv()
      const pathIdx = argv.indexOf("--path")
      // argv --path is the canonical in-project root, NOT the smuggled outside dir.
      expect(argv[pathIdx + 1]).toBe(fs.realpathSync(proj))
      expect(argv.join(" ")).not.toContain(fs.realpathSync(outside))
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("malicious __contextJson is discarded and never reaches argv", async () => {
    const { ctx } = makeCtx()
    try {
      fs.mkdirSync(path.join(ctx.directory, "src"), { recursive: true })
      fs.writeFileSync(path.join(ctx.directory, "src", "mod.ts"), "export function alpha() {}\n")
      fs.writeFileSync(harness.record, "")
      // A real trace execution WOULD add --context-json (internal temp file);
      // the model-supplied path must never appear.
      const res = asResult(
        await tools.agentgrep.execute(
          { mode: "trace", terms: ["subject:alpha"], __contextJson: "/etc/passwd" },
          ctx,
        ),
      )
      expect(res.metadata.ok).toBe(true)
      const argv = lastArgv()
      const cjIdx = argv.indexOf("--context-json")
      // Either the trusted harness temp context (created in ctx tmp) or none —
      // NEVER /etc/passwd.
      if (cjIdx > -1) {
        expect(argv[cjIdx + 1]).not.toBe("/etc/passwd")
        expect(argv[cjIdx + 1]).not.toContain("etc")
      }
      expect(argv.join(" ")).not.toContain("/etc/passwd")
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("unknown model keys are discarded (never reach argv or affects), public type is normalized", async () => {
    const { ctx } = makeCtx()
    try {
      fs.writeFileSync(harness.record, "")
      const res = asResult(
        await tools.agentgrep.execute(
          { mode: "grep", query: "auth", type: "rs", bogusInternal: "x", hidden: true },
          ctx,
        ),
      )
      expect(res.metadata.ok).toBe(true)
      const argv = lastArgv()
      expect(argv[argv.indexOf("--type") + 1]).toBe("rs")
      expect(argv.join(" ")).not.toContain("bogusInternal")
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("leading-dash query is argv-safe via `--` (no spawn of altered command)", async () => {
    const { ctx, asks } = makeCtx()
    try {
      fs.writeFileSync(harness.record, "")
      const res = asResult(
        await tools.agentgrep.execute({ mode: "grep", query: "--regex", path: "." }, ctx),
      )
      expect(res.metadata.ok).toBe(true)
      const argv = lastArgv()
      // Query stayed a positional after `--`; it did not become a flag.
      const dashIdx = argv.indexOf("--")
      expect(dashIdx).toBeGreaterThan(-1)
      expect(argv[argv.length - 1]).toBe("--regex")
      // The permission pattern reflects the literal query.
      const ask = asks.find((a) => a.permission === "agentgrep")
      expect(ask!.patterns).toEqual(["--regex"])
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("leading-dash type value produces a friendly no-spawn result", async () => {
    const { ctx } = makeCtx()
    try {
      fs.writeFileSync(harness.record, "")
      const res = asResult(await tools.agentgrep.execute({ mode: "grep", query: "auth", type: "-rs" }, ctx))
      expect(res.metadata.ok).toBe(false)
      expect(res.output).toContain("invalid arguments")
      expect(readRecord(harness.record)).toEqual([])
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("leading-dash glob value produces a friendly no-spawn result", async () => {
    const { ctx } = makeCtx()
    try {
      fs.writeFileSync(harness.record, "")
      const res = asResult(await tools.agentgrep.execute({ mode: "grep", query: "auth", glob: "--evil" }, ctx))
      expect(res.metadata.ok).toBe(false)
      expect(res.output).toContain("invalid arguments")
      expect(readRecord(harness.record)).toEqual([])
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("exact-file path with glob metachars in the filename stays contained (escaped scope)", async () => {
    const { ctx } = makeCtx()
    try {
      fs.mkdirSync(path.join(ctx.directory, "src"), { recursive: true })
      // Adversarial siblings: a1.ts could match a raw `a*.ts` glob.
      fs.writeFileSync(path.join(ctx.directory, "src", "a*.ts"), "export function auth_status() {}\n")
      fs.writeFileSync(path.join(ctx.directory, "src", "a1.ts"), "export function auth_status() {}\n")
      fs.writeFileSync(harness.record, "")
      const res = asResult(
        await tools.agentgrep.execute({ mode: "grep", query: "auth_status", path: "src/a*.ts" }, ctx),
      )
      expect(res.metadata.ok).toBe(true)
      const argv = lastArgv()
      const pathIdx = argv.indexOf("--path")
      expect(argv[pathIdx + 1]).toBe(path.join(fs.realpathSync(ctx.directory), "src"))
      // Basename is glob-escaped: only the literal `a*.ts` can match.
      expect(argv[argv.indexOf("--glob") + 1]).toBe("a\\*.ts")
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  // ── Reserved internal keys are inert through execute (blocker follow-up) ──
  // Prove every reserved/internal key passed by the model is discarded before
  // any permission ask, metadata, or provider/context work, and can never
  // alter argv, asks, or external access.

  test("raw mode \"smart\" is rejected through execute (no-spawn friendly result, before any ask)", async () => {
    const { ctx, asks } = makeCtx()
    try {
      fs.writeFileSync(harness.record, "")
      const res = asResult(await tools.agentgrep.execute({ mode: "smart", query: "x" }, ctx))
      expect(res.metadata.ok).toBe(false)
      expect(res.output).toMatch(/internal alias|smart.*invalid|invalid arguments/i)
      // No spawn (fake bin never ran) AND no permission ask was issued: the
      // closed public-only input is built before any permission/metadata work.
      expect(readRecord(harness.record)).toEqual([])
      expect(asks).toHaveLength(0)
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("every reserved internal key is inert through execute (argv, asks, metadata unaffected)", async () => {
    const { ctx, asks } = makeCtx()
    try {
      fs.writeFileSync(harness.record, "")

      // Pass EVERY reserved/internal key alongside a valid public-only call.
      // None should reach argv, permission asks, or metadata.
      const res = asResult(
        await tools.agentgrep.execute(
          {
            mode: "grep",
            query: "auth",
            path: "src",
            // Reserved/internal keys — all must be discarded:
            pattern: "internal-pattern-should-not-appear",
            file_path: "internal-file-path-should-not-appear",
            include: "*.internal-include-should-not-appear",
            file_type: "internal-file-type-should-not-appear",
            max_items: 999,
            hidden: true,
            no_ignore: true,
            full_region: "always",
            debug_plan: true,
            debug_score: true,
            __fileScope: { root: "/etc", glob: "passwd" },
            __contextJson: "/etc/passwd",
            unknownKey: "must-be-dropped",
          },
          ctx,
        ),
      )
      expect(res.metadata.ok).toBe(true)

      const argv = lastArgv()
      // The argv must contain ONLY the public-mode subcommand + public query + public --path.
      // No --type, --hidden, --no-ignore, --glob with internal patterns, etc.
      expect(argv[0]).toBe("grep")
      expect(argv[1]).toBe("auth")
      expect(argv[argv.indexOf("--path") + 1]).toContain("src")
      // Forbidden flags/proofs:
      expect(argv).not.toContain("--type")
      expect(argv).not.toContain("--hidden")
      expect(argv).not.toContain("--no-ignore")
      expect(argv).not.toContain("--glob")
      expect(argv).not.toContain("--max-items")
      expect(argv).not.toContain("--full-region")
      expect(argv).not.toContain("--debug-plan")
      expect(argv).not.toContain("--debug-score")
      // The smuggled __fileScope/__contextJson must never reach argv.
      expect(argv.join(" ")).not.toContain("/etc")
      expect(argv.join(" ")).not.toContain("passwd")
      expect(argv.join(" ")).not.toContain("internal")
      expect(argv.join(" ")).not.toContain("unknownKey")

      // Permission ask metadata must NOT include the internal keys.
      const ask = asks.find((a) => a.permission === "agentgrep")
      expect(ask!.metadata.include).toBeUndefined() // no include smuggled
      // The ask patterns must be the public query, not the internal pattern.
      expect(ask!.patterns).toEqual(["auth"])

      // No external_directory ask was triggered (the smuggled __fileScope
      // pointing at /etc must not have been used for root resolution).
      expect(asks.some((a) => a.permission === "external_directory")).toBe(false)
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("reserved alias file_path cannot substitute for public file (outline mode)", async () => {
    const { ctx } = makeCtx()
    try {
      fs.writeFileSync(harness.record, "")
      // file_path alone (no public file) → no outline file → invalid arguments.
      const res = asResult(await tools.agentgrep.execute({ mode: "outline", file_path: "a.ts" }, ctx))
      expect(res.metadata.ok).toBe(false)
      expect(res.output).toContain("invalid arguments")
      expect(readRecord(harness.record)).toEqual([])
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("reserved alias pattern cannot substitute for public query (grep mode)", async () => {
    const { ctx } = makeCtx()
    try {
      fs.writeFileSync(harness.record, "")
      // pattern alone (no public query) → no query → invalid arguments.
      const res = asResult(await tools.agentgrep.execute({ mode: "grep", pattern: "auth" }, ctx))
      expect(res.metadata.ok).toBe(false)
      expect(res.output).toContain("invalid arguments")
      expect(readRecord(harness.record)).toEqual([])
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("reserved alias include cannot substitute for public glob (find scoped-only)", async () => {
    const { ctx, asks } = makeCtx()
    try {
      fs.writeFileSync(harness.record, "")
      // include alone (no public glob, no terms): the include key is INERT.
      // Execute threads the canonical project path, so the find runs as an
      // UNFILTERED project-wide find — it must NOT receive a --glob from
      // include, and the ask metadata must not carry the include value.
      const res = asResult(await tools.agentgrep.execute({ mode: "find", include: "*.ts" }, ctx))
      expect(res.metadata.ok).toBe(true)
      const argv = lastArgv()
      expect(argv[0]).toBe("find")
      expect(argv).not.toContain("--glob")
      expect(argv.join(" ")).not.toContain("*.ts")
      const ask = asks.find((a) => a.permission === "agentgrep")
      expect(ask!.metadata.include).toBeUndefined()
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("reserved alias file_type cannot produce --type argv (model must use public type)", async () => {
    const { ctx } = makeCtx()
    try {
      fs.writeFileSync(harness.record, "")
      const res = asResult(
        await tools.agentgrep.execute({ mode: "grep", query: "auth", file_type: "rs" }, ctx),
      )
      expect(res.metadata.ok).toBe(true)
      const argv = lastArgv()
      expect(argv).not.toContain("--type")
      expect(argv.join(" ")).not.toContain("rs")
    } finally {
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

  test("exact-file scope with glob metacharacters contains to the literal file (adversarial siblings)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-smoke-globesc-"))
    try {
      // `a*.ts` is a literal filename; `a1.ts` is an adversarial sibling that a
      // RAW `a*.ts` glob would also match. Both contain the same hit so an
      // uncontained search would report 2 files.
      const target = path.join(dir, "a*.ts")
      const sibling = path.join(dir, "a1.ts")
      fs.writeFileSync(target, "export function auth_status() {}\n")
      fs.writeFileSync(sibling, "export function auth_status() {}\n")
      const scope = exactFileScope(target, "file")
      const argv = buildAgentGrepArgs({ mode: "grep", query: "auth_status", path: target, __fileScope: scope! })
      expect(scope!.glob).toBe("a\\*.ts")
      const res = await runAgentGrep(argv, { bin: smokeBin!, cwd: dir })
      expect(res.exit).toBe(0)
      expect(res.stdout).toContain("a*.ts")
      expect(res.stdout).not.toContain("a1.ts")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("exact-file scope with brackets/braces/backslash contains to the literal file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-smoke-globesc2-"))
    try {
      const names = ["a[1].ts", "a{b}.ts", "a\\b.ts"]
      for (const name of names) {
        fs.writeFileSync(path.join(dir, name), "export function auth_status() {}\n")
      }
      // Adversarial siblings for each pattern.
      fs.writeFileSync(path.join(dir, "a1.ts"), "export function auth_status() {}\n")
      fs.writeFileSync(path.join(dir, "ab.ts"), "export function auth_status() {}\n")
      for (const name of names) {
        const target = path.join(dir, name)
        const scope = exactFileScope(target, "file")
        const argv = buildAgentGrepArgs({ mode: "grep", query: "auth_status", path: target, __fileScope: scope! })
        const res = await runAgentGrep(argv, { bin: smokeBin!, cwd: dir })
        expect(res.exit).toBe(0)
        expect(res.stdout).toContain(name)
      }
      // The adversarial siblings must NOT appear in any single-file scope run.
      const one = exactFileScope(path.join(dir, "a[1].ts"), "file")!
      const argv = buildAgentGrepArgs({ mode: "grep", query: "auth_status", path: path.join(dir, "a[1].ts"), __fileScope: one })
      const res = await runAgentGrep(argv, { bin: smokeBin!, cwd: dir })
      expect(res.stdout).not.toContain("a1.ts")
      expect(res.stdout).not.toContain("ab.ts")
      expect(res.stdout).not.toContain("a{b}.ts")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("leading-dash query stays a literal positional via `--` (no flag reinterpretation)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-smoke-dash-"))
    try {
      fs.writeFileSync(path.join(dir, "a.ts"), "// --regex appears here\n")
      const argv = buildAgentGrepArgs({ mode: "grep", query: "--regex", path: dir })
      expect(argv).toContain("--")
      const res = await runAgentGrep(argv, { bin: smokeBin!, cwd: dir })
      expect(res.exit).toBe(0)
      expect(res.stdout).toContain("a.ts")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("public `type` is normalized and accepted by the real CLI", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-smoke-type-"))
    try {
      fs.writeFileSync(path.join(dir, "a.ts"), "export function auth_status() {}\n")
      fs.writeFileSync(path.join(dir, "b.md"), "export function auth_status() {}\n")
      const argv = buildAgentGrepArgs({ mode: "grep", query: "auth_status", type: "ts", path: dir })
      expect(argv).toContain("--type")
      expect(argv[argv.indexOf("--type") + 1]).toBe("ts")
      const res = await runAgentGrep(argv, { bin: smokeBin!, cwd: dir })
      expect(res.exit).toBe(0)
      expect(res.stdout).toContain("a.ts")
      expect(res.stdout).not.toContain("b.md")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── grep result-level region cap (item 5) ─────────────────────────────────────
// AgentGrep v0.1.6 grep accepts NO --max-regions flag, so the public
// max_regions controls a post-execution result cap (omitted → 200) applied
// ONLY to grep stdout. No buffering/spawn changes: the exec layer already
// captures bounded output; the fake CLI proves the argv has no new flag.

describe("grep result-level region cap (post-exec, no CLI flag)", () => {
  const tools = buildAgentGrepTools()
  const savedBin = process.env.AGENTGREP_BIN
  const savedRecord = process.env.AG_RECORD
  let manyBin = ""
  let record = ""

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-cap-"))
    record = path.join(dir, "record.txt")
    manyBin = writeBin(
      dir,
      "agentgrep-many",
      `
printf '%s\\n' "$(printf '%s\\t' "$@")" >> "\${AG_RECORD:-/dev/null}"
mode="$1"
i=0
while [ $i -lt 500 ]; do
  if [ "$mode" = "grep" ]; then
    printf 'file%d.ts:%d:1: auth region %d\\n' "$i" "$((i % 50 + 1))" "$i"
  else
    echo "file$i.ts"
  fi
  i=$((i + 1))
done
`,
    )
    process.env.AGENTGREP_BIN = manyBin
    process.env.AG_RECORD = record
  })

  afterAll(() => {
    if (savedBin === undefined) delete process.env.AGENTGREP_BIN
    else process.env.AGENTGREP_BIN = savedBin
    if (savedRecord === undefined) delete process.env.AG_RECORD
    else process.env.AG_RECORD = savedRecord
    fs.rmSync(path.dirname(record), { recursive: true, force: true })
  })

  function lastArgv(): string[] {
    const rec = readRecord(record)
    return rec[rec.length - 1] ?? []
  }

  function countRegions(out: string): number {
    return out.split("\n").filter((l) => /^[^:\n]+:\d+:/.test(l)).length
  }

  test("grep with public max_regions caps the RESULT (and never the argv)", async () => {
    const { ctx, asks } = makeCtx()
    try {
      fs.writeFileSync(record, "")
      const res = asResult(await tools.agentgrep.execute({ mode: "grep", query: "auth", max_regions: 3 }, ctx))
      expect(res.metadata.ok).toBe(true)
      expect(res.metadata.regionsCapped).toBe(true)
      expect(res.metadata.regions).toBe(500)
      expect(res.metadata.maxRegions).toBe(3)
      expect(countRegions(res.output)).toBeLessThanOrEqual(3)
      expect(res.output).toContain("results truncated to 3 regions")
      // The CLI must never receive --max-regions (v0.1.6 grep rejects it).
      const argv = lastArgv()
      expect(argv[0]).toBe("grep")
      expect(argv).not.toContain("--max-regions")
      expect(asks.find((a) => a.permission === "agentgrep")).toBeTruthy()
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("grep default cap is 200 when max_regions is omitted", async () => {
    const { ctx } = makeCtx()
    try {
      fs.writeFileSync(record, "")
      const capped = asResult(await tools.agentgrep.execute({ mode: "grep", query: "auth" }, ctx))
      expect(capped.metadata.ok).toBe(true)
      expect(capped.metadata.regionsCapped).toBe(true)
      expect(capped.metadata.maxRegions).toBe(200)
      expect(countRegions(capped.output)).toBeLessThanOrEqual(200)
      expect(capped.output).toContain("max_regions=200")
      const argv = lastArgv()
      expect(argv).not.toContain("--max-regions")
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("later grep with a generous max_regions does not cap (under limit)", async () => {
    const { ctx } = makeCtx()
    try {
      fs.writeFileSync(record, "")
      const res = asResult(await tools.agentgrep.execute({ mode: "grep", query: "auth", max_regions: 1000 }, ctx))
      expect(res.metadata.ok).toBe(true)
      expect(res.metadata.regionsCapped).toBeUndefined()
      expect(countRegions(res.output)).toBe(500)
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("non-grep modes are NEVER compacted (find passthrough with max_regions)", async () => {
    const { ctx } = makeCtx()
    try {
      fs.writeFileSync(record, "")
      const res = asResult(await tools.agentgrep.execute({ mode: "find", query: "auth", max_regions: 3 }, ctx))
      expect(res.metadata.ok).toBe(true)
      expect(res.metadata.regionsCapped).toBeUndefined()
      // All 500 lines pass through untouched — no truncation note, no cap.
      expect(res.output.split("\n").filter(Boolean).length).toBe(500)
      expect(res.output).not.toContain("truncated to")
    } finally {
      fs.rmSync(ctx.directory, { recursive: true, force: true })
    }
  })

  test("pure compactGrepRegions: cap binds only above the limit, headers kept, note truthful", () => {
    const many = Array.from({ length: 300 }, (_, i) => `f${i}.ts:${i + 1}:1: hit`).join("\n")
    const withHeader = `top files: 300\n${many}`
    const capped = compactGrepRegions(withHeader, 5)
    expect(capped.capped).toBe(true)
    expect(capped.regions).toBe(300)
    expect(capped.text).toContain("top files: 300")
    expect(countRegions(capped.text)).toBe(5)
    expect(capped.text).toContain("results truncated to 5 regions")
    // Under the limit → byte-for-byte untouched.
    const small = "a.ts:1:1: x\nb.ts:2:1: y\n"
    expect(compactGrepRegions(small, 200)).toEqual({ text: small, regions: 2, capped: false })
    expect(GREP_DEFAULT_MAX_REGIONS).toBe(200)
  })
})
