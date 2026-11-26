#!/usr/bin/env node
import { sha256 } from '@noble/hashes/sha2.js';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { FileDecoder, FileEncoder, MQR_PREFIX } from '../src/index.js';
import {
  chooseSymbolSize,
  composeGridPage,
  parseGrid,
  qrModulesForFragment,
  renderQrFragment,
} from '../src/qr-grid.js';

const VERSION = '0.2.0';

function usage() {
  return `murfile ${VERSION}

RaptorQ/Base45 multi-QR file encoder and decoder.

Usage:
  murfile encode <file> --out <directory> [options]
  murfile decode <file|directory|-> --out <file>
  murfile inspect <file|directory|-> [--json]

Encode options:
  --out <dir>                     Output directory (required)
  --grid <columns>x<rows>          QR page layout (default: 4x4)
  --qr-version <version>           QR version 1-40 (default: 21)
  --correction <level>             low|medium|quartile|high (default: low)
  --repair-symbols <count>          RaptorQ repair symbols per page (default: 2 on 4x4)
  --grid-gap <pixels>               Gap between QR codes (default: 24)
  --grid-padding <pixels>           Outer page margin (default: 48)
  --size <pixels>                   QR image side length (default: 512)
  --format <format>                 both|png|mqr (default: both)
  --force                           Allow writing into a non-empty output directory

Decode reads MQR1 text frames; it does not decode image files.
`;
}

function parseArgs(argv) {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help' };
  }
  if (command === '--version' || command === '-v') return { command: 'version' };
  const positionals = [];
  const options = {};
  const valueOptions = new Set([
    '--out', '-o', '--grid', '--qr-version', '--correction', '--repair-symbols',
    '--grid-gap', '--grid-padding', '--size', '--format',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '-' || !argument.startsWith('-')) {
      positionals.push(argument);
      continue;
    }
    if (argument === '--force' || argument === '--json') {
      options[argument.slice(2)] = true;
      continue;
    }
    if (!valueOptions.has(argument)) throw new Error(`Unknown option: ${argument}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    const key = argument === '-o' ? 'out' : argument.slice(2).replaceAll('-', '_');
    options[key] = value;
    index += 1;
  }
  return { command, positionals, options };
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive safe integer.`);
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative safe integer.`);
  return number;
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function encodeCommand(inputPath, options) {
  if (!options.out) throw new Error('encode requires --out <directory>.');
  const input = new Uint8Array(await readFile(inputPath));
  const grid = options.grid === undefined ? { columns: 4, rows: 4 } : parseGrid(options.grid);
  const cellsPerPage = grid.columns * grid.rows;
  if (!Number.isSafeInteger(cellsPerPage) || cellsPerPage > 255) {
    throw new Error('--grid must contain between 1 and 255 cells.');
  }
  const repairSymbols = options.repair_symbols === undefined
    ? Math.max(1, Math.round(cellsPerPage * 2 / 16))
    : positiveInteger(options.repair_symbols, '--repair-symbols');
  if (repairSymbols >= cellsPerPage) {
    throw new Error('--repair-symbols must be less than the number of grid cells.');
  }
  const sourceSymbols = cellsPerPage - repairSymbols;
  const qrVersion = positiveInteger(options.qr_version ?? '21', '--qr-version');
  if (qrVersion > 40) throw new Error('--qr-version must be between 1 and 40.');
  const size = positiveInteger(options.size ?? '512', '--size');
  const correction = options.correction ?? 'low';
  if (!['low', 'medium', 'quartile', 'high'].includes(correction)) {
    throw new Error('--correction must be low, medium, quartile or high.');
  }
  const format = options.format ?? 'both';
  if (!['both', 'png', 'mqr'].includes(format)) throw new Error('--format must be both, png or mqr.');
  const gap = options.grid_gap === undefined ? 24 : nonNegativeInteger(options.grid_gap, '--grid-gap');
  const padding = options.grid_padding === undefined
    ? 48
    : nonNegativeInteger(options.grid_padding, '--grid-padding');
  const symbolSize = chooseSymbolSize(correction, qrVersion);
  const encoder = new FileEncoder(input, { symbolSize, sourceSymbols, repairSymbols });
  const outputDirectory = resolve(options.out);
  await mkdir(outputDirectory, { recursive: true });
  const existing = await readdir(outputDirectory);
  if (existing.length && !options.force) {
    throw new Error(`Output directory is not empty: ${outputDirectory} (use --force to overwrite files).`);
  }

  const frameDigits = String(cellsPerPage).length;
  const pageDigits = String(encoder.pageCount).length;
  let firstModules;
  for (let pageIndex = 0; pageIndex < encoder.pageCount; pageIndex += 1) {
    const frames = encoder.nextPage();
    if (!frames || frames.length !== cellsPerPage) throw new Error(`Page ${pageIndex + 1} has an invalid frame count.`);
    const pageImages = [];
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const frame = frames[frameIndex];
      const modules = qrModulesForFragment(frame, correction, qrVersion);
      if (firstModules === undefined) firstModules = modules;
      const stem = `page-${String(pageIndex + 1).padStart(pageDigits, '0')}-frame-${String(frameIndex + 1).padStart(frameDigits, '0')}`;
      if (format !== 'png') await writeFile(join(outputDirectory, `${stem}.mqr.txt`), `${frame}\n`, 'utf8');
      if (format !== 'mqr') {
        pageImages.push(renderQrFragment(frame, { size, correction, version: qrVersion }));
      }
    }
    if (format !== 'mqr') {
      const page = composeGridPage(pageImages, {
        size,
        columns: grid.columns,
        rows: grid.rows,
        gap,
        padding,
      });
      const pageName = `page-${String(pageIndex + 1).padStart(pageDigits, '0')}.png`;
      await writeFile(join(outputDirectory, pageName), page.toPng());
    }
  }

  const manifest = {
    format: 'MQR1',
    protocol: 'RaptorQ RFC 6330 + Base45 RFC 9285',
    originalFilename: basename(inputPath),
    originalSize: input.byteLength,
    sha256: hex(sha256(input)),
    transferId: encoder.transferId,
    pageCount: encoder.pageCount,
    frameCount: encoder.frameCount,
    sourceSymbolCount: encoder.sourceSymbolCount,
    qr: { size, correction, version: qrVersion, modules: firstModules },
    grid: {
      columns: grid.columns,
      rows: grid.rows,
      gap,
      padding,
      framesPerPage: cellsPerPage,
      sourceSymbols,
      repairSymbols,
      symbolSize,
      ordering: 'row-major',
    },
    generatedBy: `murfile/${VERSION}`,
  };
  await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Encoded: ${inputPath}`);
  console.log(`Bytes:   ${input.byteLength}`);
  console.log(`SHA-256: ${manifest.sha256}`);
  console.log(`Pages:   ${encoder.pageCount} · ${cellsPerPage} frames/page · ${sourceSymbols} source + ${repairSymbols} repair`);
  console.log(`QR:      version ${qrVersion}-${correction} profile (${symbolSize} bytes/symbol)`);
  console.log(`Output:  ${outputDirectory}`);
}

async function collectFiles(path) {
  const absolute = resolve(path);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(absolute, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath));
    else if (entry.isFile() && /\.(?:mqr|txt)$/i.test(entry.name)) files.push(fullPath);
  }
  return files;
}

async function readInputs(inputPath) {
  if (inputPath === '-') {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return [{ source: 'stdin', text }];
  }
  const absolute = resolve(inputPath);
  try {
    const files = await collectFiles(absolute);
    return await Promise.all(files.map(async (file) => ({
      source: file,
      text: await readFile(file, 'utf8'),
    })));
  } catch (error) {
    if (error?.code !== 'ENOTDIR') throw error;
    return [{ source: absolute, text: await readFile(absolute, 'utf8') }];
  }
}

async function collectDecoder(inputPath) {
  const decoder = new FileDecoder();
  let totalCandidates = 0;
  const sources = await readInputs(inputPath);
  for (const source of sources) {
    const frames = source.text.split(/\r?\n/).filter((line) => line.startsWith(MQR_PREFIX));
    totalCandidates += frames.length;
    decoder.addMany(frames);
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
      `Incomplete MQR transfer: ${status.fragmentsReceived} accepted frames, ` +
      `${status.progress.toFixed(3)} progress, ${status.invalidFrames} invalid frames. ` +
      `Missing pages: ${status.missingPages.map((index) => index + 1).join(', ') || 'none known'}. ` +
      `Collected ${totalCandidates} MQR frames.`,
    );
  }
  const bytes = decoder.result;
  await atomicWrite(options.out, bytes);
  console.log(`Decoded: ${options.out}`);
  console.log(`Bytes:   ${bytes.byteLength}`);
  console.log(`SHA-256: ${hex(sha256(bytes))}`);
  console.log(`Frames:  ${totalCandidates} read`);
}

async function inspectCommand(inputPath, options) {
  const { decoder, totalCandidates, sources } = await collectDecoder(inputPath);
  const status = decoder.status;
  const report = {
    input: inputPath,
    sourceFiles: sources.length,
    mqrFramesRead: totalCandidates,
    mode: status.mode,
    complete: status.complete,
    progress: status.progress,
    acceptedFrames: status.fragmentsReceived,
    duplicatesIgnored: status.duplicatesIgnored,
    redundantFrames: status.redundantFragments,
    invalidFrames: status.invalidFrames,
    reconstructedBytes: decoder.result?.byteLength ?? null,
    completedPages: status.completedPages,
    pageCount: status.pageCount,
    missingPages: status.missingPages,
    activeBlocks: status.activeSessions,
    expectedSha256: status.expectedSha256,
  };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Input:              ${report.input}`);
  console.log(`MQR frames:         ${report.mqrFramesRead}`);
  console.log(`Complete:           ${report.complete ? 'yes' : 'no'}`);
  console.log(`Progress:           ${(report.progress * 100).toFixed(1)} %`);
  console.log(`Accepted frames:    ${report.acceptedFrames}`);
  console.log(`Duplicates:         ${report.duplicatesIgnored}`);
  console.log(`Redundant frames:   ${report.redundantFrames}`);
  console.log(`Invalid frames:     ${report.invalidFrames}`);
  console.log(`Pages:              ${report.completedPages}/${report.pageCount ?? '?'}`);
  if (report.missingPages.length) console.log(`Missing pages:      ${report.missingPages.map((index) => index + 1).join(', ')}`);
}

async function main() {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.command === 'help') {
      console.log(usage());
      return;
    }
    if (parsed.command === 'version') {
      console.log(VERSION);
      return;
    }
    const inputPath = parsed.positionals?.[0];
    if (!inputPath && parsed.command !== 'help') throw new Error(`${parsed.command} requires an input path.`);
    if (parsed.command === 'encode') await encodeCommand(inputPath, parsed.options);
    else if (parsed.command === 'decode') await decodeCommand(inputPath, parsed.options);
    else if (parsed.command === 'inspect') await inspectCommand(inputPath, parsed.options);
    else throw new Error(`Unknown command: ${parsed.command}`);
  } catch (error) {
    console.error(`murfile: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

await main();
