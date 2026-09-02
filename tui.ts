// agentgrep TUI facade — a tiny, separate TUI plugin loaded ONLY from
// `tui.json` (never from `plugin` in opencode.json).
//
// It makes the plugin visible in the TUI Plugins screen and provides at most a
// harmless `/agentgrep` command that explains the canonical SERVER tool
// status/config via a toast. It does NOT duplicate the server tool, does NOT
// register any server hooks, and does NOT access secrets. The TUI Plugins
// screen reflects TUI-side load status only — live server tool availability is
// a server-plugin concern (see index.ts / README).
//
// ⚠️ This module is NOT a server plugin entrypoint: it exports only the TUI
// module shape (`{ id, tui }`) and never a `server` export.

import type { TuiPluginModule } from "@opencode-ai/plugin/tui"

export default {
  id: "agentgrep",
  tui: async (api) => {
    api.command?.register(() => [
      {
        title: "agentgrep: canonical server tool status",
        value: "agentgrep.status",
        description:
          "agentgrep server plugin status: the default registry exposes only canonical `agentgrep` with mode=grep|find|outline|trace and replaces native grep/glob.",
        category: "agentgrep",
        slash: { name: "agentgrep", aliases: [] },
        onSelect: () => {
          api.ui.toast({
            variant: "info",
            title: "agentgrep",
            message:
              "Canonical server tool: agentgrep (mode grep|find|outline|trace). Native grep/glob are replaced by default; compatibility aliases require explicit plugin tuple options. Check the server tool registry for live availability.",
          })
        },
      },
    ])
  },
} satisfies TuiPluginModule
