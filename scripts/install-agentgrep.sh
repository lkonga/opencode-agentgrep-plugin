#!/usr/bin/env bash
# install-agentgrep.sh — Pinned, reproducible install of 1jehuang/agentgrep v0.1.6
# into the documented user-local binary dir (~/.local/bin by default).
#
# This script lives in the standalone opencode-agentgrep plugin repo
# (scripts/install-agentgrep.sh) and is self-contained: it only touches its own
# temp/build dirs and the install prefix. It does NOT reference any opencode
# runtime files.
#
# Pinning:
#   repo   : https://github.com/1jehuang/agentgrep
#   tag    : v0.1.6
#   commit : b01b804008ab0662fa14e6b60b10bff61716e6f1   (verified via GitHub API)
#
# Behavior:
#   1. Uses / reuses a source clone under $AGENTGREP_BUILD_DIR.
#   2. Validates the existing clone's tag/commit when present; re-fetches the
#      pinned tag if it does not match. Refuses to install from an untagged/
#      mismatched working tree.
#   3. `cargo build --release --locked` for a reproducible build.
#   4. Copies the resulting binary to $INSTALL_DIR/agentgrep (chmod +x) and
#      verifies `agentgrep --version`.
#
# Safety: does NOT use sudo and does NOT install any host/OS packages. It only
# builds a user-local binary. The binary is NOT committed anywhere.
#
# The installed location matches the "documented packaged default" that the
# agentgrep OpenCode plugin (index.ts / agentgrep-exec.ts) resolves after
# $AGENTGREP_BIN and before $PATH: $HOME/.local/bin/agentgrep.
#
# Usage:
#   bash scripts/install-agentgrep.sh
# Env overrides:
#   AGENTGREP_INSTALL_DIR   install prefix dir (default: $HOME/.local/bin)
#   AGENTGREP_BUILD_DIR     reusable source dir (default: secure temporary dir)
#   AGENTGREP_SKIP_BUILD    if set and the binary already exists, skip rebuild

set -euo pipefail

REPO_URL="https://github.com/1jehuang/agentgrep.git"
TAG="v0.1.6"
COMMIT="b01b804008ab0662fa14e6b60b10bff61716e6f1"

AGENTGREP_SKIP_BUILD="${AGENTGREP_SKIP_BUILD:-0}"
INSTALL_DIR="${AGENTGREP_INSTALL_DIR:-${HOME:?HOME is required}/.local/bin}"
if [[ -n "${AGENTGREP_BUILD_DIR:-}" ]]; then
  BUILD_DIR="$AGENTGREP_BUILD_DIR"
  CLEAN_BUILD_DIR=0
else
  BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentgrep-install.XXXXXX")"
  CLEAN_BUILD_DIR=1
fi
SRC_DIR="$BUILD_DIR/agentgrep"

cleanup() {
  if [[ "$CLEAN_BUILD_DIR" == "1" ]]; then
    rm -rf -- "$BUILD_DIR"
  fi
}
trap cleanup EXIT INT TERM

echo "==> agentgrep pinned install"
echo "    tag   : $TAG"
echo "    commit: $COMMIT"
echo "    install: $INSTALL_DIR/agentgrep"
echo "    source: $SRC_DIR"

mkdir -p "$INSTALL_DIR" "$BUILD_DIR"

if [[ "$AGENTGREP_SKIP_BUILD" == "1" && -x "$INSTALL_DIR/agentgrep" ]]; then
  echo "==> existing binary present and AGENTGREP_SKIP_BUILD=1 — skipping build"
  echo "==> verifying"
  "$INSTALL_DIR/agentgrep" --version
  echo "==> done. Binary already installed at $INSTALL_DIR/agentgrep"
  exit 0
fi

ensure_pinned_source() {
  if [[ -d "$SRC_DIR/.git" ]]; then
    echo "==> validating existing clone at $SRC_DIR"
    local current_commit
    current_commit="$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || true)"
    local current_desc
    current_desc="$(git -C "$SRC_DIR" describe --tags --exact-match 2>/dev/null || git -C "$SRC_DIR" describe --tags 2>/dev/null || echo "untagged")"
    echo "    current: tag=$current_desc commit=$current_commit"
    if [[ "$current_commit" == "$COMMIT" ]]; then
      echo "    clone already at pinned commit — reusing"
      return
    fi
    if [[ "$AGENTGREP_SKIP_BUILD" == "1" ]]; then
      echo "ERROR: existing clone does not match pinned commit ($current_commit != $COMMIT) and AGENTGREP_SKIP_BUILD=1" >&2
      exit 1
    fi
    echo "    mismatch — re-fetching pinned tag"
    git -C "$SRC_DIR" fetch --quiet --tags origin
    # Detach to the pinned tag (ignore local layout), then verify the commit.
    git -C "$SRC_DIR" checkout --detach --quiet "$TAG"
  else
    echo "==> cloning pinned tag $TAG (depth 1)"
    git clone --quiet --depth 1 --branch "$TAG" "$REPO_URL" "$SRC_DIR"
  fi

  local head_sha
  head_sha="$(git -C "$SRC_DIR" rev-parse HEAD)"
  echo "    head after fetch: $head_sha"
  if [[ "$head_sha" != "$COMMIT" ]]; then
    echo "ERROR: tag $TAG does not resolve to pinned commit $COMMIT (found $head_sha)." >&2
    echo "       Refusing to install a differently-pinned source. Investigate before continuing." >&2
    exit 1
  fi
}

ensure_pinned_source

if [[ -f "$SRC_DIR/Cargo.lock" ]]; then
  echo "==> cargo build --release --locked (pinned Cargo.lock present)"
  cargo build --release --locked --manifest-path "$SRC_DIR/Cargo.toml"
else
  # The agentgrep repo does not commit a Cargo.lock for this bin crate, so a
  # fresh clone cannot honor --locked. Generate the lockfile on first build;
  # it is then committed in the working tree and used as the pin thereafter.
  echo "==> cargo build --release (no committed Cargo.lock — generating lockfile)"
  cargo build --release --manifest-path "$SRC_DIR/Cargo.toml"
fi

TARGET_BIN="$SRC_DIR/target/release/agentgrep"
if [[ ! -x "$TARGET_BIN" ]]; then
  echo "ERROR: expected built binary not found at $TARGET_BIN" >&2
  exit 1
fi

echo "==> installing $TARGET_BIN -> $INSTALL_DIR/agentgrep"
INSTALL_TMP="$(mktemp "$INSTALL_DIR/.agentgrep.XXXXXX")"
install -m 0755 "$TARGET_BIN" "$INSTALL_TMP"
mv -f -- "$INSTALL_TMP" "$INSTALL_DIR/agentgrep"

echo "==> verifying"
"$INSTALL_DIR/agentgrep" --version

echo "==> done. Binary installed to $INSTALL_DIR/agentgrep"
echo "    The agentgrep plugin resolves it as the packaged default (no AGENTGREP_BIN / PATH needed)."
