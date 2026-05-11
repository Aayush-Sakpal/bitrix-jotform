import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import type {
  ParsedJotFormSubmission,
  JotFormFieldValue,
} from '../types/jotform.types';
import type { BitrixMultiField, BitrixEntityFields } from '../types/bitrix.types';
import type {
  MappingConfig,
  FormMappingConfig,
  FieldTransform,
} from '../types/mapping.types';
import { jotformService } from './jotform.service';
import { toBitrixFieldName, toFieldSuffix } from './field.registry';
import type { BitrixClient } from './bitrix.service';

// ─────────────────────────────────────────────────────────────────────────────
// FIELD DETECTION RULES
//
// When a form has no explicit mapping config, the auto-mapper uses these rules
// to detect what kind of data each JotForm field contains by looking at its
// name. Case-insensitive substring matching.
// ─────────────────────────────────────────────────────────────────────────────

/** Fields that match these patterns get mapped to Bitrix24 EMAIL */
const EMAIL_PATTERNS    = ['email', 'mail', 'e-mail'];

/** Fields that match these patterns get mapped to Bitrix24 PHONE */
const PHONE_PATTERNS    = ['phone', 'mobile', 'cell', 'tel', 'contact'];

/** Fields that match these patterns are used to build the Lead TITLE */
const TITLE_PATTERNS    = ['name', 'fullname', 'location', 'company', 'title', 'organisation', 'organization'];

/** Fields we skip entirely — internal JotForm metadata, not real form data */
const SKIP_FIELDS       = new Set([
  'formid', 'submissionid', 'formtitle', 'ip', 'rawrequest', 'pretty',
  'submitsource', 'submitdate', 'builddate', 'uploadserverurl',
  'eventobserver', 'simple_spc', 'event_id', 'timetosubmit',
  'temp_upload_folder', 'validatednewrequiredfieldids',
  'jsexecutiontracker', 'website',
]);

function matchesAny(key: string, patterns: string[]): boolean {
  const lower = key.toLowerCase();
  return patterns.some(p => lower.includes(p));
}

function isSkippable(key: string): boolean {
  return SKIP_FIELDS.has(key.toLowerCase());
}

export class MappingService {
  private cfg: MappingConfig;

  constructor() {
    this.cfg = this.load();
  }

  private load(): MappingConfig {
    const p = config.mapping.configPath;
    if (!fs.existsSync(p)) {
      logger.warn('mapping.config.json not found', { path: p });
      return { forms: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as MappingConfig;
      logger.info('Mapping config loaded', {
        formCount:  Object.keys(parsed.forms).length,
        hasDefault: !!parsed.defaultForm,
        autoMap:    parsed.autoMap ?? false,
      });
      return parsed;
    } catch (err) {
      logger.error('Failed to parse mapping.config.json', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { forms: {} };
    }
  }

  reload(): void {
    this.cfg = this.load();
    logger.info('Mapping config reloaded');
  }

  getFormConfig(formId: string): FormMappingConfig | null {
    if (this.cfg.forms[formId]) return this.cfg.forms[formId]!;
    if (this.cfg.defaultForm)  return this.cfg.defaultForm;
    return null;
  }

  isAutoMapEnabled(): boolean {
    return this.cfg.autoMap === true;
  }

  getRoutingConfig() {
    return this.cfg.globalRouting ?? null;
  }

  getGlobalDefaults() {
    return this.cfg.globalDefaults ?? {};
  }

  // ── Explicit mapping (existing behaviour — unchanged) ─────────────────────

  mapToEntity(
    submission: ParsedJotFormSubmission,
    formConfig: FormMappingConfig
  ): BitrixEntityFields {
    const result: Record<string, unknown> = {};

    Object.assign(result, this.cfg.globalDefaults?.[formConfig.bitrixEntity] ?? {});
    Object.assign(result, formConfig.defaults ?? {});

    const multi: Record<string, BitrixMultiField[]> = {};

    for (const mapping of formConfig.fieldMappings) {
      const raw = this.resolveField(submission, mapping.jotformField);

      if (raw === null || raw === undefined) {
        if (mapping.required) {
          logger.warn('Required field missing', {
            submissionId: submission.submissionId,
            field:        mapping.jotformField,
          });
        }
        continue;
      }

      const transformed = this.applyTransform(raw, mapping.transform ?? 'none');
      if (transformed === null || transformed === '' || transformed === undefined) continue;

      const ftype = mapping.fieldType ?? 'string';

      if (ftype === 'email' || ftype === 'phone' || ftype === 'web') {
        if (!multi[mapping.bitrixField]) multi[mapping.bitrixField] = [];
        multi[mapping.bitrixField]!.push({
          VALUE:      String(transformed),
          VALUE_TYPE: mapping.valueType ?? 'WORK',
        });
      } else if (ftype === 'float') {
        result[mapping.bitrixField] = parseFloat(String(transformed)) || 0;
      } else if (ftype === 'integer') {
        result[mapping.bitrixField] = parseInt(String(transformed), 10) || 0;
      } else {
        result[mapping.bitrixField] = String(transformed);
      }
    }

    for (const [k, v] of Object.entries(multi)) result[k] = v;

    if (!result['COMMENTS']) {
      result['COMMENTS'] = this.buildNote(submission, formConfig.appendNote);
    }

    return result as BitrixEntityFields;
  }

  // ── Auto-mapping (new behaviour — zero config needed) ─────────────────────

  /**
   * Automatically maps ALL fields from a JotForm submission to Bitrix24
   * fields without any explicit configuration.
   *
   * What it does:
   *  1. Skips internal JotForm metadata fields
   *  2. Detects email fields → maps to Bitrix24 EMAIL
   *  3. Detects phone fields → maps to Bitrix24 PHONE
   *  4. Everything else     → maps to UF_CRM_{FIELD_NAME} (auto-created if missing)
   *  5. Builds a TITLE from the best available field
   *  6. Ensures every custom field exists in Bitrix24 before sending
   *
   * @param submission  The parsed JotForm submission
   * @param client      The Bitrix24 client for the target department
   * @param defaults    Global defaults merged in (SOURCE_ID, STATUS_ID, etc.)
   */
  async autoMapSubmission(
    submission: ParsedJotFormSubmission,
    client: BitrixClient,
    defaults: Record<string, unknown> = {}
  ): Promise<BitrixEntityFields> {
    const result: Record<string, unknown> = { ...defaults };
    const multi: Record<string, BitrixMultiField[]> = {};

    // Collect field creation promises so we can run them in parallel
    const fieldEnsurePromises: Promise<void>[] = [];

    // Track what we found for TITLE building
    let titleCandidate = '';

    // Process every field in the submission
    for (const [rawKey, value] of Object.entries(submission.fields)) {
      // Skip duplicates — we store both q3_email and email.
      // Only process the prefixed version (q3_email) to avoid double-mapping.
      // If there is no prefixed version, process the bare key.
      if (/^q\d+_/i.test(rawKey) === false) {
        // This is a bare key (e.g. "email") — only process if no prefixed
        // version of this key exists in the submission
        const prefixedExists = Object.keys(submission.fields).some(
          k => /^q\d+_/i.test(k) && k.replace(/^q\d+_/i, '').toLowerCase() === rawKey.toLowerCase()
        );
        if (prefixedExists) continue;
      }

      // Skip empty values
      const strValue = jotformService.fieldToString(value);
      if (!strValue || strValue.trim() === '') continue;

      // Get the bare key for pattern matching
      const bare = rawKey.replace(/^q\d+_/i, '');

      // Skip internal metadata fields
      if (isSkippable(bare) || isSkippable(rawKey)) continue;

      // ── Email detection ──────────────────────────────────────────────────
      if (matchesAny(bare, EMAIL_PATTERNS)) {
        if (!multi['EMAIL']) multi['EMAIL'] = [];
        multi['EMAIL'].push({ VALUE: strValue.trim(), VALUE_TYPE: 'WORK' });
        // Also store as custom field so it's searchable by name
        const customField = toBitrixFieldName(rawKey);
        const label       = toHumanLabel(bare);
        fieldEnsurePromises.push(client.fieldRegistry.ensureField(customField, label));
        result[customField] = strValue.trim();
        continue;
      }

      // ── Phone detection ──────────────────────────────────────────────────
      if (matchesAny(bare, PHONE_PATTERNS)) {
        if (!multi['PHONE']) multi['PHONE'] = [];
        multi['PHONE'].push({ VALUE: strValue.trim(), VALUE_TYPE: 'WORK' });
        const customField = toBitrixFieldName(rawKey);
        const label       = toHumanLabel(bare);
        fieldEnsurePromises.push(client.fieldRegistry.ensureField(customField, label));
        result[customField] = strValue.trim();
        continue;
      }

      // ── Title candidate detection ────────────────────────────────────────
      if (!titleCandidate && matchesAny(bare, TITLE_PATTERNS)) {
        titleCandidate = strValue.trim();
      }

      // ── Everything else → custom field ───────────────────────────────────
      const bitrixField = toBitrixFieldName(rawKey);
      const label       = toHumanLabel(bare);

      // Queue field creation (runs in parallel below)
      fieldEnsurePromises.push(client.fieldRegistry.ensureField(bitrixField, label));
      result[bitrixField] = strValue.trim();
    }

    // Wait for all field-existence checks/creations to complete
    // before we send the lead (Bitrix24 rejects unknown fields)
    await Promise.all(fieldEnsurePromises);

    // ── Merge multi-value fields ─────────────────────────────────────────
    for (const [k, v] of Object.entries(multi)) result[k] = v;

    // ── Build TITLE ──────────────────────────────────────────────────────
    // Priority: detected title candidate → form title → submission ID
    if (!result['TITLE']) {
      if (titleCandidate) {
        result['TITLE'] = `Request from ${titleCandidate}`;
      } else if (submission.formTitle && submission.formTitle !== 'Unknown Form') {
        result['TITLE'] = `${submission.formTitle} — ${submission.submissionId}`;
      } else {
        result['TITLE'] = `Service Request — ${submission.submissionId}`;
      }
    }

    // ── Add submission metadata to COMMENTS ─────────────────────────────
    if (!result['COMMENTS']) {
      result['COMMENTS'] = this.buildNote(submission);
    }

    return result as BitrixEntityFields;
  }

  // ── Routing ───────────────────────────────────────────────────────────────

  /**
   * Resolves the department key from a submission using the global routing
   * config. Works for both auto-map and explicit-mapping modes.
   */
  resolveRoutingDepartment(
    submission: ParsedJotFormSubmission,
    routingConfig: NonNullable<MappingConfig['globalRouting']>,
    requestId: string
  ): string | null {
    const raw = this.resolveField(submission, routingConfig.field);
    const val = raw ? jotformService.fieldToString(raw).trim() : '';

    if (!val) {
      logger.warn('Routing field empty', {
        requestId, field: routingConfig.field, submissionId: submission.submissionId,
      });
    }

    const matched = Object.entries(routingConfig.rules).find(
      ([ruleVal]) => ruleVal.toLowerCase() === val.toLowerCase()
    )?.[1];

    if (matched) {
      logger.info('Submission routed', {
        requestId, field: routingConfig.field, value: val, department: matched,
      });
      return matched.toUpperCase();
    }

    if (routingConfig.default) {
      logger.warn('No routing rule matched — using default', {
        requestId, value: val, default: routingConfig.default,
      });
      return routingConfig.default.toUpperCase();
    }

    logger.error('No routing rule matched and no default — submission dropped', {
      requestId, value: val, availableRules: Object.keys(routingConfig.rules),
    });
    return null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private resolveField(
    submission: ParsedJotFormSubmission,
    key: string
  ): JotFormFieldValue {
    if (key in submission.fields) return submission.fields[key] ?? null;
    const bare  = key.replace(/^q\d+_/i, '');
    if (bare in submission.fields) return submission.fields[bare] ?? null;
    const lower = bare.toLowerCase();
    for (const [k, v] of Object.entries(submission.fields)) {
      if (k.replace(/^q\d+_/i, '').toLowerCase() === lower) return v ?? null;
    }
    return null;
  }

  private applyTransform(
    value: JotFormFieldValue,
    transform: FieldTransform
  ): string | number | null {
    const str = jotformService.fieldToString(value);
    switch (transform) {
      case 'none':        return str;
      case 'trim':        return str.trim();
      case 'uppercase':   return str.toUpperCase();
      case 'lowercase':   return str.toLowerCase();
      case 'nameToTitle': return str ? `Lead from ${str}` : null;
      case 'joinName': {
        if (jotformService.isNameField(value)) {
          return [value.first, value.last].filter(Boolean).join(' ').trim() || str || null;
        }
        return str || null;
      }
      case 'firstName': {
        if (jotformService.isNameField(value)) return value.first?.trim() ?? null;
        return str.split(/\s+/)[0] ?? null;
      }
      case 'lastName': {
        if (jotformService.isNameField(value)) return value.last?.trim() ?? null;
        return str.split(/\s+/).slice(1).join(' ') || null;
      }
      case 'joinAddress': {
        if (jotformService.isAddressField(value)) {
          return [value.addr_line1, value.addr_line2, value.city, value.state, value.postal, value.country]
            .filter(Boolean).join(', ') || null;
        }
        return str || null;
      }
      case 'toFloat': {
        const n = parseFloat(str.replace(/[^0-9.\-]/g, ''));
        return isNaN(n) ? null : n;
      }
      case 'toInt': {
        const n = parseInt(str.replace(/[^0-9\-]/g, ''), 10);
        return isNaN(n) ? null : n;
      }
      default: return str;
    }
  }

  private buildNote(submission: ParsedJotFormSubmission, appendNote?: string): string {
    const lines = [
      `Form: ${submission.formTitle}`,
      `Submission ID: ${submission.submissionId}`,
      `Submitted At: ${submission.submittedAt.toISOString()}`,
      `IP: ${submission.submitterIp}`,
      '',
      'All submitted fields:',
    ];
    for (const [key, val] of Object.entries(submission.fields)) {
      if (/^q\d+_/i.test(key)) continue;
      if (isSkippable(key)) continue;
      const s = jotformService.fieldToString(val);
      if (s) lines.push(`  ${key}: ${s}`);
    }
    if (appendNote) lines.push('', appendNote);
    return lines.join('\n');
  }
}

/**
 * Converts a camelCase or snake_case field name into a readable label.
 * e.g. "requestCategory" → "Request Category"
 *      "qmc_location"    → "Qmc Location"
 */
function toHumanLabel(bare: string): string {
  return bare
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

export const mappingService = new MappingService();