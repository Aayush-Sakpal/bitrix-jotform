import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';

export function requireWebhookToken(req: Request, res: Response, next: NextFunction): void {
  const token =
    (req.query['token'] as string | undefined) ??
    (req.headers['x-webhook-secret'] as string | undefined);

  if (!token) {
    logger.warn('Webhook request missing token', { ip: req.ip });
    res.status(401).json({ error: 'Unauthorized: token required' });
    return;
  }

  if (!timingSafeEqual(token, config.server.webhookSecret)) {
    logger.warn('Webhook request has invalid token', { ip: req.ip });
    res.status(401).json({ error: 'Unauthorized: invalid token' });
    return;
  }

  next();
}

function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  const bufA = Buffer.from(a.padEnd(len));
  const bufB = Buffer.from(b.padEnd(len));
  try {
    return crypto.timingSafeEqual(bufA, bufB) && a.length === b.length;
  } catch {
    return false;
  }
}