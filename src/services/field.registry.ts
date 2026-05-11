import { logger } from '../utils/logger';
import type { BitrixClient } from './bitrix.service';

/**
 * Sanitises a JotForm field name into a valid Bitrix24 custom field suffix.
 *
 * Rules:
 *  - Strip the q{N}_ prefix  (q17_facilitiesService → facilitiesService)
 *  - Convert camelCase to UPPER_SNAKE  (facilitiesService → FACILITIES_SERVICE)
 *  - Strip all characters that are not A-Z, 0-9, or underscore
 *  - Truncate to 50 characters (Bitrix24 limit)
 *
 * Bitrix24 automatically prepends UF_CRM_ when you create the field,
 * so we only pass the suffix here.
 *
 * Example:
 *   q17_facilitiesService  →  FACILITIES_SERVICE
 *   Bitrix24 stores it as  →  UF_CRM_FACILITIES_SERVICE
 */
export function toFieldSuffix(jotformKey: string): string {
  // Remove q{N}_ prefix
  const bare = jotformKey.replace(/^q\d+_/i, '');

  // Replace spaces with underscores FIRST before any other processing
  const noSpaces = bare.replace(/\s+/g, '_');

  // camelCase / PascalCase → UPPER_SNAKE_CASE
  const snaked = noSpaces
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toUpperCase();

  // Remove invalid characters, collapse multiple underscores
  const clean = snaked
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  return clean.substring(0, 50);
}

/**
 * Returns the full Bitrix24 field name for a JotForm key.
 * e.g. q17_facilitiesService → UF_CRM_FACILITIES_SERVICE
 */
export function toBitrixFieldName(jotformKey: string): string {
  return `UF_CRM_${toFieldSuffix(jotformKey)}`;
}

/**
 * FieldRegistry — per Bitrix24 department client.
 *
 * Keeps an in-memory set of field names that are confirmed to exist
 * in that department's Bitrix24 portal.
 *
 * On first use it fetches the full field list from Bitrix24.
 * When a field is missing it creates it automatically, then caches it.
 * Subsequent submissions skip the check entirely — pure in-memory lookup.
 */
export class FieldRegistry {
  // Set of FULL field names that exist: "UF_CRM_LOCATION", "EMAIL", etc.
  private knownFields: Set<string> = new Set();
  private initialised  = false;
  private initialising = false;
  // Queue of callers waiting for the first init to finish
  private initWaiters: Array<() => void> = [];

  constructor(private readonly client: BitrixClient) {}

  /**
   * Call this once per server start (or after a reload).
   * Fetches all existing fields from Bitrix24 and caches their names.
   */
  async init(): Promise<void> {
    if (this.initialised) return;

    // Prevent parallel initialisations if two webhooks arrive simultaneously
    if (this.initialising) {
      await new Promise<void>(resolve => this.initWaiters.push(resolve));
      return;
    }

    this.initialising = true;

    try {
      const fields = await this.client.getLeadFields();
      this.knownFields = new Set(Object.keys(fields));
      this.initialised = true;
      logger.info('FieldRegistry initialised', {
        department:  this.client.departmentKey,
        fieldCount:  this.knownFields.size,
      });
    } catch (err) {
      logger.error('FieldRegistry init failed — will retry on next submission', {
        department: this.client.departmentKey,
        error:      err instanceof Error ? err.message : String(err),
      });
      // Don't mark as initialised — will retry next time
    } finally {
      this.initialising = false;
      // Wake all waiters
      this.initWaiters.forEach(resolve => resolve());
      this.initWaiters = [];
    }
  }

  /**
   * Ensures a custom field exists in Bitrix24.
   * If it already exists (cached): instant return.
   * If it does not exist: creates it, then caches it.
   *
   * @param fullFieldName  e.g. "UF_CRM_FACILITIES_SERVICE"
   * @param label          Human-readable label shown in Bitrix24 UI
   */
  async ensureField(fullFieldName: string, label: string): Promise<void> {
    if (this.knownFields.has(fullFieldName)) return;

    // Strip UF_CRM_ prefix — Bitrix24 adds it back on creation
    const suffix = fullFieldName.startsWith('UF_CRM_')
      ? fullFieldName.slice(7)   // remove "UF_CRM_"
      : fullFieldName;

    try {
      await this.client.createLeadField(suffix, label);
      this.knownFields.add(fullFieldName);
      logger.info('Auto-created Bitrix24 custom field', {
        department: this.client.departmentKey,
        field:      fullFieldName,
        label,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // "Field already exists" is not a real error — another process beat us to it
      if (msg.includes('DUPLICATE') || msg.includes('already exists') || msg.includes('already_exists')) {
        this.knownFields.add(fullFieldName);
        return;
      }

      // For any other error, log and continue — don't crash the submission
      logger.warn('Could not auto-create field — value will be skipped', {
        department: this.client.departmentKey,
        field:      fullFieldName,
        error:      msg,
      });
    }
  }

  /** True if a field is confirmed to exist. */
  has(fieldName: string): boolean {
    return this.knownFields.has(fieldName);
  }

  /** Force a fresh fetch from Bitrix24 (used by reload-config endpoint). */
  async reset(): Promise<void> {
    this.initialised  = false;
    this.initialising = false;
    this.knownFields  = new Set();
    await this.init();
  }
}