import { Router } from 'express';

import multer from 'multer';

import rateLimit from 'express-rate-limit';

import { webhookController }
from '../controllers/webhook.controller';

import { requireWebhookToken }
from '../middleware/auth.middleware';

const router = Router();

/**
 * Multer setup
 */
const upload = multer({
  storage: multer.memoryStorage(),
});

/**
 * Rate limiters
 */
const webhookLimiter = rateLimit({

  windowMs: 60_000,

  max: 300,

  standardHeaders: true,

  legacyHeaders: false,

  message: {
    error: 'Too many requests — try again later'
  },
});

const adminLimiter = rateLimit({

  windowMs: 60_000,

  max: 10,

  standardHeaders: true,

  legacyHeaders: false,

  message: {
    error: 'Too many admin requests'
  },
});

/**
 * Public routes
 */
router.get(
  '/health',
  (req, res) =>
    webhookController.healthCheck(req, res)
);

router.get(
  '/health/detailed',
  (req, res) =>
    webhookController.detailedHealthCheck(req, res)
);

/**
 * JotForm webhook
 */
router.post(

  '/webhook/jotform',

  webhookLimiter,

  requireWebhookToken,

  /**
   * IMPORTANT:
   * Parse multipart/form-data
   */
  upload.any(),

  (req, res, next) =>
    webhookController.handleJotFormWebhook(
      req,
      res,
      next
    )
);

/**
 * Admin routes
 */
router.post(

  '/admin/reload-config',

  adminLimiter,

  requireWebhookToken,

  (req, res) =>
    webhookController.reloadConfig(req, res)
);

export default router;