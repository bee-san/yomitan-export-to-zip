// SPDX-License-Identifier: GPL-3.0-or-later
//
// Page controller. All work happens locally: the selected File is handed to a
// module Worker (src/worker.js) which streams it and returns Blobs. If module
// workers are unavailable the same code runs on the main thread.

import {archiveFileName} from './convert.js';

const $ = (id) => document.getElementById(id);
const els = {
    fileInput: $('file-input'),
    fileName: $('file-name'),
    dropzone: $('dropzone'),
    status: $('status'),
    error: $('error'),
    dictionariesSection: $('dictionaries-section'),
    convertSection: $('convert-section'),
    rows: $('dictionary-rows'),
    sortExport: $('sort-export'),
    sortNameAsc: $('sort-name-asc'),
    sortNameDesc: $('sort-name-desc'),
    convert: $('convert'),
    downloadAll: $('download-all'),
    reset: $('reset'),
    progressWrap: $('progress-wrap'),
    progress: $('progress'),
    progressLabel: $('progress-label'),
    report: $('report'),
    reportList: $('report-list'),
};

const state = {
    file: null,
    /** @type {Array<{key: unknown, title: string, revision: string, version: number, counts: object|undefined}>} */
    dictionaries: [],
    /** output order as a list of dictionary keys */
    order: [],
    /** @type {Map<unknown, {blob: Blob, url: string, size: number, warnings: Array<{message: string}>}>} */
    archives: new Map(),
    warnings: [],
    busy: false,
};

// --- worker plumbing -----------------------------------------------------------

let worker = null;
let requestId = 0;
const pending = new Map();
let mainThreadModule = null;

function getWorker() {
    if (worker !== null) return worker;
    try {
        worker = new Worker(new URL('./worker.js', import.meta.url), {type: 'module'});
    } catch {
        return null;
    }
    worker.addEventListener('message', (event) => {
        const msg = event.data;
        const req = pending.get(msg.id);
        if (!req) return;
        if (msg.type === 'progress') {
            req.onProgress?.(msg);
        } else if (msg.type === 'error') {
            pending.delete(msg.id);
            const error = new Error(msg.error.message);
            error.name = msg.error.name;
            req.reject(error);
        } else {
            pending.delete(msg.id);
            req.resolve(msg);
        }
    });
    worker.addEventListener('error', (event) => {
        // A failed module worker (e.g. unsupported browser) falls back to the main thread.
        for (const req of pending.values()) req.reject(new Error(event.message || 'Worker failed'));
        pending.clear();
        worker.terminate();
        worker = null;
        workerBroken = true;
    });
    return worker;
}
let workerBroken = false;

async function runTask(type, file, onProgress) {
    const w = workerBroken ? null : getWorker();
    if (w !== null) {
        try {
            return await new Promise((resolve, reject) => {
                const id = ++requestId;
                pending.set(id, {resolve, reject, onProgress});
                w.postMessage({id, type, file});
            });
        } catch (error) {
            if (!workerBroken) throw error;
        }
    }
    // Main-thread fallback
    mainThreadModule ??= await import('./convert.js');
    if (type === 'scan') {
        const result = await mainThreadModule.scanExport(file, {onBytes: (bytes) => onProgress?.({phase: 'scan', bytes})});
        return {type: 'scanned', ...result};
    }
    const result = await mainThreadModule.convertExport(file, {onProgress: (p) => onProgress?.({phase: 'convert', ...p})});
    return {
        type: 'converted',
        header: result.header,
        warnings: result.warnings,
        archives: result.archives.map((a) => ({...a, blob: new Blob(a.parts, {type: 'application/zip'}), parts: undefined})),
    };
}

function cancelWork() {
    if (worker !== null) {
        worker.terminate();
        worker = null;
    }
    for (const req of pending.values()) req.reject(new DOMException('Cancelled', 'AbortError'));
    pending.clear();
}

// --- rendering ------------------------------------------------------------------

const numberFormat = new Intl.NumberFormat();

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function setStatus(text) {
    els.status.textContent = text;
}

function showError(message) {
    els.error.textContent = message;
    els.error.hidden = false;
}

function clearError() {
    els.error.hidden = true;
    els.error.textContent = '';
}

function describeCounts(d) {
    const c = d.counts;
    if (!c) return 'contents unknown';
    const parts = [];
    const add = (label, n) => { if (typeof n === 'number' && n > 0) parts.push(`${numberFormat.format(n)} ${label}`); };
    add('terms', c.terms?.total);
    add('term meta', c.termMeta?.total);
    add('kanji', c.kanji?.total);
    add('kanji meta', c.kanjiMeta?.total);
    add('tags', c.tagMeta?.total);
    add('media files', c.media?.total);
    return parts.length > 0 ? parts.join(', ') : 'empty';
}

function orderedDictionaries() {
    const byKey = new Map(state.dictionaries.map((d) => [d.key, d]));
    return state.order.map((key) => byKey.get(key));
}

function fileNameFor(position, title) {
    return archiveFileName(position, state.order.length, title);
}

function renderRows(focusKey = null, focusDirection = null) {
    const dictionaries = orderedDictionaries();
    els.rows.replaceChildren();
    dictionaries.forEach((d, i) => {
        const position = i + 1;
        const tr = document.createElement('tr');
        tr.dataset.key = String(d.key);

        const tdPos = document.createElement('td');
        tdPos.className = 'position';
        tdPos.dataset.label = 'Position';
        tdPos.textContent = String(position);

        const tdTitle = document.createElement('td');
        tdTitle.dataset.label = 'Dictionary';
        const title = document.createElement('div');
        title.className = 'dict-title';
        title.textContent = d.title;
        const meta = document.createElement('div');
        meta.className = 'dict-meta';
        meta.textContent = `revision ${d.revision}${d.version !== 3 ? ` · stored as format ${d.version}, written as format 3` : ''}`;
        tdTitle.append(title, meta);

        const tdContents = document.createElement('td');
        tdContents.dataset.label = 'Contents';
        tdContents.className = 'contents';
        tdContents.textContent = describeCounts(d);

        const tdMove = document.createElement('td');
        tdMove.dataset.label = 'Move';
        const moves = document.createElement('div');
        moves.className = 'move-buttons';
        const up = document.createElement('button');
        up.type = 'button';
        up.textContent = '↑';
        up.setAttribute('aria-label', `Move ${d.title} up`);
        up.disabled = i === 0 || state.busy;
        up.addEventListener('click', () => move(d.key, -1));
        const down = document.createElement('button');
        down.type = 'button';
        down.textContent = '↓';
        down.setAttribute('aria-label', `Move ${d.title} down`);
        down.disabled = i === dictionaries.length - 1 || state.busy;
        down.addEventListener('click', () => move(d.key, 1));
        moves.append(up, down);
        tdMove.append(moves);

        const tdArchive = document.createElement('td');
        tdArchive.dataset.label = 'Archive';
        const name = fileNameFor(position, d.title);
        const archive = state.archives.get(d.key);
        if (archive) {
            const a = document.createElement('a');
            a.className = 'download';
            a.href = archive.url;
            a.download = name;
            a.textContent = `Download ${name}`;
            a.setAttribute('aria-label', `Download ${name} (${formatBytes(archive.size)})`);
            const size = document.createElement('div');
            size.className = 'dict-meta';
            size.textContent = formatBytes(archive.size);
            tdArchive.append(a, size);
            if (archive.warnings.length > 0) {
                const warn = document.createElement('div');
                warn.className = 'dict-meta';
                warn.textContent = `${archive.warnings.length} note(s), see report`;
                tdArchive.append(warn);
            }
        } else {
            const span = document.createElement('span');
            span.className = 'archive-name';
            span.textContent = name;
            tdArchive.append(span);
        }

        tr.append(tdPos, tdTitle, tdContents, tdMove, tdArchive);
        els.rows.append(tr);

        if (focusKey !== null && d.key === focusKey) {
            // Keep keyboard focus on the moved row's control.
            const target = focusDirection < 0 ? (up.disabled ? down : up) : (down.disabled ? up : down);
            queueMicrotask(() => target.focus());
        }
    });
    els.downloadAll.hidden = state.archives.size === 0;
}

function renderReport() {
    els.reportList.replaceChildren();
    const items = [];
    const dictionaries = orderedDictionaries();
    items.push({text: `${dictionaries.length} archive(s) written. Output bytes depend only on the export contents, so converting the same file again produces identical archives.`});
    for (const w of state.warnings) {
        items.push({text: (w.dictionary ? `${w.dictionary}: ` : '') + w.message, warning: true});
    }
    for (const it of items) {
        const li = document.createElement('li');
        li.textContent = it.text;
        if (it.warning) li.className = 'warning';
        els.reportList.append(li);
    }
    els.report.hidden = false;
}

// --- actions -------------------------------------------------------------------

function move(key, delta) {
    const i = state.order.indexOf(key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= state.order.length) return;
    [state.order[i], state.order[j]] = [state.order[j], state.order[i]];
    renderRows(key, delta);
    setStatus(`Moved to position ${j + 1} of ${state.order.length}.`);
}

const collator = new Intl.Collator(undefined, {sensitivity: 'base', numeric: true});

function sortBy(kind) {
    const dictionaries = orderedDictionaries();
    if (kind === 'export') {
        dictionaries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    } else {
        dictionaries.sort((a, b) => {
            const c = collator.compare(a.title, b.title) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
            return kind === 'name-desc' ? -c : c;
        });
    }
    state.order = dictionaries.map((d) => d.key);
    renderRows();
    setStatus(kind === 'export' ? 'Restored the export order.' : `Sorted by dictionary name, ${kind === 'name-asc' ? 'A to Z' : 'Z to A'}.`);
}

function setBusy(busy) {
    state.busy = busy;
    els.convert.disabled = busy || state.archives.size > 0;
    els.fileInput.disabled = busy;
    els.sortExport.disabled = busy;
    els.sortNameAsc.disabled = busy;
    els.sortNameDesc.disabled = busy;
    renderRows();
}

function resetAll() {
    cancelWork();
    for (const a of state.archives.values()) URL.revokeObjectURL(a.url);
    state.file = null;
    state.dictionaries = [];
    state.order = [];
    state.archives = new Map();
    state.warnings = [];
    state.busy = false;
    els.fileInput.value = '';
    els.fileInput.disabled = false;
    els.fileName.textContent = '';
    els.dictionariesSection.hidden = true;
    els.convertSection.hidden = true;
    els.progressWrap.hidden = true;
    els.progress.value = 0;
    els.report.hidden = true;
    els.downloadAll.hidden = true;
    els.convert.disabled = false;
    els.rows.replaceChildren();
    clearError();
    setStatus('');
}

async function chooseFile(file) {
    resetAll();
    if (!file) return;
    state.file = file;
    els.fileName.textContent = `${file.name} (${formatBytes(file.size)})`;
    if (!/\.json$/i.test(file.name) && file.type !== 'application/json') {
        showError(`"${file.name}" does not look like a JSON file. Choose the yomitan-dictionaries-….json export produced by Yomitan.`);
        return;
    }
    setBusy(true);
    setStatus('Reading the list of dictionaries…');
    try {
        const result = await runTask('scan', file, (p) => {
            if (p.phase === 'scan' && file.size > 0) {
                setStatus(`Reading the list of dictionaries… ${Math.min(100, Math.round((p.bytes / file.size) * 100))}%`);
            }
        });
        state.dictionaries = result.dictionaries;
        state.order = result.dictionaries.map((d) => d.key);
        state.warnings = result.warnings ?? [];
        if (state.dictionaries.length === 0) {
            showError('This export contains no dictionaries. Yomitan writes this shape when the dictionary collection is empty, so there is nothing to convert.');
            setStatus('No dictionaries found.');
            setBusy(false);
            return;
        }
        els.dictionariesSection.hidden = false;
        els.convertSection.hidden = false;
        setBusy(false);
        setStatus(`Found ${state.dictionaries.length} dictionar${state.dictionaries.length === 1 ? 'y' : 'ies'}. Order them, then convert.`);
        if (state.warnings.length > 0) renderReport();
    } catch (error) {
        setBusy(false);
        setStatus('Could not read the file.');
        showError(describeError(error));
    }
}

function describeError(error) {
    if (error?.name === 'AbortError') return 'Cancelled.';
    return error?.message ?? String(error);
}

async function convert() {
    if (!state.file || state.busy) return;
    clearError();
    setBusy(true);
    els.progressWrap.hidden = false;
    els.progress.value = 0;
    els.progressLabel.textContent = 'Converting…';
    setStatus('Converting…');
    const size = state.file.size;
    try {
        const result = await runTask('convert', state.file, (p) => {
            if (p.phase !== 'convert') return;
            const pct = size > 0 ? Math.min(100, Math.round((p.bytes / size) * 100)) : 0;
            els.progress.value = pct;
            els.progressLabel.textContent = `Converting… ${pct}% (${numberFormat.format(p.rows ?? 0)} rows${p.table ? `, ${p.table}` : ''})`;
        });
        for (const a of result.archives) {
            state.archives.set(a.key, {blob: a.blob, url: URL.createObjectURL(a.blob), size: a.size, warnings: a.warnings ?? []});
        }
        state.warnings = result.warnings ?? [];
        els.progress.value = 100;
        els.progressLabel.textContent = 'Conversion finished.';
        setBusy(false);
        renderReport();
        setStatus(`Conversion finished: ${result.archives.length} archive(s) ready to download.`);
        els.downloadAll.focus();
    } catch (error) {
        setBusy(false);
        els.progressWrap.hidden = true;
        setStatus('Conversion failed.');
        showError(describeError(error));
    }
}

async function downloadAll() {
    const links = [...els.rows.querySelectorAll('a.download')];
    setStatus(`Starting ${links.length} download(s). Your browser may ask for permission to download multiple files.`);
    for (const a of links) {
        a.click();
        await new Promise((r) => setTimeout(r, 250));
    }
}

// --- wiring --------------------------------------------------------------------

els.fileInput.addEventListener('change', () => chooseFile(els.fileInput.files?.[0] ?? null));
els.dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dropzone.classList.add('dragover');
});
els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('dragover'));
els.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) chooseFile(file);
});
els.sortExport.addEventListener('click', () => sortBy('export'));
els.sortNameAsc.addEventListener('click', () => sortBy('name-asc'));
els.sortNameDesc.addEventListener('click', () => sortBy('name-desc'));
els.convert.addEventListener('click', convert);
els.downloadAll.addEventListener('click', downloadAll);
els.reset.addEventListener('click', () => {
    resetAll();
    els.fileInput.focus();
});

// Expose a tiny hook for automated tests (no behavior change for users).
window.__yomitanExportToZip = {state, fileNameFor: (position, title) => fileNameFor(position, title)};
