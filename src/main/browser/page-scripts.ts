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

/**
 * Stands in a snapshot where a frame of another site is (as a child line of its iframe, followed by
 * the iframe's ref): its document is out of the script's reach, the page driver reads it through the
 * DevTools protocol and puts it in that place (see frames.ts).
 */
export const FRAME_MARK = '⁣frame:'

const INSTALL = String.raw`
if (!globalThis.__cm) (() => {
  const MAX_TEXT = 300
  const MAX_NAME = 120
  const refs = new Map()
  const ids = new WeakMap()
  let next = 1
  /** This document: a snapshot of another one (after a navigation) can't be compared with the last. */
  const doc = Math.random().toString(36).slice(2)
  /** Frames marked for the DevTools protocol (markFrames), until unmarkFrames. */
  let marked = []
  const FRAME_MARK = ${JSON.stringify(FRAME_MARK)}

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
    const title = clean(el.title || el.name || el.getAttribute('aria-label'))
    let inner = null
    try {
      inner = el.contentDocument
    } catch {}
    if (inner?.body) return { items: [{ text: 'iframe' + (title ? ' ' + quote(title) : ''), children: visitChildren(inner.body), hot: false }] }
    // A frame of another site (or one still loading): the page driver fills in its content.
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return EMPTY
    const ref = refOf(el)
    return { items: [{ text: 'iframe' + (title ? ' ' + quote(title) : '') + ' [ref=' + ref + ']', children: [textItem(FRAME_MARK + ref)], hot: false }] }
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

  /** The box of a frame's document in the viewport: inside its border and padding. */
  function frameContentBox(el) {
    const b = box(el)
    const s = el.ownerDocument.defaultView.getComputedStyle(el)
    const left = parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft)
    const top = parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop)
    const right = parseFloat(s.borderRightWidth) + parseFloat(s.paddingRight)
    const bottom = parseFloat(s.borderBottomWidth) + parseFloat(s.paddingBottom)
    return { x: b.x + left, y: b.y + top, width: Math.max(0, b.width - left - right), height: Math.max(0, b.height - top - bottom) }
  }

  /**
   * Calls fn for every element below root in document order, in shadow roots and frames of the same
   * site too; fn returns 'skip' to leave out what is inside the element. Stops after many elements.
   */
  function eachElement(root, fn) {
    let left = 30000
    const go = (parent) => {
      for (const node of childNodesOf(parent)) {
        if (node.nodeType !== 1) continue
        if (--left < 0) return
        if (fn(node) === 'skip') continue
        if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
          let inner = null
          try {
            inner = node.contentDocument
          } catch {}
          if (inner?.body) go(inner.body)
          continue
        }
        go(node)
      }
    }
    if (root) go(root)
  }

  /** The text of an element's own text nodes, not of the elements in it. */
  function ownText(el) {
    let text = ''
    for (const node of el.childNodes) if (node.nodeType === 3) text += node.data
    return clean(text)
  }

  /** The element above in the page, also out of a shadow root. */
  const parentOf = (n) => n.parentElement || (n.getRootNode && n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null)

  /** Where an element is against the viewport: in it, partly, or which way to scroll. */
  function placeOf(el) {
    const b = box(el)
    if (b.width === 0 && b.height === 0) return 'no size'
    if (b.y >= innerHeight) return 'below the viewport, ' + Math.round(b.y - innerHeight + b.height) + ' px further down'
    if (b.y + b.height <= 0) return 'above the viewport'
    if (b.x >= innerWidth) return 'right of the viewport'
    if (b.x + b.width <= 0) return 'left of the viewport'
    if (b.x < 0 || b.y < 0 || b.x + b.width > innerWidth || b.y + b.height > innerHeight) return 'partly in view'
    return 'in view'
  }

  let colorContext = null
  const colors = new Map()
  /** A CSS color as [r, g, b, a] in sRGB: legacy rgb() read directly, any other syntax drawn into one pixel. */
  function rgba(color) {
    if (colors.has(color)) return colors.get(color)
    let out = null
    const m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(color)
    if (m) out = [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]]
    else {
      try {
        if (!colorContext) {
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 1
          colorContext = canvas.getContext('2d', { willReadFrequently: true })
        }
        colorContext.clearRect(0, 0, 1, 1)
        colorContext.fillStyle = 'rgba(0, 0, 0, 0)'
        colorContext.fillStyle = color
        colorContext.fillRect(0, 0, 1, 1)
        const d = colorContext.getImageData(0, 0, 1, 1).data
        out = [d[0], d[1], d[2], d[3] / 255]
      } catch {}
    }
    colors.set(color, out)
    return out
  }

  /** One color over another (alpha blending). */
  function blend(top, bottom) {
    const a = top[3] + bottom[3] * (1 - top[3])
    if (a === 0) return [0, 0, 0, 0]
    const mix = (i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a
    return [mix(0), mix(1), mix(2), a]
  }

  function luminance(c) {
    const f = (v) => {
      v /= 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
  }

  const hex = (c) => '#' + [0, 1, 2].map((i) => Math.round(c[i]).toString(16).padStart(2, '0')).join('')

  /** The color behind an element from its own background and its parents', over white; null when an image lies behind. */
  function backdrop(el) {
    const layers = []
    for (let n = el; n; n = parentOf(n)) {
      const st = n.ownerDocument.defaultView.getComputedStyle(n)
      if (st.backgroundImage && st.backgroundImage !== 'none') return null
      const c = rgba(st.backgroundColor)
      if (c && c[3] > 0) {
        layers.push(c)
        if (c[3] >= 1) break
      }
    }
    let color = [255, 255, 255, 1]
    for (let i = layers.length - 1; i >= 0; i--) color = blend(layers[i], color)
    return color
  }

  /** The contrast of an element's text with what lies behind it (WCAG 2), or null when it can't be told. */
  function contrastOf(el) {
    const st = styleOf(el)
    const fg = rgba(st.color)
    const bg = backdrop(el)
    if (!fg || !bg) return null
    let opacity = 1
    for (let n = el; n; n = parentOf(n)) opacity *= parseFloat(n.ownerDocument.defaultView.getComputedStyle(n).opacity) || 0
    const text = blend([fg[0], fg[1], fg[2], fg[3] * opacity], bg)
    const l1 = luminance(text)
    const l2 = luminance(bg)
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    const size = parseFloat(st.fontSize)
    const weight = parseInt(st.fontWeight, 10) || 400
    const large = size >= 24 || (size >= 18.66 && weight >= 700)
    return { ratio: Math.round(ratio * 100) / 100, needed: large ? 3 : 4.5, color: hex(text), background: hex(bg), large }
  }

  /** A short CSS path to an element: its id when unique, else tags with their place among siblings. */
  function cssPath(el) {
    const doc = el.ownerDocument
    const parts = []
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      if (n.id && doc.querySelectorAll('#' + CSS.escape(n.id)).length === 1) {
        parts.unshift('#' + CSS.escape(n.id))
        break
      }
      let part = n.tagName.toLowerCase()
      const parent = n.parentElement
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === n.tagName)
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'
      }
      parts.unshift(part)
      if (n.tagName === 'BODY') break
    }
    return parts.join(' > ')
  }

  /** A line about an element for find and the accessibility check: like the snapshot's, with a ref. */
  function refLine(el) {
    const role = roleOf(el)
    if (role || interactive(el, role)) return describe(el, role || (draggable(el) ? 'draggable' : null), true)
    const text = cut(clean(el.innerText || el.textContent), 120)
    return el.tagName.toLowerCase() + (text ? ' ' + quote(text) : '') + ' [ref=' + refOf(el) + ']'
  }

  /** The landmark, dialog, form or table an element is in, by its role and name. */
  function regionOf(el) {
    for (let n = parentOf(el); n; n = parentOf(n)) {
      if (n.nodeType !== 1) continue
      const role = roleOf(n)
      if (['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'region', 'dialog', 'form', 'table', 'search', 'alertdialog'].includes(role)) {
        const name = cut(nameOf(n, role), 60)
        return role + (name ? ' ' + quote(name) : '')
      }
    }
    return ''
  }

  const ARIA_ROLES = new Set(
    ('alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary ' +
      'contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img ' +
      'insertion link list listbox listitem log main mark marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter ' +
      'navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search ' +
      'searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time ' +
      'timer toolbar tooltip tree treegrid treeitem graphics-document graphics-object graphics-symbol').split(' '),
  )
  const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton'])
  /** Roles of what one clicks or taps, for the size of click targets (browser_check_accessibility). */
  const TARGET_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem'])
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable=true]'
  /** Computed styles browser_inspect shows; values that change nothing are left out (BORING). */
  const STYLE_KEYS = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'box-sizing', 'width', 'height', 'min-width', 'max-width',
    'min-height', 'max-height', 'overflow-x', 'overflow-y', 'color', 'background-color', 'background-image', 'font-family', 'font-size',
    'font-weight', 'line-height', 'text-align', 'white-space', 'text-overflow', 'opacity', 'visibility', 'transform', 'cursor',
    'pointer-events', 'border-radius', 'box-shadow', 'outline', 'transition',
  ]
  const FLEX_KEYS = ['flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap']
  const GRID_KEYS = ['grid-template-columns', 'grid-template-rows', 'grid-auto-flow', 'justify-items', 'align-items', 'gap']
  const ITEM_KEYS = ['flex', 'align-self', 'order', 'grid-column', 'grid-row']
  const BORING = {
    top: ['auto'], right: ['auto'], bottom: ['auto'], left: ['auto'], 'z-index': ['auto'], 'min-width': ['auto', '0px'],
    'max-width': ['none'], 'min-height': ['auto', '0px'], 'max-height': ['none'], 'overflow-x': ['visible'], 'overflow-y': ['visible'],
    'background-image': ['none'], 'white-space': ['normal'], 'text-overflow': ['clip'], opacity: ['1'], visibility: ['visible'],
    transform: ['none'], cursor: ['auto'], 'pointer-events': ['auto'], 'border-radius': ['0px'], 'box-shadow': ['none'],
    transition: ['all 0s ease 0s', 'all'], order: ['0'], 'align-self': ['auto'], flex: ['0 1 auto'], 'grid-column': ['auto'],
    'grid-row': ['auto'], gap: ['normal'],
  }

  globalThis.__cm = {
    /** The outline and its document; frame: of a frame in another page, which only names its address. */
    snapshot(max, frame) {
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
      const scroller = document.scrollingElement || document.documentElement
      if (frame) add('- Frame URL: ' + location.href)
      else {
        add('- Page URL: ' + location.href)
        add('- Page title: ' + clean(document.title))
        add('- Scroll: ' + Math.round(scrollY) + ' of ' + Math.max(0, Math.round(scroller.scrollHeight - innerHeight)) + ' px down (viewport ' + innerWidth + '×' + innerHeight + ')')
      }
      const active = document.activeElement
      if (active && active !== document.body && !ids.has(active) && active.tagName !== 'IFRAME' && active.tagName !== 'FRAME') {
        // Focus inside something without a ref (e.g. an editor) is still worth knowing.
        add('- Focused: ' + short(active))
      }
      render(items, 0)
      if (full) lines.push('- … (cut: the page is longer; scroll or use browser_evaluate to read more)')
      return { doc, text: lines.join('\n') }
    },
    /** Marks frames of other sites (by ref) for the DevTools protocol, which finds them by the mark. */
    markFrames(token, frameRefs) {
      for (const ref of frameRefs) {
        const el = refs.get(ref)?.deref()
        if (!el || !el.isConnected || (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME')) continue
        el.setAttribute('data-claude-manager-frame', 'cm-frame-' + token + '-' + ref)
        marked.push(new WeakRef(el))
      }
      return marked.length
    },
    unmarkFrames() {
      for (const weak of marked) weak.deref()?.removeAttribute('data-claude-manager-frame')
      marked = []
    },
    /**
     * Where the document of a frame is in this viewport, for a spot in it (point, in the frame's own
     * pixels): scrolls the frame so the spot is visible. Returns the box of the frame's document.
     */
    locateFrame(ref, point) {
      const el = element(ref)
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
      let b = frameContentBox(el)
      const x = b.x + point.x
      const y = b.y + point.y
      const outsideX = x < 0 || x > innerWidth
      const outsideY = y < 0 || y > innerHeight
      if (outsideX || outsideY) {
        // A frame larger than the window: the spot comes to the middle.
        scrollBy({ left: outsideX ? x - innerWidth / 2 : 0, top: outsideY ? y - innerHeight / 2 : 0, behavior: 'instant' })
        b = frameContentBox(el)
      }
      return b
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
    /**
     * Elements by text or role, beyond what the snapshot holds: those whose name or own text has the
     * text (exact: is it), of the role when one is given. Text in a link or button finds that.
     */
    find(text, role, exact, limit) {
      styles = new WeakMap()
      const needle = clean(text).toLowerCase()
      const wanted = clean(role).toLowerCase()
      const matches = (value) => {
        const v = clean(value).toLowerCase()
        if (!needle) return true
        return exact ? v === needle : v.includes(needle)
      }
      const items = []
      const seen = new Set()
      let total = 0
      let hidden = 0
      eachElement(document.body || document.documentElement, (el) => {
        if (SKIP.has(el.tagName)) return 'skip'
        const own = roleOf(el)
        const shown = own || (interactive(el, own) ? 'clickable' : null)
        if (wanted && shown !== wanted) return
        let hit = !!shown && (!needle || matches(nameOf(el, shown)))
        if (!hit && !wanted && needle) {
          hit = matches(ownText(el)) && !!ownText(el)
          if (!hit && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'password') hit = !!el.value && matches(el.value)
        }
        if (!hit) return
        let target = el
        if (!wanted && !INTERACTIVE.has(shown)) {
          const hot = el.parentElement?.closest('a[href], button, summary, label, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], [role=switch]')
          if (hot) target = hot
        }
        if (seen.has(target)) return
        seen.add(target)
        total++
        if (!visible(target) || target.closest('[aria-hidden="true"]')) {
          hidden++
          return
        }
        if (items.length >= limit) return
        const block = roleOf(target) ? '' : clean(target.closest('p, li, td, th, dd, figcaption, blockquote, label')?.innerText)
        const line = refLine(target)
        items.push({ line, region: regionOf(target), place: placeOf(target), context: block && !line.includes(cut(block, 120)) ? cut(block, 160) : '' })
      })
      return { items, total, hidden }
    },
    /** What browser_inspect tells of an element: box model, styles, why it may not be seen or reached. */
    inspect(ref, extra) {
      styles = new WeakMap()
      const el = element(ref)
      const win = el.ownerDocument.defaultView
      const s = win.getComputedStyle(el)
      const role = roleOf(el)
      const px = (v) => Math.round((parseFloat(v) || 0) * 10) / 10
      const four = (name) => ['top', 'right', 'bottom', 'left'].map((side) => px(s.getPropertyValue(name.replace('*', side))))
      const shownStyles = []
      const show = (key) => {
        const value = s.getPropertyValue(key)
        if (!value || (BORING[key] || []).includes(value)) return
        if (key === 'outline' && / none /.test(' ' + value + ' ')) return
        if (['top', 'right', 'bottom', 'left'].includes(key) && s.position === 'static') return
        if (!shownStyles.some(([k]) => k === key)) shownStyles.push([key, cut(value, 200)])
      }
      STYLE_KEYS.forEach(show)
      if (s.display.includes('flex')) FLEX_KEYS.forEach(show)
      if (s.display.includes('grid')) GRID_KEYS.forEach(show)
      const parent = el.parentElement ? win.getComputedStyle(el.parentElement) : null
      if (parent && (parent.display.includes('flex') || parent.display.includes('grid'))) ITEM_KEYS.forEach(show)
      const asked = (extra || []).map((key) => [key, cut(s.getPropertyValue(key) || '(not set)', 300)])
      const attributes = [...el.attributes].slice(0, 30).map((a) => [a.name, el.type === 'password' && a.name === 'value' ? '••••' : cut(a.value, 200)])
      let why = null
      for (let n = el; n && !why; n = n.parentElement) {
        const st = n.ownerDocument.defaultView.getComputedStyle(n)
        if (st.display === 'none') why = n === el ? 'display: none' : short(n) + ' around it has display: none'
        else if (st.opacity === '0') why = n === el ? 'opacity: 0' : short(n) + ' around it has opacity: 0'
      }
      if (!why && s.visibility !== 'visible') why = 'visibility: ' + s.visibility
      const r = el.getBoundingClientRect()
      if (!why && (r.width === 0 || r.height === 0)) why = 'it has no size (' + px(r.width) + '×' + px(r.height) + ')'
      if (!why) {
        for (let n = el.parentElement; n && n !== el.ownerDocument.body; n = n.parentElement) {
          const st = n.ownerDocument.defaultView.getComputedStyle(n)
          if (st.overflowX === 'visible' && st.overflowY === 'visible') continue
          const nr = n.getBoundingClientRect()
          if (r.right <= nr.left || r.left >= nr.right || r.bottom <= nr.top || r.top >= nr.bottom) {
            why = 'it lies outside ' + short(n) + ', which clips its content (overflow: ' + st.overflow + ')'
            break
          }
        }
      }
      const place = placeOf(el)
      let covered = null
      if (!why && el.ownerDocument === document && (place === 'in view' || place === 'partly in view')) {
        const b = box(el)
        const x = Math.min(Math.max(b.x + b.width / 2, 0), innerWidth - 1)
        const y = Math.min(Math.max(b.y + b.height / 2, 0), innerHeight - 1)
        const hit = document.elementFromPoint(x, y)
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) covered = short(hit) + (roleOf(hit) ? ' (' + roleOf(hit) + ')' : '')
      }
      const own = ownText(el) || (el.children.length === 0 ? clean(el.textContent) : '')
      return {
        line: refLine(el),
        tag: el.tagName.toLowerCase(),
        role: role || '',
        name: cut(nameOf(el, role || 'clickable'), MAX_NAME),
        states: states(el, role),
        attributes,
        box: { ...box(el), margin: four('margin-*'), padding: four('padding-*'), border: four('border-*-width') },
        styles: shownStyles,
        asked,
        hidden: why,
        ariaHidden: !!el.closest('[aria-hidden="true"]') || !!el.inert,
        place,
        covered,
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        pointerEvents: s.pointerEvents,
        contrast: own ? contrastOf(el) : null,
        text: cut(clean(el.innerText || el.textContent), 300),
        path: cssPath(el),
        children: el.children.length,
        frame: el.ownerDocument !== document ? 'in a frame of the same site' : '',
      }
    },
    /**
     * Problems of accessibility a script can find (like axe or Lighthouse, fewer rules): images
     * without text, fields and buttons without names, low contrast, wrong roles, hidden focus,
     * heading levels, zoom, ids labels refer to. At most perRule elements of each rule.
     */
    audit(perRule) {
      styles = new WeakMap()
      const issues = []
      const counts = {}
      const add = (rule, severity, el, detail) => {
        counts[rule] = (counts[rule] || 0) + 1
        if (counts[rule] > perRule) return
        issues.push({ rule, severity, line: el ? refLine(el) : null, detail })
      }
      const html = document.documentElement
      if (!clean(html.getAttribute('lang'))) add('html-lang', 'error', null, 'The <html> element has no lang attribute: screen readers may read the page in the wrong language.')
      if (!clean(document.title)) add('document-title', 'error', null, 'The page has no <title>.')
      const viewport = document.querySelector('meta[name="viewport"]')?.getAttribute('content') || ''
      const maxScale = /maximum-scale\s*=\s*([\d.]+)/i.exec(viewport)
      if (/user-scalable\s*=\s*(no|0)\b/i.test(viewport) || (maxScale && parseFloat(maxScale[1]) < 2)) {
        add('zoom', 'error', null, 'The viewport meta tag keeps users from zooming: ' + quote(viewport))
      }
      let lastHeading = 0
      let checked = 0
      let contrastChecks = 0
      const targets = []
      let foreign = 0
      eachElement(document.body || html, (el) => {
        if (SKIP.has(el.tagName)) return 'skip'
        checked++
        if (el.getAttribute('aria-hidden') === 'true') {
          const focusable = el.matches(FOCUSABLE) ? el : el.querySelector(FOCUSABLE)
          if (focusable && visible(focusable)) add('aria-hidden-focus', 'error', el, 'It is hidden from screen readers (aria-hidden) but holds something the keyboard reaches: ' + short(focusable) + '.')
          return 'skip'
        }
        if (!visible(el)) return 'skip'
        const tag = el.tagName
        if (tag === 'IFRAME' || tag === 'FRAME') {
          let inner = null
          try {
            inner = el.contentDocument
          } catch {}
          if (!inner) foreign++
          if (!clean(el.title || el.getAttribute('aria-label'))) add('frame-title', 'warning', el, 'The frame has no title.')
        }
        const explicit = clean(el.getAttribute('role')).split(' ')[0].toLowerCase()
        if (explicit && !ARIA_ROLES.has(explicit)) add('aria-role', 'error', el, 'role=' + quote(explicit) + ' is no ARIA role.')
        const role = roleOf(el)
        if (tag === 'IMG' && !el.hasAttribute('alt') && !clean(el.getAttribute('aria-label')) && !labelledBy(el) && explicit !== 'presentation' && explicit !== 'none') {
          add('image-alt', 'error', el, 'The image has no alt text (alt="" if it is only decoration): ' + cut(el.currentSrc || el.src || '', 100))
        }
        if (tag === 'INPUT' && el.type === 'image' && !clean(el.alt) && !clean(el.getAttribute('aria-label'))) add('image-alt', 'error', el, 'The image button has no alt text.')
        if (FIELD_ROLES.has(role) && tag !== 'OPTION') {
          const labelled = clean(el.getAttribute('aria-label')) || labelledBy(el) || (el.labels && [...el.labels].some((l) => clean(l.innerText)))
          if (!labelled) {
            if (clean(el.getAttribute('placeholder'))) add('form-label', 'warning', el, 'Only the placeholder names the field; it goes away when the user types. Give it a <label>.')
            else if (!clean(el.title)) add('form-label', 'error', el, 'The field has no label (no <label>, aria-label or aria-labelledby).')
          }
        }
        if ((role === 'button' || role === 'link') && !nameOf(el, role)) add(role + '-name', 'error', el, 'The ' + role + ' has no name a screen reader could read (text, aria-label or an image with alt).')
        const tabindex = Number(el.getAttribute('tabindex'))
        if (tabindex > 0) add('tabindex', 'warning', el, 'tabindex="' + tabindex + '" changes the order of the Tab key; use 0 or -1.')
        if (role === 'heading') {
          const level = Number(tag[1]) || Number(el.getAttribute('aria-level')) || 2
          if (lastHeading && level > lastHeading + 1) add('heading-order', 'warning', el, 'A heading of level ' + level + ' follows one of level ' + lastHeading + '.')
          lastHeading = level
        }
        const own = ownText(el)
        if (own && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && contrastChecks < 3000) {
          contrastChecks++
          const c = contrastOf(el)
          if (c && c.ratio < c.needed) add('contrast', 'error', el, 'Contrast ' + c.ratio + ':1, needs ' + c.needed + ':1' + (c.large ? ' (large text)' : '') + ': ' + c.color + ' on ' + c.background + ', ' + quote(cut(own, 60)))
        }
        if (TARGET_ROLES.has(role) && styleOf(el).display !== 'inline' && !(el.labels && el.labels.length)) {
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) targets.push({ el, r, small: r.width < 24 || r.height < 24 })
        }
      })
      // WCAG 2.5.8: a target under 24×24 px is fine with room around it: a circle of 24 px around its
      // middle reaches no other target and no such circle of another small one.
      const middle = (r) => [r.x + r.width / 2, r.y + r.height / 2]
      const reaches = (p, r) => Math.hypot(Math.max(r.left - p[0], 0, p[0] - r.right), Math.max(r.top - p[1], 0, p[1] - r.bottom)) < 12
      for (const t of targets.filter((t) => t.small).slice(0, 500)) {
        const m = middle(t.r)
        const close = targets.find((o) => {
          if (o === t || o.el.contains(t.el) || t.el.contains(o.el)) return false
          if (reaches(m, o.r)) return true
          if (!o.small) return false
          const n = middle(o.r)
          return Math.hypot(m[0] - n[0], m[1] - n[1]) < 24
        })
        if (close) {
          add('target-size', 'warning', t.el, 'It is ' + Math.round(t.r.width) + '×' + Math.round(t.r.height) + ' px and close to ' + refLine(close.el) + ': 24×24 px, or 24 px of room around its middle, make it easy to hit (WCAG 2.5.8).')
        }
      }
      const referenced = new Set()
      for (const el of document.querySelectorAll('[for], [aria-labelledby], [aria-describedby], [aria-controls], [aria-owns], [aria-activedescendant]')) {
        for (const name of ['for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant']) {
          for (const id of clean(el.getAttribute(name)).split(' ')) if (id) referenced.add(id)
        }
      }
      for (const id of referenced) {
        const all = document.querySelectorAll('#' + CSS.escape(id))
        if (all.length > 1) add('duplicate-id', 'error', all[0], 'The id ' + quote(id) + ' is used ' + all.length + ' times, but labels or ARIA attributes refer to it.')
      }
      return { issues, counts, checked, foreign }
    },
    /** What a Playwright locator for the element needs (browser_generate_test): role and name, label, test id … */
    locator(ref) {
      styles = new WeakMap()
      const el = element(ref)
      const role = roleOf(el)
      const name = role ? nameOf(el, role) : ''
      let same = 0
      let exact = 0
      let index = 0
      if (role && name) {
        const needle = name.toLowerCase()
        eachElement(el.ownerDocument.body || el.ownerDocument.documentElement, (other) => {
          if (SKIP.has(other.tagName) || other.getAttribute('aria-hidden') === 'true') return 'skip'
          if (other.tagName === 'IFRAME' || other.tagName === 'FRAME') return 'skip'
          if (roleOf(other) !== role) return
          const otherName = nameOf(other, role).toLowerCase()
          if (!otherName.includes(needle) || !visible(other)) return
          same++
          if (otherName === needle) {
            if (other === el) index = exact
            exact++
          }
        })
      }
      const label = el.labels && el.labels.length ? clean([...el.labels].map((l) => l.innerText).join(' ')) : ''
      const id = el.id && el.ownerDocument.querySelectorAll('#' + CSS.escape(el.id)).length === 1 ? '#' + CSS.escape(el.id) : ''
      return {
        role: role || '',
        name: cut(name, 200),
        testId: el.getAttribute('data-testid') || '',
        label: cut(label, 200),
        placeholder: clean(el.getAttribute('placeholder')),
        text: cut(clean(el.innerText || el.textContent), 80),
        same,
        exact,
        index,
        css: id || cssPath(el),
      }
    },
    /** The page's local or session storage: list, get, set, remove, clear. */
    storage(area, op, key, value, max) {
      const store = area === 'session' ? sessionStorage : localStorage
      if (op === 'list') {
        const out = []
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i)
          const v = store.getItem(k) ?? ''
          out.push([k, cut(v, max), v.length])
        }
        return out.sort((a, b) => (a[0] < b[0] ? -1 : 1))
      }
      if (op === 'get') {
        const v = store.getItem(key)
        return v === null ? null : [key, cut(v, max), v.length]
      }
      if (op === 'set') {
        store.setItem(key, value)
        return null
      }
      if (op === 'remove') {
        const had = store.getItem(key) !== null
        store.removeItem(key)
        return had
      }
      if (op === 'clear') {
        const n = store.length
        store.clear()
        return n
      }
      throw new Error('Unknown storage operation ' + op)
    },
    /** The element at a spot of the viewport (CSS pixels), for a click there. */
    hitAt(x, y) {
      const el = document.elementFromPoint(x, y)
      if (!el) return null
      const role = roleOf(el)
      return { role: role || el.tagName.toLowerCase(), name: cut(nameOf(el, role || 'clickable'), MAX_NAME), short: short(el) }
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
