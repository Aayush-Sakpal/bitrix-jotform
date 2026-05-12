import { logger } from '../utils/logger';
import type { BitrixClient } from './bitrix.service';

/**
 * Converts a JotForm field key into a valid Bitrix24 custom field suffix.
 *
 * q17_facilitiesService  →  FACILITIES_SERVICE
 * "Request Category"     →  REQUEST_CATEGORY
 * q26_typeA26            →  TYPE_A26
 *
 * Bitrix24 prepends UF_CRM_ automatically on creation.
 * We only ever pass the suffix.
 */
export function toFieldSuffix(jotformKey: string): string {
  // Step 1 — strip q{N}_ prefix
  const bare = jotformKey.replace(/^q\d+_/i, '');

  // Step 2 — replace spaces with underscores
  const noSpaces = bare.replace(/\s+/g, '_');

  // Step 3 — camelCase / PascalCase → UPPER_SNAKE_CASE
  const snaked = noSpaces
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toUpperCase();

  // Step 4 — strip invalid characters, collapse multiple underscores
  const clean = snaked
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  // Step 5 — truncate to Bitrix24's 50-character field name limit
  return clean.substring(0, 50);
}

/**
 * Returns the full Bitrix24 field name including the UF_CRM_ prefix.
 * q17_facilitiesService → UF_CRM_FACILITIES_SERVICE
 */
export function toBitrixFieldName(jotformKey: string): string {
  return `UF_CRM_${toFieldSuffix(jotformKey)}`;
}

/**
 * FieldRegistry — one instance per Bitrix24 department client.
 *
 * Keeps an in-memory Set of field names confirmed to exist in that portal.
 *
 * On startup  → fetches the full field list from Bitrix24 and caches it.
 * On submit   → checks the cache. If field exists: instant return (no API call).
 *               If field is missing: attempts to create it, then caches it.
 * On failure  → logs clearly and continues. Never crashes a Deal submission.
 */
export class FieldRegistry {
  private knownFields:  Set<string>    = new Set();
  private initialised  = false;
  private initialising = false;
  private initWaiters: Array<() => void> = [];

  // Track whether this portal supports crm.userfield.add.
  // Once we know it doesn't (METHOD_NOT_FOUND), we stop trying
  // for every subsequent field — avoids a flood of 404 errors.
  private canCreateFields: boolean | null = null;

  constructor(private readonly client: BitrixClient) {}

  // ── Initialisation ────────────────────────────────────────────────────────

  /**
   * Fetches all existing Deal fields from Bitrix24 and caches their names.
   * Must be called once at startup before processing any submissions.
   */
  async init(): Promise<void> {
    if (this.initialised) return;

    // If two webhooks arrive simultaneously during startup, queue the second
    if (this.initialising) {
      await new Promise<void>(resolve => this.initWaiters.push(resolve));
      return;
    }

    this.initialising = true;

    try {
      const fields     = await this.client.getDealFields();
      this.knownFields = new Set(Object.keys(fields));
      this.initialised = true;

      logger.info('FieldRegistry initialised', {
        department:  this.client.departmentKey,
        fieldCount:  this.knownFields.size,
        customCount: [...this.knownFields].filter(f => f.startsWith('UF_CRM_')).length,
      });
    } catch (err) {
      logger.error(
        'FieldRegistry init failed — will retry on first submission. ' +
        'Check that your Bitrix24 token has CRM scope.',
        {
          department: this.client.departmentKey,
          error:      err instanceof Error ? err.message : String(err),
        }
      );
      // Leave initialised = false so we retry on the next submission
    } finally {
      this.initialising = false;
      this.initWaiters.forEach(resolve => resolve());
      this.initWaiters = [];
    }
  }

  // ── Field existence guarantee ─────────────────────────────────────────────

  /**
   * Ensures a custom field exists in Bitrix24 before we send a Deal with it.
   *
   * Outcomes:
   *   Field already known  →  instant return (cache hit)
   *   Field missing + can create  →  creates it, caches it, returns
   *   Field missing + cannot create (no permission)  →  logs warning, returns
   *   Any other error  →  logs warning, skips this field, returns
   *
   * This method NEVER throws. A field management failure must never
   * prevent the Deal itself from being created.
   *
   * @param fullFieldName  e.g. "UF_CRM_FACILITIES_SERVICE"
   * @param label          Human-readable label shown in Bitrix24 UI
   */
  async ensureField(fullFieldName: string, label: string): Promise<void> {
    // Fast path — field already confirmed to exist
    if (this.knownFields.has(fullFieldName)) return;

    // If init hasn't run yet (startup timing edge case), retry it now
    if (!this.initialised) {
      await this.init();
      // Check again after init
      if (this.knownFields.has(fullFieldName)) return;
    }

    // If we already know this portal doesn't allow field creation, skip silently
    if (this.canCreateFields === false) {
      logger.debug('Skipping field creation — portal does not permit it', {
        department: this.client.departmentKey,
        field:      fullFieldName,
      });
      return;
    }

    // Strip UF_CRM_ prefix — Bitrix24 re-adds it on creation
    const suffix = fullFieldName.startsWith('UF_CRM_')
      ? fullFieldName.slice(7)
      : fullFieldName;

    try {
      await this.client.createDealField(suffix, label);

      // Creation succeeded — cache it and mark that this portal supports creation
      this.knownFields.add(fullFieldName);
      this.canCreateFields = true;

      logger.info('Auto-created Bitrix24 custom field', {
        department: this.client.departmentKey,
        field:      fullFieldName,
        label,
      });

    } catch (err) {
      const msg      = err instanceof Error ? err.message : String(err);
      const errObj   = err as { bitrixCode?: string };
      const errCode  = errObj.bitrixCode ?? '';

      // ── Field already exists ─────────────────────────────────────────────
      // Race condition: another process created it between our check and now.
      if (
        errCode === 'DUPLICATE' ||
        msg.toLowerCase().includes('duplicate') ||
        msg.toLowerCase().includes('already exist')
      ) {
        this.knownFields.add(fullFieldName);
        logger.debug('Field already exists (race condition) — cached', {
          department: this.client.departmentKey,
          field:      fullFieldName,
        });
        return;
      }

      // ── Webhook lacks permission to create fields ────────────────────────
      // ERROR_METHOD_NOT_FOUND or ACCESS_DENIED means the incoming webhook
      // token does not have the right to call crm.userfield.add.
      // This is expected when using a basic incoming webhook.
      // Solution: create the field manually in Bitrix24, or upgrade the
      // webhook to an OAuth app with userfieldconfig scope.
      if (
        errCode === 'ERROR_METHOD_NOT_FOUND' ||
        errCode === 'METHOD_NOT_FOUND'       ||
        errCode === 'ERROR_ACCESS_DENIED'    ||
        errCode === 'ACCESS_DENIED'
      ) {
        // Remember this so we don't try again for every field in this session
        this.canCreateFields = false;

        logger.warn(
          `Bitrix24 webhook token cannot create custom fields (${errCode}). ` +
          `The field "${fullFieldName}" (label: "${label}") must be created manually. ` +
          `Go to: Bitrix24 → CRM → Settings ⚙️ → Custom Fields → Deals → Add Field. ` +
          `Field code: ${suffix}. ` +
          `This field will be SKIPPED in submissions until it is created manually.`,
          {
            department: this.client.departmentKey,
            field:      fullFieldName,
            suffix,
            label,
          }
        );
        return;
      }

      // ── Any other error — skip this field, don't crash the submission ────
      logger.warn(
        `Could not create/verify field "${fullFieldName}" — ` +
        `it will be skipped in this submission. Error: ${msg}`,
        {
          department: this.client.departmentKey,
          field:      fullFieldName,
          error:      msg,
        }
      );
    }
  }

  /** Returns true if the field is confirmed to exist in this portal. */
  has(fieldName: string): boolean {
    return this.knownFields.has(fieldName);
  }

  /** Force a full refresh from Bitrix24 (used by /admin/reload-config). */
  async reset(): Promise<void> {
    this.initialised     = false;
    this.initialising    = false;
    this.knownFields     = new Set();
    this.canCreateFields = null;
    await this.init();
  }
}