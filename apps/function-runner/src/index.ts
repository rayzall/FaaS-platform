/**
 * FaaS Function Runner
 *
 * A lightweight HTTP server that mimics the OpenFaaS Gateway API surface.
 * Uses only Docker Hub images — no ghcr.io required.
 *
 * API surface (compatible with the API Gateway's openfaas client):
 *   POST   /system/functions          — deploy / update a function
 *   PUT    /system/functions          — update a function
 *   DELETE /system/functions          — remove a function
 *   GET    /system/functions          — list all functions
 *   GET    /system/function/:name     — get one function
 *   POST   /system/scale-function/:name — scale
 *   GET    /system/logs               — get logs
 *   POST   /function/:name            — invoke a function
 *   GET    /function/:name            — invoke a function (GET)
 *   GET    /healthz                   — health check
 */
import 'dotenv/config';
import express, { Request, Response } from 'express';
import http from 'http';
import httpProxy from 'http-proxy';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

import { config } from './config';
import { logger } from './logger';
import {
  buildFunctionImage,
  startFunctionContainer,
  stopFunctionContainer,
  getFunctionContainer,
  listFunctionContainers,
  getContainerLogs,
  scaleFunctionContainer,
  pingDocker,
} from './docker';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// In-memory function registry (persisted to disk for restarts)
interface FunctionRecord {
  name: string;
  image: string;
  runtime: string;
  envVars: Record<string, string>;
  labels: Record<string, string>;
  memory: number;
  replicas: number;
  invocationCount: number;
  availableReplicas: number;
  createdAt: string;
}

const REGISTRY_FILE = process.env.REGISTRY_FILE || '/tmp/faas-registry.json';
const functions = new Map<string, FunctionRecord>();

function saveRegistry() {
  try {
    const data = JSON.stringify(Array.from(functions.entries()), null, 2);
    fs.writeFileSync(REGISTRY_FILE, data);
  } catch { /* ignore */ }
}

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
      for (const [k, v] of data) functions.set(k, v);
      logger.info({ count: functions.size }, 'Registry loaded from disk');
    }
  } catch { /* ignore */ }
}

// ─── Health ───────────────────────────────────────────────────
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', functions: functions.size });
});

// ─── List functions ───────────────────────────────────────────
app.get('/system/functions', async (_req, res) => {
  const list = Array.from(functions.values()).map(fn => ({
    name: fn.name,
    image: fn.image,
    invocationCount: fn.invocationCount,
    replicas: fn.replicas,
    availableReplicas: fn.availableReplicas,
    labels: fn.labels,
    envVars: fn.envVars,
    createdAt: fn.createdAt,
  }));
  res.json(list);
});

// ─── Get one function ─────────────────────────────────────────
app.get('/system/function/:name', (req, res) => {
  const fn = functions.get(req.params.name);
  if (!fn) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(fn);
});

// ─── Deploy / Update function ─────────────────────────────────
async function deployFunction(req: Request, res: Response): Promise<void> {
  const { service, image, envVars = {}, labels = {}, limits } = req.body;

  if (!service) { res.status(400).json({ error: 'service name required' }); return; }

  const runtime = labels['faas.platform/runtime'] || detectRuntime(image);
  const memoryMb = limits?.memory
    ? parseInt(limits.memory.replace(/[^0-9]/g, ''), 10)
    : config.functionMemoryMb;

  // Source code is passed via envVars.__SOURCE_CODE (set by deployment service)
  const sourceCode = envVars.__SOURCE_CODE || getDefaultHandler(runtime);
  const cleanEnv = { ...envVars };
  delete cleanEnv.__SOURCE_CODE;

  try {
    // Build dir
    const buildDir = path.join('/tmp', `faas-build-${uuidv4()}`);
    fs.mkdirSync(buildDir, { recursive: true });

    // Build image
    const imageTag = await buildFunctionImage(service, runtime, sourceCode, buildDir);

    // Start container
    const container = await startFunctionContainer(service, imageTag, cleanEnv, memoryMb);

    // Register
    const record: FunctionRecord = {
      name: service,
      image: imageTag,
      runtime,
      envVars: cleanEnv,
      labels,
      memory: memoryMb,
      replicas: 1,
      invocationCount: 0,
      availableReplicas: 1,
      createdAt: new Date().toISOString(),
    };
    functions.set(service, record);
    saveRegistry();

    // Cleanup build dir
    fs.rmSync(buildDir, { recursive: true, force: true });

    logger.info({ service, imageTag, host: container.host }, 'Function deployed');
    res.status(200).json({ status: 'deployed', service, image: imageTag });
  } catch (err) {
    logger.error({ service, err: (err as Error).message }, 'Deploy failed');
    res.status(500).json({ error: (err as Error).message });
  }
}

app.post('/system/functions', deployFunction);
app.put('/system/functions', deployFunction);

// ─── Delete function ──────────────────────────────────────────
app.delete('/system/functions', async (req, res) => {
  const { functionName } = req.body;
  if (!functionName) { res.status(400).json({ error: 'functionName required' }); return; }

  await stopFunctionContainer(functionName);
  functions.delete(functionName);
  saveRegistry();

  res.status(200).json({ status: 'deleted' });
});

// ─── Scale function ───────────────────────────────────────────
app.post('/system/scale-function/:name', async (req, res) => {
  const { name } = req.params;
  const { replicas } = req.body;
  const fn = functions.get(name);
  if (!fn) { res.status(404).json({ error: 'Not found' }); return; }

  await scaleFunctionContainer(name, replicas);
  fn.replicas = replicas;
  saveRegistry();

  res.status(200).json({ status: 'scaled', replicas });
});

// ─── Get logs ─────────────────────────────────────────────────
app.get('/system/logs', async (req, res) => {
  const name = req.query.name as string;
  const tail = parseInt(req.query.tail as string || '100', 10);
  if (!name) { res.status(400).json({ error: 'name required' }); return; }

  const logs = await getContainerLogs(name, tail);
  res.type('text/plain').send(logs);
});

// ─── Invoke function ──────────────────────────────────────────
const proxy = httpProxy.createProxyServer({ changeOrigin: true });

proxy.on('error', (err, _req, res) => {
  logger.error({ err: err.message }, 'Proxy error');
  (res as Response).status(502).json({ error: 'Function unavailable' });
});

app.all('/function/:name', async (req, res) => {
  const { name } = req.params;
  const fn = functions.get(name);

  if (!fn) {
    res.status(404).json({ error: `Function "${name}" not found` });
    return;
  }

  // Get or start container
  let container = getFunctionContainer(name);
  if (!container) {
    try {
      container = await startFunctionContainer(name, fn.image, fn.envVars, fn.memory);
      // Give container 2s to start
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      res.status(503).json({ error: 'Failed to start function container' });
      return;
    }
  }

  fn.invocationCount++;
  saveRegistry();

  const target = `http://${container.host}:${container.port}`;
  logger.debug({ name, target }, 'Proxying invocation');

  proxy.web(req, res, { target });
});

// ─── Start ────────────────────────────────────────────────────
const server = http.createServer(app);

loadRegistry();

async function start() {
  try {
    await pingDocker();
  } catch {
    logger.error('Docker daemon not reachable; refusing to start function-runner');
    process.exit(1);
  }
  server.listen(config.port, () => {
    logger.info({ port: config.port }, '🚀 FaaS Function Runner started');
  });
}

void start();

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });

// ─── Helpers ──────────────────────────────────────────────────
function detectRuntime(image: string): string {
  if (image.includes('python')) return 'PYTHON3';
  if (image.includes('go') || image.includes('golang')) return 'GO119';
  return 'NODE18';
}

function getDefaultHandler(runtime: string): string {
  const defaults: Record<string, string> = {
    NODE18:  `module.exports = async (event, context) => context.status(200).succeed({ message: 'Hello from Node.js!', ts: Date.now() });`,
    PYTHON3: `def handle(event, context):\n    import json\n    return {"statusCode": 200, "body": json.dumps({"message": "Hello from Python!"})}`,
    GO119:   `package handler\nimport ("encoding/json";"net/http")\nfunc Handle(w http.ResponseWriter, r *http.Request) { w.Header().Set("Content-Type","application/json"); json.NewEncoder(w).Encode(map[string]string{"message":"Hello from Go!"}) }`,
  };
  return defaults[runtime] || defaults.NODE18;
}
