import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }

  if (err instanceof AppError) {
    const body = { error: { code: err.code, message: err.message } };
    if (err.details !== undefined) body.error.details = err.details;
    return res.status(err.status).json(body);
  }

  // Mongo duplicate key
  if (err && err.code === 11000) {
    return res.status(409).json({
      error: { code: 'DUPLICATE_KEY', message: 'Duplicate value', details: err.keyValue },
    });
  }

  // Mongoose CastError (invalid ObjectId in a URL param)
  if (err && err.name === 'CastError') {
    return res.status(400).json({
      error: { code: 'INVALID_ID', message: 'Invalid identifier' },
    });
  }

  // eslint-disable-next-line no-console
  console.error('[server] unhandled error:', err);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}