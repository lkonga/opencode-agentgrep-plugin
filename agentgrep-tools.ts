// agentgrep-tools — the OpenCode-facing half of the standalone agentgrep
// plugin: tool descriptions, the shared execute orchestration (permission
// asks → canonical roots → harness context → argv → bounded spawn), and the
// tool registry builder using the canonical `tool({...})` factory.
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
//   agentgrep-context*  — harness context adapter (see agentgrep-context.ts)
//
// ⚠️ This module is NOT a plugin entrypoint. Only index.ts may be loaded by
// OpenCode, and it must export exactly one thing (the default plugin fn).

import { tool, type PluginInput, type ToolDefinition, type ToolContext, type ToolResult } from "@opencode-ai/plugin"
import path from "node:path"
import type { AgentGrepInput, AgentGrepMode, AgentGrepCompatibilityAlias, ResolvedAgentGrepPluginOptions } from "./agentgrep-types"
import {
  AGENTGREP_CANONICAL_ID,
  normalizeAgentGrepMode,
} from "./agentgrep-types"
import { buildAgentGrepArgs, exactFileScope, operationPatterns } from "./agentgrep-args"
import { askExternalDirectoryIfNeeded, canonicalizePath, resolveModelRoots } from "./agentgrep-paths"
import { resolveAgentGrepBin, runAgentGrep } from "./agentgrep-exec"
import { createAgentGrepContextProvider, type AgentGrepContextProvider } from "./agentgrep-context"
import { writeContextTempFile, type ContextTempFile } from "./agentgrep-context-temp"
import { sanitizeContextOutput, type SanitizeResult } from "./agentgrep-context-sanitize"

function toolDescription(alias: string | null): string {
  const header =
    `Canonical code search and retrieval tool over the current repository using the ` +
    `agentgrep CLI (v0.1.6). One-shot, lexical-first, returns a compact investigation-` +
    `ready result packet. Use this tool for exact search, file outlines, and traces.`
  const modes =
    `Modes: "grep" (exact search), "outline" (structure scan of a known file, ` +
    `requires \`file\`), "trace" (structured investigation with ranked files+regions). ` +
    `It can also do ranked file discovery with mode="find".`
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
      ? ` Compatibility-only alias for the canonical \`agentgrep\` tool. Use \`agentgrep\` with mode="grep" for exact search.`
      : alias === "find"
        ? ` Compatibility-only alias for the canonical \`agentgrep\` tool. Use \`agentgrep\` with mode="find" for ranked file discovery.`
        : ""
  return [header, modes, schema, note.split("\n").join(" ")].filter(Boolean).join("\n\n")
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
 *
 * Harness context (trace/smart/outline only): built AFTER permission asks so a
 * denied call never triggers SDK/SQLite/stat work, and its failures degrade to
 * "no context" (never affect permission, path, argv, or search behavior). The
 * context tempfile is removed in a `finally` on success/nonzero/timeout/abort/
 * error, and its path never leaks into asks, results, or metadata.
 *
 * NOTE (hidden-smart parity): `input.mode` is threaded through RAW into the
 * args builder so `smart` + multiword `query` still splits into trace DSL terms
 * inside buildAgentGrepArgs/operationPatterns, while the CLI subcommand is
 * resolved to `trace`. `resolvedMode` (smart → trace) is used only for
 * metadata; it does NOT overwrite the raw mode.
 */
async function executeAgentGrep(
  input: Record<string, any>,
  ctx: ToolContext,
  resolvedMode: AgentGrepMode,
  provider: AgentGrepContextProvider,
): Promise<ToolResult> {
  const title = `agentgrep ${resolvedMode}`
  const roots = resolveModelRoots(input, resolvedMode, ctx.directory)
  const patterns = operationPatterns(resolvedMode, input)

  await ctx.ask({
    permission: "agentgrep",
    patterns,
    always: ["*"],
    metadata: {
      mode: resolvedMode,
      pattern: patterns.join(" ") || undefined,
      path: roots.path?.full ?? ctx.directory,
      include: input.glob ?? input.include,
    },
  })
  await askExternalDirectoryIfNeeded(ctx, roots)

  let normalized: AgentGrepInput
  let contextTemp: ContextTempFile | null = null
  let contextJson: string | null = null
  // While a context file is active, every stream returned by execute must be
  // scrubbed of the temp path / serialized context before it reaches the model.
  const sanitize = (text: string): SanitizeResult =>
    sanitizeContextOutput(text, { tempPath: contextTemp?.path ?? null, contextJson })
  try {
    // Keep the RAW caller mode so smart query-splitting survives into the args
    // builder; the mode is resolved per-call, never pinned by the tool id.
    normalized = { ...input }

    if (roots.path?.isExactFile) {
      const scope = exactFileScope(roots.path.full, roots.path.kind)
      if (scope) normalized.__fileScope = scope
    } else if (roots.path) {
      normalized.path = roots.path.full
    }
    if (resolvedMode === "outline") {
      if (roots.outline) normalized.file = roots.outline.full
      if (!roots.path) normalized.path = canonicalizePath(path.resolve(ctx.directory, "."))
    }

    // Harness context for trace/smart/outline only (jcode parity). Guarded so
    // failures here never affect the tool's other behavior. The search root for
    // context is always a DIRECTORY (the project root / directory-valued path
    // root) — never an exact-file leaf — because context paths serialize
    // relative to the repository root and must be contained within it.
    if (resolvedMode === "trace" || resolvedMode === "outline") {
      const searchRoot =
        roots.path && roots.path.kind === "directory"
          ? roots.path.full
          : canonicalizePath(path.resolve(ctx.directory, "."))
      const json = await provider.getHarnessJson(input, ctx, searchRoot)
      contextJson = json
      contextTemp = writeContextTempFile(json)
      if (contextTemp) normalized.__contextJson = contextTemp.path
    }
  } catch (err) {
    contextTemp?.cleanup()
    const safe = sanitize((err as Error)?.message ?? String(err))
    return {
      title,
      output: `agentgrep: invalid arguments: ${safe.text}`,
      metadata: { mode: resolvedMode, ok: false, contextRedacted: safe.redacted || undefined },
    }
  }

  let argv: string[]
  try {
    argv = buildAgentGrepArgs(normalized)
  } catch (err) {
    contextTemp?.cleanup()
    const safe = sanitize((err as Error)?.message ?? String(err))
    return {
      title,
      output: `agentgrep: invalid arguments: ${safe.text}`,
      metadata: { mode: resolvedMode, ok: false, contextRedacted: safe.redacted || undefined },
    }
  }

  let bin: string
  try {
    bin = resolveAgentGrepBin()
  } catch (err) {
    contextTemp?.cleanup()
    const safe = sanitize((err as Error)?.message ?? String(err))
    return {
      title,
      output: `agentgrep executable unavailable.\n\n${safe.text}`,
      metadata: { mode: resolvedMode, ok: false, contextRedacted: safe.redacted || undefined },
    }
  }

  try {
    const result = await runAgentGrep(argv, {
      bin,
      cwd: ctx.directory,
      signal: ctx.abort,
    })
    const stdout = sanitize(result.stdout)
    const stderr = sanitize(result.stderr)
    if (result.timedOut) {
      return {
        title,
        output:
          `agentgrep (${resolvedMode}) timed out and was killed. ` +
          `Narrow the query or raise AGENTGREP_TIMEOUT_MS.`,
        metadata: { mode: resolvedMode, ok: false, timedOut: true, exit: result.exit, bin },
      }
    }
    if (result.aborted) {
      return {
        title,
        output: `agentgrep: aborted.`,
        metadata: { mode: resolvedMode, ok: false, aborted: true, exit: result.exit },
      }
    }
    if (result.exit !== 0) {
      const detail = (stderr.text || stdout.text).trim() || `exit ${result.exit}`
      return {
        title,
        output: `agentgrep (${resolvedMode}) failed (exit ${result.exit}):\n${detail}`,
        metadata: {
          mode: resolvedMode,
          ok: false,
          exit: result.exit,
          bin,
          truncated: result.truncated || undefined,
          contextRedacted: stdout.redacted || stderr.redacted || undefined,
        },
      }
    }
    return {
      title,
      output: stdout.text,
      metadata: {
        mode: resolvedMode,
        ok: true,
        exit: result.exit,
        bin,
        truncated: result.truncated || undefined,
        boundKilled: result.boundKilled,
        contextRedacted: stdout.redacted || stderr.redacted || undefined,
      },
    }
  } catch (err) {
    const aborted = (ctx.abort && ctx.abort.aborted) || (err as Error)?.name === "AbortError"
    const safe = sanitize((err as Error)?.message ?? String(err))
    return {
      title,
      output: aborted
        ? "agentgrep: aborted."
        : `agentgrep: execution error: ${safe.text}`,
      metadata: { mode: resolvedMode, ok: false, aborted: aborted || undefined, contextRedacted: safe.redacted || undefined },
    }
  } finally {
    // Success, nonzero, timeout, abort, and thrown errors all clean up.
    contextTemp?.cleanup()
  }
}

/**
 * Build one mode-flexible ToolDefinition via the canonical `tool({...})` factory
 * from `@opencode-ai/plugin`. The args shape uses `tool.schema` (the plugin
 * package's own zod — v4) so the server's registry recognizes the types and can
 * serialize a proper JSON Schema for /experimental/tool.
 */
function buildTool(alias: string | null, provider: AgentGrepContextProvider): ToolDefinition {
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
      // Validate + resolve (smart → trace) for metadata, but keep the RAW mode
      // inside executeAgentGrep so smart query-splitting works.
      const resolvedMode = normalizeAgentGrepMode(input.mode)
      return executeAgentGrep(input, ctx, resolvedMode, provider)
    },
  })
}

/**
 * The explicit compatibility `find` alias: a purpose-built ToolDefinition that
 * FORCES agentgrep `find` mode regardless of any `mode` the model passes
 * (matching the historical first-class `find` behavior). Registered ONLY when
 * `compatibilityAliases` includes "find" — never by default.
 */
function buildFindTool(provider: AgentGrepContextProvider): ToolDefinition {
  return tool({
    description:
      `Compatibility-only alias for the canonical \`agentgrep\` tool. Use \`agentgrep\` ` +
      `with mode="find" for ranked file discovery. This id forces agentgrep \`find\` mode ` +
      `regardless of any \`mode\` input. Results are ranked candidate files matching the ` +
      `given terms, optionally narrowed by \`glob\` / \`type\` / \`max_files\`. A file-valued ` +
      `\`path\` scopes discovery to that exact file. \`path\` defaults to the current project ` +
      `directory; relative paths resolve against it. Paths outside the project require ` +
      `external_directory permission. Results are bounded CLI-side (max-files default 10), ` +
      `output is capped (default 200000 chars), and runs are killed after a default 30s timeout.`,
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
      // Pin the RAW mode to "find" so buildAgentGrepArgs/operationPatterns emit
      // find argv/patterns even if the model passed a different mode.
      return executeAgentGrep({ ...input, mode: "find" }, ctx, "find", provider)
    },
  })
}

/**
 * Build the registry of tool definitions.
 *
 * Default: canonical `agentgrep` (mode-flexible, the primary local code-search
 * tool with modes grep/find/outline/trace). Compatibility aliases (`find`,
 * `file_grep`, `Grep` — exact case) are registered ONLY when explicitly
 * requested through `opts.compatibilityAliases`; `find` is never registered
 * implicitly. The `find` alias is a purpose-built, forced-find ToolDefinition
 * (see buildFindTool); `file_grep`/`Grep` reuse the mode-flexible schema.
 * NOTE: intentionally NO `grep` id and NO `glob` id — the config
 * hook disables OpenCode's native grep/glob tools, so grep/glob-id plugin
 * aliases would be unreachable and would silently never fire.
 *
 * `opts` is the ALREADY-SANITIZED policy from `sanitizeAgentGrepPluginOptions`
 * (see agentgrep-types.ts); pass the raw plugin tuple through that sanitizer
 * first. Omitted → default policy (no aliases).
 *
 * `pluginInput` is threaded from the loader so the shared harness context
 * adapter can feature-detect the injected SDK client and (lazily) a v2 client
 * from `PluginInput.serverUrl`. Backwards-compatible: omitted → a provider
 * with no SDK client (context then only ever falls through to a best-effort
 * SQLite probe, which in practice yields null).
 */
export function buildAgentGrepTools(
  pluginInput?: PluginInput,
  opts?: ResolvedAgentGrepPluginOptions,
): Record<string, ToolDefinition> {
  const provider = createAgentGrepContextProvider(pluginInput)
  const tools: Record<string, ToolDefinition> = {
    [AGENTGREP_CANONICAL_ID]: buildTool(null, provider),
  }
  for (const alias of opts?.compatibilityAliases ?? []) {
    if (alias === "find") {
      tools[alias] = buildFindTool(provider)
    } else {
      tools[alias] = buildTool(alias, provider)
    }
  }
  return tools
}
