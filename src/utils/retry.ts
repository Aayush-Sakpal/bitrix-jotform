import { logger } from './logger';

export interface RetryOptions {
    maxAttempts: number;
    delayMs: number;
    backoffMultiplier?: number;
    maxDelayMs?: number;
    retryOn?: (error: unknown) => boolean;
}

export async function withRetry<T>(
    fn: () => Promise<T>,
    options: RetryOptions,
    label = 'operation'
): Promise<T> {
    const {
        maxAttempts,
        delayMs,
        backoffMultiplier = 2,
        maxDelayMs = 60_000,
        retryOn = () => true,
    } = options;

    let lastError: unknown;

    for(let attempt = 1; attempt <= maxAttempts; attempt++){
        try {
            return await fn();
        }
        catch(err) {
            lastError = err;

            if(!retryOn(err)) {
                logger.warn(`[${label}] Non-retryable error on attempt ${attempt} — stopping`, {
                    error: err instanceof Error ? err.message : String(err),
                });
                throw err;
            }

            if(attempt === maxAttempts) break;

            const wait = Math.min(delayMs * Math.pow(backoffMultiplier, attempt - 1), maxDelayMs);
            logger.warn(`[${label}] Attempt ${attempt}/${maxAttempts} failed — retrying in ${wait}ms`, {
                error: err instanceof Error ? err.message : String(err),
            });
            await new Promise(r => setTimeout(r, wait));
        }
    }

    logger.error(`[${label}] All ${maxAttempts} attempts exhausted`);
    throw lastError;
}

export function isRetryableHttpError(err: unknown): boolean {
    if (err && typeof(err) === 'object') {
        const e = err as {response?: {status?: number}};

        if(!e.response) return true;

        const status = e.response.status ?? 0;
         return [429, 500, 502, 503, 504].includes(status);
    }
    return true;
}