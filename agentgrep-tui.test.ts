// agentgrep-tui — lightweight import-shape tests for the separate TUI facade
// (`tui.ts`). The TUI plugin is loaded only from `tui.json` and must:
//   - export ONLY the default TUI module object (loader shape);
//   - carry a mandatory unique id and a `tui()` function;
//   - NOT export a `server` (it is not a server plugin);
//   - register at most a harmless `/agentgrep` command/toast and never
//     duplicate the server tool or touch secrets.

import { describe, test, expect } from "bun:test"
import tuiPlugin from "./tui"

function fakeTuiApi(): {
  api: Parameters<typeof tuiPlugin.tui>[0]
  registered: unknown[]
  toasts: unknown[]
} {
  const registered: unknown[] = []
  const toasts: unknown[] = []
  const api = {
    command: {
      register: (cb: () => unknown[]) => {
        registered.push(...cb())
        return () => {}
      },
      trigger: () => {},
      show: () => {},
    },
    ui: { toast: (t: unknown) => void toasts.push(t) },
  }
  return { api: api as unknown as Parameters<typeof tuiPlugin.tui>[0], registered, toasts }
}

describe("TUI facade module shape (tui.ts)", () => {
  test("tui.ts exports ONLY the default TUI module", async () => {
    const mod = await import("./tui")
    expect(Object.keys(mod)).toEqual(["default"])
  })

  test("default export has unique id + tui() function and NO server export", () => {
    expect(tuiPlugin.id).toBe("agentgrep")
    expect(typeof tuiPlugin.tui).toBe("function")
    expect("server" in tuiPlugin).toBe(false)
  })

  test("tui() registers the /agentgrep command and shows a status toast", async () => {
    const { api, registered, toasts } = fakeTuiApi()
    await tuiPlugin.tui(api)
    expect(registered).toHaveLength(1)
    const command = registered[0] as { slash?: { name?: string }; onSelect?: () => void; description?: string }
    expect(command.slash?.name).toBe("agentgrep")
    expect(command.description ?? "").toContain("only canonical `agentgrep`")
    expect(command.description ?? "").toContain("mode=grep|find|outline|trace")
    expect(command.description ?? "").not.toMatch(/`find`.*shortcut/i)
    command.onSelect?.()
    expect(toasts).toHaveLength(1)
    const toast = toasts[0] as { title?: string; message?: string }
    expect(toast.title).toBe("agentgrep")
    expect(toast.message ?? "").toContain("agentgrep (mode grep|find|outline|trace)")
    expect(toast.message ?? "").toContain("Native grep/glob are replaced by default")
    expect(toast.message ?? "").not.toMatch(/`find`.*shortcut/i)
  })

  test("tui() is a no-op when the legacy command API is absent", async () => {
    const api = { ui: { toast: () => {} } }
    await expect(tuiPlugin.tui(api as never)).resolves.toBeUndefined()
  })
})
