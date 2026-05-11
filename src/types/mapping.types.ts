import type { BitrixEntity, BitrixMultiField } from './bitrix.types';

export type FieldTransform =
  | 'none' | 'trim' | 'uppercase' | 'lowercase'
  | 'nameToTitle' | 'joinName' | 'firstName' | 'lastName'
  | 'joinAddress' | 'toFloat' | 'toInt';

export type BitrixFieldType =
  | 'string' | 'email' | 'phone' | 'web' | 'float' | 'integer' | 'multiline';

export interface FieldMapping {
  jotformField: string;
  bitrixField:  string;
  fieldType?:   BitrixFieldType;
  transform?:   FieldTransform;
  valueType?:   BitrixMultiField['VALUE_TYPE'];
  required?:    boolean;
}

export interface RoutingConfig {
  /**
   * The JotForm field name whose VALUE decides the department.
   * Use the bare name — e.g. "requestCategory" or "q11_requestCategory".
   * Both work — the server tries both automatically.
   */
  field: string;

  /**
   * Maps exact field values (case-insensitive) to department keys.
   * Department keys must match BITRIX_DEPARTMENTS in .env.
   */
  rules: Record<string, string>;

  /**
   * Department to use when no rule matches.
   * If omitted and nothing matches, the submission is dropped and logged.
   */
  default?: string;
}

export interface FormMappingConfig {
  bitrixEntity:        BitrixEntity;
  fieldMappings:       FieldMapping[];
  defaults?:           Record<string, unknown>;
  routing?:            RoutingConfig;
  secondaryEntity?: {
    bitrixEntity:  BitrixEntity;
    fieldMappings: FieldMapping[];
    defaults?:     Record<string, unknown>;
  };
  skipDuplicateCheck?: boolean;
  appendNote?:         string;
}

export interface MappingConfig {
  /**
   * Set to true to enable fully automatic field mapping for ALL forms.
   *
   * When true:
   *  - No per-form entries in "forms" are needed
   *  - Every JotForm field is automatically mapped to a Bitrix24 custom field
   *  - Custom fields are auto-created in Bitrix24 if they don't exist
   *  - Routing is driven by "globalRouting" below
   *
   * When false (default):
   *  - Only forms listed in "forms" are processed
   *  - Each form needs explicit fieldMappings
   */
  autoMap?: boolean;

  /**
   * Organisation-wide routing config.
   * Used in autoMap mode for ALL forms.
   * Can also be overridden per-form inside each form's "routing" block.
   *
   * This means you define routing ONCE for the whole organisation.
   * Every new form automatically uses it — no config change needed.
   */
  globalRouting?: RoutingConfig;

  globalDefaults?: {
    lead?:    Record<string, unknown>;
    contact?: Record<string, unknown>;
    deal?:    Record<string, unknown>;
    company?: Record<string, unknown>;
  };

  /**
   * Per-form overrides. Optional when autoMap is true.
   * Add a form here ONLY if it needs different behaviour from the default.
   */
  forms: Record<string, FormMappingConfig>;

  defaultForm?: FormMappingConfig;
}