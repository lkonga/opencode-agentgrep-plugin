// agentgrep-context-sdk — compatibility-safe structural shims over the OpenCode
// SDK clients for the harness context adapter.
//
// The plugin's injected `PluginInput.client` is the v1 SDK client
// (`@opencode-ai/sdk` createOpencodeClient). On 1.18.21 it exposes
// `client.session.messages` (v1 shape: `messages({ path: { id }, query: { limit } })`
// → `Array<{ info, parts }>`) but NO `session.context`. The v2 SDK client
// (`@opencode-ai/sdk/v2/client`) adds `client.v2.session.context({ sessionID })`
// — the post-compaction ACTIVE context endpoint ("all messages after the last
// compaction") — plus `client.v2.session.messages({ sessionID, limit, order,
// cursor })` whose response payload is `{ data, cursor: { previous?, next? } }`
// (items keep the requested order across pages; move with cursor.next).
//
// This module therefore:
//   1. feature-detects `session.context` / `session.messages` on whatever
//      client object is actually injected (duck-typed, so future hosts that
//      inject a context-capable client are used directly);
//   2. lazily creates a v2 client from `PluginInput.serverUrl` (compat-safe:
//      creation and every call are guarded, so a missing/unreachable server or
//      an absent dependency is a graceful null, never a throw into the tool);
//   3. fetches with bounded cursor pagination and returns RAW payloads that the
//      pure schema normalizer (`agentgrep-context-schema.ts`) converts.
//
// Pagination safety: page arrays are consumed into a message + UTF-8 byte
// budget BEFORE pushing (no unbounded `all.push(...page)`), cursors are
// tracked with a seen-guard against loops, and every page stops at the caps.
//
// Error reporting: failures are reported as FIXED categories
// (`context_request_failed` / `messages_request_failed`) — never raw SDK
// exception text, URLs, paths, session ids, refs, or response bodies.
//
// Nothing here touches the filesystem. Nothing here throws at callers.
//
// ⚠️ NOT a plugin entrypoint. Only index.ts is loaded by OpenCode.

import { CONTEXT_CAP_MESSAGES, CONTEXT_CAP_PAGES, CONTEXT_CAP_SOURCE_BYTES } from "./agentgrep-context-caps"
import { boundedUtf8Bytes } from "./agentgrep-context-bytes"
import { unwrapResult } from "./agentgrep-context-schema"

// ── Structural shims (duck-typed, minimal) ───────────────────────────────────

/** A session namespace exposing v2-style methods (flat sessionID params). */
export interface V2SessionShim {
  context?: (args: { sessionID: string }) => unknown | Promise<unknown>
  messages?: (args: {
    sessionID: string
    limit?: number
    order?: "asc" | "desc"
    cursor?: string
  }) => unknown | Promise<unknown>
}

/** A session namespace exposing v1-style methods (path/query params). */
export interface V1SessionShim {
  messages?: (args: {
    path: { id: string }
    query?: { limit?: number }
  }) => unknown | Promise<unknown>
}

/**
 * Union of session-namespace shapes a client may expose. Feature detection
 * never assumes a method exists; it checks `typeof` first.
 */
export type SessionClientShim = V1SessionShim | V2SessionShim

export interface ClientShim {
  /**
   * Injected SDK client namespace. On 1.18.21 this is the v1 client
   * (`messages({ path, query })`); future hosts may inject a v2-shaped
   * namespace that also carries `context`, so it is typed as the union and
   * feature-detected.
   */
  session?: SessionClientShim
  /** v2 SDK client tree (may be absent on hosts without a v2 client). */
  v2?: { session?: V2SessionShim }
}

/**
 * Fixed, safe error categories for SDK fetch failures. NEVER raw exception
 * text, URLs, paths, session ids, refs, or response bodies.
 */
export type SdkFetchError = "context_request_failed" | "messages_request_failed"

export interface SdkMessagesResult {
  /** RAW concatenated payload (bounded). */
  payload: unknown
  pagesFetched: number
  /** True when the message/byte budgets cut the fetch short. */
  truncated?: boolean
  /** Fixed failure category when the underlying call failed. */
  error?: SdkFetchError
}

export interface SdkContextResult {
  payload: unknown
  error?: SdkFetchError
}

/**
 * Narrow a session namespace to the v1 `{ path, query }` messages shape (the
 * injected v1 client's documented method). This is a member-of-union
 * structural cast at the API boundary — no `any` — and the returned namespace
 * is the SAME object, so invocations stay `this`-bound (hey-api clients rely
 * on `this._client`; detached calls throw).
 */
export function v1MessagesOf(ns: SessionClientShim | undefined): V1SessionShim | null {
  if (!ns) return null
  const v1 = ns as V1SessionShim
  return typeof v1.messages === "function" ? v1 : null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Normalize the result of a duck-typed SDK call. Unwraps only genuine
 * hey-api "fields"-style envelopes (`{ data, error, request|response }`) so a
 * bare `{ data: [...] }` payload (the v2 context response) stays intact.
 */
export function normalizeSdkResult(res: unknown): unknown {
  return unwrapResult(res)
}

/** Feature-detect a `context` method (v2 tree preferred, injected fallback). */
export function hasSessionContext(client: ClientShim | null | undefined): boolean {
  return (
    typeof client?.v2?.session?.context === "function" ||
    typeof (client?.session as V2SessionShim | undefined)?.context === "function"
  )
}

/** Feature-detect a `messages` method on either session namespace. */
export function hasSessionMessages(client: ClientShim | null | undefined): boolean {
  return (
    typeof client?.session?.messages === "function" ||
    typeof client?.v2?.session?.messages === "function"
  )
}

/**
 * Fetch the post-compaction ACTIVE context via the v2 context endpoint.
 * Single-shot (the endpoint returns the full active window), still bounded by
 * the normalizer's caps downstream. Failures return the fixed category
 * `context_request_failed`.
 *
 * NOTE: SDK client methods rely on `this` (hey-api `this._client`), so they
 * must be invoked ON their namespace — never extracted and called detached.
 */
export async function fetchSessionContext(
  client: ClientShim,
  sessionID: string,
): Promise<SdkContextResult> {
  const ns = client?.v2?.session ?? client?.session
  const fn = (ns as V2SessionShim | undefined)?.context
  if (typeof fn !== "function" || !ns) return { payload: null }
  try {
    const res = await (ns as V2SessionShim).context!({ sessionID })
    return { payload: normalizeSdkResult(res) }
  } catch {
    return { payload: null, error: "context_request_failed" }
  }
}

/**
 * Fetch session messages with bounded pagination.
 *
 *  - v2 namespace (`client.v2.session.messages`): cursor pages via
 *    `{ sessionID, limit, order: "asc", cursor }`, response payload
 *    `{ data, cursor: { previous?, next? } }`. Pages are consumed into the
 *    global message + UTF-8 byte budgets BEFORE pushing, with a seen-cursor
 *    guard against loops.
 *  - v1 namespace (`client.session.messages`): single bounded page via
 *    `{ path: { id }, query: { limit } }`.
 *
 * Returns the RAW concatenated payload plus how many pages were fetched.
 * Never throws; failures report the fixed `messages_request_failed` category.
 */
export async function fetchSessionMessages(
  client: ClientShim,
  sessionID: string,
  opts: { perPage?: number; maxPages?: number } = {},
): Promise<SdkMessagesResult> {
  const perPage = opts.perPage ?? 100
  const maxPages = opts.maxPages ?? CONTEXT_CAP_PAGES

  // v2 tree first: its session namespace is v2-shaped by construction, and its
  // messages method is invoked ON the namespace (this-bound).
  const v2ns = client?.v2?.session
  if (v2ns && typeof v2ns.messages === "function") {
    return fetchV2Messages(v2ns, sessionID, perPage, maxPages)
  }

  // Injected v1 namespace: narrow to the v1 shape and invoke on it.
  const v1ns = v1MessagesOf(client?.session)
  if (v1ns) {
    try {
      const res = await v1ns.messages!({
        path: { id: sessionID },
        query: { limit: perPage },
      })
      return { payload: normalizeSdkResult(res), pagesFetched: 1 }
    } catch {
      return { payload: null, pagesFetched: 0, error: "messages_request_failed" }
    }
  }
  return { payload: null, pagesFetched: 0 }
}

async function fetchV2Messages(
  ns: V2SessionShim,
  sessionID: string,
  perPage: number,
  maxPages: number,
): Promise<SdkMessagesResult> {
  const all: unknown[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let pages = 0
  let bytes = 0
  let truncated = false

  while (pages < maxPages) {
    let res: unknown
    try {
      res = await ns.messages!({
        sessionID,
        limit: perPage,
        order: "asc",
        ...(cursor ? { cursor } : {}),
      })
    } catch {
      return { payload: all, pagesFetched: pages, error: "messages_request_failed" }
    }
    pages++
    const payload = normalizeSdkResult(res)
    const next = readNextCursor(payload, res)

    // Consume the page into the global budgets BEFORE any cursor decision, so
    // every successfully fetched page contributes its items exactly once — the
    // seen-cursor loop guard must never drop the page that revealed it.
    const items = extractDataItems(payload)
    for (const item of items) {
      if (all.length >= CONTEXT_CAP_MESSAGES) {
        truncated = true
        break
      }
      const remaining = CONTEXT_CAP_SOURCE_BYTES - bytes
      if (remaining <= 0) {
        truncated = true
        break
      }
      const { bytes: itemBytes, oversized } = boundedUtf8Bytes(item, remaining)
      if (oversized) {
        truncated = true
        break
      }
      bytes += itemBytes
      all.push(item)
    }
    if (truncated) break
    if (next === undefined) break // no more pages
    if (seenCursors.has(next)) break // repeated cursor → loop guard (page already consumed)
    seenCursors.add(next) // track the cursor we will follow next
    cursor = next
  }

  return { payload: all, pagesFetched: pages, truncated: truncated || undefined }
}

/** Extract the message items from a normalized v2 payload. */
function extractDataItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!isRecord(payload)) return []
  if (Array.isArray(payload.data)) return payload.data
  if ("info" in payload && "parts" in payload) return [payload]
  return []
}

/**
 * Cursor extraction: PRIMARY is the normalized payload's `cursor.next` (the
 * v2 `{ data, cursor: { previous?, next? } }` response). Fallbacks keep
 * compatibility with hosts that surface `nextCursor` on the payload or the
 * raw envelope.
 */
function readNextCursor(payload: unknown, raw: unknown): string | undefined {
  for (const candidate of [payload, raw]) {
    if (!isRecord(candidate)) continue
    const cur = candidate.cursor
    if (isRecord(cur) && typeof cur.next === "string") return cur.next
    if (typeof candidate.nextCursor === "string") return candidate.nextCursor
  }
  return undefined
}

/**
 * Create a v2 SDK client from a server URL in a compatibility-safe way.
 * Dynamic-imports the v2 client module (guarded), so a host whose plugin
 * environment lacks the direct dependency degrades to null instead of failing
 * plugin load. The provider calls this lazily and only when the injected
 * client cannot supply context data.
 */
export async function createV2ClientFromServerUrl(serverUrl?: URL): Promise<ClientShim | null> {
  if (!serverUrl) return null
  const mod = await loadRealV2ClientModule()
  if (!mod) return null
  try {
    const client = mod.createOpencodeClient({ baseUrl: serverUrl.toString() })
    return client as ClientShim
  } catch {
    return null
  }
}

type V2ClientModule = { createOpencodeClient: (config: unknown) => unknown }

/** Test seam: install a fake v2 client factory (no real network, no SDK import). */
let v2ClientModuleOverride: V2ClientModule | null | undefined

export function _setV2ClientModule(mod: V2ClientModule | null): void {
  v2ClientModuleOverride = mod
}

/**
 * Guarded dynamic import of the real v2 SDK client. Never throws.
 */
export async function loadRealV2ClientModule(): Promise<V2ClientModule | null> {
  if (v2ClientModuleOverride !== undefined) return v2ClientModuleOverride
  try {
    const mod = await import("@opencode-ai/sdk/v2/client")
    const factory = (mod as { createOpencodeClient?: unknown }).createOpencodeClient
    if (typeof factory === "function") {
      return { createOpencodeClient: factory as (c: unknown) => unknown }
    }
    return null
  } catch {
    return null
  }
}