// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {ExportFormatError, readExport, readTableThenStop, reviveTypeson, validateExportHeader} from '../../src/dexie-export.js';
import {encode, fixtureBytes, fixtureJson, makeExport, summaryRow, termRow} from './helpers.mjs';

test('reviveTypeson: rows without $types pass through', () => {
    const row = {a: 1, b: [1, 2]};
    assert.equal(reviveTypeson(row), row);
    assert.equal(reviveTypeson(5), 5);
});

test('reviveTypeson: outbound tuple with arrayNonindexKeys is unwrapped', () => {
    const revived = reviveTypeson({$: [7, {title: 't', meanings: []}], $types: {$: {'': 'arrayNonindexKeys', '1.meanings': 'arrayNonindexKeys'}}});
    assert.deepEqual(revived, [7, {title: 't', meanings: []}]);
});

test('reviveTypeson: arrays that carried non-index keys are rebuilt from objects', () => {
    const revived = reviveTypeson({glossary: {0: 'a', 1: 'b', extra: true}, $types: {glossary: 'arrayNonindexKeys'}});
    assert.ok(Array.isArray(revived.glossary));
    assert.deepEqual([...revived.glossary], ['a', 'b']);
    assert.equal(revived.glossary.extra, true);
});

test('reviveTypeson: arraybuffer, typed arrays, blobs and buffer references decode to bytes', () => {
    const b64 = Buffer.from([1, 2, 3, 4]).toString('base64');
    const ab = reviveTypeson({content: b64, $types: {content: 'arraybuffer'}});
    assert.deepEqual([...ab.content], [1, 2, 3, 4]);
    const u8 = reviveTypeson({content: {encoded: b64, byteOffset: 1, length: 2}, $types: {content: 'uint8array'}});
    assert.deepEqual([...u8.content], [2, 3]);
    const shared = reviveTypeson({a: b64, b: {index: 0}, $types: {a: 'arraybuffer', b: 'arraybuffer'}});
    assert.equal(shared.a, shared.b);
    const blob = reviveTypeson({content: {type: 'image/png', data: b64}, $types: {content: 'blob'}});
    assert.deepEqual([...blob.content], [1, 2, 3, 4]);
    const nested = reviveTypeson({$: [1, {media: {content: b64}}], $types: {$: {'': 'arrayNonindexKeys', '1.media.content': 'arraybuffer'}}});
    assert.deepEqual([...nested[1].media.content], [1, 2, 3, 4]);
});

test('reviveTypeson: escaped key paths, undefined, special numbers, $types:true', () => {
    const r = reviveTypeson({'a.b': {x: 0}, gone: 0, nan: 0, $types: {'a~1b.x': 'negativeInfinity', gone: 'undef', nan: 'nan'}});
    assert.equal(r['a.b'].x, -Infinity);
    assert.ok(!('gone' in r));
    assert.ok(Number.isNaN(r.nan));
    assert.deepEqual(reviveTypeson({$: {$types: 'literal', v: 1}, $types: true}), {$types: 'literal', v: 1});
});

test('reviveTypeson: unsupported or cyclic types are clear errors', () => {
    assert.throws(() => reviveTypeson({x: 1, $types: {x: 'weakmap'}}), /Unsupported typeson type "weakmap"/);
    assert.throws(() => reviveTypeson({x: 1, $types: {x: '#'}}), /Cyclic/);
    assert.throws(() => reviveTypeson({x: {index: 4}, $types: {x: 'arraybuffer'}}), /Dangling/);
    assert.throws(() => reviveTypeson({$types: 'nope'}), /Invalid "\$types"/);
});

test('validateExportHeader rejects things that are not dictionary exports', () => {
    const cases = [
        [[], /not a JSON object/],
        [{}, /formatName/],
        [{formatName: 'dexie', formatVersion: 1, profiles: []}, /no "data"/],
        [{formatName: 'dexie', formatVersion: 3, data: {}}, /formatVersion 3/],
        [{formatName: 'dexie', formatVersion: 1, data: {databaseName: 'dict'}}, /no "tables"/],
        [{formatName: 'dexie', formatVersion: 1, data: {databaseName: 'dict', tables: [{name: 1}]}}, /Malformed table/],
        [{formatName: 'dexie', formatVersion: 1, data: {databaseName: 'dict', tables: [], data: 5}}, /must be a list/],
    ];
    for (const [root, re] of cases) {
        assert.throws(() => validateExportHeader(root), (e) => e instanceof ExportFormatError && re.test(e.message), JSON.stringify(root));
    }
    // A Yomitan *settings* backup is the most likely wrong file.
    assert.throws(() => validateExportHeader({version: 0, date: '2026', url: 'x', options: {}}), /settings backups/);
});

test('readExport streams every table of a real fixture with correct inbound/outbound handling', async () => {
    const json = fixtureJson('multi-six');
    const seen = {};
    const starts = [];
    const ends = [];
    let header;
    const result = await readExport(fixtureBytes('multi-six'), {
        onHeader: (h) => { header = h; },
        onTableStart: (t) => starts.push(`${t.tableName}:${t.inbound}`),
        onTableEnd: (name, n) => ends.push(`${name}:${n}`),
        onRow: (table, key, value, inbound) => {
            seen[table] = (seen[table] ?? 0) + 1;
            if (inbound) assert.equal(key, undefined);
            else assert.equal(typeof key, 'number');
            assert.equal(typeof (value.dictionary ?? value.title), 'string');
            if (table === 'media') assert.ok(value.content instanceof Uint8Array);
        },
    });
    assert.equal(result.tableCount, 7);
    const expected = Object.fromEntries(json.data.tables.map((t) => [t.name, t.rowCount]));
    assert.deepEqual(seen, expected);
    assert.deepEqual(header.tables.map((t) => t.name), Object.keys(expected));
    assert.deepEqual(starts, json.data.data.map((t) => `${t.tableName}:${t.inbound}`));
    assert.deepEqual(ends, json.data.data.map((t) => `${t.tableName}:${t.rows.length}`));
});

test('readExport accepts strings, Uint8Array, Blob and async iterables', async () => {
    const doc = makeExport({dictionaries: [summaryRow('A')], terms: [termRow('A', '語', 'ご', ['x'])]});
    const text = JSON.stringify(doc);
    async function* chunks() { yield encode(doc).subarray(0, 10); yield encode(doc).subarray(10); }
    for (const source of [text, encode(doc), new Blob([text]), chunks()]) {
        const rows = [];
        await readExport(source, {onRow: (t, k, v) => rows.push(t)});
        assert.deepEqual(rows, ['dictionaries', 'terms']);
    }
});

test('readExport validates the header before the first row and reports malformed rows', async () => {
    await assert.rejects(readExport('{"formatName":"nope","data":{"tables":[],"data":[{"tableName":"terms","inbound":true,"rows":[{}]}]}}'), /expected "formatName": "dexie"/);
    const base = '{"formatName":"dexie","formatVersion":1,"data":{"databaseName":"dict","tables":[],"data":';
    await assert.rejects(readExport(`${base}[{"rows":[1]}]}}`), /no "tableName"/);
    await assert.rejects(readExport(`${base}[{"tableName":"kanji","rows":[1]}]}}`), /no boolean "inbound"/);
    await assert.rejects(readExport(`${base}[{"tableName":"kanji","inbound":false,"rows":[1]}]}}`), /not a \[key, value\] tuple/);
    await assert.rejects(readExport(`${base}[{"tableName":"kanji","inbound":false,"rows":[`), /not valid JSON.*truncated/);
    await assert.rejects(readExport('not json'), /not valid JSON/);
});

test('readTableThenStop stops reading after the dictionaries table', async () => {
    const bytes = fixtureBytes('multi-six');
    const dictEnd = Buffer.from(bytes).indexOf('"tableName":"kanji"');
    let consumed = 0;
    async function* chunks() {
        for (let i = 0; i < bytes.length; i += 1024) {
            consumed = Math.min(i + 1024, bytes.length);
            yield bytes.subarray(i, i + 1024);
        }
    }
    const titles = [];
    const found = await readTableThenStop(chunks(), 'dictionaries', (key, value) => titles.push([key, value.title]));
    assert.equal(found, true);
    assert.equal(titles.length, 6);
    assert.ok(consumed < dictEnd + 2048, `consumed ${consumed} of ${bytes.length}; should stop near ${dictEnd}`);
    assert.ok(consumed < bytes.length / 4, 'read only the head of the file');
});

test('readTableThenStop returns false when the table is absent', async () => {
    const doc = makeExport({});
    doc.data.tables = doc.data.tables.filter((t) => t.name !== 'dictionaries');
    doc.data.data = doc.data.data.filter((t) => t.tableName !== 'dictionaries');
    assert.equal(await readTableThenStop(encode(doc), 'dictionaries', () => {}), false);
});
