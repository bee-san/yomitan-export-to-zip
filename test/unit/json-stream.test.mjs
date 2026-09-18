// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {JsonSyntaxError, StreamingJsonParser, feedStream, parseJsonText} from '../../src/json-stream.js';

const SAMPLE = {
    a: [1, 2, {b: 'x"y\\z\u00e9\ud83d\ude00\n\t'}],
    c: {},
    d: [],
    e: null,
    f: -1.5e3,
    g: true,
    h: '',
    'k.ey~': {'': 0},
    rows: [{k: 1}, {k: 2}, [3, [4]], 'five', null],
    z: {rows: [9]},
};
const TEXT = JSON.stringify(SAMPLE);

test('parses a document identically to JSON.parse, preserving key order', () => {
    assert.equal(JSON.stringify(parseJsonText(TEXT)), TEXT);
    assert.deepEqual(parseJsonText(' \n[1, "a", {"b": [true, false, null]}] '), [1, 'a', {b: [true, false, null]}]);
});

test('any chunk boundary yields the same result', () => {
    for (let cut = 1; cut < TEXT.length; cut++) {
        const p = new StreamingJsonParser();
        p.feed(TEXT.slice(0, cut));
        p.feed(TEXT.slice(cut));
        assert.equal(JSON.stringify(p.end()), TEXT, `cut at ${cut}`);
    }
    // three-way splits around escapes and literals
    const tricky = '{"s":"a\\u00e9\\n\\"b","n":-12.5e-3,"t":true,"u":null}';
    for (let i = 1; i < tricky.length - 1; i++) {
        for (let j = i + 1; j < tricky.length; j++) {
            const p = new StreamingJsonParser();
            p.feed(tricky.slice(0, i));
            p.feed(tricky.slice(i, j));
            p.feed(tricky.slice(j));
            assert.deepEqual(p.end(), JSON.parse(tricky), `cuts ${i},${j}`);
        }
    }
});

test('streams array elements at the requested path and replaces the array', () => {
    const items = [];
    const ends = [];
    const parser = new StreamingJsonParser({
        streamArray: (path) => path.length === 1 && path[0] === 'rows',
        onItem: (item, path, parent) => items.push([item, path, Object.keys(parent)]),
        onArrayEnd: (path) => ends.push(path),
    });
    for (const piece of TEXT.match(/.{1,5}/g)) parser.feed(piece);
    const result = parser.end();
    assert.deepEqual(items.map((x) => x[0]), SAMPLE.rows);
    assert.deepEqual(items.map((x) => x[1]), SAMPLE.rows.map((_, i) => ['rows', i]));
    assert.ok(items[0][2].includes('a'), 'parent exposes earlier keys');
    assert.deepEqual(ends, [['rows']]);
    assert.equal(result.rows.length, SAMPLE.rows.length);
    assert.deepEqual(result.z.rows, [9], 'non-matching arrays are kept');
});

test('partialRoot exposes in-progress containers', () => {
    let seen = null;
    const parser = new StreamingJsonParser({
        streamArray: (path) => path.at(-1) === 'rows',
        onItem: () => { seen ??= JSON.parse(JSON.stringify(parser.partialRoot)); },
    });
    parser.feed('{"formatName":"dexie","data":{"tables":[1],"data":[{"tableName":"t","rows":[1,2]}]}}');
    parser.end();
    assert.equal(seen.formatName, 'dexie');
    assert.deepEqual(seen.data.tables, [1]);
    assert.equal(seen.data.data[0].tableName, 't');
});

test('reports syntax errors with positions', () => {
    const cases = [
        ['', /Empty input/],
        ['{', /truncated/],
        ['{"a":1,}', /Expected string key/],
        ['[1,]', /Unexpected "\]"/],
        ['{"a" 1}', /Expected ":"/],
        ['tru', /Invalid token "tru"/],
        ['[1 2]', /Expected ","/],
        ['"abc', /inside a string/],
        ['{"a":1}x', /after end of JSON document/],
        ['["\\x"]', /Invalid escape/],
        ['01', /Invalid token/],
        ['["a\nb"]', /control character/],
        [']', /Unexpected token outside/],
        ['{"a":]}', /Unexpected "\]"/],
    ];
    for (const [text, re] of cases) {
        assert.throws(() => parseJsonText(text), (e) => e instanceof JsonSyntaxError && re.test(e.message), `input ${JSON.stringify(text)}`);
    }
});

test('rejects nesting deeper than 256 levels', () => {
    assert.throws(() => parseJsonText('['.repeat(300) + ']'.repeat(300)), /Nesting deeper/);
    assert.deepEqual(parseJsonText('['.repeat(200) + ']'.repeat(200)).length, 1);
});

test('feedStream decodes UTF-8 across chunk boundaries and rejects invalid UTF-8', async () => {
    const bytes = new TextEncoder().encode(TEXT);
    async function* chunks(size) {
        for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
    }
    for (const size of [1, 3, 7, 64]) {
        const seen = [];
        const result = await feedStream(new StreamingJsonParser(), chunks(size), {onBytes: (b) => seen.push(b)});
        assert.equal(JSON.stringify(result), TEXT, `chunk size ${size}`);
        assert.equal(seen.at(-1), bytes.length);
    }
    async function* bad() { yield new Uint8Array([0x22, 0xff, 0xfe, 0x22]); }
    await assert.rejects(feedStream(new StreamingJsonParser(), bad()), /not valid UTF-8/);
});

test('long strings are consumed with indexOf fast path (base64-like payload)', () => {
    const big = 'A'.repeat(5_000_000);
    const parser = new StreamingJsonParser();
    const text = `{"content":"${big}","n":1}`;
    for (let i = 0; i < text.length; i += 65536) parser.feed(text.slice(i, i + 65536));
    const result = parser.end();
    assert.equal(result.content.length, big.length);
    assert.equal(result.n, 1);
});
