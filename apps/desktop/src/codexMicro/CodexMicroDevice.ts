import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { devices as listHidDevices, HIDAsync } from "node-hid";

import {
  DISCONNECTED_CODEX_MICRO_STATE,
  type CodexMicroDeviceState,
  type CodexMicroEvent,
  type CodexMicroLighting,
} from "@t3tools/contracts";

import {
  CHANNEL_RPC,
  CODEX_MICRO_PRODUCT_ID,
  decodeReport,
  encodeRpcRequest,
  isDeepEqual,
  LineAssembler,
  MAX_RPC_ID,
  NOTIFY_METHODS,
  parseRpcLine,
  RPC_METHODS,
  VENDOR_USAGE_PAGE,
  WORK_LOUDER_VENDOR_ID,
} from "./CodexMicroProtocol.ts";
import { lightingFrame } from "./CodexMicroLighting.ts";

export class CodexMicroError extends Schema.TaggedError<CodexMicroError>()("CodexMicroError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface CodexMicroDevice {
  readonly getState: Effect.Effect<CodexMicroDeviceState>;
  readonly setLighting: (lighting: CodexMicroLighting) => Effect.Effect<void>;
}

const findDevicePath = (): string | null =>
  listHidDevices().find(
    (device) =>
      device.vendorId === WORK_LOUDER_VENDOR_ID &&
      device.productId === CODEX_MICRO_PRODUCT_ID &&
      device.usagePage === VENDOR_USAGE_PAGE,
  )?.path ?? null;

/**
 * Owns one Codex Micro for the lifetime of the scope: discovery, reconnects,
 * serialized JSON-RPC (the firmware handles one request at a time), lighting
 * with auto-dim, and key/joystick notifications.
 */
export const makeCodexMicroDevice = Effect.fn("desktop.codexMicro.makeDevice")(function* (
  onEvent: (event: CodexMicroEvent) => void,
) {
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const rpcLock = yield* Semaphore.make(1);
  const lines = new LineAssembler();
  const pending = new Map<string, Deferred.Deferred<unknown, CodexMicroError>>();

  let hid: HIDAsync | null = null;
  let state: CodexMicroDeviceState = DISCONNECTED_CODEX_MICRO_STATE;
  let lighting: CodexMicroLighting | null = null;
  let lightsOff = false;
  let appliedFrame: ReturnType<typeof lightingFrame> | null = null;
  let dimFiber: Fiber.Fiber<void> | null = null;

  const setState = (next: CodexMicroDeviceState) => {
    if (isDeepEqual(next, state)) return;
    state = next;
    onEvent({ type: "state", state });
  };

  const send = Effect.fn("desktop.codexMicro.send")(function* (method: string, params: unknown) {
    const device = hid;
    if (!device) return yield* new CodexMicroError({ message: "Codex Micro is not connected" });
    const id = yield* Random.nextIntBetween(0, MAX_RPC_ID);
    const response = yield* Deferred.make<unknown, CodexMicroError>();
    pending.set(String(id), response);
    return yield* Effect.gen(function* () {
      for (const report of encodeRpcRequest(method, params, id)) {
        yield* Effect.tryPromise({
          try: () => device.write(Buffer.from(report)),
          catch: (cause) => new CodexMicroError({ message: `Codex Micro write failed`, cause }),
        });
      }
      return yield* Deferred.await(response).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () =>
            Effect.fail(new CodexMicroError({ message: `Codex Micro ${method} timed out` })),
        }),
      );
    }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(String(id)))));
  });

  // A short cooldown between requests keeps the firmware's parser happy.
  const call = (method: string, params: unknown) =>
    rpcLock.withPermits(1)(send(method, params).pipe(Effect.tap(() => Effect.sleep("15 millis"))));

  const applyLighting = Effect.gen(function* () {
    if (!hid || !lighting) return;
    const frame = lightingFrame(lighting, lightsOff);
    if (isDeepEqual(frame, appliedFrame)) return;
    appliedFrame = frame;
    yield* call(RPC_METHODS.lightingConfig, frame.zones);
    yield* call(RPC_METHODS.slotLighting, frame.slots);
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        appliedFrame = null;
      }).pipe(Effect.andThen(Effect.logWarning("Codex Micro lighting update failed", error))),
    ),
  );

  /** Input or a lighting change restores the lights and restarts auto-dim. */
  const wake = () => {
    if (dimFiber) runFork(Fiber.interrupt(dimFiber));
    dimFiber = null;
    const autoDimMs = lighting?.autoDimMs;
    if (autoDimMs) {
      dimFiber = runFork(
        Effect.sleep(autoDimMs).pipe(
          Effect.andThen(Effect.sync(() => (lightsOff = true))),
          Effect.andThen(applyLighting),
        ),
      );
    }
    if (lightsOff) {
      lightsOff = false;
      runFork(applyLighting);
    }
  };

  const onData = (data: Buffer) => {
    const report = decodeReport(data);
    if (!report || report.channel !== CHANNEL_RPC) return;
    for (const line of lines.push(report)) {
      const message = parseRpcLine(line);
      if (!message) continue;
      if (message.kind === "response") {
        const response = pending.get(message.id);
        if (!response) continue;
        runFork(
          message.error
            ? Deferred.fail(response, new CodexMicroError({ message: message.error }))
            : Deferred.succeed(response, message.result),
        );
        continue;
      }
      const { method, params } = message;
      if (method === NOTIFY_METHODS.key) {
        wake();
        const act = typeof params.act === "number" ? params.act : null;
        onEvent({ type: "input", input: { type: "key", key: String(params.k), act } });
      } else if (method === NOTIFY_METHODS.joystick) {
        const distance = Number(params.d);
        if (distance > 0.1) wake();
        onEvent({ type: "input", input: { type: "joystick", angle: Number(params.a), distance } });
      }
    }
  };

  const disconnect = Effect.gen(function* () {
    const device = hid;
    hid = null;
    lines.reset();
    for (const response of pending.values()) {
      yield* Deferred.fail(response, new CodexMicroError({ message: "Codex Micro disconnected" }));
    }
    pending.clear();
    if (device) yield* Effect.promise(() => device.close()).pipe(Effect.ignore);
    setState(DISCONNECTED_CODEX_MICRO_STATE);
  });

  const refreshStatus = Effect.gen(function* () {
    const status = (yield* call(RPC_METHODS.status, null)) as Record<string, unknown> | null;
    setState({
      connected: true,
      firmwareVersion: typeof status?.version === "string" ? status.version : null,
      batteryPercentage: typeof status?.battery === "number" ? status.battery : null,
      charging: typeof status?.is_charging === "boolean" ? status.is_charging : null,
    });
  }).pipe(Effect.catch((error) => Effect.logWarning("Codex Micro status request failed", error)));

  const connect = Effect.fn("desktop.codexMicro.connect")(function* (path: string) {
    // Non-exclusive so the keyboard and consumer interfaces keep working (macOS).
    const device = yield* Effect.tryPromise({
      try: () => HIDAsync.open(path, { nonExclusive: true }),
      catch: (cause) => new CodexMicroError({ message: "Could not open Codex Micro", cause }),
    });
    device.on("data", onData);
    device.on("error", (cause: unknown) => {
      if (hid !== device) return;
      runFork(
        Effect.logWarning("Codex Micro connection lost", cause).pipe(Effect.andThen(disconnect)),
      );
    });
    hid = device;
    appliedFrame = null;
    setState({ ...DISCONNECTED_CODEX_MICRO_STATE, connected: true });
    wake();
    yield* applyLighting;
    yield* refreshStatus;
  });

  // Poll for the device while disconnected; refresh battery while connected.
  yield* Effect.gen(function* () {
    if (hid) return;
    const path = findDevicePath();
    if (path) yield* connect(path);
  }).pipe(
    // Usually missing Input Monitoring permission or another app holding the device.
    Effect.catch((error) => Effect.logWarning("Codex Micro connection failed", error)),
    Effect.repeat(Schedule.spaced("2 seconds")),
    Effect.forkScoped,
  );
  yield* Effect.gen(function* () {
    if (hid) yield* refreshStatus;
  }).pipe(Effect.delay("1 minute"), Effect.forever, Effect.forkScoped);

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (dimFiber) yield* Fiber.interrupt(dimFiber);
      // Leave the device dark rather than frozen on stale thread states.
      lightsOff = true;
      yield* applyLighting;
      yield* disconnect;
    }),
  );

  return {
    getState: Effect.sync(() => state),
    setLighting: Effect.fn("desktop.codexMicro.setLighting")(function* (next: CodexMicroLighting) {
      const changed = !isDeepEqual(next, lighting);
      lighting = next;
      if (changed) wake();
      yield* applyLighting;
    }),
  } satisfies CodexMicroDevice;
});
