// agentgrep-exec — bounded execution of the `agentgrep` CLI for the standalone
// agentgrep plugin (agentgrep-core.ts). Extracted from core so that module stays
// cohesive; this module owns executable resolution and the bounded
// spawn/capture logic, and is fully self-contained (no plugin imports).
//
// Bounded execution: runs are killed after a default 30s timeout
// ($AGENTGREP_TIMEOUT_MS) and output is capped at 200000 chars
// ($AGENTGREP_MAX_OUTPUT_CHARS) — a runaway search is killed on either bound,
// and an already-aborted caller never spawns. Abort is honored throughout:
// ctx.abort and the timeout both abort the child through one internal
// AbortController.
//
// Everything shells out WITHOUT shell interpolation: argv is passed to
// Bun.spawn as an array. No command strings are ever built by concatenation.

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

export const AGENTGREP_DEFAULT_TIMEOUT_MS = 30_000
export const AGENTGREP_DEFAULT_MAX_OUTPUT_CHARS = 200_000

/** Documented packaged install location written by scripts/install-agentgrep.sh. */
export function agentGrepDefaultBin(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  return path.join(home, ".local", "bin", "agentgrep")
}

/** Locate `agentgrep` on $PATH (platform-aware). Returns null when absent. */
export function findAgentGrepOnPath(): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const suffixes = process.platform === "win32" ? ["", ".exe"] : [""]
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, "agentgrep" + suffix)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        // not executable here — keep scanning
      }
    }
  }
  return null
}

/**
 * Resolve the agentgrep executable. Order:
 *   1. $AGENTGREP_BIN
 *   2. packaged default (~/.local/bin/agentgrep)
 *   3. $PATH
 * Throws an actionable error when unavailable.
 */
export function resolveAgentGrepBin(): string {
  const env = process.env.AGENTGREP_BIN
  if (env) {
    try {
      fs.accessSync(env, fs.constants.X_OK)
      return env
    } catch {
      throw new Error(
        `agentgrep: AGENTGREP_BIN="${env}" is not an executable file. Fix the path or unset it to use the packaged default / $PATH.`,
      )
    }
  }
  const packaged = agentGrepDefaultBin()
  if (fs.existsSync(packaged)) {
    try {
      fs.accessSync(packaged, fs.constants.X_OK)
      return packaged
    } catch {
      // found but not executable → fall through so PATH / error can report it
    }
  }
  const onPath = findAgentGrepOnPath()
  if (onPath) return onPath
  const msg =
    `agentgrep: executable not found. Tried:\n` +
    `  1. $AGENTGREP_BIN (unset)\n` +
    `  2. packaged default ${packaged} (not present or not executable)\n` +
    `  3. $PATH (no 'agentgrep' found)\n` +
    `Install it with: bash scripts/install-agentgrep.sh  (pinned 1jehuang/agentgrep v0.1.6), ` +
    `or set AGENTGREP_BIN to a prebuilt binary.`
  throw new Error(msg)
}

/** Null-safe resolution for tests/smoke: returns null instead of throwing. */
export function tryResolveAgentGrepBin(): string | null {
  try {
    return resolveAgentGrepBin()
  } catch {
    return null
  }
}

export interface AgentGrepExecOptions {
  bin?: string
  cwd?: string
  signal?: AbortSignal
  /** Override the default timeout (ms). 0 disables the timeout. */
  timeoutMs?: number
  /** Override the default output cap (chars) applied to stdout and stderr. */
  maxOutputChars?: number
}

export interface AgentGrepExecResult {
  stdout: string
  stderr: string
  exit: number
  timedOut?: boolean
  aborted?: boolean
  truncated?: boolean
  /** Which stream crossed the output cap (stdout|stderr); the child was killed. */
  boundKilled?: string
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Terminate the whole process tree rooted at `pid` and wait for it to exit.
 *
 * Why a tree walk: the agentgrep CLI is launched through a shell-wrapped
 * harness in tests, and any wrapper can leave a grandchild holding the stdout/
 * stderr pipes open (a SIGKILL to the direct child alone would orphan it, so
 * the streams would only hit EOF when the grandchild dies — up to the run
 * bound later). The tree walk is the robust fix:
 *
 *   1. SIGSTOP the direct child so no new descendants can appear while we
 *      enumerate (and so a killed shell cannot race a fresh fork).
 *   2. Collect the full descendant set with `pgrep -P` (recursively).
 *   3. SIGKILL every pid in the tree (child first, then descendants).
 *   4. SIGCONT the stopped child so it can actually die.
 *   5. Wait for the direct child to reap (bounded by `waitMs`).
 *
 * Best-effort by design: failures here never throw — the caller's abort/
 * timeout path must stay robust. Fallbacks are (in order) plain proc.kill()
 * and AbortController.abort().
 */
export function killProcessTree(pid: number, waitMs = 500): void {
  const sig = (target: string, s: string) => {
    try {
      spawnSync("kill", [s, target])
    } catch {
      // ignore — best effort
    }
  }
  const collect = (root: string): string[] => {
    const out = spawnSync("pgrep", ["-P", root], { encoding: "utf8" })
    const kids = (out.stdout ?? "").trim().split("\n").filter(Boolean)
    return [root, ...kids.flatMap((k) => collect(k))]
  }

  const root = String(pid)
  sig(root, "-STOP")
  let tree: string[] = []
  try {
    tree = collect(root)
  } catch {
    tree = [root]
  }
  for (const target of tree) sig(target, "-KILL")
  sig(root, "-CONT")

  // Wait (bounded) for the direct child to disappear so `exited` settles.
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return // already gone
    }
    if (Date.now() >= deadline) return
    const nap = spawnSync("sleep", ["0.02"])
    if (nap.status !== 0) return
  }
}

/**
 * Run the agentgrep CLI one-shot and return captured output. argv is passed to
 * Bun.spawn as an array (no shell). Bounded by a default 30s timeout and a
 * 200k-char output cap — the child process tree is killed when either bound is
 * crossed. Honors an abort signal (an already-aborted caller never spawns; a
 * mid-run abort kills the tree the same way the timeout does).
 */
export async function runAgentGrep(
  argv: string[],
  opts: AgentGrepExecOptions = {},
): Promise<AgentGrepExecResult> {
  const timeoutMs = opts.timeoutMs ?? envInt("AGENTGREP_TIMEOUT_MS", AGENTGREP_DEFAULT_TIMEOUT_MS)
  const maxOutput = opts.maxOutputChars ?? envInt("AGENTGREP_MAX_OUTPUT_CHARS", AGENTGREP_DEFAULT_MAX_OUTPUT_CHARS)
  const bin = opts.bin ?? resolveAgentGrepBin()

  // An already-aborted caller must never spawn a child.
  if (opts.signal?.aborted) {
    return { stdout: "", stderr: "", exit: -1, aborted: true }
  }

  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined

  let proc: ReturnType<typeof Bun.spawn>
  try {
    // env: process.env — Bun.spawn does NOT snapshot runtime process.env
    // mutations by default; without this the child cannot see knobs like
    // AGENTGREP_BIN set in-process by tests/hosts.
    proc = Bun.spawn({
      cmd: [bin, ...argv],
      cwd: opts.cwd ?? process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
      env: process.env,
    })
  } catch (err) {
    throw err
  }

  // Kill-on-bound: the first stream to exceed its cap triggers a single
  // process-tree kill; both readers then keep draining (discarding) so they
  // always reach EOF and `exited` resolves — no deadlock on a full pipe, no
  // unbounded memory.
  let killCalled = false
  const killOnce = () => {
    if (killCalled) return
    killCalled = true
    try {
      killProcessTree(proc.pid)
    } finally {
      try {
        proc.kill()
      } catch {
        // already gone
      }
    }
  }

  // Install abort/timeout handling only after both the process and idempotent
  // tree-kill helper exist. Kill descendants before aborting Bun's direct
  // child; otherwise a shell wrapper can be reparented while still holding the
  // output pipes open, preventing both readers from reaching EOF.
  const stop = () => {
    killOnce()
    controller.abort()
  }
  const onAbort = () => stop()
  opts.signal?.addEventListener("abort", onAbort, { once: true })
  if (opts.signal?.aborted) onAbort()
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
  }
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer)
    opts.signal?.removeEventListener("abort", onAbort)
  }

  const readCapped = async (stream: ReadableStream<Uint8Array>, cap: number) => {
    // Async iteration avoids reader-type friction across Bun/DOM/node types and
    // handles backpressure; `break` cancels the iterator cleanly after kill.
    const chunks: string[] = []
    let total = 0
    let truncated = false
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      const text = new TextDecoder().decode(chunk)
      total += text.length
      if (!truncated && total <= cap) {
        chunks.push(text)
      } else if (!truncated) {
        chunks.push(text.slice(0, Math.max(0, cap - (total - text.length))))
        truncated = true
        killOnce()
      }
    }
    return { text: chunks.join(""), truncated }
  }

  // `stdout`/`stderr` are typed as `ReadableStream | number`; with "pipe" they
  // are always streams, so narrow them before passing to readCapped.
  const [stdout, stderr] = await Promise.all([
    readCapped(proc.stdout as ReadableStream<Uint8Array>, maxOutput),
    readCapped(proc.stderr as ReadableStream<Uint8Array>, maxOutput),
  ])

  let exit: number
  try {
    exit = await proc.exited
  } catch {
    exit = -1
  }
  cleanup()

  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exit,
    timedOut: timedOut || undefined,
    aborted: opts.signal?.aborted || undefined,
    truncated: stdout.truncated || stderr.truncated || undefined,
    boundKilled: stdout.truncated ? "stdout" : stderr.truncated ? "stderr" : undefined,
  }
}