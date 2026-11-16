import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_FRAME, linkOpening, openLink } from "./terminalLink.ts";

describe("linkOpening", () => {
  it("opens a web page in a tab", () => {
    expect(linkOpening("https://example.com/a?b")).toBe("tab");
    expect(linkOpening("http://127.0.0.1:3346/")).toBe("tab");
  });

  it("opens a scheme the browser does not handle by the OS's app for it", () => {
    expect(linkOpening("cc-candybar://dispatch/copy?path=%2FUsers%2Fbmf")).toBe("app");
    expect(linkOpening("vscode://file/Users/bmf/code/x.ts:3")).toBe("app");
    expect(linkOpening("mailto:a@example.com")).toBe("app");
  });

  it("opens nothing of a scheme the browser handles itself, or that is no URL", () => {
    expect(linkOpening("javascript:alert(1)")).toBe("refused");
    expect(linkOpening("JavaScript:alert(1)")).toBe("refused");
    expect(linkOpening("data:text/html,<script>alert(1)</script>")).toBe("refused");
    expect(linkOpening("blob:http://127.0.0.1:3346/x")).toBe("refused");
    expect(linkOpening("about:blank")).toBe("refused");
    expect(linkOpening("file:///Users/bmf/code")).toBe("refused");
    expect(linkOpening("view-source:http://127.0.0.1:3346/")).toBe("refused");
    expect(linkOpening("not a url")).toBe("refused");
  });
});

describe("openLink", () => {
  const open = vi.fn();
  beforeEach(() => {
    open.mockReset();
    vi.stubGlobal("window", { open });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens a web page in a new tab that cannot reach the app", () => {
    openLink("https://example.com/");
    expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/", "_blank", "noopener,noreferrer");
  });

  it("opens an app's link in the hidden frame, never the app's page", () => {
    openLink("cc-candybar://dispatch/copy");
    expect(open).toHaveBeenCalledExactlyOnceWith("cc-candybar://dispatch/copy", LINK_FRAME);
  });

  it("opens nothing for a refused link", () => {
    openLink("javascript:alert(1)");
    expect(open).not.toHaveBeenCalled();
  });
});
