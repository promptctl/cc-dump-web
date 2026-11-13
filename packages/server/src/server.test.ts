import { serving } from "@cc-dump/log/testing";
import { expect, it } from "vitest";
import { app } from "./server.ts";

it("answers an unknown route with 404", async () => {
  const { url } = await serving(app);

  const res = await fetch(`${url}/api/nothing`);
  await res.text();

  expect(res.status).toBe(404);
});
