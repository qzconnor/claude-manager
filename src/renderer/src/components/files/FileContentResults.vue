<script setup lang="ts">
import { ChevronRightIcon } from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import type { ContentSearchResult } from '@shared/types'
import { fileIcon } from '@/lib/file-icons'
import { baseName, parentPath } from '@/lib/file-tree'
import { cn } from '@/lib/utils'
import { splitByRanges } from '@/lib/word-diff'
import { useSettingsStore } from '@/stores/settings'

/**
 * What the content search of a file tree found: each file with its lines, the hits marked, like VS
 * Code's search. A click on a line shows it in the file's changes (the whole file), a double click or
 * Enter in a tab that stays. The keyboard moves as in the tree.
 */
const props = defineProps<{ result: ContentSearchResult }>()
const emit = defineEmits<{
  open: [path: string, line: number, keep: boolean]
  /** A letter typed in the list goes to the search. */
  type: [key: string]
  /** Escape: back to the search. */
  leave: []
}>()

const settings = useSettingsStore()
/** Like the tree's rows. */
const rowHeight = computed(() => Math.round(settings.settings.appearance.uiFontSize * 1.86))

const collapsed = ref(new Set<string>())
watch(
  () => props.result,
  () => (collapsed.value = new Set()),
)

/** A row: a file (`line` 0) or one of its lines. */
interface Item {
  key: string
  path: string
  line: number
}
const keyOf = (path: string, line: number) => `${path}\0${line}`
const items = computed<Item[]>(() =>
  props.result.files.flatMap((file) => [
    { key: keyOf(file.path, 0), path: file.path, line: 0 },
    ...(collapsed.value.has(file.path) ? [] : file.matches.map((m) => ({ key: keyOf(file.path, m.line), path: file.path, line: m.line }))),
  ]),
)

const selected = ref<string | null>(null)
const focused = ref(false)
const list = ref<HTMLElement | null>(null)

function select(item: Item | undefined) {
  if (!item) return
  selected.value = item.key
  void nextTick(() => list.value?.querySelector(`[data-key="${CSS.escape(item.key)}"]`)?.scrollIntoView({ block: 'nearest' }))
}

function toggle(path: string, open?: boolean) {
  const next = new Set(collapsed.value)
  if (open ?? next.has(path)) next.delete(path)
  else next.add(path)
  collapsed.value = next
}

function onFileClick(path: string) {
  selected.value = keyOf(path, 0)
  toggle(path)
}

function onLineClick(path: string, line: number, keep: boolean) {
  selected.value = keyOf(path, line)
  emit('open', path, line, keep)
}

/** From the search: the first line found gets the keyboard. */
function focusFirst() {
  select(items.value.find((item) => item.line > 0) ?? items.value[0])
  list.value?.focus()
}
defineExpose({ focusFirst })

function onKeydown(event: KeyboardEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey) return
  const all = items.value
  const index = all.findIndex((item) => item.key === selected.value)
  const current = all[index]
  const page = Math.max(1, Math.floor((list.value?.clientHeight ?? 0) / rowHeight.value) - 1)
  const moveTo = (i: number) => select(all[Math.max(0, Math.min(all.length - 1, i))])
  switch (event.key) {
    case 'ArrowDown':
      moveTo(index + 1)
      break
    case 'ArrowUp':
      moveTo(index === -1 ? all.length - 1 : index - 1)
      break
    case 'PageDown':
      moveTo(index + page)
      break
    case 'PageUp':
      moveTo(index - page)
      break
    case 'Home':
      moveTo(0)
      break
    case 'End':
      moveTo(all.length - 1)
      break
    case 'ArrowRight':
      if (current?.line === 0) {
        if (collapsed.value.has(current.path)) toggle(current.path, true)
        else moveTo(index + 1)
      }
      break
    case 'ArrowLeft':
      if (!current) break
      if (current.line > 0) select(all.find((item) => item.path === current.path && item.line === 0))
      else toggle(current.path, false)
      break
    case 'Enter':
      if (!current) return
      if (current.line === 0) toggle(current.path)
      else emit('open', current.path, current.line, true)
      break
    case 'Escape':
      emit('leave')
      break
    default:
      if (event.key.length === 1 && event.key !== ' ') {
        emit('type', event.key)
        break
      }
      return
  }
  event.preventDefault()
}

const row = 'mx-[6px] flex cursor-pointer items-center rounded-md pr-1.5'
const rowState = (key: string) =>
  selected.value === key
    ? cn('bg-foreground/8 shadow-sm ring-1', focused.value ? 'ring-ring/60' : 'ring-foreground/12')
    : 'hover:bg-foreground/5'
</script>

<template>
  <div
    ref="list"
    role="tree"
    aria-label="Treffer"
    tabindex="0"
    class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-2 text-sm outline-none"
    @keydown="onKeydown"
    @focus="focused = true"
    @blur="focused = false"
  >
    <template v-for="file in result.files" :key="file.path">
      <div
        role="treeitem"
        aria-level="1"
        :aria-expanded="!collapsed.has(file.path)"
        :aria-selected="selected === keyOf(file.path, 0)"
        :data-key="keyOf(file.path, 0)"
        :class="cn(row, 'pl-1.5', rowState(keyOf(file.path, 0)))"
        :style="{ height: `${rowHeight}px` }"
        @click="onFileClick(file.path)"
      >
        <ChevronRightIcon
          :class="cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-150', !collapsed.has(file.path) && 'rotate-90')"
        />
        <component
          :is="fileIcon(file.path, { dir: false, link: false, broken: false }).icon"
          :class="cn('ml-1 size-[15px] shrink-0', fileIcon(file.path, { dir: false, link: false, broken: false }).class)"
        />
        <span class="ml-2 shrink-0 truncate">{{ baseName(file.path) }}</span>
        <span class="ml-2 min-w-0 flex-1 truncate text-xs text-muted-foreground" v-tooltip="file.path">{{ parentPath(file.path) }}</span>
        <span class="ml-2 shrink-0 rounded-full bg-foreground/8 px-1.5 text-[11px] text-muted-foreground tabular-nums">{{ file.matches.length }}</span>
      </div>
      <template v-if="!collapsed.has(file.path)">
        <div
          v-for="match in file.matches"
          :key="match.line"
          role="treeitem"
          aria-level="2"
          :aria-selected="selected === keyOf(file.path, match.line)"
          :aria-label="`Zeile ${match.line}: ${match.text}`"
          :data-key="keyOf(file.path, match.line)"
          :class="cn(row, 'pl-[28px]', rowState(keyOf(file.path, match.line)))"
          :style="{ height: `${rowHeight}px` }"
          @click="onLineClick(file.path, match.line, false)"
          @dblclick="onLineClick(file.path, match.line, true)"
        >
          <span class="mr-2 w-[4ch] shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">{{ match.line }}</span>
          <span class="min-w-0 flex-1 truncate font-mono text-xs whitespace-pre"
            ><template v-for="(part, i) in splitByRanges(match.text, match.ranges)" :key="i"
              ><mark v-if="part.changed" class="rounded-[3px] bg-primary/25 text-inherit">{{ part.text }}</mark
              ><template v-else>{{ part.text }}</template></template
            ></span
          >
        </div>
      </template>
    </template>
  </div>
</template>
