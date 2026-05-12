import type { Request, Response, NextFunction } from 'express';
import { v4 as uuid } from 'uuid';
import { logger } from '../utils/logger';
import { jotformService } from '../services/jotform.service';
import { mappingService } from '../services/mapping.service';
import { bitrixRegistry } from '../services/bitrix.service';
import { jotformBodySchema } from '../validators/webhook.validator';
import type {
  BitrixLeadFields,
  BitrixContactFields,
  BitrixDealFields,
} from '../types/bitrix.types';
import type { FormMappingConfig } from '../types/mapping.types';
import type { ParsedJotFormSubmission } from '../types/jotform.types';

export class WebhookController {

  // ── Webhook entry point ───────────────────────────────────────────────────

  async handleJotFormWebhook(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const requestId = uuid();

    try {
      // 1. Validate minimum required fields
      const validation = jotformBodySchema.safeParse(req.body);
      if (!validation.success) {
        logger.warn('Invalid webhook body', {
          requestId,
          issues: validation.error.issues,
        });
        res.status(400).json({
          error:   'Invalid payload',
          details: validation.error.issues,
        });
        return;
      }

      // 2. Parse into clean submission model
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

      // 3. Respond to JotForm immediately — BEFORE processing.
      //    JotForm will retry the webhook if we don't reply within ~30 seconds.
      //    Responding here prevents duplicate submissions.
      res.status(200).json({
        success:      true,
        message:      'Received — processing in background',
        submissionId: submission.submissionId,
        requestId,
      });

      // 4. Process asynchronously after response is sent
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

  // ── Core processing logic ─────────────────────────────────────────────────

  private async processSubmission(
    submission: ParsedJotFormSubmission,
    requestId: string
  ): Promise<void> {

    // Step 1 — Resolve which department this submission belongs to
    const departmentKey = this.resolveRouting(submission, requestId);
    if (!departmentKey) {
      // resolveRouting already logged the reason
      return;
    }

    // Step 2 — Get the Bitrix24 client for that department
    let client;
    try {
      client = bitrixRegistry.getClient(departmentKey);
    } catch (err) {
      logger.error('Cannot get Bitrix24 client — submission dropped', {
        requestId,
        departmentKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Step 3 — Map JotForm fields to Bitrix24 entity fields
    let fields: BitrixDealFields;

    if (mappingService.isAutoMapEnabled()) {
      // AUTO MODE — zero config, handles any form automatically
      const globalDefaults = mappingService.getGlobalDefaults();
      const dealDefaults   = (globalDefaults.deal ?? {}) as Record<string, unknown>;

      fields = (await mappingService.autoMapSubmission(
        submission,
        client,
        dealDefaults
      )) as BitrixDealFields;

    } else {
      // EXPLICIT MODE — uses fieldMappings from mapping.config.json
      const formConfig = mappingService.getFormConfig(submission.formId);
      if (!formConfig) {
        logger.error(
          'No mapping config found for this form and autoMap is off — submission dropped',
          { requestId, formId: submission.formId }
        );
        return;
      }

      const entityFields = mappingService.mapToEntity(submission, formConfig);

      // Duplicate check (explicit mode only)
      if (!formConfig.skipDuplicateCheck) {
        const emailField = (entityFields as BitrixDealFields).EMAIL;
        if (Array.isArray(emailField) && emailField[0]) {
          const existing = await client.findDealByEmail(emailField[0].VALUE);
          if (existing !== null) {
            logger.warn('Duplicate deal detected — skipping creation', {
              requestId,
              submissionId: submission.submissionId,
              department:   departmentKey,
              existingId:   existing,
            });
            return;
          }
        }
      }

      // Handle secondary entity (explicit mode only)
      if (formConfig.secondaryEntity) {
        void this.createSecondaryEntity(
          submission,
          formConfig,
          client,
          requestId
        );
      }

      fields = entityFields as BitrixDealFields;
    }

    // Step 4 — Determine entity type and create in Bitrix24
    const entityType = this.resolveEntityType(submission.formId);

    await this.createBitrixEntity(
      entityType,
      fields,
      client,
      submission.submissionId,
      departmentKey,
      requestId
    );
  }

  /**
   * Creates the primary Bitrix24 entity (Lead, Contact, or Deal).
   */
  private async createBitrixEntity(
    entityType: 'lead' | 'contact' | 'deal',
    fields: BitrixLeadFields | BitrixContactFields | BitrixDealFields,
    client: ReturnType<typeof bitrixRegistry.getClient>,
    submissionId: string,
    departmentKey: string,
    requestId: string
  ): Promise<void> {
    let id: number;

    switch (entityType) {
      case 'lead':
        id = await client.createLead(fields as BitrixLeadFields);
        break;
      case 'contact':
        id = await client.createContact(fields as BitrixContactFields);
        break;
      case 'deal':
        id = await client.createDeal(fields as BitrixDealFields);
        break;
    }

    logger.info('Submission processed successfully', {
      requestId,
      submissionId,
      department: departmentKey,
      entity:     entityType,
      id,
    });
  }

  /**
   * Creates a secondary Bitrix24 entity — best effort, never fails the primary.
   */
  private async createSecondaryEntity(
    submission: ParsedJotFormSubmission,
    formConfig: FormMappingConfig,
    client: ReturnType<typeof bitrixRegistry.getClient>,
    requestId: string
  ): Promise<void> {
    if (!formConfig.secondaryEntity) return;

    try {
      const secConfig: FormMappingConfig = {
        bitrixEntity:       formConfig.secondaryEntity.bitrixEntity,
        fieldMappings:      formConfig.secondaryEntity.fieldMappings,
        defaults:           formConfig.secondaryEntity.defaults,
        skipDuplicateCheck: true,
      };
      const secFields = mappingService.mapToEntity(submission, secConfig);

      let secId: number;
      switch (secConfig.bitrixEntity) {
        case 'contact':
          secId = await client.createContact(secFields as BitrixContactFields);
          break;
        case 'deal':
          secId = await client.createDeal(secFields as BitrixDealFields);
          break;
        default:
          secId = await client.createDeal(secFields as BitrixDealFields);
      }

      logger.info('Secondary entity created', {
        requestId,
        entity: secConfig.bitrixEntity,
        id:     secId,
      });
    } catch (err) {
      logger.error('Secondary entity creation failed (primary was successful)', {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Determines which Bitrix24 entity type to create.
   * In auto mode: always Deal (service request forms create Deals).
   * In explicit mode: reads from form config.
   */
  private resolveEntityType(formId: string): 'lead' | 'contact' | 'deal' {
    if (!mappingService.isAutoMapEnabled()) {
      const formConfig = mappingService.getFormConfig(formId);
      if (formConfig) {
        const entity = formConfig.bitrixEntity;
        if (entity === 'contact' || entity === 'lead') return entity;
      }
    }
    return 'deal';
  }

  /**
   * Determines which department this submission belongs to.
   *
   * Priority order:
   *   1. Form-specific routing (explicit mode only)
   *   2. Global routing config (both modes)
   *   3. Only one department configured → use it automatically
   *   4. Nothing matches → drop submission and log error
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
          submission,
          formConfig.routing,
          requestId
        );
      }
    }

    // Global routing — works in both auto and explicit modes
    const globalRouting = mappingService.getRoutingConfig();
    if (globalRouting) {
      return mappingService.resolveRoutingDepartment(
        submission,
        globalRouting,
        requestId
      );
    }

    // Single department — no routing needed
    const keys = bitrixRegistry.getDepartmentKeys();
    if (keys.length === 1) {
      logger.info('Single department configured — no routing needed', {
        requestId,
        department: keys[0],
      });
      return keys[0]!;
    }

    logger.error(
      'Cannot determine target department — ' +
      'no routing config and multiple departments are configured. ' +
      'Add globalRouting to mapping.config.json.',
      { requestId, formId: submission.formId }
    );
    return null;
  }

  // ── Health endpoints ──────────────────────────────────────────────────────

  healthCheck(_req: Request, res: Response): void {
    res.json({
      status:      'ok',
      timestamp:   new Date().toISOString(),
      service:     'jotform-bitrix-integration',
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
    res.json({ success: true, message: 'Mapping config reloaded from disk' });
  }
}

export const webhookController = new WebhookController();