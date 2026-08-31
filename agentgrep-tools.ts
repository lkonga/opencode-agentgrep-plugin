// agentgrep-tools — the OpenCode-facing half of the standalone agentgrep
// plugin: tool descriptions, the shared execute orchestration (permission
// asks → canonical roots → argv → bounded spawn), and the tool registry
// builder using the canonical `tool({...})` factory.
//
// Module split of the former monolithic agentgrep-core.ts:
//   agentgrep-types.ts  — contract/types + mode/term/glob normalization
//   agentgrep-args.ts   — exact-file scope translation + argv builder +
//                         permission operation patterns
//   agentgrep-tools.ts  — OpenCode schemas (tool.schema zod v4), execute
//                         orchestration, and the tool registry (this)
//   agentgrep-core.ts   — compatibility barrel
//   agentgrep-paths.ts  — canonical roots, containment, external asks
//   agentgrep-exec.ts   — binary resolution + bounded execution
//
// ⚠️ This module is NOT a plugin entrypoint. Only index.ts may be loaded by
// OpenCode, and it must export exactly one thing (the default plugin fn).

import { tool, type ToolDefinition, type ToolContext, type ToolResult } from "@opencode-ai/plugin"
import path from "node:path"
import type { AgentGrepInput, AgentGrepMode } from "./agentgrep-types"
import { AGENTGREP_CANONICAL_ID, AGENTGREP_FIND_ID, normalizeAgentGrepMode } from "./agentgrep-types"
import { buildAgentGrepArgs, exactFileScope, operationPatterns } from "./agentgrep-args"
import { askExternalDirectoryIfNeeded, canonicalizePath, resolveModelRoots } from "./agentgrep-paths"
import { resolveAgentGrepBin, runAgentGrep } from "./agentgrep-exec"

function toolDescription(alias: string | null): string {
  const header =
    `Code search and retrieval over a repository using the agentgrep CLI (v0.1.6). ` +
    `One-shot, lexical-first, returns a compact investigation-ready result packet.`
  const modes =
    `Modes: "grep" (exact search), "find" (ranked file discovery), ` +
    `"outline" (structure scan of a known file, requires \`file\`), ` +
    `"trace" (structured investigation with ranked files+regions).`
  const schema =
    `Args follow the jcode-compatible public schema: \`query\`, \`file\`, \`terms\`, ` +
    `\`regex\`, \`path\`, \`glob\`, \`type\`, \`max_files\`, \`max_regions\`, \`paths_only\`. ` +
    `A file-valued \`path\` searches only that exact file (never siblings). ` +
    `\`path\` defaults to the current project directory; relative paths resolve ` +
    `against it. Paths outside the project require external_directory permission. ` +
    `find/trace results are bounded CLI-side (max-files/max-regions defaults); ` +
    `output is capped (default 200000 chars) and runs are killed after a default 30s timeout.`
  const note =
    alias === "file_grep" || alias === "Grep"
      ? ` Legacy alias for the canonical \`agentgrep\` tool.`
      : ""
  return [header, modes, schema, note.split("\n").join(" ")].filter(Boolean).join("\n\n")
}

function findToolDescription(): string {
  return (
    `File discovery over a repository using the agentgrep CLI (v0.1.6) \`find\` mode. ` +
    `Returns ranked candidate files matching the given terms, optionally narrowed by ` +
    `\`glob\` / \`type\` / \`max_files\`. This is the model-facing replacement for the ` +
    `disabled native \`glob\` tool — use it for "find the file that..." questions. ` +
    `A file-valued \`path\` scopes discovery to that exact file. \`path\` defaults to ` +
    `the current project directory; relative paths resolve against it. Paths outside ` +
    `the project require external_directory permission. Results are bounded CLI-side ` +
    `(max-files default 10), output is capped (default 200000 chars), and runs are ` +
    `killed after a default 30s timeout.`
  )
}

/**
 * Shared execute body for all agentgrep-family tools.
 *
 * Permission flow (before any spawn):
 *   1. `agentgrep` ask — canonical operation pattern(s), always ["*"].
 *   2. `external_directory` asks for roots outside directory/worktree (native
 *      canonical glob + metadata, deduped).
 * Denials reject execute (they are NOT converted to tool results), so a denied
 * call can never spawn the agentgrep process.
 */
async function executeAgentGrep(
  input: Record<string, any>,
  ctx: ToolContext,
  mode: AgentGrepMode,
): Promise<ToolResult> {
  const title = `agentgrep ${mode}`
  const roots = resolveModelRoots(input, mode, ctx.directory)
  const patterns = operationPatterns(mode, input)

  await ctx.ask({
    permission: "agentgrep",
    patterns,
    always: ["*"],
    metadata: {
      mode,
      pattern: patterns.join(" ") || undefined,
      path: roots.path?.full ?? ctx.directory,
      include: input.glob ?? input.include,
    },
  })
  await askExternalDirectoryIfNeeded(ctx, roots)

  let argv: string[]
  try {
    // Pin the resolved mode so forced-mode tools (the `find` id) cannot fall
    // back to buildAgentGrepArgs' grep default. Thread canonical roots back
    // into the pure args builder (exact-file scopes via __fileScope).
    const normalized: AgentGrepInput = { ...input, mode }
    if (roots.path?.isExactFile) {
      // Exact-file scope: only a canonical path that is an EXISTING file is
      // translated (jcode is_file()); nonexistent leaves stay directory roots.
      const scope = exactFileScope(roots.path.full, roots.path.kind)
      if (scope) normalized.__fileScope = scope
    } else if (roots.path) {
      normalized.path = roots.path.full
    }
    if (mode === "outline") {
      if (roots.outline) normalized.file = roots.outline.full
      if (!roots.path) normalized.path = canonicalizePath(path.resolve(ctx.directory, "."))
    }
    argv = buildAgentGrepArgs(normalized)
  } catch (err) {
    return {
      title,
      output: `agentgrep: invalid arguments: ${(err as Error).message}`,
      metadata: { mode, ok: false },
    }
  }

  let bin: string
  try {
    bin = resolveAgentGrepBin()
  } catch (err) {
    return {
      title,
      output: `agentgrep executable unavailable.\n\n${(err as Error).message}`,
      metadata: { mode, ok: false },
    }
  }

  try {
    const result = await runAgentGrep(argv, {
      bin,
      cwd: ctx.directory,
      signal: ctx.abort,
    })
    if (result.timedOut) {
      return {
        title,
        output:
          `agentgrep (${mode}) timed out and was killed. ` +
          `Narrow the query or raise AGENTGREP_TIMEOUT_MS.`,
        metadata: { mode, ok: false, timedOut: true, exit: result.exit, bin },
      }
    }
    if (result.aborted) {
      return {
        title,
        output: `agentgrep: aborted.`,
        metadata: { mode, ok: false, aborted: true, exit: result.exit },
      }
    }
    if (result.exit !== 0) {
      const detail = (result.stderr || result.stdout).trim() || `exit ${result.exit}`
      return {
        title,
        output: `agentgrep (${mode}) failed (exit ${result.exit}):\n${detail}`,
        metadata: {
          mode,
          ok: false,
          exit: result.exit,
          bin,
          truncated: result.truncated || undefined,
        },
      }
    }
    return {
      title,
      output: result.stdout,
      metadata: {
        mode,
        ok: true,
        exit: result.exit,
        bin,
        truncated: result.truncated || undefined,
        boundKilled: result.boundKilled,
      },
    }
  } catch (err) {
    const aborted = (ctx.abort && ctx.abort.aborted) || (err as Error)?.name === "AbortError"
    return {
      title,
      output: aborted
        ? "agentgrep: aborted."
        : `agentgrep: execution error: ${(err as Error)?.message ?? String(err)}`,
      metadata: { mode, ok: false, aborted: aborted || undefined },
    }
  }
}

/**
 * Build one mode-flexible ToolDefinition via the canonical `tool({...})` factory
 * from `@opencode-ai/plugin`. The args shape uses `tool.schema` (the plugin
 * package's own zod — v4) so the server's registry recognizes the types and can
 * serialize a proper JSON Schema for /experimental/tool.
 *
 * The schema is the JCODE-COMPATIBLE PUBLIC surface only, in key order:
 * mode, query, file, terms, regex, path, glob, type, max_files, max_regions,
 * paths_only. It uses `type` (NOT file_type), the public enum
 * grep|find|outline|trace (no smart), and exposes no hidden/no_ignore/
 * full_region/debug_* fields. jcode-internal aliases (pattern, file_path,
 * include, ...) are still accepted at runtime by the execute layer but are
 * never advertised to the model.
 */
function buildTool(alias: string | null): ToolDefinition {
  return tool({
    description: toolDescription(alias),
    args: {
      mode: tool.schema
        .enum(["grep", "find", "outline", "trace"])
        .optional()
        .describe("Search mode. Defaults to grep."),
      query: tool.schema
        .string()
        .optional()
        .describe("Search query. Required for grep (literal unless regex=true); optional ranking terms for find."),
      file: tool.schema.string().optional().describe("Single file to inspect. Required for outline."),
      terms: tool.schema
        .union([tool.schema.string(), tool.schema.array(tool.schema.string())])
        .optional()
        .describe(
          "Structured terms: trace DSL terms (e.g. subject:auth_status relation:rendered), or query parts for find.",
        ),
      regex: tool.schema.boolean().optional().describe("In grep mode, treat query as a regex. Defaults to false (literal)."),
      path: tool.schema
        .string()
        .optional()
        .describe(
          "Directory or file to search, relative to the workspace. A file-valued path searches only that file. Omit to search the whole workspace.",
        ),
      glob: tool.schema
        .string()
        .optional()
        .describe("Optional file glob filter such as **/*.rs. Omit to search everything."),
      type: tool.schema
        .string()
        .optional()
        .describe("Optional ripgrep file type filter, such as rs, py, js, ts, or md."),
      max_files: tool.schema
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max files to return (find/trace; CLI-side defaults 10/5)."),
      max_regions: tool.schema
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max matching regions per query (trace; CLI-side default 6)."),
      paths_only: tool.schema
        .boolean()
        .optional()
        .describe("Return only matching paths instead of match excerpts where supported."),
    },
    execute: async (input: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
      const mode = normalizeAgentGrepMode(input.mode)
      return executeAgentGrep(input, ctx, mode)
    },
  })
}

/**
 * The first-class `find` id: forces agentgrep `find` mode regardless of any
 * `mode` the model passes. This is the model-facing replacement for the
 * disabled native `glob` tool (glob is intentionally NOT registered — the
 * `glob` id is permission-filtered the same way `grep` is).
 */
function buildFindTool(): ToolDefinition {
  return tool({
    description: findToolDescription(),
    args: {
      query: tool.schema
        .string()
        .optional()
        .describe("Ranking terms for find. Multiword splits into positional query parts."),
      terms: tool.schema
        .union([tool.schema.string(), tool.schema.array(tool.schema.string())])
        .optional()
        .describe("Ranking terms for find (alternative to query)."),
      path: tool.schema
        .string()
        .optional()
        .describe(
          "Directory or file to search, relative to the workspace. A file-valued path scopes discovery to that file. Omit to search the whole workspace.",
        ),
      glob: tool.schema
        .string()
        .optional()
        .describe("Optional file glob filter such as **/*.rs. Omit to search everything."),
      type: tool.schema
        .string()
        .optional()
        .describe("Optional ripgrep file type filter, such as rs, py, js, ts, or md."),
      max_files: tool.schema
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max files to return (CLI-side default 10)."),
      paths_only: tool.schema
        .boolean()
        .optional()
        .describe("Return only matching paths instead of match excerpts where supported."),
    },
    execute: async (input: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
      return executeAgentGrep(input, ctx, "find")
    },
  })
}

/**
 * Build the registry of tool definitions. Canonical `agentgrep`, the two
 * legacy aliases, and the first-class `find` id (forced find mode). NOTE:
 * intentionally NO `grep` id and NO `glob` id — the permission gate
 * `tools.grep=false` / `tools.glob=false` filters any tool with those ids, so
 * grep/glob-id plugin aliases would be unreachable and would silently never
 * fire.
 */
export function buildAgentGrepTools(): Record<string, ToolDefinition> {
  return {
    [AGENTGREP_CANONICAL_ID]: buildTool(null),
    ["file_grep"]: buildTool("file_grep"),
    ["Grep"]: buildTool("Grep"),
    [AGENTGREP_FIND_ID]: buildFindTool(),
  }
}
