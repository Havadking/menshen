import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { handleApi } from './api.js';
import { createLogger } from '../logger.js';

const log = createLogger('http');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(res, root, pathname) {
  const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
  const file = join(root, rel);
  if (!file.startsWith(root + sep) && file !== root) return false;
  let st;
  try {
    st = statSync(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
  });
  createReadStream(file).pipe(res);
  return true;
}

/**
 * @param {{store, engine, config, publicDir: string, startedAt: number}} ctx
 */
export function createHttpServer(ctx) {
  const root = resolve(ctx.publicDir);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (await handleApi(req, res, url, ctx)) return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (serveStatic(res, root, url.pathname)) return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (e) {
      log.error(`处理 ${req.method} ${req.url} 出错`, e);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    }
  });
  return server;
}
