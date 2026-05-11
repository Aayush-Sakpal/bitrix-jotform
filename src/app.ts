import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { requestLogger } from './middleware/logger.middleware';
import { errorMiddleware, notFoundHandler } from './middleware/error.middleware';
import routes from './routes';
import { config } from './config';

export function createApp(): express.Application {
    const app = express();

    app.use(helmet());
    app.use(cors({
        origin: config.server.allowedOrigins,
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'x-webhook-secret'],
    }));
    app.set('trust proxy', 1);
    app.use(compression());

    // Jotform sends application/x-www-form-urlencoded
    app.use(express.urlencoded({ extended: true, limit: '10mb'}));
    app.use(express.json({ limit: '10mb' }));

    app.use(requestLogger);
    app.use('/', routes);

    app.use(notFoundHandler);
    app.use(errorMiddleware);

    return app;
}