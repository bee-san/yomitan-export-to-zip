#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal static server for local development and browser tests. Serves the
// repository root on the loopback interface only.

import {createServer} from 'node:http';
import {createReadStream, statSync} from 'node:fs';
import {dirname, extname, join, normalize, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8765);
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.zip': 'application/zip',
};

export function startServer(port = PORT) {
    const server = createServer((req, res) => {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
        let file = join(ROOT, rel);
        if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
        try {
            const st = statSync(file);
            if (st.isDirectory()) file = join(file, 'index.html');
            const stat = statSync(file);
            res.writeHead(200, {
                'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
                'Content-Length': stat.size,
                'Cache-Control': 'no-store',
            });
            createReadStream(file).pipe(res);
        } catch {
            res.writeHead(404, {'Content-Type': 'text/plain'});
            res.end('not found');
        }
    });
    return new Promise((resolveStarted) => {
        server.listen(port, '127.0.0.1', () => resolveStarted(server));
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    startServer().then((server) => {
        const {port} = server.address();
        console.log(`serving ${ROOT} at http://127.0.0.1:${port}/`);
    });
}
