import { existsSync } from 'node:fs';
import { join } from 'node:path';

const dockerSocket = '/var/run/docker.sock';

function hasPodmanSocket(): boolean {
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	return runtimeDir
		? existsSync(join(runtimeDir, 'podman', 'podman.sock'))
		: false;
}

export function hasContainerRuntime(): boolean {
	const available = Boolean(
		process.env.DOCKER_HOST ||
			existsSync(dockerSocket) ||
			hasPodmanSocket(),
	);
	if (!available && process.env.AUTH_PG_INTEGRATION_REQUIRED === 'true') {
		throw new Error(
			'AUTH_PG_INTEGRATION_REQUIRED=true but no Docker or Podman socket is available; refusing vacuous PostgreSQL evidence',
		);
	}
	return available;
}
