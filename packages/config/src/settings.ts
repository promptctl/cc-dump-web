import type { Json, Readers } from "@cc-dump/log/json";

// [LAW:one-type-per-behavior] [LAW:parse-dont-validate] A part's settings, `S`: each setting's reader, by which a
// settings file and a message carrying the settings alike read it, and its default, as a settings file would hold it.
// Imports nothing that needs node, so the UI reads settings by the same readers. A setting added here is read, and
// refused, by everything that reads the settings.
export type Settings<S> = { readers: Readers<S>; defaults: { [K in keyof S]: Json } };
