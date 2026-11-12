<script setup lang="ts">
import {
  CheckIcon,
  CopyIcon,
  EllipsisIcon,
  FileJsonIcon,
  FolderOpenIcon,
  ImportIcon,
  PencilIcon,
  PlusIcon,
  ShareIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from '@lucide/vue'
import { computed, ref } from 'vue'
import { THEMES } from '@shared/themes/builtin'
import { customThemeStem } from '@shared/themes/file'
import type { AppTheme } from '@shared/themes/types'
import ThemeSwatch from '@/components/themes/ThemeSwatch.vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useThemeActions } from '@/composables/useThemeActions'
import { fileManagerLabel } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useThemesStore } from '@/stores/themes'

/**
 * The built-in themes and the user's own (files in the themes folder, which show as soon as they
 * are there). Built-in themes can be copied to change them; own ones edited, opened as JSON,
 * exported and deleted. Theme files dropped here are imported.
 */
const model = defineModel<string>({ required: true })
const themes = useThemesStore()
const actions = useThemeActions()

const broken = computed(() => themes.entries.filter((e) => !e.theme))
/** The chosen theme's file is gone (deleted, renamed): the default theme shows until it is back. */
const missing = computed(() => {
  const stem = customThemeStem(model.value)
  return stem && !themes.exists(model.value) ? stem : null
})
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path

const dropping = ref(false)
let dragDepth = 0

function hasFiles(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes('Files')
}
function onDragEnter(event: DragEvent) {
  if (!hasFiles(event)) return
  dragDepth++
  dropping.value = true
}
function onDragLeave(event: DragEvent) {
  if (!hasFiles(event)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dropping.value = false
}
function onDrop(event: DragEvent) {
  dragDepth = 0
  dropping.value = false
  const files = [...(event.dataTransfer?.files ?? [])].map((file) => window.api.app.pathForFile(file)).filter(Boolean)
  if (files.length) void actions.importThemes(files)
}

const cardClass = (theme: AppTheme) =>
  cn(
    'flex w-full flex-col overflow-hidden rounded-xl text-left ring-1 ring-foreground/10 transition outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
    model.value === theme.id ? 'ring-2 ring-primary' : 'hover:ring-foreground/25',
  )
const menuButtonClass =
  'absolute top-1.5 right-1.5 bg-background/80 opacity-0 backdrop-blur-sm transition-opacity group-hover/theme:opacity-100 group-focus-within/theme:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100'
</script>

<template>
  <div class="flex flex-col gap-5">
    <p v-if="missing" role="status" class="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
      <TriangleAlertIcon class="size-4 shrink-0" />
      <span>
        Das gewählte Theme „{{ missing }}“ gibt es nicht mehr, seine Datei wurde gelöscht oder umbenannt. Bis sie wieder da ist, gilt
        {{ themes.find(model).name }}.
      </span>
    </p>

    <div role="radiogroup" aria-label="Eingebaute Themes" class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
      <div v-for="theme in THEMES" :key="theme.id" class="group/theme relative">
        <button type="button" role="radio" :aria-checked="model === theme.id" :class="cardClass(theme)" @click="model = theme.id">
          <!-- Preview: the theme's own colors, independent of the active theme. -->
          <ThemeSwatch :theme="theme" />
          <div class="flex items-center justify-between gap-2 border-t bg-card px-3 py-2">
            <span class="truncate text-sm font-medium">{{ theme.name }}</span>
            <CheckIcon v-if="model === theme.id" class="size-4 shrink-0 text-primary" />
            <span v-else class="text-xs text-muted-foreground">{{ theme.mode === 'dark' ? 'Dunkel' : 'Hell' }}</span>
          </div>
        </button>
        <Button variant="ghost" size="icon-xs" :class="menuButtonClass" v-tooltip="'Als eigenes Theme kopieren und bearbeiten'" @click="actions.copy(theme)">
          <CopyIcon />
          <span class="sr-only">„{{ theme.name }}“ kopieren und bearbeiten</span>
        </Button>
      </div>
    </div>

    <div
      data-setting="appearance.customThemes"
      :class="cn('relative flex flex-col gap-3 rounded-xl transition', dropping && 'ring-2 ring-primary ring-offset-4 ring-offset-card')"
      @dragenter="onDragEnter"
      @dragleave="onDragLeave"
      @dragover.prevent
      @drop.prevent="onDrop"
    >
      <div class="flex items-center gap-2">
        <h3 class="text-sm font-medium">Eigene Themes</h3>
        <span v-if="themes.entries.length" class="text-xs text-muted-foreground tabular-nums">{{ themes.entries.length }}</span>
        <Button size="sm" variant="ghost" class="ml-auto" @click="actions.importThemes()">
          <ImportIcon data-icon="inline-start" />
          Importieren
        </Button>
      </div>

      <div role="radiogroup" aria-label="Eigene Themes" class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        <div v-for="theme in themes.custom" :key="theme.id" class="group/theme relative">
          <button
            type="button"
            role="radio"
            :aria-checked="model === theme.id"
            :class="cardClass(theme)"
            @click="model = theme.id"
            @dblclick="actions.edit(theme.id)"
          >
            <ThemeSwatch :theme="theme" />
            <div class="flex items-center justify-between gap-2 border-t bg-card px-3 py-2">
              <span class="truncate text-sm font-medium">{{ theme.name }}</span>
              <CheckIcon v-if="model === theme.id" class="size-4 shrink-0 text-primary" />
              <span v-else class="text-xs text-muted-foreground">{{ theme.mode === 'dark' ? 'Dunkel' : 'Hell' }}</span>
            </div>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-xs" :class="menuButtonClass">
                <EllipsisIcon />
                <span class="sr-only">Aktionen für „{{ theme.name }}“</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-52">
              <DropdownMenuItem @select="actions.edit(theme.id)"><PencilIcon /> Bearbeiten</DropdownMenuItem>
              <DropdownMenuItem @select="actions.copy(theme)"><CopyIcon /> Kopieren</DropdownMenuItem>
              <DropdownMenuItem @select="actions.openFile(theme.id)"><FileJsonIcon /> Als JSON bearbeiten</DropdownMenuItem>
              <DropdownMenuItem @select="actions.showFile(theme.id)"><FolderOpenIcon /> Im {{ fileManagerLabel }} zeigen</DropdownMenuItem>
              <DropdownMenuItem @select="actions.exportTheme(theme.id)"><ShareIcon /> Exportieren…</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" @select="actions.remove(theme.id)"><Trash2Icon /> Löschen</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <!-- Files that can't be used, e.g. after editing them by hand: why, and what can be done. -->
        <div
          v-for="entry in broken"
          :key="entry.id"
          class="group/theme relative flex flex-col overflow-hidden rounded-xl ring-1 ring-destructive/40"
        >
          <div class="flex h-20 items-start gap-2 bg-destructive/5 p-3 pr-9 text-xs text-destructive" v-tooltip="entry.error ?? ''">
            <TriangleAlertIcon class="size-4 shrink-0" />
            <span class="line-clamp-3 [overflow-wrap:anywhere]">{{ entry.error }}</span>
          </div>
          <div class="flex items-center justify-between gap-2 border-t bg-card px-3 py-2">
            <span class="truncate font-mono text-xs" v-tooltip="entry.file">{{ fileName(entry.file) }}</span>
            <span class="shrink-0 text-xs text-destructive">Fehlerhaft</span>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-xs" class="absolute top-1.5 right-1.5">
                <EllipsisIcon />
                <span class="sr-only">Aktionen für {{ fileName(entry.file) }}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-52">
              <DropdownMenuItem @select="actions.openFile(entry.id)"><FileJsonIcon /> Als JSON bearbeiten</DropdownMenuItem>
              <DropdownMenuItem @select="actions.showFile(entry.id)"><FolderOpenIcon /> Im {{ fileManagerLabel }} zeigen</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" @select="actions.remove(entry.id)"><Trash2Icon /> Löschen</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <button
          type="button"
          class="flex min-h-[7.25rem] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-foreground/20 p-3 text-sm text-muted-foreground transition outline-none hover:border-foreground/40 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          @click="actions.createNew()"
        >
          <PlusIcon class="size-5" />
          Neues Theme
        </button>
      </div>

      <div
        v-if="dropping"
        class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-background/70 text-sm font-medium backdrop-blur-[2px]"
      >
        Zum Importieren loslassen
      </div>
    </div>
  </div>
</template>
