/**
 * Scripts the app runs in a page Claude drives, in a script world of their own: the page can't see
 * or change them, and they keep the element refs of the last snapshot until the page navigates.
 * Each call starts with INSTALL and returns `{ ok }` or `{ error }`, since an exception would only
 * arrive as "Script failed to execute".
 */

/** The world the scripts run in; Electron's own preloads use 999. */
export const SCRIPT_WORLD = 1077

/** Characters of a snapshot before it is cut, roughly 10 000 tokens. */
export const MAX_SNAPSHOT_CHARS = 40_000

const INSTALL = String.raw`
if (!globalThis.__cm) (() => {
  const MAX_TEXT = 300
  const MAX_NAME = 120
  const refs = new Map()
  const ids = new WeakMap()
  let next = 1

  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
  const cut = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s)
  const quote = (s) => JSON.stringify(s)

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BR', 'WBR'])
  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button', color: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
  }
  const TAG_ROLES = {
    BUTTON: 'button', TEXTAREA: 'textbox', SUMMARY: 'button', OPTION: 'option',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    UL: 'list', OL: 'list', MENU: 'list', LI: 'listitem', NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary',
    FORM: 'form', DIALOG: 'dialog', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader',
    P: 'paragraph', IFRAME: 'iframe', HEADER: 'banner', FOOTER: 'contentinfo', ARTICLE: 'article',
    FIGURE: 'figure', FIELDSET: 'group', DETAILS: 'group', PROGRESS: 'progressbar', BLOCKQUOTE: 'blockquote',
  }
  const INTERACTIVE = new Set([
    'link', 'button', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'slider',
    'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
  ])
  /** Interactive roles whose children are worth listing too. */
  const INTERACTIVE_CONTAINERS = new Set(['listbox', 'combobox', 'tab', 'treeitem'])
  const NAME_FROM_CONTENT = new Set([
    'link', 'button', 'heading', 'tab', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
    'cell', 'columnheader', 'checkbox', 'radio', 'switch', 'clickable', 'draggable',
  ])
  /** Roles that become one line of text when nothing in them can be used. */
  const COLLAPSE = new Set(['paragraph', 'listitem', 'cell', 'columnheader', 'blockquote', 'figure', 'article', 'group', 'alert', 'status'])

  let styles = new WeakMap()
  const styleOf = (el) => {
    let style = styles.get(el)
    if (!style) styles.set(el, (style = el.ownerDocument.defaultView.getComputedStyle(el)))
    return style
  }

  function roleOf(el) {
    const explicit = clean(el.getAttribute('role')).split(' ')[0].toLowerCase()
    if (explicit === 'presentation' || explicit === 'none') return null
    if (explicit) return explicit
    const tag = el.tagName
    if (tag === 'A' || tag === 'AREA') return el.hasAttribute('href') ? 'link' : null
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      return type === 'hidden' ? null : INPUT_ROLES[type] || 'textbox'
    }
    if (tag === 'SELECT') return el.multiple || el.size > 1 ? 'listbox' : 'combobox'
    if (tag === 'IMG') return el.getAttribute('alt') === '' ? null : 'img'
    if (tag === 'SECTION') return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null
    if (tag.toLowerCase() === 'svg') return el.getAttribute('aria-label') || el.querySelector('title') ? 'img' : null
    if (TAG_ROLES[tag]) return TAG_ROLES[tag]
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox'
    return null
  }

  /** Cursors that say an element can be clicked or dragged. */
  const HOT_CURSORS = new Set(['pointer', 'grab', 'move'])

  function interactive(el, role) {
    if (INTERACTIVE.has(role)) return true
    if (draggable(el)) return true
    if (role) return false
    const tabindex = el.getAttribute('tabindex')
    if (tabindex !== null && Number(tabindex) >= 0) return true
    if (el.hasAttribute('onclick')) return true
    // Clickable or draggable by its look: the cursor starts here, not at a parent it inherits it from.
    const parent = el.parentElement
    const cursor = styleOf(el).cursor
    return HOT_CURSORS.has(cursor) && (!parent || styleOf(parent).cursor !== cursor)
  }

  /** An element the page lets the mouse drag (HTML drag and drop); links and images are by default. */
  function draggable(el) {
    return el.getAttribute('draggable') === 'true'
  }

  function labelledBy(el) {
    const list = el.getAttribute('aria-labelledby')
    if (!list) return ''
    return clean(list.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)).filter(Boolean).map((n) => n.innerText || n.textContent).join(' '))
  }

  function nameOf(el, role) {
    const aria = clean(el.getAttribute('aria-label'))
    if (aria) return aria
    const by = labelledBy(el)
    if (by) return by
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const type = (el.type || '').toLowerCase()
      if (type === 'button' || type === 'submit' || type === 'reset') return clean(el.value) || (type === 'submit' ? 'Submit' : '')
      if (type === 'image') return clean(el.alt)
      const label = el.labels ? [...el.labels].map((l) => clean(l.innerText)).filter(Boolean).join(' ') : ''
      return label || clean(el.getAttribute('placeholder')) || clean(el.title) || (type === 'file' ? 'Choose file' : '')
    }
    if (tag === 'IMG' || tag === 'AREA') return clean(el.alt) || clean(el.title)
    if (tag.toLowerCase() === 'svg') return clean(el.querySelector('title')?.textContent)
    if (NAME_FROM_CONTENT.has(role)) {
      const text = clean(el.innerText ?? el.textContent)
      if (text) return text
      const icon = el.querySelector('img[alt], [aria-label], svg title')
      if (icon) return clean(icon.getAttribute?.('aria-label') || icon.alt || icon.textContent)
    }
    return clean(el.title)
  }

  function valueOf(el, role) {
    const tag = el.tagName
    if (tag === 'SELECT') return [...el.selectedOptions].map((o) => clean(o.text)).join(', ')
    if (tag === 'INPUT') {
      const type = (el.type || '').toLowerCase()
      if (type === 'password') return el.value ? '•'.repeat(Math.min(el.value.length, 8)) : ''
      if (type === 'file') return [...(el.files || [])].map((f) => f.name).join(', ')
      if (['checkbox', 'radio', 'button', 'submit', 'reset', 'image'].includes(type)) return ''
      return el.value
    }
    if (tag === 'TEXTAREA') return el.value
    if (role === 'textbox' && el.isContentEditable) return clean(el.innerText)
    if (role === 'combobox' || role === 'slider' || role === 'spinbutton' || role === 'progressbar') {
      return clean(el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow') || (tag === 'PROGRESS' ? el.value : ''))
    }
    return ''
  }

  function states(el, role) {
    const out = []
    if (role === 'heading') out.push('level=' + (Number(el.tagName[1]) || el.getAttribute('aria-level') || 2))
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled')
    if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
      const checked = typeof el.checked === 'boolean' ? el.checked : el.getAttribute('aria-checked') === 'true'
      out.push(checked ? 'checked' : 'unchecked')
    }
    const expanded = el.getAttribute('aria-expanded')
    if (expanded === 'true' || expanded === 'false') out.push(expanded === 'true' ? 'expanded' : 'collapsed')
    if (el.getAttribute('aria-selected') === 'true' || (el.tagName === 'OPTION' && el.selected)) out.push('selected')
    if (el.required || el.getAttribute('aria-required') === 'true') out.push('required')
    if (el === el.ownerDocument.activeElement && el !== el.ownerDocument.body) out.push('focused')
    return out
  }

  function refOf(el) {
    let id = ids.get(el)
    if (!id) ids.set(el, (id = 'e' + next++))
    refs.set(id, new WeakRef(el))
    return id
  }

  function shortUrl(href) {
    try {
      const url = new URL(href)
      return url.origin === location.origin ? url.pathname + url.search + url.hash : url.href
    } catch {
      return href
    }
  }

  /** One line of the snapshot: hot elements show their value; those withRef (all hot ones) get a ref. */
  function describe(el, role, hot, withRef = hot) {
    const name = cut(nameOf(el, role || 'clickable'), MAX_NAME)
    let line = role || 'clickable'
    if (name) line += ' ' + quote(name)
    if (withRef) line += ' [ref=' + refOf(el) + ']'
    for (const state of states(el, role)) line += ' [' + state + ']'
    const value = hot ? valueOf(el, role) : ''
    if (value) line += ': ' + quote(cut(value, MAX_TEXT))
    if (role === 'link') {
      const href = el.getAttribute('href')
      if (href && !/^javascript:/i.test(href) && href !== '#') line += ' → ' + cut(shortUrl(el.href), 120)
    }
    if (el.tagName === 'SELECT') {
      const options = [...el.options].slice(0, 25).map((o) => quote(cut(clean(o.text), 60)))
      line += ' options: [' + options.join(', ') + (el.options.length > 25 ? ', …' : '') + ']'
    }
    return line
  }

  function visible(el) {
    if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })
    return styleOf(el).display !== 'none'
  }

  function childNodesOf(el) {
    if (el.shadowRoot) return el.shadowRoot.childNodes
    if (el.tagName === 'SLOT') {
      const assigned = el.assignedNodes({ flatten: true })
      if (assigned.length) return assigned
    }
    return el.childNodes
  }

  const EMPTY = { items: [] }
  const textItem = (text) => ({ text, children: [], hot: false })

  function visitChildren(parent) {
    const items = []
    let pending = ''
    const flush = () => {
      const text = clean(pending)
      if (text) items.push(textItem('text: ' + cut(text, MAX_TEXT)))
      pending = ''
    }
    for (const node of childNodesOf(parent)) {
      if (node.nodeType === 3) {
        pending += ' ' + node.data
        continue
      }
      if (node.nodeType !== 1) continue
      const result = visit(node)
      if (result.inline !== undefined) {
        pending += ' ' + result.inline
        continue
      }
      if (result.items.length) {
        flush()
        items.push(...result.items)
      }
    }
    flush()
    return items
  }

  function visitFrame(el) {
    const title = clean(el.title || el.name)
    let doc = null
    try {
      doc = el.contentDocument
    } catch {}
    if (!doc?.body) return { items: [textItem('iframe' + (title ? ' ' + quote(title) : '') + ' (other origin, not readable)')] }
    return { items: [{ text: 'iframe' + (title ? ' ' + quote(title) : ''), children: visitChildren(doc.body), hot: false }] }
  }

  function visit(el) {
    if (SKIP.has(el.tagName)) return EMPTY
    if (el.getAttribute('aria-hidden') === 'true' || el.inert) return EMPTY
    if (!visible(el)) return EMPTY
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') return visitFrame(el)
    const role = roleOf(el)
    if (interactive(el, role)) {
      const shown = role || (draggable(el) ? 'draggable' : null)
      const item = { text: describe(el, shown, true), children: [], hot: true }
      if (INTERACTIVE_CONTAINERS.has(shown) || !NAME_FROM_CONTENT.has(shown || 'clickable')) {
        if (el.tagName !== 'SELECT') item.children = visitChildren(el)
      } else {
        // A clickable card may hold links and buttons of its own.
        const children = visitChildren(el)
        if (children.some((c) => c.hot)) item.children = children
      }
      return { items: [item] }
    }
    const children = visitChildren(el)
    const hot = children.some((c) => c.hot)
    if (role === 'img') {
      const name = cut(nameOf(el, role), MAX_NAME)
      return name ? { items: [textItem('img ' + quote(name))] } : EMPTY
    }
    // Parts of the page with a role get a ref as well: targets to drop on, to scroll to or to photograph.
    if (role === 'heading' && !hot) return { items: [textItem(describe(el, role, false, true))] }
    if (role === 'row' && !hot) {
      const cells = [...el.children].map((c) => clean(c.innerText)).filter(Boolean)
      return cells.length ? { items: [textItem('row [ref=' + refOf(el) + ']: ' + cut(cells.join(' | '), MAX_TEXT))] } : EMPTY
    }
    if (role && COLLAPSE.has(role) && !hot) {
      const text = clean(el.innerText)
      return text ? { items: [textItem(role + ' [ref=' + refOf(el) + ']: ' + cut(text, MAX_TEXT))] } : EMPTY
    }
    if (role) return children.length || role === 'dialog' ? { items: [{ text: describe(el, role, false, true), children, hot }] } : EMPTY
    // A plain element: inline text joins the text around it, anything else passes its children on.
    if (!hot && children.every((c) => c.text.startsWith('text: ')) && styleOf(el).display === 'inline') {
      return { inline: children.map((c) => c.text.slice(6)).join(' ') }
    }
    return { items: children }
  }

  function element(ref) {
    const el = refs.get(ref)?.deref()
    if (!el || !el.isConnected) throw new Error('Element ' + ref + ' is gone. Take a new browser_snapshot: refs change with the page.')
    return el
  }

  /** The box of an element in the viewport of the page, frames included. */
  function box(el) {
    const r = el.getBoundingClientRect()
    let x = r.left
    let y = r.top
    let win = el.ownerDocument.defaultView
    while (win && win.frameElement) {
      const frame = win.frameElement
      const fr = frame.getBoundingClientRect()
      const fs = win.parent.getComputedStyle(frame)
      x += fr.left + parseFloat(fs.borderLeftWidth) + parseFloat(fs.paddingLeft)
      y += fr.top + parseFloat(fs.borderTopWidth) + parseFloat(fs.paddingTop)
      win = win.parent
    }
    return { x, y, width: r.width, height: r.height }
  }

  function short(el) {
    let text = el.tagName.toLowerCase()
    if (el.id) text += '#' + el.id
    const cls = clean(typeof el.className === 'string' ? el.className : '').split(' ').filter(Boolean).slice(0, 2)
    if (cls.length) text += '.' + cls.join('.')
    return text
  }

  globalThis.__cm = {
    snapshot(max) {
      styles = new WeakMap()
      const lines = []
      let size = 0
      let full = false
      const add = (line) => {
        if (full) return
        if (size + line.length > max) {
          full = true
          return
        }
        lines.push(line)
        size += line.length + 1
      }
      const render = (items, depth) => {
        for (const item of items) {
          if (full) return
          add('  '.repeat(depth) + '- ' + item.text)
          render(item.children, depth + 1)
        }
      }
      const root = document.body || document.documentElement
      const items = root ? visitChildren(root) : []
      const doc = document.scrollingElement || document.documentElement
      add('- Page URL: ' + location.href)
      add('- Page title: ' + clean(document.title))
      add('- Scroll: ' + Math.round(scrollY) + ' of ' + Math.max(0, Math.round(doc.scrollHeight - innerHeight)) + ' px down (viewport ' + innerWidth + '×' + innerHeight + ')')
      if (document.activeElement && document.activeElement !== document.body && !ids.has(document.activeElement)) {
        // Focus inside something without a ref (e.g. an editor) is still worth knowing.
        add('- Focused: ' + short(document.activeElement))
      }
      render(items, 0)
      if (full) lines.push('- … (cut: the page is longer; scroll or use browser_evaluate to read more)')
      return lines.join('\n')
    },
    /** Scrolls the element into view and returns where it is, for the mouse. */
    locate(ref) {
      let el = element(ref)
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      let b = box(el)
      // A box-less control (e.g. a hidden checkbox styled by its label) is reached through its label.
      if ((b.width === 0 || b.height === 0) && el.labels?.length) {
        el = el.labels[0]
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
        b = box(el)
      }
      const role = roleOf(el)
      const cx = b.x + b.width / 2
      const cy = b.y + b.height / 2
      const hit = document.elementFromPoint(cx, cy)
      let covered = null
      if (hit && el.ownerDocument === document && hit !== el && !el.contains(hit) && !hit.contains(el)) covered = short(hit)
      const secret = el.tagName === 'INPUT' && el.type === 'password'
      return { ...b, role: role || 'element', name: cut(nameOf(el, role || 'clickable'), MAX_NAME), covered, secret }
    },
    /** Puts the caret into a text field, selecting what is there when it is to be replaced. */
    prepareTyping(ref, replace) {
      const el = element(ref)
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        el.focus()
        if (replace) el.select()
        else {
          try {
            el.setSelectionRange(el.value.length, el.value.length)
          } catch {}
        }
        return 'field'
      }
      if (el.isContentEditable) {
        el.focus()
        const range = document.createRange()
        range.selectNodeContents(el)
        if (!replace) range.collapse(false)
        const selection = getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        return 'editor'
      }
      return 'other'
    },
    selectOptions(ref, values) {
      const el = element(ref)
      if (el.tagName !== 'SELECT') throw new Error('Element ' + ref + ' is no <select>. Click it and then the option instead.')
      const wanted = values.map((v) => clean(v).toLowerCase())
      const matches = [...el.options].filter((o) => wanted.includes(clean(o.value).toLowerCase()) || wanted.includes(clean(o.text).toLowerCase()))
      if (matches.length === 0) throw new Error('No option matches ' + JSON.stringify(values) + '.')
      if (!el.multiple && matches.length > 1) matches.length = 1
      for (const option of el.options) option.selected = matches.includes(option)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return matches.map((o) => clean(o.text))
    },
    /** Marks a file input, so the protocol can find it (see browser_file_upload). */
    markFileInput(ref, mark) {
      const el = element(ref)
      if (el.tagName !== 'INPUT' || el.type !== 'file') throw new Error('Element ' + ref + ' is no file input.')
      el.setAttribute('data-claude-manager-upload', mark)
      return el.ownerDocument === document
    },
    unmarkFileInput(mark) {
      document.querySelector('[data-claude-manager-upload="' + mark + '"]')?.removeAttribute('data-claude-manager-upload')
    },
    /** What kind of field browser_fill_form fills, and whether a checkbox or radio button is checked. */
    fieldState(ref) {
      const el = element(ref)
      const tag = el.tagName
      const type = (el.type || '').toLowerCase()
      const role = roleOf(el) || ''
      let checked = null
      if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) checked = el.checked
      else if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)) checked = el.getAttribute('aria-checked') === 'true'
      return { role, checked, select: tag === 'SELECT', range: tag === 'INPUT' && type === 'range' }
    },
    /** Moves a range input to a value as dragging its knob would (input and change events). */
    setSliderValue(ref, value) {
      const el = element(ref)
      if (el.tagName !== 'INPUT' || el.type !== 'range') throw new Error('Element ' + ref + ' is no range input; press the arrow keys on it (browser_press_key) instead.')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(value))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return el.value
    },
    /**
     * For a drag: scrolls the element to drag into view and, when the target isn't visible with it,
     * the target too. Returns both boxes and whether both are in view now.
     */
    locatePair(fromRef, toRef) {
      const from = element(fromRef)
      const to = element(toRef)
      const inView = (el) => {
        const r = box(el)
        const x = r.x + r.width / 2
        const y = r.y + r.height / 2
        return x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight
      }
      from.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      if (!inView(to)) to.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
      const describe = (el) => {
        const role = roleOf(el)
        return { ...box(el), role: role || 'element', name: cut(nameOf(el, role || 'clickable'), MAX_NAME), covered: null, secret: false }
      }
      return { from: describe(from), to: describe(to), together: inView(from) && inView(to) }
    },
    hasText(text) {
      return (document.body?.innerText || '').includes(text)
    },
    scrollInfo() {
      const doc = document.scrollingElement || document.documentElement
      return { x: Math.round(scrollX), y: Math.round(scrollY), height: doc.scrollHeight, viewport: innerHeight }
    },
  }
})()
`

/** A call of one of the helpers above, e.g. `pageCall('locate', 'e3')`. */
export function pageCall(name: string, ...args: unknown[]): string {
  const call = `globalThis.__cm.${name}(${args.map((arg) => JSON.stringify(arg)).join(', ')})`
  return `${INSTALL}
;(() => {
  try {
    return { ok: ${call} }
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) }
  }
})()`
}
