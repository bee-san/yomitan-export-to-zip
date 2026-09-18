// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import {test} from 'node:test';
import zlib from 'node:zlib';

import {DeterministicZipWriter, METHOD_DEFLATE, METHOD_STORE, concatParts, crc32, prepareEntry} from '../../src/zip-writer.js';
import {readZip} from './helpers.mjs';

test('crc32 matches the reference value and Node', () => {
    const bytes = new TextEncoder().encode('123456789');
    assert.equal(crc32(bytes), 0xcbf43926);
    assert.equal(crc32(new Uint8Array(0)), 0);
    const random = new Uint8Array(10000).map((_, i) => (i * 7919) & 0xff);
    assert.equal(crc32(random), zlib.crc32(random));
});

test('archives are byte-identical for identical input and independent of wall-clock time', async () => {
    const build = () => {
        const w = new DeterministicZipWriter();
        w.add('index.json', JSON.stringify({title: 'x'}));
        w.add('term_bank_1.json', 'x'.repeat(5000));
        w.add('media/日本.png', new Uint8Array([1, 2, 3, 4]), {compress: false});
        w.add('empty.txt', '');
        return concatParts(w.finish().parts);
    };
    const a = build();
    await new Promise((r) => setTimeout(r, 1100));
    const b = build();
    assert.deepEqual(a, b);
    const zip = readZip(a);
    assert.equal(zip.zip64, false);
    for (const e of zip.entries) {
        assert.equal(e.date, 0x0021, `${e.name}: DOS date is 1980-01-01`);
        assert.equal(e.time, 0, `${e.name}: DOS time is 00:00:00`);
        assert.equal(e.flags & 0x0800, 0x0800, `${e.name}: UTF-8 flag`);
        assert.equal(e.extraLength, 0, `${e.name}: no extra fields`);
    }
    assert.deepEqual(zip.entries.map((e) => e.name), ['index.json', 'term_bank_1.json', 'media/日本.png', 'empty.txt']);
    assert.equal(zip.entries[1].method, METHOD_DEFLATE);
    assert.equal(zip.entries[2].method, METHOD_STORE, 'compress:false stores');
    assert.equal(zip.entries[0].method, METHOD_STORE, 'incompressible tiny file falls back to store');
    assert.equal(new TextDecoder().decode(zip.files.get('term_bank_1.json')), 'x'.repeat(5000));
    assert.deepEqual([...zip.files.get('media/日本.png')], [1, 2, 3, 4]);
    assert.equal(zip.files.get('empty.txt').length, 0);
});

test('entries can be prepared early and added in a different order', () => {
    const late = prepareEntry('b.txt', 'bbb');
    const w = new DeterministicZipWriter();
    w.add('a.txt', 'aaa');
    w.addPrepared(late);
    const zip = readZip(concatParts(w.finish().parts));
    assert.deepEqual(zip.entries.map((e) => e.name), ['a.txt', 'b.txt']);
});

test('duplicate entry names and oversized names are rejected', () => {
    const w = new DeterministicZipWriter();
    w.add('a', 'x');
    assert.throws(() => w.add('a', 'y'), /Duplicate ZIP entry name/);
    assert.throws(() => w.add('n'.repeat(70000), 'y'), /too long/);
    assert.equal(w.has('a'), true);
});

test('more than 65534 entries switches to a ZIP64 end record that readers understand', () => {
    const w = new DeterministicZipWriter();
    for (let i = 0; i < 70000; i++) w.add(`m/${i}`, '', {compress: false});
    const result = w.finish();
    assert.equal(result.zip64, true);
    const zip = readZip(concatParts(result.parts));
    assert.equal(zip.zip64, true);
    assert.equal(zip.entries.length, 70000);
    assert.equal(zip.entries[69999].name, 'm/69999');
    // Per-entry sizes and offsets stay 32-bit, so Hachidori's reader (which only honours the
    // ZIP64 end record) still finds every file.
    assert.ok(zip.entries.every((e) => e.extraLength === 0));
});

test('output size equals the sum of the parts', () => {
    const w = new DeterministicZipWriter();
    w.add('a', 'hello world hello world hello world');
    const r = w.finish();
    assert.equal(r.size, concatParts(r.parts).length);
});
