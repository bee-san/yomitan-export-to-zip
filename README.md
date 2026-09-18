# Yomitan export to ZIP

**Site:** https://bee-san.github.io/yomitan-export-to-zip/

Turn a Yomitan *Export Dictionary Collection* file
(`yomitan-dictionaries-<date>.json`, from **Settings › Backup**) back into
standalone Yomitan dictionary `.zip` files, one per dictionary, named
`1-<title>.zip`, `2-<title>.zip`, … in installation order. Sort them by name or
re-order them by hand and the numbers follow. The archives import into Yomitan
and into [Hachidori](https://github.com/bee-san/hachidori).

Everything runs in the browser. The export is read from disk as a stream by
JavaScript in the page; nothing is uploaded, the page makes no network requests
after it has loaded, its Content-Security-Policy forbids `connect-src`, and
there are no analytics.

## Using it

1. In Yomitan open **Settings › Backup › Export Dictionary Collection** and save
   the JSON file.
2. Open the site and choose (or drop) that file. The list of dictionaries
   appears after reading only the beginning of the file.
3. Optionally sort by name or move dictionaries up and down. File names are
   renumbered live.
4. **Convert to ZIP files**, then download each archive or **Download all**.
5. Import the archives into Yomitan or Hachidori in file-name order.

Converting the same export twice, in any browser or in Node, produces
byte-identical archives, so the downloads can be checksummed and diffed.

## What is preserved

Dictionary metadata (`index.json` including author, URLs, languages, frequency
mode, updatable-dictionary links, minimum version), terms with all glossary
types (plain text, images, structured content), term tags and definition tags,
frequencies, pitch accents and IPA, kanji and kanji frequencies, tag banks,
`styles.css`, and every image Yomitan stored, byte for byte.

[docs/FORMAT.md](docs/FORMAT.md) documents the input format from Yomitan's
source, the field-by-field mapping, and everything the export cannot represent
(unused files, format 1 details, empty-vs-equal readings, original bank layout,
dictionary priority order).

## Development

No build step. `index.html`, `styles.css`, `src/` and `vendor/fflate.js` are the
whole site; GitHub Pages serves them as-is.

```sh
npm ci
npm run test:unit        # node:test — parsing, conversion, Yomitan schema validation, determinism,
                         # malformed/partial/duplicate/empty/large inputs
npx playwright install chromium
npm run test:browser     # Playwright — conversion in Chromium, download names, sorting, offline/privacy,
                         # axe accessibility, keyboard, narrow screens, error messages
npm run serve            # http://127.0.0.1:8765/
```

Round-trip checks need external checkouts:

```sh
# Narrow Yomitan compatibility import: every produced archive is imported by Yomitan's own
# DictionaryImporter (fake-indexeddb) and re-exported; rows must equal the fixture's.
YOMITAN_DIR=/path/to/yomitan node test/roundtrip/yomitan-import.mjs

# Semantic round trip into current Hachidori: archives are imported by Hachidori's real
# hoshidicts wasm engine and every term, kanji, frequency, style and media byte is compared.
HACHIDORI_DIR=/path/to/hachidori node test/roundtrip/hachidori-import.mjs

# Regenerate fixtures with Yomitan's own importer + export library.
YOMITAN_DIR=/path/to/yomitan npm run fixtures
```

`YOMITAN_DIR` needs `npm ci && npm run build:libs` in the Yomitan checkout.
CI runs all of the above on every push and pull request.

## Layout

| Path | Purpose |
| --- | --- |
| `src/json-stream.js` | Chunked JSON parser that streams `data.data[*].rows` |
| `src/dexie-export.js` | dexie-export-import envelope validation and typeson revival |
| `src/convert.js` | Inverse of Yomitan's importer; builds one archive per dictionary |
| `src/zip-writer.js` | Deterministic ZIP container (fixed timestamps, ZIP64 when needed) |
| `src/app.js`, `src/worker.js` | Page controller and the Web Worker that does the work |
| `vendor/fflate.js` | Pinned fflate 0.8.3 ESM build (MIT) for raw deflate |
| `test/fixtures/` | Real-format exports produced by Yomitan's code; see `PROVENANCE.md` |
| `test/schemas/` | Yomitan's dictionary JSON schemas, used to validate output |

## License

GPL-3.0-or-later. `vendor/fflate.js` is MIT (see `vendor/fflate.LICENSE`);
`test/schemas/` are Yomitan's (GPL-3.0-or-later).
