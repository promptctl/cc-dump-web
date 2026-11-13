import type { Header } from "@cc-dump/proxy/format";
import { decompress as brotliDecompress } from "brotli/decompress";
import { Gunzip, Unzlib } from "fflate";
import { Decompress as ZstdDecompress } from "fzstd";

// A body as text: what decoded, and why the decoding stopped short, if it did.
export type Body = { text: string; error: string | undefined };

// The decoding of one recorded body as its chunks arrive: `decode` takes every chunk recorded so far and whether the
// body is complete (no more bytes follow), and returns the body as far as it decodes. Chunks it has decoded before are
// not decoded again, so a body read while it streams costs the bytes it receives, not its whole length each time.
// [LAW:one-source-of-truth] The chunks are the truth and the decoding is derived from them: a recording only grows, so
// each call's chunks begin with the ones before, and the body equals a decoding of all of them at once.
export type Decoding = { decode: (chunks: readonly { base64: string }[], complete: boolean) => Body };

// Decodes a body with the content codings `headers` name, undone, as UTF-8. [LAW:no-silent-failure] A chunk that is
// not base64, a coding not decoded here, bytes that fail to decode, or a body not yet decodable give the reason and
// whatever decoded before it, so the view shows both; the decoding stops at its first failure.
export function createDecoding(headers: Header[]): Decoding {
  const text = utf8();
  // Codings are listed in the order they were applied, so they are undone from the last: each one's stage feeds the
  // stage of the coding applied before it, and the first applied feeds the text.
  const stages = contentCodings(headers).reduce<Stage>(
    (inner, coding) => {
      const outer = (decoders.get(coding) ?? undecodable(coding))(inner.push);
      return {
        push: outer.push,
        end: () => {
          outer.end();
          inner.end();
        },
        held: () => outer.held() ?? inner.held(),
      };
    },
    { push: text.push, end: () => {}, held: () => undefined },
  );
  let decoded = 0;
  let ended = false;
  let error: string | undefined;
  const failing = (step: () => void) => {
    try {
      step();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  };
  return {
    decode: (chunks, complete) => {
      if (chunks.length < decoded) throw new Error(`a body decoded to chunk ${decoded} was given ${chunks.length} chunks: a recording only grows`);
      for (; decoded < chunks.length && error === undefined; decoded++) failing(() => stages.push(Uint8Array.fromBase64(chunks[decoded]!.base64)));
      if (complete && !ended) {
        ended = true;
        if (error === undefined) failing(stages.end);
        // What waits for more bytes is all there is once the body is complete: a character cut short reads as U+FFFD.
        text.end();
      }
      return { text: text.text(), error: error ?? text.error() ?? stages.held() };
    },
  };
}

// Decodes a whole recorded body at once.
export function decodeBody(headers: Header[], chunks: readonly { base64: string }[], complete: boolean): Body {
  return createDecoding(headers).decode(chunks, complete);
}

// One step of a body's decoding: bytes pushed in, passed on as they decode; `end`: no more bytes follow, and the end's
// checks run (a checksum, a stream cut short), throwing when they fail. `held`: why bytes pushed have not decoded yet,
// when they wait for the end. Throws when the bytes do not decode.
type Stage = { push: (bytes: Uint8Array) => void; end: () => void; held: () => string | undefined };

// Undoes one content coding, passing what it decodes to `next`.
type Decoder = (next: (bytes: Uint8Array) => void) => Stage;

// A streaming decoder fed the bytes and their end apart, so a body cut short passes on what it decodes before the
// end's check throws: fflate's Unzlib holds back the last bytes as the checksum when told they are the last.
const streaming =
  (decoder: (emit: (chunk: Uint8Array) => void) => { push(chunk: Uint8Array, final?: boolean): void }): Decoder =>
  (next) => {
    const decoding = decoder(next);
    return { push: (bytes) => decoding.push(bytes, false), end: () => decoding.push(new Uint8Array(), true), held: () => undefined };
  };
const gunzip = streaming((emit) => new Gunzip(emit));

// [LAW:one-type-per-behavior] The content codings Claude Code accepts (gzip, deflate, br, zstd) and their aliases.
// Anthropic answers in more than one: a stream with gzip, an error with br. HTTP's deflate is the zlib format.
const decoders = new Map<string, Decoder>([
  ["gzip", gunzip],
  ["x-gzip", gunzip],
  ["deflate", streaming((emit) => new Unzlib(emit))],
  ["zstd", streaming((emit) => new ZstdDecompress(emit))],
  [
    "br",
    (next) => {
      const bytes: Uint8Array[] = [];
      return {
        push: (chunk) => void bytes.push(chunk),
        end: () => next(brotliDecompress(concat(bytes.splice(0)))),
        held: () => (bytes.length === 0 ? undefined : `${concat(bytes).length} bytes wait for the body to complete: br is decoded whole`),
      };
    },
  ],
]);

// [LAW:dataflow-not-control-flow] A coding with no decoder decodes nothing, as one whose bytes fail at the first does,
// so its still-encoded bytes are never read as text.
const undecodable =
  (coding: string): Decoder =>
  () => {
    const fail = () => {
      throw new Error(`content-encoding ${coding} is not one this view decodes`);
    };
    return { push: fail, end: fail, held: () => undefined };
  };

// The values of the header `name`, given in lower case, in the order received: field names are case-insensitive.
export function headerValues(headers: Header[], name: string): string[] {
  return headers.filter(([field]) => field.toLowerCase() === name).map(([, value]) => value);
}

function contentCodings(headers: Header[]): string[] {
  return headerValues(headers, "content-encoding")
    .flatMap((value) => value.split(","))
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity");
}

// The last stage: bytes read as UTF-8, a character cut short at the end of what has arrived waiting for the rest.
// [LAW:no-silent-failure] Bytes that are not UTF-8, binary or still encoded, are shown as U+FFFD and said to be: a
// lenient decoder gives the text, and a strict one beside it finds whether any of it was not UTF-8.
function utf8() {
  const lenient = new TextDecoder();
  const strict = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let valid = true;
  const read = (bytes: Uint8Array | undefined, stream: boolean) => {
    text += lenient.decode(bytes, { stream });
    try {
      if (valid) strict.decode(bytes, { stream });
    } catch {
      valid = false;
    }
  };
  return {
    push: (bytes: Uint8Array) => read(bytes, true),
    end: () => read(undefined, false),
    text: () => text,
    error: () => (valid ? undefined : "the body is not UTF-8: what is not is shown as U+FFFD"),
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
