/**
 * Structured application errors.
 *
 * Every error carries a stable machine-readable `code` and an HTTP `status`.
 * The error handler serialises these into a consistent envelope so clients can
 * branch on `error.code` rather than parsing prose.
 */
export class AppError extends Error {
  /**
   * @param {string} code   stable machine-readable code, e.g. "INVALID_URL"
   * @param {string} message human-readable message
   * @param {number} status  HTTP status code
   * @param {object} [details] optional structured details
   */
  constructor(code, message, status, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const Errors = {
  invalidUrl: (message = 'A valid absolute http(s) URL is required.', details) =>
    new AppError('INVALID_URL', message, 400, details),

  blockedTarget: (message = 'Target host is not permitted.', details) =>
    new AppError('BLOCKED_TARGET', message, 403, details),

  fetchTimeout: (message = 'The target did not respond in time.') =>
    new AppError('UPSTREAM_TIMEOUT', message, 504),

  fetchFailed: (message = 'The target could not be reached.', details) =>
    new AppError('UPSTREAM_UNREACHABLE', message, 502, details),

  tooManyRedirects: (message = 'The target exceeded the redirect limit.') =>
    new AppError('TOO_MANY_REDIRECTS', message, 502),

  capacityExceeded: (message = 'The service is at capacity, please retry shortly.') =>
    new AppError('CAPACITY_EXCEEDED', message, 503),

  rateLimited: (message = 'Rate limit exceeded.') =>
    new AppError('RATE_LIMITED', message, 429),

  internal: (message = 'An unexpected error occurred.') =>
    new AppError('INTERNAL', message, 500),
};
