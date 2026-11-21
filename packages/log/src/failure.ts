// [LAW:one-source-of-truth] The kinds of failure a part's code tells apart, declared below the HTTP layer so the code that
// fails does not need to know what status it is answered with: answer.ts maps each kind to its status, once. An error of
// no kind here is the part's own failure. Imports nothing that needs node, so the UI's parsers use it too.

// The error every parser, and each part's format.ts, throws for input it cannot take, so a request's reader can tell a
// client's unreadable input from a bug of its own, which is another error.
export class Malformed extends Error {}

// A dependency of the part failing (the proxy for the app server, tmux): its failure, in its words, is not the part's own.
export class DependencyFailed extends Error {}
