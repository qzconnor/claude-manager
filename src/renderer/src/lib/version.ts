/** Compares versions like `1.10.0` and `1.9.2` numerically; > 0 if `a` is newer. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) =>
    version
      .split('-')[0]
      .split('.')
      .map((n) => Number(n) || 0)
  const [pa, pb] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff) return diff
  }
  return 0
}
