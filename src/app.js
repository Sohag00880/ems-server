import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import trackingRoutes from './routes/tracking.js';
import { errorHandler } from './middleware/error.js';

export function createApp() {
  const app = express();

  // Helmet first — sets security headers.
  app.use(helmet());

  // Dev-only log so we can see what origins are allowed.
  if (env.nodeEnv !== 'production') {
    // eslint-disable-next-line no-console
    console.log('[cors] allowed origins:', env.corsOrigins);
  }

  // CORS — must be before any route handler.
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );

  // Answer preflight requests for all routes.
  app.options('*', cors({ origin: env.corsOrigins, credentials: true }));

  // Body parsing.
  app.use(express.json({ limit: '256kb' }));

  // Cookies for the web refresh-token flow.
  app.use(cookieParser());

  // Health check.
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'ems-server',
      environment: env.nodeEnv,
      timestamp: new Date().toISOString(),
    });
  });

  // Mount route groups.
  app.use('/api/auth', authRoutes);
  app.use('/api/tracking', trackingRoutes);
  app.use('/api/admin', adminRoutes);

  // JSON 404 for unknown routes.
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  // Central error handler (must be last).
  app.use(errorHandler);

  return app;
}