import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import {
  projectKrakenAgentObservation,
  reduceKrakenTracker,
  seedKrakenTracker,
  type KrakenAgentObservation,
} from "@t3tools/shared/krakenAgentStatus";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { createKrakenStateHub, startKrakenHttpServer } from "./KrakenHttpServer.ts";

export class KrakenDisplay extends Context.Service<
  KrakenDisplay,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/kraken/KrakenDisplay") {}

export function krakenEventThreadId(event: OrchestrationEvent): ThreadId | null {
  const payload = event.payload as { readonly threadId?: unknown };
  if (typeof payload.threadId === "string") {
    return payload.threadId as ThreadId;
  }
  if (event.aggregateKind === "thread" && typeof event.aggregateId === "string") {
    return event.aggregateId as ThreadId;
  }
  return null;
}

export function isKrakenStatusRelevantEvent(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.proposed-plan-upserted":
    case "thread.runtime-mode-set":
    case "thread.interaction-mode-set":
    case "thread.message-sent":
    case "thread.turn-start-requested":
      return false;
    case "thread.activity-appended":
      return (
        event.payload.activity.kind === "approval.requested" ||
        event.payload.activity.kind === "approval.resolved" ||
        event.payload.activity.kind === "provider.approval.respond.failed" ||
        event.payload.activity.kind === "user-input.requested" ||
        event.payload.activity.kind === "user-input.resolved" ||
        event.payload.activity.kind === "runtime.error"
      );
    default:
      return true;
  }
}

export function forceStoppedObservation(
  event: OrchestrationEvent,
  observation: KrakenAgentObservation | null,
): KrakenAgentObservation | null {
  if (
    event.type !== "thread.session-set" ||
    event.payload.session.status !== "stopped" ||
    observation === null
  ) {
    return observation;
  }
  return { ...observation, phase: "stopped" };
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;

  const start: KrakenDisplay["Service"]["start"] = Effect.fn("KrakenDisplay.start")(function* () {
    if (!config.krakenEnabled) {
      yield* Effect.logInfo("NZXT Kraken agent display disabled");
      return;
    }

    const environmentId = yield* environment.getEnvironmentId;
    const startupTimestamp = DateTime.formatIso(yield* DateTime.now);
    const snapshot = yield* snapshotQuery.getShellSnapshot().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("NZXT Kraken display could not hydrate orchestration state", {
          cause,
        }).pipe(
          Effect.as({
            snapshotSequence: 0,
            projects: [],
            threads: [],
            updatedAt: startupTimestamp,
          } as const),
        ),
      ),
    );
    const projectsById = new Map(
      snapshot.projects.map((project) => [project.id, project] as const),
    );
    const initialObservations = snapshot.threads.flatMap((thread) => {
      const project = projectsById.get(thread.projectId);
      if (!project) {
        return [];
      }
      const observation = projectKrakenAgentObservation({
        environmentId,
        project,
        thread,
      });
      return observation === null ? [] : [observation];
    });
    let tracker = seedKrakenTracker({
      observations: initialObservations,
      updatedAt: startupTimestamp,
    });
    const hub = createKrakenStateHub(tracker.display);
    const serverResult = yield* Effect.promise(() =>
      startKrakenHttpServer({ port: config.krakenPort, hub }),
    );

    if (!serverResult.ok) {
      yield* Effect.logWarning("NZXT Kraken display listener unavailable; T3 Code will continue", {
        host: "127.0.0.1",
        port: config.krakenPort,
        cause: serverResult.error,
      });
      return;
    }

    yield* Effect.addFinalizer(() =>
      Effect.promise(() => serverResult.handle.close()).pipe(Effect.ignoreCause({ log: true })),
    );
    yield* Effect.logInfo("NZXT Kraken agent display ready", {
      url: `http://${serverResult.handle.host}:${serverResult.handle.port}/`,
    });

    const interruptedThreads = new Set<ThreadId>();
    const processEvent = Effect.fn("KrakenDisplay.processEvent")(function* (
      event: OrchestrationEvent,
    ) {
      const threadId = krakenEventThreadId(event);
      if (threadId === null || !isKrakenStatusRelevantEvent(event)) {
        return;
      }
      if (event.type === "thread.turn-interrupt-requested") {
        interruptedThreads.add(threadId);
        return;
      }

      const thread = yield* snapshotQuery.getThreadShellById(threadId);
      let observation: KrakenAgentObservation | null = null;
      if (Option.isSome(thread)) {
        const project = yield* snapshotQuery.getProjectShellById(thread.value.projectId);
        if (Option.isSome(project)) {
          observation = projectKrakenAgentObservation({
            environmentId,
            project: project.value,
            thread: thread.value,
          });
        }
      }

      observation = forceStoppedObservation(event, observation);
      if (observation?.phase === "done" && interruptedThreads.has(threadId)) {
        observation = { ...observation, phase: "stopped" };
      }
      if (
        observation?.phase === "done" ||
        observation?.phase === "failed" ||
        observation?.phase === "stopped"
      ) {
        interruptedThreads.delete(threadId);
      }

      const update = reduceKrakenTracker(tracker, {
        threadId,
        observation,
        updatedAt: event.occurredAt,
      });
      tracker = update.state;
      if (update.changed) {
        hub.publish(tracker.display);
      }
    });

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        processEvent(event).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("NZXT Kraken display ignored an unreadable lifecycle update", {
              eventType: event.type,
              cause,
            }),
          ),
        ),
      ),
    );
  });

  return KrakenDisplay.of({ start });
});

export const layer = Layer.effect(KrakenDisplay, make);
