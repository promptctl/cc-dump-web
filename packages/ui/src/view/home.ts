// `path` as a shell abbreviates it, `~` for `home` and what is in it, so `/Users/a/code` reads `~/code`; `/Users/ab` is
// not in `/Users/a`.
export function tildeHome(path: string, home: string): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
