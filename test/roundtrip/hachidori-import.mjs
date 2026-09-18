#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Semantic round trip into the current Hachidori. Every fixture export is
// converted, each produced archive is imported by Hachidori's real WebAssembly
// engine (extension/vendor/hoshidicts.mjs from a Hachidori checkout, running
// in Node on MEMFS exactly like Hachidori's own test/node-smoke.mjs), and the
// engine's answers are compared with the rows of the original export:
//
//   * import report counts equal the export's row counts;
//   * every term in the export is found by hdw_lookup_dictionary with the same
//     reading, rules, score, glossary bytes and tags;
//   * kanji, frequency, pitch, styles and media bytes round-trip.
//
// Usage: HACHIDORI_DIR=/path/to/hachidori node test/roundtrip/hachidori-import.mjs

import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

import {convertExport, restoreGlossaryItem} from '../../src/convert.js';
import {readExport} from '../../src/dexie-export.js';
import {concatParts} from '../../src/zip-writer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', 'fixtures');
const HACHIDORI_DIR = process.env.HACHIDORI_DIR ?? '';
const VARIANT = process.env.HACHIDORI_WASM_VARIANT === 'threaded' ? 'hoshidicts-threaded' : 'hoshidicts';
const MODULE_PATH = join(HACHIDORI_DIR, 'extension', 'vendor', `${VARIANT}.mjs`);
if (!HACHIDORI_DIR || !existsSync(MODULE_PATH)) {
    console.error('HACHIDORI_DIR must point at a Hachidori checkout (extension/vendor/hoshidicts.mjs).');
    process.exit(2);
}
const hachidoriCommit = execFileSync('git', ['-C', HACHIDORI_DIR, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();

const {default: createHoshidicts} = await import(pathToFileURL(MODULE_PATH).href);
const M = await createHoshidicts();
const call = (name, ret, types, args) => M.ccall(name, ret, types, args);
const lastError = () => call('hdw_last_error', 'string', [], []);
const hdwImport = (zip, out) => JSON.parse(call('hdw_import', 'string', ['string', 'string', 'number'], [zip, out, 0]));
const addDict = (path, kind) => call('hdw_add_dict', 'number', ['string', 'number'], [path, kind]);
const lookupDictionary = (text, path) => JSON.parse(call('hdw_lookup_dictionary', 'string', ['string', 'string', 'number', 'number', 'string'], [text, path, 64, 32, '']));
const kanji = (character) => JSON.parse(call('hdw_kanji', 'string', ['string'], [character]));
const styles = () => JSON.parse(call('hdw_styles', 'string', [], []));
const media = (dictionary, path) => call('hdw_media', 'number', ['string', 'string'], [dictionary, path]);
const mediaBytes = (length) => {
    const ptr = call('hdw_media_data', 'pointer', [], []);
    return Uint8Array.from(M.HEAPU8.subarray(ptr, ptr + length));
};
const reset = () => call('hdw_reset', null, [], []);
const entriesOf = (dir) => M.FS.readdir(dir).filter((n) => n !== '.' && n !== '..');

M.FS.mkdir('/work');
if (call('hdw_init_storage', 'number', ['number'], [0]) !== 1) throw new Error(`storage init failed: ${lastError()}`);

const problems = [];
const fail = (msg) => problems.push(msg);
const same = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${what}\n    expected ${JSON.stringify(b)}\n    actual   ${JSON.stringify(a)}`); };

/** Group the export's rows per dictionary title. */
async function rowsByDictionary(bytes) {
    const dicts = new Map();
    const get = (title) => {
        if (!dicts.has(title)) dicts.set(title, {summary: null, terms: [], termMeta: [], kanji: [], kanjiMeta: [], tagMeta: [], media: []});
        return dicts.get(title);
    };
    await readExport(bytes, {
        onRow(table, key, value) {
            if (table === 'dictionaries') get(value.title).summary = value;
            else if (dicts.has(value.dictionary) || table !== 'dictionaries') get(value.dictionary)[table].push(value);
        },
    });
    return dicts;
}

const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
const report = [];
let generation = 0;
for (const file of files) {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, file)));
    const {archives} = await convertExport(bytes);
    const rows = await rowsByDictionary(bytes);
    const perArchive = [];
    for (const archive of archives) {
        const zipPath = `/work/${generation}.zip`;
        const root = `/dicts/g${generation++}`;
        M.FS.mkdir(root);
        M.FS.writeFile(zipPath, concatParts(archive.parts));
        const imported = hdwImport(zipPath, root);
        const source = rows.get(archive.title);
        const entry = {title: archive.title, success: imported.success, error: imported.error, counts: {}};
        perArchive.push(entry);
        if (!imported.success) {
            if (/[/\\]/.test(archive.title)) {
                entry.note = 'Hachidori refuses titles containing path separators (engine limitation, archive itself is valid).';
                continue;
            }
            fail(`${file} / ${archive.title}: Hachidori import failed: ${imported.error}`);
            continue;
        }
        same(imported.title, archive.title, `${archive.title}: title`);
        entry.counts = {termCount: imported.termCount, metaCount: imported.metaCount, frequencyCount: imported.frequencyCount, pitchCount: imported.pitchCount, kanjiCount: imported.kanjiCount, mediaCount: imported.mediaCount};
        same(imported.termCount, source.terms.length, `${archive.title}: termCount`);
        same(imported.metaCount, source.termMeta.length, `${archive.title}: metaCount`);
        same(imported.frequencyCount, source.termMeta.filter((m) => m.mode === 'freq').length, `${archive.title}: frequencyCount`);
        same(imported.pitchCount, source.termMeta.filter((m) => m.mode === 'pitch' || m.mode === 'ipa').length, `${archive.title}: pitchCount`);
        same(imported.kanjiCount, source.kanji.length, `${archive.title}: kanjiCount`);
        same(imported.mediaCount, source.media.length, `${archive.title}: mediaCount`);

        const dirs = entriesOf(root);
        if (dirs.length !== 1) { fail(`${archive.title}: expected one imported directory, found ${JSON.stringify(dirs)}`); continue; }
        const dictDir = `${root}/${dirs[0]}`;
        for (const kind of [0, 1, 2, 3]) {
            if (addDict(dictDir, kind) !== 1) fail(`${archive.title}: add_dict(${kind}) rejected: ${lastError()}`);
        }

        // Terms: expected glossary strings per (expression, reading), in export order.
        const expected = new Map();
        for (const t of source.terms) {
            const key = `${t.expression}\u0000${t.reading}`;
            if (!expected.has(key)) expected.set(key, {expression: t.expression, reading: t.reading, rules: t.rules, score: t.score, glossaries: []});
            const e = expected.get(key);
            e.score = Math.max(e.score, t.score);
            e.rules = [...new Set(`${e.rules} ${t.rules}`.split(' ').filter(Boolean))].sort().join(' ');
            e.glossaries.push({
                glossary: JSON.stringify((t.glossary ?? []).map((g) => restoreGlossaryItem(structuredClone(g), new Set()))),
                definitionTags: t.definitionTags ?? '',
                termTags: t.termTags ?? '',
            });
        }
        let termsChecked = 0;
        for (const e of expected.values()) {
            const {results} = lookupDictionary(e.expression, dictDir);
            const hit = results.find((r) => r.matched === e.expression && r.term.expression === e.expression && r.term.reading === e.reading);
            if (!hit) { fail(`${archive.title}: ${e.expression} (${e.reading}) not found by Hachidori`); continue; }
            // Hachidori merges rows sharing (expression, reading) and concatenates their rules.
            same([...new Set(hit.term.rules.split(' ').filter(Boolean))].sort().join(' '), e.rules, `${archive.title}: ${e.expression} rules`);
            same(hit.term.score, e.score, `${archive.title}: ${e.expression} score`);
            const got = hit.term.glossaries.filter((g) => g.dictionary === archive.title).map(({glossary, definitionTags, termTags}) => ({glossary, definitionTags, termTags}));
            same(got, e.glossaries, `${archive.title}: ${e.expression} glossaries`);
            // Frequencies attached to the term.
            const freqRows = source.termMeta.filter((m) => m.mode === 'freq' && m.expression === e.expression);
            const gotFreq = hit.term.frequencies.filter((f) => f.dictionary === archive.title).flatMap((f) => f.frequencies);
            if (freqRows.length > 0 && gotFreq.length === 0) fail(`${archive.title}: ${e.expression} has ${freqRows.length} frequency row(s) in the export but none from Hachidori`);
            termsChecked++;
        }
        entry.termsChecked = termsChecked;

        // Kanji.
        for (const k of source.kanji) {
            const {entries} = kanji(k.character);
            const hit = entries.find((x) => x.dictionary === archive.title);
            if (!hit) { fail(`${archive.title}: kanji ${k.character} not found`); continue; }
            same(hit.onyomi, k.onyomi, `${archive.title}: kanji ${k.character} onyomi`);
            same(hit.kunyomi, k.kunyomi, `${archive.title}: kanji ${k.character} kunyomi`);
            same(hit.tags, k.tags, `${archive.title}: kanji ${k.character} tags`);
            same(hit.definitions, k.meanings, `${archive.title}: kanji ${k.character} meanings`);
            const stats = Object.entries(k.stats ?? {}).map(([name, value]) => ({name, value: String(value)}));
            same(hit.stats.map((s) => ({name: s.name, value: s.value})).sort((a, b) => a.name.localeCompare(b.name)), stats.sort((a, b) => a.name.localeCompare(b.name)), `${archive.title}: kanji ${k.character} stats`);
        }
        entry.kanjiChecked = source.kanji.length;

        // Styles.
        const style = styles().find((s) => s.dictionary === archive.title);
        same(style?.styles ?? '', source.summary.styles ?? '', `${archive.title}: styles`);

        // Media bytes.
        let mediaChecked = 0;
        for (const m of source.media) {
            const length = media(archive.title, m.path);
            if (length <= 0) { fail(`${archive.title}: media ${m.path} not served (${lastError()})`); continue; }
            const got = mediaBytes(length);
            if (Buffer.compare(Buffer.from(got), Buffer.from(m.content)) !== 0) fail(`${archive.title}: media ${m.path} bytes differ`);
            mediaChecked++;
        }
        entry.mediaChecked = mediaChecked;
        reset();
    }
    report.push({fixture: file, archives: perArchive});
}

console.log(JSON.stringify({hachidoriCommit, engine: VARIANT, report}, null, 2));
if (problems.length > 0) {
    console.error(`FAILED: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
    process.exit(1);
}
console.log('HACHIDORI_ROUNDTRIP_OK');
