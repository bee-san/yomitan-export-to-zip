// SPDX-License-Identifier: GPL-3.0-or-later
//
// Rebuilds standalone Yomitan dictionary archives from the rows of a Yomitan
// dictionary-collection export. The row shapes are the ones written by
// Yomitan's importer (ext/js/dictionary/dictionary-importer.js); this module
// is its inverse, documented field by field in docs/FORMAT.md.

import {ExportFormatError, YOMITAN_DATABASE_NAME, YOMITAN_TABLES, readExport, readTableThenStop} from './dexie-export.js';
import {DeterministicZipWriter, prepareEntry} from './zip-writer.js';

/** Rows per *_bank_N.json file. */
export const BANK_SIZE = 10000;
/** Largest number of dictionaries a single export is allowed to describe. */
export const MAX_DICTIONARIES = 10000;

const IMAGE_COMMON_KEYS = ['title', 'alt', 'description', 'pixelated', 'imageRendering', 'appearance', 'background', 'collapsed', 'collapsible'];
const IMAGE_NODE_EXTRA_KEYS = ['verticalAlign', 'border', 'borderRadius', 'sizeUnits'];
const INDEX_OPTIONAL_STRING_KEYS = ['author', 'url', 'description', 'attribution', 'sourceLanguage', 'targetLanguage', 'frequencyMode', 'minimumYomitanVersion'];
const RESERVED_NAME_RE = /^(?:index\.json|styles\.css|(?:term|term_meta|kanji|kanji_meta|tag)_bank_\d+\.json)$/;

// --- file names --------------------------------------------------------------

/**
 * Make a dictionary title safe for use in a download file name on Windows, macOS and Linux.
 * @param {string} title
 */
export function sanitizeFileName(title) {
    let safe = String(title)
        .normalize('NFC')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+|\.+$/g, '')
        .trim();
    if (safe.length > 80) safe = safe.slice(0, 80).trim();
    if (safe.length === 0 || /^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(safe)) safe = 'dictionary';
    return safe;
}

/**
 * `1-dict.zip`, `2-dict.zip`, …; zero-padded to the width of the largest position so that a
 * plain alphabetical file listing keeps the intended order (`01-`…`12-`).
 * @param {number} position 1-based
 * @param {number} total
 * @param {string} title
 */
export function archiveFileName(position, total, title) {
    const width = String(Math.max(total, 1)).length;
    return `${String(position).padStart(width, '0')}-${sanitizeFileName(title)}.zip`;
}

// --- glossary / structured content restoration --------------------------------

/**
 * Inverse of DictionaryImporter._createImageData: the importer replaced the author's
 * width/height with the decoded image's dimensions and moved the originals to
 * preferredWidth/preferredHeight.
 * @param {Record<string, unknown>} stored
 * @param {'image'|'img'} kind
 * @param {Set<string>} mediaPaths
 */
function restoreImage(stored, kind, mediaPaths) {
    const out = kind === 'image' ? {type: 'image'} : {tag: 'img'};
    if (typeof stored.path === 'string') {
        out.path = stored.path;
        mediaPaths.add(stored.path);
    }
    if (typeof stored.preferredWidth === 'number') out.width = stored.preferredWidth;
    if (typeof stored.preferredHeight === 'number') out.height = stored.preferredHeight;
    for (const key of IMAGE_COMMON_KEYS) {
        if (stored[key] !== undefined) out[key] = stored[key];
    }
    if (kind === 'img') {
        for (const key of IMAGE_NODE_EXTRA_KEYS) {
            if (stored[key] !== undefined) out[key] = stored[key];
        }
    }
    return out;
}

/** Mirrors DictionaryImporter._prepareStructuredContent, undoing only the img transformation. */
function restoreStructuredContent(content, mediaPaths) {
    if (typeof content !== 'object' || content === null) return content;
    if (Array.isArray(content)) {
        for (let i = 0; i < content.length; i++) content[i] = restoreStructuredContent(content[i], mediaPaths);
        return content;
    }
    if (content.tag === 'img') return restoreImage(content, 'img', mediaPaths);
    if (content.content !== undefined) content.content = restoreStructuredContent(content.content, mediaPaths);
    return content;
}

/**
 * @param {unknown} item one stored glossary item
 * @param {Set<string>} mediaPaths
 */
export function restoreGlossaryItem(item, mediaPaths) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
    switch (item.type) {
        case 'image':
            return restoreImage(item, 'image', mediaPaths);
        case 'structured-content':
            return {type: 'structured-content', content: restoreStructuredContent(item.content, mediaPaths)};
        default:
            return item;
    }
}

// --- index.json ----------------------------------------------------------------

/**
 * Inverse of DictionaryImporter._createSummary.
 * @param {Record<string, unknown>} summary row from the "dictionaries" table
 * @param {number} format output format number
 */
export function buildIndex(summary, format) {
    const index = {
        title: summary.title,
        format,
        revision: summary.revision,
        sequenced: summary.sequenced === true,
    };
    for (const key of INDEX_OPTIONAL_STRING_KEYS) {
        if (typeof summary[key] === 'string') index[key] = summary[key];
    }
    if (summary.isUpdatable === true && typeof summary.indexUrl === 'string' && typeof summary.downloadUrl === 'string') {
        index.isUpdatable = true;
        index.indexUrl = summary.indexUrl;
        index.downloadUrl = summary.downloadUrl;
    }
    return index;
}

// --- per-dictionary builder ------------------------------------------------------

class Bank {
    /** @param {string} prefix e.g. "term_bank" */
    constructor(prefix) {
        this.prefix = prefix;
        this.rows = [];
        this.entries = [];
        this.total = 0;
    }
    push(row) {
        this.rows.push(row);
        this.total++;
        if (this.rows.length >= BANK_SIZE) this.flush();
    }
    flush() {
        if (this.rows.length === 0) return;
        const name = `${this.prefix}_${this.entries.length + 1}.json`;
        this.entries.push(prepareEntry(name, JSON.stringify(this.rows)));
        this.rows = [];
    }
}

function isSafeMediaPath(path) {
    if (typeof path !== 'string' || path.length === 0 || path.length > 1024) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
    if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return false;
    const segments = path.split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
    if (RESERVED_NAME_RE.test(path)) return false;
    return true;
}

export class DictionaryBuilder {
    /**
     * @param {unknown} key primary key in the "dictionaries" table (import order)
     * @param {Record<string, unknown>} summary
     */
    constructor(key, summary) {
        this.key = key;
        this.summary = summary;
        this.title = summary.title;
        this.sourceFormat = summary.version;
        // Format 1 banks are emitted as format 3 (sequence 0, no term tags, empty kanji stats):
        // that is lossless for the data the importer kept, and current Yomitan cannot import
        // format 1 archives that carry glossaries anyway.
        this.format = 3;
        this.warnings = [];
        this.banks = {
            terms: new Bank('term_bank'),
            termMeta: new Bank('term_meta_bank'),
            kanji: new Bank('kanji_bank'),
            kanjiMeta: new Bank('kanji_meta_bank'),
            tagMeta: new Bank('tag_bank'),
        };
        /** @type {Map<string, import('./zip-writer.js').ZipEntry>} */
        this.media = new Map();
        this.mediaDuplicates = 0;
        this.mediaUnsafe = [];
        this.referencedMedia = new Set();
        this.rowCounts = {terms: 0, termMeta: 0, kanji: 0, kanjiMeta: 0, tagMeta: 0, media: 0};
        this.mediaBytes = 0;
        if (this.sourceFormat === 1) {
            this.warn('format-upgraded', 'Stored as a format 1 dictionary; written as format 3 (sequence 0, no term tags, empty kanji stats).');
        }
    }

    warn(code, message) {
        this.warnings.push({code, message, dictionary: this.title});
    }

    /** @param {Record<string, unknown>} row */
    addTerm(row) {
        this.rowCounts.terms++;
        const {expression, reading, definitionTags, rules, score, glossary, sequence, termTags} = row;
        if (typeof expression !== 'string' || typeof reading !== 'string') {
            throw new ExportFormatError(`Term row ${this.rowCounts.terms} of "${this.title}" has no expression/reading`);
        }
        const glossaryList = Array.isArray(glossary) ? glossary.map((g) => restoreGlossaryItem(g, this.referencedMedia)) : [];
        if (!Array.isArray(glossary)) this.warnOnce('term-glossary-missing', 'Some term rows had no glossary list; written as empty glossaries.');
        this.banks.terms.push([
            expression,
            reading,
            typeof definitionTags === 'string' || definitionTags === null ? definitionTags : '',
            typeof rules === 'string' ? rules : '',
            typeof score === 'number' ? score : 0,
            glossaryList,
            typeof sequence === 'number' ? sequence : 0,
            typeof termTags === 'string' ? termTags : '',
        ]);
    }

    addTermMeta(row) {
        this.rowCounts.termMeta++;
        const {expression, mode, data} = row;
        if (typeof expression !== 'string' || typeof mode !== 'string') {
            throw new ExportFormatError(`Term meta row ${this.rowCounts.termMeta} of "${this.title}" is malformed`);
        }
        this.banks.termMeta.push([expression, mode, data]);
    }

    addKanji(row) {
        this.rowCounts.kanji++;
        const {character, onyomi, kunyomi, tags, meanings, stats} = row;
        if (typeof character !== 'string') {
            throw new ExportFormatError(`Kanji row ${this.rowCounts.kanji} of "${this.title}" has no character`);
        }
        this.banks.kanji.push([
            character,
            typeof onyomi === 'string' ? onyomi : '',
            typeof kunyomi === 'string' ? kunyomi : '',
            typeof tags === 'string' ? tags : '',
            Array.isArray(meanings) ? meanings : [],
            stats && typeof stats === 'object' ? stats : {},
        ]);
    }

    addKanjiMeta(row) {
        this.rowCounts.kanjiMeta++;
        const {character, mode, data} = row;
        if (typeof character !== 'string' || typeof mode !== 'string') {
            throw new ExportFormatError(`Kanji meta row ${this.rowCounts.kanjiMeta} of "${this.title}" is malformed`);
        }
        this.banks.kanjiMeta.push([character, mode, data]);
    }

    addTag(row) {
        this.rowCounts.tagMeta++;
        const {name, category, order, notes, score} = row;
        if (typeof name !== 'string') {
            throw new ExportFormatError(`Tag row ${this.rowCounts.tagMeta} of "${this.title}" has no name`);
        }
        this.banks.tagMeta.push([
            name,
            typeof category === 'string' ? category : '',
            typeof order === 'number' ? order : 0,
            typeof notes === 'string' ? notes : '',
            typeof score === 'number' ? score : 0,
        ]);
    }

    addMedia(row) {
        this.rowCounts.media++;
        const {path, content} = row;
        if (!isSafeMediaPath(path)) {
            this.mediaUnsafe.push(String(path).slice(0, 80));
            return;
        }
        if (this.media.has(path)) {
            this.mediaDuplicates++;
            return;
        }
        if (!(content instanceof Uint8Array)) {
            throw new ExportFormatError(`Media "${path}" of "${this.title}" has no binary content`);
        }
        // Images are already compressed; storing them keeps the archive deterministic and fast.
        this.media.set(path, prepareEntry(path, content, {compress: false}));
        this.mediaBytes += content.byteLength;
    }

    warnOnce(code, message) {
        if (!this.warnings.some((w) => w.code === code)) this.warn(code, message);
    }

    /**
     * @returns {{parts: Uint8Array[], size: number, zip64: boolean, entryNames: string[]}}
     */
    finish() {
        const writer = new DeterministicZipWriter();
        writer.add('index.json', JSON.stringify(buildIndex(this.summary, this.format)));
        for (const bankName of ['terms', 'termMeta', 'kanji', 'kanjiMeta', 'tagMeta']) {
            const bank = this.banks[bankName];
            bank.flush();
            for (const entry of bank.entries) writer.addPrepared(entry);
        }
        if (typeof this.summary.styles === 'string' && this.summary.styles.length > 0) {
            writer.add('styles.css', this.summary.styles);
        }
        for (const path of [...this.media.keys()].sort()) {
            writer.addPrepared(this.media.get(path));
        }

        // Consistency checks against the counts Yomitan recorded at import time.
        const counts = this.summary.counts;
        if (counts && typeof counts === 'object') {
            for (const [table, actual] of Object.entries(this.rowCounts)) {
                const expected = counts[table]?.total;
                if (typeof expected === 'number' && expected !== actual) {
                    this.warn('count-mismatch', `Yomitan recorded ${expected} ${table} row(s) at import time but the export contains ${actual}; the export may be partial.`);
                }
            }
        }
        const missingMedia = [...this.referencedMedia].filter((p) => !this.media.has(p));
        if (missingMedia.length > 0) {
            this.warn('media-missing', `${missingMedia.length} image path(s) referenced by entries have no media row in the export (e.g. ${JSON.stringify(missingMedia[0])}); Yomitan will refuse to import this archive until those files are added.`);
        }
        if (this.mediaUnsafe.length > 0) {
            this.warn('media-unsafe-path', `${this.mediaUnsafe.length} media row(s) skipped because their path is not a safe relative archive path (e.g. ${JSON.stringify(this.mediaUnsafe[0])}).`);
        }
        if (this.mediaDuplicates > 0) {
            this.warn('media-duplicate', `${this.mediaDuplicates} duplicate media path(s) ignored (first occurrence kept).`);
        }
        const result = writer.finish();
        return {...result, entryNames: writer.entries.map((e) => e.name)};
    }
}

// --- scanning and converting -------------------------------------------------------

/**
 * @typedef {object} DictionaryInfo
 * @property {unknown} key primary key (import order)
 * @property {string} title
 * @property {string} revision
 * @property {number} version
 * @property {boolean} sequenced
 * @property {number|undefined} importDate
 * @property {Record<string, {total: number}>|undefined} counts
 * @property {string|undefined} author
 * @property {string|undefined} description
 * @property {boolean} hasStyles
 */

function summarizeDictionary(key, summary) {
    if (!summary || typeof summary !== 'object' || typeof summary.title !== 'string' || typeof summary.revision !== 'string') {
        throw new ExportFormatError(`Row ${JSON.stringify(key)} of the "dictionaries" table is not a dictionary summary (missing title/revision)`);
    }
    return {
        key,
        title: summary.title,
        revision: summary.revision,
        version: typeof summary.version === 'number' ? summary.version : 3,
        sequenced: summary.sequenced === true,
        importDate: typeof summary.importDate === 'number' ? summary.importDate : undefined,
        counts: summary.counts && typeof summary.counts === 'object' ? summary.counts : undefined,
        author: typeof summary.author === 'string' ? summary.author : undefined,
        description: typeof summary.description === 'string' ? summary.description : undefined,
        hasStyles: typeof summary.styles === 'string' && summary.styles.length > 0,
    };
}

function headerWarnings(header) {
    const warnings = [];
    if (header.databaseName !== YOMITAN_DATABASE_NAME) {
        warnings.push({code: 'database-name', message: `Database is named ${JSON.stringify(header.databaseName)} rather than "dict"; this may not be a Yomitan export.`});
    }
    const known = new Set(YOMITAN_TABLES);
    const unknown = header.tables.map((t) => t.name).filter((n) => !known.has(n));
    if (unknown.length > 0) {
        warnings.push({code: 'unknown-tables', message: `Ignoring unknown table(s): ${unknown.join(', ')}.`});
    }
    const missing = YOMITAN_TABLES.filter((n) => !header.tables.some((t) => t.name === n));
    if (missing.length > 0) {
        warnings.push({code: 'missing-tables', message: `Export lacks table(s): ${missing.join(', ')}; the dictionaries may be incomplete.`});
    }
    return warnings;
}

function checkDuplicateTitles(dictionaries) {
    const seen = new Map();
    for (const d of dictionaries) {
        if (seen.has(d.title)) {
            throw new ExportFormatError(`The export lists the dictionary title ${JSON.stringify(d.title)} twice (rows ${JSON.stringify(seen.get(d.title))} and ${JSON.stringify(d.key)}). Yomitan keys every entry by title, so these rows cannot be separated.`);
        }
        seen.set(d.title, d.key);
    }
}

/**
 * Read just enough of the export to list its dictionaries (the "dictionaries" table is the
 * first one in the file).
 * @param {Blob|Uint8Array|string|ReadableStream<Uint8Array>} source
 * @param {{onBytes?: (bytes: number) => void, signal?: AbortSignal}} [options]
 * @returns {Promise<{header: object, dictionaries: DictionaryInfo[], warnings: Array<{code: string, message: string}>, totalRows: number}>}
 */
export async function scanExport(source, options = {}) {
    let header = null;
    const dictionaries = [];
    const found = await readTableThenStop(source, 'dictionaries', (key, value) => {
        dictionaries.push(summarizeDictionary(key, value));
        if (dictionaries.length > MAX_DICTIONARIES) throw new ExportFormatError(`More than ${MAX_DICTIONARIES} dictionaries in one export`);
    }, {onHeader: (h) => { header = h; }, onBytes: options.onBytes, signal: options.signal});
    if (header === null) {
        // The file had no "data" rows at all; read it fully to surface a format error or the header.
        ({header} = await readExport(source, {}));
    }
    if (!found && !header.tables.some((t) => t.name === 'dictionaries')) {
        throw new ExportFormatError('The export has no "dictionaries" table, so it is not a Yomitan dictionary collection.');
    }
    checkDuplicateTitles(dictionaries);
    dictionaries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const totalRows = header.tables.reduce((sum, t) => sum + (t.rowCount || 0), 0);
    return {header, dictionaries, warnings: headerWarnings(header), totalRows};
}

/**
 * @typedef {object} ArchiveResult
 * @property {unknown} key
 * @property {string} title
 * @property {Uint8Array[]} parts archive bytes, in order
 * @property {number} size
 * @property {boolean} zip64
 * @property {string[]} entryNames
 * @property {Record<string, number>} rowCounts
 * @property {number} mediaBytes
 * @property {number} sourceFormat
 * @property {number} format
 * @property {Array<{code: string, message: string, dictionary?: string}>} warnings
 */

/**
 * Convert a whole export into one archive per dictionary. Output bytes depend only on the
 * export contents (not on the order the caller later assigns).
 * @param {Blob|Uint8Array|string|ReadableStream<Uint8Array>} source
 * @param {{onProgress?: (p: {bytes: number, rows: number, table?: string}) => void, signal?: AbortSignal}} [options]
 * @returns {Promise<{header: object, archives: ArchiveResult[], warnings: Array<{code: string, message: string, dictionary?: string}>}>}
 */
export async function convertExport(source, options = {}) {
    /** @type {Map<string, DictionaryBuilder>} */
    const builders = new Map();
    const infos = [];
    const orphanRows = new Map();
    let header = null;
    let rows = 0;
    let bytes = 0;
    let currentTable = '';
    let dictionariesTableSeen = false;
    const progress = () => options.onProgress?.({bytes, rows, table: currentTable});

    const builderFor = (tableName, value) => {
        const title = value && typeof value === 'object' ? value.dictionary : undefined;
        const builder = typeof title === 'string' ? builders.get(title) : undefined;
        if (builder === undefined) {
            const label = typeof title === 'string' ? title : '(no dictionary field)';
            orphanRows.set(label, (orphanRows.get(label) ?? 0) + 1);
            return null;
        }
        return builder;
    };

    await readExport(source, {
        signal: options.signal,
        onHeader(h) {
            header = h;
        },
        onBytes(b) {
            bytes = b;
            progress();
        },
        onTableStart({tableName}) {
            currentTable = tableName;
            if (tableName === 'dictionaries') dictionariesTableSeen = true;
            else if (!dictionariesTableSeen && YOMITAN_TABLES.includes(tableName)) {
                throw new ExportFormatError(`Table "${tableName}" appears before "dictionaries"; Yomitan exports list tables alphabetically, so this file was rewritten or is not a Yomitan export.`);
            }
        },
        onRow(tableName, key, value) {
            rows++;
            if ((rows & 0x3ff) === 0) progress();
            switch (tableName) {
                case 'dictionaries': {
                    const info = summarizeDictionary(key, value);
                    infos.push(info);
                    if (infos.length > MAX_DICTIONARIES) throw new ExportFormatError(`More than ${MAX_DICTIONARIES} dictionaries in one export`);
                    if (builders.has(info.title)) checkDuplicateTitles(infos);
                    builders.set(info.title, new DictionaryBuilder(key, value));
                    break;
                }
                case 'terms': builderFor(tableName, value)?.addTerm(value); break;
                case 'termMeta': builderFor(tableName, value)?.addTermMeta(value); break;
                case 'kanji': builderFor(tableName, value)?.addKanji(value); break;
                case 'kanjiMeta': builderFor(tableName, value)?.addKanjiMeta(value); break;
                case 'tagMeta': builderFor(tableName, value)?.addTag(value); break;
                case 'media': builderFor(tableName, value)?.addMedia(value); break;
                default: break; // unknown table, reported via headerWarnings
            }
        },
    });

    const warnings = headerWarnings(header);
    if (orphanRows.size > 0) {
        const detail = [...orphanRows.entries()].slice(0, 5).map(([t, n]) => `${JSON.stringify(t)}: ${n}`).join(', ');
        warnings.push({code: 'orphan-rows', message: `Skipped rows belonging to dictionaries that the export does not list (${detail}). The export may be partial or edited.`});
    }
    const archives = [];
    for (const info of infos) {
        const builder = builders.get(info.title);
        const result = builder.finish();
        archives.push({
            key: builder.key,
            title: builder.title,
            parts: result.parts,
            size: result.size,
            zip64: result.zip64,
            entryNames: result.entryNames,
            rowCounts: builder.rowCounts,
            mediaBytes: builder.mediaBytes,
            sourceFormat: builder.sourceFormat,
            format: builder.format,
            warnings: builder.warnings,
        });
        warnings.push(...builder.warnings);
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    }
    archives.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    progress();
    return {header, archives, warnings};
}
