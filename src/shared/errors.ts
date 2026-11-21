export class BridgeError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'BridgeError'; }
}

export class DeliveryError extends BridgeError {
  constructor(code: string, message: string, public uncertain = false) { super(code, message); }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
