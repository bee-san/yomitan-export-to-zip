// SPDX-License-Identifier: GPL-3.0-or-later
//
// Reader for the dexie-export-import JSON format that Yomitan produces from
// Settings > Backup > "Export Dictionary Collection"
// (ext/js/pages/settings/backup-controller.js -> Dexie#export()).
//
// Shape (formatVersion 1):
//   {
//     "formatName": "dexie",
//     "formatVersion": 1,
//     "data": {
//       "databaseName": "dict",
//       "databaseVersion": 6,
//       "tables": [{"name", "schema", "rowCount"}, ...],
//       "data": [{"tableName", "inbound", "rows": [...]}, ...]
//     }
//   }
//
// Each row is encoded with typeson (typeson-registry "structured cloning"
// preset). For tables whose primary key lives inside the object (inbound),
// a row is the object itself with an optional "$types" map. For tables with
// out-of-line keys (inbound: false) a row is the tuple [key, value], which
// typeson wraps as {"$": [key, value], "$types": {"$": {...}}}.

import {JsonSyntaxError, StopStreaming, StreamingJsonParser, feedStream} from './json-stream.js';

export class ExportFormatError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ExportFormatError';
    }
}

/** Yomitan's dictionary database name and the tables it defines (dictionary-database.js). */
export const YOMITAN_DATABASE_NAME = 'dict';
export const YOMITAN_TABLES = ['dictionaries', 'terms', 'termMeta', 'kanji', 'kanjiMeta', 'tagMeta', 'media'];

// --- typeson revival ---------------------------------------------------------

function base64ToBytes(text) {
    if (typeof text !== 'string') throw new ExportFormatError('Expected base64 string for binary data');
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
        const buf = Buffer.from(text, 'base64');
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

const TYPED_ARRAYS = {
    int8array: Int8Array,
    uint8array: Uint8Array,
    uint8clampedarray: Uint8ClampedArray,
    int16array: Int16Array,
    uint16array: Uint16Array,
    int32array: Int32Array,
    uint32array: Uint32Array,
    float32array: Float32Array,
    float64array: Float64Array,
};

/**
 * Revive one typeson type at a location.
 * @param {string} type
 * @param {unknown} value
 * @param {{buffers: Uint8Array[]}} state
 * @param {string} keypath
 */
function reviveType(type, value, state, keypath) {
    switch (type) {
        case 'arrayNonindexKeys': {
            // Plain arrays are emitted unchanged; arrays carrying non-index keys are emitted
            // as objects with the index keys plus the extra keys.
            if (Array.isArray(value)) return value;
            if (value && typeof value === 'object') {
                const arr = [];
                for (const [k, v] of Object.entries(value)) {
                    if (/^(?:0|[1-9]\d*)$/.test(k)) arr[Number(k)] = v;
                    else arr[k] = v;
                }
                return arr;
            }
            throw new ExportFormatError(`Cannot revive array at "${keypath}"`);
        }
        case 'arraybuffer': {
            if (value && typeof value === 'object' && 'index' in value) {
                const ref = state.buffers[value.index];
                if (!ref) throw new ExportFormatError(`Dangling ArrayBuffer reference at "${keypath}"`);
                return ref;
            }
            const bytes = base64ToBytes(value);
            state.buffers.push(bytes);
            return bytes;
        }
        case 'blob':
        case 'file': {
            if (!value || typeof value !== 'object') throw new ExportFormatError(`Cannot revive Blob at "${keypath}"`);
            return base64ToBytes(value.data);
        }
        case 'dataview': {
            const {encoded, index, byteOffset, byteLength} = value;
            const buf = index !== undefined ? state.buffers[index] : base64ToBytes(encoded);
            if (index === undefined) state.buffers.push(buf);
            return buf.subarray(byteOffset, byteOffset + byteLength);
        }
        case 'undef':
            return undefined;
        case 'NegativeZero':
        case 'negativeZero':
            return -0;
        case 'nan':
            return NaN;
        case 'infinity':
            return Infinity;
        case 'negativeInfinity':
            return -Infinity;
        case 'date':
            return new Date(value);
        case 'bigint':
            return BigInt(value);
        case '#':
            throw new ExportFormatError(`Cyclic references are not supported (at "${keypath}")`);
        default: {
            const Ctor = TYPED_ARRAYS[type];
            if (Ctor) {
                const {encoded, index, byteOffset, length} = value;
                let buf;
                if (index !== undefined) {
                    buf = state.buffers[index];
                    if (!buf) throw new ExportFormatError(`Dangling buffer reference at "${keypath}"`);
                } else {
                    buf = base64ToBytes(encoded);
                    state.buffers.push(buf);
                }
                // Normalize every binary payload to Uint8Array bytes.
                const view = new Ctor(buf.buffer, buf.byteOffset + byteOffset, length);
                return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
            }
            throw new ExportFormatError(`Unsupported typeson type "${type}" at "${keypath}"`);
        }
    }
}

function splitKeypath(keypath) {
    if (keypath === '') return [];
    return keypath.split('.').map((part) => part.replace(/~1/g, '.').replace(/~0/g, '~'));
}

/**
 * Revive a typeson-encapsulated row.
 * @param {unknown} row
 * @returns {unknown}
 */
export function reviveTypeson(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !Object.prototype.hasOwnProperty.call(row, '$types')) {
        return row;
    }
    const {$types} = row;
    if ($types === true) {
        // {"$": value, "$types": true}: value is a plain object that itself has a "$types" key.
        return row.$;
    }
    if (!$types || typeof $types !== 'object') throw new ExportFormatError('Invalid "$types" annotation');
    let value;
    let types;
    if ($types.$ && typeof $types.$ === 'object' && !Array.isArray($types.$) && Object.prototype.hasOwnProperty.call(row, '$')) {
        value = row.$;
        types = $types.$;
    } else {
        value = {};
        for (const [k, v] of Object.entries(row)) if (k !== '$types') value[k] = v;
        types = $types;
    }
    const state = {buffers: []};
    // Deeper paths first, as typeson does, so parents see revived children.
    const entries = Object.entries(types).map(([kp, t]) => [splitKeypath(kp), t, kp]);
    entries.sort((a, b) => b[0].length - a[0].length);
    for (const [parts, typeSpec, keypath] of entries) {
        const typeList = Array.isArray(typeSpec) ? typeSpec : [typeSpec];
        if (parts.length === 0) {
            for (const t of typeList) value = reviveType(t, value, state, keypath);
            continue;
        }
        let parent = value;
        for (let i = 0; i < parts.length - 1; i++) {
            if (parent === null || typeof parent !== 'object') throw new ExportFormatError(`Missing path "${keypath}" while reviving row`);
            parent = parent[parts[i]];
        }
        if (parent === null || typeof parent !== 'object') throw new ExportFormatError(`Missing path "${keypath}" while reviving row`);
        const last = parts[parts.length - 1];
        let current = parent[last];
        for (const t of typeList) current = reviveType(t, current, state, keypath);
        if (current === undefined) delete parent[last];
        else parent[last] = current;
    }
    return value;
}

// --- export reading ----------------------------------------------------------

/**
 * @typedef {object} ExportHandlers
 * @property {(header: {databaseName: string, databaseVersion: number, tables: Array<{name: string, schema: string, rowCount: number}>}) => void} [onHeader]
 * @property {(table: {tableName: string, inbound: boolean}) => void} [onTableStart]
 * @property {(tableName: string, key: unknown, value: unknown, inbound: boolean) => void} [onRow]
 * @property {(tableName: string, rowsSeen: number) => void} [onTableEnd]
 * @property {(bytes: number) => void} [onBytes]
 * @property {AbortSignal} [signal]
 */

const ROWS_PATH_LENGTH = 4; // data.data[i].rows

function isRowsPath(path) {
    return path.length === ROWS_PATH_LENGTH && path[0] === 'data' && path[1] === 'data' && typeof path[2] === 'number' && path[3] === 'rows';
}

function makeParserOptions(handlers, getPartialRoot) {
    let currentTable = null;
    let rowsSeen = 0;
    let headerChecked = false;
    const tableStarted = (parent, index) => {
        if (!headerChecked) {
            // formatName/formatVersion/tables all precede "data" in the text, so the header
            // can be validated before the first row is processed.
            const header = validateExportHeader(getPartialRoot());
            headerChecked = true;
            handlers.onHeader?.(header);
        }
        if (!parent || typeof parent !== 'object') throw new ExportFormatError('Table entry is not an object');
        const {tableName, inbound} = parent;
        if (typeof tableName !== 'string') {
            throw new ExportFormatError('Table entry has no "tableName" before its "rows" (unsupported key order)');
        }
        if (typeof inbound !== 'boolean') {
            throw new ExportFormatError(`Table "${tableName}" has no boolean "inbound" before its "rows"`);
        }
        currentTable = {tableName, inbound, index};
        rowsSeen = 0;
        handlers.onTableStart?.({tableName, inbound});
    };
    return {
        streamArray: isRowsPath,
        onItem(item, path, parent) {
            if (currentTable === null || path[2] !== currentTable.index) tableStarted(parent, path[2]);
            const revived = reviveTypeson(item);
            let key;
            let value;
            if (currentTable.inbound) {
                value = revived;
                key = undefined;
            } else {
                if (!Array.isArray(revived) || revived.length !== 2) {
                    throw new ExportFormatError(`Row ${rowsSeen} of table "${currentTable.tableName}" is not a [key, value] tuple`);
                }
                [key, value] = revived;
            }
            rowsSeen++;
            handlers.onRow?.(currentTable.tableName, key, value, currentTable.inbound);
        },
        onArrayEnd(path, parent) {
            if (currentTable === null || path[2] !== currentTable.index) tableStarted(parent, path[2]);
            handlers.onTableEnd?.(currentTable.tableName, rowsSeen);
            currentTable = null;
        },
        headerChecked: () => headerChecked,
    };
}

/**
 * Validate the non-row part of the document and return its header.
 * @param {unknown} root
 */
export function validateExportHeader(root) {
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
        throw new ExportFormatError('The file is not a JSON object. Expected a Yomitan dictionary export (yomitan-dictionaries-*.json).');
    }
    const {formatName, formatVersion, data} = root;
    if (formatName !== 'dexie') {
        throw new ExportFormatError(`Not a Yomitan dictionary export: expected "formatName": "dexie", found ${JSON.stringify(formatName)}. Yomitan settings backups (yomitan-settings-*.json) and dictionary ZIPs are not supported here.`);
    }
    if (formatVersion !== 1) {
        throw new ExportFormatError(`Unsupported export formatVersion ${JSON.stringify(formatVersion)} (only version 1 is supported)`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new ExportFormatError('Export has no "data" object');
    }
    const {databaseName, databaseVersion, tables} = data;
    if (typeof databaseName !== 'string') throw new ExportFormatError('Export has no "databaseName"');
    if (!Array.isArray(tables)) throw new ExportFormatError('Export has no "tables" list');
    for (const t of tables) {
        if (!t || typeof t !== 'object' || typeof t.name !== 'string' || typeof t.rowCount !== 'number') {
            throw new ExportFormatError('Malformed table description in "tables"');
        }
    }
    if (data.data !== undefined && data.data !== null && typeof data.data !== 'object') {
        throw new ExportFormatError('Export "data.data" must be a list of tables');
    }
    return {databaseName, databaseVersion, tables};
}

/**
 * Turn any supported source into an async iterable of Uint8Array chunks.
 * @param {ReadableStream<Uint8Array>|AsyncIterable<Uint8Array>|Blob|Uint8Array|string} source
 */
function toByteIterable(source) {
    if (typeof source === 'string') {
        const bytes = new TextEncoder().encode(source);
        return (async function* () { yield bytes; })();
    }
    if (source instanceof Uint8Array) {
        return (async function* () { yield source; })();
    }
    if (typeof Blob !== 'undefined' && source instanceof Blob) {
        return source.stream();
    }
    return source;
}

/**
 * Read an export from a byte source, streaming rows to the handlers.
 * @param {ReadableStream<Uint8Array>|AsyncIterable<Uint8Array>|Blob|Uint8Array|string} source
 * @param {ExportHandlers} handlers
 * @returns {Promise<{header: ReturnType<typeof validateExportHeader>, tableCount: number}>}
 */
export async function readExport(source, handlers = {}) {
    let parser;
    const options = makeParserOptions(handlers, () => parser.partialRoot);
    parser = new StreamingJsonParser(options);
    let root;
    try {
        root = await feedStream(parser, toByteIterable(source), {onBytes: handlers.onBytes, signal: handlers.signal});
    } catch (error) {
        if (error instanceof JsonSyntaxError) {
            throw new ExportFormatError(`The file is not valid JSON: ${error.message}`);
        }
        throw error;
    }
    const header = validateExportHeader(root);
    if (!options.headerChecked()) handlers.onHeader?.(header);
    const tableList = Array.isArray(root.data.data) ? root.data.data : [];
    return {header, tableCount: tableList.length};
}

/**
 * Read only until the end of the given table (default "dictionaries"), then stop.
 * Yomitan's export lists tables alphabetically, so "dictionaries" is first and this
 * touches only the head of even a multi-gigabyte file.
 * @param {ReadableStream<Uint8Array>|Blob|Uint8Array|string} source
 * @param {string} tableName
 * @param {(key: unknown, value: unknown) => void} onRow
 * @param {Pick<ExportHandlers, 'onHeader'|'onBytes'|'signal'>} [extra]
 * @returns {Promise<boolean>} true when the table was found
 */
export async function readTableThenStop(source, tableName, onRow, extra = {}) {
    let found = false;
    const handlers = {
        ...extra,
        onTableStart(table) {
            if (found && table.tableName !== tableName) throw new StopStreaming();
        },
        onRow(name, key, value) {
            if (name === tableName) { found = true; onRow(key, value); }
        },
        onTableEnd(name) {
            if (name === tableName) { found = true; throw new StopStreaming(); }
        },
    };
    try {
        await readExport(source, handlers);
    } catch (error) {
        if (!(error instanceof StopStreaming)) throw error;
    }
    return found;
}

export {StopStreaming};
