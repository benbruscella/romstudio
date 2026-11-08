import { createServer } from 'node:http';
import { realpath, lstat } from 'node:fs/promises';
import { resolve, join, sep, extname } from 'node:path';
import { Diagnostic, sha256 } from '../core.js';
import { readBounded } from '../files.js';

/** Serve only the verified export's declared files on loopback. Trial media,
 * analysis outputs and adjacent workspace files are never part of this view. */
async function loadExport(root: string, manifestBytes: Buffer) {
  const manifest = JSON.parse(manifestBytes.toString()) as {
    files: Record<string, string>;
    verification: { referenceReplay: string };
    routing?: { basePath: string; paths: string[] };
  };
  if (
    manifest.verification?.referenceReplay !== 'passed' ||
    !manifest.files ||
    Object.keys(manifest.files).length > 4096
  ) {
    throw new Diagnostic('WEB_MANIFEST', 'Expected a verified static export.');
  }
  const files = new Map<string, Buffer>();
  files.set('/manifest.json', manifestBytes);
  for (const [relative, hash] of Object.entries(manifest.files)) {
    const path = resolve(root, relative);
    if (
      !path.startsWith(root + sep) ||
      relative.includes('\\') ||
      relative.split('/').some((part) => part === '..' || part.startsWith('.')) ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      (await lstat(path)).isSymbolicLink() ||
      !(await realpath(path)).startsWith(root + sep)
    ) {
      throw new Diagnostic('WEB_FILE', 'Export contains an unsafe file path.');
    }
    const bytes = await readBounded(path, 16777216);
    if (sha256(bytes) !== hash) {
      throw new Diagnostic(
        'WEB_HASH',
        `Changed export file: ${relative}. Run npm run build to rebuild.`,
      );
    }
    files.set('/' + relative, bytes);
  }
  return { files, routing: manifest.routing, identity: sha256(manifestBytes) };
}

export async function serveWeb(directory: string, port = 4173) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Diagnostic('WEB_PORT', 'Port must be 0–65535.');
  }
  const root = await realpath(resolve(directory));
  let bundle = await loadExport(root, await readBounded(join(root, 'manifest.json'), 1048576));
  let refreshing: Promise<void> | undefined;
  const refresh = async (): Promise<void> => {
    const bytes = await readBounded(join(root, 'manifest.json'), 1048576);
    if (sha256(bytes) === bundle.identity) {
      return;
    }
    if (!refreshing) {
      refreshing = loadExport(root, bytes)
        .then((next) => {
          bundle = next;
        })
        .finally(() => {
          refreshing = undefined;
        });
    }
    await refreshing;
  };
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ts': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
  };
  const server = createServer(async (request, response) => {
    let path: string;
    try {
      const target = request.url ?? '/';
      if (!target.startsWith('/')) {
        throw new Error('Expected an origin-relative request path.');
      }
      // Concatenate the fixed origin so //file stays a path, rather than
      // being interpreted as a different URL host and falling back to /.
      path = decodeURIComponent(new URL('http://127.0.0.1' + target).pathname);
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405);
      response.end();
      return;
    }
    const basePath = bundle.routing?.basePath ?? '/';
    if (basePath !== '/' && path.startsWith(basePath)) {
      path = '/' + path.slice(basePath.length);
    }
    if (path.endsWith('/')) {
      path += 'index.html';
    }
    const route = path.replace(/^\//, '').replace(/\/index\.html$/, '');
    if (bundle.routing?.paths.includes(route) && !bundle.files.has(path)) {
      path = '/index.html';
    }
    // A rebuild publishes its manifest last. Adopt the entire verified bundle
    // together, so refreshing the page cannot silently retain an old export.
    if (path.endsWith('/index.html') || path === '/manifest.json') {
      try {
        await refresh();
      } catch {
        response.writeHead(503, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end('The export is changing or unverified. Rebuild ROM Studio and refresh.');
        return;
      }
    }
    const body = bundle.files.get(path);
    if (!body) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveReady);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Preview server has no TCP address.');
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}${bundle.routing?.basePath ?? '/'}`,
    root,
  };
}
