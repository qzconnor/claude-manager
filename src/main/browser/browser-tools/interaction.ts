import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { keyEvents } from '../keys'
import { isFrameRef } from '../frames'
import { delay, type ElementBox, type MouseButton } from '../page-driver'
import type { ActionContext } from '../action-context'
import { type Args, cut, oneOf, optionalBoolean, optionalNumber, optionalString, requiredString, stringList, ToolError } from '../tool-args'
import { center, CLICK_AFTER_MOVE_MS, element, pageState, quote, ref, refOf, SHOW_MS, target, targetName, tool, type ToolDefinition, untilBlocked } from './tool'

/** Tools that act in the page like the user: click, type, keys, scroll, drag, forms, files, dialogs. */

const ACTION_SETTLE_MS = 5000

const MAX_UPLOAD_FILES = 20
const MAX_FORM_FIELDS = 50

/** The least time a drag takes, so the page sees it move. */
const MIN_DRAG_MS = 300

const FIELD_TYPES = ['textbox', 'checkbox', 'radio', 'combobox', 'slider'] as const
type FieldType = (typeof FIELD_TYPES)[number]
interface FormField {
  name: string
  type: FieldType
  ref: string
  value: string
}

export const interactionTools: ToolDefinition<never>[] = [
  tool({
    name: 'browser_click',
    title: 'Click',
    description: 'Clicks an element of the page with the mouse.',
    properties: {
      ref,
      element,
      doubleClick: { type: 'boolean', description: 'Double-click instead.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default: left.' },
      modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] }, description: 'Keys held while clicking.' },
    },
    required: ['ref'],
    kind: 'click',
    parse: (args) => ({
      ref: refOf(args),
      element: optionalString(args, 'element', 200),
      doubleClick: optionalBoolean(args, 'doubleClick') ?? false,
      button: oneOf(args, 'button', ['left', 'right', 'middle'] as const, 'left') as MouseButton,
      modifiers: modifierBits(args),
    }),
    label: (p) => `${p.doubleClick ? 'Doppelklickt' : 'Klickt'} auf ${p.element ? quote(p.element) : p.ref}`,
    run: async (ctx, p) => {
      const verb = p.doubleClick ? 'Doppelklickt' : p.button === 'right' ? 'Rechtsklickt' : 'Klickt'
      const box = await target(ctx, p.ref, p.element, (name) => `${verb} auf ${name}`, 'click')
      const { x, y } = center(box)
      await ctx.interceptFileChooser(() =>
        untilBlocked(ctx, async () => {
          await ctx.page.click(x, y, { button: p.button, clickCount: p.doubleClick ? 2 : 1, modifiers: p.modifiers })
          await ctx.page.settle(ACTION_SETTLE_MS)
        }),
      )
      const notes = [`Clicked ${describe(box, p.element)}.`]
      if (box.covered) notes.push(`Note: ${box.covered} lay over the element, the click may have hit it instead.`)
      if (ctx.fileChooser()) notes.push('A file chooser opened: pick files with browser_file_upload (without ref).')
      return { text: `${notes.join('\n')}\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_type',
    title: 'Type text',
    description: 'Types text into a text field or editor, replacing what is in it (unless append).',
    properties: {
      ref,
      element,
      text: { type: 'string', description: 'The text to type.' },
      submit: { type: 'boolean', description: 'Press Enter afterwards.' },
      append: { type: 'boolean', description: 'Add to the existing text instead of replacing it.' },
    },
    required: ['ref', 'text'],
    kind: 'type',
    parse: (args) => ({
      ref: refOf(args),
      element: optionalString(args, 'element', 200),
      text: requiredString(args, 'text', 100_000, true),
      submit: optionalBoolean(args, 'submit') ?? false,
      append: optionalBoolean(args, 'append') ?? false,
    }),
    label: (p) => `Tippt in ${p.element ? quote(p.element) : p.ref}`,
    run: async (ctx, p) => {
      const box = await target(ctx, p.ref, p.element, (name) => `Tippt in ${name}`, 'click')
      // What goes into a password field stays out of the log.
      ctx.label(`Tippt ${box.secret ? '••••' : quote(cut(p.text, 60))} in ${targetName(box, p.element)}`)
      const { x, y } = center(box)
      const notes: string[] = []
      await untilBlocked(ctx, async () => {
        await ctx.page.click(x, y)
        const kind = await ctx.page.callAt<string>(p.ref, 'prepareTyping', !p.append)
        if (kind === 'other') notes.push(`${describe(box, p.element)} is no text field; the text went to what has the focus after clicking it.`)
        if (p.text) await ctx.page.insertText(p.text)
        else if (!p.append) await ctx.page.press('Delete')
        if (p.submit) await ctx.page.press('Enter')
        await ctx.page.settle(p.submit ? ACTION_SETTLE_MS : 300)
      })
      ctx.note(box.secret ? 'Passwort eingegeben' : `${p.text.length} Zeichen`)
      return { text: `Typed into ${describe(box, p.element)}${p.submit ? ' and pressed Enter' : ''}.${notes.length ? `\n${notes.join('\n')}` : ''}\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_press_key',
    title: 'Press a key',
    description: 'Presses a key or a combination where the focus is, e.g. "Enter", "Escape", "ArrowDown", "Control+A", "Shift+Tab".',
    properties: { key: { type: 'string', description: 'The key, with modifiers joined by "+".' } },
    required: ['key'],
    kind: 'key',
    parse: (args) => {
      const key = requiredString(args, 'key', 60)
      try {
        keyEvents(key)
      } catch (error) {
        throw new ToolError((error as Error).message)
      }
      return { key }
    },
    label: ({ key }) => `Drückt ${key}`,
    run: async (ctx, { key }) => {
      ctx.highlight(`Drückt ${key}`)
      await untilBlocked(ctx, async () => {
        await ctx.page.press(key)
        await ctx.page.settle(ACTION_SETTLE_MS)
      })
      return { text: `Pressed ${key}.\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_hover',
    title: 'Hover',
    description: 'Moves the mouse over an element, e.g. to open a menu or a tooltip.',
    properties: { ref, element },
    required: ['ref'],
    kind: 'hover',
    parse: (args) => ({ ref: refOf(args), element: optionalString(args, 'element', 200) }),
    label: (p) => `Zeigt auf ${p.element ? quote(p.element) : p.ref}`,
    run: async (ctx, p) => {
      const box = await target(ctx, p.ref, p.element, (name) => `Zeigt auf ${name}`, 'move')
      const { x, y } = center(box)
      await ctx.page.hover(x, y)
      await delay(300)
      return { text: `Hovering over ${describe(box, p.element)}.\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_select_option',
    title: 'Select an option',
    description: 'Selects one or more options of a <select> by their value or text.',
    properties: { ref, element, values: { type: 'array', items: { type: 'string' }, description: 'Values or texts of the options.' } },
    required: ['ref', 'values'],
    kind: 'select',
    parse: (args) => ({ ref: refOf(args), element: optionalString(args, 'element', 200), values: stringList(args, 'values', 50) }),
    label: (p) => `Wählt ${p.values.map(quote).join(', ')}`,
    run: async (ctx, p) => {
      const box = await target(ctx, p.ref, p.element, (name) => `Wählt ${p.values.map((v) => quote(cut(v, 40))).join(', ')} in ${name}`, 'move')
      const chosen = await ctx.page.callAt<string[]>(p.ref, 'selectOptions', p.values)
      await ctx.page.settle(ACTION_SETTLE_MS)
      return { text: `Selected ${chosen.map((c) => JSON.stringify(c)).join(', ')} in ${describe(box, p.element)}.\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_scroll',
    title: 'Scroll',
    description: 'Scrolls the page, or scrolls an element into view (ref).',
    properties: {
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Default: down.' },
      pixels: { type: 'number', description: 'How far; default: most of the window.' },
      ref: { ...ref, description: 'Scroll this element into view instead.' },
    },
    kind: 'scroll',
    parse: (args) => ({
      direction: oneOf(args, 'direction', ['up', 'down', 'left', 'right'] as const, 'down'),
      pixels: optionalNumber(args, 'pixels', 1, 100_000),
      ref: args.ref === undefined ? undefined : refOf(args),
    }),
    label: (p) => (p.ref ? `Scrollt zu ${p.ref}` : scrollLabel(p.direction)),
    run: async (ctx, p) => {
      if (p.ref) {
        const box = await target(ctx, p.ref, undefined, (name) => `Scrollt zu ${name}`, null)
        return { text: `Scrolled ${describe(box)} into view.\n\n${await pageState(ctx)}` }
      }
      const metrics = await ctx.page.cdp<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics')
      const { clientWidth: width, clientHeight: height } = metrics.cssLayoutViewport
      const vertical = p.direction === 'up' || p.direction === 'down'
      const distance = p.pixels ?? Math.round((vertical ? height : width) * 0.8)
      const sign = p.direction === 'up' || p.direction === 'left' ? -1 : 1
      await delay(ctx.highlight(scrollLabel(p.direction), null, { x: width / 2, y: height / 2 }))
      await ctx.page.wheel(width / 2, height / 2, vertical ? 0 : sign * distance, vertical ? sign * distance : 0)
      await delay(400)
      const at = await ctx.page.call<{ x: number; y: number; height: number; viewport: number }>('scrollInfo')
      return { text: `Scrolled ${p.direction}; now ${at.y} of ${Math.max(0, at.height - at.viewport)} px down.\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_file_upload',
    title: 'Upload files',
    description: 'Puts local files into a file input (ref), or into the file chooser a click has just opened (no ref).',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the files.' },
      ref: { ...ref, description: 'The file input; leave out after a click opened a file chooser.' },
      element,
    },
    required: ['paths'],
    kind: 'upload',
    parse: (args) => {
      const paths = stringList(args, 'paths', MAX_UPLOAD_FILES)
      for (const path of paths) {
        if (!isAbsolute(path)) throw new ToolError(`Not an absolute path: ${path}`)
        let file = false
        try {
          file = statSync(path).isFile()
        } catch {
          // checked below
        }
        if (!file) throw new ToolError(`No such file: ${path}`)
      }
      return { paths, ref: args.ref === undefined ? undefined : refOf(args), element: optionalString(args, 'element', 200) }
    },
    label: (p) => `Lädt ${p.paths.length === 1 ? '1 Datei' : `${p.paths.length} Dateien`} hoch`,
    run: async (ctx, p) => {
      const names = p.paths.map((path) => path.split(/[\\/]/).pop()).join(', ')
      if (p.ref) {
        if (isFrameRef(p.ref)) throw new ToolError('This file input is inside a frame of another site; click it and use browser_file_upload without ref.')
        const box = await target(ctx, p.ref, p.element, () => `Lädt ${cut(names, 80)} hoch`, 'move')
        const mark = randomUUID()
        const topDocument = await ctx.page.call<boolean>('markFileInput', p.ref, mark)
        try {
          if (!topDocument) throw new ToolError('This file input is inside a frame; click it and use browser_file_upload without ref.')
          const { root } = await ctx.page.cdp<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 })
          const { nodeId } = await ctx.page.cdp<{ nodeId: number }>('DOM.querySelector', {
            nodeId: root.nodeId,
            selector: `[data-claude-manager-upload="${mark}"]`,
          })
          if (!nodeId) throw new ToolError('The file input is gone. Take a new snapshot.')
          await ctx.page.cdp('DOM.setFileInputFiles', { files: p.paths, nodeId })
        } finally {
          await ctx.page.call('unmarkFileInput', mark).catch(() => undefined)
        }
        await ctx.page.settle(ACTION_SETTLE_MS)
        return { text: `Put ${names} into ${describe(box, p.element)}.\n\n${await pageState(ctx)}` }
      }
      const chooser = ctx.fileChooser()
      if (!chooser) throw new ToolError('No file chooser is open. Click the upload button first, or give the ref of the file input.')
      if (!chooser.multiple && p.paths.length > 1) throw new ToolError('This file chooser takes one file only.')
      ctx.highlight(`Lädt ${cut(names, 80)} hoch`)
      await ctx.page.cdp('DOM.setFileInputFiles', { files: p.paths, backendNodeId: chooser.backendNodeId })
      ctx.clearFileChooser()
      await ctx.page.settle(ACTION_SETTLE_MS)
      return { text: `Picked ${names}.\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_handle_dialog',
    title: 'Answer a dialog',
    description:
      'Decides how the next dialog of the page (confirm, prompt) is answered, before the action that opens it; or answers a dialog that blocks the page now.',
    properties: {
      accept: { type: 'boolean', description: 'OK (true) or Cancel (false).' },
      promptText: { type: 'string', description: 'The answer to a prompt.' },
    },
    required: ['accept'],
    kind: 'dialog',
    whileDialog: true,
    parse: (args) => {
      const accept = optionalBoolean(args, 'accept')
      if (accept === undefined) throw new ToolError('accept is required.')
      return { accept, promptText: optionalString(args, 'promptText', 10_000) }
    },
    label: ({ accept }) => (accept ? 'Bestätigt den Dialog' : 'Bricht den Dialog ab'),
    run: async (ctx, p) => {
      const dialog = ctx.dialog()
      if (!dialog) {
        ctx.setDialogAnswer({ accept: p.accept, promptText: p.promptText ?? null })
        ctx.label(p.accept ? 'Bestätigt den nächsten Dialog' : 'Bricht den nächsten Dialog ab')
        const answer = p.accept ? (p.promptText !== undefined ? `OK with ${JSON.stringify(p.promptText)}` : 'OK') : 'Cancel'
        return { text: `The next dialog the page opens will be answered with ${answer}.` }
      }
      ctx.note(cut(dialog.message, 120))
      await ctx.page.cdp('Page.handleJavaScriptDialog', { accept: p.accept, ...(p.promptText !== undefined ? { promptText: p.promptText } : {}) })
      await ctx.page.settle(ACTION_SETTLE_MS)
      return { text: `${p.accept ? 'Accepted' : 'Dismissed'} the ${dialog.type} dialog.\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_drag',
    title: 'Drag and drop',
    description: 'Drags an element with the mouse and drops it on another one: drag and drop, sorting a list, moving a card to another column.',
    properties: {
      startRef: { ...ref, description: 'The element to drag, from the latest snapshot.' },
      startElement: { ...element, description: 'A short description of it, for the user watching.' },
      endRef: { ...ref, description: 'The element to drop it on.' },
      endElement: { ...element, description: 'A short description of the target, for the user watching.' },
    },
    required: ['startRef', 'endRef'],
    kind: 'drag',
    parse: (args) => ({
      startRef: refOf(args, 'startRef'),
      startElement: optionalString(args, 'startElement', 200),
      endRef: refOf(args, 'endRef'),
      endElement: optionalString(args, 'endElement', 200),
    }),
    label: (p) => `Zieht ${p.startElement ? quote(p.startElement) : p.startRef} auf ${p.endElement ? quote(p.endElement) : p.endRef}`,
    run: async (ctx, p) => {
      const pair = await ctx.page.locatePair(p.startRef, p.endRef)
      if (!pair.together) {
        throw new ToolError('The element and the target are not in view together. Scroll so that both are visible, or drag in steps.')
      }
      const text = `Zieht ${targetName(pair.from, p.startElement)} auf ${targetName(pair.to, p.endElement)}`
      ctx.label(text)
      const start = center(pair.from)
      const end = center(pair.to)
      await delay(Math.max(SHOW_MS, ctx.highlight(text, pair.from, start) + CLICK_AFTER_MOVE_MS))
      // The pointer glides to the target while the drag runs, in the same time.
      const glide = ctx.highlight(text, pair.to, end)
      const dragged = { kind: 'pointer' as 'drop' | 'pointer' }
      await untilBlocked(ctx, async () => {
        dragged.kind = await ctx.page.drag(start, end, Math.max(MIN_DRAG_MS, glide))
        await ctx.page.settle(ACTION_SETTLE_MS)
      })
      const how = dragged.kind === 'drop' ? ' (drag and drop of the page)' : ''
      return { text: `Dragged ${describe(pair.from, p.startElement)} onto ${describe(pair.to, p.endElement)}${how}.\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_fill_form',
    title: 'Fill in a form',
    description:
      'Fills several fields at once, in the given order: text fields, checkboxes, radio buttons, selects (combobox) and sliders. One call instead of one per field.',
    properties: {
      fields: {
        type: 'array',
        description: 'The fields to fill.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'A short name of the field, for the user watching (e.g. "Email").' },
            type: { type: 'string', enum: [...FIELD_TYPES], description: 'The kind of field.' },
            ref,
            value: {
              type: 'string',
              description:
                'The text for a textbox; "true" or "false" for a checkbox; "true" for the radio button to select; the option (value or text) for a combobox; the number for a slider.',
            },
          },
          required: ['name', 'type', 'ref', 'value'],
          additionalProperties: false,
        },
      },
    },
    required: ['fields'],
    kind: 'form',
    parse: (args) => ({ fields: formFields(args) }),
    label: ({ fields }) => formLabel(fields.length),
    run: async (ctx, { fields }) => {
      const done: string[] = []
      for (const field of fields) {
        try {
          done.push(await fillField(ctx, field))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const before = done.length ? `Filled ${done.length} of ${fields.length} fields:\n${done.map((line) => `- ${line}`).join('\n')}\n` : ''
          throw new ToolError(`${before}The field "${field.name}" (${field.ref}) failed: ${message}`)
        }
        // A dialog or a login holds the page up; the rest would go nowhere.
        if (ctx.dialog() || ctx.login()) break
      }
      ctx.label(formLabel(fields.length))
      ctx.note(`${done.length} von ${fields.length} Feldern`)
      await ctx.page.settle(300)
      const rest = done.length < fields.length ? `\nStopped after ${done.length} of ${fields.length} fields.` : ''
      return { text: `Filled ${done.length} field(s):\n${done.map((line) => `- ${line}`).join('\n')}${rest}\n\n${await pageState(ctx)}` }
    },
  }),
]

function describe(box: ElementBox, element?: string): string {
  const name = element?.trim() || box.name
  return name ? `${box.role} "${name}"` : box.role
}

function scrollLabel(direction: 'up' | 'down' | 'left' | 'right'): string {
  return `Scrollt nach ${({ up: 'oben', down: 'unten', left: 'links', right: 'rechts' } as const)[direction]}`
}

function formLabel(count: number): string {
  return `Füllt ${count === 1 ? '1 Feld' : `${count} Felder`} aus`
}

/** "true", "yes", "on", "checked" … for a checkbox or radio button. */
function truthy(value: string): boolean {
  return /^(true|1|yes|on|checked|ja|x)$/i.test(value.trim())
}

/** Fills one field of browser_fill_form, shown like the single tools do; returns the line for the result. */
async function fillField(ctx: ActionContext, field: FormField): Promise<string> {
  const state = await ctx.page.callAt<{ role: string; checked: boolean | null; select: boolean; range: boolean }>(field.ref, 'fieldState')
  switch (field.type) {
    case 'textbox': {
      const box = await target(ctx, field.ref, field.name, (name) => `Tippt in ${name}`, 'click')
      const { x, y } = center(box)
      const typing = { kind: 'field' }
      await untilBlocked(ctx, async () => {
        await ctx.page.click(x, y)
        typing.kind = await ctx.page.callAt<string>(field.ref, 'prepareTyping', true)
        if (typing.kind === 'other') return
        if (field.value) await ctx.page.insertText(field.value)
        else await ctx.page.press('Delete')
      })
      if (typing.kind === 'other') throw new ToolError('it is no text field (clicked it, typed nothing)')
      return `${field.name}: ${box.secret ? 'password typed' : `typed ${JSON.stringify(cut(field.value, 80))}`}`
    }
    case 'checkbox':
    case 'radio': {
      if (state.checked === null) throw new ToolError(`it is no ${field.type}`)
      const wanted = truthy(field.value)
      if (state.checked === wanted) {
        await target(ctx, field.ref, field.name, (name) => `${name} ist schon ${wanted ? 'an' : 'aus'}`, 'move')
        return `${field.name}: already ${wanted ? 'checked' : 'unchecked'}`
      }
      if (field.type === 'radio' && !wanted) throw new ToolError('a radio button goes off by selecting another one of its group')
      const verb = field.type === 'radio' ? (name: string) => `Wählt ${name}` : (name: string) => (wanted ? `Hakt ${name} an` : `Nimmt den Haken bei ${name} weg`)
      const box = await target(ctx, field.ref, field.name, verb, 'click')
      const { x, y } = center(box)
      await untilBlocked(ctx, () => ctx.page.click(x, y))
      if (ctx.dialog() || ctx.login()) return `${field.name}: clicked`
      const after = await ctx.page.callAt<{ checked: boolean | null }>(field.ref, 'fieldState').catch(() => null)
      if (after && after.checked !== wanted) throw new ToolError(`clicked it, but it is still ${after.checked ? 'checked' : 'unchecked'}`)
      return `${field.name}: ${wanted ? 'checked' : 'unchecked'}`
    }
    case 'combobox': {
      if (!state.select) throw new ToolError('it is no <select>; click it and then the option with browser_click')
      await target(ctx, field.ref, field.name, (name) => `Wählt ${quote(cut(field.value, 40))} in ${name}`, 'move')
      const chosen = await ctx.page.callAt<string[]>(field.ref, 'selectOptions', [field.value])
      return `${field.name}: selected ${JSON.stringify(chosen[0])}`
    }
    case 'slider': {
      if (!state.range) throw new ToolError('it is no range input; press the arrow keys on it with browser_press_key')
      await target(ctx, field.ref, field.name, (name) => `Stellt ${name} auf ${cut(field.value, 20)}`, 'move')
      const value = await ctx.page.callAt<string>(field.ref, 'setSliderValue', field.value)
      return `${field.name}: set to ${value}`
    }
  }
}

function formFields(args: Args): FormField[] {
  const value = args.fields
  if (!Array.isArray(value) || value.length === 0) throw new ToolError('fields must be a non-empty list.')
  if (value.length > MAX_FORM_FIELDS) throw new ToolError(`fields takes at most ${MAX_FORM_FIELDS} entries.`)
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new ToolError(`fields[${index}] must be an object.`)
    const field = item as Args
    try {
      return {
        name: requiredString(field, 'name', 200),
        type: oneOf(field, 'type', FIELD_TYPES),
        ref: refOf(field),
        value: requiredString(field, 'value', 100_000, true),
      }
    } catch (error) {
      throw new ToolError(`fields[${index}]: ${(error as Error).message}`)
    }
  })
}

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

function modifierBits(args: Args): number {
  const value = args.modifiers
  if (value === undefined || value === null) return 0
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !(item in MODIFIER_BITS))) {
    throw new ToolError('modifiers must be a list of Alt, Control, Meta and Shift.')
  }
  return (value as string[]).reduce((bits, name) => bits | MODIFIER_BITS[name], 0)
}
