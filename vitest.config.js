import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // bcrypt + mongodb-memory-server startup can exceed the default 5s.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Run tests in a single forked process so mongodb-memory-server
    // and the Mongoose singleton are not duplicated across workers.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});