// agentgrep-context — the harness context adapter's orchestration layer.
//
// `createAgentGrepContextProvider(pluginInput)` builds a provider that, given
// a tool input + ToolContext + effective search root, returns the serialized
// harness context JSON (or null) for trace/smart/outline executions.
//
// Precedence (mirrors the remediation contract):
//   1. `session.context` — the v2 post-compaction ACTIVE context endpoint
//      ("all messages after the last compaction"), preferred. Used only for the
//      exact `ctx.sessionID`; records that explicitly claim another session are
//      dropped by the normalizer. Feature-detect on whatever client is
//      injected; when the injected v1 client (1.18.21) lacks `session.context`,
//      lazily create a v2 SDK client from `PluginInput.serverUrl`.
//   2. `session.messages` — bounded cursor pagination + shape normalization
//      (v1 `{ info, parts }`, `{ data: [...] }`, arrays, projected v2).
//   3. Guarded SQLite fallback (exact session + directory validation, bounded,
//      read-only) only when neither SDK path yields usable data.
//
// Fail-closed: malformed / missing / throwing / oversized / out-of-session
// inputs all degrade to null (no context). The provider never throws, and
// building context can never affect permission/path/search behavior.
//
// ⚠️ NOT a plugin entrypoint. Only index.ts is loaded by OpenCode.

import type { ToolContext } from "@opencode-ai/plugin"
import type { PluginInput } from "@opencode-ai/plugin"
import type { AgentGrepInput } from "./agentgrep-types"
import { normalizeAgentGrepMode } from "./agentgrep-types"
import {
  createV2ClientFromServerUrl,
  fetchSessionContext,
  fetchSessionMessages,
  hasSessionContext,
  type ClientShim,
} from "./agentgrep-context-sdk"
import { normalizeContextMessages, type NormalizedContextMessage } from "./agentgrep-context-schema"
import { buildHarnessContext, serializeHarnessContext } from "./agentgrep-context-build"
import { sqliteFallbackMessages } from "./agentgrep-context-sqlite"

export interface AgentGrepContextProvider {
  /**
   * Best-effort serialized harness JSON for this invocation. Returns null when
   * the mode is not context-capable (grep/find), when no usable exposure is
   * found, when malformed/oversized/out-of-session, or on any error. Never
   * throws and never affects permission or path resolution.
   */
  getHarnessJson(input: AgentGrepInput, ctx: ToolContext, searchRoot: string): Promise<string | null>
}

function toClientShim(pluginInput: PluginInput | null | undefined): ClientShim | null {
  return (pluginInput?.client ?? null) as ClientShim | null
}

/**
 * Diagnostics seam (default off). Emits ONLY non-sensitive counts and source
 * names — never context content, temp paths, or model-visible detail. Gated by
 * $AGENTGREP_CONTEXT_DEBUG so normal runs stay silent (the requirements forbid
 * leaking context/temp content through logs or tool results).
 */
function debug(...args: unknown[]): void {
  try {
    if (process.env.AGENTGREP_CONTEXT_DEBUG === "1") {
      // eslint-disable-next-line no-console
      console.error("[agentgrep-context]", ...args)
    }
  } catch {
    // ignore
  }
}

function logOnce(_source: string, _note: string): void {
  // Intentionally silent. Enable only for local debugging; the requirements
  // forbid leaking context/temp content through logs or tool results.
}

function buildJsonFromMessages(
  messages: NormalizedContextMessage[],
  searchRoot: string,
): string | null {
  const context = buildHarnessContext({ messages, searchRoot })
  if (context) {
    debug(
      "built",
      `files=${context.known_files.length}`,
      `regions=${context.known_regions.length}`,
      `symbols=${context.known_symbols.length}`,
      `focus=${context.focus_files.length}`,
    )
  } else {
    debug("built", "null (no usable exposures)")
  }
  return serializeHarnessContext(context)
}

/**
 * Provider factory. `pluginInput` may be absent (tests / structural usage) —
 * then no SDK client exists and only a best-effort SQLite fallback can apply,
 * which in practice yields null. Threading the plugin input through the tool
 * closure is what enables SDK-backed context.
 */
export function createAgentGrepContextProvider(
  pluginInput?: PluginInput | null,
): AgentGrepContextProvider {
  const injected = toClientShim(pluginInput)
  let v2Promise: Promise<ClientShim | null> | null = null
  const getV2Client = (): Promise<ClientShim | null> => {
    if (!pluginInput?.serverUrl) return Promise.resolve(null)
    v2Promise ??= createV2ClientFromServerUrl(pluginInput.serverUrl)
    return v2Promise
  }

  async function trySdkContext(
    sessionID: string,
    searchRoot: string,
  ): Promise<string | null> {
    // (a) Injected client feature-detected context; (b) else a v2 client from
    // serverUrl (lazily). Post-compaction active data is preferred.
    const injectedHasCtx = injected ? hasSessionContext(injected) : false
    const client = injectedHasCtx ? injected : await getV2Client()
    if (!client || !hasSessionContext(client)) {
      debug("context: no context-capable client")
      return null
    }
    const { payload, error } = await fetchSessionContext(client, sessionID)
    if (payload == null) {
      debug("context: fetch returned null/unusable", error ? `error=${error}` : "")
      return null
    }
    const normalized = normalizeContextMessages(payload, { sessionID, fromActiveContext: true })
    debug("context: fetched", `messages=${normalized.messages.length}`, `skipped=${normalized.skipped}`)
    if (normalized.messages.length === 0) return null
    return buildJsonFromMessages(normalized.messages, searchRoot)
  }

  async function trySdkMessages(
    sessionID: string,
    searchRoot: string,
  ): Promise<string | null> {
    const client = injected ?? (await getV2Client())
    if (!client) {
      debug("messages: no client")
      return null
    }
    const { payload, pagesFetched, error } = await fetchSessionMessages(client, sessionID)
    debug("messages: fetch", `pages=${pagesFetched}`, `payload=${payload == null ? "null" : "ok"}`, error ? `error=${error}` : "")
    if (payload == null) return null
    const normalized = normalizeContextMessages(payload, { sessionID, fromActiveContext: false })
    debug("messages: normalized", `messages=${normalized.messages.length}`, `skipped=${normalized.skipped}`, `truncated=${normalized.truncated}`)
    if (normalized.messages.length === 0) return null
    return buildJsonFromMessages(normalized.messages, searchRoot)
  }

  return {
    async getHarnessJson(input, ctx, searchRoot) {
      try {
        // Context is only representable for trace/smart/outline (jcode parity).
        const mode = normalizeAgentGrepMode(input.mode)
        if (mode !== "trace" && mode !== "outline") return null
        const sessionID = ctx.sessionID
        if (!sessionID || typeof sessionID !== "string") return null
        // Cheap reusable guard: a degenerate search root means nothing to seed.
        if (!searchRoot || typeof searchRoot !== "string") return null

        // 1) Preferred: post-compaction active context.
        if (injected || pluginInput?.serverUrl) {
          const fromCtx = await trySdkContext(sessionID, searchRoot)
          if (fromCtx !== null) return fromCtx
        }

        // 2) Bounded session messages with shape normalization.
        if (pluginInput) {
          const fromMessages = await trySdkMessages(sessionID, searchRoot)
          if (fromMessages !== null) return fromMessages
        }

        // 3) Guarded SQLite fallback (exact session + directory validated).
        const fallback = sqliteFallbackMessages(
          sessionID,
          [ctx.directory, ctx.worktree],
          undefined,
        )
        if (fallback && fallback.messages.length > 0) {
          // Rebuild v1 { info, parts } records through the normalizer.
          const normalized = normalizeContextMessages(fallback.messages, {
            sessionID,
            fromActiveContext: false,
          })
          if (normalized.messages.length > 0) {
            const json = buildJsonFromMessages(normalized.messages, searchRoot)
            if (json !== null) return json
          }
        }

        return null
      } catch (err) {
        logOnce("getHarnessJson", String((err as Error)?.message ?? err))
        return null
      }
    },
  }
}