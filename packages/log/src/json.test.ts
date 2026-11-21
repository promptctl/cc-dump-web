import { describe, expect, it } from "vitest";
import { Malformed } from "./failure.ts";
import { fields, parseJson } from "./json.ts";
import { parseTraceId } from "./trace.ts";

describe("fields", () => {
  const json = parseJson('{"trace_id":"a b","name":"x"}', "event");

  it("fails with Malformed, naming the field, when a parser cannot take its value", () => {
    expect(() => fields(json, "event").parsed("trace_id", parseTraceId)).toThrow(Malformed);
    expect(() => fields(json, "event").parsed("trace_id", parseTraceId)).toThrow("event: trace_id");
  });

  it("passes a parser's own bug as it is, so it is not taken for the sender's fault", () => {
    const bug = new TypeError("not a function");
    expect(() =>
      fields(json, "event").parsed("name", () => {
        throw bug;
      }),
    ).toThrow(bug);
  });

  it("fails with Malformed for text that is not JSON", () => {
    expect(() => parseJson("{", "event")).toThrow(Malformed);
  });
});
