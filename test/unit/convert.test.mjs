// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {ExportFormatError} from '../../src/dexie-export.js';
import {BANK_SIZE, archiveFileName, buildIndex, convertExport, restoreGlossaryItem, sanitizeFileName, scanExport} from '../../src/convert.js';
import {concatParts} from '../../src/zip-writer.js';
import {encode, fixtureBytes, fixtureJson, fixtureNames, makeExport, readZip, schemaErrors, summaryRow, termRow, zipJson} from './helpers.mjs';

const bytesOf = (archive) => concatParts(archive.parts);
const rowsOf = (json, table) => json.data.data.find((t) => t.tableName === table).rows.map((r) => (r.$ ? r.$[1] : r));

// --- file names -------------------------------------------------------------------

test('archiveFileName numbers archives in order and pads to the widest position', () => {
    assert.equal(archiveFileName(1, 6, 'JMdict'), '1-JMdict.zip');
    assert.equal(archiveFileName(6, 6, 'JMdict'), '6-JMdict.zip');
    assert.equal(archiveFileName(1, 12, 'JMdict'), '01-JMdict.zip');
    assert.equal(archiveFileName(12, 12, 'JMdict'), '12-JMdict.zip');
    assert.equal(archiveFileName(7, 120, '大辞林'), '007-大辞林.zip');
    const names = Array.from({length: 12}, (_, i) => archiveFileName(i + 1, 12, 'd'));
    assert.deepEqual([...names].sort(), names, 'plain lexical sort keeps the intended order');
});

test('sanitizeFileName removes path separators, reserved characters and control characters', () => {
    assert.equal(sanitizeFileName('  Weird/Title: "quotes" <tags> ..\\..  '), 'Weird_Title_ _quotes_ _tags_ .._');
    assert.equal(sanitizeFileName('a\u0000b\u001fc'), 'a_b_c');
    assert.equal(sanitizeFileName('...'), 'dictionary');
    assert.equal(sanitizeFileName(''), 'dictionary');
    assert.equal(sanitizeFileName('CON'), 'dictionary');
    assert.equal(sanitizeFileName('x'.repeat(200)).length, 80);
    assert.equal(sanitizeFileName('日本語　辞書'), '日本語 辞書');
});

// --- fixtures -----------------------------------------------------------------------

test('every fixture converts to one schema-valid archive per dictionary', async () => {
    for (const name of fixtureNames()) {
        const json = fixtureJson(name);
        const bytes = fixtureBytes(name);
        const {archives, warnings} = await convertExport(bytes);
        const dictionaries = rowsOf(json, 'dictionaries');
        assert.equal(archives.length, dictionaries.length, `${name}: archive count`);
        assert.deepEqual(archives.map((a) => a.title), dictionaries.map((d) => d.title), `${name}: titles in import order`);
        for (const archive of archives) {
            const zip = readZip(bytesOf(archive));
            assert.deepEqual(schemaErrors(zip), [], `${name}/${archive.title}: Yomitan schema validation`);
            assert.equal(zip.entries[0].name, 'index.json');
            assert.equal(zipJson(zip, 'index.json').title, archive.title);
            // Every stored row landed in exactly one bank.
            const count = (re) => zip.entries.filter((e) => re.test(e.name)).reduce((n, e) => n + zipJson(zip, e.name).length, 0);
            assert.equal(count(/^term_bank_/), archive.rowCounts.terms, `${archive.title}: terms`);
            assert.equal(count(/^term_meta_bank_/), archive.rowCounts.termMeta, `${archive.title}: term meta`);
            assert.equal(count(/^kanji_bank_/), archive.rowCounts.kanji, `${archive.title}: kanji`);
            assert.equal(count(/^kanji_meta_bank_/), archive.rowCounts.kanjiMeta, `${archive.title}: kanji meta`);
            assert.equal(count(/^tag_bank_/), archive.rowCounts.tagMeta, `${archive.title}: tags`);
            for (const w of archive.warnings) assert.equal(w.code, 'format-upgraded', `${archive.title}: unexpected warning ${w.code}`);
        }
        assert.ok(warnings.every((w) => w.code === 'format-upgraded'), `${name}: ${JSON.stringify(warnings)}`);
    }
});

test('the same dictionary yields byte-identical archives whether exported alone or with others, twice', async () => {
    const single = (await convertExport(fixtureBytes('single-valid-dictionary1'))).archives[0];
    const multi = (await convertExport(fixtureBytes('multi-six'))).archives.find((a) => a.title === 'valid-dictionary1');
    const again = (await convertExport(new Blob([fixtureBytes('multi-six')]))).archives.find((a) => a.title === 'valid-dictionary1');
    assert.deepEqual(bytesOf(single), bytesOf(multi));
    assert.deepEqual(bytesOf(multi), bytesOf(again));
    assert.equal(single.size, bytesOf(single).length);
});

test('index.json is rebuilt from the stored summary with every optional field', async () => {
    const {archives} = await convertExport(fixtureBytes('single-rich-meta'));
    const zip = readZip(bytesOf(archives[0]));
    assert.deepEqual(zipJson(zip, 'index.json'), {
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
        minimumYomitanVersion: '24.0.0.0',
        isUpdatable: true,
        indexUrl: 'https://example.invalid/rich/index.json',
        downloadUrl: 'https://example.invalid/rich/rich.zip',
    });
    assert.equal(new TextDecoder().decode(zip.files.get('styles.css')), '.gloss-image { border: 1px solid #333; }\n[data-sc-content="x"] { color: teal; }\n');
});

test('buildIndex ignores runtime-only summary fields and half-specified updatable metadata', () => {
    const index = buildIndex(summaryRow('T', {importDate: 5, counts: {}, prefixWildcardsSupported: true, importSuccess: true, styles: 'x', isUpdatable: true, author: 'a'}), 3);
    assert.deepEqual(index, {title: 'T', format: 3, revision: 'r1', sequenced: false, author: 'a'});
});

test('glossaries: text objects, images and structured content are restored to author form', async () => {
    const {archives} = await convertExport(fixtureBytes('single-rich-meta'));
    const zip = readZip(bytesOf(archives[0]));
    const bank = zipJson(zip, 'term_bank_1.json');
    assert.deepEqual(bank[0], ['画像', 'がぞう', 'n', '', 10, [
        'image (text-object glossary)',
        {type: 'image', path: 'img/aosaba.png', width: 32, height: 16, title: 'aosaba', description: 'a fish', pixelated: true, collapsed: false, collapsible: true},
    ], 1, 'P']);
    assert.deepEqual(bank[1], ['構造', 'こうぞう', '', 'v1', 3, [{type: 'structured-content', content: [
        {tag: 'div', style: {fontStyle: 'italic'}, data: {content: 'x'}, content: [
            'structure ',
            {tag: 'img', path: 'img/aosaba.png', width: 8, height: 4, alt: 'alt text', imageRendering: 'pixelated', appearance: 'monochrome', background: false, verticalAlign: 'middle', border: '1px solid red', borderRadius: '2px', sizeUnits: 'em'},
            {tag: 'a', href: '?query=構造', content: 'link'},
        ]},
    ]}], 2, '']);
    // Two rows for the same term stay two rows, in order.
    assert.deepEqual(bank.slice(2).map((r) => r[5][0]), ['same expression as the next row', 'second row for the same term and reading']);
});

test('restoreGlossaryItem drops decoded dimensions when the author gave none and records media paths', () => {
    const paths = new Set();
    assert.deepEqual(restoreGlossaryItem({type: 'image', path: 'a.png', width: 100, height: 50}, paths), {type: 'image', path: 'a.png'});
    assert.deepEqual(restoreGlossaryItem({type: 'structured-content', content: {tag: 'span', content: {tag: 'img', path: 'b.png', width: 1, height: 1, preferredWidth: 2}}}, paths),
        {type: 'structured-content', content: {tag: 'span', content: {tag: 'img', path: 'b.png', width: 2}}});
    assert.deepEqual([...paths], ['a.png', 'b.png']);
    assert.equal(restoreGlossaryItem('plain', paths), 'plain');
    assert.deepEqual(restoreGlossaryItem(['uninflected', ['v1']], paths), ['uninflected', ['v1']]);
});

test('tags, frequencies, pitch, kanji and kanji meta round-trip as bank rows', async () => {
    const json = fixtureJson('single-rich-meta');
    const {archives} = await convertExport(fixtureBytes('single-rich-meta'));
    const zip = readZip(bytesOf(archives[0]));
    assert.deepEqual(zipJson(zip, 'tag_bank_1.json'), rowsOf(json, 'tagMeta').map((t) => [t.name, t.category, t.order, t.notes, t.score]));
    assert.deepEqual(zipJson(zip, 'term_meta_bank_1.json'), rowsOf(json, 'termMeta').map((m) => [m.expression, m.mode, m.data]));
    assert.deepEqual(zipJson(zip, 'kanji_meta_bank_1.json'), rowsOf(json, 'kanjiMeta').map((m) => [m.character, m.mode, m.data]));
    assert.deepEqual(zipJson(zip, 'kanji_bank_1.json'), [['画', 'ガ カク', 'えが.く', 'jouyou', ['picture', 'drawing'], {strokes: '8', grade: '2'}]]);
    const modes = zipJson(zip, 'term_meta_bank_1.json').map((m) => m[1]);
    assert.deepEqual(modes, ['freq', 'freq', 'freq', 'pitch', 'ipa']);
});

test('media files are written byte-for-byte at their referenced paths, stored uncompressed', async () => {
    const json = fixtureJson('single-valid-dictionary1');
    const {archives} = await convertExport(fixtureBytes('single-valid-dictionary1'));
    const zip = readZip(bytesOf(archives[0]));
    const media = rowsOf(json, 'media');
    assert.equal(media.length, 6);
    for (const m of media) {
        const expected = new Uint8Array(Buffer.from(m.content, 'base64'));
        assert.deepEqual(zip.files.get(m.path), expected, m.path);
        assert.equal(zip.entries.find((e) => e.name === m.path).method, 0);
    }
    assert.equal(archives[0].mediaBytes, media.reduce((n, m) => n + Buffer.from(m.content, 'base64').length, 0));
    // Media paths come last, sorted, after the JSON banks.
    const names = zip.entries.map((e) => e.name);
    assert.deepEqual(names.slice(-6), media.map((m) => m.path).sort());
});

test('format 1 dictionaries are written as format 3 with a warning', async () => {
    const {archives, warnings} = await convertExport(fixtureBytes('single-legacy-v1'));
    const zip = readZip(bytesOf(archives[0]));
    assert.equal(zipJson(zip, 'index.json').format, 3);
    assert.deepEqual(zipJson(zip, 'term_bank_1.json')[0], ['古語', 'こご', 'n arch', '', 5, [], 0, '']);
    assert.deepEqual(zipJson(zip, 'kanji_bank_1.json')[0], ['古', 'コ', 'ふる.い', 'jouyou', [], {}]);
    assert.equal(archives[0].sourceFormat, 1);
    assert.deepEqual(warnings.map((w) => w.code), ['format-upgraded']);
});

test('scanExport lists dictionaries in import order with counts, without converting', async () => {
    const scan = await scanExport(fixtureBytes('multi-six'));
    assert.deepEqual(scan.dictionaries.map((d) => d.key), [1, 2, 3, 4, 5, 6]);
    assert.equal(scan.dictionaries[0].title, 'valid-dictionary1');
    assert.equal(scan.dictionaries[0].counts.terms.total, 38);
    assert.equal(scan.dictionaries[4].version, 1);
    assert.equal(scan.totalRows, 540);
    assert.deepEqual(scan.warnings, []);
});

test('an empty dictionary collection scans and converts to nothing', async () => {
    const scan = await scanExport(fixtureBytes('empty-database'));
    assert.deepEqual(scan.dictionaries, []);
    const {archives} = await convertExport(fixtureBytes('empty-database'));
    assert.deepEqual(archives, []);
});

// --- malformed / partial / unsupported --------------------------------------------------

test('non-export inputs fail with clear messages and no archives', async () => {
    await assert.rejects(convertExport('hello'), /not valid JSON/);
    await assert.rejects(convertExport('{"version":0,"options":{}}'), /settings backups/);
    await assert.rejects(convertExport(encode({formatName: 'dexie', formatVersion: 2, data: {}})), /formatVersion 2/);
    await assert.rejects(scanExport('[]'), /not a JSON object/);
    await assert.rejects(scanExport(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), /not valid JSON/);
});

test('a truncated export is rejected as truncated (no partial archives)', async () => {
    const bytes = fixtureBytes('multi-six');
    for (const fraction of [0.1, 0.5, 0.95]) {
        const cut = bytes.subarray(0, Math.floor(bytes.length * fraction));
        await assert.rejects(convertExport(cut), (e) => e instanceof ExportFormatError && /truncated/.test(e.message), `cut at ${fraction}`);
    }
    // Scanning only needs the head of the file, so a truncated tail still lists dictionaries.
    const scan = await scanExport(bytes.subarray(0, Math.floor(bytes.length * 0.5)));
    assert.equal(scan.dictionaries.length, 6);
});

test('duplicate dictionary titles are rejected', async () => {
    const doc = makeExport({dictionaries: [summaryRow('Same'), summaryRow('Same')]});
    await assert.rejects(convertExport(encode(doc)), /title "Same" twice/);
    await assert.rejects(scanExport(encode(doc)), /title "Same" twice/);
});

test('rows whose dictionary is not listed are skipped with a warning (partial export)', async () => {
    const doc = makeExport({dictionaries: [summaryRow('A')], terms: [termRow('A', '一', 'いち', ['one']), termRow('Ghost', '二', 'に', ['two'])]});
    const {archives, warnings} = await convertExport(encode(doc));
    assert.equal(archives.length, 1);
    assert.equal(zipJson(readZip(bytesOf(archives[0])), 'term_bank_1.json').length, 1);
    assert.ok(warnings.some((w) => w.code === 'orphan-rows' && /"Ghost": 1/.test(w.message)));
    assert.ok(warnings.some((w) => w.code === 'count-mismatch' && /recorded 0 terms/.test(w.message)));
});

test('count mismatches against the import-time summary are reported', async () => {
    const summary = summaryRow('A', {counts: {terms: {total: 3}, termMeta: {total: 0}, kanji: {total: 0}, kanjiMeta: {total: 0}, tagMeta: {total: 0}, media: {total: 0}}});
    const doc = makeExport({dictionaries: [summary], terms: [termRow('A', '一', 'いち', ['one'])]});
    const {warnings} = await convertExport(encode(doc));
    assert.deepEqual(warnings.map((w) => w.code), ['count-mismatch']);
    assert.match(warnings[0].message, /recorded 3 terms row\(s\).*contains 1/);
});

test('missing, unsafe and duplicate media are reported', async () => {
    const summary = summaryRow('A', {counts: {terms: {total: 1}, termMeta: {total: 0}, kanji: {total: 0}, kanjiMeta: {total: 0}, tagMeta: {total: 0}, media: {total: 3}}});
    const png = [0x89, 0x50, 0x4e, 0x47];
    const doc = makeExport({
        dictionaries: [summary],
        terms: [termRow('A', '絵', 'え', [{type: 'image', path: 'gone.png', width: 1, height: 1}, {type: 'image', path: 'ok.png', width: 1, height: 1}])],
        media: [
            {dictionary: 'A', path: 'ok.png', mediaType: 'image/png', width: 1, height: 1, content: png},
            {dictionary: 'A', path: 'ok.png', mediaType: 'image/png', width: 1, height: 1, content: png},
            {dictionary: 'A', path: '../escape.png', mediaType: 'image/png', width: 1, height: 1, content: png},
        ],
    });
    const {archives, warnings} = await convertExport(encode(doc));
    const zip = readZip(bytesOf(archives[0]));
    assert.deepEqual(zip.entries.map((e) => e.name), ['index.json', 'term_bank_1.json', 'ok.png']);
    const codes = warnings.map((w) => w.code).sort();
    assert.deepEqual(codes, ['media-duplicate', 'media-missing', 'media-unsafe-path']);
    assert.match(warnings.find((w) => w.code === 'media-missing').message, /"gone.png"/);
});

test('unknown tables, wrong database names and missing tables produce warnings, not failures', async () => {
    const doc = makeExport({dictionaries: [summaryRow('A')], databaseName: 'other', extraTables: [{name: 'zzz', schema: '++', rows: [{$: [1, {x: 1}], $types: {$: {'': 'arrayNonindexKeys'}}}], inbound: false}]});
    doc.data.tables = doc.data.tables.filter((t) => t.name !== 'media');
    doc.data.data = doc.data.data.filter((t) => t.tableName !== 'media');
    const {archives, warnings} = await convertExport(encode(doc));
    assert.equal(archives.length, 1);
    assert.deepEqual(warnings.map((w) => w.code).sort(), ['database-name', 'missing-tables', 'unknown-tables']);
});

test('tables appearing before "dictionaries" are rejected as rewritten exports', async () => {
    const doc = makeExport({dictionaries: [summaryRow('A')], terms: [termRow('A', '一', 'いち', ['one'])]});
    doc.data.data.reverse();
    await assert.rejects(convertExport(encode(doc)), /appears before "dictionaries"/);
});

test('malformed rows inside a valid envelope are rejected with the dictionary and row number', async () => {
    const doc = makeExport({dictionaries: [summaryRow('A')], terms: [{dictionary: 'A', glossary: []}]});
    await assert.rejects(convertExport(encode(doc)), /Term row 1 of "A" has no expression/);
    const doc2 = makeExport({dictionaries: [{title: 'A'}]});
    await assert.rejects(convertExport(encode(doc2)), /not a dictionary summary/);
});

test('a term row without a glossary list is written with an empty glossary and a warning', async () => {
    const doc = makeExport({dictionaries: [summaryRow('A', {counts: undefined})], terms: [{...termRow('A', '一', 'いち', []), glossary: undefined}]});
    const {archives, warnings} = await convertExport(encode(doc));
    assert.deepEqual(zipJson(readZip(bytesOf(archives[0])), 'term_bank_1.json')[0][5], []);
    assert.deepEqual(warnings.map((w) => w.code), ['term-glossary-missing']);
});

// --- large input ----------------------------------------------------------------------

test('a large export is converted in a stream with bounded memory and split into banks', {timeout: 240_000}, async () => {
    const TERMS = 120_000;
    const dictionaries = [summaryRow('Big', {counts: {terms: {total: TERMS}, termMeta: {total: TERMS}, kanji: {total: 0}, kanjiMeta: {total: 0}, tagMeta: {total: 0}, media: {total: 0}}})];
    const head = JSON.stringify(makeExport({dictionaries}));
    // Splice large row arrays into the envelope without materializing the whole document.
    const marker = (table) => `{"tableName":"${table}","inbound":${table === 'terms'},"rows":[]}`;
    const encoder = new TextEncoder();
    async function* chunks() {
        let remaining = head;
        for (const table of ['termMeta', 'terms']) {
            const idx = remaining.indexOf(marker(table));
            const before = remaining.slice(0, idx + marker(table).length - 2);
            remaining = remaining.slice(idx + marker(table).length - 2);
            yield encoder.encode(before);
            let buf = '';
            for (let i = 0; i < TERMS; i++) {
                const row = table === 'terms'
                    ? termRow('Big', `語${i}`, `ご${i}`, [`definition ${i} `.repeat(4), {type: 'structured-content', content: {tag: 'div', content: `sc ${i}`}}], {id: i + 1, sequence: i, $types: {glossary: 'arrayNonindexKeys'}})
                    : {$: [i + 1, {expression: `語${i}`, mode: 'freq', data: {value: i, displayValue: String(i)}, dictionary: 'Big'}], $types: {$: {'': 'arrayNonindexKeys'}}};
                buf += (i > 0 ? ',' : '') + JSON.stringify(row);
                if (buf.length > 1 << 16) { yield encoder.encode(buf); buf = ''; }
            }
            yield encoder.encode(buf);
        }
        yield encoder.encode(remaining);
    }
    if (globalThis.gc) globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    let progressCalls = 0;
    const {archives, warnings} = await convertExport(chunks(), {onProgress: () => { progressCalls++; peak = Math.max(peak, process.memoryUsage().heapUsed); }});
    assert.deepEqual(warnings, []);
    assert.equal(archives.length, 1);
    assert.equal(archives[0].rowCounts.terms, TERMS);
    assert.equal(archives[0].rowCounts.termMeta, TERMS);
    assert.ok(progressCalls > 10, 'progress is reported');
    const zip = readZip(bytesOf(archives[0]));
    const termBanks = zip.entries.filter((e) => /^term_bank_/.test(e.name));
    assert.equal(termBanks.length, Math.ceil(TERMS / BANK_SIZE));
    assert.equal(zipJson(zip, `term_bank_${termBanks.length}.json`).length, TERMS % BANK_SIZE || BANK_SIZE);
    assert.deepEqual(zipJson(zip, 'term_bank_1.json')[0].slice(0, 2), ['語0', 'ご0']);
    assert.deepEqual(zipJson(zip, 'term_bank_2.json')[0].slice(0, 2), [`語${BANK_SIZE}`, `ご${BANK_SIZE}`]);
    assert.deepEqual(schemaErrors(zip), []);
    const inputBytes = TERMS * 2 * 200; // rough size of the streamed JSON (~48 MB)
    const growth = peak - before;
    assert.ok(growth < inputBytes * 4, `heap grew by ${(growth / 1e6).toFixed(0)} MB while streaming ~${(inputBytes / 1e6).toFixed(0)} MB`);
});
