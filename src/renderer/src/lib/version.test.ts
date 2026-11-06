import { describe, expect, it } from 'vitest'
import { compareVersions } from './version'

const sign = (n: number) => Math.sign(n)

describe('compareVersions', () => {
  it('compares each part numerically', () => {
    expect(sign(compareVersions('1.10.0', '1.9.2'))).toBe(1)
    expect(sign(compareVersions('1.9.2', '1.10.0'))).toBe(-1)
    expect(sign(compareVersions('2.0.0', '1.99.99'))).toBe(1)
    expect(sign(compareVersions('0.1.10', '0.1.9'))).toBe(1)
  })

  it('treats equal versions as equal', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('fills missing parts with zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(sign(compareVersions('1.2.1', '1.2'))).toBe(1)
    expect(sign(compareVersions('1', '1.0.1'))).toBe(-1)
  })

  it('compares the numbers in front of a pre-release suffix', () => {
    expect(sign(compareVersions('1.3.0-beta.1', '1.2.9'))).toBe(1)
    expect(sign(compareVersions('1.2.9', '1.3.0-rc.2'))).toBe(-1)
  })

  it('takes a release as newer than its pre-releases', () => {
    expect(sign(compareVersions('1.2.0', '1.2.0-beta.1'))).toBe(1)
    expect(sign(compareVersions('1.2.0-rc.1', '1.2.0'))).toBe(-1)
  })

  it('orders pre-releases like SemVer', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
    for (let i = 1; i < ordered.length; i++) {
      expect(sign(compareVersions(ordered[i], ordered[i - 1])), `${ordered[i]} > ${ordered[i - 1]}`).toBe(1)
      expect(sign(compareVersions(ordered[i - 1], ordered[i]))).toBe(-1)
    }
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.2')).toBe(0)
  })

  it('ignores a leading v and build metadata', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3+build.5', '1.2.3')).toBe(0)
  })
})
