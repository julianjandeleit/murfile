# Murfile

Murfile is a local-first multi-QR file transfer format and decoder. Each grid page is an independent RaptorQ block carried in Base45-encoded `MQR1` QR symbols. Soundbook uses the same transport for byte-exact Ogg Opus pages and incremental playback.

The protocol is a Murfile format, not a Blockchain Commons UR/MUR implementation. Recovery is probabilistic as defined by RaptorQ; the default grid profile is not an MDS guarantee.

## Requirements

- Node.js 22.12 or newer.
- For camera access: a browser with `getUserMedia`, WebAssembly and module workers; HTTPS or localhost is required.
- Soundbook CLI encoding additionally requires `ffmpeg` and `ffprobe` to validate Ogg Opus input and read duration. Audio is never transcoded.

## Install

```bash
npm install
```

## MQR1 protocol

Each QR contains `MQR1:` followed by Base45-encoded binary data: a repeated 76-byte transfer/page header, one RaptorQ encoding packet and a CRC32. The header carries the transfer ID, original length and SHA-256, page index/count, chunk sizing and repair-symbol count. A SHA-256 check validates the exact reconstructed file.

Every page is a separate RaptorQ block. In the default 4×4 profile, 14 cells carry source symbols and 2 carry repair symbols. Repair symbols are evenly spaced through row-major grid positions, not grouped at the beginning or end. RaptorQ can reconstruct from some missing symbols in any positions, but the result is probabilistic and must not be described as guaranteed recovery from exactly two lost cells.

Defaults for both Murfile and Soundbook are QR version 21, error correction L and a 4×4 grid. QR version, correction level, grid dimensions, image size, spacing and padding can be configured.

## Library API

```js
import { FileEncoder, FileDecoder } from 'murfile';

const original = new Uint8Array([0, 1, 2, 3, 254, 255]);
const encoder = new FileEncoder(original, {
  symbolSize: 512,
  sourceSymbols: 14,
  repairSymbols: 2,
});
const frames = encoder.take(16);

const decoder = new FileDecoder();
for (const frame of frames) {
  const result = decoder.add(frame);
  if (result.kind === 'complete') break;
}

if (decoder.complete) {
  const recovered = decoder.result;
}
```

`FileEncoder` accepts `Uint8Array` or `Buffer` input. `FileDecoder` exposes page-level completion, missing-page state, progress, duplicate/invalid counters and the final verified bytes. A decoder instance represents one transfer.

## CLI

### Encode and decode a file

```bash
npm run cli -- encode ./input.bin --out ./transfer
npm run cli -- decode ./transfer --out ./recovered.bin
```

The default export contains a manifest, one `.mqr.txt` file per QR and a PNG for each grid page. Use `--format mqr` for text frames only or `--format png` for images only. The decoder reads MQR1 text frames from a file, directory or standard input; image decoding is provided by the browser reader.

Options:

- `--grid <columns>x<rows>`: default `4x4`.
- `--qr-version <1-40>`: default `21`.
- `--correction low|medium|quartile|high`: default `low`.
- `--repair-symbols <count>`: repair symbols per page; default is about 12.5% of grid cells (2 on 4×4).
- `--size <pixels>`: QR output size; default `512`.
- `--grid-gap <pixels>` and `--grid-padding <pixels>`: grid spacing and page margin.
- `--format both|png|mqr`: output selection; default `both`.
- `--force`: allow writing into a non-empty output directory.

Example:

```bash
npm run cli:soundbook -- encode ~/Downloads/song_8k.opus \
  --out ./aufnahme-book --qr-version 21 --grid 4x4 --force
```

Soundbook validates complete Ogg Opus input, preserves every original byte, and generates page-sized RaptorQ blocks with per-page and whole-file integrity checks. The default profile plans about 23 pages for a 250 KB input. The browser reports page scanning progress, waits at missing pages during playback, and enables a complete-file download after verification.

## Browser decoder

```bash
npm run dev
npm run dev:soundbook
```

Murfile is served at `/murfile/` and Soundbook at `/soundbook/` in their respective development servers. `npm run build:site` creates a GitHub Pages-ready `dist/` with a landing page plus `dist/murfile/` and `dist/soundbook/`.

The camera scanner uses `@undecaf/zbar-wasm` in a Web Worker and accepts multiple QR detections per frame. It requests a high-resolution stream, tries the largest resolution reported by camera capabilities, and passes live frames to the scanner without downscaling. The actual and reported maximum resolution are displayed; final resolution is still subject to the browser and camera.

## Validation

```bash
npm test
npm run build
npm run build:soundbook
npm run build:site
```

Tests cover MQR1 framing and checksums, RaptorQ reconstruction and page loss, CLI roundtrips, Soundbook byte integrity and QR/grid rendering. Physical print and camera validation is still required for deployment.

## Main dependencies

- [`raptorq`](https://www.npmjs.com/package/raptorq): RaptorQ WASM implementation.
- [`@noble/hashes`](https://www.npmjs.com/package/@noble/hashes): SHA-256.
- [`@undecaf/zbar-wasm`](https://github.com/undecaf/zbar-wasm): local multi-QR recognition.
- [`qrcode`](https://www.npmjs.com/package/qrcode): QR matrix generation.
- `fast-png`: QR grid PNG output.
