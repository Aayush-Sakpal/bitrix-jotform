import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export interface BitrixDepartmentConfig {
  domain:       string;
  userId:       string;
  webhookToken: string;
  baseUrl:      string;
}

interface Config {
  server: {
    port:           number;
    nodeEnv:        string;
    webhookSecret:  string;
    allowedOrigins: string[];
  };
  bitrix: {
    departments:        Record<string, BitrixDepartmentConfig>;
    rateLimitPerSecond: number;
  };
  retry: {
    maxRetries:   number;
    retryDelayMs: number;
  };
  logging: {
    level: string;
  };
  mapping: {
    configPath: string;
  };
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(
      `[Config] Missing required environment variable: "${key}"\n` +
      `Copy .env.example to .env and fill in the value.`
    );
  }
  return value.trim();
}

function optionalEnv(key: string, fallback: string): string {
  return (process.env[key] ?? fallback).trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// OPTION A — ACTIVE
// Each department has its OWN separate Bitrix24 portal (different domains).
//
// Required .env variables:
//   BITRIX_DEPARTMENTS=FACILITIES,BIOMEDICAL,ADMIN
//   BITRIX_FACILITIES_DOMAIN=facilities.bitrix24.com
//   BITRIX_FACILITIES_USER_ID=1
//   BITRIX_FACILITIES_TOKEN=abc123
//   BITRIX_BIOMEDICAL_DOMAIN=biomedical.bitrix24.com
//   ... and so on for each department
// ─────────────────────────────────────────────────────────────────────────────
function loadDepartments(): Record<string, BitrixDepartmentConfig> {
  const raw  = requireEnv('BITRIX_DEPARTMENTS');
  const keys = raw.split(',').map(k => k.trim().toUpperCase()).filter(Boolean);

  if (keys.length === 0) {
    throw new Error('[Config] BITRIX_DEPARTMENTS is empty. Add at least one department key.');
  }

  const departments: Record<string, BitrixDepartmentConfig> = {};

  for (const key of keys) {
    const domain = requireEnv(`BITRIX_${key}_DOMAIN`);
    const userId = requireEnv(`BITRIX_${key}_USER_ID`);
    const token  = requireEnv(`BITRIX_${key}_TOKEN`);

    departments[key] = {
      domain,
      userId,
      webhookToken: token,
      baseUrl:      `https://${domain}/rest/${userId}/${token}`,
    };
  }

  return departments;
}

// ─────────────────────────────────────────────────────────────────────────────
// OPTION B — COMMENTED OUT
// ALL departments share ONE single Bitrix24 portal (same domain).
// All submissions go to the same Bitrix24 — routing only determines
// which assigned user / pipeline / category they get tagged with.
//
// To switch to this option:
//   1. Comment out the loadDepartments() function above
//   2. Comment out Option A in the config object below
//   3. Uncomment the loadSingleDomainDepartments() function below
//   4. Uncomment Option B in the config object below
//   5. Update your .env to use the single-domain variables
//
// Required .env variables for Option B:
//   BITRIX_DOMAIN=mycompany.bitrix24.com
//   BITRIX_USER_ID=1
//   BITRIX_TOKEN=abc123
//   BITRIX_DEPARTMENTS=FACILITIES,BIOMEDICAL,ADMIN
//   (all departments share the same domain/user/token above)
// ─────────────────────────────────────────────────────────────────────────────
// function loadSingleDomainDepartments(): Record<string, BitrixDepartmentConfig> {
//   const domain = requireEnv('BITRIX_DOMAIN');
//   const userId = requireEnv('BITRIX_USER_ID');
//   const token  = requireEnv('BITRIX_TOKEN');
//   const raw    = requireEnv('BITRIX_DEPARTMENTS');
//   const keys   = raw.split(',').map(k => k.trim().toUpperCase()).filter(Boolean);
//
//   if (keys.length === 0) {
//     throw new Error('[Config] BITRIX_DEPARTMENTS is empty. Add at least one department key.');
//   }
//
//   const baseUrl     = `https://${domain}/rest/${userId}/${token}`;
//   const departments: Record<string, BitrixDepartmentConfig> = {};
//
//   // Every department key points to the exact same portal.
//   // The key is still used for routing logic and logging —
//   // so the rest of the code works identically in both options.
//   for (const key of keys) {
//     departments[key] = { domain, userId, webhookToken: token, baseUrl };
//   }
//
//   return departments;
// }

export const config: Config = {
  server: {
    port:           parseInt(optionalEnv('PORT', '3000'), 10),
    nodeEnv:        optionalEnv('NODE_ENV', 'development'),
    webhookSecret:  requireEnv('WEBHOOK_SECRET'),
    allowedOrigins: optionalEnv('ALLOWED_ORIGINS', '*').split(',').map(s => s.trim()),
  },
  bitrix: {
    // ── OPTION A active — separate domain per department ──────────────────
    departments: loadDepartments(),

    // ── OPTION B commented out — single shared domain ─────────────────────
    // departments: loadSingleDomainDepartments(),

    rateLimitPerSecond: parseInt(optionalEnv('BITRIX_RATE_LIMIT_PER_SECOND', '2'), 10),
  },
  retry: {
    maxRetries:   parseInt(optionalEnv('MAX_RETRIES', '5'), 10),
    retryDelayMs: parseInt(optionalEnv('RETRY_DELAY_MS', '3000'), 10),
  },
  logging: {
    level: optionalEnv('LOG_LEVEL', 'info'),
  },
  mapping: {
    configPath: optionalEnv(
      'MAPPING_CONFIG_PATH',
      path.join(process.cwd(), 'config', 'mapping.config.json')
    ),
  },
};