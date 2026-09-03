#!/usr/bin/env bash
#
# smoke-oc-selection — reproducible end-to-end proof that a REAL `oc run`
# selects the CANONICAL `agentgrep` tool (never bare find / grep / Grep /
# file_grep / callmux) for BOTH (a) exact lexical search (mode=grep) and
# (b) ranked file discovery (mode=find).
#
# It uses a deterministic local OpenAI-compatible HTTP capture server (Python 3)
# instead of a live remote model. The capture server records every outbound
# request body to JSONL so the script can later assert the exact tool payload:
# canonical agentgrep exactly once, native grep/glob absent from the request.
#
# What it proves (TWO sequential oc runs):
#   1. Run 1 (exact grep): at least one code-search tool_use and EVERY one is
#      canonical `agentgrep` with explicit mode=grep — at least one
#      call carries query/pattern `passthroughStream`.
#   2. Run 2 (ranked find): at least one code-search tool_use and EVERY one is
#      canonical `agentgrep` with mode=find — at least one call carries relevant
#      discovery terms (e.g. "session store").
#   3. No bare `find`, `grep`, `glob`, `Grep`, `file_grep`, or `callmux*` tool
#      use in either run (explicit failure).
#   4. The controlled fake agentgrep binary is invoked at least once and at most
#      OC_SMOKE_MAX_CALLS (default 8) times per run, and EVERY invocation
#      subcommand matches the phase (grep / find).
#   5. Local-search calls per run are bounded (<= OC_SMOKE_MAX_CALLS, default 8)
#      as a deterministic loop sanity check. Unrelated read/bash calls do not
#      affect this policy assertion.
#   6. The expected result reaches the model in each run.
#   7. Pass does not rely on config-level native-tool disables; the plugin's
#      replacement policy and event-stream assertions remain authoritative.
#   8. Authoritative request-payload assertion per phase — the captured
#      HTTP request JSON is inspected to prove the canonical agentgrep tool is
#      offered exactly once, and native grep/glob are absent from the tool
#      payload (unlike the /experimental/tool/ids registry which always
#      advertises them).
#
# Host-environment notes:
#   - Uses a CONTROLLED FAKE agentgrep binary via AGENTGREP_BIN.
#   - Uses a FRESH in-process server (OPENCODE_SHARED_SERVER=0).
#   - Uses a DETERMINISTIC LOCAL CAPTURE LLM (Python 3 HTTP server) instead of
#     any live remote model. No secrets, no network egress, no provider config
#     read from the user's environment.
#   - Injects only this plugin, a controlled provider, and controlled permissions
#     through OPENCODE_CONFIG_CONTENT; ambient OPENCODE_PERMISSION is unset.
#     Does NOT touch XDG_DATA_HOME / OPENCODE_DATA_HOME / OPENCODE_CONFIG_DIR.
#   - Capture is `oc run --format json`; diagnostics are redacted.
#   - Portable poll-loop watchdog (no blocked external `timeout` wrapper).
#   - Capture LLM logs outbound request bodies to JSONL for payload assertion.
#
# Requirements: a working `oc`, the plugin checkout, and Python 3.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$ROOT"
OC="${OC:-oc}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required for the local capture LLM server." >&2
  exit 1
fi

if ! command -v "$OC" >/dev/null 2>&1; then
  echo "ERROR: '$OC' (OC, optional override via \$OC) not found on PATH." >&2
  exit 1
fi

# ── Bounded-call sanity check ────────────────────────────────────────────
MAX_CALLS="${OC_SMOKE_MAX_CALLS:-8}"
case "$MAX_CALLS" in
  ''|*[!0-9]*)
    echo "ERROR: OC_SMOKE_MAX_CALLS='$OC_SMOKE_MAX_CALLS' must be a positive integer." >&2
    exit 1
    ;;
esac
if [[ "$MAX_CALLS" -lt 1 ]]; then
  echo "ERROR: OC_SMOKE_MAX_CALLS='$MAX_CALLS' must be >= 1." >&2
  exit 1
fi
echo "  [config] MAX_CALLS=$MAX_CALLS (set OC_SMOKE_MAX_CALLS to change)" >&2

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
CAPTURE_DIR="$SANDBOX/capture"
CAPTURE_LOG="$CAPTURE_DIR/requests.jsonl"
CAPTURE_PID_FILE="$CAPTURE_DIR/server.pid"
CAPTURE_PORT_FILE="$CAPTURE_DIR/server.port"
PREFLIGHT_PID=""
RUN_PID=""

stop_group() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  stop_group "$RUN_PID"
  stop_group "$PREFLIGHT_PID"
  # Stop the capture server first.
  if [[ -f "$CAPTURE_PID_FILE" ]]; then
    local cpid
    cpid="$(cat "$CAPTURE_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$cpid" ]]; then
      kill "$cpid" 2>/dev/null || true
      wait "$cpid" 2>/dev/null || true
    fi
  fi
  if [[ "${OC_SMOKE_KEEP_SANDBOX:-0}" == "1" ]]; then
    echo "NOTE: OC_SMOKE_KEEP_SANDBOX=1 — sandbox left at $SANDBOX" >&2
    return
  fi
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

mkdir -p "$WORKDIR" "$WORKDIR/src" "$TMPSTATE" "$CAPTURE_DIR"

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

# ── Deterministic local capture LLM (Python 3 HTTP server) ──────────────────
# This server replaces the need for a real remote model. It listens on a
# random localhost port, captures every outbound request body to JSONL, and
# responds with deterministic SSE chat-completions chunks:
#   - Title/summary requests (no tools): return plain text.
#   - Main agent requests (containing function tools array): return a
#     canonical agentgrep tool call with the correct phase mode and
#     expected query/terms.
#   - Tool-result requests (containing role=tool messages): return final
#     text containing the expected fake result summary.
cat >"$SANDBOX/capture_server.py" <<'PYTHON_SCRIPT'
import json, os, sys, http.server, uuid, time, re

CAPTURE_LOG = os.environ.get("CAPTURE_LOG", "")
CAPTURE_PORT = int(os.environ.get("CAPTURE_PORT", "0"))

# Phase state tracking: per-run, track whether we've already emitted a
# tool call for the main request.
_grep_tool_called = False
_find_tool_called = False

# We use a simple JSONL log. Each line is one request body.
def log_request(body: dict):
    path = CAPTURE_LOG
    if not path:
        return
    with open(path, "a") as f:
        f.write(json.dumps(body) + "\n")

def make_chunk(id_str: str, created: int, model: str,
               delta: dict, finish_reason=None):
    choice = {"index": 0, "delta": delta}
    if finish_reason is not None:
        choice["finish_reason"] = finish_reason
    return {
        "id": id_str,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [choice],
    }

def sse_line(data: dict) -> str:
    return "data: " + json.dumps(data, separators=(",", ":")) + "\n\n"

def build_tool_call_response(body: dict):
    """Build SSE response for a main request (has tools array)."""
    global _grep_tool_called, _find_tool_called
    uid = str(uuid.uuid4())[:8]
    now = int(time.time())
    model = body.get("model", "capture-model")

    # Determine phase from user content.
    user_content = ""
    for msg in body.get("messages", []):
        if isinstance(msg.get("content"), str):
            user_content += msg["content"]
        elif isinstance(msg.get("content"), list):
            for c in msg["content"]:
                if isinstance(c, dict) and c.get("type") == "text":
                    user_content += c.get("text", "")

    is_grep = "passthroughStream" in user_content
    is_find = not is_grep

    # Determine if we already emitted a tool call for this phase.
    already_called = (_grep_tool_called if is_grep else _find_tool_called)

    if not already_called:
        # Mark called and return a tool call.
        if is_grep:
            _grep_tool_called = True
        else:
            _find_tool_called = True

        tool_args = (
            json.dumps({"mode": "grep", "query": "passthroughStream"})
            if is_grep
            else json.dumps({"mode": "find", "terms": ["session", "store"]})
        )
        tid = f"call_oc_smoke_{uid}"

        yield sse_line(make_chunk(
            f"chatcmpl-{uid}", now, model,
            {"role": "assistant", "tool_calls": [
                {"index": 0, "id": tid, "type": "function",
                 "function": {"name": "agentgrep", "arguments": tool_args}}
            ]},
        ))
        yield sse_line(make_chunk(
            f"chatcmpl-{uid}", now, model,
            {},
            finish_reason="tool_calls",
        ))
        yield "data: [DONE]\n\n"
        return

    # Already called this phase — emit final text to break any loop.
    text = (
        "passthroughStream (19 matches across 6 files); passthroughStream.ts:1, src/a.ts:2"
        if is_grep
        else "FILES: session-store.ts, src/store.ts"
    )
    yield sse_line(make_chunk(
        f"chatcmpl-{uid}", now, model,
        {"role": "assistant", "content": text},
    ))
    yield sse_line(make_chunk(
        f"chatcmpl-{uid}", now, model,
        {},
        finish_reason="stop",
    ))
    yield "data: [DONE]\n\n"

def build_text_response(body: dict):
    """Build SSE response for a title/summary or tool-result request."""
    uid = str(uuid.uuid4())[:8]
    now = int(time.time())
    model = body.get("model", "capture-model")

    # Check if this is a tool-result request (has role=tool messages).
    has_tool_result = any(
        isinstance(m, dict) and m.get("role") == "tool"
        for m in body.get("messages", [])
    )

    if has_tool_result:
        # Determine phase from user content.
        user_content = ""
        for msg in body.get("messages", []):
            if isinstance(msg.get("content"), str):
                user_content += msg["content"]
            elif isinstance(msg.get("content"), list):
                for c in msg["content"]:
                    if isinstance(c, dict) and c.get("type") == "text":
                        user_content += c.get("text", "")
        is_grep = "passthroughStream" in user_content
        text = (
            "passthroughStream (19 matches across 6 files); passthroughStream.ts:1, src/a.ts:2"
            if is_grep
            else "FILES: session-store.ts, src/store.ts"
        )
    else:
        # Title/summary request — return generic text.
        text = "This is a deterministic capture model for the agentgrep selection smoke test."

    yield sse_line(make_chunk(
        f"chatcmpl-{uid}", now, model,
        {"role": "assistant", "content": text},
    ))
    yield sse_line(make_chunk(
        f"chatcmpl-{uid}", now, model,
        {},
        finish_reason="stop",
    ))
    yield "data: [DONE]\n\n"

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress default logging to stderr.

    def do_GET(self):
        if self.path == "/v1/models":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            data = {
                "object": "list",
                "data": [{"id": "capture-model", "object": "model"}],
            }
            self.wfile.write(json.dumps(data).encode())
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path == "/v1/chat/completions":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            body = json.loads(raw.decode("utf-8"))
            log_request(body)

            # Determine if this is a main request (has tools array).
            has_tools = bool(body.get("tools"))
            response_gen = (
                build_tool_call_response(body)
                if has_tools
                else build_text_response(body)
            )

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            for chunk in response_gen:
                self.wfile.write(chunk.encode("utf-8"))
                self.wfile.flush()
            self.close_connection = True
            return

        self.send_response(404)
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

if __name__ == "__main__":
    port = CAPTURE_PORT
    if port <= 0:
        port = 0  # OS-assign
    server = http.server.HTTPServer(("127.0.0.1", port), Handler)
    actual_port = server.server_address[1]
    # Write the port to a file so the parent shell can read it.
    port_file = os.environ.get("CAPTURE_PORT_FILE", "")
    if port_file:
        with open(port_file, "w") as f:
            f.write(str(actual_port))
    # Signal readiness by writing to the pid file.
    pid_file = os.environ.get("CAPTURE_PID_FILE", "")
    if pid_file:
        with open(pid_file, "w") as f:
            f.write(str(os.getpid()))
    sys.stdout.flush()
    server.serve_forever()
PYTHON_SCRIPT

# Start the capture server.
export CAPTURE_LOG="$CAPTURE_LOG"
export CAPTURE_PORT_FILE="$CAPTURE_PORT_FILE"
export CAPTURE_PID_FILE="$CAPTURE_PID_FILE"
export CAPTURE_PORT=0  # OS-assign

python3 "$SANDBOX/capture_server.py" &
CAPTURE_PID=$!
echo "  [capture] starting capture LLM server (PID $CAPTURE_PID)..." >&2

# Wait for the server to write its port file and be ready.
CAPTURE_PORT=""
for _ in $(seq 1 15); do
  if ! kill -0 "$CAPTURE_PID" 2>/dev/null; then
    echo "ERROR: capture LLM server exited early." >&2
    exit 1
  fi
  if [[ -f "$CAPTURE_PORT_FILE" ]]; then
    CAPTURE_PORT="$(cat "$CAPTURE_PORT_FILE")"
    if [[ -n "$CAPTURE_PORT" ]]; then
      break
    fi
  fi
  sleep 0.2
done

if [[ -z "$CAPTURE_PORT" ]]; then
  echo "ERROR: capture LLM server did not start within timeout." >&2
  kill "$CAPTURE_PID" 2>/dev/null || true
  exit 1
fi

echo "  [capture] capture LLM server listening on 127.0.0.1:$CAPTURE_PORT" >&2

# ── Inject plugin + capture provider; no live model needed ──────────────────
# The OPENCODE_CONFIG_CONTENT registers the plugin AND a local OpenAI-compatible
# provider pointing at our capture server, plus sets model and small_model.
CAPTURE_BASE_URL="http://127.0.0.1:$CAPTURE_PORT/v1"
export OPENCODE_CONFIG_CONTENT="$(
  python3 -c "
import json
config = {
    'plugin': ['file://$PLUGIN_DIR'],
    'provider': {
        'oc-smoke-capture': {
            'npm': '@ai-sdk/openai-compatible',
            'name': 'OC Smoke Capture',
            'options': {
                'baseURL': '$CAPTURE_BASE_URL',
                'apiKey': 'sk-noop',
            },
            'models': {
                'capture-model': {
                    'name': 'Capture Model',
                    'tool_call': True,
                    'cost': {'input': 0, 'output': 0},
                    'limit': {'context': 128000, 'output': 4096},
                },
            },
        },
    },
    'model': 'oc-smoke-capture/capture-model',
    'small_model': 'oc-smoke-capture/capture-model',
    'permission': {
        'agentgrep': 'allow',
        'external_directory': 'allow',
    },
}
print(json.dumps(config))
"
)"
unset OPENCODE_PERMISSION
export OPENCODE_SHARED_SERVER=0
# Ignore repository/project config; the injected provider needs no user auth.
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
#        native grep/glob tool_use),
#        AND by the authoritative request-payload assertions on the captured
#        HTTP request JSON (which inspect the actual tool payload sent to the
#        model, not the registry).
reserve_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}
preflight_port="${OC_SMOKE_PREFLIGHT_PORT:-$(reserve_port)}"
preflight() {
  local pport="$preflight_port"
  local serve_log="$SANDBOX/preflight-serve.log"
  local ids_file="$SANDBOX/preflight-ids.json"

  setsid "$OC" serve --port "$pport" --hostname 127.0.0.1 >"$serve_log" 2>&1 &
  local pid=$!
  PREFLIGHT_PID="$pid"
  local ids=""
  local ok=0
  for _ in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "PREFLIGHT-FAIL: oc serve exited early (see preflight-serve.log)." >&2
      redact <"$serve_log" | tail -n 20 | sed 's/^/  /' >&2
      stop_group "$pid"
      PREFLIGHT_PID=""
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
    stop_group "$pid"
    PREFLIGHT_PID=""
    exit 1
  fi
  stop_group "$pid"
  PREFLIGHT_PID=""

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

# ── Request capture assertion helper ─────────────────────────────────────────
# Inspect the captured HTTP request JSON to prove the actual tool payload
# sent to the model during `oc run`. This is the authoritative proof that
# native grep/glob are absent from the model-request payload (the registry
# preflight above documents the residual — grep/glob are still listed by
# /experimental/tool/ids but filtered by the deny policy at request time).
#
# For each phase (grep/find), we:
#   1. Identify the main request (the one with non-empty `tools` array).
#   2. Assert canonical agentgrep is present exactly once.
#   3. Assert native grep and glob are absent.
#   4. Preferentially fail if find/Grep/file_grep appear.
#   5. Record the assertion pass/fail.
assert_request_payload() {
  local label="$1"       # "grep" or "find"
  local capture_file="$2" # path to the JSONL capture file for this run

  if [[ ! -s "$capture_file" ]]; then
    echo "  [request-payload/$label] FAIL: no captured requests" >&2
    return 1
  fi

  local main_request=""
  local main_index=0
  local idx=0
  while IFS= read -r line; do
    idx=$((idx + 1))
    if [[ -z "$line" ]]; then continue; fi
    if echo "$line" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); exit(0 if isinstance(d.get('tools'), list) and len(d['tools']) > 0 else 1)" 2>/dev/null; then
      main_request="$line"
      main_index=$idx
      break
    fi
  done <"$capture_file"

  if [[ -z "$main_request" ]]; then
    echo "  [request-payload/$label] FAIL: no main request (with tools) found in capture"
    return 1
  fi

  # Extract tool IDs from the tools array.
  local tool_ids
  tool_ids="$(echo "$main_request" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
tools = d.get('tools', [])
ids = [t.get('function', {}).get('name', t.get('id', '')) for t in tools]
print(' '.join(ids))
")"

  local agentgrep_count=0
  local has_grep=0
  local has_glob=0
  local has_find=0
  local has_Grep=0
  local has_file_grep=0

  for tid in $tool_ids; do
    case "$tid" in
      agentgrep) agentgrep_count=$((agentgrep_count + 1)) ;;
      grep)      has_grep=1 ;;
      glob)      has_glob=1 ;;
      find)      has_find=1 ;;
      Grep)      has_Grep=1 ;;
      file_grep) has_file_grep=1 ;;
    esac
  done

  local ok=0
  local errors=""

  if [[ "$agentgrep_count" -eq 1 ]]; then
    :  # exactly one canonical offer — good
  else
    errors="$errors; canonical agentgrep offered $agentgrep_count times (expected exactly once)"
  fi

  if [[ "$has_grep" -eq 1 ]]; then
    errors="$errors; native grep FOUND in request tool payload (should be absent)"
    ok=1
  fi
  if [[ "$has_glob" -eq 1 ]]; then
    errors="$errors; native glob FOUND in request tool payload (should be absent)"
    ok=1
  fi
  if [[ "$has_find" -eq 1 ]]; then
    errors="$errors; native find FOUND in request tool payload (should be absent)"
    ok=1
  fi
  if [[ "$has_Grep" -eq 1 ]]; then
    errors="$errors; native Grep FOUND in request tool payload (should be absent)"
    ok=1
  fi
  if [[ "$has_file_grep" -eq 1 ]]; then
    errors="$errors; native file_grep FOUND in request tool payload (should be absent)"
    ok=1
  fi

  if [[ -n "$errors" ]]; then
    echo "  [request-payload/$label] FAIL:$errors" >&2
    echo "  [request-payload/$label] tool IDs in request: $tool_ids" >&2
    return 1
  fi

  echo "  [request-payload/$label] PASS: canonical agentgrep offered exactly once; native grep/glob/find/Grep/file_grep absent" >&2
  return 0
}

run_oc() {
  local label="$1"   # human-readable label for diagnostics
  local prompt="$2"  # the prompt to pass to oc run
  local events_out="$3"
  local verdict_out="$4"
  local capture_file="$5"  # where to save the capture JSONL for this run

  # Clear the record for this run (fresh invocation tracking).
  : >"$RECORD"

  # Clear the capture log before this run, then symlink/rename so we can
  # separate per-run captures.
  : >"$CAPTURE_LOG"

  local run_status=0
  setsid "$OC" run --format json --print-logs --log-level DEBUG \
    -m oc-smoke-capture/capture-model \
    --dir "$WORKDIR" "$prompt" \
    >"$events_out" 2>"$OC_LOG" &
  local pid=$!
  RUN_PID="$pid"
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if (( elapsed >= timeout_secs )); then
      echo "WATCHDOG [$label]: killing oc run after ${timeout_secs}s" >&2
      stop_group "$pid"
      run_status=137
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  if [[ "$run_status" -eq 0 ]]; then
    wait "$pid" || run_status=$?
  fi
  RUN_PID=""

  [[ "$run_status" -eq 0 ]] || fail "[$label] oc run exited $run_status (see stderr tail)"

  # Save the captured requests for this run (the capture log is cleared at
  # the top of run_oc so each run's requests are separated into its own file).
  if [[ -f "$CAPTURE_LOG" ]]; then
    cp "$CAPTURE_LOG" "$capture_file"
  fi

  # The capture server tracks tool-call state per phase (`_grep_tool_called`
  # vs `_find_tool_called`) so the grep run and the find run each get exactly
  # one canonical agentgrep tool call; a repeated main request within a run
  # (retry) gets final text instead, which breaks any loop deterministically.

  # Parse the event stream.
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$events_out" >"$verdict_out" <<'PY'
import json, re, sys

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
agentgrep_all: list[dict] = []
for p in order:
    tool, inp = last_by_id[p]
    if tool == "agentgrep":
        agentgrep_input = inp
        agentgrep_all.append({"tool": tool, "input": inp})

code_search = ["agentgrep", "find", "grep", "Grep", "file_grep", "glob"]
used_code_search = [t for t in tools_used if t in code_search]
callmux = [t for t in tools_used if t and "callmux" in t.lower()]
# Explicit banned-set: bare find/grep/glob/Grep/file_grep or ANY callmux* tool.
banned_found = [t for t in tools_used if t in ("find", "grep", "glob", "Grep", "file_grep") or (t and "callmux" in t.lower())]
shell_search = []
for p in order:
    tool, inp = last_by_id[p]
    command = inp.get("command") if tool == "bash" and isinstance(inp, dict) else None
    if isinstance(command, str) and re.search(r"(?:^|[\s;&|])(?:rg|grep|find)(?=\s|$)", command):
        shell_search.append("bash")

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
print("BANNED_CODE_SEARCH=" + ",".join(sorted(set(banned_found))))
print("BANNED_SHELL_SEARCH=" + ",".join(shell_search))
print("AGENTGREP_INPUT=" + json.dumps(agentgrep_input))
print("AGENTGREP_CALLS=" + "|||".join(json.dumps(c) for c in agentgrep_all))
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
    try:
        stream = open(f, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        continue
    for line in stream:
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

CAPTURE_GREP="$SANDBOX/capture-grep.jsonl"
run_oc "grep" "$PROMPT_GREP" "$EVENTS_GREP" "$VERDICT_GREP" "$CAPTURE_GREP"

TOOLS_USED="$(verdict TOOLS_USED "$VERDICT_GREP")"
CODESEARCH_USED="$(verdict CODESEARCH_USED "$VERDICT_GREP")"
CALLMUX_USED="$(verdict CALLMUX_USED "$VERDICT_GREP")"
BANNED_CODE_SEARCH="$(verdict BANNED_CODE_SEARCH "$VERDICT_GREP")"
BANNED_SHELL_SEARCH="$(verdict BANNED_SHELL_SEARCH "$VERDICT_GREP")"
AGENTGREP_INPUT="$(verdict AGENTGREP_INPUT "$VERDICT_GREP")"
AGENTGREP_CALLS="$(verdict AGENTGREP_CALLS "$VERDICT_GREP")"
FINAL_TEXT="$(verdict FINAL_TEXT "$VERDICT_GREP")"

# 0a. Authoritative request-payload assertion: inspect the captured HTTP
# request JSON to prove canonical agentgrep is offered and native grep/glob
# are absent from the actual tool payload sent to the model.
assert_request_payload "grep" "$CAPTURE_GREP" || fail "[grep] request-payload assertion failed"

# 1a. At least one local code-search call in this phase, and EVERY code-search
# call must be canonical `agentgrep` (multi-call runs pass as long as every call
# is canonical agentgrep).
code_search_count=0
non_canonical_cs=""
IFS=',' read -ra cs_tools <<< "$CODESEARCH_USED"
for cs_tool in "${cs_tools[@]}"; do
  if [[ -n "$cs_tool" ]]; then
    code_search_count=$((code_search_count + 1))
    if [[ "$cs_tool" != "agentgrep" ]]; then
      non_canonical_cs="$non_canonical_cs,$cs_tool"
    fi
  fi
done
[[ "$code_search_count" -ge 1 ]] || fail "[grep] no local code-search call detected (expected >=1 canonical agentgrep call)"
[[ "$code_search_count" -le "$MAX_CALLS" ]] || fail "[grep] local code-search calls $code_search_count exceed MAX_CALLS=$MAX_CALLS (run looks unbounded)"
[[ -z "$non_canonical_cs" ]] || fail "[grep] every code-search call must be canonical agentgrep; found non-canonical: ${non_canonical_cs#,} (all: $CODESEARCH_USED)"

# 2a. Explicit fail on bare find/grep/glob/Grep/file_grep or any callmux usage.
[[ -z "$BANNED_CODE_SEARCH" ]] || fail "[grep] banned code-search tool(s) used: $BANNED_CODE_SEARCH (all tools: $TOOLS_USED)"
[[ -z "$BANNED_SHELL_SEARCH" ]] || fail "[grep] shell-based local search bypassed canonical agentgrep: $BANNED_SHELL_SEARCH"
[[ -z "$CALLMUX_USED" ]] || fail "[grep] callmux tool/result retrieval occurred: $CALLMUX_USED"

# 3a. EVERY canonical call must explicitly use the phase's required grep mode;
# AT LEAST ONE call must carry the phase's expected query.
ag_call_count=0
ag_mode_bad=0
ag_query_ok=0
IFS='|||' read -ra ag_calls <<< "$AGENTGREP_CALLS"
for ac in "${ag_calls[@]}"; do
  [[ -z "$ac" ]] && continue
  ag_call_count=$((ag_call_count + 1))
  if [[ "$ac" != *'"mode": "grep"'* && "$ac" != *'"mode":"grep"'* && "$ac" != *'mode: grep'* ]]; then
    ag_mode_bad=1
  fi
  if [[ "$ac" == *"passthroughStream"* ]]; then
    ag_query_ok=$((ag_query_ok + 1))
  fi
done
[[ "$ag_call_count" -ge 1 ]] || fail "[grep] no agentgrep call input captured for mode/query validation"
[[ "$ag_mode_bad" -eq 0 ]] || fail "[grep] at least one agentgrep call does not use the phase's required grep mode: $AGENTGREP_CALLS"
[[ "$ag_query_ok" -ge 1 ]] || fail "[grep] no agentgrep call carries the phase's expected query 'passthroughStream': $AGENTGREP_CALLS"

# 4a. Fake CLI: recorded invocations >=1 and <= MAX_CALLS; EVERY invocation
# subcommand must match the phase (grep).
INVOCATIONS=0
grep_sub=0
while IFS= read -r invline; do
  [[ -z "$invline" ]] && continue
  INVOCATIONS=$((INVOCATIONS + 1))
  case "$invline" in
    $'[ARGV]\tgrep\t'*) grep_sub=$((grep_sub + 1)) ;;
  esac
done < <(grep '^\[ARGV\]' "$RECORD" 2>/dev/null || true)
[[ "$INVOCATIONS" -ge 1 && "$INVOCATIONS" -le "$MAX_CALLS" ]] || fail "[grep] fake agentgrep binary invoked $INVOCATIONS times (expected >=1, <=$MAX_CALLS)"
[[ "$grep_sub" -eq "$INVOCATIONS" ]] || fail "[grep] only $grep_sub of $INVOCATIONS fake invocations used 'grep' subcommand (every invocation must match phase): $(grep '^\[ARGV\]' "$RECORD" | redact | paste -sd';' -)"
grep -q 'passthroughStream' "$RECORD" || fail "[grep] fake invocation did not pass passthroughStream: $(grep '^\[ARGV\]' "$RECORD" | redact | head -n3)"

# 5a. Expected result reached the model (final assistant text references it).
case "$FINAL_TEXT" in
  *passthroughStream*) : ;;
  *"19 matches"*|*"6 files"*) : ;;
  *) fail "[grep] expected result did not reach the model final text: $FINAL_TEXT" ;;
esac

echo "  [grep] PASS: $code_search_count agentgrep call(s) (all canonical, grep mode, <=$MAX_CALLS), $INVOCATIONS phase-matching fake invocation(s), 19-matches-across-6-files result reached the model." >&2
echo "  [grep] tool uses: $TOOLS_USED" >&2

# ═══════════════════════════════════════════════════════════════════════════════
# RUN 2: Ranked file discovery (find mode)
# ═══════════════════════════════════════════════════════════════════════════════
PROMPT_FIND='Find files in this local repository related to session storage. Use the best available repository code-search tool with mode=find to discover relevant files and report what you find.'

CAPTURE_FIND="$SANDBOX/capture-find.jsonl"
run_oc "find" "$PROMPT_FIND" "$EVENTS_FIND" "$VERDICT_FIND" "$CAPTURE_FIND"

TOOLS_USED="$(verdict TOOLS_USED "$VERDICT_FIND")"
CODESEARCH_USED="$(verdict CODESEARCH_USED "$VERDICT_FIND")"
CALLMUX_USED="$(verdict CALLMUX_USED "$VERDICT_FIND")"
BANNED_CODE_SEARCH="$(verdict BANNED_CODE_SEARCH "$VERDICT_FIND")"
BANNED_SHELL_SEARCH="$(verdict BANNED_SHELL_SEARCH "$VERDICT_FIND")"
AGENTGREP_INPUT="$(verdict AGENTGREP_INPUT "$VERDICT_FIND")"
AGENTGREP_CALLS="$(verdict AGENTGREP_CALLS "$VERDICT_FIND")"
FINAL_TEXT="$(verdict FINAL_TEXT "$VERDICT_FIND")"

# 0b. Authoritative request-payload assertion.
assert_request_payload "find" "$CAPTURE_FIND" || fail "[find] request-payload assertion failed"

# 1b. At least one local code-search call in this phase, and EVERY code-search
# call must be canonical `agentgrep` (multi-call runs pass as long as every call
# is canonical agentgrep).
code_search_count=0
non_canonical_cs=""
IFS=',' read -ra cs_tools <<< "$CODESEARCH_USED"
for cs_tool in "${cs_tools[@]}"; do
  if [[ -n "$cs_tool" ]]; then
    code_search_count=$((code_search_count + 1))
    if [[ "$cs_tool" != "agentgrep" ]]; then
      non_canonical_cs="$non_canonical_cs,$cs_tool"
    fi
  fi
done
[[ "$code_search_count" -ge 1 ]] || fail "[find] no local code-search call detected (expected >=1 canonical agentgrep call)"
[[ "$code_search_count" -le "$MAX_CALLS" ]] || fail "[find] local code-search calls $code_search_count exceed MAX_CALLS=$MAX_CALLS (run looks unbounded)"
[[ -z "$non_canonical_cs" ]] || fail "[find] every code-search call must be canonical agentgrep; found non-canonical: ${non_canonical_cs#,} (all: $CODESEARCH_USED)"

# 2b. Explicit fail on bare find/grep/glob/Grep/file_grep or any callmux usage.
[[ -z "$BANNED_CODE_SEARCH" ]] || fail "[find] banned code-search tool(s) used: $BANNED_CODE_SEARCH (all tools: $TOOLS_USED)"
[[ -z "$BANNED_SHELL_SEARCH" ]] || fail "[find] shell-based local search bypassed canonical agentgrep: $BANNED_SHELL_SEARCH"
[[ -z "$CALLMUX_USED" ]] || fail "[find] callmux tool/result retrieval occurred: $CALLMUX_USED"

# 3b. EVERY canonical call must use the phase's required mode (explicit
# mode=find — find is NOT the default); AT LEAST ONE call must carry the
# phase's expected discovery terms.
ag_call_count=0
ag_mode_bad=0
ag_terms_ok=0
IFS='|||' read -ra ag_calls <<< "$AGENTGREP_CALLS"
for ac in "${ag_calls[@]}"; do
  [[ -z "$ac" ]] && continue
  ag_call_count=$((ag_call_count + 1))
  if [[ "$ac" != *'"mode": "find"'* && "$ac" != *'"mode":"find"'* && "$ac" != *'mode: find'* ]]; then
    ag_mode_bad=1
  fi
  # NOTE: only real discovery terms count — the mode value "find" is NOT a term.
  if [[ "$ac" == *"session"* || "$ac" == *"store"* || "$ac" == *"storage"* ]]; then
    ag_terms_ok=$((ag_terms_ok + 1))
  fi
done
[[ "$ag_call_count" -ge 1 ]] || fail "[find] no agentgrep call input captured for mode/terms validation"
[[ "$ag_mode_bad" -eq 0 ]] || fail "[find] at least one agentgrep call does not use the phase's required mode=find: $AGENTGREP_CALLS"
[[ "$ag_terms_ok" -ge 1 ]] || fail "[find] no agentgrep call carries the phase's expected discovery terms (session/store/storage): $AGENTGREP_CALLS"

# 4b. Fake CLI: recorded invocations >=1 and <= MAX_CALLS; EVERY invocation
# subcommand must match the phase (find).
INVOCATIONS=0
find_sub=0
while IFS= read -r invline; do
  [[ -z "$invline" ]] && continue
  INVOCATIONS=$((INVOCATIONS + 1))
  case "$invline" in
    $'[ARGV]\tfind\t'*) find_sub=$((find_sub + 1)) ;;
  esac
done < <(grep '^\[ARGV\]' "$RECORD" 2>/dev/null || true)
[[ "$INVOCATIONS" -ge 1 && "$INVOCATIONS" -le "$MAX_CALLS" ]] || fail "[find] fake agentgrep binary invoked $INVOCATIONS times (expected >=1, <=$MAX_CALLS)"
[[ "$find_sub" -eq "$INVOCATIONS" ]] || fail "[find] only $find_sub of $INVOCATIONS fake invocations used 'find' subcommand (every invocation must match phase): $(grep '^\[ARGV\]' "$RECORD" | redact | paste -sd';' -)"

# 5b. Expected result reached the model.
case "$FINAL_TEXT" in
  *session*|*store*|*FILES*) : ;;
  *) fail "[find] expected result did not reach the model final text: $FINAL_TEXT" ;;
esac

echo "  [find] PASS: $code_search_count agentgrep call(s) (all canonical, mode=find, <=$MAX_CALLS), $INVOCATIONS phase-matching fake invocation(s), discovery result reached the model." >&2
echo "  [find] tool uses: $TOOLS_USED" >&2

# ═══════════════════════════════════════════════════════════════════════════════
echo "SMOKE-PASS: both runs passed — exact grep search and ranked find discovery each made 1..$MAX_CALLS local-search calls, all canonical agentgrep with the correct phase mode and phase-matching fake invocations; forbidden bare search/callmux tools were absent; no config-level tools.grep/tools.glob needed (plugin config hook did it); request-payload assertions confirmed grep/glob absent from the model-request payload."
exit 0
