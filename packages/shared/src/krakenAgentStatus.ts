import type {
  KrakenDisplayPhase,
  KrakenDisplayState,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { projectThreadAwareness } from "./agentAwareness.ts";
import type { AgentAwarenessPhase } from "./agentAwareness.ts";

const MAX_TASK_TITLE_LENGTH = 48;

export interface KrakenAgentObservation {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly phase: Exclude<KrakenDisplayPhase, "ready">;
  readonly providerTitle: string;
  readonly taskTitle: string;
  readonly updatedAt: string;
}

export interface KrakenTrackerState {
  readonly observations: ReadonlyMap<ThreadId, KrakenAgentObservation>;
  readonly display: KrakenDisplayState;
}

export interface KrakenTrackerUpdate {
  readonly state: KrakenTrackerState;
  readonly changed: boolean;
}

export function readyKrakenDisplayState(updatedAt: string): KrakenDisplayState {
  return {
    version: 1,
    phase: "ready",
    providerTitle: null,
    taskTitle: null,
    activeCount: 0,
    threadId: null,
    turnId: null,
    updatedAt,
  };
}

export function projectKrakenAgentObservation(input: {
  readonly environmentId: Parameters<typeof projectThreadAwareness>[0]["environmentId"];
  readonly project: Pick<OrchestrationProjectShell, "title">;
  readonly thread: OrchestrationThreadShell;
}): KrakenAgentObservation | null {
  const awareness = projectThreadAwareness(input);
  if (awareness === null) {
    const latestTurn = input.thread.latestTurn;
    if (
      latestTurn?.state === "interrupted" &&
      latestTurn.completedAt === null &&
      input.thread.session?.status === "stopped"
    ) {
      return {
        threadId: input.thread.id,
        turnId: latestTurn.turnId,
        phase: "stopped",
        providerTitle: providerTitle(input.thread),
        taskTitle: truncateTaskTitle(input.thread.title),
        updatedAt: input.thread.updatedAt,
      };
    }
    return null;
  }

  const phase = mapAwarenessPhase(awareness.phase);
  if (phase === null) {
    return null;
  }
  return {
    threadId: input.thread.id,
    turnId: input.thread.latestTurn?.turnId ?? input.thread.session?.activeTurnId ?? null,
    phase,
    providerTitle: awareness.providerTitle,
    taskTitle: truncateTaskTitle(input.thread.title),
    updatedAt: awareness.updatedAt,
  };
}

export function seedKrakenTracker(input: {
  readonly observations: ReadonlyArray<KrakenAgentObservation>;
  readonly updatedAt: string;
}): KrakenTrackerState {
  const observations = new Map(
    input.observations.map((observation) => [observation.threadId, observation] as const),
  );
  return {
    observations,
    display: {
      ...readyKrakenDisplayState(input.updatedAt),
      activeCount: activeAgentCount(observations),
    },
  };
}

export function reduceKrakenTracker(
  current: KrakenTrackerState,
  input: {
    readonly threadId: ThreadId;
    readonly observation: KrakenAgentObservation | null;
    readonly updatedAt: string;
  },
): KrakenTrackerUpdate {
  const previous = current.observations.get(input.threadId) ?? null;
  const observations = new Map(current.observations);
  if (input.observation === null) {
    observations.delete(input.threadId);
  } else {
    observations.set(input.threadId, input.observation);
  }

  const meaningfulTransition = isMeaningfulTransition(previous, input.observation);
  if (!meaningfulTransition || input.observation === null) {
    const nextActiveCount = activeAgentCount(observations);
    return {
      state: {
        observations,
        display: {
          ...current.display,
          activeCount: nextActiveCount,
        },
      },
      changed: current.display.activeCount !== nextActiveCount,
    };
  }

  return {
    state: {
      observations,
      display: displayForObservation(
        input.observation,
        activeAgentCount(observations),
        input.updatedAt,
      ),
    },
    changed: true,
  };
}

function isMeaningfulTransition(
  previous: KrakenAgentObservation | null,
  next: KrakenAgentObservation | null,
): boolean {
  if (next === null) {
    return false;
  }
  if (previous === null) {
    // A newly observed terminal state is usually startup hydration or a
    // projection replay. It is recorded, but never announced as fresh work.
    return !isTerminalPhase(next.phase);
  }
  return previous.phase !== next.phase || previous.turnId !== next.turnId;
}

function activeAgentCount(observations: ReadonlyMap<ThreadId, KrakenAgentObservation>): number {
  let count = 0;
  for (const observation of observations.values()) {
    if (!isTerminalPhase(observation.phase)) {
      count += 1;
    }
  }
  return count;
}

function displayForObservation(
  observation: KrakenAgentObservation,
  activeCount: number,
  updatedAt: string,
): KrakenDisplayState {
  return {
    version: 1,
    phase: observation.phase,
    providerTitle: observation.providerTitle,
    taskTitle: observation.taskTitle,
    activeCount,
    threadId: observation.threadId,
    turnId: observation.turnId,
    updatedAt,
  };
}

function mapAwarenessPhase(
  phase: AgentAwarenessPhase,
): Exclude<KrakenDisplayPhase, "ready" | "stopped"> | null {
  switch (phase) {
    case "starting":
      return "starting";
    case "running":
      return "working";
    case "waiting_for_approval":
      return "approval";
    case "waiting_for_input":
      return "input";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "stale":
      return null;
  }
}

function providerTitle(thread: OrchestrationThreadShell): string {
  return (
    thread.session?.providerName ??
    String(thread.modelSelection.instanceId)
      .split(/[/:]/)
      .findLast(Boolean)
      ?.replaceAll(/[-_]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase()) ??
    "Agent"
  );
}

function truncateTaskTitle(title: string): string {
  const normalized = title.trim().replaceAll(/\s+/g, " ");
  if (normalized.length <= MAX_TASK_TITLE_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TASK_TITLE_LENGTH - 1).trimEnd()}…`;
}

function isTerminalPhase(phase: KrakenAgentObservation["phase"]): boolean {
  return phase === "done" || phase === "failed" || phase === "stopped";
}
