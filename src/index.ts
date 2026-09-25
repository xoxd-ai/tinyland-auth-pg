/**
 * @tummycrypt/tinyland-auth-pg
 *
 * PostgreSQL storage adapter for @tummycrypt/tinyland-auth,
 * backed by Drizzle ORM across Neon, postgres.js, and node-postgres.
 */

export {
  PgStorageAdapter,
  NodePgStorageAdapter,
  createPgStorageAdapter,
  createNodePgStorageAdapter,
} from './adapter.js';
export { bootstrapUsers } from './bootstrap-users.js';
export type {
  PgStorageConfig,
  NodePgStorageConfig,
  Database,
  TenantScoped,
} from './adapter.js';
export type {
  BootstrapPasswordHasher,
  BootstrapUserInput,
  BootstrapUserResult,
  BootstrapUserStorage,
  BootstrapUsersConfig,
  BootstrapUsersResult,
} from './bootstrap-users.js';
export * as schema from './schema.js';
export * as businessSchema from './business-schema.js';
export * as contentSchema from './content-schema.js';
export * as bookingSchema from './booking-schema.js';
export * as giftcertSchema from './giftcert-schema.js';
export * as intakeSchema from './intake-schema.js';
export * as billingSchema from './billing-schema.js';
