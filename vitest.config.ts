import { defineConfig } from 'vitest/config';

// issue worktrees live under .claude/worktrees inside the checkout; their tests are theirs
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
