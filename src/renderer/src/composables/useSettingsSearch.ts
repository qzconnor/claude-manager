import { inject, provide, ref, type InjectionKey, type Ref } from 'vue'
import { settingsIndex, type SettingsAnchor, type SettingsEntry, type SettingsMatch } from '@/lib/settings-index'

/** The cards and rows of the settings page on this system. */
export const SETTINGS: readonly SettingsEntry[] = settingsIndex(window.api.platform)

export const settingsEntry = (id: string): SettingsEntry | undefined => SETTINGS.find((entry) => entry.id === id)

export interface SettingsFilter {
  /** Words of the search on the settings page, to mark them; empty without a search. */
  terms: Readonly<Ref<string[]>>
  /** Whether a card or row is shown; without a search every one is. */
  shows: (anchor: SettingsAnchor) => boolean
}

const KEY: InjectionKey<SettingsFilter> = Symbol('settings-filter')
const UNFILTERED: SettingsFilter = { terms: ref([]), shows: () => true }

/** Hands the search of the settings page to its cards and rows. */
export function provideSettingsFilter(terms: Readonly<Ref<string[]>>, match: Readonly<Ref<SettingsMatch | null>>): void {
  provide(KEY, { terms, shows: (anchor) => !match.value || match.value.ids.has(anchor) })
}

/** The search of the settings page, for a card or row; outside of it everything is shown. */
export const useSettingsFilter = (): SettingsFilter => inject(KEY, UNFILTERED)

/** What gets the keyboard in a row: its first control that takes it, not a read-only field. */
const FOCUSABLE = ':is(input:not([readonly]), button, select, textarea, [tabindex]):not(:disabled, [tabindex="-1"])'

/** Lights an element up for a moment (`data-flash`, see main.css), anew if it already is. */
function flash(el: HTMLElement): void {
  el.removeAttribute('data-flash')
  void el.offsetWidth // restarts the animation
  el.setAttribute('data-flash', '')
  const done = (event: AnimationEvent) => {
    if (event.target !== el) return
    el.removeAttribute('data-flash')
    el.removeEventListener('animationend', done)
  }
  el.addEventListener('animationend', done)
}

/**
 * Scrolls to a card or row of the settings page, lights it up and gives a row's control the
 * keyboard. Waits a few frames for the tab to render; false if it doesn't show up.
 */
export async function revealSetting(entry: SettingsEntry): Promise<boolean> {
  for (let frame = 0; frame < 10; frame++) {
    await new Promise(requestAnimationFrame)
    const el = document.querySelector<HTMLElement>(`[data-setting="${CSS.escape(entry.id)}"]`)
    if (!el) continue
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ block: entry.kind === 'section' ? 'start' : 'center', behavior: smooth ? 'smooth' : 'auto' })
    flash(el)
    if (entry.kind === 'field') {
      const control = el.matches(FOCUSABLE) ? el : (el.querySelector('[data-setting-control]') ?? el).querySelector<HTMLElement>(FOCUSABLE)
      control?.focus({ preventScroll: true })
    }
    return true
  }
  return false
}
