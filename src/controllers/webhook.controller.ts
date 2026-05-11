import type { Request, Response, NextFunction } from 'express';
import { v4 as uuid } from 'uuid';
import { logger } from '../utils/logger';
import { jotformService } from '../services/jotform.service';
import { mappingService } from '../services/mapping.service';
import { bitrixRegistry } from '../services/bitrix.service';
import { jotformBodySchema } from '../validators/webhook.validator';
import type {
  BitrixLeadFields,
  // BitrixContactFields,
  // BitrixDealFields,
} from '../types/bitrix.types';
// import type { FormMappingConfig } from '../types/mapping.types';
import type { ParsedJotFormSubmission } from '../types/jotform.types';

export class WebhookController {

  async handleJotFormWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    const requestId = uuid();

    try {
      const validation = jotformBodySchema.safeParse(req.body);
      if (!validation.success) {
        res.status(400).json({ error: 'Invalid payload', details: validation.error.issues });
        return;
      }

      const submission = jotformService.parseWebhookPayload(
        req.body as Record<string, string | string[]>
      );

      logger.info('Webhook received', {
        requestId,
        formId:       submission.formId,
        submissionId: submission.submissionId,
        formTitle:    submission.formTitle,
        mode:         mappingService.isAutoMapEnabled() ? 'auto' : 'explicit',
      });

      // Respond to JotForm immediately — before any async processing
      res.status(200).json({
        success:      true,
        message:      'Received',
        submissionId: submission.submissionId,
        requestId,
      });

      // Process in background
      this.processSubmission(submission, requestId).catch((err: unknown) => {
        logger.error('Background processing failed', {
          requestId,
          submissionId: submission.submissionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    } catch (err) {
      next(err);
    }
  }

  private async processSubmission(
    submission: ParsedJotFormSubmission,
    requestId: string
  ): Promise<void> {

    // ── Step 1: Resolve routing ───────────────────────────────────────────
    const departmentKey = this.resolveRouting(submission, requestId);
    if (!departmentKey) return;

    // ── Step 2: Get Bitrix24 client ───────────────────────────────────────
    let client;
    try {
      client = bitrixRegistry.getClient(departmentKey);
    } catch (err) {
      logger.error('No Bitrix24 client — submission dropped', {
        requestId, departmentKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // ── Step 3: Map fields ────────────────────────────────────────────────
    let fields: BitrixLeadFields;

    if (mappingService.isAutoMapEnabled()) {
      // ── AUTO MODE — no config needed, handles any form automatically ──
      const globalDefaults = mappingService.getGlobalDefaults();
      const leadDefaults   = (globalDefaults.lead ?? {}) as Record<string, unknown>;

      fields = await mappingService.autoMapSubmission(
        submission,
        client,
        leadDefaults
      ) as BitrixLeadFields;

    } else {
      // ── EXPLICIT MODE — uses fieldMappings from mapping.config.json ───
      const formConfig = mappingService.getFormConfig(submission.formId);
      if (!formConfig) {
        logger.error('No mapping config and autoMap is off — submission dropped', {
          requestId, formId: submission.formId,
        });
        return;
      }

      const mapped = mappingService.mapToEntity(submission, formConfig);
      fields = mapped as BitrixLeadFields;

      // Duplicate check (explicit mode only — auto mode always skips)
      if (!formConfig.skipDuplicateCheck) {
        const emailField = fields.EMAIL;
        if (Array.isArray(emailField) && emailField[0]) {
          const existing = await client.findLeadByEmail(emailField[0].VALUE);
          if (existing !== null) {
            logger.warn('Duplicate lead — skipping', {
              requestId, submissionId: submission.submissionId,
              department: departmentKey, existingId: existing,
            });
            return;
          }
        }
      }
    }

    // ── Step 4: Create Lead in Bitrix24 ───────────────────────────────────
    const leadId = await client.createLead(fields);

    logger.info('Submission processed successfully', {
      requestId,
      submissionId: submission.submissionId,
      department:   departmentKey,
      leadId,
    });
  }

  /**
   * Determines which department this submission belongs to.
   * Checks in this order:
   *   1. Form-specific routing (explicit mode)
   *   2. Global routing config (both modes)
   *   3. Only one department configured → use it
   *   4. Cannot determine → drop and log
   */
  private resolveRouting(
    submission: ParsedJotFormSubmission,
    requestId: string
  ): string | null {

    // Form-specific routing (explicit mode only)
    if (!mappingService.isAutoMapEnabled()) {
      const formConfig = mappingService.getFormConfig(submission.formId);
      if (formConfig?.routing) {
        return mappingService.resolveRoutingDepartment(
          submission, formConfig.routing, requestId
        );
      }
    }

    // Global routing (works in both modes)
    const globalRouting = mappingService.getRoutingConfig();
    if (globalRouting) {
      return mappingService.resolveRoutingDepartment(
        submission, globalRouting, requestId
      );
    }

    // Single department — no routing needed
    const keys = bitrixRegistry.getDepartmentKeys();
    if (keys.length === 1) {
      logger.info('Single department — no routing needed', {
        requestId, department: keys[0],
      });
      return keys[0]!;
    }

    logger.error('Cannot determine department — no routing config and multiple departments exist', {
      requestId, formId: submission.formId,
    });
    return null;
  }

  // ── Health endpoints ──────────────────────────────────────────────────────

  healthCheck(_req: Request, res: Response): void {
    res.json({
      status:      'ok',
      timestamp:   new Date().toISOString(),
      service:     'jotform-bitrix',
      mode:        mappingService.isAutoMapEnabled() ? 'auto' : 'explicit',
      departments: bitrixRegistry.getDepartmentKeys(),
    });
  }

  async detailedHealthCheck(_req: Request, res: Response): Promise<void> {
    const results = await bitrixRegistry.healthCheckAll();
    const allOk   = Object.values(results).every(Boolean);
    const anyOk   = Object.values(results).some(Boolean);
    res.status(allOk ? 200 : anyOk ? 207 : 503).json({
      status:      allOk ? 'ok' : anyOk ? 'partial' : 'down',
      timestamp:   new Date().toISOString(),
      mode:        mappingService.isAutoMapEnabled() ? 'auto' : 'explicit',
      departments: Object.fromEntries(
        Object.entries(results).map(([k, v]) => [k, v ? 'ok' : 'unreachable'])
      ),
    });
  }

  reloadConfig(_req: Request, res: Response): void {
    mappingService.reload();
    res.json({ success: true, message: 'Mapping config reloaded' });
  }
}

export const webhookController = new WebhookController();