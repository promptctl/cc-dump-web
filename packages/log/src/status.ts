// An HTTP response's status (RFC 9110, section 15) as the log and the UI read it. Imports nothing, so the UI uses it too.

// A response's status code and reason phrase, as its status line (RFC 9112, section 4) says them.
export type StatusLine = { status: number; reason: string };

// RFC 9110's client error (4xx) and server error (5xx) classes, and every status outside 100..599, which is invalid and
// which a client is to process as a 5xx (section 15).
export const isErrorStatus = (status: number): boolean => status < 100 || status >= 400;
