import type { ButtonHTMLAttributes } from "react";

// [LAW:single-enforcer] A control beside the conversation, pressed, not pressed or mixed. A click takes no focus: once
// it is clicked, End and Space still scroll the conversation, and Space does not press it again.
export function Toggle({ pressed, ...button }: { pressed: boolean | "mixed" } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "aria-pressed" | "onMouseDown">) {
  return <button type="button" aria-pressed={pressed} onMouseDown={(event) => event.preventDefault()} {...button} />;
}
