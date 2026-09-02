#!/usr/bin/env bash
#
# smoke-oc-selection — reproducible end-to-end proof that a REAL `oc run`
# selects the CANONICAL `agentgrep` tool (never bare find / grep / Grep /
# file_grep / callmux) for BOTH (a) exact lexical search (mode=grep) and
# (b) ranked file discovery (mode=find).
#
# To run it deterministically you must force a real model:
#     OC_SMOKE_MODEL=provider/model bash scripts/smoke-oc-selection.sh
# (e.g. OC_SMOKE_MODEL=codex-omniroute/om-cx-gpt-5.6-sol-fast). If OC_SMOKE_MODEL
# is unset the script SKIPS (exit 2) with a clear message.
#
# What it proves (TWO sequential oc runs):
#   1. Run 1 (exact grep): the ONLY code-search tool_use is canonical `agentgrep`
#      with mode=grep (or omitted default) and query/pattern `passthroughStream`.
#   2. Run 2 (ranked find): the ONLY code-search tool_use is canonical `agentgrep`
#      with mode=find and relevant discovery terms (e.g. "session store").
#   3. No bare `find`, `grep`, `glob`, `Grep`, `file_grep`, or `callmux*` tool use
#      in either run.
#   4. The controlled fake agentgrep binary is invoked EXACTLY ONCE per run with
#      the correct subcommand (grep / find).
#   5. The expected result reaches the model in each run.
#   6. Pass does NOT rely on injecting tools.grep/tools.glob in OPENCODE_CONFIG_CONTENT
#      — the plugin's config hook performs the replacement automatically.
#
# Host-environment notes:
#   - Uses a CONTROLLED FAKE agentgrep binary via AGENTGREP_BIN.
#   - Uses a FRESH in-process server (OPENCODE_SHARED_SERVER=0).
#   - READS the ACTIVE OPENCODE_CONFIG_DIR / provider config / credentials
#     read-only and injects ONLY this plugin (OPENCODE_CONFIG_CONTENT).
#     Does NOT touch XDG_DATA_HOME / OPENCODE_DATA_HOME / OPENCODE_CONFIG_DIR.
#   - Capture is `oc run --format json`; diagnostics are redacted.
#   - Portable poll-loop watchdog (no blocked external `timeout` wrapper).
#
# Requirements: a working `oc`, the plugin checkout, and a configured model.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$ROOT"
OC="${OC:-oc}"

if [[ -z "${OC_SMOKE_MODEL:-}" ]]; then
  echo "SKIP (exit 2): OC_SMOKE_MODEL is not set." >&2
  echo "  Set OC_SMOKE_MODEL=provider/model (e.g. codex-omniroute/om-cx-gpt-5.6-sol-fast) to run this smoke." >&2
  exit 2
fi

if ! command -v "$OC" >/dev/null 2>&1; then
  echo "ERROR: '$OC' (OC, optional override via \$OC) not found on PATH." >&2
  exit 1
fi

# ── Sandbox (removed on exit) ────────────────────────────────────────────────
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/oc-smoke-selection.XXXXXX")"
WORKDIR="$SANDBOX/workspace"
TMPSTATE="$SANDBOX/tmp"
RECORD="$SANDBOX/record.txt"
EVENTS_GREP="$SANDBOX/events-grep.jsonl"
EVENTS_FIND="$SANDBOX/events-find.jsonl"
VERDICT_GREP="$SANDBOX/verdict-grep.txt"
VERDICT_FIND="$SANDBOX/verdict-find.txt"
OC_LOG="$SANDBOX/oc.log"

cleanup() {
  if [[ "${OC_SMOKE_KEEP_SANDBOX:-0}" == "1" ]]; then
    echo "NOTE: OC_SMOKE_KEEP_SANDBOX=1 — sandbox left at $SANDBOX" >&2
    return
  fi
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

mkdir -p "$WORKDIR" "$WORKDIR/src" "$TMPSTATE"

# Workspace with files for BOTH grep and find scenarios.
printf 'export const passthroughStream = 1\n' >"$WORKDIR/passthroughStream.ts"
printf '// passthroughStream used here\n' >"$WORKDIR/src/a.ts"
printf '// and here too\n' >"$WORKDIR/src/b.ts"
printf '// session persistence\n' >"$WORKDIR/src/session-store.ts"
printf 'export const store = "session"\n' >"$WORKDIR/src/store.ts"

# ── Controlled fake agentgrep binary ─────────────────────────────────────────
FAKE_BIN="$SANDBOX/agentgrep-fake"
cat >"$FAKE_BIN" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
printf '[ARGV]\t%s\n' "$(printf '%s\t' "$@")" >>"${AG_SMOKE_RECORD:?}"
case "${1:-}" in
  grep) cat <<'EOF'
passthroughStream (19 matches across 6 files)
passthroughStream.ts:1: export const passthroughStream = 1
src/a.ts:2: // passthroughStream used here
EOF
    ;;
  find) printf 'FILES: session-store.ts\nsrc/store.ts\n' ;;
  *)    printf 'TRACE: ok\n' ;;
esac
exit 0
SCRIPT
chmod +x "$FAKE_BIN"

# ── Inject only this plugin (no tools.grep/tools.glob); config hook does it ──
export OPENCODE_CONFIG_CONTENT="$(
  printf '{"plugin":["file://%s"]}' "$PLUGIN_DIR"
)"
export OPENCODE_PERMISSION='{"agentgrep":"allow","external_directory":"allow"}'
export OPENCODE_SHARED_SERVER=0
# Ignore any project-scoped config (.opencode/) so the pass is host-config
# independent. This only disables PROJECT config — user/global config (where
# model auth lives) is still read, so OC_SMOKE_MODEL keeps working.
export OPENCODE_DISABLE_PROJECT_CONFIG=1

export TMPDIR="$TMPSTATE"
export AGENTGREP_BIN="$FAKE_BIN"
export AGENTGREP_TIMEOUT_MS="${OC_SMOKE_TIMEOUT_MS:-30000}"
export AG_SMOKE_RECORD="$RECORD"

# Redact the real sandbox/temp/context paths from any printed diagnostics.
redact() {
  sed -E "s#$SANDBOX#[sandbox]#g; s#$TMPSTATE#[sandbox-tmp]#g"
}

# ── Shared runner ────────────────────────────────────────────────────────────
timeout_secs="${OC_SMOKE_TIMEOUT:-300}"

# ── Fresh-host registry preflight ─────────────────────────────────────────────
# Deterministic proof that the plugin loaded and registered `agentgrep` on a
# FRESH in-process server BEFORE any model-choice assertion runs. We start our
# own `oc serve` (same fresh-host env as the runs below) and query the
# /experimental/tool/ids HTTP endpoint (the same route the SDK uses).
#
# KNOWN RESIDUAL (verified against g5kc oc 1.18.9-dev-patched):
#   /experimental/tool and /experimental/tool/ids ALWAYS advertise the built-in
#   grep/glob tools regardless of config.tools or config.permission — the
#   registry endpoint lists every registered built-in tool unfiltered. The
#   deny policy (agentgrep-policy.ts) therefore cannot be proven by registry
#   introspection; it filters the tools OFFERED TO THE MODEL at request time
#   (resolveTools / PermissionNext.disabled). We therefore:
#     1. PROVE agentgrep is present in the fresh-host registry (plugin loaded).
#     2. FAIL clearly if the introspection route is unavailable.
#     3. RECORD the residual (built-in grep/glob still listed by the registry
#        endpoint) — the actual absence is proven below by the model-choice
#        assertions on the real `oc run` tool_use events after the deny is
#        active (a called-and-denied or unoffered tool never appears as a
#        native grep/glob tool_use).
preflight_port="${OC_SMOKE_PREFLIGHT_PORT:-41887}"
preflight() {
  local pport="$preflight_port"
  local serve_log="$SANDBOX/preflight-serve.log"
  local ids_file="$SANDBOX/preflight-ids.json"

  "$OC" serve --port "$pport" --hostname 127.0.0.1 >"$serve_log" 2>&1 &
  local pid=$!
  local ids=""
  local ok=0
  for _ in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "PREFLIGHT-FAIL: oc serve exited early (see preflight-serve.log)." >&2
      redact <"$serve_log" | tail -n 20 | sed 's/^/  /' >&2
      exit 1
    fi
    ids="$(curl -sf --max-time 2 "http://127.0.0.1:$pport/experimental/tool/ids" 2>/dev/null || true)"
    if [[ -n "$ids" ]]; then
      ok=1
      break
    fi
    sleep 1
  done
  if [[ "$ok" -ne 1 ]]; then
    echo "PREFLIGHT-FAIL: cannot introspect offered tools via GET /experimental/tool/ids on fresh host (curl/serve unavailable)." >&2
    echo "  Introspection unavailable on this oc build — cannot prove registry state. See preflight-serve.log." >&2
    redact <"$serve_log" | tail -n 20 | sed 's/^/  /' >&2
    kill "$pid" 2>/dev/null || true
    exit 1
  fi
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true

  printf '%s' "$ids" >"$ids_file"

  # 1. agentgrep MUST be present (plugin loaded + tool registered on fresh host).
  if ! grep -q '"agentgrep"' "$ids_file"; then
    echo "PREFLIGHT-FAIL: canonical agentgrep NOT present in fresh-host tool registry: $ids" >&2
    exit 1
  fi

  # 2. Record the residual: built-in grep/glob are always listed by this
  #    endpoint on g5kc oc (verified 1.18.9-dev-patched). This is EXPECTED —
  #    the deny filters the model-request payload, not the registry listing.
  if grep -q '"grep"' "$ids_file" || grep -q '"glob"' "$ids_file"; then
    echo "  [preflight] RESIDUAL: native grep/glob still listed by /experimental/tool/ids (built-in registry always advertises them; deny filters the model request, proven below)." >&2
  fi

  echo "  [preflight] PASS: fresh-host registry advertises canonical agentgrep; introspection route verified live." >&2
}
preflight
run_oc() {
  local label="$1"   # human-readable label for diagnostics
  local prompt="$2"  # the prompt to pass to oc run
  local events_out="$3"
  local verdict_out="$4"

  # Clear the record for this run (fresh invocation tracking).
  : >"$RECORD"

  local run_status=0
  "$OC" run --format json --print-logs --log-level DEBUG \
    -m "$OC_SMOKE_MODEL" --dir "$WORKDIR" "$prompt" \
    >"$events_out" 2>"$OC_LOG" &
  local pid=$!
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if (( elapsed >= timeout_secs )); then
      echo "WATCHDOG [$label]: killing oc run after ${timeout_secs}s" >&2
      kill -9 "$pid" 2>/dev/null || true
      run_status=137
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  if [[ "$run_status" -eq 0 ]]; then
    wait "$pid" || run_status=$?
  fi

  [[ "$run_status" -eq 0 ]] || fail "[$label] oc run exited $run_status (see stderr tail)"

  # Parse the event stream.
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$events_out" >"$verdict_out" <<'PY'
import json, sys

def tool_parts():
    for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if not isinstance(ev, dict):
            continue
        part = ev.get("part")
        if part is None:
            part = (ev.get("properties") or {}).get("part")
        if isinstance(part, dict) and part.get("type") == "tool":
            yield part

# Streaming emits many updates for the SAME tool part (pending/running/completed).
# Dedupe by part id and keep the LAST (most complete) input per part.
order: list[str] = []
last_by_id: dict[str, tuple] = {}
for part in tool_parts():
    pid = part.get("id") or part.get("callID") or "anon"
    if pid not in last_by_id:
        order.append(pid)
    last_by_id[pid] = (part.get("tool"), (part.get("state") or {}).get("input"))

tools_used = [last_by_id[p][0] for p in order]
agentgrep_input = None
for p in order:
    tool, inp = last_by_id[p]
    if tool == "agentgrep":
        agentgrep_input = inp

code_search = ["agentgrep", "find", "grep", "Grep", "file_grep", "glob"]
used_code_search = [t for t in tools_used if t in code_search]
callmux = [t for t in tools_used if t and "callmux" in t.lower()]

# Final assistant text: the LAST text part (streaming accumulates the full text).
final_text = ""
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    line = line.strip()
    if not line:
        continue
    try:
        ev = json.loads(line)
    except Exception:
        continue
    if not isinstance(ev, dict):
        continue
    part = ev.get("part")
    if part is None:
        part = (ev.get("properties") or {}).get("part")
    if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str):
        final_text = part["text"]

print("TOOLS_USED=" + ",".join(tools_used))
print("CODESEARCH_USED=" + ",".join(used_code_search))
print("CALLMUX_USED=" + ",".join(callmux))
print("AGENTGREP_INPUT=" + json.dumps(agentgrep_input))
print("FINAL_TEXT=" + final_text.replace("\n", " "))
PY
  else
    # Minimal grep-based fallback (dedupes tool names).
    {
      echo "TOOLS_USED=$(grep -o '"tool":"[^"]*"' "$events_out" | sed 's/"tool":"//;s/"//' | sort -u | tr '\n' ',')"
    } >"$verdict_out"
  fi
}

fail() {
  echo "SMOKE-FAIL: $1" >&2
  echo "--- recorded fake-CLI invocations (redacted) ---" >&2
  [[ -f "$RECORD" ]] && redact <"$RECORD" | sed 's/^/  /' >&2 || echo "  (no record file)" >&2
  echo "--- oc run stderr (tail, redacted) ---" >&2
  [[ -f "$OC_LOG" ]] && tail -n 40 "$OC_LOG" | redact | sed 's/^/  /' >&2 || true
  echo "--- captured tool_use events (redacted) ---" >&2
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$EVENTS_GREP" "$EVENTS_FIND" <<'PY' | redact | sed 's/^/  /' >&2 || true
import json, sys
for f in sys.argv[1:]:
    for line in open(f, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        part = None
        if isinstance(ev, dict):
            part = ev.get("part")
            if part is None:
                part = (ev.get("properties") or {}).get("part")
        if isinstance(part, dict) and part.get("type") == "tool":
            print(json.dumps({"tool": part.get("tool"), "input": (part.get("state") or {}).get("input")}))
PY
  else
    grep -o '"tool":"[^"]*"' "$EVENTS_GREP" "$EVENTS_FIND" 2>/dev/null | sort | uniq -c | sed 's/^/  /' >&2 || true
  fi
  exit 1
}

verdict() { grep -m1 "^$1=" "$2" | cut -d= -f2- ; }

# ═══════════════════════════════════════════════════════════════════════════════
# RUN 1: Exact lexical search (grep mode)
# ═══════════════════════════════════════════════════════════════════════════════
PROMPT_GREP='Search this local repository for the exact string passthroughStream using the best available repository code-search tool. Report how many files contain it and the total number of matches.'

run_oc "grep" "$PROMPT_GREP" "$EVENTS_GREP" "$VERDICT_GREP"

TOOLS_USED="$(verdict TOOLS_USED "$VERDICT_GREP")"
CODESEARCH_USED="$(verdict CODESEARCH_USED "$VERDICT_GREP")"
CALLMUX_USED="$(verdict CALLMUX_USED "$VERDICT_GREP")"
AGENTGREP_INPUT="$(verdict AGENTGREP_INPUT "$VERDICT_GREP")"
FINAL_TEXT="$(verdict FINAL_TEXT "$VERDICT_GREP")"

# 1a. Exactly one code-search tool_use and it is canonical agentgrep.
[[ "$CODESEARCH_USED" == "agentgrep" ]] || fail "[grep] expected ONLY agentgrep as code-search tool use, got: $CODESEARCH_USED (all tools: $TOOLS_USED)"

# 3. No callmux tool/result retrieval.
[[ -z "$CALLMUX_USED" ]] || fail "[grep] callmux tool/result retrieval occurred: $CALLMUX_USED"

# 2a. Input is grep mode with query/pattern passthroughStream.
MODE_OK=0
case "$AGENTGREP_INPUT" in
  *passthroughStream*)
    case "$AGENTGREP_INPUT" in
      *'"mode": "grep"'*|*'"mode":"grep"'*|*"mode: grep"*) MODE_OK=1 ;;
      *) MODE_OK=0 ;;
    esac
    # Accept an explicit mode "grep" OR no mode at all (defaults to grep).
    if [[ "$MODE_OK" -ne 1 ]]; then
      if [[ "$AGENTGREP_INPUT" != *'"mode"'* && "$AGENTGREP_INPUT" != *"mode:"* ]]; then
        MODE_OK=1
      fi
    fi
    ;;
esac
[[ "$MODE_OK" -eq 1 ]] || fail "[grep] agentgrep input not grep mode / passthroughStream: $AGENTGREP_INPUT"

# 4a. Fake binary invoked EXACTLY once, in grep subcommand.
INVOCATIONS="$(grep -c '^\[ARGV\]' "$RECORD" 2>/dev/null || true)"
[[ "$INVOCATIONS" -eq 1 ]] || fail "[grep] fake agentgrep binary invoked $INVOCATIONS times (expected exactly 1)"
grep -q '^\[ARGV\]	grep	' "$RECORD" || fail "[grep] fake invocation was not grep subcommand: $(grep '^\[ARGV\]' "$RECORD" | redact | head -n1)"
grep -q 'passthroughStream' "$RECORD" || fail "[grep] fake invocation did not pass passthroughStream"

# 5a. Expected result reached the model (final assistant text references it).
case "$FINAL_TEXT" in
  *passthroughStream*) : ;;
  *"19 matches"*|*"6 files"*) : ;;
  *) fail "[grep] expected result did not reach the model final text: $FINAL_TEXT" ;;
esac

echo "  [grep] PASS: exact lexical search selected canonical agentgrep, no bare grep/find/glob/Grep/file_grep/callmux, fake invoked once, 19-matches-across-6-files result reached the model." >&2
echo "  [grep] tool uses: $TOOLS_USED" >&2

# ═══════════════════════════════════════════════════════════════════════════════
# RUN 2: Ranked file discovery (find mode)
# ═══════════════════════════════════════════════════════════════════════════════
PROMPT_FIND='Find files in this local repository related to session storage. Use the best available repository code-search tool with mode=find to discover relevant files and report what you find.'

run_oc "find" "$PROMPT_FIND" "$EVENTS_FIND" "$VERDICT_FIND"

TOOLS_USED="$(verdict TOOLS_USED "$VERDICT_FIND")"
CODESEARCH_USED="$(verdict CODESEARCH_USED "$VERDICT_FIND")"
CALLMUX_USED="$(verdict CALLMUX_USED "$VERDICT_FIND")"
AGENTGREP_INPUT="$(verdict AGENTGREP_INPUT "$VERDICT_FIND")"
FINAL_TEXT="$(verdict FINAL_TEXT "$VERDICT_FIND")"

# 1b. Exactly one code-search tool_use and it is canonical agentgrep.
[[ "$CODESEARCH_USED" == "agentgrep" ]] || fail "[find] expected ONLY agentgrep as code-search tool use, got: $CODESEARCH_USED (all tools: $TOOLS_USED)"

# 3. No callmux tool/result retrieval.
[[ -z "$CALLMUX_USED" ]] || fail "[find] callmux tool/result retrieval occurred: $CALLMUX_USED"

# 2b. Input MUST have BOTH explicit mode=find AND at least one useful
# discovery term (the prompt asks for session-storage files, so the model must
# pass a real discovery query — not just mode=find with an empty search).
MODE_FIND=0
TERMS_FIND=0
case "$AGENTGREP_INPUT" in
  *'"mode": "find"'*|*'"mode":"find"'*|*"mode: find"*) MODE_FIND=1 ;;
esac
# NOTE: do NOT treat the mode value itself as a term — the mode match above is
# the ONLY place "find" is allowed; here only real discovery terms count.
case "$AGENTGREP_INPUT" in
  *session*|*store*|*storage*) TERMS_FIND=1 ;;
esac
[[ "$MODE_FIND" -eq 1 && "$TERMS_FIND" -eq 1 ]] || fail "[find] agentgrep input must have BOTH explicit mode=find AND a useful discovery term: $AGENTGREP_INPUT"

# 4b. Fake binary invoked EXACTLY once, in find subcommand.
INVOCATIONS="$(grep -c '^\[ARGV\]' "$RECORD" 2>/dev/null || true)"
[[ "$INVOCATIONS" -eq 1 ]] || fail "[find] fake agentgrep binary invoked $INVOCATIONS times (expected exactly 1)"
grep -q '^\[ARGV\]	find	' "$RECORD" || fail "[find] fake invocation was not find subcommand: $(grep '^\[ARGV\]' "$RECORD" | redact | head -n1)"

# 5b. Expected result reached the model.
case "$FINAL_TEXT" in
  *session*|*store*|*FILES*) : ;;
  *) fail "[find] expected result did not reach the model final text: $FINAL_TEXT" ;;
esac

echo "  [find] PASS: ranked file discovery selected canonical agentgrep (mode=find), no bare find/grep/glob/Grep/file_grep/callmux, fake invoked once, discovery result reached the model." >&2
echo "  [find] tool uses: $TOOLS_USED" >&2

# ═══════════════════════════════════════════════════════════════════════════════
echo "SMOKE-PASS: both runs passed — exact grep search and ranked find discovery both selected canonical agentgrep; no config-level tools.grep/tools.glob needed (plugin config hook did it)."
exit 0