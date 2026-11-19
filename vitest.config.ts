import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Generous: the suite also runs on shared CI machines several times slower than a developer's, and its heaviest
    // tests write 20 000 documents or start the program a dozen times.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
