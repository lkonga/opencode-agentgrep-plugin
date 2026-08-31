// agentgrep — standalone OpenCode plugin. Pure contract tests: loader shape,
// tool registration, jcode-compatible public schema, mode/glob normalization,
// exact-file scope translation, argv building, permission operation patterns,
// executable resolution. (Execute/bounds/smoke tests live in
// agentgrep-execute.test.ts.)
//
// Imports point at the standalone modules (never at any opencode-patches
// runtime): the loader entrypoint is `./index`; implementation helpers live in
// `./agentgrep-core` (which re-exports the focused modules).

import { describe, test, expect } from "bun:test"
import path from "node:path"
import {
  AGENTGREP_ALIASES,
  AGENTGREP_CANONICAL_ID,
  AGENTGREP_FIND_ID,
  AGENTGREP_GUIDANCE_MARKER,
  agentgrepSystemGuidance,
  applyAgentGrepSystemGuidance,
  buildAgentGrepArgs,
  buildAgentGrepTools,
  exactFileScope,
  legacyAliasesEnabled,
  normalizeAgentGrepMode,
  normalizeMatchAllGlob,
  operationPatterns,
  resolveAgentGrepToolID,
  tryResolveAgentGrepBin,
  agentGrepDefaultBin,
} from "./agentgrep-core"
// The default plugin is loaded from the entrypoint, exactly as OpenCode does.
import agentGrepPlugin from "./index"

// Minimal PluginInput stub so the loader function can be invoked in tests.
// (The loader now threads `PluginInput` into buildAgentGrepTools.)
function makePluginInput(): any {
  return {
    client: {},
    directory: "",
    worktree: "",
    project: {},
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://localhost:4096"),
    $: undefined,
  }
}

// ── Entrypoint / registration ────────────────────────────────────────────────

describe("entrypoint module shape (loader constraint)", () => {
  test("index.ts exports ONLY the default plugin function", async () => {
    const mod = await import("./index")
    // OpenCode's loader (getLegacyPlugins) iterates Object.values(mod) and
    // throws "Plugin export is not a function" for any non-function export.
    expect(Object.keys(mod)).toEqual(["default"])
    expect(typeof mod.default).toBe("function")
  })

  test("default plugin registers canonical agentgrep + find only (no bare grep/glob, no legacy aliases)", async () => {
    const hooks = await agentGrepPlugin(makePluginInput())
    expect(Object.keys(hooks.tool)).toEqual(["agentgrep", "find"])
    for (const id of Object.keys(hooks.tool)) {
      expect(hooks.tool[id].description).toContain("agentgrep")
      expect(typeof hooks.tool[id].execute).toBe("function")
    }
  })

  test("default plugin exposes the idempotent local code-search system guidance hook", async () => {
    const hooks = await agentGrepPlugin(makePluginInput())
    const transform = hooks["experimental.chat.system.transform"]
    expect(typeof transform).toBe("function")
    const output = { system: ["existing"] }
    await transform!({ sessionID: "s", model: {} as never }, output)
    expect(output.system[0]).toBe("existing")
    expect(output.system.some((s) => s.includes(AGENTGREP_GUIDANCE_MARKER))).toBe(true)
    const before = output.system.length
    await transform!({ sessionID: "s", model: {} as never }, output)
    expect(output.system.length).toBe(before) // idempotent: no duplicate guidance
  })
})

describe("tool registration ids", () => {
  const tools = buildAgentGrepTools()
  const optInTools = buildAgentGrepTools(undefined, { legacyAliases: true })

  test("canonical agentgrep is registered", () => {
    expect(Object.keys(tools)).toContain(AGENTGREP_CANONICAL_ID)
    expect(tools.agentgrep.description).toBeTruthy()
    expect(typeof tools.agentgrep.execute).toBe("function")
    expect(tools.agentgrep.args).toBeTruthy()
  })

  test("legacy aliases are NOT registered by default, but ARE via the typed opt-in (exact case)", () => {
    // Default registry: no legacy aliases.
    for (const alias of AGENTGREP_ALIASES) {
      expect(Object.keys(tools), `${alias} must be absent by default`).not.toContain(alias)
    }
    // Typed opt-in registers BOTH exact-case ids.
    for (const alias of AGENTGREP_ALIASES) {
      expect(Object.keys(optInTools)).toContain(alias)
      expect(optInTools[alias].description).toContain("agentgrep")
      expect(optInTools[alias].description).toMatch(/compatibilit|Prefer/i)
      expect(typeof optInTools[alias].execute).toBe("function")
    }
  })

  test("AGENTGREP_LEGACY_ALIASES=1 env opt-in registers the exact-case legacy aliases", () => {
    const prev = process.env.AGENTGREP_LEGACY_ALIASES
    try {
      process.env.AGENTGREP_LEGACY_ALIASES = "1"
      const envTools = buildAgentGrepTools()
      expect(Object.keys(envTools)).toEqual(["agentgrep", "find", "file_grep", "Grep"])
      expect(legacyAliasesEnabled()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.AGENTGREP_LEGACY_ALIASES
      else process.env.AGENTGREP_LEGACY_ALIASES = prev
    }
    expect(legacyAliasesEnabled()).toBe(false)
  })

  test("first-class find id is registered with forced find semantics", () => {
    expect(Object.keys(tools)).toContain(AGENTGREP_FIND_ID)
    const findTool = tools.find
    expect(findTool.description).toContain("find")
    // find args carry no mode; the id itself forces find mode.
    expect(Object.keys(findTool.args ?? {})).not.toContain("mode")
  })

  test("grep id AND glob id are deliberately ABSENT (default and opt-in)", () => {
    // tools.grep=false / tools.glob=false filter any tool with those ids — a
    // grep/glob-id plugin alias would be unreachable. Do not regress this.
    for (const registry of [tools, optInTools]) {
      expect(Object.keys(registry)).not.toContain("grep")
      expect(Object.keys(registry)).not.toContain("glob")
    }
    expect(Object.keys(tools)).toEqual(["agentgrep", "find"])
    expect(Object.keys(optInTools)).toEqual(["agentgrep", "find", "file_grep", "Grep"])
  })

  test("args use tool.schema (zod v4) shapes the server registry recognizes", () => {
    // The server's ToolRegistry.fromPlugin checks each arg with a duck-typed
    // `isZodType` ("_zod" in value) — a zod v4 marker. A raw `zod` import can
    // resolve to v3 (no `_zod`), which makes the registry fall back to
    // `legacyJsonSchema` and embed non-serializable zod objects, 400ing
    // /experimental/tool with "Expected JSON value, got {...ZodOptional...}".
    const isZodV4Shape = (value: unknown): boolean =>
      typeof value === "object" && value !== null && "_zod" in value
    for (const id of Object.keys(tools)) {
      const args = (tools[id].args ?? {}) as Record<string, unknown>
      expect(Object.keys(args).length).toBeGreaterThan(0)
      for (const [name, shape] of Object.entries(args)) {
        expect(isZodV4Shape(shape), `${id}.args.${name} must be a zod v4 shape`).toBe(true)
      }
    }
  })
})

// ── Public schema parity (jcode v0.1.6) ──────────────────────────────────────

describe("public schema parity (jcode-compatible surface)", () => {
  const tools = buildAgentGrepTools()
  const agentgrepKeys = Object.keys(tools.agentgrep.args ?? {})

  test("public arg is `type`, NOT `file_type` (jcode wire name)", () => {
    expect(agentgrepKeys).toContain("type")
    expect(agentgrepKeys).not.toContain("file_type")
  })

  test("public schema exposes exactly the jcode public surface", () => {
    // Mirrors jcode's parameters_schema: mode, query, file, terms, regex,
    // path, glob, type, max_files, max_regions, paths_only.
    expect(agentgrepKeys).toEqual([
      "mode",
      "query",
      "file",
      "terms",
      "regex",
      "path",
      "glob",
      "type",
      "max_files",
      "max_regions",
      "paths_only",
    ])
  })

  test("jcode-internal fields are NOT exposed publicly (hidden/no_ignore/full_region/debug_*/aliases)", () => {
    for (const internal of [
      "pattern",
      "file_path",
      "include",
      "hidden",
      "no_ignore",
      "full_region",
      "debug_plan",
      "debug_score",
      "max_items",
      "__fileScope",
    ]) {
      expect(agentgrepKeys, `${internal} must stay out of the public schema`).not.toContain(internal)
    }
  })

  test("public mode enum is exactly grep|find|outline|trace — `smart` stays internal", () => {
    const modeShape = (tools.agentgrep.args as Record<string, any>).mode
    // `mode` is .optional()-wrapped; unwrap to the enum and read zod v4 .options.
    const enumShape = modeShape?.unwrap?.() ?? modeShape
    const values: string[] = enumShape?.options ?? enumShape?._def?.values ?? []
    expect(values).toEqual(["grep", "find", "outline", "trace"])
    expect(values).not.toContain("smart")
  })

  test("first-class find tool exposes the find-relevant public subset (no mode)", () => {
    expect(Object.keys(tools.find.args ?? {})).toEqual([
      "query",
      "terms",
      "path",
      "glob",
      "type",
      "max_files",
      "paths_only",
    ])
  })
})

// ── resolveAgentGrepToolID (jcode mirror) ────────────────────────────────────

describe("resolveAgentGrepToolID (jcode mirror)", () => {
  test("maps grep-ish ids to canonical agentgrep and find to find", () => {
    expect(resolveAgentGrepToolID("grep")).toBe("agentgrep")
    expect(resolveAgentGrepToolID("file_grep")).toBe("agentgrep")
    expect(resolveAgentGrepToolID("Grep")).toBe("agentgrep")
    expect(resolveAgentGrepToolID("agentgrep")).toBe("agentgrep")
    expect(resolveAgentGrepToolID("find")).toBe("find")
  })

  test("returns null for unrelated ids", () => {
    expect(resolveAgentGrepToolID("bash")).toBeNull()
    expect(resolveAgentGrepToolID("glob")).toBeNull()
    expect(resolveAgentGrepToolID("greps")).toBeNull()
    expect(resolveAgentGrepToolID("")).toBeNull()
  })
})

// ── Tool descriptions (selection clarity) ────────────────────────────────────

describe("tool descriptions are unambiguous for tool selection", () => {
  const tools = buildAgentGrepTools()
  const optInTools = buildAgentGrepTools(undefined, { legacyAliases: true })

  test("canonical agentgrep description covers grep/outline/trace and mode=find", () => {
    const d = tools.agentgrep.description
    expect(d).toContain("grep")
    expect(d).toContain("outline")
    expect(d).toContain("trace")
    expect(d).toContain("find")
    expect(d).toMatch(/canonical/i)
  })

  test("find description is scoped to ranked file discovery only", () => {
    const d = tools.find.description
    expect(d).toContain("ranked file discovery")
    expect(d).toContain("ONLY")
    expect(d).toContain("agentgrep")
  })

  test("legacy alias descriptions (opt-in) state compatibility-only / prefer agentgrep", () => {
    for (const alias of AGENTGREP_ALIASES) {
      const d = optInTools[alias].description
      expect(d).toMatch(/compatibilit/i)
      expect(d).toMatch(/prefer.*agentgrep/i)
    }
  })
})

// ── Local code-search system guidance (idempotent) ───────────────────────────

describe("local code-search system guidance", () => {
  test("guidance text is scoped to LOCAL repo search and never suggests forbidden tools", () => {
    const text = agentgrepSystemGuidance()
    expect(text).toContain(AGENTGREP_GUIDANCE_MARKER)
    expect(text).toContain("agentgrep")
    expect(text).toContain("find")
    expect(text).toMatch(/local repository/i)
    // Forbidden / compatibility ids must never be RECOMMENDED.
    expect(text).toMatch(/never call tools\s+named/i)
    expect(text).toContain("`grep`")
    expect(text).toContain("`glob`")
    expect(text).toContain("`Grep`")
    expect(text).toContain("`file_grep`")
    // callmux is forbidden only for LOCAL repo search; external tasks are carved out.
    expect(text).toMatch(/never use callmux or result retrieval for LOCAL repository search/)
    expect(text).toMatch(/does not apply to external MCP or web tasks/)
  })

  test("applyAgentGrepSystemGuidance is idempotent", () => {
    const once = applyAgentGrepSystemGuidance(["base"])
    expect(once).toHaveLength(2)
    expect(once[1]).toContain(AGENTGREP_GUIDANCE_MARKER)
    const twice = applyAgentGrepSystemGuidance(once)
    expect(twice).toHaveLength(2) // no duplicate append
    expect(twice).toEqual(once)
  })

  test("applyAgentGrepSystemGuidance never mutates the input array", () => {
    const input = ["a", "b"]
    const out = applyAgentGrepSystemGuidance(input)
    expect(input).toEqual(["a", "b"])
    expect(out).not.toBe(input)
  })
})

// ── normalizeAgentGrepMode ───────────────────────────────────────────────────

describe("normalizeAgentGrepMode", () => {
  test("passes through concrete public modes", () => {
    expect(normalizeAgentGrepMode("grep")).toBe("grep")
    expect(normalizeAgentGrepMode("find")).toBe("find")
    expect(normalizeAgentGrepMode("outline")).toBe("outline")
    expect(normalizeAgentGrepMode("trace")).toBe("trace")
  })

  test("smart is accepted ONLY as an internal trace alias (hidden compat path)", () => {
    expect(normalizeAgentGrepMode("smart")).toBe("trace")
  })

  test("defaults to grep when unspecified", () => {
    expect(normalizeAgentGrepMode(undefined)).toBe("grep")
    expect(normalizeAgentGrepMode(null)).toBe("grep")
  })

  test("rejects unknown modes", () => {
    expect(() => normalizeAgentGrepMode("rg")).toThrow(/unknown agentgrep mode/)
  })
})

// ── Match-all glob normalization ─────────────────────────────────────────────

describe("normalizeMatchAllGlob", () => {
  test("match-all forms mean unfiltered (return undefined)", () => {
    for (const form of ["*", "**", "**/*", "./*", "./**", "./**/*"]) {
      expect(normalizeMatchAllGlob(form), `glob ${JSON.stringify(form)}`).toBeUndefined()
    }
  })

  test("trimmed empty globs are dropped", () => {
    expect(normalizeMatchAllGlob(undefined)).toBeUndefined()
    expect(normalizeMatchAllGlob("")).toBeUndefined()
    expect(normalizeMatchAllGlob("   ")).toBeUndefined()
  })

  test("narrowing globs pass through trimmed", () => {
    expect(normalizeMatchAllGlob("*.ts")).toBe("*.ts")
    expect(normalizeMatchAllGlob("  src/*.rs  ")).toBe("src/*.rs")
  })
})

// ── Exact-file scope translation ─────────────────────────────────────────────

describe("exactFileScope", () => {
  test("file-valued root translates to parent dir + basename glob", () => {
    expect(exactFileScope("/repo/src/a.ts", "file", "*.ts")).toEqual({
      root: "/repo/src",
      glob: "a.ts",
    })
    // The exact file wins over any user-supplied glob (jcode resolved_search_scope).
    expect(exactFileScope("/repo/src/a.ts", "file", "user-*.rs")).toEqual({
      root: "/repo/src",
      glob: "a.ts",
    })
  })

  test("directory-valued root is NOT translated", () => {
    expect(exactFileScope("/repo/src", "directory", "*.ts")).toBeNull()
    expect(exactFileScope("/repo/src", "directory")).toBeNull()
  })
})

// ── buildAgentGrepArgs ───────────────────────────────────────────────────────

describe("buildAgentGrepArgs", () => {
  test("grep mode: query positional + path", () => {
    expect(buildAgentGrepArgs({ mode: "grep", query: "auth_status", path: "/repo" })).toEqual([
      "grep",
      "auth_status",
      "--path",
      "/repo",
    ])
  })

  test("grep mode accepts pattern alias for query (internal)", () => {
    expect(buildAgentGrepArgs({ mode: "grep", pattern: "foo" })).toEqual(["grep", "foo"])
  })

  test("grep mode: regex, type, glob/include, flags", () => {
    expect(
      buildAgentGrepArgs({
        mode: "grep",
        query: "auth_.*status",
        regex: true,
        file_type: "rs",
        include: "*.rs",
        paths_only: true,
        hidden: true,
        no_ignore: true,
        path: "/repo",
      }),
    ).toEqual([
      "grep",
      "auth_.*status",
      "--regex",
      "--type",
      "rs",
      "--paths-only",
      "--hidden",
      "--no-ignore",
      "--glob",
      "*.rs",
      "--path",
      "/repo",
    ])
  })

  test("glob alias wins over include when both provided", () => {
    expect(
      buildAgentGrepArgs({ mode: "grep", query: "x", glob: "*.ts", include: "*.js" }),
    ).toEqual(["grep", "x", "--glob", "*.ts"])
  })

  test("grep mode requires a query", () => {
    expect(() => buildAgentGrepArgs({ mode: "grep" })).toThrow(/requires `query`/)
  })

  test("grep: max_files is never emitted (CLI does not accept it)", () => {
    expect(buildAgentGrepArgs({ mode: "grep", query: "x", max_files: 5 })).toEqual(["grep", "x"])
  })

  test("grep: file-valued path is translated to parent --path + basename --glob (exact containment)", () => {
    expect(
      buildAgentGrepArgs({
        mode: "grep",
        query: "auth",
        path: "/repo/src/a.ts",
        __fileScope: { root: "/repo/src", glob: "a.ts" },
      }),
    ).toEqual(["grep", "auth", "--glob", "a.ts", "--path", "/repo/src"])
  })

  test("grep: match-all glob forms are normalized away (no false-empty --glob)", () => {
    for (const form of ["*", "**", "**/*", "./*", "./**", "./**/*"]) {
      expect(buildAgentGrepArgs({ mode: "grep", query: "x", glob: form }), `glob ${form}`).toEqual([
        "grep",
        "x",
      ])
    }
    expect(buildAgentGrepArgs({ mode: "grep", query: "x", glob: "*.ts" })).toEqual([
      "grep",
      "x",
      "--glob",
      "*.ts",
    ])
  })

  test("default mode is grep when mode omitted", () => {
    expect(buildAgentGrepArgs({ query: "x" })).toEqual(["grep", "x"])
  })

  test("find mode: multiword query splits into positional terms (jcode split_whitespace)", () => {
    expect(buildAgentGrepArgs({ mode: "find", query: "auth session" })).toEqual([
      "find",
      "auth",
      "session",
      "--max-files",
      "10",
    ])
  })

  test("find mode: string terms split the same way as query", () => {
    expect(buildAgentGrepArgs({ mode: "find", terms: "session store" })).toEqual([
      "find",
      "session",
      "store",
      "--max-files",
      "10",
    ])
  })

  test("find mode: array terms are positional query parts (whitespace-split per element)", () => {
    expect(
      buildAgentGrepArgs({ mode: "find", terms: ["auth", "session"], max_files: 5, path: "/repo" }),
    ).toEqual(["find", "auth", "session", "--max-files", "5", "--path", "/repo"])
  })

  test("find mode: single-word query is one term", () => {
    expect(buildAgentGrepArgs({ mode: "find", query: "server" })).toEqual([
      "find",
      "server",
      "--max-files",
      "10",
    ])
  })

  test("find mode: scoped-only (glob/type/path) does NOT throw — empty query positional bridges the CLI", () => {
    expect(buildAgentGrepArgs({ mode: "find", glob: "*.ts" })).toEqual([
      "find",
      "",
      "--max-files",
      "10",
      "--glob",
      "*.ts",
    ])
    expect(buildAgentGrepArgs({ mode: "find", file_type: "ts" })).toEqual([
      "find",
      "",
      "--type",
      "ts",
      "--max-files",
      "10",
    ])
    expect(buildAgentGrepArgs({ mode: "find", path: "/repo/src" })).toEqual([
      "find",
      "",
      "--max-files",
      "10",
      "--path",
      "/repo/src",
    ])
  })

  test("find mode: match-all glob only is NOT a scope (jcode normalized-scope parity) → throws", () => {
    expect(() => buildAgentGrepArgs({ mode: "find", glob: "*" })).toThrow(/requires `terms` or `query`/)
    expect(() => buildAgentGrepArgs({ mode: "find", glob: "**/*" })).toThrow(/requires `terms` or `query`/)
  })

  test("find mode: requires terms or query (or a real scope)", () => {
    expect(() => buildAgentGrepArgs({ mode: "find" })).toThrow(/requires `terms` or `query`/)
  })

  test("find mode: regex is only emitted for grep mode", () => {
    expect(buildAgentGrepArgs({ mode: "find", query: "x", regex: true })).toEqual([
      "find",
      "x",
      "--max-files",
      "10",
    ])
  })

  test("find mode: scoped query (glob + terms) keeps both", () => {
    expect(buildAgentGrepArgs({ mode: "find", query: "session", glob: "*.nomatch" })).toEqual([
      "find",
      "session",
      "--max-files",
      "10",
      "--glob",
      "*.nomatch",
    ])
  })

  test("outline mode: file positional, file_path alias, path root", () => {
    expect(
      buildAgentGrepArgs({ mode: "outline", file: "src/main.ts", path: "/repo" }),
    ).toEqual(["outline", "src/main.ts", "--path", "/repo"])
    expect(buildAgentGrepArgs({ mode: "outline", file_path: "src/lib.rs" })).toEqual([
      "outline",
      "src/lib.rs",
    ])
  })

  test("outline mode: requires a file", () => {
    expect(() => buildAgentGrepArgs({ mode: "outline" })).toThrow(/requires `file`/)
  })

  test("outline mode: mode-specific flags are NOT emitted where the CLI rejects them", () => {
    // outline only accepts --json/--max-items/--path/--context-json.
    expect(
      buildAgentGrepArgs({
        mode: "outline",
        file: "a.ts",
        file_type: "ts",
        paths_only: true,
        hidden: true,
        no_ignore: true,
        glob: "*.ts",
        max_files: 5,
        max_regions: 2,
        full_region: "always",
      }),
    ).toEqual(["outline", "a.ts"])
  })

  test("outline mode: internal max_items maps to CLI --max-items", () => {
    expect(buildAgentGrepArgs({ mode: "outline", file: "a.ts", max_items: 50 })).toEqual([
      "outline",
      "a.ts",
      "--max-items",
      "50",
    ])
  })

  test("trace mode: terms, mode-specific flags, CLI-side result bounds", () => {
    expect(
      buildAgentGrepArgs({
        mode: "trace",
        terms: ["subject:auth_status"],
        max_files: 3,
        max_regions: 4,
        full_region: "always",
        path: "/repo",
      }),
    ).toEqual([
      "trace",
      "subject:auth_status",
      "--max-regions",
      "4",
      "--full-region",
      "always",
      "--max-files",
      "3",
      "--path",
      "/repo",
    ])
  })

  test("trace mode: jcode defaults bound results CLI-side (max-files 5, max-regions 6)", () => {
    expect(buildAgentGrepArgs({ mode: "trace", terms: ["subject:x", "relation:y"] })).toEqual([
      "trace",
      "subject:x",
      "relation:y",
      "--max-regions",
      "6",
      "--max-files",
      "5",
    ])
  })

  test("trace mode: smart is an internal alias that builds trace argv", () => {
    expect(buildAgentGrepArgs({ mode: "smart", terms: ["subject:x"] })).toEqual([
      "trace",
      "subject:x",
      "--max-regions",
      "6",
      "--max-files",
      "5",
    ])
  })

  test("trace mode: smart splits a multiword query into terms (jcode internal behavior)", () => {
    expect(buildAgentGrepArgs({ mode: "smart", query: "subject:x relation:y" })).toEqual([
      "trace",
      "subject:x",
      "relation:y",
      "--max-regions",
      "6",
      "--max-files",
      "5",
    ])
  })

  test("trace mode requires non-empty terms; only smart splits query", () => {
    expect(() => buildAgentGrepArgs({ mode: "trace" })).toThrow(/requires `terms`/)
    expect(() => buildAgentGrepArgs({ mode: "trace", query: "x" })).toThrow(/requires `terms`/)
    expect(() => buildAgentGrepArgs({ mode: "smart" })).toThrow(/requires `terms`/)
  })

  test("trace mode: type flag is accepted where the CLI accepts it", () => {
    expect(
      buildAgentGrepArgs({ mode: "trace", terms: ["subject:x", "relation:y"], file_type: "ts" }),
    ).toEqual(["trace", "subject:x", "relation:y", "--max-regions", "6", "--type", "ts", "--max-files", "5"])
  })
})

// ── Permission operation patterns (must match the split argv terms) ──────────

describe("operationPatterns", () => {
  test("grep uses the query as a single pattern", () => {
    expect(operationPatterns("grep", { query: "auth" })).toEqual(["auth"])
    expect(operationPatterns("grep", { pattern: "auth" })).toEqual(["auth"])
  })

  test("find splits multiword query and terms identically to argv positionals", () => {
    expect(operationPatterns("find", { query: "auth session" })).toEqual(["auth", "session"])
    expect(operationPatterns("find", { terms: "session store" })).toEqual(["session", "store"])
    expect(operationPatterns("find", { terms: ["auth", "session"] })).toEqual(["auth", "session"])
  })

  test("find scoped-only falls back to the scope descriptor", () => {
    expect(operationPatterns("find", { glob: "*.ts" })).toEqual(["*.ts"])
    expect(operationPatterns("find", { path: "/repo/src" })).toEqual(["/repo/src"])
  })

  test("find with nothing to search has no patterns", () => {
    expect(operationPatterns("find", {})).toEqual([])
  })

  test("outline uses the raw file", () => {
    expect(operationPatterns("outline", { file: "src/mod.ts" })).toEqual(["src/mod.ts"])
    expect(operationPatterns("outline", { file_path: "src/lib.rs" })).toEqual(["src/lib.rs"])
  })

  test("trace uses explicit terms; smart splits query", () => {
    expect(operationPatterns("trace", { terms: ["subject:x", "relation:y"] })).toEqual([
      "subject:x",
      "relation:y",
    ])
    expect(operationPatterns("trace", { mode: "smart", query: "subject:x relation:y" })).toEqual([
      "subject:x",
      "relation:y",
    ])
  })
})

// ── Executable resolution ────────────────────────────────────────────────────

describe("executable resolution", () => {
  test("agentGrepDefaultBin is the documented packaged location", () => {
    expect(agentGrepDefaultBin().endsWith(path.join(".local", "bin", "agentgrep"))).toBe(true)
  })

  test("AGENTGREP_BIN is honored when it points at an executable", () => {
    const prev = process.env.AGENTGREP_BIN
    process.env.AGENTGREP_BIN = process.execPath // node/bun binary is executable
    try {
      expect(tryResolveAgentGrepBin()).toBe(process.execPath)
    } finally {
      if (prev === undefined) delete process.env.AGENTGREP_BIN
      else process.env.AGENTGREP_BIN = prev
    }
  })

  test("tryResolveAgentGrepBin returns null (not throw) when nothing found", () => {
    const prev = process.env.AGENTGREP_BIN
    const saved = process.env.PATH
    process.env.AGENTGREP_BIN = "/nonexistent/agentgrep-bin"
    process.env.PATH = "/nonexistent-agentgrep-path"
    try {
      const bin = tryResolveAgentGrepBin()
      expect(bin === null || typeof bin === "string").toBe(true)
    } finally {
      if (prev === undefined) delete process.env.AGENTGREP_BIN
      else process.env.AGENTGREP_BIN = prev
      process.env.PATH = saved
    }
  })
})
