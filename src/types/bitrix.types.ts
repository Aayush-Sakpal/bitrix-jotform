export type BitrixEntity = 'lead' | 'contact' | 'deal' | 'company';

export interface BitrixMultiField {
    VALUE: string;
    VALUE_TYPE: 'WORK' | 'HOME' | 'MOBILE' | 'FAX' | 'PAGER' | 'OTHER';
}

export interface BitrixLeadFields {
    TITLE?: string;
    NAME?: string;
    LAST_NAME?: string;
    SECOND_NAME?: string;
    COMPANY_TITLE?: string;
    SOURCE_ID?: string;
    SOURCE_DESCRIPTION?: string;
    STATUS_ID?: string;
    STATUS_DESCRIPTION?: string;
    EMAIL?: BitrixMultiField[];
    PHONE?: BitrixMultiField[];
    WEB?: BitrixMultiField[];
    COMMENTS?: string;
    CURRENCY_ID?: string;
    OPPORTUNITY?: number;
    ADDRESS?: string;
    ADDRESS_2?: string;
    ADDRESS_CITY?: string;
    ADDRESS_POSTAL_CODE?: string;
    ADDRESS_REGION?: string;
    ADDRESS_COUNTRY?: string;
    [key: string]: unknown;
}

export interface BitrixContactFields {
    NAME?: string;
    LAST_NAME?: string;
    SECOND_NAME?: string;
    SOURCE_ID?: string;
    EMAIL?: BitrixMultiField[];
    PHONE?: BitrixMultiField[];
    COMMENTS?: string;
    ADDRESS?: string;
    ADDRESS_CITY?: string;
    ADDRESS_POSTAL_CODE?: string;
    ADDRESS_REGION?: string;
    ADDRESS_COUNTRY?: string;
    [key: string]: unknown;
}

export interface BitrixDealFields {
    TITLE?: string;
    CONTACT_ID?: string;
    COMOANY_ID?: string;
    SOURCE_ID?: string;
    STAGE_ID?: string;
    CURRENCY_ID?: string;
    OPPORTUNITY?: string;
    ASSIGNED_BY_ID?: string;
    COMMENTS?: string;
    [key: string]: unknown;
}

export type BitrixEntityFields = 
    | BitrixLeadFields
    | BitrixContactFields
    | BitrixDealFields;

export interface BitrixApiResponse<T = unknown> {
    result?: T;
    error?: string;
    error_description?: string;
}