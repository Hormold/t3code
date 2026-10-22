import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  CodexMicroAction,
  CodexMicroControlId,
  CodexMicroInputEvent,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import {
  codexMicroJoystickControl,
  codexMicroShortcutEvent,
  resolveCodexMicroControl,
} from "../../codexMicro/codexMicroActions";
import { assignCodexMicroSlots } from "../../codexMicro/codexMicroSlots";
import {
  isCodexMicroAvailable,
  readCodexMicroSnapshot,
  setCodexMicroSlots,
  subscribeCodexMicroInput,
  useCodexMicroSnapshot,
} from "../../codexMicro/codexMicroStore";
import { useClientSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useQuietThreadShells } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";

const AGENT_KEY = /^AG0([0-5])$/;
const JOYSTICK_TRIGGER = 0.5;
const JOYSTICK_RELEASE = 0.2;

const hasApproval = (thread: SidebarThreadSummary | undefined): thread is SidebarThreadSummary =>
  thread !== undefined &&
  thread.hasPendingApprovals &&
  thread.source.pendingRuntimeRequest !== null;
const isWorking = (thread: SidebarThreadSummary) =>
  thread.runtime !== null &&
  ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status);

/**
 * Drives a connected Codex Micro: agent keys mirror the six most relevant
 * threads, other controls run T3 commands. Desktop only; the main process
 * owns the HID connection.
 */
export function CodexMicroCoordinator() {
  return isCodexMicroAvailable() ? <CodexMicroController /> : null;
}

function CodexMicroController() {
  const navigate = useNavigate();
  const settings = useClientSettings((current) => current.codexMicro);
  const environmentId = usePrimaryEnvironmentId();
  const shells = useQuietThreadShells();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { device, slots, selectedSlot } = useCodexMicroSnapshot();
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval);
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn);
  const joystickArmed = useRef(true);

  const threads = shells.filter((thread) => thread.environmentId === environmentId);
  const threadsById = new Map(threads.map((thread) => [thread.id as string, thread]));

  // Recompute key assignments whenever threads or settings change.
  useEffect(() => {
    const current = readCodexMicroSnapshot();
    const next = assignCodexMicroSlots({
      threads,
      previous: current.slots,
      mode: settings.agentMode,
      pinnedThreads: settings.pinnedThreads,
      now: new Date().toISOString(),
    });
    const changed = next.some(
      (slot, index) =>
        slot.threadId !== current.slots[index]?.threadId ||
        slot.status !== current.slots[index]?.status ||
        slot.title !== current.slots[index]?.title,
    );
    if (!changed) return;
    const selected = current.selectedSlot;
    setCodexMicroSlots(next, selected !== null && next[selected]?.threadId ? selected : null);
  }, [threads, settings.agentMode, settings.pinnedThreads]);

  useEffect(() => {
    if (!device.connected) return;
    void window.desktopBridge?.codexMicro?.setLighting({
      slots: slots.map((slot) => ({ status: slot.status, selected: slot.index === selectedSlot })),
      brightness: settings.brightness,
      autoDimMs: settings.autoDimMs,
      keysBacklight: settings.keysBacklight,
    });
  }, [
    device.connected,
    slots,
    selectedSlot,
    settings.brightness,
    settings.autoDimMs,
    settings.keysBacklight,
  ]);

  const openSlot = (index: number) => {
    const slot = readCodexMicroSnapshot().slots[index];
    if (!slot?.threadId || !slot.environmentId) return;
    setCodexMicroSlots(readCodexMicroSnapshot().slots, index);
    void window.desktopBridge?.revealWindow?.();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(slot.environmentId, slot.threadId)),
    });
  };

  const cycleSelection = (step: 1 | -1) => {
    const snapshot = readCodexMicroSnapshot();
    const filled = snapshot.slots.filter((slot) => slot.threadId).map((slot) => slot.index);
    if (filled.length === 0) return;
    const position = snapshot.selectedSlot === null ? -1 : filled.indexOf(snapshot.selectedSlot);
    const next =
      position === -1
        ? filled[step === 1 ? 0 : filled.length - 1]!
        : filled[(position + step + filled.length) % filled.length]!;
    setCodexMicroSlots(snapshot.slots, next);
  };

  const slotThreads = () =>
    readCodexMicroSnapshot().slots.flatMap((slot) => {
      const thread = slot.threadId ? threadsById.get(slot.threadId) : undefined;
      return thread ? [thread] : [];
    });

  const selectedThread = () => {
    const snapshot = readCodexMicroSnapshot();
    const id =
      snapshot.selectedSlot === null ? null : snapshot.slots[snapshot.selectedSlot]?.threadId;
    return id ? threadsById.get(id) : undefined;
  };

  const runAction = (action: CodexMicroAction) => {
    switch (action.type) {
      case "none":
        return;
      case "nextSlot":
        return cycleSelection(1);
      case "previousSlot":
        return cycleSelection(-1);
      case "openSelected": {
        const selected = readCodexMicroSnapshot().selectedSlot;
        if (selected !== null) openSlot(selected);
        return;
      }
      case "approve":
      case "approveForSession":
      case "decline": {
        // Selected thread first, then agent keys left to right, then anything waiting.
        const target = [selectedThread(), ...slotThreads(), ...threads].find(hasApproval);
        const request = target?.source.pendingRuntimeRequest;
        if (!target || !request) return;
        void respondToApproval({
          environmentId: target.environmentId,
          input: {
            threadId: target.id,
            requestId: request.id,
            decision:
              action.type === "approve"
                ? "accept"
                : action.type === "decline"
                  ? "decline"
                  : "acceptForSession",
          },
        });
        return;
      }
      case "stop": {
        const selected = selectedThread();
        const working = slotThreads().filter(isWorking);
        // With several running threads, stop only the one you selected.
        const target =
          selected && isWorking(selected)
            ? selected
            : working.length === 1
              ? working[0]
              : undefined;
        if (!target) return;
        void interruptTurn({ environmentId: target.environmentId, input: { threadId: target.id } });
        return;
      }
      case "command": {
        const init = codexMicroShortcutEvent(keybindings, action.command, navigator.platform);
        if (!init) return;
        const target =
          document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        return;
      }
    }
  };

  const runControl = (control: CodexMicroControlId) =>
    runAction(resolveCodexMicroControl(control, settings.knobMode, settings.controls));

  const handleInput = useEffectEvent((input: CodexMicroInputEvent) => {
    if (input.type === "joystick") {
      if (input.distance < JOYSTICK_RELEASE) joystickArmed.current = true;
      else if (joystickArmed.current && input.distance >= JOYSTICK_TRIGGER) {
        joystickArmed.current = false;
        runControl(codexMicroJoystickControl(input.angle));
      }
      return;
    }
    const agent = AGENT_KEY.exec(input.key);
    if (agent) {
      if (input.act === 1) openSlot(Number(agent[1]));
    } else if (input.key === "ENC_CW" || input.key === "ENC_CC") {
      if (input.act === 2) runControl(input.key);
    } else if (input.key.startsWith("ENC")) {
      if (input.act === 1) runControl("ENC");
    } else if (input.act === 1 && input.key in settings.controls) {
      // One wide keycap sits on ACT10 + ACT11; like Codex, ignore the second switch.
      if (input.key === "ACT11" && !settings.separateMicrophoneKeys) return;
      runControl(input.key as CodexMicroControlId);
    }
  });

  useEffect(() => {
    const unsubscribe = subscribeCodexMicroInput(handleInput);
    return () => {
      unsubscribe();
    };
  }, []);
  return null;
}
