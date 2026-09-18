// SPDX-License-Identifier: GPL-3.0-or-later
//
// Incremental JSON parser. Text is pushed in chunks; the parser builds values
// with an explicit stack (no recursion) and, for arrays whose path matches
// `streamArray`, hands each completed element to `onItem` instead of keeping
// it. Everything else is assembled into ordinary JS values, so a
// gigabyte-scale export whose bulk lives in `data.data[*].rows` needs memory
// proportional to one row, not to the file.
//
// Key order of parsed objects is insertion order, exactly as in the text.

const MAX_DEPTH = 256;

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
const LITERALS = new Map([['true', true], ['false', false], ['null', null]]);
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export class JsonSyntaxError extends Error {
    /**
     * @param {string} message
     * @param {number} position character offset in the decoded text
     */
    constructor(message, position) {
        super(`${message} (at character ${position})`);
        this.name = 'JsonSyntaxError';
        this.position = position;
    }
}

/**
 * @typedef {object} ParserOptions
 * @property {(path: (string|number)[]) => boolean} [streamArray] return true for arrays whose
 *   elements should be streamed out through onItem instead of retained.
 * @property {(item: unknown, path: (string|number)[], parent: unknown) => void} [onItem]
 *   receives each element of a streamed array; `parent` is the (partially built) object that
 *   contains the array, so callers can read sibling keys that came earlier in the text.
 * @property {(path: (string|number)[], parent: unknown) => void} [onArrayEnd] called when a
 *   streamed array closes.
 */

export class StreamingJsonParser {
    /** @param {ParserOptions} [options] */
    constructor(options = {}) {
        this._streamArray = options.streamArray ?? (() => false);
        this._onItem = options.onItem ?? (() => {});
        this._onArrayEnd = options.onArrayEnd ?? (() => {});
        /** Container stack: {type:'object'|'array', value, key, streamed, count} */
        this._stack = [];
        /** Path of keys/indices from the root to the current container. */
        this._path = [];
        this._root = undefined;
        this._hasRoot = false;
        this._done = false;
        // Token state that may span chunk boundaries.
        this._mode = 'value'; // 'value' | 'key' | 'colon' | 'comma-or-end'
        this._partial = ''; // pending literal/number text
        this._inString = false;
        this._stringParts = [];
        this._stringEscapes = false;
        this._stringIsKey = false;
        this._esc = null;
        this._position = 0;
    }

    /** Result after end(); undefined until then. */
    get result() {
        return this._root;
    }

    /** The root value as built so far (containers still open are included). */
    get partialRoot() {
        return this._stack.length > 0 ? this._stack[0].value : this._root;
    }

    /** Number of characters consumed so far. */
    get position() {
        return this._position;
    }

    /** @param {string} chunk */
    feed(chunk) {
        if (this._done) throw new JsonSyntaxError('Unexpected data after end of JSON document', this._position);
        let i = 0;
        const n = chunk.length;
        while (i < n) {
            if (this._inString) {
                i = this._continueString(chunk, i);
                continue;
            }
            if (this._partial.length > 0) {
                i = this._continueLiteral(chunk, i);
                continue;
            }
            const c = chunk.charCodeAt(i);
            if (WS.has(c)) { i++; this._position++; continue; }
            switch (this._mode) {
                case 'value':
                    i = this._beginValue(chunk, i, c);
                    break;
                case 'key':
                    if (c === 0x22) { // "
                        this._stringIsKey = true;
                        this._inString = true;
                        i = this._continueString(chunk, i + 1);
                    } else if (c === 0x7d && this._top().count === 0) { // } empty object
                        this._closeContainer('object');
                        i++;
                        this._position++;
                    } else {
                        throw new JsonSyntaxError('Expected string key in object', this._position);
                    }
                    break;
                case 'colon':
                    if (c !== 0x3a) throw new JsonSyntaxError('Expected ":" after object key', this._position);
                    this._mode = 'value';
                    i++;
                    this._position++;
                    break;
                case 'comma-or-end': {
                    if (this._stack.length === 0) throw new JsonSyntaxError('Unexpected data after end of JSON document', this._position);
                    const top = this._top();
                    if (c === 0x2c) { // ,
                        this._mode = top.type === 'object' ? 'key' : 'value';
                        top.expectMore = true;
                    } else if (c === 0x5d && top.type === 'array') {
                        this._closeContainer('array');
                    } else if (c === 0x7d && top.type === 'object') {
                        this._closeContainer('object');
                    } else {
                        throw new JsonSyntaxError(`Expected "," or closing bracket, found ${JSON.stringify(chunk[i])}`, this._position);
                    }
                    i++;
                    this._position++;
                    break;
                }
                default:
                    throw new JsonSyntaxError('Invalid parser state', this._position);
            }
        }
    }

    /** Signal end of input and return the root value. */
    end() {
        if (this._inString) throw new JsonSyntaxError('Unexpected end of input inside a string', this._position);
        if (this._partial.length > 0) {
            this._finishLiteral();
        }
        if (this._stack.length > 0) throw new JsonSyntaxError(`Unexpected end of input: ${this._stack.length} unclosed container(s); the file is truncated`, this._position);
        if (!this._hasRoot) throw new JsonSyntaxError('Empty input: no JSON value found', this._position);
        this._done = true;
        return this._root;
    }

    // --- internals ---------------------------------------------------------

    _top() {
        const top = this._stack[this._stack.length - 1];
        if (!top) throw new JsonSyntaxError('Unexpected token outside of any container', this._position);
        return top;
    }

    _beginValue(chunk, i, c) {
        if (this._hasRoot && this._stack.length === 0) {
            throw new JsonSyntaxError('Unexpected data after end of JSON document', this._position);
        }
        switch (c) {
            case 0x7b: // {
                this._openContainer('object', {});
                this._mode = 'key';
                return this._advance(i);
            case 0x5b: { // [
                const top = this._stack[this._stack.length - 1];
                const path = top ? [...this._path, top.type === 'object' ? top.pendingKey : top.count] : [];
                const streamed = this._streamArray(path);
                this._openContainer('array', [], streamed);
                this._mode = 'value';
                return this._advance(i);
            }
            case 0x5d: { // ] — only legal for an empty array
                const top = this._top();
                if (top.type === 'array' && top.count === 0 && !top.expectMore) {
                    this._closeContainer('array');
                    return this._advance(i);
                }
                throw new JsonSyntaxError('Unexpected "]"', this._position);
            }
            case 0x22: // "
                this._stringIsKey = false;
                this._inString = true;
                return this._continueString(chunk, i + 1);
            default: {
                // number or literal: accumulate until a delimiter
                const start = i;
                let j = i;
                while (j < chunk.length) {
                    const cc = chunk.charCodeAt(j);
                    if (WS.has(cc) || cc === 0x2c || cc === 0x5d || cc === 0x7d) break;
                    j++;
                }
                this._partial = chunk.slice(start, j);
                this._position += j - start;
                if (j < chunk.length) this._finishLiteral();
                return j;
            }
        }
    }

    _advance(i) {
        this._position++;
        return i + 1;
    }

    _continueLiteral(chunk, i) {
        let j = i;
        while (j < chunk.length) {
            const cc = chunk.charCodeAt(j);
            if (WS.has(cc) || cc === 0x2c || cc === 0x5d || cc === 0x7d) break;
            j++;
        }
        this._partial += chunk.slice(i, j);
        this._position += j - i;
        if (this._partial.length > 64) throw new JsonSyntaxError('Invalid token', this._position);
        if (j < chunk.length) this._finishLiteral();
        return j;
    }

    _finishLiteral() {
        const text = this._partial;
        this._partial = '';
        let value;
        if (LITERALS.has(text)) {
            value = LITERALS.get(text);
        } else if (NUMBER_RE.test(text)) {
            value = Number(text);
        } else {
            throw new JsonSyntaxError(`Invalid token ${JSON.stringify(text.slice(0, 32))}`, this._position);
        }
        this._emitValue(value);
    }

    /**
     * Consume string characters starting at i (just after the opening quote, or mid-string).
     * Uses indexOf to skip long runs (base64 media content) quickly. Escape sequences are kept
     * raw and decoded once with JSON.parse when the string closes; `_esc` buffers an escape
     * that a chunk boundary cut in half.
     */
    _continueString(chunk, i) {
        const n = chunk.length;
        while (i < n) {
            if (this._esc !== null) {
                const need = this._esc.length >= 2 ? (this._esc[1] === 'u' ? 6 : 2) : 2;
                const take = Math.min(need - this._esc.length, n - i);
                this._esc += chunk.slice(i, i + take);
                this._position += take;
                i += take;
                const needNow = this._esc.length >= 2 ? (this._esc[1] === 'u' ? 6 : 2) : 2;
                if (this._esc.length >= needNow) {
                    this._stringParts.push(this._esc);
                    this._stringEscapes = true;
                    this._esc = null;
                }
                continue;
            }
            let q = chunk.indexOf('"', i);
            let b = chunk.indexOf('\\', i);
            if (q === -1) q = n;
            if (b === -1) b = n;
            const stop = Math.min(q, b);
            if (stop > i) {
                this._checkControlChars(chunk, i, stop);
                this._stringParts.push(chunk.slice(i, stop));
                this._position += stop - i;
                i = stop;
            }
            if (i >= n) return i;
            if (chunk.charCodeAt(i) === 0x22) {
                this._position++;
                i++;
                const raw = this._stringParts.length === 1 ? this._stringParts[0] : this._stringParts.join('');
                this._stringParts = [];
                let value;
                if (this._stringEscapes) {
                    try {
                        value = JSON.parse(`"${raw}"`);
                    } catch {
                        throw new JsonSyntaxError('Invalid escape sequence in string', this._position);
                    }
                } else {
                    value = raw;
                }
                this._stringEscapes = false;
                this._inString = false;
                if (this._stringIsKey) {
                    const top = this._top();
                    top.pendingKey = value;
                    this._mode = 'colon';
                } else {
                    this._emitValue(value);
                }
                return i;
            }
            // backslash: start an escape sequence
            this._esc = '\\';
            this._position++;
            i++;
        }
        return i;
    }

    _checkControlChars(chunk, from, to) {
        for (let k = from; k < to; k++) {
            if (chunk.charCodeAt(k) < 0x20) {
                throw new JsonSyntaxError('Unescaped control character in string', this._position + (k - from));
            }
        }
    }

    _openContainer(type, value, streamed = false) {
        if (this._stack.length >= MAX_DEPTH) throw new JsonSyntaxError(`Nesting deeper than ${MAX_DEPTH} levels`, this._position);
        const top = this._stack[this._stack.length - 1];
        if (top) {
            this._path.push(top.type === 'object' ? top.pendingKey : top.count);
            // Attach now so partialRoot exposes in-progress structure; _emitValue finalizes it.
            if (top.type === 'object') top.value[top.pendingKey] = value;
            else if (!top.streamed) top.value.push(value);
        }
        this._stack.push({type, value, streamed, count: 0, pendingKey: undefined, expectMore: false});
    }

    _closeContainer(type) {
        const frame = this._stack.pop();
        if (!frame || frame.type !== type) throw new JsonSyntaxError(`Mismatched closing ${type === 'array' ? '"]"' : '"}"'}`, this._position);
        if (frame.expectMore) throw new JsonSyntaxError('Trailing comma', this._position);
        if (frame.streamed) {
            const parent = this._stack[this._stack.length - 1];
            this._onArrayEnd([...this._path], parent ? parent.value : undefined);
            frame.value = new StreamedArrayPlaceholder(frame.count);
        }
        if (this._stack.length > 0) this._path.pop();
        this._emitValue(frame.value, true);
    }

    /**
     * @param {unknown} value
     * @param {boolean} [attached] true when the value is a container already linked to its parent
     */
    _emitValue(value, attached = false) {
        const top = this._stack[this._stack.length - 1];
        if (!top) {
            this._root = value;
            this._hasRoot = true;
            this._mode = 'comma-or-end';
            return;
        }
        if (top.type === 'object') {
            top.value[top.pendingKey] = value;
            top.pendingKey = undefined;
        } else if (top.streamed) {
            const parent = this._stack[this._stack.length - 2];
            this._onItem(value, [...this._path, top.count], parent ? parent.value : undefined);
        } else if (!attached) {
            top.value.push(value);
        }
        top.count++;
        top.expectMore = false;
        this._mode = 'comma-or-end';
    }
}

/** Stands in for an array whose elements were streamed out. */
export class StreamedArrayPlaceholder {
    constructor(length) {
        this.length = length;
    }
}

/**
 * Parse a whole string through the streaming parser (handy for tests and small inputs).
 * @param {string} text
 * @param {ParserOptions} [options]
 */
export function parseJsonText(text, options) {
    const parser = new StreamingJsonParser(options);
    parser.feed(text);
    return parser.end();
}

/**
 * Decode a byte stream as UTF-8 and feed it into an existing parser.
 * @param {StreamingJsonParser} parser
 * @param {ReadableStream<Uint8Array>|AsyncIterable<Uint8Array>} byteStream
 * @param {{onBytes?: (bytes: number) => void, signal?: AbortSignal}} [options]
 */
export async function feedStream(parser, byteStream, options = {}) {
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let bytes = 0;
    const iterable = Symbol.asyncIterator in byteStream ? byteStream : readableToAsyncIterable(byteStream);
    for await (const chunk of iterable) {
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        bytes += chunk.byteLength;
        let text;
        try {
            text = decoder.decode(chunk, {stream: true});
        } catch {
            throw new JsonSyntaxError('Input is not valid UTF-8', parser.position);
        }
        if (text.length > 0) parser.feed(text);
        options.onBytes?.(bytes);
    }
    let tail;
    try {
        tail = decoder.decode();
    } catch {
        throw new JsonSyntaxError('Input is not valid UTF-8', parser.position);
    }
    if (tail.length > 0) parser.feed(tail);
    return parser.end();
}

/**
 * Parse a ReadableStream<Uint8Array> (or async iterable of Uint8Array).
 * @param {ReadableStream<Uint8Array>|AsyncIterable<Uint8Array>} byteStream
 * @param {ParserOptions & {onBytes?: (bytes: number) => void, signal?: AbortSignal}} [options]
 */
export async function parseJsonStream(byteStream, options = {}) {
    return feedStream(new StreamingJsonParser(options), byteStream, options);
}

/** @param {ReadableStream<Uint8Array>} stream */
async function* readableToAsyncIterable(stream) {
    const reader = stream.getReader();
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) return;
            yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

/** Throw from an onItem/onArrayEnd callback to stop reading early with the partial result. */
export class StopStreaming extends Error {
    constructor() {
        super('stop');
        this.name = 'StopStreaming';
    }
}
