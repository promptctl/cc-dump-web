// [LAW:one-source-of-truth] The port the browser opens. Its own module, so other parts can import it
// without loading the UI. It is part of the origin the reader's settings are kept under (settings.ts): a UI on another
// port starts from every setting's default.
export const UI_PORT = 3346;
