import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { initSync, Decoder, Encoder, EncodingPacket } from 'raptorq/raptorq.js';

const require = createRequire(import.meta.url);
initSync(readFileSync(require.resolve('raptorq/raptorq_bg.wasm')));

export { Decoder, Encoder, EncodingPacket };
