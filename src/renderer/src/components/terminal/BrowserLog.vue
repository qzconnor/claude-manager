<script setup lang="ts">
import { CheckIcon, ShieldAlertIcon, Trash2Icon, TriangleAlertIcon, XIcon } from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import type { BrowserActivity } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useBrowsersStore } from '@/stores/browsers'

/** What Claude did in a browser, floating over its page: newest at the bottom, like the terminal. */
const props = defineProps<{ terminalId: string }>()
const emit = defineEmits<{ close: [] }>()

const browsers = useBrowsersStore()
const list = ref<HTMLElement | null>(null)
/** A screenshot shown in full size; the others as small pictures. */
const enlarged = ref<number | null>(null)
/** Only what reached beyond the page: uploads, cookies, request contents, scripts, deleted data. */
const onlySensitive = ref(false)

const all = computed<BrowserActivity[]>(() => browsers.logs.get(props.terminalId) ?? [])
const sensitiveCount = computed(() => all.value.filter((entry) => entry.sensitive).length)
const entries = computed(() => (onlySensitive.value ? all.value.filter((entry) => entry.sensitive) : all.value))

// Nothing left to filter for: the whole log again.
watch(sensitiveCount, (count) => {
  if (count === 0) onlySensitive.value = false
})

const time = (at: string) => new Date(at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function duration(ms: number | null): string | null {
  if (ms === null || ms < 100) return null
  return ms < 10_000 ? `${(ms / 1000).toFixed(1).replace('.', ',')} s` : `${Math.round(ms / 1000)} s`
}

// The newest line stays in view, unless the user scrolled up to read.
watch(
  () => entries.value.length,
  async () => {
    const el = list.value
    const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40
    await nextTick()
    if (atBottom && list.value) list.value.scrollTop = list.value.scrollHeight
  },
  { immediate: true },
)
</script>

<template>
  <aside class="flex min-h-0 flex-col text-xs" aria-label="Protokoll von Claude">
    <div class="flex h-8 shrink-0 items-center gap-1 border-b pr-1 pl-3">
      <span class="font-medium">Protokoll</span>
      <span class="text-muted-foreground tabular-nums">{{ all.length }}</span>
      <Button
        v-if="sensitiveCount > 0"
        variant="ghost"
        size="xs"
        :class="
          cn('ml-auto gap-1 px-1.5 tabular-nums', onlySensitive && 'bg-warning/15 text-warning hover:bg-warning/20 hover:text-warning')
        "
        :aria-pressed="onlySensitive"
        v-tooltip="
          onlySensitive
            ? 'Wieder alles zeigen'
            : 'Nur heikle Zugriffe: hochgeladene Dateien, Cookies und Speicher, Inhalte von Anfragen, Skripte, gelöschte Daten'
        "
        @click="onlySensitive = !onlySensitive"
      >
        <ShieldAlertIcon />
        {{ sensitiveCount }}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        :class="sensitiveCount > 0 ? '' : 'ml-auto'"
        aria-label="Protokoll leeren"
        v-tooltip="'Protokoll leeren'"
        :disabled="all.length === 0"
        @click="browsers.clearLog(terminalId)"
      >
        <Trash2Icon />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Protokoll schließen" v-tooltip="'Protokoll schließen'" @click="emit('close')">
        <XIcon />
      </Button>
    </div>
    <ol ref="list" class="min-h-0 flex-1 overflow-y-auto py-1">
      <li v-if="entries.length === 0" class="px-3 py-6 text-center text-muted-foreground">
        Hier erscheint, was Claude im Browser tut.
      </li>
      <li
        v-for="entry in entries"
        :key="entry.id"
        :class="cn('flex gap-2 px-3 py-1.5', entry.status === 'warning' && 'bg-warning/5', entry.status === 'error' && 'bg-destructive/5')"
      >
        <span class="mt-px flex size-4 shrink-0 items-center justify-center">
          <Spinner v-if="entry.status === 'running'" class="size-3.5 text-muted-foreground" />
          <CheckIcon v-else-if="entry.status === 'done'" class="size-3.5 text-success" />
          <TriangleAlertIcon v-else-if="entry.status === 'warning'" class="size-3.5 text-warning" />
          <XIcon v-else class="size-3.5 text-destructive" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span :class="cn('min-w-0 flex-1 break-words', entry.kind === 'control' && 'text-muted-foreground italic')">
              <ShieldAlertIcon
                v-if="entry.sensitive"
                class="mr-1 -mt-0.5 inline size-3.5 text-warning"
                aria-label="Heikler Zugriff"
                v-tooltip="'Heikler Zugriff: reicht über die Seite hinaus'"
              />{{ entry.label }}
            </span>
            <span class="shrink-0 text-[10px] text-muted-foreground tabular-nums">
              <template v-if="duration(entry.durationMs)">{{ duration(entry.durationMs) }} · </template>{{ time(entry.at) }}
            </span>
          </div>
          <p
            v-if="entry.detail"
            :class="cn('mt-0.5 line-clamp-3 break-words text-muted-foreground', entry.status === 'error' && 'text-destructive')"
            v-tooltip="entry.detail"
          >
            {{ entry.detail }}
          </p>
          <button
            v-if="entry.image"
            type="button"
            class="mt-1.5 block overflow-hidden rounded-md border"
            :aria-label="enlarged === entry.id ? 'Screenshot verkleinern' : 'Screenshot vergrößern'"
            @click="enlarged = enlarged === entry.id ? null : entry.id"
          >
            <img :src="entry.image" alt="Screenshot" :class="cn('block', enlarged === entry.id ? 'w-full' : 'max-h-28 w-auto')" draggable="false" />
          </button>
        </div>
      </li>
    </ol>
  </aside>
</template>
