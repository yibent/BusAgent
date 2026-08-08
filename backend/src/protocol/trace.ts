/** Host-generated trace information attached to every ingested event. */
export interface TraceInfo {
  traceId: string;
  hostId: string;
  receivedAt: string;
}
