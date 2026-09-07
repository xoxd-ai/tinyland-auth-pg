import assert from 'node:assert/strict';

import { hashPassword } from '@tummycrypt/tinyland-auth';
import { createPgStorageAdapter } from '@tummycrypt/tinyland-auth-pg';

assert.equal(typeof hashPassword, 'function');
assert.equal(typeof createPgStorageAdapter, 'function');
assert.throws(
  () => createPgStorageAdapter({ db: null }),
  /`db` must be a pre-built Drizzle database instance/,
);
