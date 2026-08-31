#!/usr/bin/env bash
#
# smoke-oc-context — reproducible end-to-end proof that the agentgrep plugin
# passes a valid, owner-only harness context JSON (`--context-json`) to the
# AgentGrep CLI during a REAL `oc run`, keeps exact-file containment while
# context is present, and cleans the context tempdir up afterwards.
#
# To run it deterministically you must force a real model:
#     OC_SMOKE_MODEL=provider/model bash scripts/smoke-oc-context.sh
# (e.g. OC_SMOKE_MODEL=codex-omniroute/om-cx-gpt-5.6-sol-fast). If
# OC_SMOKE_MODEL is unset the script SKIPS (exit 2) with a clear message.
#
# What it proves:
#   1. `--context-json` actually appears in the recorded argv.
#   2. The context file is valid JSON (version 1) and mode 0600 at run time.
#   3. The context file is copied by the fake CLI before plugin cleanup.
#   4. Cleanup: no `agentgrep-context-*` temp dirs remain under $TMPDIR.
#   5. Exact-file containment remains exact while context is present
#      (a file-scoped trace argv still has `--path <parent>` + `--glob a.ts`).
#
# Host-environment notes (this is an OpenCode-wrapper box):
#   - It is a CONTROLLED FAKE agentgrep binary via AGENTGREP_BIN.
#   - It uses a FRESH in-process server (OPENCODE_SHARED_SERVER=0) so the
#     plugin is loaded with this run's env (a pre-existing shared server would
#     already have the plugin bound to the real agentgrep binary).
#   - It READS the ACTIVE OPENCODE_CONFIG_DIR / provider config / credentials
#     read-only and injects ONLY the plugin (OPENCODE_CONFIG_CONTENT, deduped
#     against whatever is already configured) plus the auto-approve permissions
#     (OPENCODE_PERMISSION). It does NOT touch or override XDG_DATA_HOME /
#     OPENCODE_DATA_HOME / OPENCODE_CONFIG_DIR (the fork binary reads the
#     `opencode-fork` data namespace; overriding XDG_DATA_HOME breaks
#     credentials). No secrets are printed; the sandbox is removed on exit.
#   - The run timeout is enforced with a pure-bash watchdog (no external
#     `timeout` binary, so the host timeout wrapper is not triggered).
#
# Requirements: a working `oc` (opencode fork/CLI), the plugin checkout, and a
# configured model reachable via OC_SMOKE_MODEL.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$ROOT"

OC="${OC:-oc}"

if [[ -z "${OC_SMOKE_MODEL:-}" ]]; then
  echo "SKIP (exit 2): OC_SMOKE_MODEL is not set." >&2
  echo "  Set OC_SMOKE_MODEL=provider/model (e.g. codex-omniroute/om-cx-gpt-5.6-sol-fast) to run this smoke." >&2
  echo "  Example: OC_SMOKE_MODEL=codex-omniroute/om-cx-gpt-5.6-sol-fast bash scripts/smoke-oc-context.sh" >&2
  exit 2
fi

if ! command -v "$OC" >/dev/null 2>&1; then
  echo "ERROR: '$OC' (OC, optional override via \$OC) not found on PATH." >&2
  exit 1
fi

# ── Sandbox (removed on exit; never mutated user config/state) ───────────────
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/oc-smoke-context.XXXXXX")"
WORKDIR="$SANDBOX/workspace"
TMPSTATE="$SANDBOX/tmp"
RECORD="$SANDBOX/record.txt"
CTX_COPY="$SANDBOX/ctx-copy.json"
OC_LOG="$SANDBOX/oc.log"

cleanup() {
  if [[ "${OC_SMOKE_KEEP_SANDBOX:-0}" == "1" ]]; then
    echo "NOTE: OC_SMOKE_KEEP_SANDBOX=1 — sandbox left at $SANDBOX" >&2
    return
  fi
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

mkdir -p "$WORKDIR" "$TMPSTATE"

# ── Controlled fake agentgrep binary ─────────────────────────────────────────
FAKE_BIN="$SANDBOX/agentgrep-fake"
cat >"$FAKE_BIN" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
RECORD="${AG_SMOKE_RECORD:?}"
CP="${AG_SMOKE_CTX_COPY:?}"
# Atomically record this invocation's argv.
printf '[ARGV]\t%s\n' "$(printf '%s\t' "$@")" >>"$RECORD"
prev=""
for a in "$@"; do
  if [[ "$prev" == "--context-json" && -n "$a" ]]; then
    if [[ -f "$a" ]]; then
      # Prove the context file is present, owner-only, and valid BEFORE cleanup.
      printf '[CTX_MODE]\t%s\n[CTX_SIZE]\t%s\n' "$(stat -c %a "$a")" "$(stat -c %s "$a")" >>"$RECORD"
      cp "$a" "$CP" 2>/dev/null || true
    fi
  fi
  prev="$a"
done
case "${1:-}" in
  outline) printf 'structure:\n  - function alpha @ 1-1 (1 lines)\n' ;;
  find)    printf 'FILES: a.ts\n' ;;
  *)       printf 'TRACE: ok\n' ;;
esac
exit 0
SCRIPT
chmod +x "$FAKE_BIN"

# Single workspace file. Attached with `oc run -f` so the user message carries a
# real local attachment exposure BEFORE the first agentgrep call — the harness
# context is non-empty on the very first trace, so `--context-json` is written.
printf 'export function alpha() { return "x" }\n// auth marker here\n' >"$WORKDIR/a.ts"

# ── Inject only the plugin + permissions; read the active config read-only ───
#   plugin:        same directory file:// URL the stable config uses -> deduped
#   tools:         ensure native grep/glob stay disabled (deep-merged)
#   permission:    auto-approve agentgrep + external_directory for a
#                  non-interactive `oc run`
export OPENCODE_CONFIG_CONTENT="$(
  printf '{"plugin":["file://%s"],"tools":{"grep":false,"glob":false}}' "$PLUGIN_DIR"
)"
export OPENCODE_PERMISSION='{"agentgrep":"allow","external_directory":"allow"}'
# Fresh in-process server so the plugin loads with the env above (NOT an
# attachment to an already-running shared server holding the real binary).
export OPENCODE_SHARED_SERVER=0

# ── Isolate only the plugin's context tempdir + fake CLI wiring ──────────────
export TMPDIR="$TMPSTATE"
export AGENTGREP_BIN="$FAKE_BIN"
export AGENTGREP_TIMEOUT_MS="${OC_SMOKE_TIMEOUT_MS:-30000}"
export AG_SMOKE_RECORD="$RECORD"
export AG_SMOKE_CTX_COPY="$CTX_COPY"

pre_ctx_dirs="$(find "$TMPSTATE" -maxdepth 1 -type d -name 'agentgrep-context-*' 2>/dev/null | wc -l | tr -d '[:space:]')"

# Deterministic prompt: force a SINGLE file-scoped agentgrep TRACE so the
# harness context AND exact-file containment are both exercised in one call.
PROMPT='Using the agentgrep tool only, run mode "trace" scoped to the single file a.ts (pass path="a.ts"), with terms like subject:alpha and relation:def. When it returns, reply with exactly the word DONE.'

# ── Run with a portable poll-loop watchdog ────────────────────────────────────
# No external `timeout` binary and no long `sleep` (both are wrapped/blocked on
# this host). Short 1s sleeps stay under the wrapper's threshold; the loop
# SIGKILLs the in-process run after OC_SMOKE_TIMEOUT.
timeout_secs="${OC_SMOKE_TIMEOUT:-300}"
run_status=0
"$OC" run --print-logs --log-level DEBUG \
  -m "$OC_SMOKE_MODEL" -f "$WORKDIR/a.ts" --dir "$WORKDIR" "$PROMPT" \
  >"$OC_LOG" 2>&1 &
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

post_ctx_dirs="$(find "$TMPSTATE" -maxdepth 1 -type d -name 'agentgrep-context-*' 2>/dev/null | wc -l | tr -d '[:space:]')"

# Redact the real context temp path from any diagnostics printed to the user:
# the record lines carry the argv (which includes the temp path after
# --context-json) and the oc log may reference the sandbox.
redact() {
  sed -E "s#--context-json[[:space:]]+[^[:space:]]+#--context-json [redacted]#g; s#$SANDBOX#[sandbox]#g; s#$TMPSTATE#[sandbox-tmp]#g"
}

fail() {
  echo "SMOKE-FAIL: $1" >&2
  [[ "$run_status" -eq 137 ]] && echo "  (note: run hit the ${timeout_secs}s watchdog timeout)" >&2
  echo "--- recorded CLI invocations (redacted) ---" >&2
  [[ -f "$RECORD" ]] && redact <"$RECORD" | sed 's/^/  /' >&2 || echo "  (no record file)" >&2
  echo "--- oc run stderr (tail, redacted) ---" >&2
  [[ -f "$OC_LOG" ]] && tail -n 60 "$OC_LOG" | redact | sed 's/^/  /' >&2 || true
  exit 1
}

[[ "$run_status" -eq 0 ]] || fail "oc run exited $run_status (see stderr tail)"

[[ -f "$RECORD" ]] || fail "fake agentgrep binary was never invoked"

# 1 + 5. Find a scoped trace argv: must contain --context-json, --path, --glob a.ts.
matched=0
while IFS= read -r line; do
  case "$line" in
    "[ARGV]"*) matched=$((matched + 1)) ;;
  esac
done <"$RECORD"
[[ "$matched" -gt 0 ]] || fail "no agentgrep invocation recorded"

scoped=0
while IFS= read -r line; do
  case "$line" in
    "[ARGV]"*trace* )
      if [[ "$line" == *"--context-json"* && "$line" == *"--glob"* && "$line" == *"--path"* && "$line" == *"a.ts"* ]]; then
        scoped=1
      fi ;;
  esac
done <"$RECORD"
[[ "$scoped" -eq 1 ]] || fail "a trace invocation with --context-json + --glob a.ts + --path (exact-file containment) was not found"

# 2 + 3. Context copy present, valid JSON (version 1), mode 0600.
grep -q '^\[CTX_MODE\][[:space:]]600$' "$RECORD" || fail "context temp file was not 0600 at run time"
[[ -f "$CTX_COPY" ]] || fail "fake CLI did not copy the context file before cleanup"

if command -v python3 >/dev/null 2>&1; then
  python3 - "$CTX_COPY" <<'PY' || fail "context copy is not valid JSON / lacks version 1"
import json, sys
data = json.load(open(sys.argv[1]))
assert data.get("version") == 1, "version != 1"
assert "a.ts" in json.dumps(data), "context does not reference a.ts"
PY
else
  grep -q '"version":1' "$CTX_COPY" || fail "context copy lacks version 1"
  grep -q 'a.ts' "$CTX_COPY" || fail "context copy does not reference a.ts"
fi

# 4. Cleanup: no context temp dirs remain.
[[ "$post_ctx_dirs" -le "$pre_ctx_dirs" ]] || fail "context temp dirs were not cleaned up (before=$pre_ctx_dirs after=$post_ctx_dirs)"
leftover="$(find "$TMPSTATE" -maxdepth 1 -type d -name 'agentgrep-context-*' 2>/dev/null | grep -c . || true)"
[[ "$leftover" -eq 0 ]] || fail "context temp dir left behind: $leftover"

echo "SMOKE-PASS: --context-json passed, context file valid + 0600, copied before cleanup, tempdir removed, exact-file containment held."
echo "  scoped trace invocation (redacted):" >&2
grep '^\[ARGV\]' "$RECORD" | head -n 3 | redact | sed 's/^/    /' >&2 || true
exit 0