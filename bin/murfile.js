#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { renderUrQr } from '@blockchaincommons/multipart-ur';
import { FileDecoder, FileEncoder } from '../src/index.js';

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
  --frames <count>                Number of MUR fragments to emit (required for multipart files)
  --max-fragment-length <bytes>   Maximum MUR fragment payload (default: 100)
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
    '--out', '-o', '--frames', '--max-fragment-length', '--size', '--correction', '--format',
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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function encodeCommand(inputPath, options) {
  if (!options.out) throw new Error('encode requires --out <directory>.');
  const requestedFrameCount = options.frames
    ? positiveInteger(options.frames, '--frames')
    : undefined;
  const maxFragmentLength = positiveInteger(options.max_fragment_length ?? '100', '--max-fragment-length');
  const size = positiveInteger(options.size ?? '512', '--size');
  const correction = options.correction ?? 'medium';
  const format = options.format ?? 'both';
  if (!['low', 'medium', 'quartile', 'high'].includes(correction)) {
    throw new Error('--correction must be low, medium, quartile or high.');
  }
  if (!['both', 'png', 'ur'].includes(format)) {
    throw new Error('--format must be both, png or ur.');
  }

  const input = await readFile(inputPath);
  const outputDirectory = resolve(options.out);
  await mkdir(outputDirectory, { recursive: true });
  const existing = await readdir(outputDirectory);
  if (existing.length > 0 && !options.force) {
    throw new Error(`Output directory is not empty: ${outputDirectory} (use --force to overwrite files).`);
  }

  const encoder = new FileEncoder(new Uint8Array(input), { maxFragmentLength });
  const frameCount = encoder.isSinglePart ? 1 : requestedFrameCount;
  if (!frameCount) {
    throw new Error(`This file needs multipart UR (${encoder.sourcePartCount} source fragments). Specify --frames <count> (at least ${encoder.sourcePartCount}).`);
  }
  if (!encoder.isSinglePart && frameCount < encoder.sourcePartCount) {
    throw new Error(`--frames must be at least ${encoder.sourcePartCount} for this file; increase it for loss tolerance.`);
  }

  const fragments = encoder.take(frameCount);
  if (fragments.length !== frameCount) {
    throw new Error('The encoder ended before the requested frame count.');
  }

  const width = String(frameCount).length;
  for (let index = 0; index < fragments.length; index += 1) {
    const stem = `frame-${String(index + 1).padStart(width, '0')}`;
    const fragment = fragments[index];

    if (format === 'both' || format === 'ur') {
      await writeFile(join(outputDirectory, `${stem}.ur.txt`), `${fragment}\n`, 'utf8');
    }
    if (format === 'both' || format === 'png') {
      const image = renderUrQr(fragment, { size, correction });
      await writeFile(join(outputDirectory, `${stem}.png`), image.toPng());
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
    qr: format === 'ur' ? null : { size, correction },
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
    if (decoder.complete) break;
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
  await atomicWrite(options.out, bytes);
  console.log(`Decoded: ${options.out}`);
  console.log(`Bytes:   ${bytes.byteLength}`);
  console.log(`SHA-256: ${sha256(bytes)}`);
  console.log(`URs:     ${totalCandidates} read`);
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
