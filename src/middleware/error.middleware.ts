import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger';

export class AppError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorMiddleware(err: Error, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error:   'Validation error',
      details: err.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
    });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  logger.error('Unhandled error', { message: err.message, stack: err.stack, path: req.path });
  res.status(500).json({
    error: 'Internal server error',
    ...(process.env['NODE_ENV'] !== 'production' ? { detail: err.message } : {}),
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
}