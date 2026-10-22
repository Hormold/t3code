import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { KeybindingCommand } from "./keybindings.ts";

/**
 * Work Louder Codex Micro: six agent keys that mirror threads, seven command
 * keys, a knob and an analog stick. The desktop main process owns the HID
 * connection; the renderer decides what the keys show and do.
 */

export const CODEX_MICRO_SLOT_COUNT = 6;

export const CodexMicroSlotStatus = Schema.Literals([
  "off",
  "idle",
  "working",
  "needs-input",
  "done",
  "error",
]);
export type CodexMicroSlotStatus = typeof CodexMicroSlotStatus.Type;

export const CodexMicroControlId = Schema.Literals([
  "ACT06",
  "ACT07",
  "ACT08",
  "ACT09",
  "ACT10",
  "ACT11",
  "ACT12",
  "ENC",
  "ENC_CW",
  "ENC_CC",
  "JOY_UP",
  "JOY_DOWN",
  "JOY_LEFT",
  "JOY_RIGHT",
]);
export type CodexMicroControlId = typeof CodexMicroControlId.Type;

export const CodexMicroAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({ type: Schema.Literal("approve") }),
  Schema.Struct({ type: Schema.Literal("approveForSession") }),
  Schema.Struct({ type: Schema.Literal("decline") }),
  Schema.Struct({ type: Schema.Literal("stop") }),
  Schema.Struct({ type: Schema.Literal("nextSlot") }),
  Schema.Struct({ type: Schema.Literal("previousSlot") }),
  Schema.Struct({ type: Schema.Literal("openSelected") }),
  Schema.Struct({ type: Schema.Literal("command"), command: KeybindingCommand }),
]);
export type CodexMicroAction = typeof CodexMicroAction.Type;

export const CodexMicroAgentMode = Schema.Literals(["priority", "pinned", "recent"]);
export type CodexMicroAgentMode = typeof CodexMicroAgentMode.Type;

export const CodexMicroKnobMode = Schema.Literals(["agents", "threads", "custom"]);
export type CodexMicroKnobMode = typeof CodexMicroKnobMode.Type;

export const DEFAULT_CODEX_MICRO_CONTROLS: Readonly<Record<CodexMicroControlId, CodexMicroAction>> =
  {
    ACT06: { type: "approve" },
    ACT07: { type: "decline" },
    ACT08: { type: "stop" },
    ACT09: { type: "command", command: "chat.new" },
    ACT10: { type: "command", command: "terminal.toggle" },
    ACT11: { type: "command", command: "diff.toggle" },
    ACT12: { type: "command", command: "commandPalette.toggle" },
    ENC: { type: "openSelected" },
    ENC_CW: { type: "nextSlot" },
    ENC_CC: { type: "previousSlot" },
    JOY_UP: { type: "command", command: "thread.previous" },
    JOY_DOWN: { type: "command", command: "thread.next" },
    JOY_LEFT: { type: "command", command: "navigation.back" },
    JOY_RIGHT: { type: "command", command: "navigation.forward" },
  };

const Brightness = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const AutoDimMs = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 24 * 60 * 60_000 })),
);

export const CodexMicroSettings = Schema.Struct({
  agentMode: CodexMicroAgentMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("priority" as const)),
  ),
  knobMode: CodexMicroKnobMode.pipe(Schema.withDecodingDefault(Effect.succeed("agents" as const))),
  /** One wide keycap covers ACT10 + ACT11; when false only ACT10 is used. */
  separateMicrophoneKeys: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Thread ids pinned to agent keys 1–6 (null = follow `agentMode`). */
  pinnedThreads: Schema.Array(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefault(Effect.succeed([null, null, null, null, null, null])),
  ),
  controls: Schema.Record(CodexMicroControlId, CodexMicroAction).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CODEX_MICRO_CONTROLS)),
  ),
  brightness: Brightness.pipe(Schema.withDecodingDefault(Effect.succeed(0.8))),
  autoDimMs: AutoDimMs.pipe(Schema.withDecodingDefault(Effect.succeed(600_000))),
  keysBacklight: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type CodexMicroSettings = typeof CodexMicroSettings.Type;

export const CodexMicroDeviceState = Schema.Struct({
  connected: Schema.Boolean,
  firmwareVersion: Schema.NullOr(Schema.String),
  batteryPercentage: Schema.NullOr(Schema.Number),
  charging: Schema.NullOr(Schema.Boolean),
});
export type CodexMicroDeviceState = typeof CodexMicroDeviceState.Type;

export const DISCONNECTED_CODEX_MICRO_STATE: CodexMicroDeviceState = {
  connected: false,
  firmwareVersion: null,
  batteryPercentage: null,
  charging: null,
};

/** `act`: 1 press, 0 release, 2 knob tick. Keys: AG00–AG05, ACT06–ACT12, ENC*, ENC_CW, ENC_CC. */
export const CodexMicroInputEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("key"),
    key: Schema.String,
    act: Schema.NullOr(Schema.Number),
  }),
  /** angle 0–1 clockwise from +x in screen space (0.75 = up); distance 0–1. */
  Schema.Struct({
    type: Schema.Literal("joystick"),
    angle: Schema.Number,
    distance: Schema.Number,
  }),
]);
export type CodexMicroInputEvent = typeof CodexMicroInputEvent.Type;

export const CodexMicroEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("state"), state: CodexMicroDeviceState }),
  Schema.Struct({ type: Schema.Literal("input"), input: CodexMicroInputEvent }),
]);
export type CodexMicroEvent = typeof CodexMicroEvent.Type;

/** What the renderer wants the device to show; the main process maps it to LEDs. */
export const CodexMicroLighting = Schema.Struct({
  slots: Schema.Array(
    Schema.Struct({ status: CodexMicroSlotStatus, selected: Schema.Boolean }),
  ).check(Schema.isMaxLength(CODEX_MICRO_SLOT_COUNT)),
  brightness: Brightness,
  autoDimMs: AutoDimMs,
  keysBacklight: Schema.Boolean,
});
export type CodexMicroLighting = typeof CodexMicroLighting.Type;

/** Codex Micro's own status colors (packed RGB). */
export const CODEX_MICRO_STATUS_COLORS: Readonly<
  Record<Exclude<CodexMicroSlotStatus, "off">, number>
> = {
  working: 0x304ffe,
  "needs-input": 0xff6d00,
  done: 0x00ff4c,
  error: 0xff0033,
  idle: 0xffffff,
};
