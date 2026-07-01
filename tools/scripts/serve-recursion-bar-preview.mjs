import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const host = '127.0.0.1';
const htmlPath = resolve(process.argv[2] || '.tmp/recursion-bar-preview.html');
const preferredPort = Number(process.argv[3] || process.env.PORT || 63494);
const statusPath = resolve('.tmp/recursion-preview-server.json');

if (!existsSync(htmlPath)) {
  console.error(`Preview file not found: ${htmlPath}`);
  process.exit(1);
}

function writeStatus(port) {
  mkdirSync(dirname(statusPath), { recursive: true });
  writeFileSync(statusPath, JSON.stringify({
    url: `http://${host}:${port}/`,
    filePath: htmlPath,
    startedAt: new Date().toISOString()
  }, null, 2));
}

function start(port) {
  const server = createServer((request, response) => {
    const path = new URL(request.url || '/', `http://${host}:${port}`).pathname;
    if (path !== '/' && path !== '/index.html') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8'
    });
    response.end(readFileSync(htmlPath, 'utf8'));
  });

  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && port < preferredPort + 30) {
      start(port + 1);
      return;
    }
    throw error;
  });

  server.listen(port, host, () => {
    writeStatus(port);
    console.log(`Recursion bar preview: http://${host}:${port}/`);
  });
}

start(preferredPort);
