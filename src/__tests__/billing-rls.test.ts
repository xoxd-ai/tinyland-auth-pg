/**
 * The billing entity (T6, TIN-4603; PY4, PY2a, AD5): migrations apply to a
 * scratch Postgres 16, the constraints hold, and row-level security keeps a
 * second tenant's rows invisible.
 *
 * Fixtures are fictitious (the DM1 demo shape): example.com emails, made-up
 * slugs and Stripe ids. SKIPS automatically when no Docker or Podman runtime
 * is discoverable, like the other container tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	BILLING_ROLES,
	STRIPE_MODES,
	TENANT_KINDS,
} from '../billing-schema.js';
import { hasContainerRuntime } from './container-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const drizzleDir = join(__dirname, '../../drizzle');

const OWNER = 'demo-owner';
const OWNER_TENANT = '00000000-0000-4000-8000-000000000001';
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PUBLISHED = '2026-09-25T00:00:00Z';

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql['begin']>[0]>[0];

describe('billing migration text', () => {
	const migration = readFileSync(join(drizzleDir, '0001_billing_entity.sql'), 'utf-8');

	it('checks exactly the exported vocabularies', () => {
		const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
		expect(migration).toContain(`"stripe_mode" in (${list(STRIPE_MODES)})`);
		expect(migration).toContain(`"kind" in (${list(TENANT_KINDS)})`);
		expect(migration).toContain(`"role" in (${list(BILLING_ROLES)})`);
	});

	it('enables and forces row-level security on all three tables', () => {
		for (const table of ['owner_accounts', 'tenants', 'tenant_members']) {
			expect(migration).toContain(`ALTER TABLE "billing"."${table}" ENABLE ROW LEVEL SECURITY`);
			expect(migration).toContain(`ALTER TABLE "billing"."${table}" FORCE ROW LEVEL SECURITY`);
		}
	});
});

describe.skipIf(!hasContainerRuntime())('billing entity on Postgres 16', () => {
	let container: StartedPostgreSqlContainer;
	let sql: Sql;

	/** Run `fn` as `role` with the given session settings, in one transaction. */
	const as = async <T>(
		role: 'billing_app' | 'billing_publisher',
		settings: { tenantId?: string; memberEmail?: string },
		fn: (tx: Tx) => Promise<T>,
	): Promise<T> =>
		(await sql.begin(async (tx) => {
			await tx.unsafe(`SET LOCAL ROLE ${role}`);
			if (settings.tenantId) {
				await tx`select set_config('app.tenant_id', ${settings.tenantId}, true)`;
			}
			if (settings.memberEmail) {
				await tx`select set_config('app.member_email', ${settings.memberEmail}, true)`;
			}
			return fn(tx);
		})) as T;

	const ids = (rows: Array<Record<string, unknown>>, key: string) =>
		rows.map((r) => String(r[key])).sort();

	beforeAll(async () => {
		container = await new PostgreSqlContainer('postgres:16-alpine').start();
		sql = postgres(container.getConnectionUri(), { prepare: false, max: 4, onnotice: () => {} });

		for (const f of readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort()) {
			await sql.unsafe(readFileSync(join(drizzleDir, f), 'utf-8'));
		}

		// The consumer's grants (the portal's own migration does this with its
		// role names): the app role reads, the publisher writes; neither bypasses RLS.
		await sql.unsafe(`
			CREATE ROLE billing_app NOLOGIN NOBYPASSRLS;
			CREATE ROLE billing_publisher NOLOGIN NOBYPASSRLS;
			GRANT USAGE ON SCHEMA billing TO billing_app, billing_publisher;
			GRANT SELECT ON ALL TABLES IN SCHEMA billing TO billing_app;
			GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA billing TO billing_publisher;
		`);

		// Seed as the container superuser, which bypasses RLS.
		await sql`
			insert into billing.owner_accounts
				(id, entity_slug, display_name, stripe_account_id, stripe_mode, status, source, published_at)
			values
				(${OWNER}, 'demo-owner-llc', 'Demo Owner', 'acct_demo0000000000', 'test', 'active', 'fixture', ${PUBLISHED}),
				('other-owner', 'other-owner-llc', 'Other Owner', null, 'test', 'active', 'fixture', ${PUBLISHED})`;
		await sql`
			insert into billing.tenants
				(id, slug, kind, owner_account_id, client_id, stripe_customer_id, display_name, status, source, published_at)
			values
				(${OWNER_TENANT}, 'demo-owner', 'owner', ${OWNER}, null, null, 'Demo Owner', 'active', 'fixture', ${PUBLISHED}),
				(${TENANT_A}, 'demo-a', 'client', ${OWNER}, 'demo-client-a', 'cus_demoA000000000', 'Demo Client A', 'active', 'fixture', ${PUBLISHED}),
				(${TENANT_B}, 'demo-b', 'client', ${OWNER}, 'demo-client-b', 'cus_demoB000000000', 'Demo Client B', 'active', 'fixture', ${PUBLISHED})`;
		await sql`
			insert into billing.tenant_members (tenant_id, email, role, status, source, published_at)
			values
				(${TENANT_A}, 'viewer-a@example.com', 'client_viewer', 'active', 'fixture', ${PUBLISHED}),
				(${TENANT_B}, 'admin-b@example.com', 'client_admin', 'active', 'fixture', ${PUBLISHED}),
				(${TENANT_A}, 'operator@example.com', 'operator', 'active', 'fixture', ${PUBLISHED}),
				(${TENANT_B}, 'operator@example.com', 'operator', 'active', 'fixture', ${PUBLISHED}),
				(${OWNER_TENANT}, 'operator@example.com', 'operator', 'active', 'fixture', ${PUBLISHED})`;
	}, 180_000);

	afterAll(async () => {
		await sql?.end();
		await container?.stop();
	});

	it('reads nothing with neither session setting (deny by default)', async () => {
		const counts = await as('billing_app', {}, async (tx) => ({
			owners: (await tx`select id from billing.owner_accounts`).length,
			tenants: (await tx`select id from billing.tenants`).length,
			members: (await tx`select email from billing.tenant_members`).length,
		}));
		expect(counts).toEqual({ owners: 0, tenants: 0, members: 0 });
	});

	it('shows a member only its own tenant, membership and owner account', async () => {
		const seen = await as('billing_app', { memberEmail: 'viewer-a@example.com' }, async (tx) => ({
			tenants: ids(await tx`select id from billing.tenants`, 'id'),
			members: ids(await tx`select email from billing.tenant_members`, 'email'),
			owners: ids(await tx`select id from billing.owner_accounts`, 'id'),
		}));
		expect(seen.tenants).toEqual([TENANT_A]);
		expect(seen.members).toEqual(['viewer-a@example.com']);
		expect(seen.owners).toEqual([OWNER]);
	});

	it('matches the member email case-insensitively', async () => {
		const tenants = await as('billing_app', { memberEmail: 'Viewer-A@Example.com' }, async (tx) =>
			ids(await tx`select id from billing.tenants`, 'id'),
		);
		expect(tenants).toEqual([TENANT_A]);
	});

	it("keeps a second tenant's rows invisible when scoped to the first", async () => {
		const seen = await as('billing_app', { tenantId: TENANT_A }, async (tx) => ({
			tenants: ids(await tx`select id from billing.tenants`, 'id'),
			members: ids(await tx`select email from billing.tenant_members`, 'email'),
			tenantB: (await tx`select id from billing.tenants where id = ${TENANT_B}`).length,
			membersB: (await tx`select email from billing.tenant_members where tenant_id = ${TENANT_B}`).length,
		}));
		expect(seen.tenants).toEqual([TENANT_A]);
		expect(seen.members).toEqual(['operator@example.com', 'viewer-a@example.com']);
		expect(seen.tenantB).toBe(0);
		expect(seen.membersB).toBe(0);
	});

	it("does not resolve another tenant's slug for a member", async () => {
		const found = await as('billing_app', { memberEmail: 'viewer-a@example.com' }, async (tx) =>
			(await tx`select id from billing.tenants where slug = 'demo-b'`).length,
		);
		expect(found).toBe(0);
	});

	it('lists every tenant an operator email belongs to (the tenant picker)', async () => {
		const tenants = await as('billing_app', { memberEmail: 'operator@example.com' }, async (tx) =>
			ids(await tx`select id from billing.tenants`, 'id'),
		);
		expect(tenants).toEqual([OWNER_TENANT, TENANT_A, TENANT_B].sort());
	});

	it('never shows an owner account that has no visible tenant', async () => {
		const owners = await as('billing_app', { memberEmail: 'operator@example.com' }, async (tx) =>
			ids(await tx`select id from billing.owner_accounts`, 'id'),
		);
		expect(owners).toEqual([OWNER]);
	});

	it('refuses every write from the SELECT-only app role', async () => {
		await expect(
			as('billing_app', { tenantId: TENANT_A }, (tx) =>
				tx`insert into billing.tenant_members (tenant_id, email, role, status, source, published_at)
					values (${TENANT_A}, 'new@example.com', 'client_viewer', 'active', 'fixture', ${PUBLISHED})`,
			),
		).rejects.toMatchObject({ code: '42501' });
	});

	it('lets the publisher write only inside the scoped tenant', async () => {
		await expect(
			as('billing_publisher', { tenantId: TENANT_B }, (tx) =>
				tx`insert into billing.tenant_members (tenant_id, email, role, status, source, published_at)
					values (${TENANT_A}, 'intruder@example.com', 'client_viewer', 'active', 'fixture', ${PUBLISHED})`,
			),
		).rejects.toMatchObject({ code: '42501' });

		const written = await as('billing_publisher', { tenantId: TENANT_B }, async (tx) => {
			await tx`insert into billing.tenant_members (tenant_id, email, role, status, source, published_at)
				values (${TENANT_B}, 'viewer-b@example.com', 'client_viewer', 'active', 'fixture', ${PUBLISHED})`;
			return ids(await tx`select email from billing.tenant_members where tenant_id = ${TENANT_B}`, 'email');
		});
		expect(written).toContain('viewer-b@example.com');
	});

	describe('constraints', () => {
		const refuses = (statement: Promise<unknown>, code: string) =>
			expect(statement).rejects.toMatchObject({ code });

		it('refuses a Stripe mode outside live and test', () =>
			refuses(
				sql`insert into billing.owner_accounts (id, entity_slug, display_name, stripe_mode, status, source, published_at)
					values ('bad-mode', 'x', 'X', 'sandbox', 'active', 'fixture', ${PUBLISHED})`,
				'23514',
			));

		it('refuses a tenant kind outside client and owner', () =>
			refuses(
				sql`insert into billing.tenants (id, slug, kind, owner_account_id, display_name, status, source, published_at)
					values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'demo-c', 'vendor', ${OWNER}, 'C', 'active', 'fixture', ${PUBLISHED})`,
				'23514',
			));

		it('refuses a role outside the three', () =>
			refuses(
				sql`insert into billing.tenant_members (tenant_id, email, role, status, source, published_at)
					values (${TENANT_A}, 'admin@example.com', 'admin', 'active', 'fixture', ${PUBLISHED})`,
				'23514',
			));

		it('refuses an email that is not lowercase', () =>
			refuses(
				sql`insert into billing.tenant_members (tenant_id, email, role, status, source, published_at)
					values (${TENANT_A}, 'Mixed@Example.com', 'client_viewer', 'active', 'fixture', ${PUBLISHED})`,
				'23514',
			));

		it('refuses a second tenant for the same Stripe customer', () =>
			refuses(
				sql`insert into billing.tenants (id, slug, kind, owner_account_id, stripe_customer_id, display_name, status, source, published_at)
					values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'demo-d', 'client', ${OWNER}, 'cus_demoA000000000', 'D', 'active', 'fixture', ${PUBLISHED})`,
				'23505',
			));

		it('refuses a tenant whose owner account does not exist', () =>
			refuses(
				sql`insert into billing.tenants (id, slug, kind, owner_account_id, display_name, status, source, published_at)
					values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'demo-e', 'client', 'no-such-owner', 'E', 'active', 'fixture', ${PUBLISHED})`,
				'23503',
			));

		it('refuses a member of a tenant that does not exist', () =>
			refuses(
				sql`insert into billing.tenant_members (tenant_id, email, role, status, source, published_at)
					values ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'ghost@example.com', 'client_viewer', 'active', 'fixture', ${PUBLISHED})`,
				'23503',
			));
	});
});
