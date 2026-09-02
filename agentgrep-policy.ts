// agentgrep-policy — config-policy helper for the standalone agentgrep plugin.
//
// OpenCode's built-in tool registry normalization happens before the plugin
// config hook runs, so legacy `config.tools.grep = false` / `config.tools.glob
// = false` is too late to prevent grep/glob from being advertised via
// /experimental/tool and /experimental/tool/ids.
//
// This module provides an authoritative "deny" PERMISSION policy at two levels:
//   1. Global `config.permission` — an explicit `grep: "deny"` / `glob: "deny"`
//      entry that overrides any default "ask" or "allow" for those tool ids.
//   2. Every explicitly configured agent's `permission` block — agents can
//      supersede global permissions, so we harden each one individually.
//
// The combined effect: resolveTools / PermissionNext.disabled() removes
// grep/glob from the model-request payload even though the HTTP introspection
// endpoints still advertise them (those endpoints show all registered
// built-in tools unfiltered). Model-choice assertions in the smoke script
// verify the actual request payload, not the registry.
//
// Unrelated permissions, settings, and order are preserved. Existing denials
// are never weakened (already "deny" stays "deny").
//
// ⚠️ This module is NOT a plugin entrypoint. Only index.ts may be loaded by
// OpenCode, and it must export exactly one function (the default plugin fn).

/**
 * Mutate the plugin Config in-place to apply the authoritative grep/glob deny
 * policy. Must be called inside the `config` hook.
 *
 * @param config - The mutable Config object from the hook.
 * @param denyTools - Array of tool ids to deny (default ["grep", "glob"])
 */
export function applyAgentGrepPolicy(
  config: Record<string, any>,
  denyTools: string[] = ["grep", "glob"],
): void {
  // ── 1. Global permission block ────────────────────────────────────────
  config.permission ??= {}
  for (const id of denyTools) {
    // Never weaken an existing "deny".
    if (config.permission[id] !== "deny") {
      config.permission[id] = "deny"
    }
  }

  // ── 2. Legacy tools.grep / tools.glob = false (still honored by resolveTools) ──
  config.tools ??= {}
  for (const id of denyTools) {
    if (config.tools[id] !== false) {
      config.tools[id] = false
    }
  }

  // ── 3. Every explicitly configured agent ──────────────────────────────
  if (config.agent && typeof config.agent === "object" && !Array.isArray(config.agent)) {
    for (const agentName of Object.keys(config.agent)) {
      const agent = config.agent[agentName]
      if (!agent || typeof agent !== "object") continue
      agent.permission ??= {}
      for (const id of denyTools) {
        if (agent.permission[id] !== "deny") {
          agent.permission[id] = "deny"
        }
      }
    }
  }
}