// Codex Micro vendor HID channel (usage page 0xFF00): 64-byte reports laid out as
// [reportId=6, channel, payloadLength, ...payload(<=61)]. Channel 2 carries
// newline-delimited JSON-RPC, channel 1 firmware logs. Over Bluetooth LE the
// keyboard, consumer and mouse collections share the same HID handle.

import type { CodexMicroTransport } from "@t3tools/contracts";

const WORK_LOUDER_VENDOR_ID = 0x303a;
const CODEX_MICRO_PRODUCT_ID = 0x8360;
const VENDOR_USAGE_PAGE = 0xff00;

const REPORT_ID = 6;
const REPORT_SIZE = 64;
const MAX_PAYLOAD = REPORT_SIZE - 3;
export const CHANNEL_RPC = 2;

/** Firmware only accepts ids in [0, 999). */
export const MAX_RPC_ID = 999;

export const RPC_METHODS = {
  status: "device.status",
  lightingConfig: "v.oai.rgbcfg",
  slotLighting: "v.oai.thstatus",
} as const;

export const NOTIFY_METHODS = {
  key: "v.oai.hid",
  joystick: "v.oai.rad",
} as const;

export function encodeRpcRequest(method: string, params: unknown, id: number): Uint8Array[] {
  // The firmware JSON parser is ASCII-only.
  const json = JSON.stringify({ method, params, id }).replace(
    /[^\x00-\x7f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const bytes = new TextEncoder().encode(json);
  const reports: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += MAX_PAYLOAD) {
    const chunk = bytes.subarray(offset, offset + MAX_PAYLOAD);
    const report = new Uint8Array(REPORT_SIZE);
    report[0] = REPORT_ID;
    report[1] = CHANNEL_RPC;
    report[2] = chunk.length;
    report.set(chunk, 3);
    reports.push(report);
  }
  return reports;
}

export interface DecodedReport {
  readonly channel: number;
  readonly text: string;
}

/**
 * Input reports arrive with or without the report id depending on the OS
 * backend. A full-size report that starts with another id is keyboard, mouse
 * or consumer input sharing the handle (Bluetooth), not vendor traffic.
 */
export function decodeReport(data: Uint8Array): DecodedReport | null {
  const base = data[0] === REPORT_ID ? 1 : data.length === REPORT_SIZE - 1 ? 0 : -1;
  if (base < 0) return null;
  const channel = data[base];
  const length = data[base + 1];
  if (channel === undefined || length === undefined || length > MAX_PAYLOAD) return null;
  return {
    channel,
    text: new TextDecoder().decode(data.subarray(base + 2, base + 2 + length)),
  };
}

export interface HidCandidate {
  readonly path?: string | undefined;
  readonly vendorId: number;
  readonly productId: number;
  readonly usagePage?: number | undefined;
  readonly release: number;
}

export interface CodexMicroEndpoint {
  readonly path: string;
  readonly transport: CodexMicroTransport;
}

/** The firmware sets the low two bits of bcdDevice for wireless links. */
const transportOf = (device: HidCandidate): CodexMicroTransport =>
  device.release % 4 === 0 ? "usb" : "bluetooth";

/** Every reachable vendor endpoint, USB first: a cable is faster and never sleeps. */
export function findEndpoints(devices: ReadonlyArray<HidCandidate>): CodexMicroEndpoint[] {
  return devices
    .flatMap((device) =>
      device.path &&
      device.vendorId === WORK_LOUDER_VENDOR_ID &&
      device.productId === CODEX_MICRO_PRODUCT_ID &&
      device.usagePage === VENDOR_USAGE_PAGE
        ? [{ path: device.path, transport: transportOf(device) }]
        : [],
    )
    .toSorted(
      (left, right) => Number(right.transport === "usb") - Number(left.transport === "usb"),
    );
}

/**
 * Keeps the open endpoint while it is still listed and nothing better is,
 * otherwise names the endpoint to move to (or `null` when the device is gone).
 */
export function reconcileEndpoint(
  current: CodexMicroEndpoint | null,
  available: ReadonlyArray<CodexMicroEndpoint>,
): { readonly keep: true } | { readonly keep: false; readonly next: CodexMicroEndpoint | null } {
  const best = available[0] ?? null;
  if (
    current &&
    available.some((endpoint) => endpoint.path === current.path) &&
    (current.transport === "usb" || best?.transport !== "usb")
  ) {
    return { keep: true };
  }
  return { keep: false, next: best };
}

/** Reassembles newline-delimited lines per channel. */
export class LineAssembler {
  private readonly buffers = new Map<number, string>();

  push(report: DecodedReport): string[] {
    const parts = ((this.buffers.get(report.channel) ?? "") + report.text).split(/\r?\n/);
    this.buffers.set(report.channel, parts.pop() ?? "");
    return parts.map((line) => line.trim()).filter((line) => line.length > 0);
  }

  reset(): void {
    this.buffers.clear();
  }
}

export type RpcLine =
  | {
      readonly kind: "response";
      readonly id: string;
      readonly result: unknown;
      readonly error: string | null;
    }
  | {
      readonly kind: "notification";
      readonly method: string;
      readonly params: Record<string, unknown>;
    };

/** The firmware sometimes abbreviates `id/method/params` to `i/m/p`. */
export function parseRpcLine(line: string): RpcLine | null {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>;
  } catch {
    return null;
  }
  const id = message.id ?? message.i;
  if (id !== undefined && id !== null) {
    const error = message.error as { message?: unknown } | undefined;
    return {
      kind: "response",
      id: String(id),
      result: message.result,
      error: error ? String(error.message ?? "rpc error") : null,
    };
  }
  const method = message.method ?? message.m;
  if (typeof method !== "string") return null;
  const params = (message.params ?? message.p ?? {}) as Record<string, unknown>;
  return { kind: "notification", method, params };
}

/** Structural equality for the plain JSON-like values we diff before writing. */
export function isDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) =>
    isDeepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}
