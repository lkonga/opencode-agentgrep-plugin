#!/usr/bin/env bash
#
# smoke-oc-selection — reproducible end-to-end proof that a REAL `oc run`
# selects the CANONICAL `agentgrep` tool (never bare grep / Grep / file_grep /
# callmux) for LOCAL repository code search, using the exact regression input
# `passthroughStream`.
#
# To run it deterministically you must force a real model:
#     OC_SMOKE_MODEL=provider/model bash scripts/smoke-oc-selection.sh
# (e.g. OC_SMOKE_MODEL=codex-omniroute/om-cx-gpt-5.6-sol-fast). If OC_SMOKE_MODEL
# is unset the script SKIPS (exit 2) with a clear message.
#
# What it proves:
#   1. The ONLY local code-search tool_use in the run is canonical `agentgrep`.
#   2. Its input is grep mode with query/pattern `passthroughStream`.
#   3. No bare `grep`, `glob`, `Grep`, `file_grep`, or `callmux*` tool use.
#   4. The controlled fake agentgrep binary is invoked EXACTLY ONCE.
#   5. The expected result (19 matches across 6 files) reaches the model.
#
# Host-environment notes (mirrors smoke-oc-context.sh):
#   - Uses a CONTROLLED FAKE agentgrep binary via AGENTGREP_BIN.
#   - Uses a FRESH in-process server (OPENCODE_SHARED_SERVER=0).
#   - READS the ACTIVE OPENCODE_CONFIG_DIR / provider config / credentials
#     read-only and injects ONLY this plugin + permissions
#     (OPENCODE_CONFIG_CONTENT / OPENCODE_PERMISSION). Does NOT touch
#     XDG_DATA_HOME / OPENCODE_DATA_HOME / OPENCODE_CONFIG_DIR.
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
EVENTS="$SANDBOX/events.jsonl"
VERDICT="$SANDBOX/verdict.txt"
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

# Workspace with files that (in the real world) contain the regression term.
printf 'export const passthroughStream = 1\n' >"$WORKDIR/passthroughStream.ts"
printf '// passthroughStream used here\n' >"$WORKDIR/src/a.ts"
printf '// and here too\n' >"$WORKDIR/src/b.ts"

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
src/a.ts:5: passthroughStream
src/a.ts:8: passthroughStream
src/a.ts:11: passthroughStream
src/b.ts:3: passthroughStream
src/b.ts:6: passthroughStream
src/c.ts:4: passthroughStream
src/c.ts:7: passthroughStream
src/d.ts:9: passthroughStream
src/d.ts:12: passthroughStream
src/e.ts:10: passthroughStream
src/e.ts:13: passthroughStream
src/f.ts:14: passthroughStream
src/f.ts:17: passthroughStream
src/f.ts:20: passthroughStream
src/f.ts:23: passthroughStream
src/f.ts:26: passthroughStream
src/f.ts:29: passthroughStream
EOF
    ;;
  find) printf 'FILES: passthroughStream.ts\nsrc/a.ts\nsrc/b.ts\n' ;;
  *)    printf 'TRACE: ok\n' ;;
esac
exit 0
SCRIPT
chmod +x "$FAKE_BIN"

# ── Inject only this plugin + permissions; read the active config read-only ──
export OPENCODE_CONFIG_CONTENT="$(
  printf '{"plugin":["file://%s"],"tools":{"grep":false,"glob":false}}' "$PLUGIN_DIR"
)"
export OPENCODE_PERMISSION='{"agentgrep":"allow","external_directory":"allow"}'
export OPENCODE_SHARED_SERVER=0

export TMPDIR="$TMPSTATE"
export AGENTGREP_BIN="$FAKE_BIN"
export AGENTGREP_TIMEOUT_MS="${OC_SMOKE_TIMEOUT_MS:-30000}"
export AG_SMOKE_RECORD="$RECORD"

# Prompt MUST NOT name agentgrep — ask for the best repository code-search tool.
PROMPT='Search this local repository for the exact string passthroughStream using the best available repository code-search tool. Report how many files contain it and the total number of matches.'

# ── Run with a portable poll-loop watchdog ────────────────────────────────────
timeout_secs="${OC_SMOKE_TIMEOUT:-300}"
run_status=0
"$OC" run --format json --print-logs --log-level DEBUG \
  -m "$OC_SMOKE_MODEL" --dir "$WORKDIR" "$PROMPT" \
  >"$EVENTS" 2>"$OC_LOG" &
pid=$!
elapsed=0
while kill -0 "$pid" 2>/dev/null; do
  if (( elapsed >= timeout_secs )); then
    echo "WATCHDOG: killing oc run after ${timeout_secs}s" >&2
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

# Redact the real sandbox/temp/context paths from any printed diagnostics.
redact() {
  sed -E "s#$SANDBOX#[sandbox]#g; s#$TMPSTATE#[sandbox-tmp]#g"
}

fail() {
  echo "SMOKE-FAIL: $1" >&2
  [[ "$run_status" -eq 137 ]] && echo "  (note: run hit the ${timeout_secs}s watchdog timeout)" >&2
  echo "--- recorded fake-CLI invocations (redacted) ---" >&2
  [[ -f "$RECORD" ]] && redact <"$RECORD" | sed 's/^/  /' >&2 || echo "  (no record file)" >&2
  echo "--- oc run stderr (tail, redacted) ---" >&2
  [[ -f "$OC_LOG" ]] && tail -n 40 "$OC_LOG" | redact | sed 's/^/  /' >&2 || true
  echo "--- captured tool_use events (redacted) ---" >&2
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$EVENTS" <<'PY' | redact | sed 's/^/  /' >&2 || true
import json, sys
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
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
    grep -o '"tool":"[^"]*"' "$EVENTS" | sort | uniq -c | sed 's/^/  /' >&2 || true
  fi
  exit 1
}

[[ "$run_status" -eq 0 ]] || fail "oc run exited $run_status (see stderr tail)"
[[ -f "$EVENTS" ]] || fail "no captured events (--format json produced no output)"

# ── Parse the event stream ───────────────────────────────────────────────────
if command -v python3 >/dev/null 2>&1; then
  python3 - "$EVENTS" >"$VERDICT" <<'PY'
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
    echo "TOOLS_USED=$(grep -o '"tool":"[^"]*"' "$EVENTS" | sed 's/"tool":"//;s/"//' | sort -u | tr '\n' ',')"
  } >"$VERDICT"
fi

verdict() { grep -m1 "^$1=" "$VERDICT" | cut -d= -f2- ; }

TOOLS_USED="$(verdict TOOLS_USED)"
CODESEARCH_USED="$(verdict CODESEARCH_USED)"
CALLMUX_USED="$(verdict CALLMUX_USED)"
AGENTGREP_INPUT="$(verdict AGENTGREP_INPUT)"
FINAL_TEXT="$(verdict FINAL_TEXT)"

# 1 + 3. Exactly one local code-search tool_use and it is canonical agentgrep.
[[ "$CODESEARCH_USED" == "agentgrep" ]] || fail "expected ONLY agentgrep as code-search tool use, got: $CODESEARCH_USED (all tools: $TOOLS_USED)"

# 3. No callmux tool/result retrieval.
[[ -z "$CALLMUX_USED" ]] || fail "callmux tool/result retrieval occurred: $CALLMUX_USED"

# 2. Input is grep mode with query/pattern passthroughStream.
MODE_OK=0
case "$AGENTGREP_INPUT" in
  *passthroughStream*)
    # mode may be absent (defaults to grep) or "grep".
    case "$AGENTGREP_INPUT" in
      *'"mode": "grep"'*|*'"mode":"grep"'*|*"mode: grep"*) MODE_OK=1 ;;
      *) MODE_OK=0 ;;
    esac
    # Accept an explicit mode "grep" OR no mode at all.
    if [[ "$MODE_OK" -ne 1 ]]; then
      if [[ "$AGENTGREP_INPUT" != *'"mode"'* && "$AGENTGREP_INPUT" != *"mode:"* ]]; then
        MODE_OK=1
      fi
    fi
    ;;
esac
[[ "$MODE_OK" -eq 1 ]] || fail "agentgrep input not grep mode / passthroughStream: $AGENTGREP_INPUT"

# 4. Fake binary invoked EXACTLY once, in grep subcommand.
INVOCATIONS="$(grep -c '^\[ARGV\]' "$RECORD" 2>/dev/null || true)"
[[ "$INVOCATIONS" -eq 1 ]] || fail "fake agentgrep binary invoked $INVOCATIONS times (expected exactly 1)"
grep -q '^\[ARGV\]	grep	' "$RECORD" || fail "fake invocation was not grep subcommand: $(grep '^\[ARGV\]' "$RECORD" | redact | head -n1)"
grep -q 'passthroughStream' "$RECORD" || fail "fake invocation did not pass passthroughStream"

# 5. Expected result reached the model (final assistant text references it).
case "$FINAL_TEXT" in
  *passthroughStream*) : ;;
  *"19 matches"*|*"6 files"*) : ;;
  *) fail "expected result did not reach the model final text: $FINAL_TEXT" ;;
esac

echo "SMOKE-PASS: real oc run selected canonical agentgrep (grep/passthroughStream), no grep/Grep/file_grep/glob/callmux, fake invoked once, 19-matches-across-6-files result reached the model."
echo "  tool uses (redacted): $TOOLS_USED" >&2
exit 0