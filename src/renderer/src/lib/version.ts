/**
 * Compares versions like `1.10.0` and `1.9.2` numerically; > 0 if `a` is newer. Pre-releases follow
 * SemVer: `1.2.0-beta.1` is older than `1.2.0` and than `1.2.0-beta.2`. A leading `v` and build
 * metadata (`+…`) are ignored.
 */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = split(a)
  const [coreB, preB] = split(b)
  for (let i = 0; i < Math.max(coreA.length, coreB.length); i++) {
    const diff = (coreA[i] ?? 0) - (coreB[i] ?? 0)
    if (diff) return Math.sign(diff)
  }
  if (!preA.length || !preB.length) return Math.sign(preB.length - preA.length)
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    const x = preA[i]
    const y = preB[i]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    // Numeric identifiers compare as numbers and come before alphanumeric ones.
    if (nx && ny) return Math.sign(Number(x) - Number(y))
    if (nx !== ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

function split(version: string): [core: number[], pre: string[]] {
  const plain = version.trim().replace(/^v/i, '').split('+')[0]
  const dash = plain.indexOf('-')
  const core = (dash === -1 ? plain : plain.slice(0, dash)).split('.').map((n) => Number(n) || 0)
  const pre = dash === -1 ? [] : plain.slice(dash + 1).split('.').filter(Boolean)
  return [core, pre]
}
