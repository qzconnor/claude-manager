<script setup lang="ts">
import { MoonIcon, PlayIcon, RotateCwIcon, TriangleAlertIcon, XIcon } from '@lucide/vue'
import { computed } from 'vue'
import type { TerminalInfo } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTerminalActions } from '@/composables/useTerminalActions'
import { useTerminalAppearance } from '@/composables/useTerminalAppearance'
import { attempt } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useTerminalsStore } from '@/stores/terminals'

/**
 * A tab of the last run that waits to start (status `asleep`), in place of its terminal: it starts once
 * it is shown, and says why when it didn't, e.g. because its folder is gone (see `TerminalInfo.sleep`).
 */
// Placed by TerminalWorkspace and GroupWorkspace, like TerminalPane.
const props = defineProps<{ terminal: TerminalInfo; active: boolean; dimmed?: boolean }>()
/** It was clicked: it should become the active one. */
const emit = defineEmits<{ focus: [] }>()

const terminals = useTerminalsStore()
const { closeTerminal } = useTerminalActions()
const { containerBackground, inactiveVeil } = useTerminalAppearance()

const error = computed(() => props.terminal.sleep?.error ?? null)
const waking = computed(() => props.terminal.sleep?.waking === true)
const kind = computed(() => (props.terminal.mode === 'shell' ? 'Shell' : 'Session'))
const text = computed(() => {
  if (error.value) return error.value
  if (props.terminal.mode === 'shell') return 'Eine neue Shell im selben Ordner.'
  return props.terminal.sessionId ? 'Die Session macht mit ihrem Verlauf weiter.' : 'Eine neue Session im selben Ordner.'
})

function start(): void {
  void attempt(() => terminals.wakeTerminal(props.terminal.id), 'Tab konnte nicht gestartet werden')
}
</script>

<template>
  <div
    class="size-full overflow-hidden"
    :style="{ background: containerBackground }"
    @pointerdown.capture="!active && emit('focus')"
    @focusin="!active && emit('focus')"
  >
    <div class="flex size-full items-center justify-center p-6">
      <div
        :role="error ? 'alert' : 'status'"
        class="glass flex w-full max-w-md flex-col gap-3 rounded-xl p-4 shadow-lg ring-1 ring-foreground/10"
      >
        <div class="flex items-start gap-3">
          <span
            :class="
              cn(
                'flex size-8 shrink-0 items-center justify-center rounded-lg',
                error ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground',
              )
            "
          >
            <TriangleAlertIcon v-if="error" class="size-4" />
            <Spinner v-else-if="waking" class="size-4" />
            <MoonIcon v-else class="size-4" />
          </span>
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <p class="text-sm font-medium">
              {{ error ? `${kind} startete nicht` : waking ? `${kind} startet …` : `${kind} vom letzten Mal` }}
            </p>
            <p class="text-sm break-words text-muted-foreground">{{ text }}</p>
          </div>
        </div>
        <!-- A missing folder is named in the reason already. -->
        <p
          v-if="terminal.cwd && !error?.includes(terminal.cwd)"
          v-tooltip="terminal.cwd"
          class="truncate font-mono text-xs text-muted-foreground"
        >
          {{ terminal.cwd }}
        </p>
        <p v-if="error" class="text-xs text-muted-foreground">Bis du ihn schließt, öffnet die App den Tab bei jedem Start wieder.</p>
        <div v-if="!waking" class="flex flex-wrap justify-end gap-2">
          <Button v-if="error" size="sm" variant="ghost" @click="closeTerminal(terminal.id)">
            <XIcon data-icon="inline-start" />
            Tab schließen
          </Button>
          <Button size="sm" :variant="error ? 'default' : 'secondary'" @click="start">
            <RotateCwIcon v-if="error" data-icon="inline-start" />
            <PlayIcon v-else data-icon="inline-start" />
            {{ error ? 'Erneut versuchen' : 'Jetzt starten' }}
          </Button>
        </div>
      </div>
    </div>

    <!-- In a split tab the parts without the keyboard step back. -->
    <div
      aria-hidden="true"
      :class="cn('pointer-events-none absolute inset-0 z-20 transition-opacity duration-150', dimmed ? 'opacity-100' : 'opacity-0')"
      :style="{ background: inactiveVeil }"
    />
  </div>
</template>
