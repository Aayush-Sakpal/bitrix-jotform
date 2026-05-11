export interface JotFormRawRequest {
    [questionName: string]: JotFormFieldValue;
}

export type JotFormFieldValue =
    | string
    | string[]
    | JotFormNameField
    | JotFormAddressField
    | JotFormMatrixField
    | null
    | undefined;

export interface JotFormNameField {
    first?: string;
    last?: string;
    middle?: string;
    prefix?: string;
    suffix?: string;
}

export interface JotFormAddressField {
    addr_line1?: string;
    addr_line2?: string;
    city?: string;
    state?: string;
    postal?: string;
    country?: string;
}

export interface JotFormMatrixField {
    [row: string]: string;
}

export interface ParsedJotFormSubmission {
    formId: string;
    submissionId: string;
    formTitle: string;
    submitterIp: string;
    submittedAt: Date;
    fields: Record<string, JotFormFieldValue>;
    rawFields: Record<string, string>;
}