import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const qrDirectory = resolve(projectRoot, 'node_modules/@blockchaincommons/multipart-ur/src/qr');
const outputPath = resolve(projectRoot, 'src/vendor/qr-fixed.generated.js');

function replaceExactlyOnce(source, original, replacement, label) {
  const first = source.indexOf(original);
  if (first < 0 || source.indexOf(original, first + original.length) >= 0) {
    throw new Error(`Cannot uniquely patch ${label}; the dependency source may have changed.`);
  }
  return source.slice(0, first) + replacement + source.slice(first + original.length);
}

const fixedEncoder = `

/** Encode data using exactly the requested QR version, padding remaining capacity. */
export function encodeFixed(data: Uint8Array, level: EcLevel, version: Version): EncodedData {
  if (!Number.isInteger(version) || version < 1 || version > 40) {
    throw new QrFailure("invalid version");
  }
  const segments = parseSegments(data);
  const optimized = optimizeSegments(segments, version);
  const totalLen = totalEncodedLen(optimized, version);
  const capacity = DATA_LENGTHS[version - 1][level];
  if (totalLen > capacity) throw new QrFailure("data too long");
  const bits = new Bits(version);
  bits.pushSegments(data, optimized);
  bits.pushTerminator(level);
  return { version, bytes: Uint8Array.from(bits.data) };
}
`;

await mkdir(dirname(outputPath), { recursive: true });

await build({
  entryPoints: [resolve(qrDirectory, 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  outfile: outputPath,
  plugins: [{
    name: 'murfile-fixed-qr-version',
    setup(builder) {
      builder.onLoad({ filter: /bits\.ts$/ }, async (args) => {
        const source = await readFile(args.path, 'utf8');
        const anchor = '  throw new QrFailure("data too long");\n}';
        const contents = replaceExactlyOnce(source, anchor, anchor + fixedEncoder, 'bits.ts');
        return { contents, loader: 'ts', resolveDir: dirname(args.path) };
      });

      builder.onLoad({ filter: /qr[\\/]index\.ts$/ }, async (args) => {
        let source = await readFile(args.path, 'utf8');
        source = replaceExactlyOnce(
          source,
          'import { encodeAuto } from "./bits.js";',
          'import { encodeAuto, encodeFixed } from "./bits.js";',
          'qr/index.ts import',
        );
        source = replaceExactlyOnce(
          source,
          'export function encodeQr(message: Uint8Array, level: EcLetter): QrSymbol {',
          'export function encodeQr(message: Uint8Array, level: EcLetter, requestedVersion?: number): QrSymbol {',
          'qr/index.ts signature',
        );
        source = replaceExactlyOnce(
          source,
          'const { version, bytes } = encodeAuto(message, ecLevel);',
          'const { version, bytes } = requestedVersion === undefined\n      ? encodeAuto(message, ecLevel)\n      : encodeFixed(message, ecLevel, requestedVersion);',
          'qr/index.ts encoder call',
        );
        return { contents: source, loader: 'ts', resolveDir: dirname(args.path) };
      });
    },
  }],
});

console.log(`Built ${outputPath}`);
