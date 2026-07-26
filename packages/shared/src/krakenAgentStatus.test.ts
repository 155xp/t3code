import {
  type EnvironmentId,
  ProviderInstanceId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  projectKrakenAgentObservation,
  reduceKrakenTracker,
  seedKrakenTracker,
  type KrakenAgentObservation,
} from "./krakenAgentStatus.ts";

const NOW = "2026-07-25T20:00:00.000Z";
const LATER = "2026-07-25T20:01:00.000Z";

function observation(
  threadId: string,
  phase: KrakenAgentObservation["phase"],
  overrides: Partial<KrakenAgentObservation> = {},
): KrakenAgentObservation {
  return {
    threadId: threadId as ThreadId,
    turnId: `${threadId}-turn` as TurnId,
    phase,
    providerTitle: "Codex",
    taskTitle: `Task ${threadId}`,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("Kraken agent status tracker", () => {
  it("hydrates existing terminal work silently and starts on READY", () => {
    const state = seedKrakenTracker({
      observations: [observation("old", "done"), observation("live", "working")],
      updatedAt: NOW,
    });
    expect(state.display).toMatchObject({ phase: "ready", activeCount: 1, threadId: null });

    const unseenTerminal = reduceKrakenTracker(state, {
      threadId: "another-old" as ThreadId,
      observation: observation("another-old", "done"),
      updatedAt: LATER,
    });
    expect(unseenTerminal.changed).toBe(false);
    expect(unseenTerminal.state.display.phase).toBe("ready");
  });

  it("shows each completion and keeps DONE through duplicate progress traffic", () => {
    let state = seedKrakenTracker({ observations: [], updatedAt: NOW });
    state = reduceKrakenTracker(state, {
      threadId: "a" as ThreadId,
      observation: observation("a", "working"),
      updatedAt: NOW,
    }).state;
    state = reduceKrakenTracker(state, {
      threadId: "b" as ThreadId,
      observation: observation("b", "working", { providerTitle: "Claude" }),
      updatedAt: NOW,
    }).state;
    expect(state.display).toMatchObject({
      phase: "working",
      providerTitle: "Claude",
      activeCount: 2,
    });

    state = reduceKrakenTracker(state, {
      threadId: "a" as ThreadId,
      observation: observation("a", "done"),
      updatedAt: LATER,
    }).state;
    expect(state.display).toMatchObject({
      phase: "done",
      taskTitle: "Task a",
      activeCount: 1,
    });

    const duplicateWorking = reduceKrakenTracker(state, {
      threadId: "b" as ThreadId,
      observation: observation("b", "working", { providerTitle: "Claude", updatedAt: LATER }),
      updatedAt: LATER,
    });
    state = duplicateWorking.state;
    expect(duplicateWorking.changed).toBe(false);
    expect(state.display.phase).toBe("done");

    const approval = reduceKrakenTracker(state, {
      threadId: "b" as ThreadId,
      observation: observation("b", "approval", { providerTitle: "Claude" }),
      updatedAt: LATER,
    });
    expect(approval.changed).toBe(true);
    expect(approval.state.display).toMatchObject({
      phase: "approval",
      providerTitle: "Claude",
      activeCount: 1,
    });
  });

  it("distinguishes failed and stopped terminal transitions", () => {
    const seeded = seedKrakenTracker({
      observations: [observation("failed", "working"), observation("stopped", "working")],
      updatedAt: NOW,
    });
    const failed = reduceKrakenTracker(seeded, {
      threadId: "failed" as ThreadId,
      observation: observation("failed", "failed"),
      updatedAt: LATER,
    });
    expect(failed.state.display.phase).toBe("failed");

    const stopped = reduceKrakenTracker(failed.state, {
      threadId: "stopped" as ThreadId,
      observation: observation("stopped", "stopped"),
      updatedAt: LATER,
    });
    expect(stopped.state.display.phase).toBe("stopped");
    expect(stopped.state.display.activeCount).toBe(0);
  });
});

describe("projectKrakenAgentObservation", () => {
  it("uses canonical awareness, provider name, and a bounded task title", () => {
    const result = projectKrakenAgentObservation({
      environmentId: "env-1" as EnvironmentId,
      project: { title: "t3code" },
      thread: {
        id: "thread-1" as ThreadId,
        projectId: "project-1" as never,
        title: "Implement a very long task title that cannot fit comfortably on the Kraken display",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-opus",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: {
          turnId: "turn-1" as TurnId,
          state: "running",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: null,
          assistantMessageId: null,
        },
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        session: {
          threadId: "thread-1" as ThreadId,
          status: "running",
          providerName: "Claude",
          runtimeMode: "full-access",
          activeTurnId: "turn-1" as TurnId,
          lastError: null,
          updatedAt: NOW,
        },
        latestUserMessageAt: NOW,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    });

    expect(result).toMatchObject({
      phase: "working",
      providerTitle: "Claude",
      turnId: "turn-1",
    });
    expect(result?.taskTitle.length).toBeLessThanOrEqual(48);
    expect(result?.taskTitle.endsWith("…")).toBe(true);
  });

  it("treats interrupted turns with a durable completion timestamp as DONE", () => {
    const result = projectKrakenAgentObservation({
      environmentId: "env-1" as EnvironmentId,
      project: { title: "t3code" },
      thread: {
        id: "thread-1" as ThreadId,
        projectId: "project-1" as never,
        title: "Fast teardown",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: {
          turnId: "turn-1" as TurnId,
          state: "interrupted",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: LATER,
          assistantMessageId: null,
        },
        createdAt: NOW,
        updatedAt: LATER,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        session: null,
        latestUserMessageAt: NOW,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    });
    expect(result?.phase).toBe("done");
  });
});
