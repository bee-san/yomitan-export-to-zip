#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Narrow Yomitan import-compatibility check. For every fixture export, convert
// it with this project, then feed each produced archive to Yomitan's own
// DictionaryImporter (running in Node on fake-indexeddb). The import must
// succeed with no errors, and re-exporting that database with Yomitan's own
// export library must reproduce the fixture's rows (ignoring only import
// timestamps and auto-increment ids). This is an import check only; it does
// not compare Yomitan against any other product.
//
// Usage: YOMITAN_DIR=/path/to/yomitan node test/roundtrip/yomitan-import.mjs

import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

import {archiveFileName, convertExport, scanExport} from '../../src/convert.js';
import {readExport} from '../../src/dexie-export.js';
import {concatParts} from '../../src/zip-writer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', 'fixtures');
const YOMITAN_DIR = process.env.YOMITAN_DIR ?? '';
if (!YOMITAN_DIR || !existsSync(join(YOMITAN_DIR, 'ext', 'lib', 'dexie.js'))) {
    console.error('YOMITAN_DIR must point at a Yomitan checkout with ext/lib/dexie.js built (npm ci && npm run build:libs).');
    process.exit(2);
}

const yomitanRequire = createRequire(join(YOMITAN_DIR, 'package.json'));
const {IDBFactory, IDBKeyRange} = yomitanRequire('fake-indexeddb');
const ext = (p) => pathToFileURL(join(YOMITAN_DIR, 'ext', p)).href;
globalThis.IDBKeyRange = IDBKeyRange;
globalThis.self = {constructor: {name: 'Window'}};
globalThis.FileReader ??= class FileReader {
    readAsArrayBuffer(blob) { blob.arrayBuffer().then((result) => { this.result = result; this.onload?.({target: this}); }, (error) => this.onerror?.({target: {error}})); }
    readAsText(blob) { blob.text().then((result) => { this.result = result; this.onload?.({target: this}); }, (error) => this.onerror?.({target: {error}})); }
};
const {DictionaryDatabase} = await import(ext('js/dictionary/dictionary-database.js'));
const {DictionaryImporter} = await import(ext('js/dictionary/dictionary-importer.js'));
const {Dexie} = await import(ext('lib/dexie.js'));
globalThis.Worker = class { addEventListener() {} terminate() {} postMessage() {} };

const yomitanCommit = execFileSync('git', ['-C', YOMITAN_DIR, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();

function imageDimensions(bytes) {
    const b = new Uint8Array(bytes);
    if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50) {
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        return {width: dv.getUint32(16), height: dv.getUint32(20)};
    }
    if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49) return {width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8)};
    return {width: 1, height: 1};
}
class MediaLoader {
    async getImageDetails(content) {
        return {content, ...imageDimensions(content)};
    }
}

async function collectRows(source) {
    /** @type {Map<string, unknown[]>} */
    const tables = new Map();
    await readExport(source, {
        onRow(table, key, value) {
            if (!tables.has(table)) tables.set(table, []);
            tables.get(table).push(normalizeRow(table, value));
        },
    });
    return tables;
}

function normalizeRow(table, value) {
    const row = {...value};
    delete row.id;
    if (table === 'dictionaries') {
        delete row.importDate;
        // Format 1 sources are written as format 3 archives.
        if (row.version === 1) row.version = 3;
    }
    if (table === 'terms' && !('sequence' in row)) {
        // Format 1 rows gain the neutral sequence/termTags that format 3 requires.
        row.sequence = 0;
        row.termTags = '';
    }
    if (table === 'kanji' && !('stats' in row)) row.stats = {}; // format 1 kanji rows have no stats
    if (table === 'media') row.content = Buffer.from(row.content).toString('base64');
    // Key order differs between format 1 and format 3 rows; compare canonically.
    return Object.fromEntries(Object.keys(row).sort().map((k) => [k, row[k]]));
}

const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
let failures = 0;
const report = [];
for (const file of files) {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, file)));
    const {dictionaries} = await scanExport(bytes);
    const {archives} = await convertExport(bytes);
    const originalRows = await collectRows(bytes);

    globalThis.indexedDB = new IDBFactory();
    const database = new DictionaryDatabase();
    await database.prepare();
    const importer = new DictionaryImporter(new MediaLoader());
    const imported = [];
    for (const [i, archive] of archives.entries()) {
        const zip = concatParts(archive.parts);
        const {errors, result} = await importer.importDictionary(database, zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength), {
            prefixWildcardsSupported: true,
            yomitanVersion: '0.0.0.0',
        });
        const ok = errors.length === 0 && result !== null && result.importSuccess === true;
        if (!ok) failures++;
        imported.push({file: archiveFileName(i + 1, archives.length, archive.title), title: archive.title, ok, errors: errors.map((e) => e.message), counts: result?.counts});
        if (ok) {
            // Term lookup through Yomitan's own query path for the first term of the archive.
            const terms = originalRows.get('terms')?.filter((r) => r.dictionary === archive.title) ?? [];
            if (terms.length > 0) {
                const matches = await database.findTermsBulk([terms[0].expression], new Set([result.title]), 'exact');
                if (!matches.some((m) => m.term === terms[0].expression)) {
                    failures++;
                    imported[imported.length - 1].lookup = `FAILED for ${terms[0].expression}`;
                } else {
                    imported[imported.length - 1].lookup = `ok (${terms[0].expression}, ${matches.length} match(es))`;
                }
            }
        }
    }
    await database.close();

    // Re-export with Yomitan's library and compare rows with the original fixture.
    Dexie.dependencies.indexedDB = globalThis.indexedDB;
    Dexie.dependencies.IDBKeyRange = IDBKeyRange;
    const db = new Dexie('dict');
    await db.open();
    const blob = await db.export({});
    db.close();
    const reexportedRows = await collectRows(new Uint8Array(await blob.arrayBuffer()));
    const tableDiffs = [];
    for (const table of ['dictionaries', 'terms', 'termMeta', 'kanji', 'kanjiMeta', 'tagMeta', 'media']) {
        const a = JSON.stringify(originalRows.get(table) ?? []);
        const b = JSON.stringify(reexportedRows.get(table) ?? []);
        if (a !== b) tableDiffs.push(table);
    }
    if (tableDiffs.length > 0) failures++;
    report.push({fixture: file, dictionaries: dictionaries.length, archives: archives.length, imported, semanticRoundTrip: tableDiffs.length === 0 ? 'identical rows' : `DIFFERENT: ${tableDiffs.join(', ')}`});
}

console.log(JSON.stringify({yomitanCommit, report}, null, 2));
if (failures > 0) {
    console.error(`FAILED: ${failures} problem(s)`);
    process.exit(1);
}
console.log('YOMITAN_IMPORT_OK');
