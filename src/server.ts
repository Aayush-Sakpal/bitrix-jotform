import http from 'http';
import { createApp } from './app';
import { config } from './config';
import { logger } from './utils/logger';
import { bitrixRegistry } from './services/bitrix.service';

async function main(): Promise<void> {
  const app    = createApp();
  const server = http.createServer(app);

  // Pre-load all Bitrix24 field lists so the first webhook is instant
  // (instead of having to fetch field lists on the very first submission)
  logger.info('Initialising Bitrix24 field registries...');
  await bitrixRegistry.initAllRegistries();
  logger.info('All field registries ready');

  server.listen(config.server.port, () => {
    logger.info('Server started', {
      port:    config.server.port,
      env:     config.server.nodeEnv,
      webhook: `http://localhost:${config.server.port}/webhook/jotform?token=<secret>`,
      health:  `http://localhost:${config.server.port}/health`,
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} — shutting down`);
    server.close(() => { logger.info('Done'); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
  process.on('uncaughtException',  (err)    => { logger.error('Uncaught', { error: err.message }); process.exit(1); });
  process.on('unhandledRejection', (reason) => { logger.error('Unhandled', { reason: String(reason) }); process.exit(1); });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });