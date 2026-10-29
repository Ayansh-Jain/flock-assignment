/** Base class for everything that can go wrong talking to the portal. */
export class PortalError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = new.target.code;
  }

  static code = 'PORTAL_ERROR';
}

/** Login rejected, or the session was refused again right after a fresh login. */
export class PortalAuthError extends PortalError {
  static code = 'PORTAL_AUTH';
}

/** The portal answered 404 for a resource. */
export class PortalNotFound extends PortalError {
  static code = 'PORTAL_NOT_FOUND';
}

/** Timeouts, network failures, 5xx after retries, or 429 that never cleared. */
export class PortalUnavailable extends PortalError {
  static code = 'PORTAL_UNAVAILABLE';
}

/** The circuit breaker is open: the call was refused without contacting the portal. */
export class PortalCircuitOpen extends PortalUnavailable {
  static code = 'PORTAL_CIRCUIT_OPEN';

  /**
   * @param {string} message
   * @param {{ retryAfterSeconds: number }} options
   */
  constructor(message, { retryAfterSeconds }) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A response did not have the shape we rely on. Carries the path, never the raw body. */
export class PortalParseError extends PortalError {
  static code = 'PORTAL_PARSE';

  /**
   * @param {string} path Portal path (or parser label) the bad response came from.
   * @param {string} reason Short description of what was wrong.
   * @param {{ cause?: unknown }} [options]
   */
  constructor(path, reason, options) {
    super(`${path}: ${reason}`, options);
    this.path = path;
  }
}
