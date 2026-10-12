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

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
    }),
  );

  // Larger body limit than Phase 2 to allow batched offline point uploads.
  app.use(express.json({ limit: '256kb' }));
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
  app.use('/api/auth', authRoutes);        // login / me / refresh / logout
  app.use('/api/tracking', trackingRoutes); // employee-facing session + point APIs
  app.use('/api/admin', adminRoutes);      // owner-only employees + admin tracking

  // JSON 404 for unknown routes.
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  // Central error handler (must be last).
  app.use(errorHandler);

  return app;
}