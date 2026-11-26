#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { FileDecoder, FileEncoder } from '../src/index.js';
import { createPageEnvelope, PAGE_ENVELOPE_HEADER_LENGTH } from '../src/page-transfer.js';
import {
  chooseMaxFragmentLength,
  composeGridPage,
  parseGrid,
  qrModulesForFragment,
  renderQrFragment,
} from '../src/qr-grid.js';

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
  --fountain-scope <scope>         global|page|both (default: global; page and both require --grid)
  --page-redundancy <profile>       default|low (page-scoped Fountain repair frames)
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
    '--out', '-o', '--frames', '--max-fragment-length', '--qr-version', '--grid', '--fountain-scope', '--page-redundancy', '--grid-gap', '--grid-padding', '--size', '--correction', '--format',
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

function pageRepairFrameCount(framesPerPage, profile) {
  if (profile === 'low') return Math.max(1, Math.ceil(framesPerPage / 4));
  return Math.max(1, Math.round(framesPerPage / 3));
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
  const fountainScope = options.fountain_scope ?? 'global';
  const pageRedundancy = options.page_redundancy ?? 'default';
  if (!['global', 'page', 'both'].includes(fountainScope)) {
    throw new Error('--fountain-scope must be global, page or both.');
  }
  if (!['default', 'low'].includes(pageRedundancy)) {
    throw new Error('--page-redundancy must be default or low.');
  }
  if (options.page_redundancy !== undefined && fountainScope === 'global') {
    throw new Error('--page-redundancy requires --fountain-scope page or both.');
  }
  if ((fountainScope === 'page' || fountainScope === 'both') && grid === undefined) {
    throw new Error(`--fountain-scope ${fountainScope} requires --grid.`);
  }
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
  if ((fountainScope === 'page' || fountainScope === 'both') && requestedFrameCount !== undefined) {
    throw new Error(`--frames cannot be used with --fountain-scope ${fountainScope}; page sessions use the grid capacity as their frame count.`);
  }

  const input = await readFile(inputPath);
  const inputBytes = new Uint8Array(input);
  const maxFragmentLength = requestedMaxFragmentLength
    ?? chooseMaxFragmentLength(
      inputBytes,
      correction,
      requestedQrVersion,
      requestedFrameCount ?? (grid && fountainScope !== 'global' ? grid.columns * grid.rows : undefined),
      grid && fountainScope !== 'global'
        ? grid.columns * grid.rows - pageRepairFrameCount(grid.columns * grid.rows, pageRedundancy)
        : undefined,
    );
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
  if (fountainScope === 'both') {
    const framesPerPage = grid.columns * grid.rows;
    if (framesPerPage < 3) {
      throw new Error('--grid needs at least 3 cells so each page can contain data and repair fragments.');
    }
    const repairFramesPerPage = pageRepairFrameCount(framesPerPage, pageRedundancy);
    if (framesPerPage - repairFramesPerPage < 2) {
      throw new Error('--grid must leave at least two data frames per page.');
    }

    const globalDirectory = join(outputDirectory, 'global');
    const pageDirectory = join(outputDirectory, 'page');

    await encodeCommand(inputPath, {
      ...options,
      out: globalDirectory,
      fountain_scope: 'global',
      page_redundancy: undefined,
    });
    await encodeCommand(inputPath, {
      ...options,
      out: pageDirectory,
      fountain_scope: 'page',
      page_redundancy: pageRedundancy,
    });

    const globalManifest = JSON.parse(await readFile(join(globalDirectory, 'manifest.json'), 'utf8'));
    const pageManifest = JSON.parse(await readFile(join(pageDirectory, 'manifest.json'), 'utf8'));
    const manifest = {
      format: 'MUR-BOTH',
      fountainScope: 'both',
      urType: 'bytes',
      originalFilename: basename(inputPath),
      originalSize: input.byteLength,
      sha256: sha256(inputBytes),
      grid: {
        columns: grid.columns,
        rows: grid.rows,
      },
      transfers: {
        global: {
          directory: 'global',
          format: globalManifest.format,
          frameCount: globalManifest.frameCount,
          sourcePartCount: globalManifest.sourcePartCount,
          pageCount: globalManifest.grid?.pageCount ?? null,
        },
        page: {
          directory: 'page',
          format: pageManifest.format,
          frameCount: pageManifest.frameCount,
          sourcePartCount: pageManifest.sourcePartCount,
          pageCount: pageManifest.grid.pageCount,
          dataFramesPerPage: pageManifest.grid.dataFramesPerPage,
          repairFramesPerPage: pageManifest.grid.repairFramesPerPage,
        },
      },
      generatedBy: `murfile/${VERSION}`,
      protocol: 'Blockchain Commons BCR-2020-005 + BCR-2024-001',
    };
    await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    console.log(`Encoded both Fountain scopes: ${inputPath}`);
    console.log(`Global transfer: ${globalManifest.frameCount} frames in ${globalManifest.grid.pageCount} visual pages`);
    console.log(`Page transfer:  ${pageManifest.frameCount} frames in ${pageManifest.grid.pageCount} independent sessions`);
    console.log(`Output:         ${outputDirectory}`);
    return;
  }

  // Page scope creates one independent Fountain session per printed page.
  if (grid && fountainScope === 'page') {
    const framesPerPage = grid.columns * grid.rows;
    if (framesPerPage < 3) {
      throw new Error('--grid needs at least 3 cells so each page can contain data and repair fragments.');
    }
    const repairFramesPerPage = pageRepairFrameCount(framesPerPage, pageRedundancy);
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

        const image = renderQrFragment(fragment, {
          size,
          correction,
          version: requestedQrVersion,
        });
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
      fountainScope,
      urType: 'bytes',
      originalFilename: basename(inputPath),
      originalSize: input.byteLength,
      sha256: fileHash,
      frameCount: totalFrameCount,
      sourcePartCount: totalSourcePartCount,
      sourcePartCountPerPage: dataFramesPerPage,
      repairFramesPerPage,
      pageRedundancy,
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
        pageRedundancy,
        ordering: 'row-major',
        fountainScope,
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

  const renderFragment = (fragment) => renderQrFragment(fragment, {
    size,
    correction,
    version: requestedQrVersion,
  });

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
    fountainScope,
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
      fountainScope,
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
  console.log(`Fountain scope: ${fountainScope}`);
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
