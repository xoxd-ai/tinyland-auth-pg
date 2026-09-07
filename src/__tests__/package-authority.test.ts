import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const readText = (path: string) => readFile(path, 'utf8');
const IN_HOUSE_SCOPES = ['@tummycrypt/', '@tinyland/'] as const;
const AUTH_MODULE = 'tummycrypt_tinyland_auth';
const AUTH_VERSION = '0.3.3';
const REGISTRY_REVISION = 'ef734c4a26045a7b396913e6cf410e50fbe16635';
const PRIVATE_REGISTRY =
  `https://raw.githubusercontent.com/tinyland-inc/bazel-registry/${REGISTRY_REVISION}`;
const PUBLIC_REGISTRY = 'https://bcr.bazel.build';
const CI_TEMPLATES_CANARY =
  'tinyland-inc/ci-templates/.github/workflows/js-bazel-package.yml@6244d36f3048cf93672a8f37a873ec2db2cb09a3';

const extractModuleBlock = (moduleBazel: string): string => {
  const moduleBlock = moduleBazel.match(/module\(([\s\S]*?)\)/);
  if (!moduleBlock) {
    throw new Error('module() declaration not found in MODULE.bazel');
  }
  return moduleBlock[1];
};

// Extract the version declared inside the top-level module() call of MODULE.bazel.
// Scoped to the module() block so bazel_dep(..., version = ...) lines cannot match.
const extractModuleVersion = (moduleBazel: string): string => {
  const version = extractModuleBlock(moduleBazel).match(/version\s*=\s*"([^"]+)"/);
  if (!version) {
    throw new Error('version attribute not found in the module() declaration');
  }
  return version[1];
};

const extractModuleName = (moduleBazel: string): string => {
  const name = extractModuleBlock(moduleBazel).match(/name\s*=\s*"([^"]+)"/);
  if (!name) {
    throw new Error('name attribute not found in the module() declaration');
  }
  return name[1];
};

const extractNpmPackageBlock = (buildBazel: string, targetName: string): string => {
  const pkgBlock = buildBazel.match(
    new RegExp(`npm_package\\(\\s*name\\s*=\\s*"${targetName}",([\\s\\S]*?)\\n\\)`),
  );
  if (!pkgBlock) {
    throw new Error(`npm_package(${targetName}) target not found in BUILD.bazel`);
  }
  return pkgBlock[1];
};

// Extract the version declared inside the publishable npm_package() target.
const extractNpmPackageVersion = (buildBazel: string): string => {
  const version = extractNpmPackageBlock(buildBazel, 'pkg').match(/version\s*=\s*"([^"]+)"/);
  if (!version) {
    throw new Error('version attribute not found in the npm_package() target');
  }
  return version[1];
};

const extractNpmPackageName = (buildBazel: string): string => {
  const packageName = extractNpmPackageBlock(buildBazel, 'pkg').match(
    /package\s*=\s*"([^"]+)"/,
  );
  if (!packageName) {
    throw new Error('package attribute not found in the npm_package() target');
  }
  return packageName[1];
};

const extractBazelDepVersion = (moduleBazel: string, moduleName: string): string => {
  const dep = moduleBazel.match(
    new RegExp(
      `bazel_dep\\(\\s*name\\s*=\\s*"${moduleName}"\\s*,\\s*version\\s*=\\s*"([^"]+)"\\s*\\)`,
    ),
  );
  if (!dep) {
    throw new Error(`bazel_dep(${moduleName}) not found in MODULE.bazel`);
  }
  return dep[1];
};

const hasInHouseName = (name: string): boolean =>
  IN_HOUSE_SCOPES.some((scope) => name.startsWith(scope));

const findInHouseCoordinates = (value: unknown, path = 'package.json'): string[] => {
  if (typeof value === 'string') {
    return hasInHouseName(value) ? [`${path}=${value}`] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findInHouseCoordinates(entry, `${path}[${index}]`),
    );
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value).flatMap(([key, entry]) => [
    ...(hasInHouseName(key) ? [`${path}.${key}`] : []),
    ...findInHouseCoordinates(entry, `${path}.${key}`),
  ]);
};

describe('package release authority', () => {
  it('keeps package identity and version aligned with the MODULE.bazel SSOT', async () => {
    const moduleBazel = await readText('MODULE.bazel');
    const buildBazel = await readText('BUILD.bazel');
    const packageJson = JSON.parse(await readText('package.json')) as {
      name?: string;
      version?: string;
    };

    const moduleVersion = extractModuleVersion(moduleBazel);
    const packagedVersion = extractNpmPackageVersion(buildBazel);

    // MODULE.bazel is the version authority. The npm_package() target and the
    // package.json manifest must both agree with it, or a release ships a
    // version that disagrees with the Bazel-registry SSOT and the git tag.
    expect(packagedVersion).toBe(moduleVersion);
    expect(packageJson.version).toBe(moduleVersion);
    expect(extractModuleName(moduleBazel)).toBe('tummycrypt_tinyland_auth_pg');
    expect(extractNpmPackageName(buildBazel)).toBe('@tummycrypt/tinyland-auth-pg');
    expect(packageJson.name).toBe('@tummycrypt/tinyland-auth-pg');
  });

  it('resolves auth from the exact Bzlmod module with explicit Node runtime stores', async () => {
    const moduleBazel = await readText('MODULE.bazel');
    const buildBazel = await readText('BUILD.bazel');
    const bazelrc = await readText('.bazelrc');
    const moduleLock = JSON.parse(await readText('MODULE.bazel.lock')) as {
      registryFileHashes?: Record<string, string>;
    };

    expect(extractBazelDepVersion(moduleBazel, AUTH_MODULE)).toBe(AUTH_VERSION);
    expect(
      bazelrc
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('common --registry=')),
    ).toEqual([
      `common --registry=${PRIVATE_REGISTRY}`,
      `common --registry=${PUBLIC_REGISTRY}`,
    ]);
    expect(bazelrc).toContain('common --lockfile_mode=error');
    expect(
      Object.keys(moduleLock.registryFileHashes ?? {}).some((path) =>
        path.includes('tinyland-inc/bazel-registry/main/'),
      ),
    ).toBe(false);

    const authRegistryPrefix = `${PRIVATE_REGISTRY}/modules/${AUTH_MODULE}/${AUTH_VERSION}/`;
    const authRegistryEntries = Object.entries(moduleLock.registryFileHashes ?? {})
      .filter(([path]) => path.startsWith(authRegistryPrefix))
      .sort(([left], [right]) => left.localeCompare(right));
    expect(authRegistryEntries.map(([path]) => path)).toEqual([
      `${authRegistryPrefix}MODULE.bazel`,
      `${authRegistryPrefix}source.json`,
    ]);
    expect(authRegistryEntries.every(([, hash]) => hash !== 'not found')).toBe(true);

    const authWrapper = extractNpmPackageBlock(buildBazel, 'tinyland_auth_registry_package');
    expect(authWrapper).toContain('srcs = [":tinyland_auth_registry_files"]');
    expect(authWrapper).toContain(
      'include_external_repositories = ["tummycrypt_tinyland_auth+"]',
    );
    expect(authWrapper).toContain('package = "@tummycrypt/tinyland-auth"');
    expect(authWrapper).toContain(`version = "${AUTH_VERSION}"`);
    expect(buildBazel).toContain('srcs = ["@tummycrypt_tinyland_auth//:pkg"]');

    const authLink = buildBazel.match(
      /npm_link_package\(\s*name\s*=\s*"node_modules\/@tummycrypt\/tinyland-auth"([\s\S]*?)\n\)/,
    );
    expect(authLink, 'consumer-owned tinyland-auth npm_link_package').not.toBeNull();
    expect(authLink?.[1]).toContain('src = ":tinyland_auth_registry_package"');

    for (const [store, alias] of [
      ['bcryptjs@2.4.3', 'bcryptjs'],
      ['nanoid@5.1.9', 'nanoid'],
      ['otplib@12.0.1', 'otplib'],
      ['qrcode@1.5.4', 'qrcode'],
    ] as const) {
      expect(authLink?.[1]).toContain(
        `:.aspect_rules_js/node_modules/${store}": "${alias}"`,
      );
    }
  });

  it('rejects every first-party package-manager source edge', async () => {
    const packageJson = JSON.parse(await readText('package.json')) as Record<string, unknown>;
    expect(packageJson.publishConfig).toBeUndefined();

    const packageManagerCoordinateFields = [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
      'bundledDependencies',
      'bundleDependencies',
      'overrides',
      'resolutions',
      'pnpm',
      'workspaces',
    ] as const;
    const packageManagerCoordinates = packageManagerCoordinateFields.flatMap((field) =>
      findInHouseCoordinates(packageJson[field], `package.json.${field}`),
    );
    expect(packageManagerCoordinates).toEqual([]);

    expect(packageJson.devDependencies).toMatchObject({
      bcryptjs: '2.4.3',
      nanoid: '5.1.9',
      otplib: '12.0.1',
      qrcode: '1.5.4',
    });

    const packageManagerFiles = await Promise.all([
      readText('pnpm-lock.yaml'),
      readText('pnpm-workspace.yaml'),
    ]);
    for (const contents of packageManagerFiles) {
      for (const scope of IN_HOUSE_SCOPES) {
        expect(contents).not.toContain(scope);
      }
    }
  });

  it('keeps peer metadata non-authoritative and delegates CI to the central v4 graph carrier', async () => {
    const [buildBazel, readme, ciWorkflow] = await Promise.all([
      readText('BUILD.bazel'),
      readText('README.md'),
      readText('.github/workflows/ci.yml'),
    ]);

    expect(buildBazel).toContain(
      'filter = ".peerDependencies = {\\"@tummycrypt/tinyland-auth\\": \\"^0.3.0\\"} | del(.devDependencies, .scripts)"',
    );
    expect(readme).toContain('Canonical first-party consumption is the immutable');
    expect(readme).toContain('publishes neither npmjs nor GitHub Packages');
    expect(readme).toContain('peer compatibility metadata');
    expect(readme).not.toContain('npm install @tummycrypt/tinyland-auth-pg');
    expect(readme).not.toContain('pnpm add @tummycrypt/tinyland-auth-pg');
    expect(ciWorkflow).toContain(`uses: ${CI_TEMPLATES_CANARY}`);
    expect(ciWorkflow).toContain('verify_bzlmod_lock: true');
    expect(ciWorkflow).toContain('//:integration_test');
    expect(ciWorkflow).not.toMatch(
      /\b(?:publish_mode|npm_publish_mode|github_package_name|package_dir|dry_run):/,
    );
    expect(ciWorkflow).not.toContain('packages: write');
    expect(ciWorkflow).not.toContain('secrets: inherit');
  });

  it('records an external Bzlmod consumer with both first-party package links', async () => {
    const [consumerModule, consumerBuild] = await Promise.all([
      readText('tests/bzlmod-consumer/MODULE.bazel.template'),
      readText('tests/bzlmod-consumer/BUILD.fixture'),
    ]);

    expect(extractBazelDepVersion(consumerModule, AUTH_MODULE)).toBe(AUTH_VERSION);
    expect(extractBazelDepVersion(consumerModule, 'tummycrypt_tinyland_auth_pg')).toBe(
      '0.2.5',
    );
    expect(consumerModule).not.toMatch(
      /local_path_override\([\s\S]*?module_name\s*=\s*"tummycrypt_tinyland_auth"[\s\S]*?\)/,
    );
    expect(consumerBuild).toContain('srcs = ["@tummycrypt_tinyland_auth//:pkg"]');
    expect(consumerBuild).toContain('srcs = ["@tummycrypt_tinyland_auth_pg//:pkg"]');
    expect(consumerBuild).toContain('name = "node_modules/@tummycrypt/tinyland-auth"');
    expect(consumerBuild).toContain('name = "node_modules/@tummycrypt/tinyland-auth-pg"');
    for (const forbidden of ['@npm', 'npm_translate_lock', 'npm.pkg.github.com', 'workspace:', 'file:']) {
      expect(`${consumerModule}\n${consumerBuild}`).not.toContain(forbidden);
    }
  });
});
