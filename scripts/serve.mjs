#!/usr/bin/env node

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number.parseInt(process.env.PORT ?? '3000', 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
};

function setSecurityHeaders(response) {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

const server = createServer((request, response) => {
  setSecurityHeaders(response);

  if (request.url === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }

  const requestedPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = normalize(join(root, requestedPath));
  if (relative(root, filePath).startsWith('..')) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  let fileStats;
  try {
    fileStats = statSync(filePath);
  } catch {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  if (!fileStats.isFile()) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  response.setHeader('Content-Type', contentTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream');
  response.setHeader('Content-Length', fileStats.size);
  response.setHeader('Cache-Control', requestedPath === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable');
  response.writeHead(200);

  if (request.method === 'HEAD') response.end();
  else createReadStream(filePath).pipe(response);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`VoxeLand listening on 0.0.0.0:${port}`);
});
