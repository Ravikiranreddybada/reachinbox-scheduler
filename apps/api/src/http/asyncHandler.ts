import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Express 4 does not forward rejected promises; this routes them to the error handler. */
export const asyncHandler =
  (
    handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
  ): RequestHandler =>
  (req, res, next) => {
    handler(req, res, next).catch(next);
  };
