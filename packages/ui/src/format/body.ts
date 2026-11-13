import type { Header } from "@cc-dump/proxy/format";
import { decompress as brotliDecompress } from "brotli/decompress";
import { Gunzip, Unzlib } from "fflate";
import { Decompress as ZstdDecompress } from "fzstd";

// A body as text: what decoded, and why the decoding stopped short, if it did.
export type Body = { text: string; error: string | undefined };

// Decodes a recorded body: its chunks' bytes, joined, with its content codings undone, as UTF-8. `complete`: no more
// bytes follow; a body not complete may still be arriving, and decodes as far as its bytes allow.
// [LAW:no-silent-failure] A chunk that is not base64, a coding not decoded here, bytes that fail to decode, or a body
// not yet decodable give the reason and whatever decoded before it, so the view shows both.
export function decodeBody(headers: Header[], chunks: { base64: string }[], complete: boolean): Body {
  let bytes: Uint8Array = new Uint8Array();
  try {
    bytes = concat(chunks.map(({ base64 }) => Uint8Array.fromBase64(base64)));
    // Codings are listed in the order they were applied, so they are undone from the last.
    for (const coding of contentCodings(headers).reverse()) {
      const decoded: Uint8Array[] = [];
      try {
        (decoders.get(coding) ?? undecodable(coding))(bytes, complete, (chunk) => void decoded.push(chunk));
      } finally {
        bytes = concat(decoded);
      }
    }
    return utf8(bytes, complete);
  } catch (error) {
    return { text: utf8(bytes, complete).text, error: error instanceof Error ? error.message : String(error) };
  }
}

// Undoes one content coding of `input`, passing what it decodes to `emit` as it goes, so a body cut short or still
// arriving decodes as far as its bytes allow; `final`: no more bytes will follow. Throws when the bytes do not decode.
type Decoder = (input: Uint8Array, final: boolean, emit: (chunk: Uint8Array) => void) => void;

const gunzip: Decoder = (input, final, emit) => new Gunzip(emit).push(input, final);

// [LAW:one-type-per-behavior] The content codings Claude Code accepts (gzip, deflate, br, zstd) and their aliases.
// Anthropic answers in more than one: a stream with gzip, an error with br. HTTP's deflate is the zlib format.
const decoders = new Map<string, Decoder>([
  ["gzip", gunzip],
  ["x-gzip", gunzip],
  ["deflate", (input, final, emit) => new Unzlib(emit).push(input, final)],
  ["zstd", (input, final, emit) => new ZstdDecompress(emit).push(input, final)],
  [
    "br",
    (input, final, emit) => {
      if (!final) throw new Error(`${input.length} bytes wait for the body to complete: br is decoded whole`);
      emit(brotliDecompress(input));
    },
  ],
]);

// [LAW:dataflow-not-control-flow] A coding with no decoder decodes nothing, as one whose bytes fail at the first does,
// so its still-encoded bytes are never read as text.
const undecodable =
  (coding: string): Decoder =>
  () => {
    throw new Error(`content-encoding ${coding} is not one this view decodes`);
  };

function contentCodings(headers: Header[]): string[] {
  return headers
    .filter(([name]) => name.toLowerCase() === "content-encoding")
    .flatMap(([, value]) => value.split(","))
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity");
}

// A body not complete may end inside a character: its bytes wait for the rest instead of decoding to U+FFFD.
// [LAW:no-silent-failure] Bytes that are not UTF-8, binary or still encoded, are shown as U+FFFD and said to be.
function utf8(bytes: Uint8Array, final: boolean): Body {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: !final }), error: undefined };
  } catch {
    return { text: new TextDecoder().decode(bytes, { stream: !final }), error: "the body is not UTF-8: what is not is shown as U+FFFD" };
  }
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
