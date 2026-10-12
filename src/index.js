import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDb, disconnectDb } from './db/connect.js';

async function main() {
  await connectDb();

  const app = createApp();
  const server = app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      // eslint-disable-next-line no-console
      console.error(`[server] Port ${env.port} is already in use.`);
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.error('[server] unexpected error:', err);
    process.exit(1);
  });

  async function shutdown(signal) {
    // eslint-disable-next-line no-console
    console.log(`[server] received ${signal}, shutting down…`);
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[server] failed to start:', err);
  process.exit(1);
});