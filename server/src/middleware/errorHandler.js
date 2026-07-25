import { AppError, Errors } from '../errors.js';

/** 404 for unmatched routes, in the standard envelope. */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route for ${req.method} ${req.path}.`,
      requestId: req.id,
    },
  });
}

/**
 * Central error handler. Serialises AppErrors into the standard envelope and
 * treats anything unexpected as a 500 without leaking internals to the client.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const appErr = err instanceof AppError ? err : null;

  if (appErr) {
    // Client errors are expected; log at warn. Server errors at error.
    const level = appErr.status >= 500 ? 'error' : 'warn';
    req.log?.[level]?.({ code: appErr.code, err: appErr }, 'request failed');
    res.status(appErr.status).json({
      error: {
        code: appErr.code,
        message: appErr.message,
        ...(appErr.details ? { details: appErr.details } : {}),
        requestId: req.id,
      },
    });
    return;
  }

  // Unknown error: log full detail, return an opaque 500.
  req.log?.error?.({ err }, 'unhandled error');
  const internal = Errors.internal();
  res.status(internal.status).json({
    error: { code: internal.code, message: internal.message, requestId: req.id },
  });
}
