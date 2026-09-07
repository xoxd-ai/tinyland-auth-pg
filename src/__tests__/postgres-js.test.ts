/**
 * postgres.js + tenant isolation smoke test via testcontainers.
 *
 * Exercises the `{ db }` driver-injection path (the whole point of v0.2.0)
 * end-to-end against a real Postgres 16. Proves Pattern B: two tenants may
 * share the same handle/email without colliding, and queries do not leak
 * across tenants.
 *
 * SKIPS automatically when no Docker/Podman runtime is discoverable.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgStorageAdapter } from '../adapter.js';
import * as schema from '../schema.js';
import { hasContainerRuntime } from './container-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe.skipIf(!hasContainerRuntime())(
	'postgres.js + tenant isolation smoke',
	() => {
		let container: StartedPostgreSqlContainer;
		let sql: ReturnType<typeof postgres>;

		const TENANT_A = '11111111-1111-1111-1111-111111111111';
		const TENANT_B = '22222222-2222-2222-2222-222222222222';

		beforeAll(async () => {
			container = await new PostgreSqlContainer(
				'postgres:16-alpine',
			).start();
			// prepare:false matches how MassageIthaca will talk to PgBouncer
			// in transaction-pooling mode — same client config as production.
			sql = postgres(container.getConnectionUri(), {
				prepare: false,
				max: 4,
			});

			// Apply auth migrations. drizzle/0000_*.sql creates the `auth`
			// schema and every auth table (users, sessions, totp_secrets,
			// backup_codes, invitations, audit_events). That is enough for
			// these user-scope smoke tests — public/business schemas are
			// exercised separately.
			const authDir = join(__dirname, '../../drizzle');
			const authFiles = readdirSync(authDir)
				.filter((f) => f.endsWith('.sql'))
				.sort();
			for (const f of authFiles) {
				const body = readFileSync(join(authDir, f), 'utf-8');
				await sql.unsafe(body);
			}
		}, 120_000);

		afterAll(async () => {
			await sql?.end({ timeout: 5 });
			await container?.stop();
		});

		it('createUser scopes by tenantId', async () => {
			const db = drizzle(sql, { schema });
			const adapter = createPgStorageAdapter({ db });

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
				// SAME handle/email — would collide in 0.1.x via the plain
				// unique on (handle) / (email). Must succeed in 0.2.0 because
				// uniqueness is composite on (tenant_id, handle/email).
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
			const db = drizzle(sql, { schema });
			const adapter = createPgStorageAdapter({ db });

			const fromA = await adapter.getUserByHandle(TENANT_A, 'alice');
			const fromB = await adapter.getUserByHandle(TENANT_B, 'alice');

			expect(fromA?.passwordHash).toBe('hash_a');
			expect(fromB?.passwordHash).toBe('hash_b');
		});

		it('getAllUsers returns only the current tenant', async () => {
			const db = drizzle(sql, { schema });
			const adapter = createPgStorageAdapter({ db });

			const usersA = await adapter.getAllUsers(TENANT_A);
			const usersB = await adapter.getAllUsers(TENANT_B);

			expect(usersA.every((u) => u.tenantId === TENANT_A)).toBe(true);
			expect(usersB.every((u) => u.tenantId === TENANT_B)).toBe(true);
		});

		it('keeps expired reads non-mutating and reaps explicitly through postgres.js', async () => {
			const db = drizzle(sql, { schema });
			const adapter = createPgStorageAdapter({ db });
			const tenantId = randomUUID();
			const suffix = randomUUID().slice(0, 8);
			const now = new Date().toISOString();
			const user = await adapter.createUser(tenantId, {
				handle: `expiry-${suffix}`,
				email: `expiry-${suffix}@example.com`,
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
			await sql`
				update auth.sessions
				   set expires = (now() at time zone 'utc') - interval '1 day',
				       expires_at = (now() at time zone 'utc') - interval '1 day'
				 where tenant_id = ${tenantId} and id = ${session.id}
			`;

			expect(await adapter.getSession(tenantId, session.id)).toBeNull();
			const before = await sql`
				select count(*)::int as count from auth.sessions
				 where tenant_id = ${tenantId} and id = ${session.id}
			`;
			expect(before[0]!.count).toBe(1);
			expect(await adapter.cleanupExpiredSessions(tenantId)).toBe(1);
			const after = await sql`
				select count(*)::int as count from auth.sessions
				 where tenant_id = ${tenantId} and id = ${session.id}
			`;
			expect(after[0]!.count).toBe(0);
		});
	},
);
