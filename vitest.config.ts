import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    // lets tests/agent-shape.test.ts ask V8 whether agents keep fast, shared object shapes
    execArgv: ['--allow-natives-syntax'],
  },
});
