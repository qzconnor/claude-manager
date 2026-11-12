<script setup lang="ts">
import {
  EllipsisIcon,
  FileJsonIcon,
  FolderOpenIcon,
  RotateCcwIcon,
  SearchIcon,
  ShareIcon,
  TriangleAlertIcon,
  XIcon,
} from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { contrastIssue, suggestedMode } from '@shared/themes/checks'
import { MAX_THEME_NAME_LENGTH, THEME_COLOR_KEYS, themeColor, themeContent, themeToFile, withThemeColor, type ThemeColorKey } from '@shared/themes/file'
import type { ThemeContent } from '@shared/themes/types'
import { searchTerms } from '@shared/utils'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import { useThemeActions } from '@/composables/useThemeActions'
import { toastError } from '@/lib/errors'
import { fileManagerLabel } from '@/lib/platform'
import { containsTerms, searchText } from '@/lib/search'
import { useSettingsStore } from '@/stores/settings'
import { useThemesStore } from '@/stores/themes'
import { useUiStore } from '@/stores/ui'
import { COLOR_SECTIONS } from '@/themes/color-info'
import ThemeColorRow from './ThemeColorRow.vue'
import ThemePreview from './ThemePreview.vue'
import ThemeSwatch from './ThemeSwatch.vue'

/**
 * Edits a theme of the user, or makes a new one from the colors of another. Every color with what
 * it is for, a search over them, a picker on each and a live preview. Nothing is written before
 * "Speichern". The dialog doesn't close by a click next to it; with changes not saved, Escape,
 * the X and "Abbrechen" ask first. While it is open its file may change in another program: without
 * changes here it is taken over, otherwise the dialog offers to.
 */
const ui = useUiStore()
const themes = useThemesStore()
const settings = useSettingsStore()
const actions = useThemeActions()

const open = computed(() => ui.themeEditorRequest !== null)
/** The theme's id; null while it is new (not saved yet). */
const editingId = ref<string | null>(null)
const draft = ref<ThemeContent>(themeContent(themes.find(null)))
/** The colors the dialog started with (or the file's, once saved or taken over): the rows go back to them. */
const original = ref<ThemeContent>(themeContent(themes.find(null)))
/** The draft as last saved or opened, to tell whether there are changes. */
const savedSnapshot = ref('')
const query = ref('')
const saving = ref(false)
const nameTouched = ref(false)
/** The file changed outside the dialog while it has changes of its own. */
const external = ref<{ kind: 'changed'; theme: ThemeContent } | { kind: 'deleted' } | { kind: 'broken'; error: string } | null>(null)

const snapshot = (theme: ThemeContent) => JSON.stringify(themeToFile({ ...theme, name: theme.name.trim() }))
const dirty = computed(() => snapshot(draft.value) !== savedSnapshot.value)

watch(
  () => ui.themeEditorRequest,
  (request) => {
    if (!request) return
    query.value = ''
    saving.value = false
    nameTouched.value = false
    external.value = null
    if (request.mode === 'edit') {
      const theme = themes.entry(request.id)?.theme
      if (!theme) {
        toast.error('Theme nicht gefunden', { description: 'Die Datei gibt es nicht mehr oder sie enthält Fehler.' })
        ui.themeEditorRequest = null
        return
      }
      editingId.value = request.id
      draft.value = themeContent(theme)
      original.value = themeContent(theme)
    } else {
      editingId.value = null
      draft.value = themeContent(request.from)
      original.value = themeContent(request.from)
    }
    // A new theme counts as changed only once something is changed: closing it right away doesn't ask.
    savedSnapshot.value = snapshot(draft.value)
  },
  { immediate: true },
)

/** The theme's file as the folder has it now; follows changes made in another program. */
const entry = computed(() => (editingId.value ? themes.entry(editingId.value) : undefined))
watch(entry, (next) => {
  if (!open.value || !editingId.value || saving.value || !themes.loaded) return
  if (!next) {
    external.value = { kind: 'deleted' }
    return
  }
  if (!next.theme) {
    external.value = { kind: 'broken', error: next.error ?? 'Die Datei lässt sich nicht lesen.' }
    return
  }
  const onDisk = themeContent(next.theme)
  if (snapshot(onDisk) === savedSnapshot.value) {
    external.value = null
    return
  }
  if (dirty.value) {
    external.value = { kind: 'changed', theme: onDisk }
    return
  }
  takeOver(onDisk)
})

function takeOver(theme: ThemeContent) {
  draft.value = themeContent(theme)
  original.value = themeContent(theme)
  savedSnapshot.value = snapshot(theme)
  external.value = null
}

const terms = computed(() => searchTerms(query.value))
const sections = computed(() =>
  COLOR_SECTIONS.map((section) => ({
    ...section,
    groups: section.groups
      .map((group) => ({
        ...group,
        colors: group.colors.filter(
          (info) =>
            terms.value.length === 0 ||
            containsTerms(
              searchText(info.label, info.key, info.description, group.title, section.title, themeColor(draft.value, info.key)),
              terms.value,
            ),
        ),
      }))
      .filter((group) => group.colors.length > 0),
  })).filter((section) => section.groups.length > 0),
)
const matches = computed(() => sections.value.reduce((n, s) => n + s.groups.reduce((m, g) => m + g.colors.length, 0), 0))

/** Every color of the draft, to pick one of them again in the picker. */
const swatches = computed(() => THEME_COLOR_KEYS.map((key) => themeColor(draft.value, key)))

function setColor(key: ThemeColorKey, value: string) {
  draft.value = withThemeColor(draft.value, key, value)
}

function contrastOf(key: ThemeColorKey): { ratio: number; label: string } | null {
  return contrastIssue(draft.value, key)
}

const MODES = [
  { value: 'dark', label: 'Dunkel' },
  { value: 'light', label: 'Hell' },
] as const

/** Text lighter than the background belongs to a dark theme; the mode says otherwise. */
const modeMismatch = computed(() => suggestedMode(draft.value))

const nameError = computed(() => {
  const name = draft.value.name.trim()
  if (!name) return 'Gib dem Theme einen Namen.'
  const lower = name.toLowerCase()
  const clash = themes.all.find((t) => t.id !== editingId.value && t.name.trim().toLowerCase() === lower)
  return clash ? `Ein Theme „${clash.name}“ gibt es schon.` : null
})

const title = computed(() => (editingId.value ? `„${original.value.name}“ bearbeiten` : 'Neues Theme'))
const fileName = computed(() => entry.value?.file.split(/[\\/]/).pop() ?? null)

function close() {
  ui.themeEditorRequest = null
}

/** Closes, after asking when there are changes not saved. */
async function requestClose() {
  if (dirty.value) {
    const ok = await ui.confirm({
      title: 'Änderungen verwerfen?',
      description: `Die Änderungen an „${draft.value.name.trim() || 'dem Theme'}“ sind noch nicht gespeichert.`,
      confirmText: 'Verwerfen',
      cancelText: 'Weiter bearbeiten',
      destructive: true,
    })
    if (!ok) return
  }
  close()
}

function onOpenChange(value: boolean) {
  if (!value) void requestClose()
}

function onEscape(event: KeyboardEvent) {
  event.preventDefault()
  // Escape in the search clears it first.
  if (query.value && document.activeElement === searchElement()) {
    query.value = ''
    return
  }
  void requestClose()
}

function searchElement(): HTMLInputElement | null {
  return document.getElementById('theme-color-search') as HTMLInputElement | null
}

function onKeydown(event: KeyboardEvent) {
  // Ctrl+F searches the colors, not the terminal behind the dialog.
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    event.stopPropagation()
    searchElement()?.focus()
    searchElement()?.select()
  }
}

function focusFirst(event: Event) {
  event.preventDefault()
  void nextTick(() => {
    if (editingId.value) {
      searchElement()?.focus()
    } else {
      const name = document.getElementById('theme-name') as HTMLInputElement | null
      name?.focus()
      name?.select()
    }
  })
}

/**
 * Saves the draft; a new theme becomes the app's theme. With `stay` the dialog stays open, e.g. to
 * open the file next to it. Resolves to the theme's id, or null when it wasn't saved.
 */
async function save(stay = false): Promise<string | null> {
  nameTouched.value = true
  if (nameError.value) {
    document.getElementById('theme-name')?.focus()
    return null
  }
  saving.value = true
  try {
    const content = { ...draft.value, name: draft.value.name.trim() }
    let id: string
    if (editingId.value) {
      const saved = await themes.save(editingId.value, content)
      id = saved.id
      if (!stay) toast.success(`Theme „${content.name}“ gespeichert`)
    } else {
      const created = await themes.create(content)
      id = created.id
      const previous = settings.settings.appearance.themeId
      await settings.update({ appearance: { themeId: id } })
      const before = themes.find(previous)
      toast.success(`Theme „${created.theme?.name ?? content.name}“ angelegt`, {
        description: 'Die App nutzt es jetzt.',
        action: { label: `Zurück zu ${before.name}`, onClick: () => void settings.update({ appearance: { themeId: before.id } }) },
      })
    }
    if (stay) {
      editingId.value = id
      const saved = themes.entry(id)?.theme
      takeOver(saved ? themeContent(saved) : content)
    } else {
      close()
    }
    return id
  } catch (error) {
    toastError(error, 'Theme nicht gespeichert')
    return null
  } finally {
    saving.value = false
  }
}

/** The theme's id once it is saved as it is now; asks first when there is something to save. */
async function savedId(purpose: string): Promise<string | null> {
  if (editingId.value && !dirty.value && entry.value?.theme) return editingId.value
  const ok = await ui.confirm({
    title: editingId.value ? 'Änderungen speichern?' : 'Theme anlegen?',
    description: `${purpose} braucht die Datei mit dem Stand von hier. ${
      editingId.value ? 'Die Änderungen werden dafür gespeichert.' : 'Das Theme wird dafür angelegt und von der App genutzt.'
    }`,
    confirmText: editingId.value ? 'Speichern' : 'Anlegen',
  })
  return ok ? save(true) : null
}

async function openJson() {
  const id = await savedId('Das Bearbeiten als JSON')
  if (id) await actions.openFile(id)
}

async function showInFolder() {
  const id = await savedId(`Das Zeigen im ${fileManagerLabel}`)
  if (id) await actions.showFile(id)
}

async function exportFile() {
  const id = await savedId('Der Export')
  if (id) await actions.exportTheme(id)
}

function resetAll() {
  draft.value = { ...themeContent(original.value), name: draft.value.name }
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent
      :show-close-button="false"
      class="flex h-[min(54rem,calc(100vh-4rem))] w-[min(76rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      @pointer-down-outside.prevent
      @interact-outside.prevent
      @escape-key-down="onEscape"
      @open-auto-focus="focusFirst"
      @keydown="onKeydown"
    >
      <header class="flex items-start gap-3 border-b px-4 py-3">
        <div class="min-w-0 flex-1">
          <DialogTitle class="truncate">{{ title }}</DialogTitle>
          <DialogDescription>
            Jede Farbe steht mit ihrer Aufgabe da, die Vorschau zeigt Änderungen sofort. Gespeichert wird erst mit „{{ editingId ? 'Speichern' : 'Anlegen' }}“.
          </DialogDescription>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon-sm" v-tooltip="'Weitere Aktionen'">
              <EllipsisIcon />
              <span class="sr-only">Weitere Aktionen</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-56">
            <DropdownMenuItem @select="openJson"><FileJsonIcon /> Als JSON bearbeiten</DropdownMenuItem>
            <DropdownMenuItem @select="showInFolder"><FolderOpenIcon /> Im {{ fileManagerLabel }} zeigen</DropdownMenuItem>
            <DropdownMenuItem @select="exportFile"><ShareIcon /> Exportieren…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem :disabled="snapshot({ ...draft, name: original.name }) === snapshot(original)" @select="resetAll">
              <RotateCcwIcon /> Alle Farben zurücksetzen
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon-sm" v-tooltip="'Schließen'" @click="requestClose">
          <XIcon />
          <span class="sr-only">Schließen</span>
        </Button>
      </header>

      <div
        v-if="external"
        role="status"
        class="flex items-center gap-2 border-b bg-warning/10 px-4 py-2 text-xs text-warning"
      >
        <TriangleAlertIcon class="size-4 shrink-0" />
        <span class="min-w-0 flex-1">
          <template v-if="external.kind === 'changed'">Die Datei wurde in einem anderen Programm geändert.</template>
          <template v-else-if="external.kind === 'deleted'">Die Datei wurde gelöscht. Speichern legt sie wieder an.</template>
          <template v-else>Die Datei enthält jetzt Fehler: {{ external.error }} Speichern überschreibt sie mit dem Stand von hier.</template>
        </span>
        <Button v-if="external.kind === 'changed'" size="xs" variant="outline" @click="takeOver(external.theme)">Stand der Datei übernehmen</Button>
      </div>

      <div class="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
        <section class="flex min-h-0 flex-col md:border-r">
          <div class="flex flex-col gap-3 border-b p-4">
            <div class="flex flex-wrap items-start gap-3">
              <Field class="min-w-48 flex-1">
                <FieldLabel for="theme-name">Name</FieldLabel>
                <Input
                  id="theme-name"
                  v-model="draft.name"
                  :maxlength="MAX_THEME_NAME_LENGTH"
                  :aria-invalid="nameTouched && !!nameError"
                  autocomplete="off"
                  @blur="nameTouched = true"
                />
                <FieldError v-if="nameTouched && nameError">{{ nameError }}</FieldError>
              </Field>
              <Field class="w-auto">
                <FieldLabel>Art</FieldLabel>
                <SegmentedControl v-model="draft.mode" :options="MODES" aria-label="Hell oder dunkel" />
              </Field>
            </div>
            <p v-if="modeMismatch" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-warning">
              <TriangleAlertIcon class="size-3.5 shrink-0" />
              <span class="flex-1">
                Der Text ist {{ modeMismatch === 'dark' ? 'heller' : 'dunkler' }} als der Hintergrund, das passt zu einem
                {{ modeMismatch === 'dark' ? 'dunklen' : 'hellen' }} Theme. Die Art bestimmt das Fenstermaterial, die gemischten Flächen und
                was Claude Codes Theme „Auto“ wählt.
              </span>
              <Button size="xs" variant="outline" @click="draft.mode = modeMismatch">Auf „{{ modeMismatch === 'dark' ? 'Dunkel' : 'Hell' }}“ stellen</Button>
            </p>
            <InputGroup>
              <InputGroupAddon><SearchIcon /></InputGroupAddon>
              <InputGroupInput
                id="theme-color-search"
                v-model="query"
                placeholder="Farben suchen: Name, Zweck, JSON-Pfad oder Wert"
                aria-label="Farben suchen"
                autocomplete="off"
                spellcheck="false"
              />
              <InputGroupAddon align="inline-end">
                <span v-if="query" class="text-xs tabular-nums">{{ matches }}</span>
                <InputGroupButton v-if="query" size="icon-xs" aria-label="Suche leeren" @click="query = ''"><XIcon /></InputGroupButton>
                <Kbd v-else>Strg+F</Kbd>
              </InputGroupAddon>
            </InputGroup>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
            <template v-for="section in sections" :key="section.id">
              <div class="sticky top-0 z-10 border-b bg-popover px-2 pt-4 pb-2">
                <h3 class="text-sm font-semibold">{{ section.title }}</h3>
                <p class="text-xs text-muted-foreground">{{ section.description }}</p>
              </div>
              <div v-for="group in section.groups" :key="group.id">
                <h4 class="px-2 pt-4 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{{ group.title }}</h4>
                <ThemeColorRow
                  v-for="info in group.colors"
                  :key="info.key"
                  :info="info"
                  :model-value="themeColor(draft, info.key)"
                  :original="themeColor(original, info.key)"
                  :terms="terms"
                  :swatches="swatches"
                  :contrast="contrastOf(info.key)"
                  @update:model-value="setColor(info.key, $event)"
                />
              </div>
            </template>
            <p v-if="sections.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground">
              Keine Farbe passt zu „{{ query }}“.
            </p>
          </div>
        </section>

        <aside class="hidden min-h-0 flex-col gap-4 overflow-y-auto bg-muted/30 p-4 md:flex">
          <div class="flex flex-col gap-2">
            <h3 class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Vorschau</h3>
            <ThemePreview :theme="draft" />
          </div>
          <div class="flex flex-col gap-2">
            <h3 class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">In der Auswahl</h3>
            <div class="w-44 overflow-hidden rounded-xl ring-1 ring-foreground/10">
              <ThemeSwatch :theme="draft" />
              <div class="flex items-center justify-between gap-2 border-t bg-card px-3 py-2">
                <span class="truncate text-sm font-medium">{{ draft.name.trim() || 'Ohne Namen' }}</span>
                <span class="text-xs text-muted-foreground">{{ draft.mode === 'dark' ? 'Dunkel' : 'Hell' }}</span>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <footer class="flex items-center gap-3 border-t px-4 py-3">
        <span class="min-w-0 truncate text-xs text-muted-foreground">
          <template v-if="!editingId">Neu, wird erst mit „Anlegen“ gespeichert</template>
          <template v-else-if="dirty">Nicht gespeicherte Änderungen</template>
          <template v-else-if="fileName">
            Gespeichert in <code class="font-mono" v-tooltip="entry?.file">themes/{{ fileName }}</code>
          </template>
        </span>
        <div class="ml-auto flex gap-2">
          <Button variant="outline" @click="requestClose">Abbrechen</Button>
          <Button :disabled="saving || (!!editingId && !dirty && !external)" @click="save()">
            <Spinner v-if="saving" data-icon="inline-start" />
            {{ editingId ? 'Speichern' : 'Anlegen' }}
          </Button>
        </div>
      </footer>
    </DialogContent>
  </Dialog>
</template>
