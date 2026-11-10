import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'Route not found' });
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) {
    return res.status(400).json({ error: 'Validation failed', details: error.issues });
  }
  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }
  if (error instanceof Error && 'type' in error && error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large' });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
    return res.status(404).json({ error: 'Resource not found' });
  }
  logger.error({ event: 'http.unhandled_error', err: error, requestId: req.id });
  res.status(500).json({ error: 'Internal server error', requestId: req.id });
}
