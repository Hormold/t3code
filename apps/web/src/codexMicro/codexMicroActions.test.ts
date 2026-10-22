import { DEFAULT_CODEX_MICRO_CONTROLS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CODEX_MICRO_ACTION_GROUPS,
  codexMicroJoystickControl,
  codexMicroShortcutEvent,
  describeCodexMicroAction,
  resolveCodexMicroControl,
} from "./codexMicroActions";

describe("codexMicroActions", () => {
  it("builds the picker with plain command names", () => {
    const labels = CODEX_MICRO_ACTION_GROUPS.flatMap((group) => group.options).map((o) => o.label);
    expect(labels).toContain("New thread");
    expect(labels).toContain("Approve");
    expect(describeCodexMicroAction({ type: "command", command: "terminal.toggle" })).toBe(
      "Toggle terminal",
    );
  });

  it("applies knob presets unless the knob is custom", () => {
    const controls = { ...DEFAULT_CODEX_MICRO_CONTROLS, ENC_CW: { type: "none" as const } };
    expect(resolveCodexMicroControl("ENC_CW", "threads", controls)).toEqual({
      type: "command",
      command: "thread.next",
    });
    expect(resolveCodexMicroControl("ENC_CW", "custom", controls)).toEqual({ type: "none" });
  });

  it("maps joystick angles like Codex", () => {
    expect(codexMicroJoystickControl(0.75)).toBe("JOY_UP");
    expect(codexMicroJoystickControl(0.25)).toBe("JOY_DOWN");
    expect(codexMicroJoystickControl(0.5)).toBe("JOY_LEFT");
    expect(codexMicroJoystickControl(0.95)).toBe("JOY_RIGHT");
  });

  it("replays the bound shortcut with the platform modifier", () => {
    const keybindings = [
      {
        command: "terminal.toggle" as const,
        shortcut: {
          key: "j",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
    ];
    expect(codexMicroShortcutEvent(keybindings, "terminal.toggle", "MacIntel")).toMatchObject({
      key: "j",
      metaKey: true,
      ctrlKey: false,
    });
    expect(codexMicroShortcutEvent(keybindings, "diff.toggle", "MacIntel")).toBeNull();
  });
});
