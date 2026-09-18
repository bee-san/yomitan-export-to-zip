// SPDX-License-Identifier: GPL-3.0-or-later
//
// Conversion worker. Receives a File, streams it, and posts results back.
// Archive bytes are wrapped in Blobs so the main thread receives references
// rather than copies.

import {convertExport, scanExport} from './convert.js';

let current = null;

function serializeError(error) {
    return {name: error?.name ?? 'Error', message: error?.message ?? String(error)};
}

self.addEventListener('message', async (event) => {
    const {id, type, file} = event.data;
    // A new request supersedes any in-flight one (the page only ever runs one at a time).
    current?.abort();
    const controller = new AbortController();
    current = controller;
    try {
        if (type === 'scan') {
            const result = await scanExport(file, {
                signal: controller.signal,
                onBytes: (bytes) => self.postMessage({id, type: 'progress', phase: 'scan', bytes}),
            });
            self.postMessage({id, type: 'scanned', header: result.header, dictionaries: result.dictionaries, warnings: result.warnings, totalRows: result.totalRows});
        } else if (type === 'convert') {
            let lastPost = 0;
            const result = await convertExport(file, {
                signal: controller.signal,
                onProgress: (p) => {
                    const now = Date.now();
                    if (now - lastPost < 100) return;
                    lastPost = now;
                    self.postMessage({id, type: 'progress', phase: 'convert', bytes: p.bytes, rows: p.rows, table: p.table});
                },
            });
            const archives = result.archives.map((a) => ({
                key: a.key,
                title: a.title,
                blob: new Blob(a.parts, {type: 'application/zip'}),
                size: a.size,
                zip64: a.zip64,
                entryNames: a.entryNames,
                rowCounts: a.rowCounts,
                mediaBytes: a.mediaBytes,
                sourceFormat: a.sourceFormat,
                format: a.format,
                warnings: a.warnings,
            }));
            self.postMessage({id, type: 'converted', header: result.header, archives, warnings: result.warnings});
        } else {
            throw new Error(`Unknown worker request "${type}"`);
        }
    } catch (error) {
        if (controller.signal.aborted) return;
        self.postMessage({id, type: 'error', error: serializeError(error)});
    } finally {
        if (current === controller) current = null;
    }
});
