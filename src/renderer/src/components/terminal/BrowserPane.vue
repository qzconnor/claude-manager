<script setup lang="ts">
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  FlaskConicalIcon,
  GlobeIcon,
  HandIcon,
  MonitorIcon,
  PlayIcon,
  RotateCwIcon,
  ScrollTextIcon,
  SmartphoneIcon,
  SparklesIcon,
  TabletIcon,
  TriangleAlertIcon,
  XIcon,
} from '@lucide/vue'
import { useElementSize } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { addressOf, addressToUrl, BLANK_PAGE, BROWSER_PARTITION, emulationLabels, isBrowsableUrl } from '@shared/browser'
import type { TerminalInfo } from '@shared/types'
import { Button } from '@/components/ui/button'
import { useTerminalAppearance } from '@/composables/useTerminalAppearance'
import { attempt } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useBrowsersStore, type BrowserViewState, type ShownHighlight } from '@/stores/browsers'
import { useUiStore } from '@/stores/ui'
import BrowserDownloads from './BrowserDownloads.vue'
import BrowserFind from './BrowserFind.vue'
import BrowserLog from './BrowserLog.vue'
import BrowserLogin from './BrowserLogin.vue'

/**
 * A web page in a part of a tab, with its own address bar. The page runs in a `<webview>` that the
 * main process hardens (browser-guests.ts): no Node.js, the browser's own profile. It must never be
 * moved to another parent, which would load it anew; TerminalWorkspace places it absolutely.
 *
 * Claude sessions drive the page through the app's MCP server (main's BrowserControl): a bar shows
 * which one, the page shows where it acts, and its log lies next to the page.
 */
const props = defineProps<{ terminal: TerminalInfo; active: boolean; dimmed?: boolean }>()
/** The pane was clicked or took the keyboard: it should become the active one. */
const emit = defineEmits<{ focus: [] }>()

/** The webview's own methods; the element exists only in Electron. */
interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  getWebContentsId(): number
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
}

/** What the page reports while it searches (`found-in-page`); a result may come in several parts. */
interface FoundInPage {
  requestId: number
  activeMatchOrdinal?: number
  matches?: number
  finalUpdate: boolean
}

const browsers = useBrowsersStore()
const ui = useUiStore()
const { containerBackground, inactiveVeil } = useTerminalAppearance()

const view = ref<WebviewElement | null>(null)
const addressInput = ref<HTMLInputElement | null>(null)
/** Bound once: the page navigates by itself afterwards, a changed attribute would load it again. */
const initialUrl = props.terminal.url && isBrowsableUrl(props.terminal.url) ? props.terminal.url : BLANK_PAGE
const url = ref(initialUrl)
const address = ref(addressOf(initialUrl))
const editing = ref(false)
/** The page's methods work once it is attached and its first document is ready. */
const ready = ref(false)
const state = reactive<BrowserViewState>({ loading: false, canGoBack: false, canGoForward: false, favicon: null })
const failure = ref<{ description: string; url: string } | null>(null)
/** The id of the page's contents, once the view is attached: questions and downloads of the page name it. */
const contentsId = ref<number | null>(null)
/** The page asks for a user name and password. */
const loginRequest = computed(() => browsers.loginFor(contentsId.value))

/** The search in the page (Ctrl+F). */
const findOpen = ref(false)
const findBar = ref<InstanceType<typeof BrowserFind> | null>(null)
const findMatches = ref<{ active: number; total: number } | null>(null)
let findRequest = 0
/** Counts the documents the view showed: an icon that arrives late for an earlier one is dropped. */
let documents = 0
/** Whether the current document named its icon; when it ends without, the site's icon is looked up. */
let iconNamed = false

/** A Claude session drives (or drove) the page. */
const control = computed(() => browsers.controls.get(props.terminal.id) ?? null)
const log = computed(() => browsers.logs.get(props.terminal.id) ?? [])
/** The log floats over the page on demand; it takes no room from it. */
const logOpen = ref(false)
/** The newest line of the log the user had in front of them. */
const seenUntil = ref(-1)
/** Something went wrong since the user last looked at the log. */
const unseenProblem = computed(() =>
  log.value.some((e) => e.id > seenUntil.value && (e.status === 'error' || e.status === 'warning')),
)
/** Lines of the log the page caused itself, not Claude. */
const PAGE_EVENTS = new Set(['console', 'network', 'page-dialog', 'control', 'download', 'popup'])
/** What Claude does right now, else what it did last. */
const lastStep = computed(() => {
  for (let i = log.value.length - 1; i >= 0; i--) {
    const entry = log.value[i]
    if (!PAGE_EVENTS.has(entry.kind)) return entry
  }
  return null
})
/** The mouse is over Claude's status: it shows all of it, also while Claude rests. */
const statusHover = ref(false)
/** Claude rests for a while: its status shrinks to its icon, out of the page's way. */
const statusCompact = computed(() => {
  const c = control.value
  return !!c && !c.busy && !c.active && !c.takenOver && !statusHover.value
})
/** Until then a focus of the page counts as Claude's (ms). */
let claudeUntil = 0
const claudeActing = () => control.value?.busy === true || Date.now() < claudeUntil
/** Where Claude acts, for a moment. */
const highlight = ref<ShownHighlight | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | undefined
/** The page's area, which Claude's pointer moves in. */
const pageArea = ref<HTMLElement | null>(null)
const { width: areaWidth, height: areaHeight } = useElementSize(pageArea)

/** The size Claude gave the page; null: it fills its part of the tab. */
const viewport = computed(() => control.value?.viewport ?? null)
/** Room around a page with a size of its own (px): its badge above it, Claude's status below it. */
const STAGE = { side: 24, top: 52, bottom: 24, status: 64 }
const FRAME_RADIUS = { phone: 22, tablet: 14, desktop: 8 }
type DeviceKind = keyof typeof FRAME_RADIUS
const deviceKind = (width: number): DeviceKind => (width < 600 ? 'phone' : width < 1100 ? 'tablet' : 'desktop')

/**
 * Where a page with a size of its own goes: in the middle of its part of the tab, scaled down to
 * fit (never up). Its view keeps the full size in the layout, which is the page's size.
 */
const frame = computed(() => {
  const v = viewport.value
  if (!v) return null
  const width = v.width * v.zoom
  const height = v.height * v.zoom
  const roomWidth = Math.max(1, areaWidth.value - 2 * STAGE.side)
  const roomHeight = Math.max(1, areaHeight.value - STAGE.top - STAGE.bottom - (control.value ? STAGE.status : 0))
  const scale = Math.min(1, roomWidth / width, roomHeight / height)
  const shownWidth = Math.round(width * scale)
  const shownHeight = Math.round(height * scale)
  const kind = deviceKind(v.width)
  return {
    width,
    height,
    scale,
    shownWidth,
    shownHeight,
    kind,
    left: Math.round((areaWidth.value - shownWidth) / 2),
    top: Math.round(STAGE.top + (roomHeight - shownHeight) / 2),
    radius: FRAME_RADIUS[kind],
  }
})
/** Screen pixels per pixel of the page's view. */
const shownScale = computed(() => frame.value?.scale ?? 1)
/** The page as the user sees it (the frame), for what lies over it. */
const frameBoxStyle = computed(() => {
  const f = frame.value
  if (!f) return undefined
  return { left: `${f.left}px`, top: `${f.top}px`, width: `${f.shownWidth}px`, height: `${f.shownHeight}px`, borderRadius: `${f.radius}px` }
})
/** The view in its full size, scaled into the frame; its corners scaled up, so they look the frame's. */
const viewStyle = computed(() => {
  const f = frame.value
  if (!f) return undefined
  return {
    left: `${f.left}px`,
    top: `${f.top}px`,
    width: `${f.width}px`,
    height: `${f.height}px`,
    transform: f.scale < 1 ? `scale(${f.scale})` : undefined,
    transformOrigin: '0 0',
    borderRadius: `${f.radius / f.scale}px`,
  }
})
/** Around a page with a size of its own: a calm surface with a fine grid of dots. */
const stageStyle = computed(() =>
  frame.value
    ? {
        backgroundImage: 'radial-gradient(circle, color-mix(in oklab, var(--foreground) 13%, transparent) 1px, transparent 1.5px)',
        backgroundSize: '18px 18px',
        backgroundPosition: 'center',
      }
    : undefined,
)

function resetViewport() {
  void attempt(() => browsers.resetViewport(props.terminal.id), 'Größe konnte nicht zurückgesetzt werden')
}

/** What Claude has the page pretend (dark mode, slow network …), as labels for its badge. */
const emulation = computed(() => {
  const value = control.value?.emulation
  return value ? emulationLabels(value) : []
})
function resetEmulation() {
  void attempt(() => browsers.resetEmulation(props.terminal.id), 'Emulation konnte nicht beendet werden')
}
/**
 * Claude's mouse pointer: it glides from spot to spot (in main's time, see pointer.ts), presses
 * where Claude clicks and fades after a while without actions; it comes back from its last spot.
 */
const pointer = reactive({ x: 0, y: 0, moveMs: 0, shown: false, known: false, pressed: false, labelLeft: false, labelAbove: false })
/** The click that landed last, as a ring at its spot. */
const pointerClick = ref<{ x: number; y: number; seq: number } | null>(null)
const POINTER_IDLE_MS = 6000
/** Room the label next to the pointer needs, to the right of and below it (px). */
const POINTER_LABEL_ROOM = { x: 260, y: 48 }
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const pointerTimers = new Set<ReturnType<typeof setTimeout>>()
let pointerHide: ReturnType<typeof setTimeout> | undefined

const blank = computed(() => url.value === BLANK_PAGE && !state.loading)
const external = computed(() => /^https?:/i.test(url.value))

/** Tells main what the page shows, so the tab, the API and the next start know it. */
function report() {
  const el = view.value
  if (!el || !ready.value) return
  window.api.browser.page(props.terminal.id, { url: el.getURL() || url.value, title: el.getTitle() })
}

function updateHistory() {
  const el = view.value
  if (!el || !ready.value) return
  state.canGoBack = el.canGoBack()
  state.canGoForward = el.canGoForward()
}

function navigated(next: string) {
  url.value = next
  if (!editing.value) address.value = addressOf(next)
  updateHistory()
  report()
}

/** Where a site keeps its icon when its page names none; Chrome looks there too. */
function siteFavicon(): string[] {
  try {
    const { origin, protocol } = new URL(url.value)
    return protocol === 'http:' || protocol === 'https:' ? [`${origin}/favicon.ico`] : []
  } catch {
    return []
  }
}

/** The first of the page's icons that main can load, else the site's; the old one stays until then. */
async function showFavicon(candidates: string[]) {
  const shown = documents
  for (const candidate of new Set([...candidates.slice(0, 3), ...siteFavicon()])) {
    const icon = await window.api.browser.favicon(candidate).catch(() => null)
    if (shown !== documents) return
    if (icon) {
      state.favicon = icon
      return
    }
  }
  state.favicon = null
}

function load(target: string) {
  const el = view.value
  if (!el) return
  failure.value = null
  url.value = target
  address.value = addressOf(target)
  // Before its first document the view only takes an address as attribute.
  if (ready.value) el.loadURL(target).catch(() => undefined)
  else el.setAttribute('src', target)
}

function submit() {
  load(addressToUrl(address.value))
  editing.value = false
  view.value?.focus()
}

function cancelEdit() {
  address.value = addressOf(url.value)
  editing.value = false
  if (!blank.value) view.value?.focus()
}

function focusAddress() {
  void nextTick(() => {
    addressInput.value?.focus()
    addressInput.value?.select()
  })
}

/** The keyboard goes to the page, or to the address bar while there is none to use. */
function focusContent() {
  if (blank.value || failure.value) focusAddress()
  else if (loginRequest.value) return // the question takes it itself
  else view.value?.focus()
}

function reload() {
  failure.value = null
  if (ready.value) view.value?.reload()
}

function openFind() {
  findOpen.value = true
  void nextTick(() => findBar.value?.focus())
}

/** F3 and Shift+F3: the next or previous match, or the search when there is none yet. */
function findAgain(forward: boolean) {
  if (findOpen.value && findBar.value?.query) findBar.value.step(forward)
  else openFind()
}

/** Runs the search in the page: anew for a changed text (`again` false), else to the next match. */
function search(query: string, forward: boolean, again: boolean) {
  const el = view.value
  if (!el || !ready.value) return
  if (!query) {
    el.stopFindInPage('clearSelection')
    findMatches.value = null
    return
  }
  findRequest = el.findInPage(query, { forward, findNext: !again })
}

function closeFind() {
  findOpen.value = false
  findMatches.value = null
  if (ready.value) view.value?.stopFindInPage('keepSelection')
  focusContent()
}

function answerLogin(credentials: { username: string; password: string } | null) {
  const request = loginRequest.value
  if (!request) return
  void attempt(() => browsers.answerLogin(request.id, credentials), 'Anmeldung konnte nicht weitergegeben werden')
  view.value?.focus()
}

function openExternal() {
  if (external.value) void attempt(() => window.api.app.openExternal(url.value), 'Seite konnte nicht geöffnet werden')
}

onMounted(() => {
  const el = view.value
  if (!el) return
  // Before its first request: a site that asks for a login asks with it.
  el.addEventListener('did-attach', () => {
    contentsId.value = el.getWebContentsId()
  })
  el.addEventListener('dom-ready', () => {
    ready.value = true
    contentsId.value = el.getWebContentsId()
    // From now on main can drive the page for Claude.
    window.api.browser.attach(props.terminal.id, el.getWebContentsId())
    updateHistory()
    report()
  })
  el.addEventListener('did-start-loading', () => {
    state.loading = true
    failure.value = null
  })
  el.addEventListener('did-stop-loading', () => {
    state.loading = false
    // A page that names no icon gets the site's.
    if (!iconNamed) {
      iconNamed = true
      void showFavicon([])
    }
    updateHistory()
  })
  el.addEventListener('did-navigate', (event) => {
    documents++
    iconNamed = false
    // The matches were those of the last document.
    findMatches.value = null
    navigated((event as Event & { url: string }).url)
  })
  el.addEventListener('page-favicon-updated', (event) => {
    iconNamed = true
    void showFavicon((event as Event & { favicons: string[] }).favicons)
  })
  el.addEventListener('did-navigate-in-page', (event) => {
    const { url: next, isMainFrame } = event as Event & { url: string; isMainFrame: boolean }
    if (isMainFrame) navigated(next)
  })
  el.addEventListener('page-title-updated', report)
  el.addEventListener('found-in-page', (event) => {
    const result = (event as Event & { result: FoundInPage }).result
    if (result.requestId !== findRequest || !findOpen.value) return
    findMatches.value = {
      active: result.activeMatchOrdinal ?? findMatches.value?.active ?? 0,
      total: result.matches ?? findMatches.value?.total ?? 0,
    }
  })
  el.addEventListener('did-fail-load', (event) => {
    const { errorCode, errorDescription, validatedURL, isMainFrame } = event as Event & {
      errorCode: number
      errorDescription: string
      validatedURL: string
      isMainFrame: boolean
    }
    // -3: aborted, e.g. by the next navigation or by stopping.
    if (isMainFrame && errorCode !== -3) failure.value = { description: errorDescription || `Fehler ${errorCode}`, url: validatedURL }
  })
  browsers.register(props.terminal.id, {
    state,
    back: () => ready.value && view.value?.goBack(),
    forward: () => ready.value && view.value?.goForward(),
    reload,
    focusAddress,
    find: openFind,
    findAgain,
    focusPage: () => view.value?.focus(),
    userClicked,
  })
  void browsers.loadLog(props.terminal.id)
  document.addEventListener('focusout', onDocumentFocusOut, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('focusout', onDocumentFocusOut, true)
  clearTimeout(highlightTimer)
  clearTimeout(pointerHide)
  for (const timer of pointerTimers) clearTimeout(timer)
  browsers.unregister(props.terminal.id)
})

/**
 * Where the keyboard was before Claude's action took it into the page ('none': nowhere). Claude's
 * clicks give the page the keyboard, also in a hidden tab, where the view reports no focus of its
 * own; the page only takes keys while it has it. So it goes back after the action, unless the user
 * works in this pane: the page acts as focused anyway (main's focus emulation).
 */
let keyboardBefore: HTMLElement | 'none' | null = null

watch(
  () => control.value?.busy,
  (busy, was) => {
    if (!was || busy) return
    claudeUntil = Date.now() + 1000
    const previous = keyboardBefore
    keyboardBefore = null
    if (!previous || props.active || document.activeElement !== view.value) return
    if (previous !== 'none' && previous.isConnected) previous.focus({ preventScroll: true })
    else view.value?.blur()
  },
)

function onDocumentFocusOut(event: FocusEvent) {
  if (props.active || !control.value?.busy || event.target === view.value) return
  const previous = event.target
  setTimeout(() => {
    if (keyboardBefore || document.activeElement !== view.value) return
    keyboardBefore = previous instanceof HTMLElement ? previous : 'none'
  })
}

/** A click of the user into the page: this part becomes the active one, and the keyboard stays there. */
function userClicked() {
  claudeUntil = 0
  keyboardBefore = null
  if (!props.active) emit('focus')
}

function onViewFocus() {
  if (!props.active && !claudeActing()) emit('focus')
}

function onFocusIn(event: FocusEvent) {
  if (props.active || (event.target === view.value && claudeActing())) return
  emit('focus')
}

// What the open log shows counts as seen.
watch(
  [logOpen, () => log.value.at(-1)?.id],
  ([open, last]) => {
    if (open && last !== undefined) seenUntil.value = last
  },
)

watch(
  () => browsers.highlights.get(props.terminal.id),
  (next) => {
    if (!next) return
    highlight.value = next
    clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => (highlight.value = null), 1800)
    if (next.point) movePointer(next.point, next.click, next.moveMs, next.seq)
  },
)

function later(ms: number, action: () => void) {
  const timer = setTimeout(() => {
    pointerTimers.delete(timer)
    action()
  }, ms)
  pointerTimers.add(timer)
}

function movePointer(to: { x: number; y: number }, click: boolean, moveMs: number, seq: number) {
  // From its last spot, also after it faded; the first time it appears where it acts.
  const glide = pointer.known && !reducedMotion.matches ? moveMs : 0
  const width = frame.value?.shownWidth ?? areaWidth.value
  const height = frame.value?.shownHeight ?? areaHeight.value
  Object.assign(pointer, {
    x: to.x,
    y: to.y,
    moveMs: glide,
    shown: true,
    known: true,
    labelLeft: width - to.x * shownScale.value < POINTER_LABEL_ROOM.x,
    labelAbove: height - to.y * shownScale.value < POINTER_LABEL_ROOM.y,
  })
  if (click) {
    later(glide, () => {
      pointerClick.value = { ...to, seq }
      pointer.pressed = true
      later(150, () => (pointer.pressed = false))
    })
  }
  clearTimeout(pointerHide)
  pointerHide = setTimeout(() => (pointer.shown = false), glide + POINTER_IDLE_MS)
}

// While the user drives, Claude's pointer is out of the way.
watch(
  () => control.value?.takenOver,
  (takenOver) => {
    if (takenOver) pointer.shown = false
  },
)

/** The label sits above the element, or below it when there is no room. */
function labelStyle(shown: ShownHighlight) {
  if (!shown.rect) return { top: '10px', left: '50%', transform: 'translateX(-50%)' }
  const scale = shownScale.value
  const [x, y, height] = [shown.rect.x * scale, shown.rect.y * scale, shown.rect.height * scale]
  const above = y >= 28
  return { left: `${Math.max(4, x)}px`, top: above ? `${y - 26}px` : `${y + height + 6}px` }
}

function takeOver() {
  if (!control.value) return
  const next = !control.value.takenOver
  void attempt(() => browsers.takeOver(props.terminal.id, next), 'Browser konnte nicht übergeben werden')
  if (next) view.value?.focus()
}

watch(
  () => props.active,
  (active) => {
    if (active) void nextTick(focusContent)
  },
  { immediate: true },
)

watch(
  () => ui.focusTerminalRequest,
  () => {
    if (props.active) focusContent()
  },
)
</script>

<template>
  <div
    class="flex size-full flex-col overflow-hidden"
    :style="{ background: containerBackground }"
    @pointerdown.capture="!active && emit('focus')"
    @focusin="onFocusIn"
  >
    <form class="flex h-10 shrink-0 items-center gap-0.5 border-b px-1.5" @submit.prevent="submit">
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Zurück" :disabled="!state.canGoBack" @click="view?.goBack()">
        <ArrowLeftIcon />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Vor" :disabled="!state.canGoForward" @click="view?.goForward()">
        <ArrowRightIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        :aria-label="state.loading ? 'Laden abbrechen' : 'Neu laden'"
        :disabled="url === BLANK_PAGE && !state.loading"
        @click="state.loading ? view?.stop() : reload()"
      >
        <XIcon v-if="state.loading" />
        <RotateCwIcon v-else />
      </Button>
      <input
        ref="addressInput"
        v-model="address"
        type="text"
        aria-label="Adresse"
        placeholder="Adresse eingeben oder suchen"
        spellcheck="false"
        autocomplete="off"
        class="mx-1 h-7 min-w-0 flex-1 rounded-md border border-input bg-background/40 px-2.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30"
        @focus="editing = true"
        @blur="editing = false"
        @keydown.esc.prevent="cancelEdit"
      />
      <BrowserDownloads :contents-id="contentsId" :claude-acting="!!control?.busy" />
      <Button
        v-if="control || log.length > 0"
        type="button"
        variant="ghost"
        size="icon-sm"
        :aria-label="logOpen ? 'Protokoll ausblenden' : unseenProblem ? 'Protokoll zeigen, neue Fehler' : 'Protokoll zeigen'"
        :title="logOpen ? 'Protokoll ausblenden' : unseenProblem ? 'Protokoll zeigen (neue Fehler)' : 'Protokoll zeigen'"
        :aria-pressed="logOpen"
        :class="cn('relative', logOpen && 'bg-muted text-foreground')"
        @click="logOpen = !logOpen"
      >
        <ScrollTextIcon />
        <span
          v-if="unseenProblem && !logOpen"
          aria-hidden="true"
          class="absolute top-1 right-1 size-1.5 rounded-full bg-destructive ring-2 ring-background"
        />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Im Standardbrowser öffnen"
        title="Im Standardbrowser öffnen"
        :disabled="!external"
        @click="openExternal"
      >
        <ExternalLinkIcon />
      </Button>
    </form>

    <div ref="pageArea" class="relative min-h-0 flex-1 overflow-hidden" :style="stageStyle">
      <!-- A page with a size of its own: its frame's shadow, unscaled, so it looks the same at any scale. -->
      <div
        v-if="frame"
        aria-hidden="true"
        class="absolute bg-background shadow-2xl ring-1 ring-foreground/10 animate-in fade-in zoom-in-95 duration-200"
        :style="frameBoxStyle"
      />
      <!--
        The page; this wrapper never goes, a view moved to another parent loads anew. With a size of
        its own the view has that size in the layout (the page's size) and is scaled down to fit.
      -->
      <div :class="cn('absolute overflow-hidden', !frame && 'inset-0')" :style="viewStyle">
        <!-- A click into the page reaches only the page: the view's own focus event says it was meant. -->
        <webview
          ref="view"
          class="absolute inset-0"
          :src="initialUrl"
          :partition="BROWSER_PARTITION"
          allowpopups
          @focus="onViewFocus"
        />
      </div>

      <!-- Over the page, in screen pixels: notices, where Claude acts and its pointer. -->
      <div :class="cn('pointer-events-none absolute z-10 overflow-hidden', !frame && 'inset-0')" :style="frameBoxStyle">
        <div
          v-if="blank"
          class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
          :style="{ background: containerBackground }"
        >
          <GlobeIcon class="size-8 opacity-50" />
          Adresse eingeben oder suchen
        </div>
        <div
          v-else-if="failure"
          class="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-sm"
          :style="{ background: containerBackground }"
        >
          <TriangleAlertIcon class="size-8 text-warning" />
          <p class="font-medium">Seite konnte nicht geladen werden</p>
          <p class="max-w-md break-all text-xs text-muted-foreground">{{ failure.url }} · {{ failure.description }}</p>
          <Button variant="outline" size="sm" @click="reload">Erneut versuchen</Button>
        </div>
        <BrowserLogin v-if="loginRequest" :request="loginRequest" :active="active" @answer="answerLogin" />

        <!-- Where Claude acts: the element and what it does. A click shows only its ripple at the pointer. -->
        <Transition leave-active-class="transition-opacity duration-500" leave-to-class="opacity-0">
          <div v-if="highlight" :key="highlight.seq" aria-hidden="true" class="absolute inset-0">
            <div
              v-if="highlight.rect && !highlight.click"
              class="absolute rounded-[4px] border-2 border-primary bg-primary/10 shadow-[0_0_0_4px] shadow-primary/20 animate-in fade-in zoom-in-95 duration-150"
              :style="{
                left: `${highlight.rect.x * shownScale - 2}px`,
                top: `${highlight.rect.y * shownScale - 2}px`,
                width: `${highlight.rect.width * shownScale + 4}px`,
                height: `${highlight.rect.height * shownScale + 4}px`,
              }"
            />
            <span
              v-if="!highlight.point"
              class="absolute max-w-[min(80%,28rem)] truncate rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground shadow-md animate-in fade-in duration-150"
              :style="labelStyle(highlight)"
            >
              {{ highlight.label }}
            </span>
          </div>
        </Transition>
        <!-- Claude's mouse pointer, with what it does next to it, and a ripple where it clicked. -->
        <div aria-hidden="true" class="absolute inset-0">
          <span
            v-if="pointerClick"
            :key="pointerClick.seq"
            class="absolute"
            :style="{ left: `${pointerClick.x * shownScale}px`, top: `${pointerClick.y * shownScale}px` }"
          >
            <!-- A light tint of Claude's color: it stands out on colored parts of the page too (a blue button). -->
            <span
              class="absolute size-11 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color-mix(in_oklab,color-mix(in_oklab,var(--primary)_60%,white)_85%,transparent)] opacity-0 animate-[browser-click_550ms_ease-out] motion-reduce:animate-[browser-click-fade_550ms_ease-out]"
            />
            <!-- The ring runs out past the tint; light seams and a shadow keep it visible on any page. -->
            <span
              class="absolute size-18 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-primary opacity-0 shadow-[0_0_0_1px_rgb(255_255_255/0.7),inset_0_0_0_1px_rgb(255_255_255/0.7),0_0_8px_rgb(0_0_0/0.25)] animate-[browser-click_800ms_ease-out_60ms] motion-reduce:hidden"
            />
          </span>
          <div
            class="absolute top-0 left-0"
            :style="{
              transform: `translate(${pointer.x * shownScale}px, ${pointer.y * shownScale}px)`,
              transition: `transform ${pointer.moveMs}ms cubic-bezier(0.45, 0.05, 0.25, 1), opacity 200ms`,
              opacity: pointer.shown ? 1 : 0,
            }"
          >
            <svg
              viewBox="0 0 20 24"
              :class="cn('-mt-0.5 -ml-0.5 block h-6 w-5 origin-top-left drop-shadow-md transition-transform duration-100', pointer.pressed && 'scale-[0.82]')"
            >
              <path
                d="M2 2 L2 19 L6.5 15 L9.5 21.5 L12 20.5 L9 14.2 L15 14.2 Z"
                class="fill-primary stroke-white"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
            </svg>
            <Transition leave-active-class="transition-opacity duration-500" leave-to-class="opacity-0">
              <span
                v-if="highlight?.point"
                :class="
                  cn(
                    'absolute w-max max-w-60 truncate rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground shadow-md',
                    pointer.labelLeft ? 'right-1' : 'left-3.5',
                    pointer.labelAbove ? 'bottom-1' : 'top-5',
                  )
                "
              >
                {{ highlight.label }}
              </span>
            </Transition>
          </div>
        </div>
        <!-- While Claude acts, the page has a frame in Claude's color. -->
        <div
          aria-hidden="true"
          :class="
            cn(
              'absolute inset-0 ring-2 ring-primary/50 ring-inset transition-opacity duration-300 [border-radius:inherit]',
              control?.busy ? 'opacity-100' : 'opacity-0',
            )
          "
        />
      </div>

      <!-- Above the page: the size Claude gave it and what Claude has it pretend, each with the way back. -->
      <div
        v-if="(frame && viewport) || emulation.length"
        class="pointer-events-none absolute left-1/2 z-20 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-2"
        :style="{ top: `${frame ? Math.max(8, frame.top - 34) : 8}px` }"
      >
        <div
          v-if="frame && viewport"
          class="pointer-events-auto flex min-w-0 items-center gap-1.5 rounded-full border bg-popover/90 py-0.5 pr-0.5 pl-2.5 text-[11px] text-popover-foreground shadow-sm backdrop-blur-md animate-in fade-in slide-in-from-bottom-1 duration-200"
        >
          <SmartphoneIcon v-if="frame.kind === 'phone'" class="size-3.5 shrink-0 text-muted-foreground" />
          <TabletIcon v-else-if="frame.kind === 'tablet'" class="size-3.5 shrink-0 text-muted-foreground" />
          <MonitorIcon v-else class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate font-medium tabular-nums">{{ viewport.width }} × {{ viewport.height }}</span>
          <span v-if="viewport.mobile" class="shrink-0 text-muted-foreground">· Mobil</span>
          <span v-if="frame.scale < 0.995" class="shrink-0 text-muted-foreground tabular-nums">· {{ Math.round(frame.scale * 100) }} %</span>
          <Button
            variant="ghost"
            size="icon-xs"
            class="shrink-0 rounded-full"
            aria-label="Originalgröße"
            title="Originalgröße wiederherstellen"
            @click="resetViewport"
          >
            <XIcon />
          </Button>
        </div>
        <div
          v-if="emulation.length"
          class="pointer-events-auto flex min-w-0 items-center gap-1.5 rounded-full border bg-popover/90 py-0.5 pr-0.5 pl-2.5 text-[11px] text-popover-foreground shadow-sm backdrop-blur-md animate-in fade-in slide-in-from-bottom-1 duration-200"
          :title="`Claude emuliert: ${emulation.join(', ')}`"
        >
          <FlaskConicalIcon class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate font-medium">{{ emulation.join(' · ') }}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            class="shrink-0 rounded-full"
            aria-label="Emulation beenden"
            title="Emulation beenden"
            @click="resetEmulation"
          >
            <XIcon />
          </Button>
        </div>
      </div>

      <!-- Claude's status over the page's foot: what it does, for which session, and the way to take over. -->
      <div v-if="control" class="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-6">
        <div
          :class="
            cn(
              'pointer-events-auto flex max-w-full min-w-0 items-center gap-3 rounded-full border bg-popover/90 p-1.5 text-xs text-popover-foreground shadow-lg backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-200',
              !statusCompact && 'min-w-72',
            )
          "
          @mouseenter="statusHover = true"
          @mouseleave="statusHover = false"
        >
          <span
            :class="
              cn(
                'relative flex size-7 shrink-0 items-center justify-center rounded-full',
                control.takenOver ? 'bg-warning/15 text-warning' : 'bg-primary/15 text-primary',
              )
            "
            :title="statusCompact ? `Claude · ${control.sessionTitle}` : undefined"
          >
            <span
              v-if="control.busy"
              aria-hidden="true"
              class="absolute -inset-px animate-spin rounded-full [background:conic-gradient(from_0deg,var(--primary),transparent_70%)] [mask:radial-gradient(farthest-side,transparent_calc(100%-2px),#000_calc(100%-1.5px))]"
            />
            <HandIcon v-if="control.takenOver" class="size-3.5" />
            <SparklesIcon v-else class="size-3.5" />
          </span>
          <template v-if="!statusCompact">
            <button
              type="button"
              class="flex min-w-0 flex-1 flex-col items-start gap-px pr-4 text-left leading-tight outline-none"
              :title="logOpen ? 'Protokoll ausblenden' : 'Protokoll zeigen'"
              @click="logOpen = !logOpen"
            >
              <!-- Transitions only: the shimmer is an animation without end, the swap would wait for it. -->
              <Transition
                type="transition"
                mode="out-in"
                enter-active-class="transition duration-200"
                enter-from-class="translate-y-1 opacity-0"
                leave-active-class="transition duration-100"
                leave-to-class="-translate-y-1 opacity-0"
              >
                <span
                  :key="control.takenOver ? 'taken' : (lastStep?.id ?? 'none')"
                  :class="cn('max-w-full truncate font-medium', control.busy && 'text-shimmer')"
                >
                  {{ control.takenOver ? 'Du steuerst' : (lastStep?.label ?? 'Bereit') }}
                </span>
              </Transition>
              <span class="max-w-full truncate text-[11px] text-muted-foreground">
                {{ control.takenOver ? 'Claude wartet' : 'Claude' }} · {{ control.sessionTitle }}
              </span>
            </button>
            <Button
              :variant="control.takenOver ? 'default' : 'secondary'"
              size="xs"
              class="shrink-0 rounded-full"
              :title="control.takenOver ? 'Claude darf den Browser wieder bedienen' : 'Selbst bedienen, Claude wartet so lange'"
              @click="takeOver"
            >
              <PlayIcon v-if="control.takenOver" data-icon="inline-start" />
              <HandIcon v-else data-icon="inline-start" />
              {{ control.takenOver ? 'Zurückgeben' : 'Übernehmen' }}
            </Button>
          </template>
        </div>
      </div>
      <!-- The search in the page, in its corner like Chrome's (clear of its scrollbar). -->
      <div v-if="findOpen" class="absolute top-2 right-5 z-20 max-w-[calc(100%-1.75rem)] animate-in fade-in slide-in-from-top-1 duration-150">
        <BrowserFind ref="findBar" :matches="findMatches" @search="search" @close="closeFind" />
      </div>
      <!-- Over the page's corner (clear of its scrollbar), until closed: it stays while Claude works and the user types elsewhere. -->
      <BrowserLog
        v-if="logOpen"
        :terminal-id="terminal.id"
        :class="
          cn(
            'absolute right-5 z-20 w-80 max-w-[calc(100%-1.75rem)] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl animate-in fade-in slide-in-from-top-1 duration-150',
            findOpen ? 'top-14 max-h-[min(30rem,calc(100%-4rem))]' : 'top-2 max-h-[min(30rem,calc(100%-1rem))]',
          )
        "
        @close="logOpen = false"
        @keydown.esc.stop="logOpen = false"
      />
    </div>

    <!-- In a split tab the parts without the keyboard step back; not the page Claude works on. -->
    <div
      aria-hidden="true"
      :class="cn('pointer-events-none absolute inset-0 z-20 transition-opacity duration-150', dimmed && !control?.active ? 'opacity-100' : 'opacity-0')"
      :style="{ background: inactiveVeil }"
    />
  </div>
</template>
