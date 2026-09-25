/**
 * Billing entity (the `billing` schema): owner accounts, tenants, tenant
 * members.
 *
 * Ticket T6 (TIN-4603) of the ratified platform payments architecture
 * (finances docs/agent-notes/2026-09-24-platform-payments-architecture.md,
 * section 4.1). Rulings: PY4 (a billing tenant keyed 1:1 to a Stripe customer,
 * carrying its owner account), PY2a (two owner Stripe accounts, each its own
 * merchant of record; a tenant is a paying client inside one), AD4 (the owner
 * row), AD5 (membership drives the Access list), TIN-2522 (the finances CSVs
 * stay the source; these tables are a projection).
 *
 * Every row carries `source` and `published_at`, like the portal's own
 * projection tables. The only writer is `reconcile tenants-publish`
 * (tinyland-billing-infra); an app role is granted SELECT only by the
 * consuming app's own migration.
 *
 * Row-level security, deny by default. Two session settings, both set with
 * `set_config(..., true)` inside the request's transaction:
 *
 * - `app.tenant_id`: the tenant the request is scoped to (the same GUC the
 *   auth tables and the portal's projection tables use).
 * - `app.member_email`: the verified Access email, set before a tenant is
 *   chosen, so the unified host can resolve a path slug and list the tenants
 *   an email belongs to (the tenant picker).
 *
 * A session sees a tenant row when it is the scoped tenant or one the email
 * belongs to; a membership row when it belongs to the scoped tenant or to the
 * email; an owner account row when a tenant it sees belongs to it. With
 * neither setting, every table reads empty. Writes are confined to the scoped
 * tenant (owner accounts excepted, since they precede their tenants); the
 * grants decide who may write at all.
 */

import { sql } from 'drizzle-orm';
import {
  pgSchema,
  text,
  uuid,
  timestamp,
  primaryKey,
  unique,
  index,
  check,
  pgPolicy,
} from 'drizzle-orm/pg-core';

export const billingSchema = pgSchema('billing');

/** The two Stripe modes an owner account can be recorded in. */
export const STRIPE_MODES = ['live', 'test'] as const;
export type StripeMode = (typeof STRIPE_MODES)[number];

/** A tenant is a paying client, or the owner account's own rollup tenant. */
export const TENANT_KINDS = ['client', 'owner'] as const;
export type TenantKind = (typeof TENANT_KINDS)[number];

/** The three client-facing roles (architecture section 4.4). */
export const BILLING_ROLES = ['client_viewer', 'client_admin', 'operator'] as const;
export type BillingRole = (typeof BILLING_ROLES)[number];

/** The session settings the policies read. */
export const BILLING_TENANT_SETTING = 'app.tenant_id';
export const BILLING_MEMBER_EMAIL_SETTING = 'app.member_email';

const scopedTenant = sql`nullif(current_setting('app.tenant_id', true), '')::uuid`;
const memberEmail = sql`lower(nullif(current_setting('app.member_email', true), ''))`;

// ---------------------------------------------------------------------------
// Owner accounts (one per Stripe account and merchant of record)
// ---------------------------------------------------------------------------

export const ownerAccounts = billingSchema.table(
  'owner_accounts',
  {
    /** The finances CSV `owner_account_id`, for example `xoxd-ai`. */
    id: text('id').primaryKey(),
    entitySlug: text('entity_slug').notNull(),
    displayName: text('display_name').notNull(),
    stripeAccountId: text('stripe_account_id').unique(),
    stripeMode: text('stripe_mode').notNull(),
    status: text('status').notNull(),
    source: text('source').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [
    check('owner_accounts_stripe_mode_check', sql`${t.stripeMode} in ('live', 'test')`),
    pgPolicy('owner_accounts_read', {
      for: 'select',
      using: sql`${t.id} in (select owner_account_id from billing.tenants)`,
    }),
    pgPolicy('owner_accounts_insert', { for: 'insert', withCheck: sql`true` }),
    pgPolicy('owner_accounts_update', { for: 'update', using: sql`true`, withCheck: sql`true` }),
    pgPolicy('owner_accounts_delete', { for: 'delete', using: sql`true` }),
  ],
);

// ---------------------------------------------------------------------------
// Tenants (a paying client keyed 1:1 to a Stripe customer, or an owner rollup)
// ---------------------------------------------------------------------------

export const tenants = billingSchema.table(
  'tenants',
  {
    /** The RLS tenant UUID the portal pins; set by the publisher, never generated. */
    id: uuid('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    kind: text('kind').notNull(),
    ownerAccountId: text('owner_account_id')
      .notNull()
      .references(() => ownerAccounts.id),
    clientId: text('client_id'),
    stripeCustomerId: text('stripe_customer_id').unique(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull(),
    source: text('source').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [
    unique('tenants_owner_account_stripe_customer_unique').on(t.ownerAccountId, t.stripeCustomerId),
    index('tenants_owner_account_idx').on(t.ownerAccountId),
    check('tenants_kind_check', sql`${t.kind} in ('client', 'owner')`),
    pgPolicy('tenants_read', {
      for: 'select',
      using: sql`${t.id} = ${scopedTenant} or ${t.id} in (select tenant_id from billing.tenant_members where email = ${memberEmail})`,
    }),
    pgPolicy('tenants_insert', { for: 'insert', withCheck: sql`${t.id} = ${scopedTenant}` }),
    pgPolicy('tenants_update', {
      for: 'update',
      using: sql`${t.id} = ${scopedTenant}`,
      withCheck: sql`${t.id} = ${scopedTenant}`,
    }),
    pgPolicy('tenants_delete', { for: 'delete', using: sql`${t.id} = ${scopedTenant}` }),
  ],
);

// ---------------------------------------------------------------------------
// Tenant members (an email and a role; the Access list is generated from these)
// ---------------------------------------------------------------------------

export const tenantMembers = billingSchema.table(
  'tenant_members',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Stored lowercased; the check refuses anything else. */
    email: text('email').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull(),
    source: text('source').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.email] }),
    index('tenant_members_email_idx').on(t.email),
    check('tenant_members_email_lowercase_check', sql`${t.email} = lower(${t.email})`),
    check('tenant_members_role_check', sql`${t.role} in ('client_viewer', 'client_admin', 'operator')`),
    pgPolicy('tenant_members_read', {
      for: 'select',
      using: sql`${t.tenantId} = ${scopedTenant} or ${t.email} = ${memberEmail}`,
    }),
    pgPolicy('tenant_members_insert', { for: 'insert', withCheck: sql`${t.tenantId} = ${scopedTenant}` }),
    pgPolicy('tenant_members_update', {
      for: 'update',
      using: sql`${t.tenantId} = ${scopedTenant}`,
      withCheck: sql`${t.tenantId} = ${scopedTenant}`,
    }),
    pgPolicy('tenant_members_delete', { for: 'delete', using: sql`${t.tenantId} = ${scopedTenant}` }),
  ],
);

export type OwnerAccount = typeof ownerAccounts.$inferSelect;
export type NewOwnerAccount = typeof ownerAccounts.$inferInsert;
export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type TenantMember = typeof tenantMembers.$inferSelect;
export type NewTenantMember = typeof tenantMembers.$inferInsert;
