#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createSoundbookPagePlan,
  encodeSoundbookPage,
} from '../src/soundbook-encoder.js';
import { completeOggPrefixLength, isOggOpus } from '../src/ogg-stream.js';

const VERSION = '0.2.0';

function usage() {
  return `soundbook ${VERSION}

Encode an Ogg Opus file byte-for-byte into QR pages.

Usage:
  soundbook encode <audio-file> --out <directory> [options]

Options:
  --out <dir>                        Output directory (required)
  --grid <columns>x<rows>             Grid size (default: 4x4)
  --qr-version <version>              QR version 1-40 (default: 21)
  --correction <level>                low|medium|quartile|high (default: low)
  --size <pixels>                     QR image side length (default: 512)
  --repair-symbols <count>             RaptorQ repair symbols per page (default: 2 on 4x4)
  --grid-gap <pixels>                  Gap between grid cells (default: 24)
  --grid-padding <pixels>              Outer grid margin (default: 48)
  --force                             Allow writing into a non-empty directory

The input must be an Ogg Opus file. Its audio bytes are never transcoded or modified.
`;
}

function parseArgs(argv) {
  const [command, ...args] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help' };
  }
  const positionals = [];
  const options = {};
  const valued = new Set([
    '--out', '--grid', '--qr-version', '--correction', '--size',
    '--repair-symbols', '--grid-gap', '--grid-padding',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { command: 'help' };
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (!valued.has(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[arg.slice(2).replaceAll('-', '_')] = value;
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
  const match = /^(\d+)x(\d+)$/i.exec(value);
  if (!match) throw new Error('--grid must have the form NxM, e.g. 4x4.');
  return {
    columns: positiveInteger(match[1], '--grid columns'),
    rows: positiveInteger(match[2], '--grid rows'),
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) {
    throw new Error(`Could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
  }
  return result.stdout.trim();
}

function probeOggOpus(inputPath) {
  const probe = JSON.parse(run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=format_name,duration:stream=codec_name',
    '-of', 'json',
    inputPath,
  ]));
  const formatNames = String(probe.format?.format_name ?? '').split(',');
  if (!formatNames.includes('ogg') ||
      !probe.streams?.some((stream) => stream.codec_name === 'opus')) {
    throw new Error('Soundbook requires an Ogg Opus input file; input bytes are preserved without transcoding.');
  }
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('ffprobe did not report a valid duration for the input audio.');
  }
  return Math.round(duration * 1_000_000);
}

async function encode(inputPath, options) {
  if (!options.out) throw new Error('encode requires --out <directory>.');
  const grid = options.grid === undefined ? { columns: 4, rows: 4 } : parseGrid(options.grid);
  const qrVersion = positiveInteger(options.qr_version ?? '21', '--qr-version');
  if (qrVersion > 40) throw new Error('--qr-version must be between 1 and 40.');
  const size = positiveInteger(options.size ?? '512', '--size');
  const correction = options.correction ?? 'low';
  if (!['low', 'medium', 'quartile', 'high'].includes(correction)) {
    throw new Error('--correction must be low, medium, quartile or high.');
  }
  const repairSymbols = options.repair_symbols === undefined
    ? undefined
    : positiveInteger(options.repair_symbols, '--repair-symbols');
  const gap = nonNegativeInteger(options.grid_gap ?? '24', '--grid-gap');
  const padding = nonNegativeInteger(options.grid_padding ?? '48', '--grid-padding');
  const inputPathResolved = resolve(inputPath);
  const outputDirectory = resolve(options.out);
  await mkdir(outputDirectory, { recursive: true });
  const existing = await readdir(outputDirectory);
  if (existing.length > 0 && !options.force) {
    throw new Error(`Output directory is not empty: ${outputDirectory} (use --force to overwrite files).`);
  }

  const durationMicros = probeOggOpus(inputPathResolved);
  const audio = new Uint8Array(await readFile(inputPathResolved));
  if (!isOggOpus(audio) || completeOggPrefixLength(audio) !== audio.byteLength) {
    throw new Error('Input is not a complete Ogg Opus byte stream.');
  }
  const bookId = randomBytes(16).toString('hex');
  const planOptions = {
    bookId,
    audioSha256: createHash('sha256').update(audio).digest('hex'),
    durationMicros,
    ...grid,
    size,
    correction,
    qrVersion,
    gap,
    padding,
    repairSymbols,
  };
  const sizingPlan = createSoundbookPagePlan(audio, planOptions);
  const chunkHashes = Array.from({ length: sizingPlan.pageCount }, (_, pageIndex) => {
    const offset = pageIndex * sizingPlan.chunkCapacity;
    return createHash('sha256')
      .update(audio.subarray(offset, Math.min(offset + sizingPlan.chunkCapacity, audio.byteLength)))
      .digest('hex');
  });
  const plan = createSoundbookPagePlan(audio, { ...planOptions, chunkHashes });

  const pageDigits = String(plan.pageCount).length;
  const frameDigits = String(plan.framesPerPage).length;
  for (let pageIndex = 0; pageIndex < plan.pageCount; pageIndex += 1) {
    const page = encodeSoundbookPage(audio, plan, pageIndex);
    const pageStem = `page-${String(page.pageIndex + 1).padStart(pageDigits, '0')}`;
    await writeFile(join(outputDirectory, `${pageStem}.png`), page.png);
    for (let index = 0; index < page.fragments.length; index += 1) {
      const frameStem = `${pageStem}-frame-${String(index + 1).padStart(frameDigits, '0')}`;
      await writeFile(join(outputDirectory, `${frameStem}.mqr.txt`), `${page.fragments[index]}\n`, 'utf8');
    }
  }

  const manifest = {
    ...plan.manifest,
    originalFilename: basename(inputPathResolved),
    audioFormat: 'Original Ogg Opus bytes (unchanged)',
    generatedAt: new Date().toISOString(),
  };
  await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Encoded: ${inputPathResolved}`);
  console.log(`Audio:   ${(durationMicros / 1_000_000).toFixed(2)} s · ${audio.byteLength} original bytes`);
  console.log(`Pages:   ${manifest.pageCount} · ${manifest.grid.sourceSymbols} source + ${manifest.grid.repairSymbols} repair symbols/page`);
  console.log(`Payload: ${manifest.pagePayloadBytes} original audio bytes/page`);
  console.log(`Output:  ${outputDirectory}`);
}

async function main() {
  const { command, positionals = [], options = {} } = parseArgs(process.argv.slice(2));
  if (command === 'help') {
    console.log(usage());
    return;
  }
  if (command !== 'encode') throw new Error(`Unknown command: ${command}`);
  if (positionals.length !== 1) throw new Error('encode requires exactly one audio file.');
  await encode(positionals[0], options);
}

main().catch((error) => {
  console.error(`soundbook: ${error.message}`);
  process.exitCode = 1;
});
