/**
 * PostgreSQL Storage Adapter for @tummycrypt/tinyland-auth
 *
 * v0.2.0 — driver-agnostic + Pattern B tenant scoping.
 *
 * Usage:
 *   // Preferred: inject a pre-built drizzle client (postgres.js, node-postgres, neon-http)
 *   const adapter = createPgStorageAdapter({ db });
 *
 *   // Legacy: neon-http path (kept for backward-compat)
 *   const adapter = createPgStorageAdapter({ connectionString });
 *
 * Every method takes `tenantId: string` as its first parameter. Every INSERT
 * sets `tenant_id` on the row; every SELECT/UPDATE/DELETE filters by `tenant_id`.
 */

import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, lt, gt, desc, sql, count as countFn } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema.js';
import type { AuditEventFilters } from '@tummycrypt/tinyland-auth/storage';
import type {
  AdminUser,
  Session,
  SessionMetadata,
  EncryptedTOTPSecret,
  BackupCodeSet,
  AdminInvitation,
  AuditEvent,
} from '@tummycrypt/tinyland-auth/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Union of supported drizzle-orm database clients.
 *
 * NOTE: this union is accepted at the factory boundary for DI, but internal
 * query builders currently type-narrow against the neon-http shape because
 * the drizzle-orm `select()/insert()/update()/delete()` return types diverge
 * slightly between drivers. The runtime query builder is fully compatible
 * across drivers — this is purely a tsc ergonomics cap that will resolve
 * once drizzle-orm's generic union inference improves OR once we cross-repo
 * uplift the peer types to a unified shape.
 */
export type Database =
  | NeonHttpDatabase<typeof schema>
  | NodePgDatabase<typeof schema>
  | PostgresJsDatabase<typeof schema>;

/**
 * Domain objects from `@tummycrypt/tinyland-auth/types` don't natively carry
 * `tenantId`. We widen locally so the adapter can surface the column without
 * changing the upstream domain model pinned by this package.
 */
export type TenantScoped<T> = T & { tenantId: string };

export type PgStorageConfig =
  | {
      /** Pre-built drizzle client (preferred). Accepts postgres.js, node-postgres, neon-http. */
      db: Database;
      /** Session TTL in milliseconds (default: 7 days) */
      sessionMaxAge?: number;
    }
  | {
      /** Neon connection string (legacy path — deprecated, kept for backward-compat) */
      connectionString: string;
      /** Session TTL in milliseconds (default: 7 days) */
      sessionMaxAge?: number;
    };

export interface NodePgStorageConfig {
  /** PostgreSQL connection string for node-postgres. */
  connectionString: string;
  /** Session TTL in milliseconds (default: 7 days). */
  sessionMaxAge?: number;
  /** Optional pg.Pool config merged with the connection string. */
  poolConfig?: PoolConfig;
  /**
   * Whether adapter.close() should end the owned pool.
   * Defaults to true for factory-created node-postgres adapters.
   */
  closeOnDispose?: boolean;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// PostgreSQL owns session liveness. Both session timestamp columns are
// `timestamp without time zone` strings for compatibility with the existing
// public schema, so parsing driver-rendered text in JavaScript would make
// DateStyle and process TZ part of authentication correctness. Compare the
// authoritative expires_at column to the database's UTC wall clock instead.
const SESSION_IS_LIVE = sql`${schema.sessions.expiresAt} > (now() at time zone 'utc')`;
const SESSION_IS_EXPIRED = sql`${schema.sessions.expiresAt} <= (now() at time zone 'utc')`;

// ---------------------------------------------------------------------------
// Row → Domain mappers (pure transforms, tenant-scoped)
// ---------------------------------------------------------------------------

type UserRow = typeof schema.users.$inferSelect;
type SessionRow = typeof schema.sessions.$inferSelect;
type TotpRow = typeof schema.totpSecrets.$inferSelect;
type BackupRow = typeof schema.backupCodes.$inferSelect;
type InviteRow = typeof schema.invitations.$inferSelect;
type AuditRow = typeof schema.auditEvents.$inferSelect;

const toAdminUser = (row: UserRow): TenantScoped<AdminUser> => ({
  id: row.id,
  tenantId: row.tenantId,
  handle: row.handle,
  email: row.email,
  displayName: row.displayName ?? undefined,
  passwordHash: row.passwordHash,
  role: row.role as AdminUser['role'],
  isActive: row.isActive,
  isLocked: row.isLocked ?? undefined,
  lockReason: row.lockReason ?? undefined,
  lockedAt: row.lockedAt ?? undefined,
  needsOnboarding: row.needsOnboarding,
  onboardingStep: row.onboardingStep,
  firstLogin: row.firstLogin ?? undefined,
  totpEnabled: row.totpEnabled,
  totpSecretId: row.totpSecretId ?? undefined,
  permissions: row.permissions ?? undefined,
  bio: row.bio ?? undefined,
  avatarUrl: row.avatarUrl ?? undefined,
  pronouns: row.pronouns ?? undefined,
  timezone: row.timezone ?? undefined,
  locale: row.locale ?? undefined,
  theme: (row.theme as AdminUser['theme']) ?? undefined,
  emailNotifications: row.emailNotifications ?? undefined,
  loginAttempts: row.loginAttempts ?? undefined,
  lastFailedLoginAt: row.lastFailedLoginAt ?? undefined,
  lastLoginAt: row.lastLoginAt ?? undefined,
  passwordChangedAt: row.passwordChangedAt ?? undefined,
  ipAddress: row.ipAddress ?? undefined,
  userAgent: row.userAgent ?? undefined,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toSession = (row: SessionRow): TenantScoped<Session> => ({
  id: row.id,
  tenantId: row.tenantId,
  userId: row.userId,
  expires: row.expires,
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
  user: row.user ?? undefined,
  clientIp: row.clientIp,
  clientIpMasked: row.clientIpMasked ?? undefined,
  userAgent: row.userAgent,
  deviceType: (row.deviceType as Session['deviceType']) ?? undefined,
  browserFingerprint: row.browserFingerprint ?? undefined,
  geoLocation: row.geoLocation ?? undefined,
  tempTotpSecret: row.tempTotpSecret ?? undefined,
  tempTotpExpiresAt: row.tempTotpExpiresAt ?? undefined,
});

const toTotpSecret = (row: TotpRow): TenantScoped<EncryptedTOTPSecret> => ({
  tenantId: row.tenantId,
  userId: row.userId,
  handle: row.handle,
  encryptedSecret: row.encryptedSecret,
  iv: row.iv,
  authTag: row.authTag,
  salt: row.salt,
  backupCodesGenerated: row.backupCodesGenerated,
  version: row.version,
  lastUsedAt: row.lastUsedAt ?? undefined,
  createdAt: row.createdAt,
});

const toBackupCodeSet = (row: BackupRow): TenantScoped<BackupCodeSet> => ({
  tenantId: row.tenantId,
  userId: row.userId,
  codes: row.codes,
  generatedAt: row.generatedAt,
  lastUsedAt: row.lastUsedAt ?? undefined,
});

const toInvitation = (row: InviteRow): TenantScoped<AdminInvitation> => ({
  id: row.id,
  tenantId: row.tenantId,
  token: row.token,
  email: row.email,
  role: row.role as AdminInvitation['role'],
  createdBy: row.createdBy,
  isActive: row.isActive,
  expiresAt: row.expiresAt,
  usedAt: row.usedAt ?? undefined,
  usedBy: row.usedBy ?? undefined,
  temporaryTotpSecret: row.temporaryTotpSecret ?? undefined,
  metadata: row.metadata ?? undefined,
  createdAt: row.createdAt,
});

const toAuditEvent = (row: AuditRow): TenantScoped<AuditEvent> => ({
  id: row.id,
  tenantId: row.tenantId,
  type: row.type as AuditEvent['type'],
  userId: row.userId ?? undefined,
  targetUserId: row.targetUserId ?? undefined,
  handle: row.handle ?? undefined,
  ipAddress: row.ipAddress ?? undefined,
  userAgent: row.userAgent ?? undefined,
  details: row.details,
  severity: row.severity as AuditEvent['severity'],
  source: row.source as AuditEvent['source'],
  timestamp: row.timestamp,
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * PgStorageAdapter — driver-agnostic, tenant-scoped.
 *
 * This class exposes tinyland-auth's Pattern B tenant-scoped shape. The
 * `IStorageAdapter` interface remains Pattern A (for example, `getUser(id)`),
 * while this adapter requires `getUser(tenantId, id)`.
 */
export class PgStorageAdapter {
  // Narrow to NeonHttpDatabase internally — runtime is compatible across drivers
  // (see `Database` type comment). This avoids drizzle-orm union-narrowing issues
  // in the query builder where overload resolution differs between drivers.
  private readonly db: NeonHttpDatabase<typeof schema>;
  private readonly sessionMaxAge: number;
  private readonly closeFn?: () => Promise<void>;

  constructor(config: PgStorageConfig, closeFn?: () => Promise<void>) {
    if ('db' in config) {
      if (!config.db) {
        throw new Error(
          'PgStorageAdapter: `db` is required when using driver injection',
        );
      }
      this.db = config.db as NeonHttpDatabase<typeof schema>;
    } else {
      if (!config.connectionString) {
        throw new Error(
          'PgStorageAdapter: `connectionString` is required for the legacy neon-http path',
        );
      }
      const client = neon(config.connectionString);
      this.db = drizzleNeon(client, { schema });
    }
    this.sessionMaxAge = config.sessionMaxAge ?? SEVEN_DAYS_MS;
    this.closeFn = closeFn;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async init(): Promise<void> {
    // Verify connectivity with a simple query
    await this.db.execute(sql`SELECT 1`);
  }

  async close(): Promise<void> {
    // Neon HTTP is stateless. Injected drivers are caller-owned.
    // Factory-created node-postgres adapters install a disposer here.
    await this.closeFn?.();
  }

  // ==========================================================================
  // User Operations
  // ==========================================================================

  async getUser(tenantId: string, id: string): Promise<TenantScoped<AdminUser> | null> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.id, id)))
      .limit(1);
    return rows[0] ? toAdminUser(rows[0]) : null;
  }

  async getUserByHandle(tenantId: string, handle: string): Promise<TenantScoped<AdminUser> | null> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(
        and(
          eq(schema.users.tenantId, tenantId),
          eq(schema.users.handle, handle.toLowerCase()),
        ),
      )
      .limit(1);
    return rows[0] ? toAdminUser(rows[0]) : null;
  }

  async getUserByEmail(tenantId: string, email: string): Promise<TenantScoped<AdminUser> | null> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(
        and(
          eq(schema.users.tenantId, tenantId),
          eq(schema.users.email, email.toLowerCase()),
        ),
      )
      .limit(1);
    return rows[0] ? toAdminUser(rows[0]) : null;
  }

  async getAllUsers(tenantId: string): Promise<TenantScoped<AdminUser>[]> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.tenantId, tenantId));
    return rows.map(toAdminUser);
  }

  async createUser(
    tenantId: string,
    user: Omit<AdminUser, 'id' | 'tenantId'>,
  ): Promise<TenantScoped<AdminUser>> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const rows = await this.db
      .insert(schema.users)
      .values({
        id,
        tenantId,
        handle: user.handle.toLowerCase(),
        email: user.email.toLowerCase(),
        displayName: user.displayName,
        passwordHash: user.passwordHash,
        role: user.role,
        isActive: user.isActive,
        needsOnboarding: user.needsOnboarding,
        onboardingStep: user.onboardingStep,
        totpEnabled: user.totpEnabled,
        permissions: user.permissions,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return toAdminUser(rows[0]!);
  }

  async updateUser(
    tenantId: string,
    id: string,
    updates: Partial<AdminUser>,
  ): Promise<TenantScoped<AdminUser>> {
    const existing = await this.getUser(tenantId, id);
    if (!existing) throw new Error(`User ${id} not found`);

    // Fields that map 1:1 from AdminUser to DB columns
    const passthrough = [
      'displayName', 'passwordHash', 'role', 'isActive', 'isLocked',
      'lockReason', 'lockedAt', 'needsOnboarding', 'onboardingStep',
      'firstLogin', 'totpEnabled', 'totpSecretId', 'permissions',
      'lastLoginAt', 'passwordChangedAt', 'loginAttempts',
      'lastFailedLoginAt', 'ipAddress', 'userAgent', 'bio',
      'avatarUrl', 'pronouns', 'timezone', 'locale', 'theme',
      'emailNotifications',
    ] as const;

    const values: Record<string, unknown> = { updatedAt: new Date().toISOString() };

    // Handle/email need lowercasing
    if (updates.handle !== undefined) values.handle = updates.handle.toLowerCase();
    if (updates.email !== undefined) values.email = updates.email.toLowerCase();

    // All other fields pass through directly
    for (const key of passthrough) {
      if (updates[key] !== undefined) values[key] = updates[key];
    }

    const rows = await this.db
      .update(schema.users)
      .set(values)
      .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.id, id)))
      .returning();

    return toAdminUser(rows[0]!);
  }

  async deleteUser(tenantId: string, id: string): Promise<boolean> {
    const user = await this.getUser(tenantId, id);
    if (!user) return false;

    // sessions.user_id and backup_codes.user_id cascade via FK ON DELETE CASCADE.
    // totp_secrets has no FK to users; invitations.created_by uses ON DELETE
    // NO ACTION. Both must be cleaned up manually before the user row is
    // removed, or the final DELETE throws a foreign key violation.
    await this.deleteTOTPSecret(tenantId, user.handle);
    await this.db
      .delete(schema.invitations)
      .where(
        and(
          eq(schema.invitations.tenantId, tenantId),
          eq(schema.invitations.createdBy, id),
        ),
      );
    await this.db
      .delete(schema.users)
      .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.id, id)));
    return true;
  }

  async hasUsers(tenantId: string): Promise<boolean> {
    const result = await this.db
      .select({ n: countFn() })
      .from(schema.users)
      .where(eq(schema.users.tenantId, tenantId))
      .limit(1);
    return (result[0]?.n ?? 0) > 0;
  }

  // ==========================================================================
  // Session Operations
  // ==========================================================================

  async getSession(tenantId: string, id: string): Promise<TenantScoped<Session> | null> {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.tenantId, tenantId),
          eq(schema.sessions.id, id),
          SESSION_IS_LIVE,
        ),
      )
      .limit(1);
    return rows[0] ? toSession(rows[0]) : null;
  }

  async getSessionsByUser(tenantId: string, userId: string): Promise<TenantScoped<Session>[]> {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.tenantId, tenantId),
          eq(schema.sessions.userId, userId),
          SESSION_IS_LIVE,
        ),
      );

    return rows.map(toSession);
  }

  async getAllSessions(tenantId: string): Promise<TenantScoped<Session>[]> {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.tenantId, tenantId),
          SESSION_IS_LIVE,
        ),
      );

    return rows.map(toSession);
  }

  async createSession(
    tenantId: string,
    userId: string,
    user: Partial<AdminUser>,
    metadata?: SessionMetadata,
  ): Promise<TenantScoped<Session>> {
    const id = randomUUID();
    const now = new Date();
    const expires = new Date(now.getTime() + this.sessionMaxAge);

    const sessionUser = {
      id: user.id || userId,
      username: user.handle || '',
      name: user.displayName || user.handle || '',
      role: user.role || 'viewer',
      needsOnboarding: user.needsOnboarding,
      onboardingStep: user.onboardingStep,
    };

    const rows = await this.db
      .insert(schema.sessions)
      .values({
        id,
        tenantId,
        userId,
        expires: expires.toISOString(),
        expiresAt: expires.toISOString(),
        createdAt: now.toISOString(),
        user: sessionUser,
        clientIp: metadata?.clientIp || 'unknown',
        clientIpMasked: metadata?.clientIpMasked,
        userAgent: metadata?.userAgent || 'unknown',
        deviceType: metadata?.deviceType || 'unknown',
        browserFingerprint: metadata?.browserFingerprint,
        geoLocation: metadata?.geoLocation,
      })
      .returning();

    return toSession(rows[0]!);
  }

  async updateSession(
    tenantId: string,
    id: string,
    updates: Partial<Session>,
  ): Promise<TenantScoped<Session>> {
    const existing = await this.getSession(tenantId, id);
    if (!existing) throw new Error(`Session ${id} not found`);

    const values: Record<string, unknown> = {};
    if (updates.expires !== undefined) {
      values.expires = updates.expires;
      values.expiresAt = updates.expires;
    }
    if (updates.user !== undefined) values.user = updates.user;
    if (updates.tempTotpSecret !== undefined) values.tempTotpSecret = updates.tempTotpSecret;
    if (updates.tempTotpExpiresAt !== undefined) values.tempTotpExpiresAt = updates.tempTotpExpiresAt;

    const rows = await this.db
      .update(schema.sessions)
      .set(values)
      .where(and(eq(schema.sessions.tenantId, tenantId), eq(schema.sessions.id, id)))
      .returning();

    return toSession(rows[0]!);
  }

  async deleteSession(tenantId: string, id: string): Promise<boolean> {
    // Use `.returning()` length instead of `result.rowCount` so the count works
    // across every supported driver. `rowCount` is a neon-http/node-postgres
    // thing; `postgres.js` exposes `.count` and PgBouncer transaction-mode can
    // strip the exec metadata entirely. `.returning()` gives us a driver-
    // agnostic array of affected rows.
    const deleted = await this.db
      .delete(schema.sessions)
      .where(and(eq(schema.sessions.tenantId, tenantId), eq(schema.sessions.id, id)))
      .returning({ id: schema.sessions.id });
    return deleted.length > 0;
  }

  async deleteUserSessions(tenantId: string, userId: string): Promise<number> {
    const deleted = await this.db
      .delete(schema.sessions)
      .where(
        and(
          eq(schema.sessions.tenantId, tenantId),
          eq(schema.sessions.userId, userId),
        ),
      )
      .returning({ id: schema.sessions.id });
    return deleted.length;
  }

  async cleanupExpiredSessions(tenantId: string): Promise<number> {
    const deleted = await this.db
      .delete(schema.sessions)
      .where(
        and(
          eq(schema.sessions.tenantId, tenantId),
          SESSION_IS_EXPIRED,
        ),
      )
      .returning({ id: schema.sessions.id });
    return deleted.length;
  }

  // ==========================================================================
  // TOTP Operations
  // ==========================================================================

  async getTOTPSecret(
    tenantId: string,
    handle: string,
  ): Promise<TenantScoped<EncryptedTOTPSecret> | null> {
    const rows = await this.db
      .select()
      .from(schema.totpSecrets)
      .where(
        and(
          eq(schema.totpSecrets.tenantId, tenantId),
          eq(schema.totpSecrets.handle, handle.toLowerCase()),
        ),
      )
      .limit(1);

    return rows[0] ? toTotpSecret(rows[0]) : null;
  }

  async saveTOTPSecret(
    tenantId: string,
    handle: string,
    secret: EncryptedTOTPSecret,
  ): Promise<void> {
    await this.db
      .insert(schema.totpSecrets)
      .values({
        tenantId,
        handle: handle.toLowerCase(),
        userId: secret.userId,
        encryptedSecret: secret.encryptedSecret,
        iv: secret.iv,
        authTag: secret.authTag,
        salt: secret.salt,
        backupCodesGenerated: secret.backupCodesGenerated,
        version: secret.version,
        lastUsedAt: secret.lastUsedAt,
        createdAt: secret.createdAt,
      })
      .onConflictDoUpdate({
        target: [schema.totpSecrets.tenantId, schema.totpSecrets.handle],
        set: {
          encryptedSecret: secret.encryptedSecret,
          iv: secret.iv,
          authTag: secret.authTag,
          salt: secret.salt,
          backupCodesGenerated: secret.backupCodesGenerated,
          version: secret.version,
          lastUsedAt: secret.lastUsedAt,
        },
      });
  }

  async deleteTOTPSecret(tenantId: string, handle: string): Promise<boolean> {
    const deleted = await this.db
      .delete(schema.totpSecrets)
      .where(
        and(
          eq(schema.totpSecrets.tenantId, tenantId),
          eq(schema.totpSecrets.handle, handle.toLowerCase()),
        ),
      )
      .returning({ handle: schema.totpSecrets.handle });
    return deleted.length > 0;
  }

  // ==========================================================================
  // Backup Code Operations
  // ==========================================================================

  async getBackupCodes(
    tenantId: string,
    userId: string,
  ): Promise<TenantScoped<BackupCodeSet> | null> {
    const rows = await this.db
      .select()
      .from(schema.backupCodes)
      .where(
        and(
          eq(schema.backupCodes.tenantId, tenantId),
          eq(schema.backupCodes.userId, userId),
        ),
      )
      .limit(1);

    return rows[0] ? toBackupCodeSet(rows[0]) : null;
  }

  async saveBackupCodes(
    tenantId: string,
    userId: string,
    codes: BackupCodeSet,
  ): Promise<void> {
    await this.db
      .insert(schema.backupCodes)
      .values({
        tenantId,
        userId,
        codes: codes.codes,
        generatedAt: codes.generatedAt,
        lastUsedAt: codes.lastUsedAt,
      })
      .onConflictDoUpdate({
        target: [schema.backupCodes.tenantId, schema.backupCodes.userId],
        set: {
          codes: codes.codes,
          generatedAt: codes.generatedAt,
          lastUsedAt: codes.lastUsedAt,
        },
      });
  }

  async deleteBackupCodes(tenantId: string, userId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(schema.backupCodes)
      .where(
        and(
          eq(schema.backupCodes.tenantId, tenantId),
          eq(schema.backupCodes.userId, userId),
        ),
      )
      .returning({ userId: schema.backupCodes.userId });
    return deleted.length > 0;
  }

  // ==========================================================================
  // Invitation Operations
  // ==========================================================================

  async getInvitation(
    tenantId: string,
    token: string,
  ): Promise<TenantScoped<AdminInvitation> | null> {
    const rows = await this.db
      .select()
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.tenantId, tenantId),
          eq(schema.invitations.token, token),
        ),
      )
      .limit(1);

    if (!rows[0]) return null;
    const invite = toInvitation(rows[0]);
    if (new Date(invite.expiresAt) < new Date()) return null;
    return invite;
  }

  async getInvitationById(
    tenantId: string,
    id: string,
  ): Promise<TenantScoped<AdminInvitation> | null> {
    const rows = await this.db
      .select()
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.tenantId, tenantId),
          eq(schema.invitations.id, id),
        ),
      )
      .limit(1);

    return rows[0] ? toInvitation(rows[0]) : null;
  }

  async getAllInvitations(tenantId: string): Promise<TenantScoped<AdminInvitation>[]> {
    const rows = await this.db
      .select()
      .from(schema.invitations)
      .where(eq(schema.invitations.tenantId, tenantId));
    return rows.map(toInvitation);
  }

  async getPendingInvitations(tenantId: string): Promise<TenantScoped<AdminInvitation>[]> {
    const now = new Date().toISOString();
    const rows = await this.db
      .select()
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.tenantId, tenantId),
          eq(schema.invitations.isActive, true),
          gt(schema.invitations.expiresAt, now),
          sql`${schema.invitations.usedAt} IS NULL`,
        ),
      );

    return rows.map(toInvitation);
  }

  async createInvitation(
    tenantId: string,
    invitation: Omit<AdminInvitation, 'id'>,
  ): Promise<TenantScoped<AdminInvitation>> {
    const id = randomUUID();

    const rows = await this.db
      .insert(schema.invitations)
      .values({
        id,
        tenantId,
        token: invitation.token,
        email: invitation.email,
        role: invitation.role,
        createdBy: invitation.createdBy,
        isActive: invitation.isActive,
        expiresAt: invitation.expiresAt,
        usedAt: invitation.usedAt,
        usedBy: invitation.usedBy,
        temporaryTotpSecret: invitation.temporaryTotpSecret,
        metadata: invitation.metadata,
        createdAt: invitation.createdAt,
      })
      .returning();

    return toInvitation(rows[0]!);
  }

  async updateInvitation(
    tenantId: string,
    token: string,
    updates: Partial<AdminInvitation>,
  ): Promise<TenantScoped<AdminInvitation>> {
    const existing = await this.getInvitation(tenantId, token);
    if (!existing) throw new Error('Invitation not found');

    const values: Record<string, unknown> = {};
    if (updates.isActive !== undefined) values.isActive = updates.isActive;
    if (updates.usedAt !== undefined) values.usedAt = updates.usedAt;
    if (updates.usedBy !== undefined) values.usedBy = updates.usedBy;
    if (updates.metadata !== undefined) values.metadata = updates.metadata;

    const rows = await this.db
      .update(schema.invitations)
      .set(values)
      .where(
        and(
          eq(schema.invitations.tenantId, tenantId),
          eq(schema.invitations.token, token),
        ),
      )
      .returning();

    return toInvitation(rows[0]!);
  }

  async deleteInvitation(tenantId: string, token: string): Promise<boolean> {
    const deleted = await this.db
      .delete(schema.invitations)
      .where(
        and(
          eq(schema.invitations.tenantId, tenantId),
          eq(schema.invitations.token, token),
        ),
      )
      .returning({ id: schema.invitations.id });
    return deleted.length > 0;
  }

  async cleanupExpiredInvitations(tenantId: string): Promise<number> {
    const now = new Date().toISOString();
    const deleted = await this.db
      .delete(schema.invitations)
      .where(
        and(
          eq(schema.invitations.tenantId, tenantId),
          lt(schema.invitations.expiresAt, now),
        ),
      )
      .returning({ id: schema.invitations.id });
    return deleted.length;
  }

  // ==========================================================================
  // Audit Operations
  // ==========================================================================

  async logAuditEvent(
    tenantId: string,
    event: Omit<AuditEvent, 'id'>,
  ): Promise<TenantScoped<AuditEvent>> {
    const id = `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const rows = await this.db
      .insert(schema.auditEvents)
      .values({
        id,
        tenantId,
        type: event.type as string,
        userId: event.userId,
        targetUserId: event.targetUserId,
        handle: event.handle,
        ipAddress: event.ipAddress,
        userAgent: event.userAgent,
        details: event.details,
        severity: event.severity,
        source: event.source,
        timestamp: event.timestamp,
      })
      .returning();

    return toAuditEvent(rows[0]!);
  }

  async getAuditEvents(
    tenantId: string,
    filters: AuditEventFilters,
  ): Promise<TenantScoped<AuditEvent>[]> {
    const conditions = [eq(schema.auditEvents.tenantId, tenantId)];

    if (filters.startDate) {
      conditions.push(gt(schema.auditEvents.timestamp, filters.startDate.toISOString()));
    }
    if (filters.endDate) {
      conditions.push(lt(schema.auditEvents.timestamp, filters.endDate.toISOString()));
    }
    if (filters.type) {
      conditions.push(eq(schema.auditEvents.type, filters.type));
    }
    if (filters.userId) {
      conditions.push(eq(schema.auditEvents.userId, filters.userId));
    }
    if (filters.severity) {
      conditions.push(eq(schema.auditEvents.severity, filters.severity));
    }

    let query = this.db
      .select()
      .from(schema.auditEvents)
      .where(and(...conditions))
      .orderBy(desc(schema.auditEvents.timestamp));

    if (filters.offset) {
      query = query.offset(filters.offset) as typeof query;
    }
    if (filters.limit) {
      query = query.limit(filters.limit) as typeof query;
    }

    const rows = await query;
    return rows.map(toAuditEvent);
  }

  async getRecentAuditEvents(tenantId: string, limit = 100): Promise<TenantScoped<AuditEvent>[]> {
    const rows = await this.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.tenantId, tenantId))
      .orderBy(desc(schema.auditEvents.timestamp))
      .limit(limit);

    return rows.map(toAuditEvent);
  }
}

/**
 * NodePgStorageAdapter — tenant-scoped adapter backed by an owned pg.Pool.
 *
 * Use this when the package should construct and optionally dispose the pool
 * itself from a standard PostgreSQL connection string.
 */
export class NodePgStorageAdapter extends PgStorageAdapter {
  readonly pool: Pool;

  constructor(config: NodePgStorageConfig) {
    if (!config.connectionString) {
      throw new Error(
        'NodePgStorageAdapter: `connectionString` is required',
      );
    }

    const pool = new Pool({
      ...config.poolConfig,
      connectionString: config.connectionString,
    });

    const db = drizzleNodePg(pool, { schema });
    const closeFn =
      config.closeOnDispose === false
        ? undefined
        : async () => {
            await pool.end();
          };

    super(
      {
        db,
        sessionMaxAge: config.sessionMaxAge,
      },
      closeFn,
    );

    this.pool = pool;
  }
}

/**
 * Factory function for creating a PgStorageAdapter.
 *
 * @example
 *   // With a pre-built drizzle client (postgres.js, node-postgres, neon-http)
 *   const sql = postgres(process.env.DATABASE_URL!, { prepare: false });
 *   const db = drizzle(sql, { schema });
 *   const adapter = createPgStorageAdapter({ db });
 *
 * @example
 *   // Legacy neon-http path (kept for backward-compat)
 *   const adapter = createPgStorageAdapter({ connectionString });
 */
export const createPgStorageAdapter = (config: PgStorageConfig): PgStorageAdapter =>
  new PgStorageAdapter(config);

/**
 * Factory function for creating a node-postgres-backed PgStorageAdapter.
 *
 * @example
 *   const adapter = createNodePgStorageAdapter({
 *     connectionString: process.env.DATABASE_URL!,
 *     poolConfig: { max: 10 },
 *   });
 */
export const createNodePgStorageAdapter = (
  config: NodePgStorageConfig,
): NodePgStorageAdapter => new NodePgStorageAdapter(config);
