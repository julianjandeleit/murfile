# murfile

A file-oriented encoder/decoder, CLI and browser live reader for Blockchain Commons Uniform Resources and Multipart UR (MUR).

The project deliberately reuses the published Blockchain Commons TypeScript implementations:

- [`@blockchaincommons/uniform-resources`](https://github.com/BlockchainCommons/bc-ur-ts) for UR parsing, CBOR payloads, Bytewords, fountain encoding and fountain decoding.
- [`@blockchaincommons/dcbor`](https://github.com/BlockchainCommons/bc-dcbor-ts) for deterministic CBOR byte strings.
- [`@blockchaincommons/multipart-ur`](https://github.com/BlockchainCommons/bc-mur-ts) for standards-compatible QR rendering.
- [`@undecaf/zbar-wasm`](https://github.com/undecaf/zbar-wasm) for local multi-symbol QR recognition in the browser.

UR, Bytewords, Fountain and QR encoding use the published Blockchain Commons implementations. Page-scoped mode additionally uses a non-systematic Vandermonde MDS erasure code over the Fountain source blocks.

> **Maturity:** the Blockchain Commons TypeScript UR/MUR packages are currently published as beta software. This repository is a prototype/integration layer, not an audited production transfer tool. Validate it against independent implementations and the target phones before relying on it.

## Requirements

- Node.js **22.12 or newer**.
- npm (or another Node package manager).
- For camera access: a browser with `getUserMedia`, WebAssembly and module workers.
- Camera access requires a secure context: HTTPS or `localhost`.

## Install

```bash
npm install
```

## Core library

The library API is transport-independent. It accepts and returns UR strings; camera access and image decoding remain outside the core.

```js
import { FileEncoder, FileDecoder } from 'murfile';

const data = new Uint8Array([0, 1, 2, 3, 254, 255]);
const encoder = new FileEncoder(data, { maxFragmentLength: 100 });
const fragments = encoder.take(20); // a finite prefix from the infinite fountain stream

const decoder = new FileDecoder();
for (const fragment of fragments) {
  const result = decoder.add(fragment);
  if (result.kind === 'complete') break;
}

if (decoder.complete) {
  const recovered = decoder.result;
}
```

`FileEncoder` creates `ur:bytes` with a CBOR byte-string payload. If the complete CBOR payload fits in one configured fragment, it emits one ordinary UR; otherwise it delegates MUR fragmentation to Blockchain Commons' `MultipartEncoder`. The MUR stream is infinite by design; callers choose how many parts to export. Page-scoped exports wrap the MUR source blocks in Murfile's `ur:murpage` MDS code so that any configured number of missing cells can be recovered; global exports remain standard MUR.

`FileDecoder` routes multipart fragments to the official `MultipartDecoder` and single-part URs to `UR.parse()`. It exposes the official fountain decoder's `progress` value (0–1), as well as received, duplicate, redundant and invalid counters.

The shared QR/grid functions are available from the `murfile/qr-grid` package subpath, separately from the Murfile CLI and browser application.

Each `FileDecoder` instance represents **one transfer**. Do not mix fragments from different transfers in one session. MUR does not add a per-file UUID to the standard part strings, so two concurrent transfers of the same UR type must be decoded in separate sessions.

## CLI

The CLI is called `murfile`.

### Encode a file

```bash
murfile encode ./song.mp3 \
  --out ./song-qr \
  --frames 150 \
  --max-fragment-length 100 \
  --size 512 \
  --correction medium
```

By default, the output contains both PNG images and plain-text UR fragments:

```text
song-qr/
├── manifest.json
├── frame-001.ur.txt
├── frame-001.png
├── frame-002.ur.txt
├── frame-002.png
└── ...
```

`--frames` is required for multipart files because MUR is rateless: the encoder can produce an unlimited sequence, while a printed object has a finite number of QR symbols. Small files that fit into one fragment are emitted as a single-part UR and need no `--frames`. For MUR, the requested count must be at least the source-fragment count; choose additional fragments based on expected scan loss and test the printed QR size on the target cameras. `--max-fragment-length` controls the MUR fragment payload, not the physical QR dimensions.

Available options:

- `--out <directory>`: output directory.
- `--frames <count>`: number of fountain fragments to emit.
- `--max-fragment-length <bytes>`: fragment payload size; default 100.
- `--size <pixels>`: QR PNG side length; default 512.
- `--correction low|medium|quartile|high`: QR error correction; default `medium`.
- `--fountain-scope global|page|both`: use one global Fountain session (`global`, default), independent MDS-coded sessions per grid page (`page`), or export both variants (`both`; the latter two require `--grid`).
- `--force`: permit writing into a non-empty output directory.

`--grid` controls the visual arrangement of QR codes independently of the Fountain scope. With `global`, frames on different grid pages belong to the same standard MUR session. With `page`, each grid page is independently decodable and every QR is a mixed MDS code symbol; any `repairFramesPerPage` cells may be missing in any positions. `--frames` is not supported because the grid capacity determines the number of frames per page. Page-scoped output uses the `ur:murpage` type and requires Murfile's decoder; global output remains interoperable standard MUR.

With `--fountain-scope both`, murfile creates two separate output directories, `global/` and `page/`, each with its own manifest and UR fragments. Decode them separately:

```bash
murfile decode ./song-both/global --out ./recovered-global.mp3
murfile decode ./song-both/page --out ./recovered-page.mp3
```

Examples:

```bash
# One global Fountain session, visually arranged as 3x3 pages
murfile encode ./song.mp3 --out ./song-global --grid 3x3 --fountain-scope global

# Independent MDS-coded session for every 3x3 page
murfile encode ./song.mp3 --out ./song-pages --grid 3x3 --fountain-scope page

# Export both encodings in separate subdirectories
murfile encode ./song.mp3 --out ./song-both --grid 3x3 --fountain-scope both
```

### Decode UR text files

```bash
murfile decode ./song-qr --out ./recovered.mp3
```

The CLI reads `.ur`, `.txt` and `.ur.txt` files. It also accepts UR strings from standard input:

```bash
cat fragments.txt | murfile decode - --out ./recovered.bin
```

The encoder writes text sidecars by default, so its output directory can be decoded directly with the CLI. The CLI does **not** decode PNG/JPEG files; use the browser live reader to scan QR images or printed pages. A future CLI image-input adapter can be added without changing the core decoder.

### Inspect a collection

```bash
murfile inspect ./song-qr
murfile inspect ./song-qr --json
```

`inspect` reports the number of UR strings, fountain progress, accepted fragments, duplicates, redundant fragments and invalid URs.

### Page-scoped erasure recovery

Page-scoped exports MDS-encode every QR as a mixture of the page's source blocks. The selected redundancy is a guaranteed erasure count, independent of which cells are lost. For example, `--page-redundancy low` on a 4x4 grid reserves four cells' worth of recovery capacity, so any four QR cells may be missing:

```bash
murfile encode ./recording.mp3 --out ./pages \
  --grid 4x4 --fountain-scope page --page-redundancy low
```

For a 4x4 grid this encodes 12 source blocks into 16 mixed QR symbols. Page-scoped QR strings use the `ur:murpage` type and require Murfile's decoder; global Fountain exports retain standard MUR and its existing frame-count behavior.

## Soundbook

Soundbook preserves an existing Ogg Opus file byte-for-byte, divides its original bytes into contiguous page chunks, and encodes each chunk as its own page-scoped MDS session. The reader plays only the contiguous prefix of complete Ogg pages, pauses at a missing page, and resumes when the gap is recovered. The optional original-file download becomes available after every chunk and the whole-file SHA-256 are verified.

```bash
npm run cli:soundbook -- encode ./recording.opus --out ./recording-book
npm run dev:soundbook
npm run build:soundbook
```

The input must be an Ogg Opus file. `ffprobe` is used only to read codec and duration metadata; Soundbook does not invoke an encoder or alter the audio bytes. Defaults are a 4x4 grid, QR version 20, QR error correction L, and minimal page redundancy (1 erasure-recovery symbol per 16-cell page). Every QR is a mixed symbol, so any one missing cell can be recovered regardless of its position. Use `--fountain-redundancy low` or `default` to guarantee recovery from more missing cells, reducing the source bytes available per page. The reader is served from its own Vite root and can be deployed separately from Murfile.

Minimal redundancy allocates 15 source blocks and one recovery equation per 4x4 grid; every one of the 16 QR symbols mixes those blocks, so any single QR may be absent. Higher redundancy guarantees recovery from multiple missing cells. The exact source-byte payload depends on the QR profile; UR/Bytewords and MDS framing reduce usable capacity. `--qr-version 28` provides additional capacity, but version 20 remains the default. Printed-module size and camera performance still require physical-device validation.

Each reconstructed page is verified against its chunk SHA-256 before use. For incremental playback, the reader combines only consecutive chunks starting at page 1 and exposes complete Ogg pages to the player. A later page cannot bypass a gap. The downloaded `.opus` file is the original byte stream, verified against the whole-file SHA-256.

## Live web reader

Start the local development server:

```bash
npm run dev
```

Open the URL printed by Vite, normally `http://localhost:5173`. On a phone, use an HTTPS tunnel or USB port forwarding; see below.

Features:

- live camera video feed and camera selection;
- back-camera preference;
- QR scanning in a Web Worker;
- ZBar multi-symbol detection, so more than one QR can be extracted from a video frame;
- MUR decoding through the same `FileDecoder` used by the CLI;
- fountain progress, duplicate and invalid-fragment counters;
- local reconstruction, SHA-256 display and download.

No frame, fragment or reconstructed file is uploaded to a server by this application. Vite is only the development/static asset server.

### Test on a phone without setting up a certificate

`getUserMedia()` is restricted to secure contexts. Plain HTTP from a LAN IP (`http://192.168.x.x:5173`) is normally not sufficient. You cannot disable this browser security rule from JavaScript.

**Android: USB port forwarding (no HTTPS certificate required)**

1. Enable Developer options and USB debugging on the Pixel.
2. Connect it to the computer and allow the debugging prompt.
3. In desktop Chrome, open `chrome://inspect/#devices` and select **Port forwarding**.
4. Add a rule mapping device port `5173` to local address `localhost:5173`.
5. Start the Vite server with `npm run dev`.
6. On the phone, open `http://localhost:5173` in Chrome.

The phone's browser accesses the forwarded service through its own `localhost` secure-context exception.

**iPhone or wireless testing: HTTPS tunnel**

Run a tunnel to the Vite server, for example with Cloudflare Tunnel or ngrok, and open the generated HTTPS URL in Safari. The tunnel exposes the development server, so only use it temporarily and do not put private files or unrelated services behind it.

## Tests

```bash
npm test
```

The Node test suite covers:

- `ur:bytes` CBOR byte-string construction and single-part decoding;
- MUR fragment generation through the official encoder;
- multipart roundtrip and out-of-order fragment reception;
- duplicate and malformed input handling;
- rejection of other UR types;
- CLI encode/decode roundtrip using text sidecars;
- shared QR/grid API behavior and fixed-version rendering;
- Soundbook envelope validation, byte-exact page reconstruction, incremental Ogg-prefix readiness, integrity checks, and original-file roundtrip;
- a 2.1 MB roundtrip matching the intended file-size range.

These tests run against the installed Blockchain Commons TypeScript package. They do not replace differential interoperability tests against the Rust/Swift/C++ reference implementations, printed-page tests, or physical-device camera validation.

## Build the web app

```bash
npm run build
npm run build:soundbook
npm run build:site
npm run preview
```

`npm run build:site` creates one GitHub Pages-ready `dist/` directory: the landing page is at its root, Murfile at `dist/murfile/`, and Soundbook at `dist/soundbook/`. On the `julianjandeleit.github.io/murfile` project site these are served at `/murfile/`, `/murfile/murfile/`, and `/murfile/soundbook/`, respectively. The reader headers link between the two decoder paths.

Individual app builds write to their respective subdirectories in `dist/`.

## Architecture

```text
                          ┌─────────────────────────────┐
                          │ @blockchaincommons/dcbor    │
                          │ deterministic CBOR bytes   │
                          └──────────────┬──────────────┘
                                         │
┌───────────────┐       ┌────────────────▼────────────────┐
│ CLI           │──────▶│ murfile core                    │
│ file I/O      │       │ FileEncoder / FileDecoder       │
└───────────────┘       └────────────────┬────────────────┘
                                         │
                          ┌──────────────▼───────────────┐
                          │ bc-ur-ts                     │
                          │ UR + MUR fountain encoder    │
                          │ and decoder                  │
                          └──────────────────────────────┘

┌───────────────┐       ┌───────────────────────────────┐
│ Browser       │──────▶│ ZBar WASM in Web Worker       │
│ getUserMedia  │       │ multi-QR recognition          │
└───────────────┘       └──────────────┬────────────────┘
                                       │ UR strings
                            ┌──────────▼──────────┐
                            │ same murfile core   │
                            └─────────────────────┘

CLI / browser QR output ──▶ bc-mur-ts renderUrQr()
```

## Protocol and dependencies

- UR: [BCR-2020-005](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2020-005-ur.md)
- Multipart UR: [BCR-2024-001](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2024-001-multipart-ur.md)
- `bc-ur-ts`: [source repository](https://github.com/BlockchainCommons/bc-ur-ts)
- `bc-mur-ts`: [source repository](https://github.com/BlockchainCommons/bc-mur-ts)
- `bc-dcbor-ts`: [source repository](https://github.com/BlockchainCommons/bc-dcbor-ts)
- `@undecaf/zbar-wasm`: [source repository](https://github.com/undecaf/zbar-wasm)

See each dependency's own license and status. In particular, the ZBar WASM package is LGPL-2.1; check its terms before redistributing the combined application.
# murfile
# murfile
