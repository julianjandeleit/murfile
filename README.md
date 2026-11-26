# murfile

A file-oriented encoder/decoder, CLI and browser live reader for Blockchain Commons Uniform Resources and Multipart UR (MUR).

The project deliberately reuses the published Blockchain Commons TypeScript implementations:

- [`@blockchaincommons/uniform-resources`](https://github.com/BlockchainCommons/bc-ur-ts) for UR parsing, CBOR payloads, Bytewords, fountain encoding and fountain decoding.
- [`@blockchaincommons/dcbor`](https://github.com/BlockchainCommons/bc-dcbor-ts) for deterministic CBOR byte strings.
- [`@blockchaincommons/multipart-ur`](https://github.com/BlockchainCommons/bc-mur-ts) for standards-compatible QR rendering.
- [`@undecaf/zbar-wasm`](https://github.com/undecaf/zbar-wasm) for local multi-symbol QR recognition in the browser.

No UR, Bytewords, fountain-code or QR encoder is reimplemented here. `murfile` adds file-oriented APIs, command-line workflows, tests and a camera UI.

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

`FileEncoder` creates `ur:bytes` with a CBOR byte-string payload. If the complete CBOR payload fits in one configured fragment, it emits one ordinary UR; otherwise it delegates MUR fragmentation to Blockchain Commons' `MultipartEncoder`. The MUR stream is infinite by design; callers choose how many parts to export.

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
- `--fountain-scope global|page|both`: use one global Fountain session (`global`, default), independent sessions per grid page (`page`), or export both variants (`both`; the latter two require `--grid`).
- `--force`: permit writing into a non-empty output directory.

`--grid` controls the visual arrangement of QR codes independently of the Fountain scope. With `global`, frames on different grid pages belong to the same MUR session. With `page`, each grid page is independently decodable and includes its own repair frames; `--frames` is not supported because the grid capacity determines the number of frames per page.

With `--fountain-scope both`, murfile creates two separate output directories, `global/` and `page/`, each with its own manifest and UR fragments. Decode them separately:

```bash
murfile decode ./song-both/global --out ./recovered-global.mp3
murfile decode ./song-both/page --out ./recovered-page.mp3
```

Examples:

```bash
# One global Fountain session, visually arranged as 3x3 pages
murfile encode ./song.mp3 --out ./song-global --grid 3x3 --fountain-scope global

# Independent Fountain session for every 3x3 page
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

### Page-scoped Fountain redundancy

Murfile preserves its existing page-repair ratio by default. For page-scoped exports, `--page-redundancy low` instead reserves one quarter of each grid's cells for Fountain repair fragments:

```bash
murfile encode ./recording.mp3 --out ./pages \
  --grid 4x4 --fountain-scope page --page-redundancy low
```

For a 4x4 grid this is 12 source and 4 repair frames per page. The option applies only to page-scoped (or `both`) output; global Fountain exports retain their existing frame-count behavior.

## Soundbook

The separate Soundbook CLI transcodes one complete recording to Ogg Opus and divides the compressed bytes into independent page-scoped Fountain sessions. Audio segmentation is not enabled yet, so playback and download become available only after every page is reconstructed and the whole-book SHA-256 validates.

```bash
npm run cli:soundbook -- encode ./recording.wav --out ./recording-book
npm run dev:soundbook
npm run build:soundbook
```

FFmpeg and ffprobe must be installed and available on `PATH`. Defaults are a 48 kb/s, 48 kHz stereo Ogg Opus transcode, 4x4 grid, QR version 20, QR error correction L, and minimal Fountain redundancy (1 repair cell per 16-cell page). Use `--fountain-redundancy low` for 4 repair cells or `default` for 5. The reader is served from its own Vite root and can be deployed separately from Murfile.

Minimal Fountain redundancy increases the data allocation from 12 to 15 QR cells per grid. The exact compressed-audio payload depends on the chosen redundancy profile; the UR/Bytewords text and Fountain framing reduce usable capacity. `--qr-version 28` provides additional capacity, but version 20 remains the default. Printed-module size and camera performance still require physical-device validation.

The reader reports completed/missing pages and active Fountain sessions, waits rather than skipping a missing page, and enables playback plus an optional `.ogg` download only after the complete file is reconstructed. The whole compressed recording is one stream at this stage; later audio-segment support is required for playback to begin before all pages arrive.

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
- Soundbook envelope validation, interleaved page reconstruction, integrity checks, and FFmpeg CLI roundtrip;
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
