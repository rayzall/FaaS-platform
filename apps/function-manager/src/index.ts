/**
 * Function Manager
 *
 * Standalone worker that handles Docker image builds and pushes for
 * serverless functions. Consumes jobs from the Bull "deployments" queue
 * and reports status back via Redis pub/sub.
 *
 * In the current architecture this logic runs inside the API Gateway.
 * Extract this file into a separate container for independent scaling.
 */
import 'dotenv/config';
import Bull from 'bull';
import Docker from 'dockerode';
import pino from 'pino';
import path from 'path';
import fs from 'fs/promises';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Build a dockerode connection from env, OS-aware.
 *  - DOCKER_HOST=tcp://host:port  → remote/TCP daemon
 *  - else on Windows              → named pipe (Docker Desktop)
 *  - else                         → unix socket
 */
function createDockerClient(): Docker {
  const host = process.env.DOCKER_HOST?.trim();
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

const docker = createDockerClient();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const REGISTRY   = process.env.DOCKER_REGISTRY || 'localhost:5000';
const IMAGE_PREFIX = process.env.FUNCTION_IMAGE_PREFIX || 'faas-fn';
const BUILD_DIR  = process.env.BUILD_DIR || '/tmp/faas-builds';

// ─── Queue ────────────────────────────────────────────────────
const buildQueue = new Bull('function-builds', {
  redis: REDIS_URL,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
});

// ─── Build Job ────────────────────────────────────────────────
buildQueue.process('build-and-push', async (job) => {
  const { functionId, functionName, runtime, sourceCode, version } = job.data;

  logger.info({ functionId, functionName, runtime }, 'Starting build');

  const buildDir = path.join(BUILD_DIR, functionId);
  await fs.mkdir(buildDir, { recursive: true });

  try {
    // Write source code
    const handlerFile = getHandlerFile(runtime);
    await fs.writeFile(path.join(buildDir, handlerFile), sourceCode);

    // Write Dockerfile
    const dockerfile = getDockerfile(runtime);
    await fs.writeFile(path.join(buildDir, 'Dockerfile'), dockerfile);

    const imageTag = `${REGISTRY}/${IMAGE_PREFIX}-${functionName}:v${version}`;

    // Build image
    logger.info({ imageTag }, 'Building Docker image');
    await buildImage(buildDir, imageTag);

    // Push image
    logger.info({ imageTag }, 'Pushing Docker image');
    await pushImage(imageTag);

    logger.info({ functionId, imageTag }, 'Build and push complete');
    return { imageTag };
  } finally {
    await fs.rm(buildDir, { recursive: true, force: true });
  }
});

async function buildImage(contextDir: string, tag: string): Promise<void> {
  const stream = await docker.buildImage(
    { context: contextDir, src: ['.'] },
    { t: tag }
  );
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    }, (event: { stream?: string }) => {
      if (event.stream) logger.debug(event.stream.trim());
    });
  });
}

async function pushImage(tag: string): Promise<void> {
  const stream = await docker.getImage(tag).push({});
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function getHandlerFile(runtime: string): string {
  const map: Record<string, string> = {
    NODE18: 'handler.js',
    PYTHON3: 'handler.py',
    GO119: 'handler.go',
  };
  return map[runtime] || 'handler.js';
}

function getDockerfile(runtime: string): string {
  const templates: Record<string, string> = {
    NODE18: `FROM ghcr.io/openfaas/node18-http:latest
WORKDIR /home/app
COPY handler.js .
ENV NODE_ENV=production
`,
    PYTHON3: `FROM ghcr.io/openfaas/python3-http:latest
WORKDIR /home/app
COPY handler.py .
`,
    GO119: `FROM ghcr.io/openfaas/golang-http:latest AS build
WORKDIR /go/src/handler
COPY handler.go .
RUN go build -o handler .
FROM alpine:3.18
COPY --from=build /go/src/handler/handler /usr/bin/handler
CMD ["/usr/bin/handler"]
`,
  };
  return templates[runtime] || templates.NODE18;
}

// ─── Health ───────────────────────────────────────────────────
buildQueue.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'Build job completed');
});

buildQueue.on('failed', (job, err) => {
  logger.error({ jobId: job.id, err: err.message }, 'Build job failed');
});

async function pingDocker(): Promise<void> {
  try {
    await docker.ping();
    const v = await docker.version();
    logger.info({ version: v.Version, apiVersion: v.ApiVersion, os: v.Os }, 'Docker daemon reachable');
  } catch (err) {
    logger.error({ err }, 'Docker daemon unreachable — is Docker Desktop running?');
    throw err;
  }
}

void (async () => {
  try {
    await pingDocker();
  } catch {
    process.exit(1);
  }
  logger.info({ redis: REDIS_URL, registry: REGISTRY }, '🔨 Function Manager started');
})();
