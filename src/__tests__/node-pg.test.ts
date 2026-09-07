/**
 * node-postgres + tenant isolation smoke test via testcontainers.
 *
 * Exercises the owned-pool factory path end-to-end against a real Postgres 16.
 * Proves the new createNodePgStorageAdapter() path preserves the same tenant
 * scoping guarantees as the injected-driver path.
 *
 * SKIPS automatically when no Docker/Podman runtime is discoverable.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodePgStorageAdapter, createPgStorageAdapter } from '../adapter.js';
import * as schema from '../schema.js';
import { hasContainerRuntime } from './container-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe.skipIf(!hasContainerRuntime())(
	'node-postgres + tenant isolation smoke',
	() => {
		let container: StartedPostgreSqlContainer;
		let setupPool: Pool;
		let adapter: ReturnType<typeof createNodePgStorageAdapter>;
		const originalTimezone = process.env.TZ;

		const TENANT_A = '11111111-1111-1111-1111-111111111111';
		const TENANT_B = '22222222-2222-2222-2222-222222222222';

		beforeAll(async () => {
			container = await new PostgreSqlContainer(
				'postgres:16-alpine',
			).start();

			setupPool = new Pool({
				connectionString: container.getConnectionUri(),
			});

			const authDir = join(__dirname, '../../drizzle');
			const authFiles = readdirSync(authDir)
				.filter((f) => f.endsWith('.sql'))
				.sort();
			for (const f of authFiles) {
				const body = readFileSync(join(authDir, f), 'utf-8');
				await setupPool.query(body);
			}

			adapter = createNodePgStorageAdapter({
				connectionString: container.getConnectionUri(),
				// Session-level DateStyle probes below must use one physical
				// connection for SET + adapter query.
				poolConfig: { max: 1 },
			});
			await adapter.init();
		}, 120_000);

		afterAll(async () => {
			await adapter?.close();
			await setupPool?.end();
			await container?.stop();
		});

		afterEach(async () => {
			vi.useRealTimers();
			if (originalTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = originalTimezone;
			await adapter.pool.query('reset datestyle');
		});

		async function createSessionFixture(tenantId = randomUUID()) {
			const suffix = randomUUID().slice(0, 8);
			const now = new Date().toISOString();
			const user = await adapter.createUser(tenantId, {
				handle: `session-${suffix}`,
				email: `session-${suffix}@example.com`,
				passwordHash: 'fixture-hash',
				role: 'admin',
				isActive: true,
				needsOnboarding: false,
				onboardingStep: 0,
				totpEnabled: false,
				createdAt: now,
				updatedAt: now,
			});
			const session = await adapter.createSession(tenantId, user.id, user);
			return { tenantId, user, session };
		}

		async function sessionExists(
			tenantId: string,
			sessionId: string,
			queryable: Pool | PoolClient = setupPool,
		): Promise<boolean> {
			const { rows } = await queryable.query<{ exists: boolean }>(
				'select exists(select 1 from auth.sessions where tenant_id = $1 and id = $2)',
				[tenantId, sessionId],
			);
			return rows[0]!.exists;
		}

		it('createUser scopes by tenantId', async () => {
			const now = new Date().toISOString();

			const a = await adapter.createUser(TENANT_A, {
				handle: 'alice',
				email: 'alice@example.com',
				passwordHash: 'hash_a',
				role: 'admin',
				isActive: true,
				needsOnboarding: false,
				onboardingStep: 0,
				totpEnabled: false,
				createdAt: now,
				updatedAt: now,
			});
			const b = await adapter.createUser(TENANT_B, {
				handle: 'alice',
				email: 'alice@example.com',
				passwordHash: 'hash_b',
				role: 'admin',
				isActive: true,
				needsOnboarding: false,
				onboardingStep: 0,
				totpEnabled: false,
				createdAt: now,
				updatedAt: now,
			});

			expect(a.id).not.toBe(b.id);
			expect(a.tenantId).toBe(TENANT_A);
			expect(b.tenantId).toBe(TENANT_B);
		});

		it('getUserByHandle does not leak across tenants', async () => {
			const fromA = await adapter.getUserByHandle(TENANT_A, 'alice');
			const fromB = await adapter.getUserByHandle(TENANT_B, 'alice');

			expect(fromA?.passwordHash).toBe('hash_a');
			expect(fromB?.passwordHash).toBe('hash_b');
		});

		it('uses the database clock for every session-read path', async () => {
			const fixture = await createSessionFixture();
			await setupPool.query(
				`update auth.sessions
				    set expires = (now() at time zone 'utc') + interval '1 day',
				        expires_at = (now() at time zone 'utc') + interval '1 day'
				  where tenant_id = $1 and id = $2`,
				[fixture.tenantId, fixture.session.id],
			);

			// Fake Date only; network and pool timers stay real.
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));

			expect(await adapter.getSession(fixture.tenantId, fixture.session.id)).not.toBeNull();
			expect((await adapter.getSessionsByUser(fixture.tenantId, fixture.user.id)).map((row) => row.id)).toContain(
				fixture.session.id,
			);
			expect((await adapter.getAllSessions(fixture.tenantId)).map((row) => row.id)).toContain(fixture.session.id);
			expect(await sessionExists(fixture.tenantId, fixture.session.id)).toBe(true);
		});

		it('keeps a live SQL, DMY session without parsing or deleting it', async () => {
			const fixture = await createSessionFixture();
			const yearResult = await setupPool.query<{ year: number }>(
				"select extract(year from now())::int + 1 as year",
			);
			const year = yearResult.rows[0]!.year;
			await setupPool.query(
				`update auth.sessions
				    set expires = make_timestamp($3, 12, 3, 12, 0, 0),
				        expires_at = make_timestamp($3, 12, 3, 12, 0, 0)
				  where tenant_id = $1 and id = $2`,
				[fixture.tenantId, fixture.session.id, year],
			);
			await adapter.pool.query("set datestyle to 'SQL, DMY'");
			const rendered = await adapter.pool.query<{ expires: string }>(
				'select expires::text as expires from auth.sessions where tenant_id = $1 and id = $2',
				[fixture.tenantId, fixture.session.id],
			);

			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(new Date(Date.UTC(year, 5, 1, 12, 0, 0)));
			// Negative control: the old bare-Date heuristic sees 03/12 as March 12,
			// which is already past on June 1 and would delete this live row.
			expect(new Date(rendered.rows[0]!.expires).getTime()).toBeLessThan(Date.now());

			expect(await adapter.getSession(fixture.tenantId, fixture.session.id)).not.toBeNull();
			expect(await sessionExists(fixture.tenantId, fixture.session.id)).toBe(true);
		});

		it('keeps a live session under an Asia/Tokyo process timezone', async () => {
			const fixture = await createSessionFixture();
			await setupPool.query(
				`update auth.sessions
				    set expires = (now() at time zone 'utc') + interval '3 hours',
				        expires_at = (now() at time zone 'utc') + interval '3 hours'
				  where tenant_id = $1 and id = $2`,
				[fixture.tenantId, fixture.session.id],
			);
			process.env.TZ = 'Asia/Tokyo';
			const rendered = await adapter.pool.query<{ expires: string }>(
				'select expires::text as expires from auth.sessions where tenant_id = $1 and id = $2',
				[fixture.tenantId, fixture.session.id],
			);
			// Negative control: interpreting the naive UTC string as Tokyo local
			// time moves it six hours behind the real clock.
			expect(new Date(rendered.rows[0]!.expires).getTime()).toBeLessThan(Date.now());

			expect(await adapter.getSession(fixture.tenantId, fixture.session.id)).not.toBeNull();
			expect(await sessionExists(fixture.tenantId, fixture.session.id)).toBe(true);
		});

		it('keeps expired reads non-mutating and reaps only through the explicit janitor', async () => {
			const fixture = await createSessionFixture();
			await setupPool.query(
				`update auth.sessions
				    set expires = (now() at time zone 'utc') - interval '1 day',
				        expires_at = (now() at time zone 'utc') - interval '1 day'
				  where tenant_id = $1 and id = $2`,
				[fixture.tenantId, fixture.session.id],
			);

			expect(await adapter.getSession(fixture.tenantId, fixture.session.id)).toBeNull();
			expect(await sessionExists(fixture.tenantId, fixture.session.id)).toBe(true);
			expect(await adapter.cleanupExpiredSessions(fixture.tenantId)).toBe(1);
			expect(await sessionExists(fixture.tenantId, fixture.session.id)).toBe(false);
		});

		it('uses expires_at with strict-live and boundary-inclusive tenant cleanup', async () => {
			const a = await createSessionFixture();
			const b = await createSessionFixture();
			const client = await adapter.pool.connect();
			try {
				await client.query('begin');
				await client.query(
					`update auth.sessions
					    set expires = (now() at time zone 'utc') + interval '1 day',
					        expires_at = (now() at time zone 'utc')
					  where (tenant_id = $1 and id = $2) or (tenant_id = $3 and id = $4)`,
					[a.tenantId, a.session.id, b.tenantId, b.session.id],
				);

				const txAdapter = createPgStorageAdapter({ db: drizzle(client, { schema }) });
				expect(await txAdapter.getSession(a.tenantId, a.session.id)).toBeNull();
				expect((await txAdapter.getSessionsByUser(a.tenantId, a.user.id)).map((row) => row.id)).not.toContain(
					a.session.id,
				);
				expect((await txAdapter.getAllSessions(a.tenantId)).map((row) => row.id)).not.toContain(a.session.id);
				expect(await sessionExists(a.tenantId, a.session.id, client)).toBe(true);
				expect(await txAdapter.cleanupExpiredSessions(a.tenantId)).toBe(1);
				expect(await sessionExists(a.tenantId, a.session.id, client)).toBe(false);
				expect(await sessionExists(b.tenantId, b.session.id, client)).toBe(true);
			} finally {
				await client.query('rollback');
				client.release();
			}
		});
	},
);
