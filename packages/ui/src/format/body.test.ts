import type { Header } from "@cc-dump/proxy/format";
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createDecoding, decodeBody } from "./body.ts";

// A body recorded in chunks of `size` bytes, each encoded on its own as the proxy does.
const chunked = (bytes: Uint8Array, size: number) =>
  Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => ({ base64: Buffer.from(bytes.subarray(i * size, (i + 1) * size)).toString("base64") }));

// A decoding fed its chunks one at a time gives, after each, what decoding that many chunks at once gives, and the
// same once the body is complete.
function expectIncrementalEqualsWhole(headers: Header[], chunks: { base64: string }[]) {
  const decoding = createDecoding(headers);
  for (let count = 0; count <= chunks.length; count++) {
    expect(decoding.decode(chunks.slice(0, count), false), `${count} chunks`).toEqual(decodeBody(headers, chunks.slice(0, count), false));
  }
  expect(decoding.decode(chunks, true)).toEqual(decodeBody(headers, chunks, true));
  return decoding.decode(chunks, true);
}

// Text with characters of two, three and four bytes, so chunks split them.
const text = "event: content_block_delta\ndata: {\"text\":\"é ✓ 𝄞\"}\n\n".repeat(40);

describe("createDecoding", () => {
  it.each([
    ["identity", [], new TextEncoder().encode(text)],
    ["gzip", [["Content-Encoding", "gzip"]], gzipSync(text)],
    ["deflate", [["Content-Encoding", "deflate"]], deflateSync(text)],
    ["zstd", [["Content-Encoding", "zstd"]], zstdCompressSync(text)],
    ["br", [["Content-Encoding", "br"]], brotliCompressSync(text)],
    ["gzip then br", [["Content-Encoding", "gzip, br"]], brotliCompressSync(gzipSync(text))],
  ] satisfies [string, Header[], Uint8Array][])("decodes a %s body fed chunk by chunk as it decodes it whole", (_, headers, bytes) => {
    expect(expectIncrementalEqualsWhole(headers, chunked(bytes, 7))).toEqual({ text, error: undefined });
  });

  it("decodes a body cut short, and one with a chunk that is not base64, as far as its bytes allow", () => {
    const gzipped = gzipSync(text);
    const cut = expectIncrementalEqualsWhole([["Content-Encoding", "gzip"]], chunked(gzipped.subarray(0, gzipped.length - 10), 7));
    expect(text.startsWith(cut.text.replace(/�$/, ""))).toBe(true);
    expect(cut.error).toBeDefined();
    const chunks = chunked(new TextEncoder().encode(text), 7);
    const broken = expectIncrementalEqualsWhole([], [...chunks.slice(0, 5), { base64: "not base64!" }, ...chunks.slice(5)]);
    expect(broken).toEqual({ text: text.slice(0, 35), error: expect.any(String) });
  });

  it("says a body is not UTF-8, fed chunk by chunk as whole", () => {
    expect(expectIncrementalEqualsWhole([], chunked(gzipSync(text), 7)).error).toBe("the body is not UTF-8: what is not is shown as U+FFFD");
  });

  it("refuses chunks that do not extend the ones it decoded", () => {
    const decoding = createDecoding([]);
    decoding.decode(chunked(new TextEncoder().encode(text), 7), false);
    expect(() => decoding.decode([], false)).toThrow(/a recording only grows/);
  });
});
