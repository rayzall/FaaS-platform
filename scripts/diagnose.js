/**
 * FaaS Platform — diagnostic check
 *
 * Verifies the live state of every infrastructure dependency the platform
 * relies on (Docker, Postgres, Redis), using the same env-var conventions
 * the application code uses.
 *
 * Run with:  node scripts/diagnose.js
 */
require('dotenv/config');

const Docker = require('dockerode');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';

const ok = (label, msg) => console.log(`${GREEN}✓${RESET} ${BOLD}${label}${RESET}  ${msg}`);
const fail = (label, msg) => console.log(`${RED}✗${RESET} ${BOLD}${label}${RESET}  ${msg}`);
const warn = (label, msg) => console.log(`${YELLOW}!${RESET} ${BOLD}${label}${RESET}  ${msg}`);

function buildDockerOptions() {
  const host = (process.env.DOCKER_HOST || '').trim();
  if (host && host.startsWith('tcp://')) {
    const url = new URL(host);
    return {
      host: url.hostname,
      port: parseInt(url.port || '2375', 10),
      protocol: 'http',
      _label: `tcp://${url.hostname}:${url.port || 2375}`,
    };
  }
  const socketPath =
    process.env.DOCKER_SOCKET ||
    (process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock');
  return { socketPath, _label: socketPath };
}

async function checkDocker() {
  const opts = buildDockerOptions();
  const label = opts._label;
  delete opts._label;
  try {
    const docker = new Docker(opts);
    await docker.ping();
    const info = await docker.version();
    ok('Docker', `engine ${info.Version} (api ${info.ApiVersion}) via ${label}`);
    const containers = await docker.listContainers({ all: false });
    const faasContainers = containers.filter(
      (c) => (c.Names[0] || '').includes('faas') || (c.Labels && c.Labels['faas.managed'])
    );
    ok(
      'Docker',
      `${containers.length} container(s) running, ${faasContainers.length} FaaS-tagged`
    );
    faasContainers.forEach((c) =>
      console.log(`         • ${c.Names[0].replace(/^\//, '')}  [${c.Image}]  ${c.Status}`)
    );
    return true;
  } catch (err) {
    fail('Docker', `cannot connect via ${label} — ${err.message}`);
    return false;
  }
}

async function checkPostgres() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    fail('Postgres', 'DATABASE_URL not set');
    return false;
  }
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    const safeUrl = url.replace(/:[^:@/]+@/, ':***@');
    ok('Postgres', `connected to ${safeUrl}`);
    const ver = await prisma.$queryRaw`SELECT version() AS version`;
    console.log(`         • ${String(ver[0].version).split(',')[0]}`);
    const tables = await prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM information_schema.tables
      WHERE table_schema = 'public'`;
    ok('Postgres', `${tables[0].n} table(s) in public schema`);
    if (tables[0].n > 0) {
      try {
        const userCount = await prisma.user.count();
        ok('Postgres', `${userCount} user(s) in 'users' table`);
      } catch {
        warn('Postgres', "schema doesn't match Prisma model — run prisma migrate deploy");
      }
    } else {
      warn('Postgres', 'no tables yet — run "npm run db:migrate"');
    }
    return true;
  } catch (err) {
    fail('Postgres', err.message);
    return false;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

async function checkRedis() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    const pong = await redis.ping();
    const info = await redis.info('server');
    const ver = (info.match(/redis_version:([^\r\n]+)/) || [])[1] || 'unknown';
    ok('Redis', `${pong} from ${url} (v${ver})`);
    return true;
  } catch (err) {
    fail('Redis', err.message);
    return false;
  } finally {
    redis.disconnect();
  }
}

async function checkHttp(label, url, optional = false) {
  const http = url.startsWith('https:') ? require('https') : require('http');
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      const code = res.statusCode;
      res.resume();
      if (code >= 200 && code < 500) {
        ok(label, `${url} → HTTP ${code}`);
        resolve(true);
      } else {
        fail(label, `${url} → HTTP ${code}`);
        resolve(false);
      }
    });
    req.on('timeout', () => {
      req.destroy();
      (optional ? warn : fail)(label, `${url} → timeout`);
      resolve(optional);
    });
    req.on('error', (err) => {
      (optional ? warn : fail)(label, `${url} → ${err.code || err.message}`);
      resolve(optional);
    });
  });
}

(async () => {
  console.log(`${BOLD}\nFaaS Platform — Diagnostic\n${RESET}`);
  const results = {
    docker: await checkDocker(),
    postgres: await checkPostgres(),
    redis: await checkRedis(),
  };
  console.log(`${BOLD}\nOptional services\n${RESET}`);
  results.apiGateway = await checkHttp(
    'API Gateway',
    `http://localhost:${process.env.PORT || 3001}/health`,
    true
  );
  results.functionRunner = await checkHttp(
    'Function Runner',
    process.env.FUNCTION_RUNNER_URL || 'http://localhost:8080/health',
    true
  );
  results.nginx = await checkHttp('NGINX', 'http://localhost/', true);

  console.log('');
  const required = ['docker', 'postgres', 'redis'];
  const passed = required.filter((k) => results[k]).length;
  if (passed === required.length) {
    ok('Summary', `${passed}/${required.length} core systems healthy`);
    process.exit(0);
  } else {
    warn('Summary', `${passed}/${required.length} core systems healthy`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
