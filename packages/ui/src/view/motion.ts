// Moving in time as one motion (docs/design/02-design.md, "Two axes"): the conversation the moment leaves slides away,
// the way the move goes, while the next moment fades in, by the View Transitions API, its motion the stylesheet's
// (index.css), which has none when the OS asks for reduced motion. Only a move the reader makes runs one; what arrives
// live is not animated.

// Which way a move in time goes: back to an earlier step, or forward to a later one.
export type Way = "back" | "forward";

// [LAW:effects-at-boundaries] The one place the document runs a transition. A browser whose transitions take no types
// could not tell the stylesheet which way to slide, so there the update is made with no motion.
const typed = typeof document.startViewTransition === "function" && typeof ViewTransition !== "undefined" && "types" in ViewTransition.prototype;

// Runs `update`, which must change the page before it returns, as a motion `way`. Gives when the update is done, or
// why it failed. [LAW:no-silent-failure] A transition another move skips, or a hidden document, still makes its update,
// so its motion not running is expected and nothing to report; the update failing is reported, by what this gives.
export function inMotion(way: Way, update: () => void): Promise<void> {
  if (!typed) {
    update();
    return Promise.resolve();
  }
  const transition = document.startViewTransition({ update, types: [way] });
  transition.ready.catch(() => {});
  transition.finished.catch(() => {});
  return transition.updateCallbackDone;
}
