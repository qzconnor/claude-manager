/**
 * Keys as Claude names them (`Enter`, `Control+A`, `Shift+Tab`), turned into the key events of the
 * Chrome DevTools Protocol (`Input.dispatchKeyEvent`).
 */

export interface KeyEvent {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp'
  key: string
  code: string
  windowsVirtualKeyCode: number
  modifiers: number
  /** The character the key types; only for keys that type one. */
  text?: string
}

interface KeyDefinition {
  key: string
  code: string
  keyCode: number
  text?: string
}

/** The bits of `modifiers` in CDP. */
const MODIFIERS: Record<string, KeyDefinition & { bit: number }> = {
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, bit: 1 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, bit: 2 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, bit: 4 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, bit: 8 },
}

const NAMED: Record<string, KeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  ContextMenu: { key: 'ContextMenu', code: 'ContextMenu', keyCode: 93 },
}
for (let n = 1; n <= 12; n++) NAMED[`F${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n }

/** Other names Claude may use, in lower case. */
const ALIASES: Record<string, string> = {
  ctrl: 'Control',
  control: 'Control',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  win: 'Meta',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  esc: 'Escape',
  return: 'Enter',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  ' ': 'Space',
}

function canonical(name: string): string {
  const alias = ALIASES[name.toLowerCase()]
  if (alias) return alias
  const named = Object.keys(NAMED).find((key) => key.toLowerCase() === name.toLowerCase())
  return named ?? name
}

/** A single character: letters and digits get their key code, other characters only type. */
function characterKey(char: string, shift: boolean): KeyDefinition {
  if (/^[a-z]$/i.test(char)) {
    const upper = char.toUpperCase()
    const typed = shift ? upper : char
    return { key: typed, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: typed }
  }
  if (/^[0-9]$/.test(char)) return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), text: char }
  return { key: char, code: '', keyCode: 0, text: char }
}

/**
 * The events for a key with its modifiers, e.g. `Control+Shift+K`, in the order they happen.
 * Throws for a name it doesn't know.
 */
export function keyEvents(combo: string): KeyEvent[] {
  // A lone "+" is the key itself, as is the "+" in "Control++".
  const parts = combo === '+' ? ['+'] : combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo.split('+')
  const names = parts.map((part) => (part === ' ' ? ' ' : part.trim())).filter((part) => part.length > 0)
  if (names.length === 0) throw new Error('No key given.')
  const mainName = canonical(names[names.length - 1])
  const modifiers = names.slice(0, -1).map((name) => {
    const modifier = MODIFIERS[canonical(name)]
    if (!modifier) throw new Error(`Unknown modifier "${name}". Use Control, Alt, Shift or Meta.`)
    return modifier
  })
  const bits = modifiers.reduce((sum, modifier) => sum | modifier.bit, 0)
  const shift = (bits & MODIFIERS.Shift.bit) !== 0

  let main: KeyDefinition
  if (MODIFIERS[mainName]) main = MODIFIERS[mainName]
  else if (NAMED[mainName]) main = NAMED[mainName]
  else if ([...mainName].length === 1) main = characterKey(mainName, shift)
  else throw new Error(`Unknown key "${mainName}". Use e.g. Enter, Tab, Escape, ArrowDown, F5 or a single character.`)

  // With Control, Alt or Meta held the key is a shortcut and types nothing.
  const types = main.text !== undefined && (bits & ~MODIFIERS.Shift.bit) === 0
  const events: KeyEvent[] = []
  let held = 0
  for (const modifier of modifiers) {
    held |= modifier.bit
    events.push({ type: 'rawKeyDown', key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers: held })
  }
  const base = { key: main.key, code: main.code, windowsVirtualKeyCode: main.keyCode, modifiers: bits }
  events.push(types ? { type: 'keyDown', ...base, text: main.text } : { type: 'rawKeyDown', ...base })
  events.push({ type: 'keyUp', ...base })
  for (const modifier of [...modifiers].reverse()) {
    held &= ~modifier.bit
    events.push({ type: 'keyUp', key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers: held })
  }
  return events
}
