import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../config';
import type { BitrixDepartmentConfig } from '../config';
import { logger } from '../utils/logger';
import { withRetry, isRetryableHttpError } from '../utils/retry';
import { FieldRegistry } from './field.registry';
import type {
  BitrixApiResponse,
  BitrixLeadFields,
  BitrixContactFields,
  BitrixDealFields,
} from '../types/bitrix.types';

// ── Bitrix24 error codes that must never be retried ───────────────────────────
// FIX: Added ERROR_ prefixed variants — these are the ACTUAL codes Bitrix24
// sends in body.error. The non-prefixed versions never appear in practice.
const NON_RETRYABLE = new Set([
  'INVALID_CREDENTIALS',
  'ERROR_INVALID_CREDENTIALS',
  'WRONG_LOGIN',
  'ERROR_WRONG_LOGIN',
  'ACCESS_DENIED',
  'ERROR_ACCESS_DENIED',
  'METHOD_NOT_FOUND',
  'ERROR_METHOD_NOT_FOUND',   // ← this was the missing one causing 5 retries
  'INVALID_ARG_VALUE',
  'ERROR_INVALID_ARG_VALUE',
]);

class RateLimiter {
  private lastCallAt    = 0;
  private readonly minInterval: number;

  constructor(callsPerSecond: number) {
    this.minInterval = Math.ceil(1000 / callsPerSecond);
  }

  async throttle(): Promise<void> {
    const wait = this.minInterval - (Date.now() - this.lastCallAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }
}

export class BitrixClient {
  private readonly http:    AxiosInstance;
  private readonly limiter: RateLimiter;

  readonly departmentKey: string;
  readonly fieldRegistry: FieldRegistry;

  constructor(departmentKey: string, cfg: BitrixDepartmentConfig) {
    this.departmentKey = departmentKey;
    this.limiter       = new RateLimiter(config.bitrix.rateLimitPerSecond);
    this.fieldRegistry = new FieldRegistry(this);

    this.http = axios.create({
      baseURL: cfg.baseUrl,
      timeout: 30_000,
      headers: { 'Content-Type': 'application/json' },
    });

    this.http.interceptors.response.use(
      res => res,
      (err: AxiosError) => {
        logger.error('Bitrix24 HTTP error', {
          department: departmentKey,
          status:     err.response?.status,
          data:       err.response?.data,
          url:        err.config?.url,
        });
        return Promise.reject(err);
      }
    );
  }

  // ── Standard retrying call — used for Lead/Contact/Deal operations ─────────
  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return withRetry(
      async () => {
        await this.limiter.throttle();
        const res  = await this.http.post<BitrixApiResponse<T>>(`/${method}`, params);
        const body = res.data;

        if (body.error) {
          const retryable = !NON_RETRYABLE.has(body.error);
          throw Object.assign(
            new Error(
              `Bitrix24[${this.departmentKey}] [${body.error}]: ` +
              `${body.error_description ?? 'unknown'}`
            ),
            { retryable, bitrixCode: body.error }
          );
        }

        return body.result as T;
      },
      {
        maxAttempts:       config.retry.maxRetries,
        delayMs:           config.retry.retryDelayMs,
        backoffMultiplier: 2,
        maxDelayMs:        60_000,
        retryOn: (err) => {
          const e = err as { retryable?: boolean };
          if (e.retryable === false) return false;
          return isRetryableHttpError(err);
        },
      },
      `bitrix[${this.departmentKey}].${method}`
    );
  }

  // ── Single-attempt call — used for field management only ─────────────────
  // Field creation/inspection is best-effort. We never want to retry these
  // because:
  //   a) ERROR_METHOD_NOT_FOUND won't fix itself on retry
  //   b) Field already existing is not an error
  //   c) We don't want field management issues to delay Deal creation
  async callOnce<T>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.limiter.throttle();
    const res  = await this.http.post<BitrixApiResponse<T>>(`/${method}`, params);
    const body = res.data;

    if (body.error) {
      throw Object.assign(
        new Error(
          `Bitrix24[${this.departmentKey}] [${body.error}]: ` +
          `${body.error_description ?? 'unknown'}`
        ),
        { bitrixCode: body.error }
      );
    }

    return body.result as T;
  }

  // ── CRM entity methods ────────────────────────────────────────────────────

  async createLead(fields: BitrixLeadFields): Promise<number> {
    logger.info('Creating Lead', { department: this.departmentKey, title: fields.TITLE });
    const id = await this.call<number>('crm.lead.add', { fields });
    logger.info('Lead created', { department: this.departmentKey, leadId: id });
    return id;
  }

  async createContact(fields: BitrixContactFields): Promise<number> {
    logger.info('Creating Contact', { department: this.departmentKey });
    const id = await this.call<number>('crm.contact.add', { fields });
    logger.info('Contact created', { department: this.departmentKey, contactId: id });
    return id;
  }

  async createDeal(fields: BitrixDealFields): Promise<number> {
    logger.info('Creating Deal', { department: this.departmentKey, title: fields.TITLE });
    const id = await this.call<number>('crm.deal.add', { fields });
    logger.info('Deal created', { department: this.departmentKey, dealId: id });
    return id;
  }

  async findDealByEmail(email: string): Promise<number | null> {
    try {
      const rows = await this.call<Array<{ ID: string }>>('crm.deal.list', {
        filter: { EMAIL: email },
        select: ['ID'],
      });
      if (Array.isArray(rows) && rows.length > 0 && rows[0]) {
        return parseInt(rows[0].ID, 10);
      }
    } catch (err) {
      logger.warn('Duplicate check failed — proceeding with creation', {
        department: this.departmentKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }

  // ── Field management methods ──────────────────────────────────────────────

  /**
   * Fetches ALL Deal field definitions from this portal.
   * Uses callOnce — no retries needed, this is read-only discovery.
   */
  async getDealFields(): Promise<Record<string, unknown>> {
    return this.callOnce<Record<string, unknown>>('crm.deal.fields', {});
  }

  /**
   * Creates a new string custom field on CRM Deals.
   * Uses callOnce — field creation must never be retried because:
   *   - Retrying a successful creation causes a DUPLICATE error
   *   - Retrying a METHOD_NOT_FOUND won't suddenly grant permissions
   *
   * @param suffix  The part AFTER UF_CRM_  e.g. "FACILITIES_SERVICE"
   * @param label   Human-readable label shown in Bitrix24 UI
   */
  async createDealField(suffix: string, label: string): Promise<void> {
    await this.callOnce<unknown>('crm.deal.userfield.add', {
      fields: {
        ENTITY_ID:         'CRM_DEAL',
        FIELD_NAME:        suffix,
        USER_TYPE_ID:      'string',
        EDIT_FORM_LABEL:   label,
        LIST_COLUMN_LABEL: label,
        SHOW_IN_LIST:      'Y',
        EDIT_IN_LIST:      'Y',
        IS_SEARCHABLE:     'Y',
        XML_ID:            suffix,
      },
    });
  }

  // ── Health check ──────────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      await this.callOnce<unknown>('app.info', {});
      return true;
    } catch {
      return false;
    }
  }
}

// ── Client registry ───────────────────────────────────────────────────────────

export class BitrixClientRegistry {
  private readonly clients: Map<string, BitrixClient> = new Map();

  constructor() {
    for (const [key, cfg] of Object.entries(config.bitrix.departments)) {
      const client = new BitrixClient(key, cfg);
      this.clients.set(key.toUpperCase(), client);
      logger.info('Bitrix24 client registered', {
        department: key,
        domain:     cfg.domain,
      });
    }
  }

  async initAllRegistries(): Promise<void> {
    await Promise.all(
      [...this.clients.values()].map(c => c.fieldRegistry.init())
    );
  }

  getClient(departmentKey: string): BitrixClient {
    const key    = departmentKey.toUpperCase();
    const client = this.clients.get(key);
    if (!client) {
      const available = [...this.clients.keys()].join(', ');
      throw new Error(
        `No Bitrix24 client for department "${departmentKey}". ` +
        `Available: ${available}.`
      );
    }
    return client;
  }

  getDepartmentKeys(): string[] {
    return [...this.clients.keys()];
  }

  async healthCheckAll(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    for (const [key, client] of this.clients.entries()) {
      results[key] = await client.healthCheck();
    }
    return results;
  }
}

export const bitrixRegistry = new BitrixClientRegistry();