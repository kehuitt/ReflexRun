import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const assets = new Set([
  '/docs/playground/index.html',
  '/docs/playground/app.js',
  '/docs/playground/scenarios.js',
  '/docs/playground/style.css',
  '/docs/demo.mp4',
  '/docs/demo-poster.jpg',
  '/docs/logo.svg',
  '/benchmarks/showcase.json',
  '/benchmarks/capabilities.json',
  '/LICENSE',
]);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};
const port = Number(process.env.REFLEXRUN_DEMO_PORT ?? 4317);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error('REFLEXRUN_DEMO_PORT must be an integer between 0 and 65535.');

const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method ?? '')) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path === '/' || path === '/docs/playground') {
    response.writeHead(302, { Location: '/docs/playground/' }).end();
    return;
  }
  if (path === '/favicon.ico') {
    response.writeHead(204).end();
    return;
  }
  const asset = path === '/docs/playground/' ? '/docs/playground/index.html' : path;
  if (!assets.has(asset)) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const data = await readFile(new URL('..' + asset, import.meta.url));
    let start = 0,
      end = data.length - 1;
    const range = request.headers.range;
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, data.length - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      }
      if (
        !match ||
        !(match[1] || match[2]) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= data.length
      ) {
        response.writeHead(416, { 'Content-Range': `bytes */${data.length}` }).end();
        return;
      }
    }
    const body = data.subarray(start, end + 1);
    response.writeHead(range ? 206 : 200, {
      'Content-Type': mime[extname(asset)] ?? 'text/plain; charset=utf-8',
      'Content-Length': body.length,
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {}),
      'Cache-Control': 'no-cache',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(500).end('Demo assets are missing. Use a complete ReflexRun checkout.');
  }
});
server.on('error', (error) => {
  process.stderr.write(`Demo server: ${error.message}\n`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    `ReflexRun demo: http://127.0.0.1:${server.address().port}/docs/playground/\n`,
  );
});
