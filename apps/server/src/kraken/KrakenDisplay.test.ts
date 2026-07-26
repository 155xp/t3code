import type { OrchestrationEvent, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  forceStoppedObservation,
  isKrakenStatusRelevantEvent,
  krakenEventThreadId,
} from "./KrakenDisplay.ts";

const BASE = {
  eventId: "event-1",
  aggregateKind: "thread",
  aggregateId: "thread-1",
  sequence: 1,
  commandId: "command-1",
  correlationId: "command-1",
  causationId: null,
  occurredAt: "2026-07-25T20:00:00.000Z",
} as const;

function event(type: string, payload: unknown): OrchestrationEvent {
  return { ...BASE, type, payload } as unknown as OrchestrationEvent;
}

describe("KrakenDisplay event policy", () => {
  it("ignores settlement and snooze organization events", () => {
    for (const type of [
      "thread.settled",
      "thread.unsettled",
      "thread.snoozed",
      "thread.unsnoozed",
    ]) {
      expect(isKrakenStatusRelevantEvent(event(type, { threadId: "thread-1" }))).toBe(false);
    }
  });

  it("accepts only activity events that change agent attention state", () => {
    expect(
      isKrakenStatusRelevantEvent(
        event("thread.activity-appended", { activity: { kind: "approval.requested" } }),
      ),
    ).toBe(true);
    expect(
      isKrakenStatusRelevantEvent(
        event("thread.activity-appended", { activity: { kind: "tool.completed" } }),
      ),
    ).toBe(false);
  });

  it("extracts thread identity and maps a stopped session to STOPPED", () => {
    const stoppedEvent = event("thread.session-set", {
      threadId: "thread-1",
      session: { status: "stopped" },
    });
    expect(krakenEventThreadId(stoppedEvent)).toBe("thread-1");
    expect(
      forceStoppedObservation(stoppedEvent, {
        threadId: "thread-1" as ThreadId,
        turnId: "turn-1" as TurnId,
        phase: "done",
        providerTitle: "Codex",
        taskTitle: "Stopped task",
        updatedAt: BASE.occurredAt,
      })?.phase,
    ).toBe("stopped");
  });
});
