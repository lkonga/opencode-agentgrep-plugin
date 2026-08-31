// agentgrep-paths — OpenCode-native path-permission semantics for the standalone
// agentgrep plugin. This module owns model-root resolution, canonicalization,
// project boundary classification, and the external_directory asks.
// (Permission *operation patterns* live in agentgrep-args.ts; tool schemas,
// execute orchestration and the registry live in agentgrep-tools.ts; the
// compatibility barrel is agentgrep-core.ts.)
//
// Mirrors the native behavior in packages/opencode/src/tool/{grep.ts,glob.ts,
// external-directory.ts} and the native `containsPath`
// (packages/opencode/src/project/instance-context.ts):
//   - every model-controlled filesystem root (`path`, the outline `file`/
//     `file_path`, and `file` as an alternative grep/find/trace scope) resolves
//     relative to ctx.directory (or the directory-valued `path` root for
//     outline);
//   - existing symlinks are canonicalized (realpath); a nonexistent leaf is
//     canonicalized to its nearest existing ancestor + the remaining suffix; a
//     strict boundary check then classifies against ctx.directory/ctx.worktree;
//   - a file-valued root stays EXACT: grep/find/trace translate it to a
//     parent-root + basename-glob scope (see exactFileScope in agentgrep-args)
//     so a sibling file is never searched;
//   - `external_directory` is asked with a canonical parent-dir glob and
//     filepath/parentDir metadata, coalescing duplicate asks per parent dir.
// A denial rejects the ask and abandons execution before any process spawns.

import type { ToolContext } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import type { AgentGrepInput, AgentGrepMode } from "./agentgrep-types"

export interface ProjectBounds {
  directory: string
  worktree: string
}

export interface ResolvedRoot {
  /** Canonical absolute path (symlinks resolved; nonexistent leaf → nearest existing ancestor + suffix). */
  full: string
  kind: "file" | "directory"
  /**
   * True only when the canonical path is an EXISTING file (stat-kind "file").
   * Nonexistent leaves keep kind "file" for the external-ask parent-dir
   * semantics but are NOT treated as exact-file scopes (jcode is_file()).
   */
  isExactFile?: boolean
  /** Parent dir used for the external_directory ask (mirrors native external-directory.ts). */
  dir: string
}

export interface ResolvedRoots {
  path?: ResolvedRoot
  outline?: ResolvedRoot
}

/** Strict path-boundary containment: target inside root, or exactly root. */
export function isWithinPath(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/**
 * Mirror of the native `containsPath`: inside the session directory OR the
 * project worktree. A "/" worktree (non-git projects) is treated as unset so it
 * cannot match every absolute path.
 */
export function isInsideProject(absPath: string, bounds: ProjectBounds): boolean {
  if (isWithinPath(bounds.directory, absPath)) return true
  if (!bounds.worktree || bounds.worktree === "/") return false
  return isWithinPath(bounds.worktree, absPath)
}

/**
 * Canonicalize a path: resolve symlinks for the existing portion. A nonexistent
 * leaf canonicalizes to its nearest existing ancestor plus the remaining
 * suffix, so classification is strict even for not-yet-created files.
 */
export function canonicalizePath(input: string): string {
  try {
    return fs.realpathSync(input)
  } catch {
    // leaf (or more) does not exist — fall through to ancestor canonicalization
  }
  const abs = path.resolve(input)
  const root = path.parse(abs).root
  const parts = abs.slice(root.length).split(path.sep).filter(Boolean)
  // Find the deepest existing ancestor, then realpath it and re-append the
  // remaining (nonexistent) suffix verbatim.
  let base = root
  let resolved = 0
  let acc = root
  for (let i = 0; i < parts.length; i++) {
    acc = path.join(acc, parts[i])
    if (!fs.existsSync(acc)) break
    base = acc
    resolved = i + 1
  }
  const realBase = fs.realpathSync(base)
  const rest = parts.slice(resolved).join(path.sep)
  return rest ? path.join(realBase, rest) : realBase
}

function statKind(p: string): "directory" | "file" | undefined {
  try {
    const st = fs.statSync(p)
    return st.isDirectory() ? "directory" : "file"
  } catch {
    return undefined
  }
}

/**
 * Collect the model-controlled filesystem roots for this invocation, resolved
 * against ctx.directory and canonicalized.
 *
 * grep/find/trace:
 *   - `path` (defaults to the session directory); `file` acts as an alternative
 *     exact-file scope when `path` is absent (jcode `path = path.or(file)`).
 *   - A file-valued root is kept EXACT — the execute layer translates it into a
 *     parent-root + basename-glob scope so no sibling is ever searched.
 *
 * outline:
 *   - a file-valued `path` IS the outline target (jcode: treat a file-valued
 *     path as the outline file, not a root to join onto);
 *   - otherwise `file`/`file_path` resolves against the directory-valued `path`
 *     root when one is provided, else against ctx.directory.
 */
export function resolveModelRoots(input: AgentGrepInput, mode: AgentGrepMode, directory: string): ResolvedRoots {
  const roots: ResolvedRoots = {}
  const rawPath = input.path ? String(input.path) : undefined
  const rawFile = input.file ?? input.file_path

  if (mode === "outline") {
    if (rawPath) {
      const full = canonicalizePath(path.resolve(directory, rawPath))
      const st = statKind(full)
      if (st === "file") {
        // File-valued path → the outline target itself (no root to join onto).
        roots.outline = { full, kind: "file", isExactFile: true, dir: path.dirname(full) }
        return roots
      }
      roots.path = { full, kind: "directory", dir: full }
    }
    if (rawFile) {
      // `file` resolves relative to the directory-valued `path` root when one
      // is provided (requirement: file resolves against path).
      const base = roots.path?.full ?? directory
      const full = canonicalizePath(path.resolve(base, rawFile))
      roots.outline = { full, kind: "file", dir: path.dirname(full) }
    }
    return roots
  }

  // grep/find/trace: `file` is an alternative exact-file scope when path is absent.
  const scope = rawPath ?? rawFile
  if (scope) {
    const abs = path.resolve(directory, scope)
    const full = canonicalizePath(abs)
    const st = statKind(full)
    const kind = st === "directory" ? "directory" : "file"
    roots.path = {
      full,
      kind,
      isExactFile: st === "file",
      dir: kind === "directory" ? full : path.dirname(full),
    }
  } else {
    roots.path = { full: canonicalizePath(path.resolve(directory, ".")), kind: "directory", dir: directory }
  }
  return roots
}

/**
 * Ask the native `external_directory` permission for every model-controlled
 * root that escapes the project boundary. Uses the canonical parent-dir glob
 * and filepath/parentDir metadata exactly like the native
 * external-directory.ts; duplicate asks for the same parent dir are coalesced.
 * A denial rejects and aborts execute before any spawn.
 */
export async function askExternalDirectoryIfNeeded(
  ctx: ToolContext,
  roots: ResolvedRoots,
): Promise<void> {
  const bounds: ProjectBounds = { directory: ctx.directory, worktree: ctx.worktree }
  const asked = new Set<string>()
  for (const root of [roots.path, roots.outline]) {
    if (!root) continue
    if (isInsideProject(root.full, bounds)) continue
    const dir = root.kind === "directory" ? root.full : path.dirname(root.full)
    if (asked.has(dir)) continue
    asked.add(dir)
    const glob = path.join(dir, "*").replaceAll("\\", "/")
    await ctx.ask({
      permission: "external_directory",
      patterns: [glob],
      always: [glob],
      metadata: { filepath: root.full, parentDir: dir },
    })
  }
}