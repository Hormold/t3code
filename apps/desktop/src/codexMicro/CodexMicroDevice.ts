import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { HIDAsync } from "node-hid";

import {
  DISCONNECTED_CODEX_MICRO_STATE,
  type CodexMicroDeviceState,
  type CodexMicroEvent,
  type CodexMicroLighting,
} from "@t3tools/contracts";

import {
  CHANNEL_RPC,
  type CodexMicroEndpoint,
  decodeReport,
  encodeRpcRequest,
  findEndpoints,
  isDeepEqual,
  LineAssembler,
  MAX_RPC_ID,
  NOTIFY_METHODS,
  parseRpcLine,
  reconcileEndpoint,
  RPC_METHODS,
} from "./CodexMicroProtocol.ts";
import { lightingFrame } from "./CodexMicroLighting.ts";

export class CodexMicroError extends Schema.TaggedError<CodexMicroError>()("CodexMicroError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const MAX_CONSECUTIVE_FAILURES = 3;

export interface CodexMicroDevice {
  readonly getState: Effect.Effect<CodexMicroDeviceState>;
  readonly setLighting: (lighting: CodexMicroLighting) => Effect.Effect<void>;
}

// A failed open waits this long before retrying, unless the topology changes.
const RETRY_AFTER_FAILURE_MS = 10_000;

// node-hid is a native addon: load it on first use so a broken prebuild can
// only disable the Codex Micro, never stop the desktop app from starting.
let nodeHid: Promise<typeof import("node-hid")> | null = null;
const loadNodeHid = Effect.tryPromise({
  try: () => (nodeHid ??= import("node-hid")),
  catch: (cause) => new CodexMicroError({ message: "Could not load node-hid", cause }),
});

// Enumeration is async so polling never blocks the main process.
const listEndpoints = loadNodeHid.pipe(
  Effect.flatMap((hidModule) =>
    Effect.tryPromise({
      try: () => hidModule.devicesAsync(),
      catch: (cause) => new CodexMicroError({ message: "Could not list HID devices", cause }),
    }),
  ),
  Effect.map(findEndpoints),
);

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
  let endpoint: CodexMicroEndpoint | null = null;
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
    const id = yield* Random.nextIntBetween(0, MAX_RPC_ID, { halfOpen: true });
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
  // A handle can go dead without a read error (sleep/wake, a dropped Bluetooth
  // link). Treat a run of failed requests as a disconnect so discovery reopens it.
  let consecutiveFailures = 0;
  const call = (method: string, params: unknown) =>
    rpcLock.withPermits(1)(
      send(method, params).pipe(
        Effect.tap(() => Effect.sync(() => (consecutiveFailures = 0))),
        Effect.tapError(() =>
          Effect.suspend(() =>
            ++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? disconnect : Effect.void,
          ),
        ),
        Effect.ensuring(Effect.sleep("15 millis")),
      ),
    );

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
      if (method === NOTIFY_METHODS.key && typeof params.k === "string") {
        wake();
        const act = typeof params.act === "number" ? params.act : null;
        onEvent({ type: "input", input: { type: "key", key: params.k, act } });
      } else if (
        method === NOTIFY_METHODS.joystick &&
        Number.isFinite(params.a) &&
        Number.isFinite(params.d)
      ) {
        const angle = params.a as number;
        const distance = params.d as number;
        if (distance > 0.1) wake();
        onEvent({ type: "input", input: { type: "joystick", angle, distance } });
      }
    }
  };

  const disconnect: Effect.Effect<void> = Effect.gen(function* () {
    const device = hid;
    consecutiveFailures = 0;
    hid = null;
    endpoint = null;
    lines.reset();
    for (const response of pending.values()) {
      yield* Deferred.fail(response, new CodexMicroError({ message: "Codex Micro disconnected" }));
    }
    pending.clear();
    if (device) {
      // An unplugged or out-of-range device can reject close(); it must not
      // stop the disconnected state from reaching the renderer.
      yield* Effect.tryPromise({
        try: () => device.close(),
        catch: (cause) => new CodexMicroError({ message: "Could not close Codex Micro", cause }),
      }).pipe(Effect.ignore);
    }
    setState(DISCONNECTED_CODEX_MICRO_STATE);
  });

  const refreshStatus = Effect.gen(function* () {
    const status = (yield* call(RPC_METHODS.status, null)) as Record<string, unknown> | null;
    setState({
      connected: true,
      transport: endpoint?.transport ?? null,
      firmwareVersion: typeof status?.version === "string" ? status.version : null,
      batteryPercentage: typeof status?.battery === "number" ? status.battery : null,
      charging: typeof status?.is_charging === "boolean" ? status.is_charging : null,
    });
  }).pipe(Effect.catch((error) => Effect.logWarning("Codex Micro status request failed", error)));

  const connect = Effect.fn("desktop.codexMicro.connect")(function* (next: CodexMicroEndpoint) {
    const { HIDAsync } = yield* loadNodeHid;
    // Non-exclusive so the keyboard and consumer collections keep working:
    // over Bluetooth they share this very handle (macOS).
    const device = yield* Effect.tryPromise({
      try: () => HIDAsync.open(next.path, { nonExclusive: true }),
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
    endpoint = next;
    appliedFrame = null;
    setState({ ...DISCONNECTED_CODEX_MICRO_STATE, connected: true, transport: next.transport });
    wake();
    yield* applyLighting;
    yield* refreshStatus;
  });

  // Reconcile the HID topology on every poll, connected or not. A Bluetooth
  // handle can vanish without a read error (sleep, out of range, a channel
  // switch), and plugging in the cable flips the device to its USB endpoint,
  // so follow whichever endpoint is live and prefer USB when both are.
  // A failing open (usually missing Input Monitoring permission) backs off and
  // is logged once per distinct error rather than on every poll.
  let lastConnectError: string | null = null;
  let retryAt = 0;
  let lastTopology = "";
  yield* Effect.gen(function* () {
    const available = yield* listEndpoints;
    const topology = available.map((candidate) => candidate.path).join("\n");
    if (topology !== lastTopology) {
      lastTopology = topology;
      retryAt = 0;
    }
    const plan = reconcileEndpoint(hid ? endpoint : null, available);
    if (plan.keep) return;
    if (hid) yield* disconnect;
    const now = yield* Clock.currentTimeMillis;
    if (!plan.next || now < retryAt) return;
    yield* connect(plan.next).pipe(
      Effect.tapError(() => Effect.sync(() => (retryAt = now + RETRY_AFTER_FAILURE_MS))),
    );
    lastConnectError = null;
  }).pipe(
    Effect.catch((error) => {
      const message = String(error.cause ?? error.message);
      if (message === lastConnectError) return Effect.void;
      lastConnectError = message;
      return Effect.logWarning("Codex Micro connection failed", error);
    }),
    Effect.repeat(Schedule.spaced("2 seconds")),
    Effect.forkScoped,
  );
  yield* Effect.gen(function* () {
    if (hid) yield* refreshStatus;
  }).pipe(Effect.delay("1 minute"), Effect.forever, Effect.forkScoped);

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (dimFiber) yield* Fiber.interrupt(dimFiber);
      // Leave the device dark rather than frozen on stale thread states, but
      // never hold up quitting on an unresponsive device.
      lightsOff = true;
      yield* applyLighting.pipe(
        Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }),
      );
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
