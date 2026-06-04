export const ErrorCodes = {
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  BRAIN_UNREACHABLE: 'BRAIN_UNREACHABLE',
  BRAIN_TIMEOUT: 'BRAIN_TIMEOUT',
  INVALID_STAGE_TRANSITION: 'INVALID_STAGE_TRANSITION',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  VAPI_REJECTED: 'VAPI_REJECTED',
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
