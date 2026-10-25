import { assert, describe, it } from "@effect/vitest";

import {
  decodeReport,
  encodeRpcRequest,
  findEndpoints,
  LineAssembler,
  parseRpcLine,
  reconcileEndpoint,
} from "./CodexMicroProtocol.ts";
import { lightingFrame } from "./CodexMicroLighting.ts";

describe("Codex Micro protocol", () => {
  it("splits requests into 64-byte reports and reassembles them", () => {
    const params = { text: "x".repeat(150), title: "привет" };
    const reports = encodeRpcRequest("v.oai.thstatus", params, 7);
    assert.isAbove(reports.length, 2);
    for (const report of reports) {
      assert.strictEqual(report.length, 64);
      assert.strictEqual(report[0], 6);
      assert.strictEqual(report[1], 2);
      assert.isAtMost(report[2] ?? 0, 61);
    }
    const lines = new LineAssembler();
    const out = reports.flatMap((report) => lines.push(decodeReport(report)!));
    out.push(...lines.push({ channel: 2, text: "\n" }));
    assert.deepStrictEqual(JSON.parse(out[0]!), { method: "v.oai.thstatus", params, id: 7 });
  });

  it("decodes reports with or without the report id", () => {
    const payload = [...new TextEncoder().encode("abc")];
    assert.deepStrictEqual(decodeReport(Uint8Array.from([6, 2, 3, ...payload])), {
      channel: 2,
      text: "abc",
    });
    const withoutId = new Uint8Array(63);
    withoutId.set([2, 3, ...payload]);
    assert.deepStrictEqual(decodeReport(withoutId), { channel: 2, text: "abc" });
  });

  it("ignores keyboard, consumer and mouse reports sharing a Bluetooth handle", () => {
    const consumer = new Uint8Array(64);
    consumer.set([2, 3, 0xe9, 0x00]);
    assert.isNull(decodeReport(consumer));
    assert.isNull(decodeReport(Uint8Array.from([1, 0, 0, 4, 0, 0, 0, 0, 0])));
    assert.isNull(decodeReport(Uint8Array.from([3, 0, 1, 255])));
  });

  const hid = (path: string, release: number, usagePage = 0xff00) => ({
    path,
    vendorId: 0x303a,
    productId: 0x8360,
    usagePage,
    release,
  });

  it("finds vendor endpoints and prefers USB over Bluetooth", () => {
    assert.deepStrictEqual(
      findEndpoints([
        hid("ble", 177),
        hid("kbd", 176, 1),
        hid("usb", 176),
        { ...hid("x", 0), productId: 1 },
      ]),
      [
        { path: "usb", transport: "usb" },
        { path: "ble", transport: "bluetooth" },
      ],
    );
  });

  it("follows the live endpoint and hands off to USB", () => {
    const usb = { path: "usb", transport: "usb" } as const;
    const ble = { path: "ble", transport: "bluetooth" } as const;
    assert.deepStrictEqual(reconcileEndpoint(null, []), { keep: false, next: null });
    assert.deepStrictEqual(reconcileEndpoint(null, [ble]), { keep: false, next: ble });
    assert.deepStrictEqual(reconcileEndpoint(ble, [ble]), { keep: true });
    assert.deepStrictEqual(reconcileEndpoint(ble, [usb, ble]), { keep: false, next: usb });
    assert.deepStrictEqual(reconcileEndpoint(usb, [usb, ble]), { keep: true });
    // Unplugging the cable (or a new pairing handle after sleep) moves to what is left.
    assert.deepStrictEqual(reconcileEndpoint(usb, [ble]), { keep: false, next: ble });
    assert.deepStrictEqual(reconcileEndpoint(ble, []), { keep: false, next: null });
  });

  it("parses responses and abbreviated notifications", () => {
    assert.deepStrictEqual(parseRpcLine(`{"result":{"ok":1},"id":42}`), {
      kind: "response",
      id: "42",
      result: { ok: 1 },
      error: null,
    });
    assert.deepStrictEqual(parseRpcLine(`{"m":"v.oai.hid","p":{"k":"AG01","act":1}}`), {
      kind: "notification",
      method: "v.oai.hid",
      params: { k: "AG01", act: 1 },
    });
    assert.isNull(parseRpcLine("garbage"));
  });
});

describe("Codex Micro lighting", () => {
  const lighting = {
    slots: [
      { status: "needs-input", selected: false },
      { status: "working", selected: true },
      { status: "idle", selected: false },
    ],
    brightness: 0.8,
    autoDimMs: null,
    keysBacklight: false,
  } as const;

  it("lights the ring with the most urgent state and keys per thread", () => {
    const frame = lightingFrame(lighting, false);
    assert.strictEqual(frame.zones.ambient.c, 0xff6d00);
    assert.strictEqual(frame.slots.length, 6);
    assert.strictEqual(frame.slots[1]?.c, 0x304ffe);
    assert.isBelow(frame.slots[2]?.b ?? 1, 0.8);
    assert.strictEqual(frame.slots[5]?.b, 0);
  });
});
