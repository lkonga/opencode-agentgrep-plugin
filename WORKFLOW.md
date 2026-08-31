# opencode-agentgrep — what to do when you change it

## Plugin-only (this repo) — **no `build-opencode`**

| You changed | Do this | Version string in TUI |
|-------------|---------|------------------------|
| `index.ts`, `agentgrep-*.ts`, README | **Restart `oc`** (or new session) | **Unchanged** — still the fork binary version |
| Schema / argv behavior | Run `bun test` + `bunx tsc --noEmit` first | — |
| Real-CLI behavior | Re-run the smoke suite (needs `~/.local/bin/agentgrep`) | — |

The agentgrep plugin is loaded as a **`file:///…/opencode-agentgrep` directory
plugin** in `opencode.json` — loaded at runtime, no rebuild needed. A `git tag`
of the repo is the checkpoint (`git tag -l`).

## Fork binary (only when you change opencode-patches / upstream)

```bash
cd ~/codes/opencode-patches
# merge your branch first if needed
build-opencode --no-update   # or your usual flags; agentgrep is NOT a patch anymore
oc --version                 # hash suffix may change; still *-dev-patched-*
```

agentgrep is **not** in `patch-registry` / `build-opencode` — there is no
`agentgrep.source.*` patch to rebuild. Deleting/ignoring those does not require
a fork rebuild for this plugin.

## Publishing

Tag `v*.*.*` on `main` triggers `.github/workflows/publish.yml` (npm
`@lkonga/opencode-agentgrep`). npm installs use the published package; local
`file://` installs ignore npm entirely.
