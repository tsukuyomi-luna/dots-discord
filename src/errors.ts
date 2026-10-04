export class PublicError extends Error {
  constructor(
    message: string,
    readonly code = -32602,
  ) {
    super(message);
  }
}

export class CallbackError extends PublicError {
  constructor(readonly reason: string) {
    super("Webhook callback rejected", -32015);
  }
}

export function publicMessage(error: unknown): string {
  return error instanceof PublicError ? error.message : "Operation failed; check the server status";
}
