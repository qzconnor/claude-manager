import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUiStore } from './ui'

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ui store: confirm', () => {
  it('lets a second question wait for the first, instead of answering it with No', async () => {
    const ui = useUiStore()
    const remove = ui.confirm({ title: 'Session löschen?' })
    // The main process asks meanwhile (trusting a folder after `cm`).
    const trust = ui.confirm({ title: 'Ordner vertrauen?' })
    expect(ui.confirmState?.title).toBe('Session löschen?')

    ui.settleConfirm(true)
    expect(await remove).toBe(true)
    expect(ui.confirmState?.open).toBe(false)

    // Once the first has faded out, the second comes.
    await vi.advanceTimersByTimeAsync(200)
    expect(ui.confirmState).toMatchObject({ title: 'Ordner vertrauen?', open: true })
    ui.settleConfirm(false)
    expect(await trust).toBe(false)
  })

  it('answers each question once, also when the dialog closes after a click', async () => {
    const ui = useUiStore()
    const asked = ui.confirm({ title: 'Beenden?' })
    ui.settleConfirm(true)
    // Closing, the dialog reports it too.
    ui.settleConfirm(false)
    expect(await asked).toBe(true)
  })
})
