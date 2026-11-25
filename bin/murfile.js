#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { RenderedImage, qrModuleCount, renderUrQr } from '@blockchaincommons/multipart-ur';
import { encodeQr as encodeFixedQr } from '../src/vendor/qr-fixed.js';
import { createBytesUr, FileDecoder, FileEncoder } from '../src/index.js';
import { createPageEnvelope, PAGE_ENVELOPE_HEADER_LENGTH } from '../src/page-transfer.js';

const VERSION = '0.1.0';

function usage() {
  return `murfile ${VERSION}

File-oriented encoder and decoder for Blockchain Commons UR/MUR.

Usage:
  murfile encode <file> --out <directory> [--frames <count>] [options]
  murfile decode <file|directory|-> --out <file>
  murfile inspect <file|directory|-> [--json]

Commands:
  encode    Encode a file as ur:bytes MUR fragments and QR PNG images.
  decode    Reconstruct a file from .ur/.txt files or stdin.
  inspect   Validate fragments and show fountain decoder progress.

Encode options:
  --out <dir>                     Output directory (required)
  --frames <count>                Number of MUR fragments (default: source count + 10% redundancy)
  --max-fragment-length <bytes>   Maximum MUR fragment payload (default: largest QR-fitting size)
  --qr-version <version>           Force QR matrix version 1-40 (default: automatic)
  --grid <columns>x<rows>          Arrange QR codes on PNG pages, e.g. 3x3
  --grid-gap <pixels>              Gap between QR codes (default: 24; requires --grid)
  --grid-padding <pixels>          Outer grid margin (default: 48; requires --grid)
  --size <pixels>                 QR image width/height (default: 512)
  --correction <level>            low|medium|quartile|high (default: medium)
  --format <format>               both|png|ur (default: both)
  --force                         Allow writing into a non-empty output directory

Decode options:
  --out <file>                    Reconstructed output path (required)

Inspect options:
  --json                          Emit machine-readable JSON

Examples:
  murfile encode ./song.mp3 --out ./song-qr --frames 150 --max-fragment-length 100
  murfile decode ./song-qr --out ./recovered.mp3
  murfile inspect ./song-qr
  cat fragments.txt | murfile decode - --out ./recovered.bin

The CLI reads UR strings, not QR image files. Use the included browser reader to
scan printed pages or image files with a camera. Encode writes both .ur.txt and
.png by default so that the same export can also be decoded by the CLI.
`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help' };
  }
  if (command === '--version' || command === '-v') return { command: 'version' };

  const positionals = [];
  const options = {};
  const valueOptions = new Set([
    '--out', '-o', '--frames', '--max-fragment-length', '--qr-version', '--grid', '--grid-gap', '--grid-padding', '--size', '--correction', '--format',
  ]);
  const aliases = { '-o': '--out' };

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '-' || !argument.startsWith('-')) {
      positionals.push(argument);
      continue;
    }
    const key = aliases[argument] || argument;
    if (key === '--force' || key === '--json') {
      options[key.slice(2)] = true;
      continue;
    }
    if (!valueOptions.has(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}`);
    }
    options[key.slice(2).replaceAll('-', '_')] = value;
    index += 1;
  }
  return { command, positionals, options };
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return number;
}

function parseGrid(value) {
  const match = /^(\d+)x(\d+)$/i.exec(String(value));
  if (!match) throw new Error('--grid must have the form NxM, e.g. 3x3.');
  const columns = positiveInteger(match[1], '--grid columns');
  const rows = positiveInteger(match[2], '--grid rows');
  if (!Number.isSafeInteger(columns * rows)) {
    throw new Error('--grid dimensions are too large.');
  }
  return { columns, rows };
}

/** Compose QR images into a white, row-major grid page. */
function composeGridPage(images, { size, columns, rows, gap, padding }) {
  const pageWidth = columns * size + (columns - 1) * gap + 2 * padding;
  const pageHeight = rows * size + (rows - 1) * gap + 2 * padding;
  const pixelLength = pageWidth * pageHeight * 4;
  if (!Number.isSafeInteger(pixelLength)) {
    throw new Error('Grid page dimensions are too large.');
  }
  if (images.length > columns * rows) {
    throw new Error('Too many QR images for one grid page.');
  }

  const pixels = new Uint8Array(pixelLength);
  pixels.fill(255);
  const rowBytes = size * 4;

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    if (image.width !== size || image.height !== size) {
      throw new Error('All QR images in a grid must have the configured size.');
    }
    const column = index % columns;
    const row = Math.floor(index / columns);
    const destinationX = padding + column * (size + gap);
    const destinationY = padding + row * (size + gap);

    for (let y = 0; y < size; y += 1) {
      const sourceStart = y * rowBytes;
      const destinationStart = ((destinationY + y) * pageWidth + destinationX) * 4;
      pixels.set(
        image.pixels.subarray(sourceStart, sourceStart + rowBytes),
        destinationStart,
      );
    }
  }

  return new RenderedImage({ width: pageWidth, height: pageHeight, pixels });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function cborByteStringHeaderLength(length) {
  if (length < 24) return 1;
  if (length <= 0xff) return 2;
  if (length <= 0xffff) return 3;
  if (length <= 0xffffffff) return 5;
  return 9;
}

/** Size the padded page payload so its CBOR byte string is exactly K MUR fragments. */
function calculatePageChunkCapacity(maxFragmentLength, dataFramesPerPage) {
  const targetLength = maxFragmentLength * dataFramesPerPage;
  if (!Number.isSafeInteger(targetLength)) throw new Error('Page fragment capacity is too large.');
  let chunkCapacity = targetLength - PAGE_ENVELOPE_HEADER_LENGTH - 9;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const envelopeLength = PAGE_ENVELOPE_HEADER_LENGTH + chunkCapacity;
    const next = targetLength - PAGE_ENVELOPE_HEADER_LENGTH - cborByteStringHeaderLength(envelopeLength);
    if (next === chunkCapacity) break;
    chunkCapacity = next;
  }
  const envelopeLength = PAGE_ENVELOPE_HEADER_LENGTH + chunkCapacity;
  if (chunkCapacity < 1 || envelopeLength + cborByteStringHeaderLength(envelopeLength) !== targetLength) {
    throw new Error('Could not calculate a valid page payload size for this fragment length.');
  }
  return chunkCapacity;
}

const AUTO_FRAME_REDUNDANCY = 0.10;
const QR_EC_LEVELS = { low: 'L', medium: 'M', quartile: 'Q', high: 'H' };

function qrModulesForFragment(fragment, correction, requestedVersion) {
  const bytes = new TextEncoder().encode(fragment.toUpperCase());
  if (requestedVersion !== undefined) {
    return encodeFixedQr(bytes, QR_EC_LEVELS[correction], requestedVersion).width;
  }
  return qrModuleCount(bytes, correction);
}

function renderFixedUrQr(fragment, { size, correction, version }) {
  const bytes = new TextEncoder().encode(fragment.toUpperCase());
  const symbol = encodeFixedQr(bytes, QR_EC_LEVELS[correction], version);
  const quietZone = 1;
  const totalModules = symbol.width + quietZone * 2;
  const pixelsPerModule = Math.max(1, Math.floor(size / totalModules));
  const rasterSize = totalModules * pixelsPerModule;
  const raster = new Uint8Array(rasterSize * rasterSize * 4);
  raster.fill(255);

  for (let row = 0; row < symbol.width; row += 1) {
    for (let column = 0; column < symbol.width; column += 1) {
      if (symbol.modules[row * symbol.width + column] === 0) continue;
      const x0 = (column + quietZone) * pixelsPerModule;
      const y0 = (row + quietZone) * pixelsPerModule;
      for (let y = y0; y < y0 + pixelsPerModule; y += 1) {
        for (let x = x0; x < x0 + pixelsPerModule; x += 1) {
          const offset = (y * rasterSize + x) * 4;
          raster[offset] = 0;
          raster[offset + 1] = 0;
          raster[offset + 2] = 0;
        }
      }
    }
  }

  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.min(Math.floor((y * rasterSize) / size), rasterSize - 1);
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.min(Math.floor((x * rasterSize) / size), rasterSize - 1);
      const sourceOffset = (sourceY * rasterSize + sourceX) * 4;
      const targetOffset = (y * size + x) * 4;
      pixels.set(raster.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }

  return new RenderedImage({ width: size, height: size, pixels });
}

function candidateFragmentsFitQrVersion(data, fragmentLength, correction, requestedVersion, requestedFrameCount) {
  const encoder = new FileEncoder(data, { maxFragmentLength: fragmentLength });
  if (encoder.isSinglePart) {
    try {
      qrModulesForFragment(encoder.nextFragment(), correction, requestedVersion);
      return true;
    } catch {
      return false;
    }
  }

  const frameCount = requestedFrameCount
    ?? Math.ceil(encoder.sourcePartCount * (1 + AUTO_FRAME_REDUNDANCY));
  const testCount = Math.max(frameCount, encoder.sourcePartCount);
  let firstFragment;
  let lastFragment;

  // Use actual MUR output. The first and last frames cover the sequence
  // header's shortest and longest values; fragment payload lengths are fixed.
  for (let index = 0; index < testCount; index += 1) {
    const fragment = encoder.nextFragment();
    if (fragment === undefined) return false;
    if (index === 0) firstFragment = fragment;
    if (index === testCount - 1) lastFragment = fragment;
  }

  try {
    qrModulesForFragment(firstFragment, correction, requestedVersion);
    if (lastFragment !== firstFragment) {
      qrModulesForFragment(lastFragment, correction, requestedVersion);
    }
    return true;
  } catch {
    return false;
  }
}

/** Find the largest fragment payload fitting the automatic or requested QR version. */
function chooseMaxFragmentLength(data, correction, requestedVersion, requestedFrameCount) {
  const bytes = new Uint8Array(data);
  const payloadLength = createBytesUr(bytes).cbor.toData().byteLength;
  let lowerBound = 1;
  let upperBound = payloadLength;
  let best = 0;

  while (lowerBound <= upperBound) {
    const candidate = Math.floor((lowerBound + upperBound) / 2);
    if (candidateFragmentsFitQrVersion(
      bytes,
      candidate,
      correction,
      requestedVersion,
      requestedFrameCount,
    )) {
      best = candidate;
      lowerBound = candidate + 1;
    } else {
      upperBound = candidate - 1;
    }
  }

  if (best === 0) {
    const target = requestedVersion === undefined
      ? 'the maximum supported QR version'
      : `QR version ${requestedVersion}`;
    throw new Error(`No UR fragment fits ${target} with correction level ${correction}.`);
  }

  return best;
}

async function encodeCommand(inputPath, options) {
  if (!options.out) throw new Error('encode requires --out <directory>.');
  const requestedFrameCount = options.frames
    ? positiveInteger(options.frames, '--frames')
    : undefined;
  const requestedMaxFragmentLength = options.max_fragment_length === undefined
    ? undefined
    : positiveInteger(options.max_fragment_length, '--max-fragment-length');
  const requestedQrVersion = options.qr_version === undefined
    ? undefined
    : positiveInteger(options.qr_version, '--qr-version');
  if (requestedQrVersion !== undefined && requestedQrVersion > 40) {
    throw new Error('--qr-version must be between 1 and 40.');
  }
  const grid = options.grid === undefined ? undefined : parseGrid(options.grid);
  const gridGap = options.grid_gap === undefined
    ? 24
    : nonNegativeInteger(options.grid_gap, '--grid-gap');
  if (options.grid_gap !== undefined && grid === undefined) {
    throw new Error('--grid-gap requires --grid.');
  }
  const gridPadding = options.grid_padding === undefined
    ? 48
    : nonNegativeInteger(options.grid_padding, '--grid-padding');
  if (options.grid_padding !== undefined && grid === undefined) {
    throw new Error('--grid-padding requires --grid.');
  }
  const size = positiveInteger(options.size ?? '512', '--size');
  const correction = options.correction ?? 'medium';
  const format = options.format ?? 'both';
  if (!['low', 'medium', 'quartile', 'high'].includes(correction)) {
    throw new Error('--correction must be low, medium, quartile or high.');
  }
  if (!['both', 'png', 'ur'].includes(format)) {
    throw new Error('--format must be both, png or ur.');
  }
  if (grid !== undefined && format === 'ur') {
    throw new Error('--grid requires --format png or both.');
  }
  if (grid !== undefined && requestedFrameCount !== undefined) {
    throw new Error('--frames cannot be used with --grid; page sessions use the grid capacity as their frame count.');
  }

  const input = await readFile(inputPath);
  const inputBytes = new Uint8Array(input);
  const maxFragmentLength = requestedMaxFragmentLength
    ?? chooseMaxFragmentLength(inputBytes, correction, requestedQrVersion, requestedFrameCount);
  const encoder = new FileEncoder(inputBytes, { maxFragmentLength });
  const automaticFrameCount = encoder.isSinglePart
    ? 1
    : Math.ceil(encoder.sourcePartCount * (1 + AUTO_FRAME_REDUNDANCY));
  const frameCount = encoder.isSinglePart
    ? 1
    : requestedFrameCount ?? automaticFrameCount;

  const outputDirectory = resolve(options.out);
  await mkdir(outputDirectory, { recursive: true });
  const existing = await readdir(outputDirectory);
  if (existing.length > 0 && !options.force) {
    throw new Error(`Output directory is not empty: ${outputDirectory} (use --force to overwrite files).`);
  }
  // A grid export is one independent Fountain session per printed page.
  if (grid) {
    const framesPerPage = grid.columns * grid.rows;
    if (framesPerPage < 3) {
      throw new Error('--grid needs at least 3 cells so each page can contain data and repair fragments.');
    }
    const repairFramesPerPage = Math.max(1, Math.round(framesPerPage / 3));
    const dataFramesPerPage = framesPerPage - repairFramesPerPage;
    if (dataFramesPerPage < 2) {
      throw new Error('--grid must leave at least two data frames per page.');
    }

    const chunkCapacity = calculatePageChunkCapacity(maxFragmentLength, dataFramesPerPage);
    const pageCount = Math.max(1, Math.ceil(inputBytes.byteLength / chunkCapacity));
    if (pageCount > 0xffffffff) throw new Error('Page count exceeds the page-transfer format limit.');
    const totalFrameCount = pageCount * framesPerPage;
    const totalSourcePartCount = pageCount * dataFramesPerPage;
    const fileHash = sha256(inputBytes);
    const pageDigits = String(pageCount).length;
    const frameDigits = String(framesPerPage).length;
    let firstQrModules = null;

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const chunkStart = pageIndex * chunkCapacity;
      const chunkLength = Math.max(0, Math.min(chunkCapacity, inputBytes.byteLength - chunkStart));
      const chunk = new Uint8Array(chunkCapacity);
      chunk.set(inputBytes.subarray(chunkStart, chunkStart + chunkLength));
      const envelope = createPageEnvelope({
        pageIndex,
        pageCount,
        originalSize: inputBytes.byteLength,
        chunkLength,
        chunk,
        fileSha256: fileHash,
      });
      const pageEncoder = new FileEncoder(envelope, { maxFragmentLength });
      if (pageEncoder.isSinglePart || pageEncoder.sourcePartCount !== dataFramesPerPage) {
        throw new Error(
          `Internal page sizing error: page ${pageIndex + 1} has ${pageEncoder.sourcePartCount} ` +
          `source fragments; expected ${dataFramesPerPage}.`,
        );
      }
      const pageFragments = pageEncoder.take(framesPerPage);
      if (pageFragments.length !== framesPerPage) {
        throw new Error(`Page ${pageIndex + 1} did not produce ${framesPerPage} frames.`);
      }

      const pageImages = [];
      for (let frameIndex = 0; frameIndex < pageFragments.length; frameIndex += 1) {
        const fragment = pageFragments[frameIndex];
        const modules = qrModulesForFragment(fragment, correction, requestedQrVersion);
        if (requestedQrVersion !== undefined && modules !== 17 + 4 * requestedQrVersion) {
          throw new Error(`Page ${pageIndex + 1}, frame ${frameIndex + 1} does not fit QR version ${requestedQrVersion}.`);
        }
        if (firstQrModules === null) firstQrModules = modules;

        const pageStem = `page-${String(pageIndex + 1).padStart(pageDigits, '0')}`;
        const frameStem = `${pageStem}-frame-${String(frameIndex + 1).padStart(frameDigits, '0')}`;
        if (format === 'both') {
          await writeFile(join(outputDirectory, `${frameStem}.ur.txt`), `${fragment}\n`, 'utf8');
        }

        const image = requestedQrVersion === undefined
          ? renderUrQr(fragment, { size, correction })
          : renderFixedUrQr(fragment, { size, correction, version: requestedQrVersion });
        pageImages.push(image);
      }

      const pageImage = composeGridPage(pageImages, {
        size,
        columns: grid.columns,
        rows: grid.rows,
        gap: gridGap,
        padding: gridPadding,
      });
      const pageName = `page-${String(pageIndex + 1).padStart(pageDigits, '0')}.png`;
      await writeFile(join(outputDirectory, pageName), pageImage.toPng());
    }

    const actualQrVersion = (firstQrModules - 17) / 4;
    const manifest = {
      format: 'MUR-PAGES',
      fountainScope: 'page',
      urType: 'bytes',
      originalFilename: basename(inputPath),
      originalSize: input.byteLength,
      sha256: fileHash,
      frameCount: totalFrameCount,
      sourcePartCount: totalSourcePartCount,
      sourcePartCountPerPage: dataFramesPerPage,
      repairFramesPerPage,
      maxFragmentLength,
      qr: { size, correction, version: actualQrVersion, modules: firstQrModules },
      grid: {
        columns: grid.columns,
        rows: grid.rows,
        gap: gridGap,
        padding: gridPadding,
        framesPerPage,
        pageCount,
        dataFramesPerPage,
        repairFramesPerPage,
        ordering: 'row-major',
        fountainScope: 'page',
      },
      generatedBy: `murfile/${VERSION}`,
      protocol: 'Blockchain Commons BCR-2020-005 + BCR-2024-001',
    };
    await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    console.log(`Encoded: ${inputPath}`);
    console.log(`Bytes:   ${input.byteLength}`);
    console.log(`SHA-256: ${manifest.sha256}`);
    console.log(`Pages:   ${pageCount}`);
    console.log(`Frames:  ${totalFrameCount} (${framesPerPage} per page)`);
    console.log(`Output:  ${outputDirectory}`);
    console.log(`Format:  ${format}`);
    console.log(`QR:      version ${actualQrVersion} (${firstQrModules} modules)`);
    console.log(`Grid:    ${grid.columns}x${grid.rows}, ${pageCount} independent Fountain sessions`);
    console.log(`Per page: ${dataFramesPerPage} source + ${repairFramesPerPage} repair frames`);
    return;
  }

  if (!encoder.isSinglePart && frameCount < encoder.sourcePartCount) {
    throw new Error(`--frames must be at least ${encoder.sourcePartCount} for this file; increase it for loss tolerance.`);
  }

  const fragments = encoder.take(frameCount);
  if (fragments.length !== frameCount) {
    throw new Error('The encoder ended before the requested frame count.');
  }

  const firstQrModules = qrModulesForFragment(fragments[0], correction, requestedQrVersion);
  if (requestedQrVersion !== undefined) {
    const expectedModules = 17 + 4 * requestedQrVersion;
    for (let index = 0; index < fragments.length; index += 1) {
      const modules = qrModulesForFragment(fragments[index], correction, requestedQrVersion);
      if (modules !== expectedModules) {
        throw new Error(`Frame ${index + 1} did not use the requested QR version ${requestedQrVersion}.`);
      }
    }
  }

  const actualQrVersion = (firstQrModules - 17) / 4;
  const width = String(frameCount).length;
  const framesPerPage = grid ? grid.columns * grid.rows : 1;
  const pageCount = grid ? Math.ceil(frameCount / framesPerPage) : 0;

  const renderFragment = (fragment) => requestedQrVersion === undefined
    ? renderUrQr(fragment, { size, correction })
    : renderFixedUrQr(fragment, { size, correction, version: requestedQrVersion });

  if (grid) {
    const pageDigits = String(pageCount).length;
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const pageImages = [];
      const start = pageIndex * framesPerPage;
      const end = Math.min(start + framesPerPage, fragments.length);

      for (let index = start; index < end; index += 1) {
        const stem = `frame-${String(index + 1).padStart(width, '0')}`;
        const fragment = fragments[index];

        if (format === 'both') {
          await writeFile(join(outputDirectory, `${stem}.ur.txt`), `${fragment}\n`, 'utf8');
        }
        pageImages.push(renderFragment(fragment));
      }

      const page = composeGridPage(pageImages, {
        size,
        columns: grid.columns,
        rows: grid.rows,
        gap: gridGap,
        padding: gridPadding,
      });
      const pageName = `page-${String(pageIndex + 1).padStart(pageDigits, '0')}.png`;
      await writeFile(join(outputDirectory, pageName), page.toPng());
    }
  } else {
    for (let index = 0; index < fragments.length; index += 1) {
      const stem = `frame-${String(index + 1).padStart(width, '0')}`;
      const fragment = fragments[index];

      if (format === 'both' || format === 'ur') {
        await writeFile(join(outputDirectory, `${stem}.ur.txt`), `${fragment}\n`, 'utf8');
      }
      if (format === 'both' || format === 'png') {
        const image = renderFragment(fragment);
        await writeFile(join(outputDirectory, `${stem}.png`), image.toPng());
      }
    }
  }

  const manifest = {
    format: encoder.isSinglePart ? 'UR' : 'MUR',
    urType: 'bytes',
    originalFilename: basename(inputPath),
    originalSize: input.byteLength,
    sha256: sha256(input),
    frameCount,
    sourcePartCount: encoder.sourcePartCount,
    maxFragmentLength,
    qr: {
      size: format === 'ur' ? null : size,
      correction,
      version: actualQrVersion,
      modules: firstQrModules,
    },
    grid: grid ? {
      columns: grid.columns,
      rows: grid.rows,
      gap: gridGap,
      padding: gridPadding,
      framesPerPage,
      pageCount,
      ordering: 'row-major',
    } : null,
    generatedBy: `murfile/${VERSION}`,
    protocol: 'Blockchain Commons BCR-2020-005 + BCR-2024-001',
  };
  await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`Encoded: ${inputPath}`);
  console.log(`Bytes:   ${input.byteLength}`);
  console.log(`SHA-256: ${manifest.sha256}`);
  console.log(`Frames:  ${frameCount}`);
  console.log(`Output:  ${outputDirectory}`);
  console.log(`Format:  ${format}`);
  console.log(`QR:      version ${actualQrVersion} (${firstQrModules} modules)`);
  if (grid) console.log(`Grid:    ${grid.columns}x${grid.rows}, ${pageCount} pages, ${gridGap}px gap, ${gridPadding}px padding`);
  if (!encoder.isSinglePart) console.log(`Source fragments: ${encoder.sourcePartCount}; exported fragments include fountain redundancy.`);
}

async function collectFiles(path) {
  const absolute = resolve(path);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(absolute, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath));
    else if (entry.isFile() && /\.(?:ur|txt)$/i.test(entry.name)) files.push(fullPath);
  }
  return files;
}

async function readInputTexts(inputPath) {
  if (inputPath === '-') {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return [{ source: 'stdin', text }];
  }

  const absolute = resolve(inputPath);
  try {
    const files = await collectFiles(absolute);
    return await Promise.all(files.map(async (file) => ({ source: file, text: await readFile(file, 'utf8') })));
  } catch (error) {
    if (error?.code !== 'ENOTDIR') throw error;
    return [{ source: absolute, text: await readFile(absolute, 'utf8') }];
  }
}

function extractUrStrings(text) {
  return String(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => /^ur:/i.test(token));
}

async function collectDecoder(inputPath) {
  const decoder = new FileDecoder();
  let totalCandidates = 0;
  const sources = await readInputTexts(inputPath);
  for (const source of sources) {
    const fragments = extractUrStrings(source.text);
    totalCandidates += fragments.length;
    decoder.addMany(fragments);
  }
  return { decoder, totalCandidates, sources };
}

async function atomicWrite(path, bytes) {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  try {
    await rename(temporary, target);
  } catch (error) {
    const { unlink } = await import('node:fs/promises');
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function decodeCommand(inputPath, options) {
  if (!options.out) throw new Error('decode requires --out <file>.');
  const { decoder, totalCandidates } = await collectDecoder(inputPath);
  const status = decoder.status;
  if (!decoder.complete) {
    throw new Error(
      `Incomplete transfer: ${status.fragmentsReceived} accepted fragments, ` +
      `${status.progress.toFixed(3)} fountain progress, ${status.invalidUris} invalid URs. ` +
      `Collected ${totalCandidates} UR strings.`,
    );
  }

  const bytes = decoder.result;
  const actualHash = sha256(bytes);
  if (status.expectedSha256 && actualHash !== status.expectedSha256) {
    throw new Error(`Reconstructed file hash mismatch: expected ${status.expectedSha256}, got ${actualHash}.`);
  }
  await atomicWrite(options.out, bytes);
  console.log(`Decoded: ${options.out}`);
  console.log(`Bytes:   ${bytes.byteLength}`);
  console.log(`SHA-256: ${actualHash}`);
  console.log(`URs:     ${totalCandidates} read`);
  if (status.pageCount !== null) console.log(`Pages:   ${status.completedPages}/${status.pageCount} independently reconstructed`);
}

async function inspectCommand(inputPath, options) {
  const { decoder, totalCandidates, sources } = await collectDecoder(inputPath);
  const status = decoder.status;
  const result = {
    input: inputPath,
    sourceFiles: sources.length,
    urStringsRead: totalCandidates,
    mode: status.mode,
    complete: status.complete,
    fountainProgress: status.progress,
    acceptedFragments: status.fragmentsReceived,
    duplicatesIgnored: status.duplicatesIgnored,
    redundantFragments: status.redundantFragments,
    invalidUris: status.invalidUris,
    reconstructedBytes: decoder.result?.byteLength ?? null,
    completedPages: status.completedPages,
    pageCount: status.pageCount,
    missingPages: status.missingPages,
    activeSessions: status.activeSessions,
    expectedSha256: status.expectedSha256,
  };

  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Input:                 ${result.input}`);
    console.log(`Source files:          ${result.sourceFiles}`);
    console.log(`UR strings:            ${result.urStringsRead}`);
    console.log(`Mode:                  ${result.mode}`);
    console.log(`Complete:              ${result.complete ? 'yes' : 'no'}`);
    console.log(`Fountain progress:     ${(result.fountainProgress * 100).toFixed(1)} %`);
    console.log(`Accepted fragments:    ${result.acceptedFragments}`);
    console.log(`Duplicates ignored:    ${result.duplicatesIgnored}`);
    console.log(`Redundant fragments:   ${result.redundantFragments}`);
    console.log(`Invalid URs:           ${result.invalidUris}`);
    if (result.reconstructedBytes !== null) console.log(`Reconstructed bytes:   ${result.reconstructedBytes}`);
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
    if (parsed.command === 'help') {
      console.log(usage());
      return;
    }
    if (parsed.command === 'version') {
      console.log(VERSION);
      return;
    }
    const input = parsed.positionals?.[0];
    if (parsed.command !== 'encode' && parsed.command !== 'decode' && parsed.command !== 'inspect') {
      throw new Error(`Unknown command: ${parsed.command}`);
    }
    if (!input) throw new Error(`${parsed.command} requires an input path (or - for stdin).`);

    if (parsed.command === 'encode') await encodeCommand(input, parsed.options);
    else if (parsed.command === 'decode') await decodeCommand(input, parsed.options);
    else await inspectCommand(input, parsed.options);
  } catch (error) {
    console.error(`murfile: ${error instanceof Error ? error.message : String(error)}`);
    console.error('Run "murfile --help" for usage.');
    process.exitCode = 1;
  }
}

await main();
