import winston from 'winston';
import { config } from '../config';

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    let line = `${ts} [${level}]: ${String(message)}`;
    if (Object.keys(meta).length) line += `  ${JSON.stringify(meta)}`;
    if (stack) line += `\n${String(stack)}`;
    return line;
  })
);

const prodFormat = combine(timestamp(), errors({ stack: true }), json());

const transports: winston.transport[] = [new winston.transports.Console()];

if (config.server.nodeEnv === 'production') {
  transports.push(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
    })
  );
}

export const logger = winston.createLogger({
  level: config.logging.level,
  format: config.server.nodeEnv === 'production' ? prodFormat : devFormat,
  defaultMeta: { service: 'jotform-bitrix' },
  transports,
});