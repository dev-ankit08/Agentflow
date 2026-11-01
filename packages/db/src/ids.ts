/** Prefixed, URL-safe ids such as `flw_3f9a…` so the type of an id is obvious in logs and URLs. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}
