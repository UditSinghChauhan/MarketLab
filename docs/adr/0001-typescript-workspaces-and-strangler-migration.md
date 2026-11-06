# ADR 0001 — TypeScript workspaces and a strangler migration

- Status: Accepted
- Date: 2026-11-06

## Context

MarketLab is three JavaScript apps (`backend/`, `dashboard/`, `frontend/`), each
with its own `package.json` and lockfile. The roadmap
([PORTFOLIO-ROADMAP.md](../PORTFOLIO-ROADMAP.md)) replaces the order logic with a
price-time matching engine, moves persistence from MongoDB to PostgreSQL, and
rebuilds both UIs. Doing that as one rewrite would leave the app broken for weeks
and produce a pull request nobody can review.

## Decision

1. **TypeScript, strict mode**, for all new code. `tsconfig.base.json` enables
   `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, so array
   reads and optional fields are checked at compile time.
2. **npm workspaces.** New code lives in `packages/*` (libraries) and, from
   Phase 3, `apps/*` (deployables). The first package is `@marketlab/engine`: pure
   domain logic with no I/O and no timers, testable in isolation.
3. **Strangler migration.** The legacy apps stay outside the workspace, keep their
   own tooling, and keep running and building in CI. Each is deleted only in the
   phase that replaces it (backend in Phase 3, dashboard in Phase 5, landing site
   in Phase 8). Every merge leaves a working app.
4. **One quality gate.** `npm run check` runs typecheck, ESLint
   (`strictTypeChecked`), Prettier and Vitest. CI runs it, the legacy backend
   tests and both legacy builds on every pull request.

## Consequences

- Two toolchains coexist until Phase 8; the ESLint and Prettier configs ignore
  the legacy directories explicitly.
- Contributors run `npm run install:all` to install both.
- The root package is `"type": "module"`, so the one CommonJS utility script is
  named `scripts/serve-build.cjs`.

## Alternatives considered

- **pnpm or Turborepo.** Better caching at scale; not needed for four packages,
  and npm workspaces add no new tool for reviewers to install.
- **Convert the legacy apps in place to TypeScript.** Most of that code is being
  replaced, so typing it would be wasted work.
