#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generates the real-format fixtures under test/fixtures/ by running Yomitan's
// own dictionary importer (ext/js/dictionary/dictionary-importer.js) against
// fake-indexeddb, then exporting the resulting "dict" database with the exact
// library Yomitan ships for Settings > Backup > "Export Dictionary Collection"
// (ext/lib/dexie.js, which bundles dexie + dexie-export-import). Nothing about
// the export format is hand-written here: the bytes come from Yomitan's code.
//
// Usage:
//   YOMITAN_DIR=/path/to/yomitan/checkout node tools/generate-fixtures.mjs
//
// YOMITAN_DIR must have `npm ci` and `npm run build:libs` already done so that
// ext/lib/dexie.js and node_modules/fake-indexeddb exist.

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const OUT_DIR = join(REPO, 'test', 'fixtures');

const YOMITAN_DIR = process.env.YOMITAN_DIR ?? '';
if (!YOMITAN_DIR || !existsSync(join(YOMITAN_DIR, 'ext', 'lib', 'dexie.js'))) {
    console.error('YOMITAN_DIR must point at a Yomitan checkout with ext/lib/dexie.js built (npm ci && npm run build:libs).');
    process.exit(2);
}

// Fixed clock so regenerating fixtures yields byte-identical files (importDate).
const FIXED_NOW = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
Date.now = () => FIXED_NOW;

const yomitanRequire = createRequire(join(YOMITAN_DIR, 'package.json'));
const {IDBFactory, IDBKeyRange} = yomitanRequire('fake-indexeddb');
const ext = (p) => pathToFileURL(join(YOMITAN_DIR, 'ext', p)).href;
globalThis.IDBKeyRange = IDBKeyRange;
globalThis.self = {constructor: {name: 'Window'}};
const {DictionaryDatabase} = await import(ext('js/dictionary/dictionary-database.js'));
const {DictionaryImporter} = await import(ext('js/dictionary/dictionary-importer.js'));
const {Dexie} = await import(ext('lib/dexie.js'));
const {createDictionaryArchiveData} = await import(pathToFileURL(join(YOMITAN_DIR, 'dev', 'dictionary-archive-util.js')).href);
const {ZipWriter, BlobWriter, TextReader, Uint8ArrayReader} = await import(ext('lib/zip.js'));
// zip.js decides at import time whether Worker exists; define the stub only now so
// its codecs run inline (Node has CompressionStream) while DictionaryDatabase.prepare()
// can still construct its (unused) worker.
globalThis.Worker = class { addEventListener() {} terminate() {} postMessage() {} };

const yomitanCommit = execFileSync('git', ['-C', YOMITAN_DIR, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
const yomitanPkg = JSON.parse(readFileSync(join(YOMITAN_DIR, 'package.json'), 'utf8'));
const lockfile = JSON.parse(readFileSync(join(YOMITAN_DIR, 'package-lock.json'), 'utf8'));
const lockedVersion = (name) => lockfile.packages?.[`node_modules/${name}`]?.version ?? 'unknown';

// dexie-export-import finalizes Blob-typed values through FileReader, which Node lacks.
globalThis.FileReader ??= class FileReader {
    readAsArrayBuffer(blob) { blob.arrayBuffer().then((result) => { this.result = result; this.onload?.({target: this}); }, (error) => this.onerror?.({target: {error}})); }
    readAsText(blob) { blob.text().then((result) => { this.result = result; this.onload?.({target: this}); }, (error) => this.onerror?.({target: {error}})); }
};

/** Minimal PNG/GIF/JPEG dimension sniffing so stored width/height match what a browser reports. */
function imageDimensions(bytes) {
    const b = new Uint8Array(bytes);
    if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        return {width: dv.getUint32(16), height: dv.getUint32(20)};
    }
    if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
        return {width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8)};
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
        let i = 2;
        while (i + 9 < b.length) {
            if (b[i] !== 0xff) { i++; continue; }
            const marker = b[i + 1];
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return {height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8]};
            }
            i += 2 + ((b[i + 2] << 8) | b[i + 3]);
        }
    }
    return {width: 1, height: 1};
}

class MediaLoader {
    async getImageDetails(content) {
        const {width, height} = imageDimensions(content);
        return {content, width, height};
    }
}

/** @param {Array<[string, string|Uint8Array]>} files */
async function zipFromFiles(files) {
    const writer = new ZipWriter(new BlobWriter('application/zip'));
    for (const [name, data] of files) {
        await writer.add(name, typeof data === 'string' ? new TextReader(data) : new Uint8ArrayReader(data));
    }
    const blob = await writer.close();
    return new Uint8Array(await blob.arrayBuffer());
}

const toArrayBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

async function freshDatabase() {
    globalThis.indexedDB = new IDBFactory();
    const database = new DictionaryDatabase();
    await database.prepare();
    return database;
}

async function importArchive(database, archiveBytes, label) {
    const importer = new DictionaryImporter(new MediaLoader());
    const {errors, result} = await importer.importDictionary(database, toArrayBuffer(archiveBytes), {
        prefixWildcardsSupported: true,
        yomitanVersion: '0.0.0.0',
    });
    if (errors.length > 0 || result === null || !result.importSuccess) {
        throw new Error(`import failed for ${label}: ${JSON.stringify(errors.map((e) => e.message))}`);
    }
    return result;
}

async function exportDatabase() {
    // Mirrors BackupController._exportDatabase(): dynamic Dexie open + db.export().
    Dexie.dependencies.indexedDB = globalThis.indexedDB;
    Dexie.dependencies.IDBKeyRange = IDBKeyRange;
    const db = new Dexie('dict');
    await db.open();
    const blob = await db.export({});
    db.close();
    return new Uint8Array(await blob.arrayBuffer());
}

// --- Source dictionaries -----------------------------------------------------

const sources = {};

sources.validDictionary1 = async () => {
    const dir = join(YOMITAN_DIR, 'test', 'data', 'dictionaries', 'valid-dictionary1');
    const buf = await createDictionaryArchiveData(dir, 'valid-dictionary1');
    return {bytes: new Uint8Array(buf), origin: `yomitan test/data/dictionaries/valid-dictionary1 (commit ${yomitanCommit})`};
};

// The same test dictionary imported under another title (Yomitan keys everything
// by title, so this is the realistic "two dictionaries with identical rows" case).
sources.validDictionary1Copy = async () => {
    const dir = join(YOMITAN_DIR, 'test', 'data', 'dictionaries', 'valid-dictionary1');
    const buf = await createDictionaryArchiveData(dir, 'valid-dictionary1 (copy)');
    return {bytes: new Uint8Array(buf), origin: `yomitan test/data/dictionaries/valid-dictionary1 with title renamed (commit ${yomitanCommit})`};
};

// Synthesized: format 1 term/kanji banks, index with obsolete tagMeta, no styles.
sources.legacyV1 = async () => {
    const files = [
        ['index.json', JSON.stringify({
            title: 'Legacy V1 Dictionary',
            version: 1,
            revision: 'v1-2026',
            author: 'fixture',
            tagMeta: {
                n: {category: 'partOfSpeech', order: -3, notes: 'noun', score: 0},
                arch: {category: '', order: 0, notes: 'archaic', score: -4},
            },
        })],
        // Current Yomitan's v1 schemas cap term rows at 5 items and kanji rows at
        // 4 items (dictionary-term-bank-v1-schema.json, dictionary-kanji-bank-v1-schema.json),
        // so glossaries/meanings cannot be present in an importable v1 archive.
        ['term_bank_1.json', JSON.stringify([
            ['古語', 'こご', 'n arch', '', 5],
            ['ひらがな', '', 'n', '', 1],
        ])],
        ['kanji_bank_1.json', JSON.stringify([
            ['古', 'コ', 'ふる.い', 'jouyou'],
        ])],
    ];
    return {bytes: await zipFromFiles(files), origin: 'synthesized by tools/generate-fixtures.mjs (format 1 banks, obsolete index.tagMeta)'};
};

// Synthesized: updatable dictionary with every optional index field, frequency
// and pitch meta, kanji meta, and both `text` and `image` glossary objects.
sources.richMeta = async () => {
    const png = readFileSync(join(YOMITAN_DIR, 'test', 'data', 'dictionaries', 'valid-dictionary1', 'aosaba_auto.png'));
    const files = [
        ['index.json', JSON.stringify({
            title: 'Rich Metadata Dictionary',
            format: 3,
            revision: 'rich.2026.01',
            sequenced: true,
            author: 'fixture author',
            url: 'https://example.invalid/rich',
            description: 'Exercises every optional index field.\nSecond line.',
            attribution: 'CC0',
            sourceLanguage: 'ja',
            targetLanguage: 'en',
            frequencyMode: 'rank-based',
            isUpdatable: true,
            indexUrl: 'https://example.invalid/rich/index.json',
            downloadUrl: 'https://example.invalid/rich/rich.zip',
            minimumYomitanVersion: '24.0.0.0',
        })],
        ['term_bank_1.json', JSON.stringify([
            ['画像', 'がぞう', 'n', '', 10, [
                {type: 'text', text: 'image (text-object glossary)'},
                {type: 'image', path: 'img/aosaba.png', width: 32, height: 16, title: 'aosaba', description: 'a fish', pixelated: true, collapsed: false, collapsible: true},
            ], 1, 'P'],
            ['構造', 'こうぞう', '', 'v1', 3, [
                {type: 'structured-content', content: [
                    {tag: 'div', style: {fontStyle: 'italic'}, data: {content: 'x'}, content: [
                        'structure ',
                        {tag: 'img', path: 'img/aosaba.png', width: 8, height: 4, sizeUnits: 'em', verticalAlign: 'middle', border: '1px solid red', borderRadius: '2px', alt: 'alt text', background: false, imageRendering: 'pixelated', appearance: 'monochrome'},
                        {tag: 'a', href: '?query=構造', content: 'link'},
                    ]},
                ]},
            ], 2, ''],
            ['同形', 'どうけい', '', '', 0, ['same expression as the next row'], 3, ''],
            ['同形', 'どうけい', '', '', 0, ['second row for the same term and reading'], 3, ''],
        ])],
        ['term_meta_bank_1.json', JSON.stringify([
            ['画像', 'freq', 12],
            ['画像', 'freq', {value: 12, displayValue: '12th'}],
            ['画像', 'freq', {reading: 'がぞう', frequency: {value: 13, displayValue: '13㋕'}}],
            ['構造', 'pitch', {reading: 'こうぞう', pitches: [{position: 0}, {position: 3, nasal: 2, devoice: [1]}, {position: 1, tags: ['P']}]}],
            ['構造', 'ipa', {reading: 'こうぞう', transcriptions: [{ipa: 'koːzoː', tags: ['P']}]}],
        ])],
        ['kanji_bank_1.json', JSON.stringify([
            ['画', 'ガ カク', 'えが.く', 'jouyou', ['picture', 'drawing'], {strokes: '8', grade: '2'}],
        ])],
        ['kanji_meta_bank_1.json', JSON.stringify([
            ['画', 'freq', 480],
            ['画', 'freq', {value: 480, displayValue: '480位'}],
        ])],
        ['tag_bank_1.json', JSON.stringify([
            ['n', 'partOfSpeech', -3, 'noun', 0],
            ['P', 'popular', -10, 'popular term', 10],
            ['jouyou', 'frequent', -5, 'jōyō kanji', 0],
        ])],
        ['styles.css', '.gloss-image { border: 1px solid #333; }\n[data-sc-content="x"] { color: teal; }\n'],
        ['img/aosaba.png', new Uint8Array(png)],
        ['img/unreferenced.png', new Uint8Array(png)],
    ];
    return {bytes: await zipFromFiles(files), origin: 'synthesized by tools/generate-fixtures.mjs (updatable index, freq/pitch/ipa meta, kanji meta, text/image/structured glossaries, unreferenced media file)'};
};

// Synthesized: frequency-only dictionary (no term banks), the common "freq list" shape.
sources.freqOnly = async () => {
    const rows = [];
    for (let i = 1; i <= 300; i++) rows.push([`語${i}`, 'freq', {value: i, displayValue: `${i}`}]);
    const files = [
        ['index.json', JSON.stringify({title: 'Frequency Only', format: 3, revision: 'f1', frequencyMode: 'occurrence-based'})],
        ['term_meta_bank_1.json', JSON.stringify(rows.slice(0, 200))],
        ['term_meta_bank_2.json', JSON.stringify(rows.slice(200))],
    ];
    return {bytes: await zipFromFiles(files), origin: 'synthesized by tools/generate-fixtures.mjs (term_meta only, two banks)'};
};

// Synthesized: a dictionary title with characters that are unsafe in file names.
sources.awkwardTitle = async () => {
    const files = [
        ['index.json', JSON.stringify({title: '  Weird/Title: "quotes" <tags> ..\\..  ', format: 3, revision: 'w'})],
        ['term_bank_1.json', JSON.stringify([['変', 'へん', '', '', 0, ['strange'], 0, '']])],
    ];
    return {bytes: await zipFromFiles(files), origin: 'synthesized by tools/generate-fixtures.mjs (title with path separators, quotes, angle brackets, dot segments, surrounding whitespace)'};
};

// --- Fixture builds ----------------------------------------------------------

const builds = [
    {name: 'single-valid-dictionary1', sources: ['validDictionary1']},
    {name: 'single-rich-meta', sources: ['richMeta']},
    {name: 'single-legacy-v1', sources: ['legacyV1']},
    {name: 'empty-database', sources: []},
    {name: 'multi-six', sources: ['validDictionary1', 'richMeta', 'freqOnly', 'awkwardTitle', 'legacyV1', 'validDictionary1Copy']},
];

mkdirSync(OUT_DIR, {recursive: true});
const provenance = [];
const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');

for (const build of builds) {
    const database = await freshDatabase();
    const imported = [];
    for (const key of build.sources) {
        const source = await sources[key]();
        if (source === null) { console.warn(`skipping ${key} (missing directory)`); continue; }
        const result = await importArchive(database, source.bytes, key);
        imported.push({key, title: result.title, origin: source.origin, zipSha256: sha256(source.bytes), counts: result.counts});
    }
    await database.close();
    const json = await exportDatabase();
    const fileName = `${build.name}.json`;
    writeFileSync(join(OUT_DIR, fileName), json);
    provenance.push({fileName, bytes: json.byteLength, sha256: sha256(json), imported});
    console.log(`${fileName}: ${json.byteLength} bytes, ${imported.length} dictionaries`);
}

const lines = [
    '# Fixture provenance',
    '',
    'Generated by `tools/generate-fixtures.mjs`. Do not edit the JSON files by hand.',
    '',
    '## Authoritative sources',
    '',
    `- Yomitan checkout: https://github.com/yomidevs/yomitan at commit \`${yomitanCommit}\` (package version ${yomitanPkg.version}).`,
    '- Export code path: `ext/js/pages/settings/backup-controller.js` `_exportDatabase()` opens the `dict` IndexedDB database with Dexie and calls `db.export()`; the file is named `yomitan-dictionaries-<date>.json`.',
    `- Export library: \`ext/lib/dexie.js\` built by \`npm run build:libs\` from \`dexie@${lockedVersion('dexie')}\` and \`dexie-export-import@${lockedVersion('dexie-export-import')}\` (format \`{"formatName":"dexie","formatVersion":1}\`, rows encoded with typeson).`,
    '- Database schema: `ext/js/dictionary/dictionary-database.js` (version 60; stores `terms`, `kanji`, `tagMeta`, `dictionaries`, `termMeta`, `kanjiMeta`, `media`).',
    '- Row shapes: `ext/js/dictionary/dictionary-importer.js` (`_convert*BankEntry*`, `_createSummary`, `_createImageData`, `_getImageMedia`).',
    `- Importer run in Node with \`fake-indexeddb@${lockedVersion('fake-indexeddb')}\`; image dimensions sniffed from PNG/GIF/JPEG headers to mirror the browser's naturalWidth/naturalHeight.`,
    `- Clock pinned to ${new Date(FIXED_NOW).toISOString()} so \`importDate\` is stable.`,
    '',
    '## Files',
    '',
];
for (const p of provenance) {
    lines.push(`### \`${p.fileName}\``, '', `- ${p.bytes} bytes, sha256 \`${p.sha256}\``, `- dictionaries: ${p.imported.length}`);
    for (const d of p.imported) {
        lines.push(`  - **${d.title}** — ${d.origin}; source zip sha256 \`${d.zipSha256}\`; counts ${JSON.stringify(d.counts)}`);
    }
    lines.push('');
}
writeFileSync(join(OUT_DIR, 'PROVENANCE.md'), lines.join('\n'));
console.log('wrote PROVENANCE.md');
