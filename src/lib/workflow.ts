import { OrderStatus } from "../generated/prisma/enums";

/** The subset of a Station record the workflow logic actually needs. */
export interface WorkflowStation {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  isQcCheckpoint: boolean;
  isSystem: boolean;
  /** The fixed Return section — kept off the linear production sequence entirely. */
  isReturnStation: boolean;
}

/**
 * Non-system (Management-configurable) stations first, sorted by sortOrder, then system
 * stations (QC, Packaging, Courier/Pick-up) last, sorted among themselves by sortOrder. This guarantees
 * the fixed stages always come after every dynamic station regardless of their numeric
 * sortOrder — no reserved numeric range needed. The Return station is excluded altogether: it
 * is never "next" or "last" in the sequence, only entered from delivery and left via a return
 * decision.
 */
function activeSorted(stations: WorkflowStation[]): WorkflowStation[] {
  const active = stations.filter((s) => s.isActive && !s.isReturnStation);
  const regular = active.filter((s) => !s.isSystem).sort((a, b) => a.sortOrder - b.sortOrder);
  const system = active.filter((s) => s.isSystem).sort((a, b) => a.sortOrder - b.sortOrder);
  return [...regular, ...system];
}

/** The first station an order is expected at right after intake. */
export function firstStation(stations: WorkflowStation[]): WorkflowStation | undefined {
  return activeSorted(stations)[0];
}

/** The last station an order must clear before a delivery outcome can be recorded. */
export function lastStation(stations: WorkflowStation[]): WorkflowStation | undefined {
  const sorted = activeSorted(stations);
  return sorted[sorted.length - 1];
}

/** The active station that follows `stationId`, or undefined if it's the last one. */
export function nextStationAfter(stations: WorkflowStation[], stationId: string): WorkflowStation | undefined {
  const sorted = activeSorted(stations);
  const index = sorted.findIndex((s) => s.id === stationId);
  if (index === -1) return undefined;
  return sorted[index + 1];
}

/** The active station immediately before `stationId` in the production sequence, or
 * undefined if it's the first one (or a system stage, which never precedes a dynamic
 * station). Used by POST /scan/reject — unlike QC's rework targeting (any earlier active
 * dynamic station), a regular station's rejection always goes back exactly one step. */
export function previousStationBefore(stations: WorkflowStation[], stationId: string): WorkflowStation | undefined {
  const sorted = activeSorted(stations);
  const index = sorted.findIndex((s) => s.id === stationId);
  if (index <= 0) return undefined;
  return sorted[index - 1];
}

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

export interface OrderWorkflowState {
  status: OrderStatus;
  currentStationId: string | null;
  /** True when the order is physically checked in at currentStationId, awaiting outgoing. */
  isCheckedIn: boolean;
}

/** Can this order be scan-received at `requestedStationId` right now? */
export function canReceive(
  state: OrderWorkflowState,
  stations: WorkflowStation[],
  requestedStationId: string,
): TransitionCheck {
  if (state.status === OrderStatus.DELIVERED) {
    return { ok: false, reason: "Order has already been delivered." };
  }
  if (state.isCheckedIn) {
    const current = stations.find((s) => s.id === state.currentStationId);
    return {
      ok: false,
      reason: `Order is already checked in at ${current?.name ?? state.currentStationId}; log outgoing there before receiving elsewhere.`,
    };
  }

  const requested = stations.find((s) => s.id === requestedStationId);
  if (!requested || !requested.isActive) {
    return { ok: false, reason: "That station does not exist or is no longer active." };
  }
  if (requestedStationId !== state.currentStationId) {
    const expected = stations.find((s) => s.id === state.currentStationId);
    return {
      ok: false,
      reason: `Order is expected at ${expected?.name ?? state.currentStationId}, not ${requested.name}.`,
    };
  }
  return { ok: true };
}

/**
 * Can outgoing be logged for this order at `requestedStationId` right now?
 * QC-checkpoint stations have no plain "outgoing" scan — their exit is always via a
 * QC decision (approve -> next station, rework -> an earlier station), so it's rejected here.
 */
export function canLogOutgoing(
  state: OrderWorkflowState,
  stations: WorkflowStation[],
  requestedStationId: string,
): TransitionCheck {
  const requested = stations.find((s) => s.id === requestedStationId);
  if (!requested) {
    return { ok: false, reason: "That station does not exist." };
  }
  if (requested.isQcCheckpoint) {
    return { ok: false, reason: `${requested.name} is a QC checkpoint; submit a QC decision instead.` };
  }
  if (requested.isReturnStation) {
    return { ok: false, reason: `${requested.name} is the Return station; submit a return decision instead.` };
  }
  if (!state.isCheckedIn) {
    return { ok: false, reason: "Order is not currently checked in anywhere; receive it first." };
  }
  if (state.currentStationId !== requestedStationId) {
    const current = stations.find((s) => s.id === state.currentStationId);
    return {
      ok: false,
      reason: `Order is checked in at ${current?.name ?? state.currentStationId}, not ${requested.name}.`,
    };
  }
  return { ok: true };
}

/** Can this order be rejected/returned for rework by `requestedStationId` right now? Only a
 * regular (non-system) station may do this — QC and Courier/Pick-up keep using their own
 * dedicated decision flows, and Packaging has no rework/rejection path at all (its only exit
 * is forward into delivery). There must be an earlier active station to return it to; the
 * first station in the sequence has nothing before it. Mirrors canLogOutgoing's shape:
 * requestedStationId must be where the order is actually checked in. */
export function canReturnForRework(
  state: OrderWorkflowState,
  stations: WorkflowStation[],
  requestedStationId: string,
): TransitionCheck {
  const requested = stations.find((s) => s.id === requestedStationId);
  if (!requested) {
    return { ok: false, reason: "That station does not exist." };
  }
  if (requested.isSystem) {
    return {
      ok: false,
      reason: "Only a regular production station can reject an order for rework — QC, Packaging, and Courier/Pick-up use their own decision flows (or, for Packaging, have no rework path at all).",
    };
  }
  if (!state.isCheckedIn) {
    return { ok: false, reason: "Order is not currently checked in anywhere; receive it first." };
  }
  if (state.currentStationId !== requestedStationId) {
    const current = stations.find((s) => s.id === state.currentStationId);
    return {
      ok: false,
      reason: `Order is checked in at ${current?.name ?? state.currentStationId}, not ${requested.name}.`,
    };
  }
  const previous = previousStationBefore(stations, requested.id);
  if (!previous) {
    return { ok: false, reason: `${requested.name} is the first station — there is no earlier station to return the order to.` };
  }
  return { ok: true };
}

/** Can a QC decision be submitted for this order right now? */
export function canSubmitQcDecision(state: OrderWorkflowState, stations: WorkflowStation[]): TransitionCheck {
  const current = stations.find((s) => s.id === state.currentStationId);
  if (!state.isCheckedIn || !current?.isQcCheckpoint) {
    return { ok: false, reason: "Order must be checked in at a QC checkpoint station to submit a QC decision." };
  }
  return { ok: true };
}

/** Can a return decision be submitted for this order right now? */
export function canSubmitReturnDecision(state: OrderWorkflowState, stations: WorkflowStation[]): TransitionCheck {
  const current = stations.find((s) => s.id === state.currentStationId);
  if (!state.isCheckedIn || !current?.isReturnStation) {
    return { ok: false, reason: "Order must be checked in at the Return station to submit a return decision." };
  }
  return { ok: true };
}

/** Can a replacement be issued (order looped back to the first station) right now? It must be
 * parked at the Return station, not checked in — i.e. the Return decision already ran. */
export function canIssueReplacement(state: OrderWorkflowState, stations: WorkflowStation[]): TransitionCheck {
  const current = stations.find((s) => s.id === state.currentStationId);
  if (state.isCheckedIn || !current?.isReturnStation) {
    return { ok: false, reason: "Order must be parked at the Return station (decision made, not checked in) to issue a replacement." };
  }
  return { ok: true };
}

/** Can a delivery outcome be recorded for this order right now? */
export function canRecordDeliveryOutcome(state: OrderWorkflowState, stations: WorkflowStation[]): TransitionCheck {
  if (state.isCheckedIn) {
    const current = stations.find((s) => s.id === state.currentStationId);
    return {
      ok: false,
      reason: `Order is still checked in at ${current?.name ?? state.currentStationId}; log outgoing before recording a delivery outcome.`,
    };
  }
  const last = lastStation(stations);
  if (!last || state.currentStationId !== last.id) {
    return {
      ok: false,
      reason: `Order must have completed outgoing at ${last?.name ?? "the last station"} before a delivery outcome can be recorded.`,
    };
  }
  return { ok: true };
}

/**
 * Can `checkpoint` (always the QC system station) route rework back to `target`? Any active
 * dynamic (non-system) station qualifies — QC always runs after all of them, so every one
 * counts as "earlier." Rework can never target a system station (QC, Packaging, Courier/Pick-up).
 */
export function isValidReworkTarget(checkpoint: WorkflowStation, target: WorkflowStation | undefined): TransitionCheck {
  if (!target || !target.isActive) {
    return { ok: false, reason: "targetStationId does not reference an active station." };
  }
  if (target.isSystem) {
    return { ok: false, reason: `Rework can only be routed to a dynamic production station, not ${target.name}.` };
  }
  return { ok: true };
}
