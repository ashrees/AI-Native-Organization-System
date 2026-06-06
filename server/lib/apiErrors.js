/**
 * Consistent API error responses and async route wrapper.
 */

function errorBody(code, message, extra = {}) {
  return {
    error: {
      code: code || 'INTERNAL_ERROR',
      message: message || 'An unexpected error occurred',
      ...extra,
    },
  };
}

function sendError(res, status, code, message, extra) {
  return res.status(status).json(errorBody(code, message, extra));
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function notFoundHandler(req, res) {
  sendError(res, 404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`);
}

function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  const code = err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
  const message =
    status >= 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message || 'Request failed';
  console.error(`[API] ${req.method} ${req.path}:`, err.message);
  res.status(status).json(errorBody(code, message));
}

module.exports = {
  errorBody,
  sendError,
  asyncHandler,
  notFoundHandler,
  errorHandler,
};
