// SPDX-License-Identifier: GPL-3.0-or-later
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateRawSync} from 'node:zlib';
import Ajv from 'ajv';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = join(REPO, 'test', 'fixtures');

export function fixtureBytes(name) {
    return new Uint8Array(readFileSync(join(FIXTURES, `${name}.json`)));
}

export function fixtureJson(name) {
    return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

export function fixtureNames() {
    return readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

/**
 * Independent minimal ZIP reader (central directory driven) so the tests do not trust the writer.
 * @param {Uint8Array} bytes
 * @returns {{entries: Array<{name: string, method: number, crc: number, size: number, compressedSize: number, offset: number, time: number, date: number, flags: number, extraLength: number}>, zip64: boolean, files: Map<string, Uint8Array>}}
 */
export function readZip(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = bytes.length - 22;
    while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error('no end of central directory');
    let count = dv.getUint16(eocd + 10, true);
    let cdOffset = dv.getUint32(eocd + 16, true);
    let zip64 = false;
    if (eocd >= 20 && dv.getUint32(eocd - 20, true) === 0x07064b50) {
        zip64 = true;
        const e64 = Number(dv.getBigUint64(eocd - 12, true));
        if (dv.getUint32(e64, true) !== 0x06064b50) throw new Error('bad zip64 eocd');
        count = Number(dv.getBigUint64(e64 + 32, true));
        cdOffset = Number(dv.getBigUint64(e64 + 48, true));
    }
    const entries = [];
    const files = new Map();
    let pos = cdOffset;
    const decoder = new TextDecoder();
    for (let i = 0; i < count; i++) {
        if (dv.getUint32(pos, true) !== 0x02014b50) throw new Error(`bad central directory entry at ${pos}`);
        const flags = dv.getUint16(pos + 8, true);
        const method = dv.getUint16(pos + 10, true);
        const time = dv.getUint16(pos + 12, true);
        const date = dv.getUint16(pos + 14, true);
        const crc = dv.getUint32(pos + 16, true);
        const compressedSize = dv.getUint32(pos + 20, true);
        const size = dv.getUint32(pos + 24, true);
        const nameLen = dv.getUint16(pos + 28, true);
        const extraLength = dv.getUint16(pos + 30, true);
        const commentLen = dv.getUint16(pos + 32, true);
        const offset = dv.getUint32(pos + 42, true);
        const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
        entries.push({name, method, crc, size, compressedSize, offset, time, date, flags, extraLength});
        if (dv.getUint32(offset, true) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
        const lhNameLen = dv.getUint16(offset + 26, true);
        const lhExtraLen = dv.getUint16(offset + 28, true);
        const dataStart = offset + 30 + lhNameLen + lhExtraLen;
        const raw = bytes.subarray(dataStart, dataStart + compressedSize);
        let data;
        if (method === 0) data = raw;
        else if (method === 8) data = new Uint8Array(inflateRawSync(raw));
        else throw new Error(`unsupported method ${method} for ${name}`);
        if (data.length !== size) throw new Error(`size mismatch for ${name}`);
        files.set(name, data);
        pos += 46 + nameLen + extraLength + commentLen;
    }
    return {entries, zip64, files};
}

export function zipJson(zip, name) {
    return JSON.parse(new TextDecoder().decode(zip.files.get(name)));
}

const SCHEMA_DIR = join(REPO, 'test', 'schemas');
let validators = null;

/** Ajv validators built exactly like Yomitan's dev/schema-validate.js. */
export function yomitanValidators() {
    if (validators) return validators;
    const load = (file) => JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8'));
    const ajv = new Ajv({meta: false, strictTuples: false, allowUnionTypes: true});
    const metaSchema = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('ajv/dist/refs/json-schema-draft-07.json')), 'utf8'));
    ajv.addMetaSchema(metaSchema);
    validators = {
        index: ajv.compile(load('dictionary-index-schema.json')),
        termBankV3: ajv.compile(load('dictionary-term-bank-v3-schema.json')),
        termMetaBankV3: ajv.compile(load('dictionary-term-meta-bank-v3-schema.json')),
        kanjiBankV3: ajv.compile(load('dictionary-kanji-bank-v3-schema.json')),
        kanjiMetaBankV3: ajv.compile(load('dictionary-kanji-meta-bank-v3-schema.json')),
        tagBankV3: ajv.compile(load('dictionary-tag-bank-v3-schema.json')),
    };
    return validators;
}

/** Validate every file of a produced archive against Yomitan's schemas; returns error strings. */
export function schemaErrors(zip) {
    const v = yomitanValidators();
    const errors = [];
    const check = (validate, name) => {
        const data = zipJson(zip, name);
        if (!validate(data)) errors.push(`${name}: ${JSON.stringify(validate.errors).slice(0, 300)}`);
    };
    const names = [...zip.files.keys()];
    if (!names.includes('index.json')) errors.push('index.json missing');
    else check(v.index, 'index.json');
    for (const name of names) {
        if (/^term_bank_\d+\.json$/.test(name)) check(v.termBankV3, name);
        else if (/^term_meta_bank_\d+\.json$/.test(name)) check(v.termMetaBankV3, name);
        else if (/^kanji_bank_\d+\.json$/.test(name)) check(v.kanjiBankV3, name);
        else if (/^kanji_meta_bank_\d+\.json$/.test(name)) check(v.kanjiMetaBankV3, name);
        else if (/^tag_bank_\d+\.json$/.test(name)) check(v.tagBankV3, name);
    }
    return errors;
}

/** Build a minimal export document from per-table rows (mirrors dexie-export-import's layout). */
export function makeExport({dictionaries = [], terms = [], termMeta = [], kanji = [], kanjiMeta = [], tagMeta = [], media = [], databaseName = 'dict', extraTables = []} = {}) {
    const outbound = (rows) => rows.map((value, i) => ({$: [i + 1, value], $types: {$: {'': 'arrayNonindexKeys'}}}));
    const inbound = (rows) => rows.map((value, i) => ({...value, id: i + 1}));
    const tables = [
        {name: 'dictionaries', schema: '++,title,version', rows: outbound(dictionaries), inbound: false},
        {name: 'kanji', schema: '++,character,dictionary', rows: outbound(kanji), inbound: false},
        {name: 'kanjiMeta', schema: '++,character,dictionary', rows: outbound(kanjiMeta), inbound: false},
        {name: 'media', schema: '++id,dictionary,path', rows: inbound(media.map((m) => ({...m, content: Buffer.from(m.content).toString('base64'), $types: {content: 'arraybuffer'}}))), inbound: true},
        {name: 'tagMeta', schema: '++,dictionary,name', rows: outbound(tagMeta), inbound: false},
        {name: 'termMeta', schema: '++,dictionary,expression', rows: outbound(termMeta), inbound: false},
        {name: 'terms', schema: '++id,dictionary,expression,expressionReverse,reading,readingReverse,sequence', rows: inbound(terms), inbound: true},
        ...extraTables,
    ];
    return {
        formatName: 'dexie',
        formatVersion: 1,
        data: {
            databaseName,
            databaseVersion: 6,
            tables: tables.map((t) => ({name: t.name, schema: t.schema, rowCount: t.rows.length})),
            data: tables.map((t) => ({tableName: t.name, inbound: t.inbound, rows: t.rows})),
        },
    };
}

export function summaryRow(title, extra = {}) {
    return {
        title,
        revision: 'r1',
        sequenced: false,
        version: 3,
        importDate: 1767323045678,
        prefixWildcardsSupported: true,
        counts: {terms: {total: 0}, termMeta: {total: 0}, kanji: {total: 0}, kanjiMeta: {total: 0}, tagMeta: {total: 0}, media: {total: 0}},
        styles: '',
        importSuccess: true,
        ...extra,
    };
}

export function termRow(dictionary, expression, reading, glossary, extra = {}) {
    return {expression, reading: reading || expression, definitionTags: '', rules: '', score: 0, glossary, sequence: 0, termTags: '', dictionary, expressionReverse: [...expression].reverse().join(''), readingReverse: [...(reading || expression)].reverse().join(''), ...extra};
}

export const encode = (obj) => new TextEncoder().encode(JSON.stringify(obj));
