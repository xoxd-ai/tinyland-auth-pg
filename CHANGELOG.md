# Changelog

All notable changes to `@tummycrypt/tinyland-auth-pg` will be documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this package uses pre-1.0 semver where **breaking changes bump the minor**.

## [0.3.0] - 2026-09-25

### Added

- The `billing` schema (`src/billing-schema.ts`, exported as `billingSchema`
  and `./billing-schema`): `billing.owner_accounts`, `billing.tenants` and
  `billing.tenant_members`, the billing entity of the platform payments
  architecture (T6, TIN-4603; rulings PY4, PY2a, AD4, AD5). A tenant is a
  paying client keyed 1:1 to a Stripe customer inside one owner account, or
  the owner account's own rollup tenant; members are an email and one of
  `client_viewer`, `client_admin`, `operator`.
- `drizzle/0001_billing_entity.sql`: the schema, its check constraints, and
  row-level security enabled and forced on all three tables, deny by default,
  keyed on `app.tenant_id` and `app.member_email` (see the README).
- `src/__tests__/billing-rls.test.ts`: the migrations applied to a scratch
  Postgres 16, the constraints, and a second tenant's rows invisible.

### Fixed

- `flake.nix`: the dev shell's `(pnpm_10 or pnpm)` was not valid Nix outside an
  attribute selection; it now reads `(pkgs.pnpm_10 or pkgs.pnpm)`.

### Consumers

- The tables are a projection of the finances CSVs; the only writer is
  `reconcile tenants-publish` (tinyland-billing-infra). A consuming app grants
  its runtime role SELECT only and its publisher role write, in its own
  migration, with its own role names.

## [0.2.4] - 2026-04-28

### Added

- `bootstrapUsers({ storage | pool | connectionString, tenantId, users, passwordHasher? })`
  as an idempotent tenant-scoped bootstrap helper for apps that seed admin
  users during deploy/startup.
- `./bootstrap-users` package export and root export for the helper and its
  public types.

### Fixed

- Keep the bootstrap flow on the shared adapter boundary instead of requiring
  consumers to duplicate raw SQL upsert logic.

## [0.2.3] - 2026-04-28

### Fixed

- Broaden the `@tummycrypt/tinyland-auth` peer range to allow `0.3.x`
  consumers while continuing to allow existing `0.2.x` consumers.
- Validate the package against `@tummycrypt/tinyland-auth@0.3.0`.

## [0.2.2] - 2026-04-27

### Fixed

- Use a package-scoped Bazel npm repository name so this module composes with
  sibling Bzlmod modules without exporting a generic `@npm` repo.

## [0.2.1] - 2026-04-22

### Added

- `createNodePgStorageAdapter({ connectionString, poolConfig? })`: a first-class
  node-postgres factory for self-hosted PostgreSQL, CNPG, and local development.
- `NodePgStorageAdapter` export, which owns a `pg.Pool` and closes it by default
  when `adapter.close()` is called.
- `NodePgStorageConfig` export for the new factory.
- `src/__tests__/node-pg.test.ts`: end-to-end smoke coverage of the owned
  node-postgres path against Postgres 16 via testcontainers.

### Fixed

- The package no longer forces self-hosted consumers to construct their own
  drizzle node-postgres client just to avoid the legacy neon-only
  `connectionString` path.
- `Database` now includes the node-postgres drizzle database type, so the
  driver-injection API matches the runtime support already described by v0.2.0.

## [0.2.0] - 2026-04-17

### Breaking Changes

- **Pattern B tenant isolation**: every `PgStorageAdapter` method signature now
  takes `tenantId: string` as its **first parameter**. Example:
  `adapter.getUser(id)` → `adapter.getUser(tenantId, id)`. Applies to every
  read, write, update, and delete: no exceptions.
- **Schema uplift**: every row-bearing table now carries `tenant_id uuid NOT NULL`.
  Previous single-column unique constraints on `handle`, `email`, `token`,
  `code`, `acuity_id`, etc. are now **composite unique indexes** scoped to
  `(tenant_id, <col>)`. Composite PKs for `totp_secrets` and `backup_codes`.
- **Return types widened** with `TenantScoped<T>`: every returned row now
  exposes its `tenantId`. Callers that destructured tight `AdminUser` /
  `Session` shapes will type-check against `TenantScoped<AdminUser>` /
  `TenantScoped<Session>`.
- Existing deployments **must** run the generated migration that (1) adds the
  `tenant_id` columns (initially nullable), (2) backfills a single seed UUID
  for historical rows, and (3) flips the columns to `NOT NULL`. See the
  Migration Guide below.

### Added

- `createPgStorageAdapter({ db })`: driver-agnostic constructor accepting a
  pre-built drizzle client. Works with `drizzle-orm/neon-http`,
  `drizzle-orm/postgres-js`, and `drizzle-orm/node-postgres`. Callers own the
  client lifecycle.
- Exported types:
  - `Database`: the union of supported drizzle client types.
  - `TenantScoped<T>`: widens a domain type with `{ tenantId: string }`.
  - `PgStorageConfig`: the discriminated union accepted by the factory.
- Construction-time validation: both `{ db }` and `{ connectionString }`
  branches throw loudly on nullish input instead of deferring to the first
  query.
- `src/__tests__/postgres-js.test.ts`: end-to-end smoke test via
  `@testcontainers/postgresql` exercising the `{ db }` path against a real
  Postgres 16 with `prepare: false` (PgBouncer-compatible).
- 24 `tenant_idx` indexes: one per row-bearing table: for RLS query
  performance.
- 12 composite unique indexes replacing the former per-column uniques.

### Deprecated

- `createPgStorageAdapter({ connectionString })` still works but is limited
  to `neon-http`. Prefer `{ db }` for all new code: it is the only path that
  supports PgBouncer, node-postgres, and self-hosted Postgres deployments.

### Migration Guide (0.1.x → 0.2.0)

1. **Run the generated migration**: `drizzle/0000_*.sql` and
   `drizzle-public/0000_*.sql` add `tenant_id uuid NOT NULL` and the composite
   uniques. If you have existing data, adapt the migration to:
   ```sql
   ALTER TABLE auth.users ADD COLUMN tenant_id uuid;
   UPDATE auth.users SET tenant_id = '<your-seed-tenant-uuid>';
   ALTER TABLE auth.users ALTER COLUMN tenant_id SET NOT NULL;
   -- ...repeat for every table, then create the composite uniques/indexes
   ```
2. **Update every call site**: add a `tenantId` as the first argument to
   every adapter method. TypeScript will surface these at build time.
3. **Drop `tenantId` from insert payloads**: the adapter now sets `tenant_id`
   from the first argument; do not pass it in the `user`/`session`/... object
   literal.
4. **Widen return-type consumers**: replace `AdminUser` with
   `TenantScoped<AdminUser>` (or leave inference to do it) at any site that
   previously destructured the tight shape.

### Known follow-ups (tracked for 0.3.0)

- Uplift `@tummycrypt/tinyland-auth`'s `IStorageAdapter` interface to natively
  include `tenantId`. The adapter class no longer `implements IStorageAdapter`
  because the 0.2.x peer package has the pre-tenant signatures; this is
  intentional for v0.2.0 and will close when the peer ships.
- Strengthen the `{ db }` DI smoke to also assert on `getInvitation`,
  `logAuditEvent`, and `saveBackupCodes` paths across tenant boundaries.
- Normalize audit-event ids to `randomUUID()` (currently timestamp + 36-bit
  random; low collision risk but inconsistent with other PKs).

## [0.1.1] - 2026-04-06

- First published release on `@tummycrypt` scope.
- `PgStorageAdapter` constructed internally via `neon-http` from a
  `connectionString`. Single-tenant schema; no `tenant_id` columns.
