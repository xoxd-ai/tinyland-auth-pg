import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));

assert.equal(manifest.name, '@tummycrypt/tinyland-auth-pg');
assert.equal(manifest.version, '0.2.5');
assert.deepEqual(manifest.peerDependencies, {
  '@tummycrypt/tinyland-auth': '^0.3.0',
});
assert.equal(manifest.dependencies?.['@tummycrypt/tinyland-auth'], undefined);
assert.equal(manifest.devDependencies, undefined);
assert.equal(manifest.scripts, undefined);
assert.equal(manifest.publishConfig, undefined);
await assert.rejects(access(resolve(packageRoot, 'node_modules')));

const requiredPaths = [
  'dist/index.js',
  'dist/index.d.ts',
  'drizzle/0000_lush_carmella_unuscione.sql',
  'drizzle/meta/0000_snapshot.json',
  'drizzle/meta/_journal.json',
  'drizzle-public/0000_worthless_post.sql',
  'drizzle-public/meta/0000_snapshot.json',
  'drizzle-public/meta/_journal.json',
];
await Promise.all(requiredPaths.map((relativePath) => access(resolve(packageRoot, relativePath))));

const runtime = await import(pathToFileURL(resolve(packageRoot, 'dist/index.js')).href);
assert.equal(typeof runtime.createPgStorageAdapter, 'function');
assert.equal(typeof runtime.createNodePgStorageAdapter, 'function');
assert.equal(typeof runtime.bootstrapUsers, 'function');
assert.throws(
  () => runtime.createPgStorageAdapter({ db: null }),
  /`db` is required when using driver injection/,
);

const authMigration = await readFile(
  resolve(packageRoot, 'drizzle/0000_lush_carmella_unuscione.sql'),
  'utf8',
);
for (const table of [
  'audit_events',
  'backup_codes',
  'invitations',
  'sessions',
  'totp_secrets',
  'users',
]) {
  assert.ok(authMigration.includes(`CREATE TABLE "auth"."${table}"`), table);
}
assert.ok(
  authMigration.includes(
    'CREATE UNIQUE INDEX "users_tenant_handle_unique" ON "auth"."users" USING btree ("tenant_id","handle")',
  ),
);

const publicMigration = await readFile(
  resolve(packageRoot, 'drizzle-public/0000_worthless_post.sql'),
  'utf8',
);
for (const table of [
  'appointments',
  'bookings',
  'business_hours',
  'business_hours_overrides',
  'business_profile',
  'clients',
  'gift_certificates',
  'intake_form_responses',
  'intake_form_templates',
  'local_bookings',
  'packages',
  'payments',
  'practitioners',
  'redemptions',
  'reviews',
  'services',
  'slot_reservations',
  'time_blocks',
]) {
  assert.ok(publicMigration.includes(`CREATE TABLE "${table}"`), table);
}

const authJournal = JSON.parse(
  await readFile(resolve(packageRoot, 'drizzle/meta/_journal.json'), 'utf8'),
);
const publicJournal = JSON.parse(
  await readFile(resolve(packageRoot, 'drizzle-public/meta/_journal.json'), 'utf8'),
);
assert.deepEqual(
  authJournal.entries.map(({ idx, tag }) => ({ idx, tag })),
  [{ idx: 0, tag: '0000_lush_carmella_unuscione' }],
);
assert.deepEqual(
  publicJournal.entries.map(({ idx, tag }) => ({ idx, tag })),
  [{ idx: 0, tag: '0000_worthless_post' }],
);
