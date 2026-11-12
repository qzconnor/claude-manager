import type { AppSettings, DeepPartial } from '@shared/types'

/** The settings a card of the settings shows, by section: what its „Zurücksetzen“ resets. */
export type SettingsResetKeys = { [S in keyof AppSettings]?: readonly (keyof AppSettings[S] & string)[] }

/** What resetting `keys` sets (their defaults) and what brings them back as they were (`previous`). */
export function resetPatches(
  keys: SettingsResetKeys,
  current: AppSettings,
  defaults: AppSettings,
): { patch: DeepPartial<AppSettings>; previous: DeepPartial<AppSettings> } {
  const patch: Record<string, Record<string, unknown>> = {}
  const previous: Record<string, Record<string, unknown>> = {}
  for (const [section, names] of Object.entries(keys) as [keyof AppSettings, readonly string[]][]) {
    patch[section] = {}
    previous[section] = {}
    for (const name of names) {
      patch[section][name] = copy((defaults[section] as unknown as Record<string, unknown>)[name])
      previous[section][name] = copy((current[section] as unknown as Record<string, unknown>)[name])
    }
  }
  return { patch: patch as DeepPartial<AppSettings>, previous: previous as DeepPartial<AppSettings> }
}

/** Settings are plain JSON; this also copies the reactive proxies of the store. */
function copy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}
