import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString, TurnId } from "./baseSchemas.ts";

export const KrakenDisplayPhase = Schema.Literals([
  "ready",
  "starting",
  "working",
  "approval",
  "input",
  "done",
  "failed",
  "stopped",
]);
export type KrakenDisplayPhase = typeof KrakenDisplayPhase.Type;

/**
 * Small, read-only payload rendered by the NZXT CAM Web Integration page.
 * It deliberately excludes prompts, messages, paths, and provider errors.
 */
export const KrakenDisplayState = Schema.Struct({
  version: Schema.Literal(1),
  phase: KrakenDisplayPhase,
  providerTitle: Schema.NullOr(TrimmedNonEmptyString),
  taskTitle: Schema.NullOr(TrimmedNonEmptyString),
  activeCount: NonNegativeInt,
  threadId: Schema.NullOr(ThreadId),
  turnId: Schema.NullOr(TurnId),
  updatedAt: TrimmedNonEmptyString,
});
export type KrakenDisplayState = typeof KrakenDisplayState.Type;
