import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'vue-sonner'
import { attempt, errorMessage } from './errors'

vi.mock('vue-sonner', () => ({ toast: { error: vi.fn() } }))

describe('errorMessage', () => {
  it("strips Electron's prefix of errors thrown in the main process", () => {
    const error = new Error("Error invoking remote method 'accounts:create': Error: Name fehlt")
    expect(errorMessage(error)).toBe('Name fehlt')
    expect(errorMessage(new Error("Error invoking remote method 'x': TypeError: kaputt"))).toBe('TypeError: kaputt')
  })

  it('keeps other messages and turns non-errors into text', () => {
    expect(errorMessage(new Error('Kein Netz'))).toBe('Kein Netz')
    expect(errorMessage('plain')).toBe('plain')
    expect(errorMessage(42)).toBe('42')
  })
})

describe('attempt', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear()
  })

  it('returns the result of a successful action', async () => {
    await expect(attempt(async () => 7)).resolves.toBe(7)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('shows a toast and returns undefined when the action fails', async () => {
    await expect(attempt(() => Promise.reject(new Error("Error invoking remote method 'a': Error: weg")), 'Speichern')).resolves.toBeUndefined()
    expect(toast.error).toHaveBeenCalledWith('Speichern', { description: 'weg' })
  })

  it('titles the toast "Fehler" by default', async () => {
    await attempt(() => Promise.reject(new Error('x')))
    expect(toast.error).toHaveBeenCalledWith('Fehler', { description: 'x' })
  })
})
