import { useLayoutEffect, useMemo, useRef, type PointerEvent, type RefObject } from "react";
import type { Theme } from "../theme/theme.ts";
import { colorsOf, offsetAt, scaleOf, slivers, viewBox, type Extent } from "./minimap.ts";
import type { Row } from "./rows.ts";

// The minimap (docs/design/02-design.md, "Layout"), beside the columns: the conversation's rows top to bottom at its
// height, each a sliver in its category's color with the mark of what the step did to it at its right edge, and the
// view's box over them. A press or a drag on it puts the view there, through `onPlace`, the view's own placing, so the
// view stays the scroll offset's one writer. `extents`: each row's start and height, measured or estimated, as the
// virtualizer holds them; `total`: the conversation's height; `scroller`: what the view's box is read from.
export function Minimap({
  rows,
  extents,
  total,
  scroller,
  theme,
  onPlace,
}: {
  rows: readonly Row[];
  extents: readonly Extent[];
  total: number;
  scroller: RefObject<HTMLElement | null>;
  theme: Theme;
  onPlace: (offset: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const colors = useMemo(() => colorsOf(theme), [theme]);
  // [LAW:effects-at-boundaries] The one draw: the geometry (minimap.ts) painted, at the device's pixel ratio.
  const draw = () => {
    const element = canvas.current!;
    const view = scroller.current!;
    const { clientWidth: width, clientHeight: height } = element;
    const ratio = window.devicePixelRatio;
    // Setting its size clears the canvas.
    element.width = Math.round(width * ratio);
    element.height = Math.round(height * ratio);
    const context = element.getContext("2d")!;
    context.scale(ratio, ratio);
    const scale = scaleOf(total, height);
    for (const { y, height: tall, paint, change } of slivers(rows, extents, scale)) {
      context.fillStyle = colors.paint[paint];
      context.fillRect(0, y, width - markWidth - 1, tall);
      context.fillStyle = colors.change[change];
      context.fillRect(width - markWidth, y, markWidth, tall);
    }
    const box = viewBox(view.scrollTop, view.clientHeight, scale);
    context.fillStyle = colors.view;
    context.globalAlpha = 0.12;
    context.fillRect(0, box.y, width, box.height);
    context.globalAlpha = 0.5;
    context.strokeStyle = colors.view;
    context.strokeRect(0.5, box.y + 0.5, width - 1, Math.max(0, box.height - 1));
  };
  // [LAW:no-ambient-temporal-coupling] Drawn after every render, with what it rendered, and, at most once a frame, when
  // the view scrolls or the minimap is resized, with the render last committed.
  const latest = useRef(draw);
  useLayoutEffect(() => {
    latest.current = draw;
    draw();
  });
  useLayoutEffect(() => {
    const view = scroller.current!;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => latest.current());
    };
    const resized = new ResizeObserver(schedule);
    resized.observe(canvas.current!);
    view.addEventListener("scroll", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      view.removeEventListener("scroll", schedule);
    };
  }, [scroller]);
  // The point pressed, or dragged to while the press holds, is where the view goes.
  const place = (event: PointerEvent<HTMLCanvasElement>) => {
    const { top, height } = event.currentTarget.getBoundingClientRect();
    onPlace(offsetAt(event.clientY - top, scaleOf(total, height), scroller.current!.clientHeight, total));
  };
  return (
    // The canvas fills a box of its own: its size set to draw it is not a size the layout reads.
    <div className="relative w-10 shrink-0 bg-surface">
      <canvas
        ref={canvas}
        data-minimap
        aria-hidden
        className="absolute inset-0 h-full w-full cursor-pointer touch-none"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          place(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) place(event);
        }}
      />
    </div>
  );
}

// How wide the column of what the step did is, at the minimap's right edge, in pixels.
const markWidth = 3;
