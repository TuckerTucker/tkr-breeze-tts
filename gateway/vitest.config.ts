import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // ffmpeg transcodes and cache round-trips touch the filesystem; the
    // default 5s is tight for the reference-intake fixtures.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
