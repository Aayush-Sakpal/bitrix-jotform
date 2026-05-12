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
import { toBitrixFieldName } from './field.registry';
import type { BitrixClient } from './bitrix.service';

// ─────────────────────────────────────────────────────────────────────────────
// FIELD DETECTION RULES
// Case-insensitive substring matching against the bare field name.
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_PATTERNS = ['email', 'mail', 'e-mail'];
const PHONE_PATTERNS = ['phone', 'mobile', 'cell', 'tel'];

const TITLE_PATTERNS = [
  'name', 'fullname', 'location', 'company',
  'title', 'organisation', 'organization',
];

// Internal JotForm metadata — never map these to Bitrix24
const SKIP_FIELDS = new Set([
  'formid', 'submissionid', 'formtitle', 'ip', 'rawrequest', 'pretty',
  'submitsource', 'submitdate', 'builddate', 'uploadserverurl',
  'eventobserver', 'simple_spc', 'event_id', 'timetosubmit',
  'temp_upload_folder', 'validatednewrequiredfieldids',
  'jsexecutiontracker', 'website', 'file',
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

  // ── Config management ─────────────────────────────────────────────────────

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

  getRoutingConfig(): MappingConfig['globalRouting'] {
    return this.cfg.globalRouting ?? undefined;
  }

  getGlobalDefaults(): NonNullable<MappingConfig['globalDefaults']> {
    return this.cfg.globalDefaults ?? {};
  }

  // ── Explicit mapping ──────────────────────────────────────────────────────

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

  // ── Auto-mapping ──────────────────────────────────────────────────────────

  /**
   * Automatically maps ALL fields from a JotForm submission to Bitrix24
   * without any explicit configuration.
   *
   * Rules:
   *  1. Skip internal JotForm metadata fields
   *  2. Email fields   → Bitrix24 built-in EMAIL (multi-value)
   *  3. Phone fields   → Bitrix24 built-in PHONE (multi-value)
   *  4. Everything else → UF_CRM_{FIELD_NAME} (auto-created if missing)
   *  5. Best available field used for TITLE
   *  6. All custom fields confirmed/created before sending Deal
   */
  async autoMapSubmission(
    submission: ParsedJotFormSubmission,
    client: BitrixClient,
    defaults: Record<string, unknown> = {}
  ): Promise<BitrixEntityFields> {
    const result: Record<string, unknown> = { ...defaults };
    const multi: Record<string, BitrixMultiField[]> = {};
    const fieldEnsurePromises: Promise<void>[] = [];

    let titleCandidate = '';

    for (const [rawKey, value] of Object.entries(submission.fields)) {
      // Skip bare keys when a prefixed version (q{N}_key) already exists.
      // Both are stored by jotformService — process only the prefixed one.
      if (!/^q\d+_/i.test(rawKey)) {
        const prefixedExists = Object.keys(submission.fields).some(
          k =>
            /^q\d+_/i.test(k) &&
            k.replace(/^q\d+_/i, '').toLowerCase() === rawKey.toLowerCase()
        );
        if (prefixedExists) continue;
      }

      // Skip empty values
      const strValue = jotformService.fieldToString(value);
      if (!strValue || strValue.trim() === '') continue;

      const bare = rawKey.replace(/^q\d+_/i, '');

      // Skip internal metadata
      if (isSkippable(bare) || isSkippable(rawKey)) continue;

      // ── Email → built-in EMAIL multi-value field only ─────────────────
      // We do NOT create a separate UF_CRM_ field for email/phone because
      // the built-in EMAIL/PHONE fields are the correct Bitrix24 home for them.
      if (matchesAny(bare, EMAIL_PATTERNS)) {
        if (!multi['EMAIL']) multi['EMAIL'] = [];
        multi['EMAIL'].push({ VALUE: strValue.trim(), VALUE_TYPE: 'WORK' });
        continue;
      }

      // ── Phone → built-in PHONE multi-value field only ─────────────────
      if (matchesAny(bare, PHONE_PATTERNS)) {
        if (!multi['PHONE']) multi['PHONE'] = [];
        multi['PHONE'].push({ VALUE: strValue.trim(), VALUE_TYPE: 'WORK' });
        continue;
      }

      // ── Title candidate ───────────────────────────────────────────────
      if (!titleCandidate && matchesAny(bare, TITLE_PATTERNS)) {
        titleCandidate = strValue.trim();
      }

      // ── Everything else → custom field ────────────────────────────────
      const bitrixField = toBitrixFieldName(rawKey);
      const label       = toHumanLabel(bare);

      fieldEnsurePromises.push(client.fieldRegistry.ensureField(bitrixField, label));
      result[bitrixField] = strValue.trim();
    }

    // Wait for all field checks/creations before sending to Bitrix24
    // (Bitrix24 rejects any field it does not know about)
    await Promise.all(fieldEnsurePromises);

    // Merge multi-value fields
    for (const [k, v] of Object.entries(multi)) result[k] = v;

    // Build TITLE
    if (!result['TITLE']) {
      if (titleCandidate) {
        result['TITLE'] = `Request from ${titleCandidate}`;
      } else if (submission.formTitle && submission.formTitle !== 'Unknown Form') {
        result['TITLE'] = `${submission.formTitle} — ${submission.submissionId}`;
      } else {
        result['TITLE'] = `Service Request — ${submission.submissionId}`;
      }
    }

    // Build COMMENTS with full submission data
    if (!result['COMMENTS']) {
      result['COMMENTS'] = this.buildNote(submission);
    }

    return result as BitrixEntityFields;
  }

  // ── Routing ───────────────────────────────────────────────────────────────

  resolveRoutingDepartment(
    submission: ParsedJotFormSubmission,
    routingConfig: NonNullable<MappingConfig['globalRouting']>,
    requestId: string
  ): string | null {
    const raw = this.resolveField(submission, routingConfig.field);
    const val = raw ? jotformService.fieldToString(raw).trim() : '';

    if (!val) {
      logger.warn('Routing field is empty in submission', {
        requestId,
        field:        routingConfig.field,
        submissionId: submission.submissionId,
      });
    }

    // Case-insensitive match
    const matched = Object.entries(routingConfig.rules).find(
      ([ruleVal]) => ruleVal.toLowerCase() === val.toLowerCase()
    )?.[1];

    if (matched) {
      logger.info('Submission routed to department', {
        requestId,
        field:      routingConfig.field,
        value:      val,
        department: matched,
      });
      return matched.toUpperCase();
    }

    if (routingConfig.default) {
      logger.warn('No routing rule matched — using default department', {
        requestId,
        value:          val,
        default:        routingConfig.default,
        availableRules: Object.keys(routingConfig.rules),
      });
      return routingConfig.default.toUpperCase();
    }

    logger.error('No routing rule matched and no default set — submission dropped', {
      requestId,
      field:          routingConfig.field,
      value:          val,
      availableRules: Object.keys(routingConfig.rules),
    });
    return null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Resolves a JotForm field value from the submission by trying multiple
   * key formats in order. Handles prefixes, casing, and spaces.
   *
   * Try 1: Exact key as provided                  ("requestCategory")
   * Try 2: Bare key without q{N}_ prefix          ("requestCategory" from "q11_requestCategory")
   * Try 3: Case-insensitive bare key match
   * Try 4: Space-collapsed match                  ("Request Category" → "requestcategory")
   * Try 5: Space-to-underscore match              ("Request Category" → "request_category")
   */
  private resolveField(
    submission: ParsedJotFormSubmission,
    key: string
  ): JotFormFieldValue {
    // Try 1 — exact
    if (key in submission.fields) return submission.fields[key] ?? null;

    // Try 2 — strip q{N}_ prefix
    const bare = key.replace(/^q\d+_/i, '');
    if (bare in submission.fields) return submission.fields[bare] ?? null;

    const bareLower = bare.toLowerCase();

    // Try 3 — case-insensitive
    for (const [k, v] of Object.entries(submission.fields)) {
      if (k.replace(/^q\d+_/i, '').toLowerCase() === bareLower) {
        return v ?? null;
      }
    }

    // Try 4 — collapse spaces ("Request Category" → "requestcategory")
    const bareNoSpaces = bareLower.replace(/\s+/g, '');
    for (const [k, v] of Object.entries(submission.fields)) {
      const kNorm = k.replace(/^q\d+_/i, '').toLowerCase().replace(/\s+/g, '');
      if (kNorm === bareNoSpaces) return v ?? null;
    }

    // Try 5 — spaces to underscores ("Request Category" → "request_category")
    const bareUnderscored = bareLower.replace(/\s+/g, '_');
    for (const [k, v] of Object.entries(submission.fields)) {
      const kNorm = k.replace(/^q\d+_/i, '').toLowerCase().replace(/\s+/g, '_');
      if (kNorm === bareUnderscored) return v ?? null;
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
      case 'nameToTitle': return str ? `Deal from ${str}` : null;
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
          return (
            [
              value.addr_line1, value.addr_line2, value.city,
              value.state, value.postal, value.country,
            ]
              .filter(Boolean)
              .join(', ') || null
          );
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
      `Form:          ${submission.formTitle}`,
      `Submission ID: ${submission.submissionId}`,
      `Submitted At:  ${submission.submittedAt.toISOString()}`,
      `IP:            ${submission.submitterIp}`,
      '',
      'Submitted Fields:',
    ];
    for (const [key, val] of Object.entries(submission.fields)) {
      if (/^q\d+_/i.test(key)) continue; // skip prefixed duplicates
      if (isSkippable(key)) continue;
      const s = jotformService.fieldToString(val);
      if (s) lines.push(`  ${key}: ${s}`);
    }
    if (appendNote) lines.push('', appendNote);
    return lines.join('\n');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts a camelCase / snake_case bare field name into a readable label.
 * "requestCategory" → "Request Category"
 * "qmc_location"    → "Qmc Location"
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