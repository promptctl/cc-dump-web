import type { Header } from "@cc-dump/proxy/format";
import { decompress as brotliDecompress } from "brotli/decompress";
import { Gunzip, Unzlib } from "fflate";
import { Decompress as ZstdDecompress } from "fzstd";

// A body as text: what decoded, and why the decoding stopped short, if it did.
export type Body = { text: string; error: string | undefined };

// Decodes a recorded body: its chunks' bytes, joined, with its content codings undone, as UTF-8. `complete`: its
// trailers are recorded, so no more bytes follow; a body without them may still be arriving, or may have been cut off
// by a crash, and both decode as far as their bytes allow.
// [LAW:no-silent-failure] A coding not decoded here, bytes that fail to decode, or a body not yet decodable give the
// reason and whatever decoded before it, so the view shows both.
export function decodeBody(headers: Header[], chunks: { base64: string }[], complete: boolean): Body {
  let bytes = concat(chunks.map(({ base64 }) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))));
  try {
    // Codings are listed in the order they were applied, so they are undone from the last.
    for (const coding of contentCodings(headers).reverse()) {
      const decode = decoders[coding];
      if (decode === undefined) throw new Error(`content-encoding ${coding} is not one this view decodes`);
      const decoded: Uint8Array[] = [];
      try {
        decode(bytes, complete, (chunk) => void decoded.push(chunk));
      } finally {
        bytes = concat(decoded);
      }
    }
    return { text: utf8(bytes, complete), error: undefined };
  } catch (error) {
    return { text: utf8(bytes, complete), error: error instanceof Error ? error.message : String(error) };
  }
}

// Undoes one content coding of `input`, passing what it decodes to `emit` as it goes, so a body cut short or still
// arriving decodes as far as its bytes allow; `final`: no more bytes will follow. Throws when the bytes do not decode.
type Decoder = (input: Uint8Array, final: boolean, emit: (chunk: Uint8Array) => void) => void;

// [LAW:one-type-per-behavior] The content codings Claude Code accepts (gzip, deflate, br, zstd) and their aliases.
// Anthropic answers in more than one: a stream with gzip, an error with br. HTTP's deflate is the zlib format.
const decoders: Partial<Record<string, Decoder>> = {
  gzip: (input, final, emit) => new Gunzip(emit).push(input, final),
  "x-gzip": (input, final, emit) => new Gunzip(emit).push(input, final),
  deflate: (input, final, emit) => new Unzlib(emit).push(input, final),
  zstd: (input, final, emit) => new ZstdDecompress(emit).push(input, final),
  br: (input, final, emit) => {
    if (!final) throw new Error(`${input.length} bytes wait for the body to complete: br is decoded whole`);
    emit(brotliDecompress(input));
  },
};

function contentCodings(headers: Header[]): string[] {
  return headers
    .filter(([name]) => name.toLowerCase() === "content-encoding")
    .flatMap(([, value]) => value.split(","))
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity");
}

// A body not complete may end inside a character: its bytes wait for the rest instead of decoding to U+FFFD.
function utf8(bytes: Uint8Array, final: boolean): string {
  return new TextDecoder().decode(bytes, { stream: !final });
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
