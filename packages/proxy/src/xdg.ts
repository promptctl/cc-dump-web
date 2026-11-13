import { isAbsolute, join } from "node:path";

// The XDG Base Directory spec's default for each base directory, under the home directory.
const defaults = { XDG_DATA_HOME: ".local/share", XDG_CONFIG_HOME: ".config" };

// [LAW:single-enforcer] Where a base directory is, by the XDG Base Directory spec: the variable's value, or the spec's
// default under `home` when that is unset or not absolute, which the spec says to ignore. `from` says which, for the
// event of the work that uses it.
export function baseDirectory(variable: keyof typeof defaults, env: NodeJS.ProcessEnv, home: string) {
  const value = env[variable];
  return value && isAbsolute(value) ? { dir: value, from: variable } : { dir: join(home, defaults[variable]), from: "default" };
}
