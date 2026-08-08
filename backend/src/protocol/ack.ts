/**
 * `deliver()` only acknowledges delivery; it never returns business results
 * (spec §9). Business results are published back through the unified ingress.
 */
export type DeliveryAck =
  | { status: 'accepted'; ok: true }
  | { status: 'rejected'; ok: false; reason: string };

export function ackAccepted(): DeliveryAck {
  return { status: 'accepted', ok: true };
}

export function ackRejected(reason: string): DeliveryAck {
  return { status: 'rejected', ok: false, reason };
}
