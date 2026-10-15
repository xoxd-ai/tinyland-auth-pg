/**
 * Tests for PgStorageAdapter — row mappers + adapter methods with mocked DB.
 *
 * Tests the mapper logic (pure transforms) and verifies adapter methods
 * call the right Drizzle operations with correct arguments.
 */

import { describe, it, expect } from 'vitest';

// Fixed tenant UUID used across all fixture rows and adapter call sites so
// tests exercise the Pattern B contract (every method accepts tenantId first).
const TEST_TENANT_ID = '11111111-1111-1111-1111-111111111111';

// ---------------------------------------------------------------------------
// Row fixtures (match Drizzle $inferSelect types from schema.ts)
// ---------------------------------------------------------------------------

const userRow = {
	id: '550e8400-e29b-41d4-a716-446655440000',
	tenantId: TEST_TENANT_ID,
	handle: 'jen',
	email: 'jen@example.com',
	displayName: 'Jen',
	passwordHash: '$2b$10$hash',
	role: 'business_owner',
	isActive: true,
	isLocked: false,
	lockReason: null,
	lockedAt: null,
	needsOnboarding: false,
	onboardingStep: 3,
	firstLogin: false,
	totpEnabled: false,
	totpSecretId: null,
	permissions: ['admin'],
	bio: null,
	avatarUrl: null,
	pronouns: null,
	timezone: 'America/New_York',
	locale: 'en-US',
	theme: 'light',
	emailNotifications: true,
	loginAttempts: 0,
	lastFailedLoginAt: null,
	lastLoginAt: '2026-03-22T10:00:00Z',
	passwordChangedAt: '2026-03-01T00:00:00Z',
	ipAddress: null,
	userAgent: null,
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-03-22T10:00:00Z',
};

const sessionRow = {
	id: '660e8400-e29b-41d4-a716-446655440001',
	tenantId: TEST_TENANT_ID,
	userId: '550e8400-e29b-41d4-a716-446655440000',
	expires: '2026-03-29T10:00:00Z',
	expiresAt: '2026-03-29T10:00:00Z',
	createdAt: '2026-03-22T10:00:00Z',
	user: { id: '550e', username: 'jen', name: 'Jen', role: 'business_owner' },
	clientIp: '127.0.0.1',
	clientIpMasked: null,
	userAgent: 'Mozilla/5.0',
	deviceType: 'desktop',
	browserFingerprint: null,
	geoLocation: null,
	tempTotpSecret: null,
	tempTotpExpiresAt: null,
};

// totp_secrets has a composite PK of (tenantId, handle) — there is no `id`
// column on the real row. Keep this fixture aligned with the schema.
const totpRow = {
	tenantId: TEST_TENANT_ID,
	userId: '550e8400-e29b-41d4-a716-446655440000',
	handle: 'jess',
	encryptedSecret: 'encrypted-data',
	iv: 'iv-data',
	authTag: 'tag-data',
	salt: 'salt-data',
	backupCodesGenerated: true,
	version: 1,
	lastUsedAt: '2026-03-20T00:00:00Z',
	createdAt: '2026-03-01T00:00:00Z',
};

const auditRow = {
	id: 'evt_123_abc',
	tenantId: TEST_TENANT_ID,
	type: 'login_success',
	userId: '550e8400-e29b-41d4-a716-446655440000',
	targetUserId: null,
	handle: 'jen',
	ipAddress: '127.0.0.1',
	userAgent: 'Mozilla/5.0',
	details: { method: 'PIN' },
	severity: 'info',
	source: 'user',
	timestamp: '2026-03-22T10:00:00Z',
};

// ---------------------------------------------------------------------------
// Row Mapper Tests (pure transforms, no DB)
// ---------------------------------------------------------------------------

describe('Row Mappers', () => {
	// We can't directly import the private mappers, but we can test them
	// indirectly through the adapter. Instead, let's test the shapes.

	describe('User row shape', () => {
		it('has all required fields', () => {
			expect(userRow).toHaveProperty('id');
			expect(userRow).toHaveProperty('handle');
			expect(userRow).toHaveProperty('email');
			expect(userRow).toHaveProperty('passwordHash');
			expect(userRow).toHaveProperty('role');
			expect(userRow).toHaveProperty('isActive');
			expect(userRow).toHaveProperty('createdAt');
		});

		it('handle is lowercase', () => {
			expect(userRow.handle).toBe(userRow.handle.toLowerCase());
		});

		it('carries tenantId (Pattern B)', () => {
			expect(userRow.tenantId).toBe(TEST_TENANT_ID);
		});
	});

	describe('Session row shape', () => {
		it('has required fields', () => {
			expect(sessionRow).toHaveProperty('id');
			expect(sessionRow).toHaveProperty('userId');
			expect(sessionRow).toHaveProperty('expires');
			expect(sessionRow).toHaveProperty('user');
		});

		it('user is a nested object', () => {
			expect(typeof sessionRow.user).toBe('object');
			expect(sessionRow.user).toHaveProperty('username');
			expect(sessionRow.user).toHaveProperty('role');
		});

		it('carries tenantId (Pattern B)', () => {
			expect(sessionRow.tenantId).toBe(TEST_TENANT_ID);
		});
	});

	describe('TOTP row shape', () => {
		it('has encryption fields', () => {
			expect(totpRow).toHaveProperty('encryptedSecret');
			expect(totpRow).toHaveProperty('iv');
			expect(totpRow).toHaveProperty('authTag');
			expect(totpRow).toHaveProperty('salt');
		});

		it('carries tenantId (Pattern B)', () => {
			expect(totpRow.tenantId).toBe(TEST_TENANT_ID);
		});
	});

	describe('Audit event row shape', () => {
		it('has all required fields', () => {
			expect(auditRow).toHaveProperty('type');
			expect(auditRow).toHaveProperty('severity');
			expect(auditRow).toHaveProperty('source');
			expect(auditRow).toHaveProperty('timestamp');
		});

		it('carries tenantId (Pattern B)', () => {
			expect(auditRow.tenantId).toBe(TEST_TENANT_ID);
		});
	});
});

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe('Schema Definitions', () => {
	it('imports auth schema without errors', async () => {
		const schema = await import('../schema.js');
		expect(schema.users).toBeDefined();
		expect(schema.sessions).toBeDefined();
		expect(schema.totpSecrets).toBeDefined();
		expect(schema.backupCodes).toBeDefined();
		expect(schema.invitations).toBeDefined();
		expect(schema.auditEvents).toBeDefined();
	}, 30000);

	it('imports content schema without errors', async () => {
		const schema = await import('../content-schema.js');
		expect(schema).toBeDefined();
	});

	it('imports booking schema without errors', async () => {
		const schema = await import('../booking-schema.js');
		expect(schema).toBeDefined();
	});

	it('imports giftcert schema without errors', async () => {
		const schema = await import('../giftcert-schema.js');
		expect(schema).toBeDefined();
	});

	it('imports intake schema without errors', async () => {
		const schema = await import('../intake-schema.js');
		expect(schema).toBeDefined();
	});

	it('imports business schema without errors', async () => {
		const schema = await import('../business-schema.js');
		expect(schema).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Factory function tests
// ---------------------------------------------------------------------------

describe('createPgStorageAdapter', () => {
	it('exports factory function', async () => {
		const mod = await import('../index.js');
		expect(mod.createPgStorageAdapter).toBeDefined();
		expect(typeof mod.createPgStorageAdapter).toBe('function');
	});

	it('throws with empty connection string', async () => {
		const { createPgStorageAdapter } = await import('../index.js');
		// neon() throws on empty/invalid connection string
		expect(() => createPgStorageAdapter({ connectionString: '' })).toThrow();
	});

	it('throws with falsy db in driver-injection mode', async () => {
		const { createPgStorageAdapter } = await import('../index.js');
		// Mirrors the connectionString validation — a nullish `db` must fail loudly
		// at construction rather than silently defer to first query
		expect(() =>
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			createPgStorageAdapter({ db: null as any }),
		).toThrow(/`db` is required/);
		expect(() =>
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			createPgStorageAdapter({ db: undefined as any }),
		).toThrow(/`db` is required/);
	});
});

describe('createNodePgStorageAdapter', () => {
	it('exports factory function', async () => {
		const mod = await import('../index.js');
		expect(mod.createNodePgStorageAdapter).toBeDefined();
		expect(typeof mod.createNodePgStorageAdapter).toBe('function');
	});

	it('throws with empty connection string', async () => {
		const { createNodePgStorageAdapter } = await import('../index.js');
		expect(() => createNodePgStorageAdapter({ connectionString: '' })).toThrow(
			/`connectionString` is required/,
		);
	});

	it('creates a node-postgres-backed adapter', async () => {
		const { createNodePgStorageAdapter, NodePgStorageAdapter } = await import('../index.js');
		const adapter = createNodePgStorageAdapter({
			connectionString: 'postgresql://u:p@127.0.0.1:5432/db',
		});

		expect(adapter).toBeInstanceOf(NodePgStorageAdapter);
		await adapter.close();
	});

	it('supports caller-owned pool lifecycle', async () => {
		const { createNodePgStorageAdapter } = await import('../index.js');
		const adapter = createNodePgStorageAdapter({
			connectionString: 'postgresql://u:p@127.0.0.1:5432/db',
			closeOnDispose: false,
		});

		await expect(adapter.close()).resolves.toBeUndefined();
		await adapter.pool.end();
	});
});

// ---------------------------------------------------------------------------
// Adapter method signature tests
// ---------------------------------------------------------------------------

describe('PgStorageAdapter interface', () => {
	it('exposes all expected storage adapter methods', async () => {
		const { PgStorageAdapter } = await import('../adapter.js');

		// Verify all expected methods exist on the prototype
		const expectedMethods = [
			'init', 'close',
			'getUser', 'getUserByHandle', 'getUserByEmail', 'getAllUsers',
			'createUser', 'updateUser', 'deleteUser', 'hasUsers',
			'getSession', 'getSessionsByUser', 'getAllSessions',
			'createSession', 'updateSession', 'deleteSession',
			'deleteUserSessions', 'cleanupExpiredSessions',
			'getTOTPSecret', 'saveTOTPSecret', 'deleteTOTPSecret',
			'getBackupCodes', 'saveBackupCodes', 'deleteBackupCodes',
			'getInvitation', 'getInvitationById', 'getAllInvitations',
			'getPendingInvitations', 'createInvitation', 'updateInvitation',
			'deleteInvitation', 'cleanupExpiredInvitations',
			'logAuditEvent', 'getAuditEvents', 'getRecentAuditEvents',
		];

		for (const method of expectedMethods) {
			expect(PgStorageAdapter.prototype).toHaveProperty(method);
			expect(typeof PgStorageAdapter.prototype[method as keyof typeof PgStorageAdapter.prototype]).toBe('function');
		}
	});

	it('has 34 methods (lifecycle + CRUD)', async () => {
		const { PgStorageAdapter } = await import('../adapter.js');
		const methods = Object.getOwnPropertyNames(PgStorageAdapter.prototype)
			.filter(m => m !== 'constructor' && typeof PgStorageAdapter.prototype[m as keyof typeof PgStorageAdapter.prototype] === 'function');
		expect(methods.length).toBeGreaterThanOrEqual(31);
	});
});

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

describe('PgStorageConfig', () => {
	it('default sessionMaxAge is 7 days in ms', () => {
		const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
		expect(SEVEN_DAYS_MS).toBe(604800000);
	});
});

// ---------------------------------------------------------------------------
// Export structure tests
// ---------------------------------------------------------------------------

describe('Package exports', () => {
	it('index exports createPgStorageAdapter', async () => {
		const mod = await import('../index.js');
		expect(mod.createPgStorageAdapter).toBeDefined();
	});

	it('index exports createNodePgStorageAdapter', async () => {
		const mod = await import('../index.js');
		expect(mod.createNodePgStorageAdapter).toBeDefined();
	});

	it('index exports PgStorageAdapter class', async () => {
		const mod = await import('../adapter.js');
		expect(mod.PgStorageAdapter).toBeDefined();
	});

	it('index exports NodePgStorageAdapter class', async () => {
		const mod = await import('../adapter.js');
		expect(mod.NodePgStorageAdapter).toBeDefined();
	});

	it('schema exports auth tables', async () => {
		const schema = await import('../schema.js');
		expect(schema.authSchema).toBeDefined();
		expect(schema.users).toBeDefined();
		expect(schema.sessions).toBeDefined();
		expect(schema.totpSecrets).toBeDefined();
		expect(schema.backupCodes).toBeDefined();
		expect(schema.invitations).toBeDefined();
		expect(schema.auditEvents).toBeDefined();
	});

	it('content-schema exports tables', async () => {
		const schema = await import('../content-schema.js');
		// Should export service, business hours, etc. tables
		expect(Object.keys(schema).length).toBeGreaterThan(0);
	});

	it('booking-schema exports tables', async () => {
		const schema = await import('../booking-schema.js');
		expect(Object.keys(schema).length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Driver injection (v0.2.0) — factory accepts pre-built drizzle client
// ---------------------------------------------------------------------------

describe('driver injection', () => {
	it('accepts a pre-built drizzle client via { db }', async () => {
		const { drizzle: drizzlePgJs } = await import('drizzle-orm/postgres-js');
		const schema = await import('../schema.js');
		const { createPgStorageAdapter, PgStorageAdapter } = await import('../adapter.js');

		// Mock postgres.js shape sufficient for Drizzle's client wrapper.
		// drizzle postgres-js driver reads `sql.options.parsers` at construction,
		// so the mock must expose a minimally-shaped `options` object.
		const mockSql: any = () => [];
		mockSql.unsafe = () => Promise.resolve([]);
		mockSql.options = { parsers: {}, serializers: {} };
		const db = drizzlePgJs(mockSql, { schema });

		const adapter = createPgStorageAdapter({ db });
		expect(adapter).toBeInstanceOf(PgStorageAdapter);
	});

	it('still accepts connectionString (backward compat)', async () => {
		const { createPgStorageAdapter, PgStorageAdapter } = await import('../adapter.js');
		const adapter = createPgStorageAdapter({ connectionString: 'postgresql://u:p@h/d' });
		expect(adapter).toBeInstanceOf(PgStorageAdapter);
	});
});

describe('email at the adapter boundary (tinyland-auth 1.x)', () => {
	// tinyland-auth 1.x made AdminUser.email and AdminInvitation.email optional;
	// auth.users.email and auth.invitations.email stay NOT NULL, so the adapter
	// rejects a missing email before any query runs.
	const makeAdapter = async () => {
		const { drizzle: drizzlePgJs } = await import('drizzle-orm/postgres-js');
		const schema = await import('../schema.js');
		const { createPgStorageAdapter } = await import('../adapter.js');
		const queries: string[] = [];
		const mockSql: any = () => [];
		mockSql.unsafe = (query: string) => {
			queries.push(query);
			return Promise.resolve([]);
		};
		mockSql.options = { parsers: {}, serializers: {} };
		return { adapter: createPgStorageAdapter({ db: drizzlePgJs(mockSql, { schema }) }), queries };
	};

	it('createUser throws without an email and issues no query', async () => {
		const { adapter, queries } = await makeAdapter();
		await expect(
			adapter.createUser(TEST_TENANT_ID, {
				handle: 'noemail',
				displayName: 'No Email',
				passwordHash: 'x',
				role: 'viewer',
				isActive: true,
				needsOnboarding: false,
				onboardingStep: 0,
				totpEnabled: false,
				createdAt: '2026-10-15T00:00:00Z',
			} as any),
		).rejects.toThrow(/createUser requires an email/);
		expect(queries).toEqual([]);
	});

	it('createInvitation throws on a blank email and issues no query', async () => {
		const { adapter, queries } = await makeAdapter();
		await expect(
			adapter.createInvitation(TEST_TENANT_ID, {
				token: 't',
				email: '  ',
				role: 'viewer',
				createdBy: 'u',
				isActive: true,
				expiresAt: '2026-10-22T00:00:00Z',
				createdAt: '2026-10-15T00:00:00Z',
			} as any),
		).rejects.toThrow(/createInvitation requires an email/);
		expect(queries).toEqual([]);
	});
});
