import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compactLimit, readCompactLimit, type AccountFiles } from './auto-compact'

const models: AccountFiles['models'] = new Map([
  ['claude-opus-5-5', { input: 1_000_000, output: 128_000 }],
  ['claude-haiku-4-5', { input: 200_000, output: 8_000 }],
])

function limit(settings: AccountFiles['settings'], model: string | null, env: NodeJS.ProcessEnv = {}, selected: string | null = null) {
  return compactLimit({ settings, models, selected }, model, env)
}

describe('compactLimit', () => {
  const opus400k = { modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh', autoCompactWindow: 400_000 } } }

  it('compacts below the window that /autocompact set for the model, as Claude Code does', () => {
    // 400k less 20k for the answer and 13k for the summary: the user's sessions compacted at about 368k.
    expect(limit(opus400k, 'claude-opus-5-5')).toEqual({ model: 'claude-opus-5-5', window: 400_000, configured: true, compactAt: 367_000 })
    // Without a setting the model's whole context window.
    expect(limit({}, 'claude-opus-5-5')).toEqual({ model: 'claude-opus-5-5', window: 1_000_000, configured: false, compactAt: 967_000 })
  })

  it('takes the model chosen in Claude Code before the first answer, the session’s after it', () => {
    expect(limit(opus400k, null, {}, 'claude-opus-5-5')).toMatchObject({ model: 'claude-opus-5-5', compactAt: 367_000 })
    expect(limit(opus400k, 'claude-haiku-4-5', {}, 'claude-opus-5-5')).toMatchObject({ model: 'claude-haiku-4-5', window: 200_000 })
    expect(limit(opus400k, null)).toMatchObject({ model: null, window: 200_000 })
  })

  it('takes the top-level setting, the variable first, and never more than the model has', () => {
    expect(limit({ autoCompactWindow: 300_000 }, 'claude-opus-5-5').window).toBe(300_000)
    const both = { autoCompactWindow: 300_000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 500_000 } } }
    expect(limit(both, 'claude-opus-5-5', { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250k' }).window).toBe(250_000)
    expect(limit({ autoCompactWindow: 'auto' }, 'claude-opus-5-5').configured).toBe(false)
    // A dated model id takes the entry without the date; its small output leaves more room.
    const haiku = limit({ modelSettings: { 'claude-haiku-4-5': { autoCompactWindow: 900_000 } } }, 'claude-haiku-4-5-20251001')
    expect(haiku).toMatchObject({ window: 200_000, configured: true, compactAt: 179_000 })
  })

  it('guesses 200k for a model it doesn’t know, 1M with [1m], and knows when auto-compact is off', () => {
    expect(limit({}, 'claude-unknown').compactAt).toBe(167_000)
    expect(limit({ model: 'sonnet[1m]' }, 'claude-unknown').window).toBe(1_000_000)
    expect(limit({ autoCompactEnabled: false }, 'claude-opus-5-5').compactAt).toBeNull()
    expect(limit({ env: { DISABLE_AUTO_COMPACT: '1' } }, 'claude-opus-5-5').compactAt).toBeNull()
    expect(limit({}, 'claude-opus-5-5', { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' }).compactAt).toBe(490_000)
  })
})

describe('readCompactLimit', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cm-compact-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads the settings and the model catalog of the account, with the model chosen there', async () => {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ model: 'opus', modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 400_000 } } }))
    const catalog = join(dir, 'cache', 'model-catalog')
    await mkdir(catalog, { recursive: true })
    const entry = { id: 'claude-opus-5-5', runtime: { max_input_tokens: 1_000_000, max_output_tokens: 128_000 } }
    const file = { catalog: { config: { models: [entry] }, state: { model: 'claude-opus-5-5' } } }
    await writeFile(join(catalog, 'org-hash-cc.json'), JSON.stringify(file))
    const expected = { model: 'claude-opus-5-5', window: 400_000, configured: true, compactAt: 367_000 }
    expect(await readCompactLimit(dir, 'claude-opus-5-5', {})).toEqual(expected)
    expect(await readCompactLimit(dir, null, {})).toEqual(expected)
    expect(await readCompactLimit(join(dir, 'fehlt'), 'claude-opus-5-5', {})).toMatchObject({ window: 200_000, compactAt: 167_000 })
  })
})
