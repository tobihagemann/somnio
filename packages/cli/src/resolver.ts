import { SecureTransportValidationError, isLoopbackURL, validate } from './urlValidation.ts';

/** The loopback dev server and its well-known token; the fallbacks for the loopback dev case. */
export const DEV_ADMIN_URL = 'ws://127.0.0.1:17662/admin';
export const DEV_ADMIN_TOKEN = 'dev-admin';

/** A usage error: reported on stderr and exits 64 (`EX_USAGE`). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface AdminConnection {
  url: string;
  token: string;
}

/**
 * `--server-url`, then `SOMNIO_ADMIN_URL`, then the loopback dev server; the token from
 * `SOMNIO_ADMIN_TOKEN`, or the dev token when the URL is loopback. An empty token counts as
 * unset, as it does for the server. A non-loopback URL with no token is a usage error: the
 * missing credential is reported here rather than as a 401 after a dial. The URL passes the
 * whole secure-transport gate first, so every invalid URL is a usage error too (the transport
 * re-checks it for its other callers).
 */
export function resolveAdminConnection(serverURL: string | undefined, env: Record<string, string | undefined> = process.env): AdminConnection {
  const url = serverURL ?? env['SOMNIO_ADMIN_URL'] ?? DEV_ADMIN_URL;
  try {
    validate(url);
  } catch (error) {
    if (error instanceof SecureTransportValidationError) throw new ValidationError(validationMessage(error));
    throw error;
  }
  const configured = env['SOMNIO_ADMIN_TOKEN'];
  const token = configured === undefined || configured.length === 0 ? undefined : configured;
  if (token === undefined && !isLoopbackURL(url)) {
    throw new ValidationError('SOMNIO_ADMIN_TOKEN environment variable is required.');
  }
  return { url, token: token ?? DEV_ADMIN_TOKEN };
}

function validationMessage(error: SecureTransportValidationError): string {
  switch (error.kind) {
    case 'invalidURL':
      return '--server-url is not a valid URL.';
    case 'unsupportedScheme':
      return '--server-url must use the ws:// or wss:// scheme (lowercase).';
    case 'insecureRemoteURL':
      return 'Refusing to send the admin token over plaintext ws://. Use wss:// for remote endpoints.';
    case 'userinfoNotAllowed':
      return '--server-url must not embed user:password@host. Pass the bearer token via SOMNIO_ADMIN_TOKEN.';
  }
}
