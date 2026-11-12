import { describe, expect, it } from 'vitest'
import { allTags, cleanTag, cleanTags, hasTag, MAX_SESSION_TAGS, MAX_TAG_LENGTH } from './session-marks'

describe('cleanTag', () => {
  it('puts a tag on one line without the # before it', () => {
    expect(cleanTag('  #Bug\nfix ')).toBe('Bug fix')
    expect(cleanTag('## Release')).toBe('Release')
    expect(cleanTag('C#')).toBe('C#')
    expect(cleanTag(' \n ')).toBe('')
    expect(cleanTag('#')).toBe('')
  })

  it('cuts a long tag without a space at its end', () => {
    expect(cleanTag('x'.repeat(MAX_TAG_LENGTH + 5))).toHaveLength(MAX_TAG_LENGTH)
    expect(cleanTag(`${'x'.repeat(MAX_TAG_LENGTH - 1)} y`)).toBe('x'.repeat(MAX_TAG_LENGTH - 1))
  })
})

describe('cleanTags', () => {
  it('keeps each tag once in its first spelling, in the order given, without what is no text', () => {
    expect(cleanTags(['Bug', ' bug', 'Über', 'über', '', 3, null, 'Release'])).toEqual(['Bug', 'Über', 'Release'])
  })

  it('keeps no more than a session takes', () => {
    const many = Array.from({ length: MAX_SESSION_TAGS + 3 }, (_, i) => `t${i}`)
    expect(cleanTags(many)).toEqual(many.slice(0, MAX_SESSION_TAGS))
    // Doubles don't take a place.
    expect(cleanTags(['a', 'A', ...many])).toEqual(['a', ...many.slice(0, MAX_SESSION_TAGS - 1)])
  })
})

describe('hasTag and allTags', () => {
  it('finds a tag whatever its case', () => {
    expect(hasTag(['Bug', 'Release'], 'bug')).toBe(true)
    expect(hasTag(['Bug'], 'Bugs')).toBe(false)
  })

  it('lists the tags of all sessions once each, in alphabetical order', () => {
    expect(allTags([{ tags: ['release', 'Bug'] }, { tags: ['bug', 'Äpfel', 'Zebra'] }, { tags: [] }])).toEqual([
      'Äpfel',
      'Bug',
      'release',
      'Zebra',
    ])
    expect(allTags([])).toEqual([])
  })
})
