<script setup lang="ts">
import { ArrowRightIcon, ShieldAlertIcon } from '@lucide/vue'
import { computed, ref, toRaw, watch } from 'vue'
import { toast } from 'vue-sonner'
import type { SettingChange, SettingsImportPreview } from '@shared/types'
import { settingsPatch } from '@shared/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { attempt, toastError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { groupChanges, settingValueText, THEME_SETTINGS } from '@/lib/setting-changes'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings'
import { useThemesStore } from '@/stores/themes'

/**
 * What a settings file would change, setting by setting with the value now and the one from the file.
 * Everything is chosen except what decides what runs or what Claude may do without asking.
 */
const props = defineProps<{ preview: SettingsImportPreview | null }>()
const open = defineModel<boolean>('open', { required: true })

const settings = useSettingsStore()
const themes = useThemesStore()
const selected = ref(new Set<string>())
const applying = ref(false)

const changes = computed(() => props.preview?.changes ?? [])
const groups = computed(() => groupChanges(changes.value, window.api.platform))
const sensitiveCount = computed(() => changes.value.filter((change) => change.sensitive).length)
const chosen = computed(() => changes.value.filter((change) => selected.value.has(change.path)))
const allChosen = computed(() => chosen.value.length === changes.value.length)

/** A theme this computer doesn't have: the app would show its default theme instead. */
const missingTheme = (change: SettingChange) =>
  THEME_SETTINGS.includes(change.path) && typeof change.to === 'string' && !themes.exists(change.to)
/** Chosen at first: everything but what is sensitive and themes missing here. */
const preselected = (change: SettingChange) => !change.sensitive && !missingTheme(change)

watch(
  () => [open.value, props.preview] as const,
  ([isOpen]) => {
    if (isOpen) selected.value = new Set(changes.value.filter(preselected).map((change) => change.path))
  },
  { immediate: true },
)

const source = computed(() => {
  const preview = props.preview
  if (!preview) return ''
  const when = preview.exportedAt ? `, exportiert am ${formatDateTime(preview.exportedAt)}` : ''
  const version = preview.appVersion ? ` mit Version ${preview.appVersion}` : ''
  return `„${preview.fileName}“${when}${when ? version : ''}.`
})

const themeName = (id: string) => (themes.exists(id) ? themes.find(id).name : null)
const text = (path: string, value: unknown) => settingValueText(path, value, themeName)
/** Long values (a path, a font) are cut, the tooltip has all of it. Sensitive ones are shown whole. */
const full = (value: string) => (value.length > 32 ? value : null)

function toggle(path: string, checked: boolean) {
  const next = new Set(selected.value)
  if (checked) next.add(path)
  else next.delete(path)
  selected.value = next
}

function toggleAll() {
  selected.value = allChosen.value ? new Set() : new Set(changes.value.map((change) => change.path))
}

async function apply() {
  // Plain objects: the patch goes over IPC.
  const picked = chosen.value.map((change) => toRaw(change))
  if (picked.length === 0 || applying.value) return
  applying.value = true
  try {
    await settings.update(settingsPatch(picked))
    open.value = false
    const left = changes.value.length - picked.length
    toast.success(picked.length === 1 ? 'Eine Einstellung übernommen' : `${picked.length} Einstellungen übernommen`, {
      description: left === 0 ? undefined : left === 1 ? 'Eine Änderung weggelassen' : `${left} Änderungen weggelassen`,
      action: {
        label: 'Rückgängig',
        onClick: () => void attempt(() => settings.update(settingsPatch(picked, 'from')), 'Rückgängig fehlgeschlagen'),
      },
    })
  } catch (error) {
    toastError(error, 'Import fehlgeschlagen')
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex max-h-[calc(100vh-4rem)] flex-col sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>Einstellungen importieren</DialogTitle>
        <DialogDescription>{{ source }} Übernommen wird, was ausgewählt ist, alles andere bleibt, wie es ist.</DialogDescription>
      </DialogHeader>

      <div v-if="sensitiveCount" class="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
        <ShieldAlertIcon class="mt-0.5 size-4 shrink-0 text-warning" />
        <p>
          {{ sensitiveCount === 1 ? 'Eine Änderung bestimmt' : `${sensitiveCount} Änderungen bestimmen` }}, welches Programm startet oder
          was Claude ohne Nachfrage darf. {{ sensitiveCount === 1 ? 'Sie ist' : 'Sie sind' }} nicht ausgewählt: Übernimm sie nur aus einer
          Datei, der du vertraust.
        </p>
      </div>

      <div class="-mx-6 min-h-0 flex-1 overflow-y-auto px-6" data-testid="import-changes">
        <section v-for="group in groups" :key="group.label" class="mb-3 last:mb-0">
          <h3 class="mb-1 px-2 text-xs font-medium text-muted-foreground">{{ group.label }}</h3>
          <ul class="flex flex-col gap-0.5">
            <li v-for="change in group.changes" :key="change.path">
              <label
                :class="
                  cn(
                    'grid cursor-pointer grid-cols-[auto_minmax(0,15rem)_minmax(0,1fr)] items-start gap-x-3',
                    'rounded-md px-2 py-1.5 text-sm hover:bg-accent/50',
                    change.sensitive && 'bg-warning/10 hover:bg-warning/15',
                  )
                "
              >
                <Checkbox
                  class="mt-0.5"
                  :model-value="selected.has(change.path)"
                  @update:model-value="toggle(change.path, $event === true)"
                />
                <span class="flex min-w-0 items-start gap-1.5">
                  <span class="min-w-0">{{ change.label }}</span>
                  <ShieldAlertIcon
                    v-if="change.sensitive"
                    class="mt-[3px] size-3.5 shrink-0 text-warning"
                    v-tooltip="'Bestimmt, welches Programm startet oder was Claude ohne Nachfrage darf'"
                  />
                </span>
                <span class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs leading-5 [overflow-wrap:anywhere]">
                  <span
                    :class="cn('text-muted-foreground line-through', !change.sensitive && 'max-w-full truncate')"
                    v-tooltip="change.sensitive ? null : full(text(change.path, change.from))"
                  >
                    {{ text(change.path, change.from) }}
                  </span>
                  <ArrowRightIcon class="size-3 shrink-0 text-muted-foreground" aria-label="wird zu" />
                  <span
                    :class="cn('font-medium', change.sensitive ? 'font-mono whitespace-pre-wrap' : 'max-w-full truncate')"
                    v-tooltip="change.sensitive ? null : full(text(change.path, change.to))"
                  >
                    {{ text(change.path, change.to) }}
                  </span>
                </span>
              </label>
            </li>
          </ul>
        </section>
        <p v-if="preview?.skipped.length" class="mt-3 px-2 text-xs text-muted-foreground">
          Nicht übernommen, weil es das auf diesem Computer nicht gibt: {{ preview.skipped.join(', ') }}
        </p>
      </div>

      <DialogFooter class="sm:justify-between">
        <Button variant="ghost" @click="toggleAll">{{ allChosen ? 'Keine auswählen' : 'Alle auswählen' }}</Button>
        <div class="flex flex-col-reverse gap-2 sm:flex-row">
          <Button variant="outline" @click="open = false">Abbrechen</Button>
          <Button :disabled="chosen.length === 0 || applying" @click="apply">
            {{ chosen.length === 1 ? '1 Änderung übernehmen' : `${chosen.length} Änderungen übernehmen` }}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
