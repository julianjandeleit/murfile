import init, { Decoder, Encoder, EncodingPacket } from 'raptorq/raptorq.js';
import wasmUrl from 'raptorq/raptorq_bg.wasm?url';

await init(wasmUrl);

export { Decoder, Encoder, EncodingPacket };
