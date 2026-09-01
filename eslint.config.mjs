// @ts-check
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * One flat config for the whole pnpm workspace.
 *
 * The rule set is deliberately TINY. `pnpm -r typecheck` already passes clean
 * under a strict tsconfig (strict, noUncheckedIndexedAccess,
 * exactOptionalPropertyTypes, noUnusedLocals/Parameters), so the stylistic and
 * "possible error" families ESLint is usually brought in for are either already
 * enforced by the compiler or are taste. What the compiler CANNOT see is a
 * promise nobody waited for — and in a Fastify API plus a long-running worker
 * poll loop, that is the live bug class: a dropped `await` on an audit append or
 * a state transition fails silently, out of order, and off the request that
 * caused it.
 *
 * So this gate enforces exactly two rules, both type-aware, both blocking. A
 * narrow gate that is green is worth more than a broad one that is permanently
 * yellow — a lint step nobody can clear teaches people to skip lint, the same
 * way a red E2E once taught this repo to skip the E2E. Add rules deliberately,
 * one at a time, each with its violations fixed in the same commit.
 *
 * Note `void expr` is the sanctioned escape hatch and is NOT a workaround here:
 * Fastify's `reply` is thenable, so `reply.header(...)` trips
 * no-floating-promises even though there is nothing to await. `void app.register(...)`
 * is likewise deliberate fire-and-forget. Use `void` only where dropping the
 * result is the intent; if the call actually needs to finish first, await it.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.prerender/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/coverage/**',
      // Flutter client — Dart, its own gates (`flutter analyze` + `flutter test`).
      'apps/mobile/**',
    ],
  },
  {
    // Scoped to what the workspace tsconfigs actually include, so every linted
    // file has a real type graph behind it. Loose scripts (scripts/*.mjs, the
    // vitest/playwright configs) are outside any tsconfig and stay unlinted
    // rather than being force-fitted into one.
    files: ['apps/*/src/**/*.{ts,tsx}', 'apps/web/tests/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        // Resolves each file against its own package's tsconfig — the workspace
        // has 17 of them and no root project that spans all.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },

  // apps/web is the one workspace with violations today: 25 of them, and NONE is
  // a genuine bug. Audited one by one on 2026-08-09 —
  //   * 9 no-floating-promises: every one is a `navigate(...)` call. react-router
  //     7 (the 6→7 CVE upgrade) changed NavigateFunction to return Promise<void>,
  //     so calls that were correct in v6 now read as floating. SPA navigation is
  //     fire-and-forget by definition; there is nothing to await.
  //   * 14 no-misused-promises: `onClick={async () => …}` / `onSubmit={async …}`
  //     React handlers, whose bodies already try/catch and set error state.
  // Demoted to warn rather than silenced, and deliberately NOT fixed here: the
  // fix is ~23 mechanical `void` insertions across working UI code, which does
  // not belong in the commit that introduces the linter. Follow-up: sweep them,
  // then raise these two back to error for this block and delete it.
  //
  // The server side is a different risk and stays at error above: apps/api,
  // apps/worker and all 15 packages are at ZERO violations, and that is the code
  // where a dropped await silently mis-orders an audit append or a release
  // transition. Do not demote those to match this.
  {
    // Same scope as the typed block above — not a broader `apps/web/**`, which
    // would pull in vite/playwright configs that no tsconfig covers and that the
    // type-aware rules therefore cannot run on.
    files: ['apps/web/src/**/*.{ts,tsx}', 'apps/web/tests/**/*.{ts,tsx}'],
    plugins: { '@typescript-eslint': tseslint.plugin, 'react-hooks': reactHooks },
    rules: {
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      // Registered so the pre-existing `eslint-disable-next-line
      // react-hooks/exhaustive-deps` directives in the test helpers resolve —
      // without the plugin those are hard "rule not found" errors. rules-of-hooks
      // is a correctness rule and is clean, so it blocks; exhaustive-deps is
      // advisory and warns.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
