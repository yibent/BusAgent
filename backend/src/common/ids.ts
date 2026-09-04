import { randomUUID } from 'node:crypto';

/** Host-generated event id (BusEvent.eventId). */
export function newEventId(): string {
  return `evt_${randomUUID()}`;
}

/** Correlation id used to tie a whole interaction together. */
export function newCorrelationId(): string {
  return `corr_${randomUUID()}`;
}

/** Trace id assigned per ingested event. */
export function newTraceId(): string {
  return `trace_${randomUUID()}`;
}

/** Stream id for one utterance of streaming speech-to-text. */
export function newStreamId(): string {
  return `stream_${randomUUID()}`;
}

/** Bare UUID used as primary key of persistence rows. */
export function newUuid(): string {
  return randomUUID();
}

/** Stable id for a delivery row / in-process job: one per event + target agent. */
export function deliveryId(eventId: string, agentId: string): string {
  return `${eventId}:${agentId}`;
}
