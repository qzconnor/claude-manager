import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, type NativeImage } from 'electron'
import { uniqueFileName } from '../../window/browser-policy'
import { delay, withTimeout } from '../page-driver'
import { cut, optionalBoolean, optionalNumber, optionalString, requiredString, ToolError } from '../tool-args'
import { element, pageState, quote, ref, refOf, tool, type ToolDefinition, untilBlocked } from './tool'

/** Tools that read the page: its outline, a screenshot, a script's result, a PDF, waiting for it. */

const MAX_WAIT_SECONDS = 30
const MAX_EVALUATE_CHARS = 20_000

const PDF_WAIT_MS = 60_000

export const readingTools: ToolDefinition<never>[] = [
  tool({
    name: 'browser_snapshot',
    title: 'Read the page',
    description: 'An outline of the page with refs for the elements you can act on. Better than a screenshot for reading and acting.',
    properties: {},
    readOnly: true,
    kind: 'snapshot',
    parse: () => ({}),
    label: () => 'Liest die Seite',
    run: async (ctx) => ({ text: await pageState(ctx, false) }),
  }),
  tool({
    name: 'browser_wait_for',
    title: 'Wait',
    description: `Waits until a text appears or disappears on the page, or for a number of seconds (at most ${MAX_WAIT_SECONDS}).`,
    properties: {
      text: { type: 'string', description: 'Wait until this text is on the page.' },
      textGone: { type: 'string', description: 'Wait until this text is gone.' },
      seconds: { type: 'number', description: 'How long to wait, or the most to wait for the text (default 10).' },
    },
    readOnly: true,
    kind: 'wait',
    parse: (args) => {
      const p = {
        text: optionalString(args, 'text', 500),
        textGone: optionalString(args, 'textGone', 500),
        seconds: optionalNumber(args, 'seconds', 0, MAX_WAIT_SECONDS),
      }
      if (!p.text && !p.textGone && p.seconds === undefined) throw new ToolError('Give text, textGone or seconds.')
      return p
    },
    label: (p) => (p.text ? `Wartet auf ${quote(cut(p.text, 60))}` : p.textGone ? `Wartet, bis ${quote(cut(p.textGone, 60))} weg ist` : `Wartet ${p.seconds} s`),
    run: async (ctx, p) => {
      if (!p.text && !p.textGone) {
        await delay((p.seconds ?? 0) * 1000)
        return { text: `Waited ${p.seconds} s.\n\n${await pageState(ctx)}` }
      }
      const until = Date.now() + (p.seconds ?? 10) * 1000
      for (;;) {
        const shown = p.text ? await ctx.page.hasText(p.text) : true
        const gone = p.textGone ? !(await ctx.page.hasText(p.textGone)) : true
        if (shown && gone) break
        if (Date.now() > until) {
          throw new ToolError(`Timed out: ${p.text && !shown ? `"${p.text}" did not appear` : `"${p.textGone}" did not go away`}.`)
        }
        await delay(250)
      }
      return { text: `${p.text ? `"${p.text}" is on the page` : `"${p.textGone}" is gone`}.\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_take_screenshot',
    title: 'Take a screenshot',
    description: 'A picture of the visible part of the page, of the whole page (fullPage), or of one element (ref).',
    properties: {
      fullPage: { type: 'boolean', description: 'The whole page instead of the visible part.' },
      ref: { ...ref, description: 'Only this element.' },
      element,
    },
    readOnly: true,
    kind: 'screenshot',
    whileDialog: true,
    parse: (args) => ({
      fullPage: optionalBoolean(args, 'fullPage') ?? false,
      ref: args.ref === undefined ? undefined : refOf(args),
      element: optionalString(args, 'element', 200),
    }),
    label: (p) => (p.ref ? `Fotografiert ${p.element ? quote(p.element) : p.ref}` : p.fullPage ? 'Fotografiert die ganze Seite' : 'Macht einen Screenshot'),
    run: async (ctx, p) => {
      let image: NativeImage
      let note = ''
      if (p.ref) {
        const box = await ctx.page.locate(p.ref)
        ctx.label(`Fotografiert ${quote(p.element || box.name || box.role)}`)
        image = await ctx.page.capture(box)
      } else if (p.fullPage) {
        const shot = await ctx.page.captureFullPage()
        image = shot.image
        if (shot.cut) note = ' The page is longer: the picture ends after 8000 px.'
      } else {
        image = await ctx.page.capture()
      }
      ctx.image(image)
      const { width, height } = image.getSize()
      return { text: `Screenshot (${width}×${height}).${note}`, image }
    },
  }),
  tool({
    name: 'browser_evaluate',
    title: 'Run JavaScript',
    description: 'Runs JavaScript in the page and returns the result as JSON: a function like "() => document.title" or an expression. Promises are awaited.',
    properties: { function: { type: 'string', description: 'The function or expression.' } },
    required: ['function'],
    kind: 'evaluate',
    parse: (args) => ({ code: requiredString(args, 'function', 100_000) }),
    label: () => 'Führt ein Skript aus',
    run: async (ctx, { code }) => {
      ctx.highlight('Führt ein Skript aus')
      const expression = `(async () => { const __value = (${code}\n); return typeof __value === 'function' ? await __value() : await __value })()`
      type Evaluation = {
        result: { type: string; value?: unknown; description?: string; unserializableValue?: string }
        exceptionDetails?: { text: string; exception?: { description?: string } }
      }
      let evaluation: Evaluation | undefined
      await untilBlocked(ctx, async () => {
        evaluation = await withTimeout(
          ctx.page.cdp<Evaluation>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }),
          30_000,
          'The script did not finish within 30 s.',
        )
      })
      if (!evaluation) return { text: `The script opened a dialog.\n\n${await pageState(ctx)}` }
      if (evaluation.exceptionDetails) {
        throw new ToolError(`The script failed: ${evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text}`)
      }
      const { result } = evaluation
      const value =
        result.type === 'undefined'
          ? 'undefined'
          : result.unserializableValue ?? (result.value !== undefined ? JSON.stringify(result.value, null, 2) : result.description ?? String(result.value))
      return { text: cut(value, MAX_EVALUATE_CHARS) }
    },
  }),
  tool({
    name: 'browser_pdf_save',
    title: 'Save as PDF',
    description:
      "Saves the page as a PDF file, as it would print (with backgrounds), into the user's downloads folder and returns its path. Read it with your file tools.",
    properties: { filename: { type: 'string', description: 'The file name, e.g. "invoice.pdf"; default: from the page title. An existing file is never replaced.' } },
    kind: 'pdf',
    parse: (args) => ({ filename: optionalString(args, 'filename', 200) }),
    label: () => 'Speichert die Seite als PDF',
    run: async (ctx, { filename }) => {
      ctx.highlight('Speichert die Seite als PDF')
      const data = await withTimeout(ctx.page.contents.printToPDF({ printBackground: true }), PDF_WAIT_MS, 'The PDF was not ready within 60 s.')
      const folder = app.getPath('downloads')
      await mkdir(folder, { recursive: true })
      const name = uniqueFileName(pdfName(filename ?? ctx.page.contents.getTitle()), (candidate) => existsSync(join(folder, candidate)))
      const path = join(folder, name)
      await writeFile(path, data, { flag: 'wx' })
      ctx.note(path)
      return { text: `Saved the page as PDF (${Math.max(1, Math.round(data.length / 1024))} KB): ${path}` }
    },
  }),
]

/** A file name for a PDF of the page: what Claude named it, else the page's title. */
function pdfName(name: string): string {
  const base = name.replace(/\.pdf$/i, '').replace(/\s+/g, ' ').trim() || 'Seite'
  return `${base.slice(0, 120)}.pdf`
}
