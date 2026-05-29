import Docker from 'dockerode';
import { config } from './config';
import { logger } from './logger';
import path from 'path';
import fs from 'fs';
import tar from 'tar-fs';

/**
 * Build a dockerode connection from env config, OS-aware.
 *
 * Priority:
 *   1. DOCKER_HOST=tcp://host:port  → TCP transport
 *   2. DOCKER_SOCKET                → Unix socket or Windows named pipe
 *   3. Platform default             → Windows pipe / unix socket
 */
function buildDockerOptions(): Docker.DockerOptions {
  const host = config.dockerHost.trim();
  if (host) {
    try {
      const url = new URL(host);
      const opts: Docker.DockerOptions = {
        host: url.hostname,
        port: url.port ? parseInt(url.port, 10) : 2375,
        protocol: (url.protocol.replace(':', '') as 'http' | 'https') || 'http',
      };
      logger.info({ host: opts.host, port: opts.port, protocol: opts.protocol }, 'Docker: TCP connection');
      return opts;
    } catch (err) {
      logger.warn({ err, dockerHost: host }, 'Invalid DOCKER_HOST, falling back to socket');
    }
  }
  logger.info({ socketPath: config.dockerSocket }, 'Docker: socket connection');
  return { socketPath: config.dockerSocket };
}

export const docker = new Docker(buildDockerOptions());

/**
 * Verify connectivity to the Docker daemon. Logs and rethrows on failure
 * so callers can decide whether to exit or degrade.
 */
export async function pingDocker(): Promise<void> {
  try {
    await docker.ping();
    const info = await docker.version();
    logger.info(
      { version: info.Version, apiVersion: info.ApiVersion, os: info.Os },
      'Docker daemon reachable'
    );
  } catch (err) {
    logger.error({ err }, 'Docker daemon unreachable — is Docker Desktop running?');
    throw err;
  }
}

export interface FunctionContainer {
  id: string;
  name: string;
  host: string;
  port: number;
  runtime: string;
}

// Track running function containers: functionName → container info
const runningContainers = new Map<string, FunctionContainer>();

/**
 * Build a Docker image for a function from its source code.
 */
export async function buildFunctionImage(
  functionName: string,
  runtime: string,
  sourceCode: string,
  buildDir: string
): Promise<string> {
  const imageTag = `${config.functionImagePrefix}-${functionName}:latest`;

  // Write handler file
  const handlerFile = getHandlerFile(runtime);
  const handlerPath = path.join(buildDir, handlerFile);
  fs.writeFileSync(handlerPath, sourceCode);

  // Write wrapper server + Dockerfile
  writeRuntimeFiles(runtime, buildDir);

  logger.info({ functionName, imageTag, runtime }, 'Building function image');

  // Create tar stream from build dir
  const tarStream = tar.pack(buildDir);

  const stream = await docker.buildImage(tarStream, { t: imageTag });

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => (err ? reject(err) : resolve()),
      (event: { stream?: string; error?: string }) => {
        if (event.stream) logger.debug(event.stream.trim());
        if (event.error) logger.error(event.error);
      }
    );
  });

  logger.info({ imageTag }, 'Image built successfully');
  return imageTag;
}

/**
 * Start a function container and return its address.
 */
export async function startFunctionContainer(
  functionName: string,
  imageTag: string,
  envVars: Record<string, string>,
  memoryMb: number
): Promise<FunctionContainer> {
  // Stop existing container if any
  await stopFunctionContainer(functionName);

  const containerName = `faas-fn-${functionName}`;
  const memBytes = memoryMb * 1024 * 1024;

  const container = await docker.createContainer({
    name: containerName,
    Image: imageTag,
    Env: Object.entries(envVars).map(([k, v]) => `${k}=${v}`),
    ExposedPorts: { [`${config.containerPort}/tcp`]: {} },
    HostConfig: {
      Memory: memBytes,
      MemorySwap: memBytes,
      NetworkMode: config.networkName,
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: {}, // No host port binding — accessed via container name
    },
    Labels: {
      'faas.managed': 'true',
      'faas.function': functionName,
    },
  });

  await container.start();
  const info = await container.inspect();
  const ip = info.NetworkSettings.Networks[config.networkName]?.IPAddress || containerName;

  const fnContainer: FunctionContainer = {
    id: container.id,
    name: containerName,
    host: ip || containerName,
    port: config.containerPort,
    runtime: imageTag,
  };

  runningContainers.set(functionName, fnContainer);
  logger.info({ functionName, containerName, host: fnContainer.host }, 'Function container started');
  return fnContainer;
}

/**
 * Stop and remove a function container.
 */
export async function stopFunctionContainer(functionName: string): Promise<void> {
  const containerName = `faas-fn-${functionName}`;
  try {
    const container = docker.getContainer(containerName);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
    runningContainers.delete(functionName);
    logger.info({ functionName }, 'Function container stopped');
  } catch {
    // Container may not exist — that's fine
  }
}

/**
 * Get the address of a running function container.
 */
export function getFunctionContainer(functionName: string): FunctionContainer | undefined {
  return runningContainers.get(functionName);
}

/**
 * List all running function containers.
 */
export async function listFunctionContainers(): Promise<Docker.ContainerInfo[]> {
  const containers = await docker.listContainers({
    filters: JSON.stringify({ label: ['faas.managed=true'] }),
  });
  return containers;
}

/**
 * Get container logs.
 */
export async function getContainerLogs(functionName: string, tail = 100): Promise<string> {
  const containerName = `faas-fn-${functionName}`;
  try {
    const container = docker.getContainer(containerName);
    const logs = await container.logs({ stdout: true, stderr: true, tail });
    return logs.toString('utf8').replace(/[\x00-\x08\x0e-\x1f]/g, '');
  } catch {
    return '';
  }
}

/**
 * Scale a function by adjusting replica count (simplified: restart with new count).
 */
export async function scaleFunctionContainer(
  functionName: string,
  replicas: number
): Promise<void> {
  logger.info({ functionName, replicas }, 'Scale requested (single-node: no-op for replicas > 1)');
  // In a single-node setup, scaling is informational only
  // For true scaling, use Docker Swarm or Kubernetes
}

// ─── Runtime file generators ──────────────────────────────────

function getHandlerFile(runtime: string): string {
  return { NODE18: 'handler.js', PYTHON3: 'handler.py', GO119: 'handler.go' }[runtime] || 'handler.js';
}

function writeRuntimeFiles(runtime: string, dir: string): void {
  switch (runtime) {
    case 'NODE18':
      fs.writeFileSync(path.join(dir, 'server.js'), NODE_SERVER);
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fn', version: '1.0.0', main: 'server.js' }));
      fs.writeFileSync(path.join(dir, 'Dockerfile'), NODE_DOCKERFILE);
      break;
    case 'PYTHON3':
      fs.writeFileSync(path.join(dir, 'server.py'), PYTHON_SERVER);
      fs.writeFileSync(path.join(dir, 'requirements.txt'), 'flask==3.0.0\n');
      fs.writeFileSync(path.join(dir, 'Dockerfile'), PYTHON_DOCKERFILE);
      break;
    case 'GO119':
      fs.writeFileSync(path.join(dir, 'main.go'), GO_SERVER);
      fs.writeFileSync(path.join(dir, 'go.mod'), 'module function\n\ngo 1.21\n');
      fs.writeFileSync(path.join(dir, 'Dockerfile'), GO_DOCKERFILE);
      break;
  }
}

// ─── Runtime server wrappers ──────────────────────────────────

const NODE_SERVER = `
const http = require('http');
const handler = require('./handler');
const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString();
    const event = {
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: body ? (() => { try { return JSON.parse(body); } catch { return body; } })() : null,
      query: Object.fromEntries(new URL(req.url, 'http://localhost').searchParams),
    };
    const context = {
      status: (code) => ({ succeed: (data) => { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(data)); return data; }, fail: (err) => { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify({error: String(err)})); } }),
    };
    try {
      await handler(event, context);
    } catch (err) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});
server.listen(PORT, () => console.log('Function listening on ' + PORT));
`;

const NODE_DOCKERFILE = `FROM node:18-alpine
WORKDIR /app
COPY package.json .
COPY server.js .
COPY handler.js .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
`;

const PYTHON_SERVER = `
import json, os
from flask import Flask, request, jsonify
import importlib.util, sys

app = Flask(__name__)
spec = importlib.util.spec_from_file_location("handler", "/app/handler.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

@app.route('/', defaults={'path': ''}, methods=['GET','POST','PUT','DELETE','PATCH'])
@app.route('/<path:path>', methods=['GET','POST','PUT','DELETE','PATCH'])
def invoke(path):
    class Event:
        method = request.method
        headers = dict(request.headers)
        body = request.get_data(as_text=True)
        query = dict(request.args)
    class Context: pass
    try:
        result = mod.handle(Event(), Context())
        if isinstance(result, dict):
            status = result.get('statusCode', 200)
            body = result.get('body', '{}')
            return app.response_class(body, status=status, mimetype='application/json')
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 3000)))
`;

const PYTHON_DOCKERFILE = `FROM python:3.11-alpine
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
COPY handler.py .
ENV PORT=3000
EXPOSE 3000
CMD ["python", "server.py"]
`;

const GO_SERVER = `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	fn "function/handler"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" { port = "3000" }
	http.HandleFunc("/", fn.Handle)
	fmt.Println("Function listening on " + port)
	http.ListenAndServe(":"+port, nil)
}
`;

const GO_DOCKERFILE = `FROM golang:1.21-alpine AS build
WORKDIR /go/src/function
COPY go.mod .
COPY main.go .
RUN mkdir -p handler
COPY handler.go handler/handler.go
RUN go build -o /function .

FROM alpine:3.18
COPY --from=build /function /usr/bin/function
ENV PORT=3000
EXPOSE 3000
CMD ["/usr/bin/function"]
`;
