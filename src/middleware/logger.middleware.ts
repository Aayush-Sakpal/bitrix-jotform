import morgan from 'morgan';
import { logger } from '../utils/logger';

export const requestLogger = morgan(
  ':remote-addr :method :url :status :response-time ms',
  { stream: { write: (msg: string) => logger.info(msg.trim()) } }
);
