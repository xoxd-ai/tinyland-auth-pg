import assert from 'node:assert/strict';

import * as auth from '@tummycrypt/tinyland-auth';
import * as storage from '@tummycrypt/tinyland-auth/storage';

assert.equal(typeof auth.hashPassword, 'function');
assert.equal(typeof auth.generateTOTPSecret, 'function');
assert.equal(typeof auth.generateTOTPQRCode, 'function');
assert.equal(typeof auth.generateSecureCredentialsLink, 'function');
assert.equal(typeof storage.createFixedTenantStorageAdapter, 'function');
