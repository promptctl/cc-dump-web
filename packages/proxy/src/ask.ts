// [LAW:one-source-of-truth] The one way a part asks the proxy's reader port: its answer to one request, parsed, or a
// failure naming the request. The UI and the app server both ask it, so it holds nothing of node's.
export async function ask<T>(url: string, init: RequestInit, parse: (json: string) => T): Promise<T> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return parse(await res.text());
  } catch (error) {
    throw new Error(`${init.method ?? "GET"} ${url}`, { cause: error });
  }
}
