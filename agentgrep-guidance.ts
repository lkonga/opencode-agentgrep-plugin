// agentgrep-guidance — pure, idempotent LOCAL repository code-search guidance
// for the system prompt. Wired in via the `experimental.chat.system.transform`
// hook from index.ts (the typed single default export).
//
// Scope is deliberately narrow: it only tells the model which tool to use for
// LOCAL repository code search. It recommends only canonical `agentgrep`,
// forbids native and compatibility ids, and explicitly carves out external MCP/
// web tasks so callmux behavior is untouched for those.
//
// Idempotent: `applyAgentGrepSystemGuidance` appends the guidance only once,
// keyed on a stable marker line, so repeated hook invocations never duplicate.
//
// ⚠️ NOT a plugin entrypoint. Only index.ts is loaded by OpenCode as a server
// plugin; tui.ts is a separate TUI facade.

/** Stable marker that makes the guidance append idempotent. */
export const AGENTGREP_GUIDANCE_MARKER = "agentgrep:local-code-search-guidance"

/**
 * The guidance text injected into the system prompt. Scoped to local repository
 * code search; explicitly defers to callmux for external MCP/web tasks.
 */
export function agentgrepSystemGuidance(): string {
  return [
    AGENTGREP_GUIDANCE_MARKER,
    "For LOCAL repository code search, use the `agentgrep` tool for exact lexical search",
    "(mode=grep), file outlines (mode=outline), and relationship traces (mode=trace); it can",
    "also do ranked file discovery with mode=find. `agentgrep` is the canonical local search",
    "tool. Never call tools named `find`, `grep`, `glob`, `Grep`, or `file_grep` for local",
    "repository search, and never use callmux or result retrieval for LOCAL repository search.",
    "This guidance does not apply to external MCP or web tasks, where callmux remains available.",
  ].join("\n")
}

/**
 * Append the local code-search guidance to a system prompt idempotently.
 * Never mutates the input array. No-op when the marker is already present.
 */
export function applyAgentGrepSystemGuidance(system: string[]): string[] {
  if (system.some((line) => line.includes(AGENTGREP_GUIDANCE_MARKER))) return system
  return [...system, agentgrepSystemGuidance()]
}
