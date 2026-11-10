<script setup lang="ts">
import { DownloadIcon, FileDownIcon, FileIcon, FileXIcon, FolderOpenIcon, XIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import type { BrowserDownload, BrowserDownloadAction } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { attempt } from '@/lib/errors'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useBrowsersStore } from '@/stores/browsers'

/**
 * The browser's downloads, behind a button in the address bar of each browser: it shows while any
 * runs (with its progress) and once there are any. A download the user started in this pane opens
 * the list, like Chrome's; one of Claude's only marks the button.
 */
const props = defineProps<{ contentsId: number | null; claudeActing: boolean }>()

const browsers = useBrowsersStore()
const open = ref(false)
/** A download ended since the user last looked at the list. */
const unseen = ref(false)

/** Newest first. */
const list = computed(() => [...browsers.downloads].reverse())
const running = computed(() => browsers.downloads.filter((d) => d.state === 'progressing'))
/** Progress of what runs, 0–1; null while a size is unknown. */
const progress = computed(() => {
  const all = running.value
  if (all.length === 0 || all.some((d) => d.totalBytes <= 0)) return null
  const total = all.reduce((sum, d) => sum + d.totalBytes, 0)
  return all.reduce((sum, d) => sum + d.receivedBytes, 0) / total
})
const finished = computed(() => browsers.downloads.some((d) => d.state !== 'progressing'))

const RING = 2 * Math.PI * 9

watch(
  () => browsers.downloads.map((d) => `${d.id}:${d.state}`).join(),
  (_now, before) => {
    const known = new Set((before ?? '').split(',').map((entry) => entry.split(':')[0]))
    for (const download of browsers.downloads) {
      if (!known.has(download.id) && download.contentsId === props.contentsId && !props.claudeActing) open.value = true
    }
    if (!open.value && before !== undefined) unseen.value = true
  },
)
watch(open, (isOpen) => isOpen && (unseen.value = false))

function status(download: BrowserDownload): string {
  switch (download.state) {
    case 'progressing': {
      const received = formatBytes(download.receivedBytes)
      if (download.totalBytes <= 0) return received
      const percent = Math.floor((download.receivedBytes / download.totalBytes) * 100)
      return `${received} von ${formatBytes(download.totalBytes)} · ${percent} %`
    }
    case 'completed':
      return formatBytes(download.totalBytes || download.receivedBytes)
    case 'cancelled':
      return 'Abgebrochen'
    case 'interrupted':
      return 'Fehlgeschlagen'
  }
}

function act(download: BrowserDownload, action: BrowserDownloadAction) {
  const messages: Record<BrowserDownloadAction, string> = {
    open: 'Datei konnte nicht geöffnet werden',
    show: 'Ordner konnte nicht geöffnet werden',
    cancel: 'Download konnte nicht abgebrochen werden',
    remove: 'Download konnte nicht entfernt werden',
  }
  void attempt(() => browsers.downloadAction(download.id, action), messages[action])
}
</script>

<template>
  <Popover v-if="browsers.downloads.length > 0" v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        :aria-label="running.length ? `Downloads, ${running.length} laufen` : 'Downloads'"
        v-tooltip="running.length ? `Downloads (${running.length} laufen)` : 'Downloads'"
        :class="cn('relative', open && 'bg-muted text-foreground')"
      >
        <DownloadIcon :class="cn(running.length > 0 && 'text-primary')" />
        <!-- Around the icon: how far what runs has come, or a turning arc while its size is unknown. -->
        <svg v-if="running.length > 0" viewBox="0 0 22 22" aria-hidden="true" class="pointer-events-none absolute inset-0.5 -rotate-90">
          <circle cx="11" cy="11" r="9" fill="none" stroke-width="1.5" class="stroke-primary/20" />
          <circle
            cx="11"
            cy="11"
            r="9"
            fill="none"
            stroke-width="1.5"
            stroke-linecap="round"
            :class="cn('stroke-primary transition-[stroke-dashoffset] duration-300', progress === null && 'origin-center [transform-box:fill-box] animate-spin')"
            :stroke-dasharray="RING"
            :stroke-dashoffset="progress === null ? RING * 0.7 : RING * (1 - progress)"
          />
        </svg>
        <span
          v-else-if="unseen && finished"
          aria-hidden="true"
          class="absolute top-1 right-1 size-1.5 rounded-full bg-primary ring-2 ring-background"
        />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-80 gap-0 p-0 text-xs" @open-auto-focus.prevent>
      <div class="flex h-9 items-center gap-1 border-b pr-1 pl-3">
        <span class="font-medium">Downloads</span>
        <Button
          variant="ghost"
          size="xs"
          class="ml-auto text-muted-foreground"
          :disabled="!finished"
          v-tooltip="'Beendete Downloads aus der Liste nehmen, die Dateien bleiben'"
          @click="browsers.clearDownloads()"
        >
          Liste leeren
        </Button>
      </div>
      <ol class="max-h-80 overflow-y-auto py-1">
        <li v-for="download in list" :key="download.id" class="group flex items-center gap-2.5 px-3 py-2 hover:bg-muted/50">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none disabled:cursor-default"
            :disabled="download.state !== 'completed'"
            v-tooltip="download.state === 'completed' ? `${download.path} öffnen` : download.path"
            @click="act(download, 'open')"
          >
            <FileDownIcon v-if="download.state === 'progressing'" class="size-5 shrink-0 text-primary" />
            <FileIcon v-else-if="download.state === 'completed'" class="size-5 shrink-0 text-muted-foreground" />
            <FileXIcon v-else class="size-5 shrink-0 text-muted-foreground/60" />
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span :class="cn('truncate font-medium', download.state === 'cancelled' || download.state === 'interrupted' ? 'text-muted-foreground line-through' : '')">
                {{ download.filename }}
              </span>
              <span :class="cn('truncate text-[11px] text-muted-foreground tabular-nums', download.state === 'interrupted' && 'text-destructive')">
                {{ status(download) }}
              </span>
              <Progress
                v-if="download.state === 'progressing' && download.totalBytes > 0"
                :model-value="(download.receivedBytes / download.totalBytes) * 100"
                class="mt-0.5"
              />
            </span>
          </button>
          <Button
            v-if="download.state !== 'cancelled' && download.state !== 'interrupted'"
            variant="ghost"
            size="icon-xs"
            aria-label="Im Ordner zeigen"
            v-tooltip="'Im Ordner zeigen'"
            @click="act(download, 'show')"
          >
            <FolderOpenIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            :aria-label="download.state === 'progressing' ? 'Download abbrechen' : 'Aus der Liste nehmen'"
            v-tooltip="download.state === 'progressing' ? 'Download abbrechen' : 'Aus der Liste nehmen'"
            @click="act(download, download.state === 'progressing' ? 'cancel' : 'remove')"
          >
            <XIcon />
          </Button>
        </li>
      </ol>
    </PopoverContent>
  </Popover>
</template>
