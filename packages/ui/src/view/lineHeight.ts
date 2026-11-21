// [LAW:one-source-of-truth] An element's line, in pixels, as the stylesheet has it: what a move by lines moves.
export const lineHeightOf = (element: Element): number => parseFloat(getComputedStyle(element).lineHeight);
