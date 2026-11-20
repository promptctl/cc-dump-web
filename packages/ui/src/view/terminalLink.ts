import type { ILinkHandler } from "@xterm/xterm";

// How a link in the terminal opens (docs/design/01-features.md, F13). One of a scheme the browser handles itself is
// refused since what the agent prints is not the app's to run; one that does not parse as a URL is a link to nothing.
export type LinkOpening = "tab" | "app" | "refused";

const web = new Set(["http:", "https:"]);
const browsers = new Set([
  "about:", "blob:", "data:", "file:", "filesystem:", "javascript:", "vbscript:", "view-source:", "ws:", "wss:",
  "chrome:", "chrome-extension:", "edge:", "moz-extension:", "safari-web-extension:",
]);

export function linkOpening(uri: string): LinkOpening {
  const url = URL.parse(uri);
  if (url === null || browsers.has(url.protocol)) return "refused";
  return web.has(url.protocol) ? "tab" : "app";
}

// The hidden frame an app's link opens in (view/Terminal.tsx): the browser hands the scheme to the OS from there,
// asking first, and whatever the frame shows instead, an error page for a scheme nothing handles, is never the app's.
export const LINK_FRAME = "terminal-links";

// [LAW:single-enforcer] Every link the terminal shows opens here on a click: those the program wrote as links (OSC 8),
// of every scheme, and the URLs it printed as text.
export function openLink(uri: string) {
  switch (linkOpening(uri)) {
    case "tab":
      window.open(uri, "_blank", "noopener,noreferrer");
      return;
    case "app":
      window.open(uri, LINK_FRAME);
      return;
    case "refused":
      return;
  }
}

// Where a link goes, on the terminal's own element while the pointer is over it, since a link's text need not say.
export function showTarget(event: MouseEvent, uri: string) {
  const terminal = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".xterm");
  if (terminal) terminal.title = linkOpening(uri) === "refused" ? `${uri}\nNot opened from the terminal` : uri;
}

// The pointer may have left the terminal it was over, so every terminal's is cleared.
export function hideTarget() {
  for (const terminal of document.querySelectorAll<HTMLElement>(".xterm")) terminal.removeAttribute("title");
}

export const linkHandler: ILinkHandler = {
  allowNonHttpProtocols: true,
  activate: (_event, uri) => openLink(uri),
  hover: showTarget,
  leave: hideTarget,
};
