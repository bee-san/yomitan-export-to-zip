// SPDX-License-Identifier: GPL-3.0-or-later
//
// Deterministic ZIP container writer. Every byte is a pure function of the
// entry names and contents: fixed DOS timestamp, fixed version fields, no
// extra fields except ZIP64 when sizes/counts require them, no comments, and
// raw-deflate streams produced by the vendored, pinned fflate at one level.
//
// Entries are written in the order they are added; callers are responsible for
// choosing a canonical order.

import {deflateSync} from '../vendor/fflate.js';

export const DEFLATE_LEVEL = 6;
export const METHOD_STORE = 0;
export const METHOD_DEFLATE = 8;

// 1980-01-01 00:00:00, the DOS epoch: date = (year-1980)<<9 | month<<5 | day, time = 0.
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;
const FLAG_UTF8 = 0x0800;
const VERSION_MADE_BY = 0x0014; // 2.0, MS-DOS attributes
const VERSION_NEEDED_DEFLATE = 20;
const VERSION_NEEDED_ZIP64 = 45;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

/**
 * @param {Uint8Array} bytes
 * @param {number} [seed] running CRC from a previous chunk
 */
export function crc32(bytes, seed = 0) {
    let c = seed ^ -1;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

const encoder = new TextEncoder();

class ByteBuilder {
    constructor(size) {
        this.buf = new Uint8Array(size);
        this.view = new DataView(this.buf.buffer);
        this.pos = 0;
    }
    u16(v) { this.view.setUint16(this.pos, v, true); this.pos += 2; }
    u32(v) { this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
    u64(v) { this.view.setBigUint64(this.pos, BigInt(v), true); this.pos += 8; }
    bytes(b) { this.buf.set(b, this.pos); this.pos += b.length; }
    done() { return this.buf.subarray(0, this.pos); }
}

/**
 * @typedef {object} ZipEntry
 * @property {string} name
 * @property {Uint8Array} nameBytes
 * @property {number} method
 * @property {number} crc
 * @property {number} size uncompressed
 * @property {number} compressedSize
 * @property {Uint8Array[]} data compressed payload chunks
 * @property {number} [offset] local header offset, set at finish
 */

/**
 * Compress (or store) a file's bytes now, returning an entry that can be added to a writer later.
 * @param {string} name
 * @param {Uint8Array|string} data
 * @param {{compress?: boolean}} [options]
 * @returns {ZipEntry}
 */
export function prepareEntry(name, data, options = {}) {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    const nameBytes = encoder.encode(name);
    if (nameBytes.length > MAX16) throw new Error(`ZIP entry name too long: ${name.slice(0, 40)}…`);
    const compress = options.compress ?? true;
    const crc = crc32(bytes);
    let payload = bytes;
    let method = METHOD_STORE;
    if (compress && bytes.length > 0) {
        const deflated = deflateSync(bytes, {level: DEFLATE_LEVEL});
        if (deflated.length < bytes.length) {
            payload = deflated;
            method = METHOD_DEFLATE;
        }
    }
    return {name, nameBytes, method, crc, size: bytes.length, compressedSize: payload.length, data: [payload]};
}

export class DeterministicZipWriter {
    constructor() {
        /** @type {ZipEntry[]} */
        this.entries = [];
        this._names = new Set();
        this.compressedBytes = 0;
    }

    /**
     * Add a file. Data is compressed immediately (deflate) or stored as-is.
     * @param {string} name forward-slash separated path inside the archive
     * @param {Uint8Array|string} data
     * @param {{compress?: boolean}} [options]
     */
    add(name, data, options = {}) {
        this.addPrepared(prepareEntry(name, data, options));
    }

    /** @param {ZipEntry} entry from prepareEntry() */
    addPrepared(entry) {
        if (this._names.has(entry.name)) throw new Error(`Duplicate ZIP entry name: ${entry.name}`);
        this._names.add(entry.name);
        this.entries.push(entry);
        this.compressedBytes += entry.compressedSize;
    }

    has(name) {
        return this._names.has(name);
    }

    /**
     * Produce the archive as a list of byte chunks (concatenate or wrap in a Blob).
     * @returns {{parts: Uint8Array[], size: number, zip64: boolean}}
     */
    finish() {
        const parts = [];
        let offset = 0;
        const needsZip64Entry = (e) => e.size > MAX32 || e.compressedSize > MAX32 || e.offset > MAX32;
        for (const e of this.entries) {
            e.offset = offset;
            const z64 = e.size > MAX32 || e.compressedSize > MAX32;
            const extraLen = z64 ? 20 : 0;
            const lh = new ByteBuilder(30 + e.nameBytes.length + extraLen);
            lh.u32(0x04034b50);
            lh.u16(z64 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED_DEFLATE);
            lh.u16(FLAG_UTF8);
            lh.u16(e.method);
            lh.u16(DOS_TIME);
            lh.u16(DOS_DATE);
            lh.u32(e.crc);
            lh.u32(z64 ? MAX32 : e.compressedSize);
            lh.u32(z64 ? MAX32 : e.size);
            lh.u16(e.nameBytes.length);
            lh.u16(extraLen);
            lh.bytes(e.nameBytes);
            if (z64) {
                lh.u16(0x0001);
                lh.u16(16);
                lh.u64(e.size);
                lh.u64(e.compressedSize);
            }
            const header = lh.done();
            parts.push(header);
            offset += header.length;
            for (const chunk of e.data) {
                parts.push(chunk);
                offset += chunk.length;
            }
        }
        const cdStart = offset;
        let cdSize = 0;
        let anyZip64 = false;
        for (const e of this.entries) {
            const z64 = needsZip64Entry(e);
            anyZip64 ||= z64;
            const fields = [];
            if (e.size > MAX32) fields.push(['u64', e.size]);
            if (e.compressedSize > MAX32) fields.push(['u64', e.compressedSize]);
            if (e.offset > MAX32) fields.push(['u64', e.offset]);
            const extraLen = z64 ? 4 + fields.length * 8 : 0;
            const cd = new ByteBuilder(46 + e.nameBytes.length + extraLen);
            cd.u32(0x02014b50);
            cd.u16(VERSION_MADE_BY);
            cd.u16(z64 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED_DEFLATE);
            cd.u16(FLAG_UTF8);
            cd.u16(e.method);
            cd.u16(DOS_TIME);
            cd.u16(DOS_DATE);
            cd.u32(e.crc);
            cd.u32(e.compressedSize > MAX32 ? MAX32 : e.compressedSize);
            cd.u32(e.size > MAX32 ? MAX32 : e.size);
            cd.u16(e.nameBytes.length);
            cd.u16(extraLen);
            cd.u16(0); // comment length
            cd.u16(0); // disk number start
            cd.u16(0); // internal attributes
            cd.u32(0); // external attributes
            cd.u32(e.offset > MAX32 ? MAX32 : e.offset);
            cd.bytes(e.nameBytes);
            if (z64) {
                cd.u16(0x0001);
                cd.u16(fields.length * 8);
                for (const [, v] of fields) cd.u64(v);
            }
            const rec = cd.done();
            parts.push(rec);
            cdSize += rec.length;
        }
        offset += cdSize;
        const count = this.entries.length;
        const zip64 = anyZip64 || count > MAX16 - 1 || cdStart > MAX32 || cdSize > MAX32;
        if (zip64) {
            const eocd64 = new ByteBuilder(56);
            eocd64.u32(0x06064b50);
            eocd64.u64(44);
            eocd64.u16(VERSION_MADE_BY);
            eocd64.u16(VERSION_NEEDED_ZIP64);
            eocd64.u32(0);
            eocd64.u32(0);
            eocd64.u64(count);
            eocd64.u64(count);
            eocd64.u64(cdSize);
            eocd64.u64(cdStart);
            parts.push(eocd64.done());
            const locator = new ByteBuilder(20);
            locator.u32(0x07064b50);
            locator.u32(0);
            locator.u64(offset);
            locator.u32(1);
            parts.push(locator.done());
            offset += 76;
        }
        const eocd = new ByteBuilder(22);
        eocd.u32(0x06054b50);
        eocd.u16(0);
        eocd.u16(0);
        eocd.u16(count > MAX16 - 1 ? MAX16 : count);
        eocd.u16(count > MAX16 - 1 ? MAX16 : count);
        eocd.u32(cdSize > MAX32 ? MAX32 : cdSize);
        eocd.u32(cdStart > MAX32 ? MAX32 : cdStart);
        eocd.u16(0);
        parts.push(eocd.done());
        offset += 22;
        return {parts, size: offset, zip64};
    }
}

/** Concatenate chunks into one Uint8Array (tests and Node callers). */
export function concatParts(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.length;
    }
    return out;
}
