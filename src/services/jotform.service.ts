import type {
  JotFormRawRequest, JotFormFieldValue,
  JotFormNameField, JotFormAddressField, ParsedJotFormSubmission,
} from '../types/jotform.types';
import { logger } from '../utils/logger';

export class JotFormService {
  parseWebhookPayload(body: Record<string, string | string[]>): ParsedJotFormSubmission {
    // Flatten arrays to comma-separated strings for metadata
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) {
      flat[k] = Array.isArray(v) ? v.join(', ') : v;
    }

    const formId       = flat['formID'];
    const submissionId = flat['submissionID'];

    if (!formId || !submissionId) {
      throw new Error('Invalid JotForm webhook: missing formID or submissionID.');
    }

    let fields: Record<string, JotFormFieldValue> = {};
    const rawRequestStr = flat['rawRequest'];

    if (rawRequestStr) {
      try {
        fields = this.extractFromRaw(JSON.parse(rawRequestStr) as JotFormRawRequest);
      } catch (err) {
        logger.warn('rawRequest JSON parse failed — using flat fields', {
          submissionId,
          error: err instanceof Error ? err.message : String(err),
        });
        fields = this.extractFromFlat(flat);
      }
    } else {
      fields = this.extractFromFlat(flat);
    }

    return {
      formId,
      submissionId,
      formTitle:   flat['formTitle'] ?? 'Unknown Form',
      submitterIp: flat['ip'] ?? '',
      submittedAt: new Date(),
      fields,
      rawFields:   flat,
    };
  }

  private extractFromRaw(raw: JotFormRawRequest): Record<string, JotFormFieldValue> {
    const out: Record<string, JotFormFieldValue> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || value === undefined || value === '') continue;
      if (Array.isArray(value) && value.length === 0) continue;
      out[key] = value;
      // Also store without the q{N}_ prefix for easy lookup
      const bare = key.replace(/^q\d+_/i, '');
      if (bare !== key) out[bare] = value;
    }
    return out;
  }

  private extractFromFlat(flat: Record<string, string>): Record<string, JotFormFieldValue> {
    const out: Record<string, JotFormFieldValue> = {};
    for (const [key, value] of Object.entries(flat)) {
      if (!/^q\d+_/i.test(key) || !value) continue;
      out[key] = value;
      out[key.replace(/^q\d+_/i, '')] = value;
    }
    return out;
  }

  fieldToString(value: JotFormFieldValue): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) return value.filter(Boolean).join(', ').trim();
    if (this.isNameField(value)) {
      return [value.prefix, value.first, value.middle, value.last, value.suffix]
        .filter(Boolean).join(' ').trim();
    }
    if (this.isAddressField(value)) {
      return [value.addr_line1, value.addr_line2, value.city, value.state, value.postal, value.country]
        .filter(Boolean).join(', ');
    }
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${String(v)}`).join('; ');
  }

  isNameField(v: unknown): v is JotFormNameField {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    return 'first' in (v as object) || 'last' in (v as object) || 'prefix' in (v as object);
  }

  isAddressField(v: unknown): v is JotFormAddressField {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    return 'addr_line1' in (v as object) || 'city' in (v as object) || 'postal' in (v as object);
  }
}

export const jotformService = new JotFormService();