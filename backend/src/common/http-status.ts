import type { BusAgentErrorCode } from './errors.js';

/** Maps a structured BusAgent error code to an HTTP status for the public endpoints. */
export function statusForCode(code: BusAgentErrorCode): number {
  switch (code) {
    case 'NOT_READY':
      return 503;
    case 'AGENT_NOT_INSTALLED':
      return 404;
    case 'REGISTRATION_CONFLICT':
      return 409;
    case 'AGENT_ID_CONFLICT':
      return 409;
    case 'SOURCE_NOT_REGISTERED':
      return 409;
    case 'AGENT_CONTRACT_VIOLATION':
      return 400;
    case 'ENVELOPE_INVALID':
      return 400;
    case 'REGISTRATION_MISMATCH':
      return 400;
    case 'PATH_ESCAPE':
      return 400;
    default:
      return 400;
  }
}
