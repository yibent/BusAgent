export type BusAgentErrorCode =
  | 'CONFIG_INVALID'
  | 'AGENT_ID_CONFLICT'
  | 'PATH_ESCAPE'
  | 'AGENT_NOT_INSTALLED'
  | 'REGISTRATION_CONFLICT'
  | 'REGISTRATION_MISMATCH'
  | 'ENVELOPE_INVALID'
  | 'AGENT_CONTRACT_VIOLATION'
  | 'SOURCE_NOT_REGISTERED'
  | 'NOT_READY'
  | 'TASK_STALE'
  | 'TASK_CANCELLED'
  | 'SCHEMA_MISSING'
  | 'SCHEMA_INVALID'
  | 'INTERNAL';

export class BusAgentError extends Error {
  readonly code: BusAgentErrorCode;
  readonly detail: Record<string, unknown> | undefined;

  constructor(
    code: BusAgentErrorCode,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BusAgentError';
    this.code = code;
    this.detail = detail;
  }
}
