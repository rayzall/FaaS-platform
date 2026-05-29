/**
 * Smoke test: verifies the env-driven Docker connection works.
 * Run with: node scripts/check-docker.js
 */
require('dotenv').config();
const Docker = require('dockerode');

function createDockerClient() {
  const host = (process.env.DOCKER_HOST || '').trim();
  if (host && host.startsWith('tcp://')) {
    const url = new URL(host);
    return new Docker({
      host: url.hostname,
      port: parseInt(url.port || '2375', 10),
      protocol: 'http',
    });
  }
  const socketPath =
    process.env.DOCKER_SOCKET ||
    (process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock');
  return new Docker({ socketPath });
}

(async () => {
  const docker = createDockerClient();
  const target =
    (process.env.DOCKER_HOST || '').trim() ||
    process.env.DOCKER_SOCKET ||
    (process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock');
  console.log(`→ connecting to: ${target}`);
  try {
    const v = await docker.version();
    const info = await docker.info();
    console.log('OK — Docker connection established');
    console.log(`  Engine:     ${v.Version} (API ${v.ApiVersion})`);
    console.log(`  OS / Arch:  ${v.Os}/${v.Arch}`);
    console.log(`  Containers: ${info.Containers}  (running: ${info.ContainersRunning})`);
    console.log(`  Images:     ${info.Images}`);
    console.log(`  ServerName: ${info.Name}`);
    process.exit(0);
  } catch (err) {
    console.error('FAIL — could not connect to Docker daemon');
    console.error(`  ${err.code || ''} ${err.message}`);
    process.exit(1);
  }
})();
