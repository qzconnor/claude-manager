<script setup lang="ts">
import { TriangleAlertIcon, XIcon } from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import type { TerminalInfo } from '@shared/types'
import { Button } from '@/components/ui/button'
import { attempt } from '@/lib/errors'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'

/**
 * Shown in a session that has the app's browser and also starts with Claude in Chrome: Claude might
 * take the user's Chrome first. Turns Claude in Chrome off for the sessions the app starts, and
 * offers to start this one again, so it goes on with its conversation without Chrome.
 */
const props = defineProps<{ terminal: TerminalInfo }>()

const settings = useSettingsStore()
const terminals = useTerminalsStore()
const ui = useUiStore()
const busy = ref(false)

/** Long enough to read and decide; the tab is the one the user just looked at. */
const RESTART_OFFER_MS = 15_000

async function turnOff() {
  busy.value = true
  const done = await attempt(
    () => settings.update({ claude: { noClaudeInChrome: true } }).then(() => true),
    'Claude in Chrome konnte nicht ausgeschaltet werden',
  )
  busy.value = false
  if (!done) return
  // The banner is gone with the setting: the offer keeps the tab's id, not the component.
  const id = props.terminal.id
  toast.success('Claude in Chrome ist für Sessions der App aus', {
    description: 'Gilt für neue Sessions. Diese läuft noch mit Chrome, bis sie neu startet; ihr Verlauf bleibt.',
    duration: RESTART_OFFER_MS,
    action: { label: 'Jetzt neu starten', onClick: () => void restart(id) },
  })
}

async function restart(id: string) {
  const terminal = terminals.terminals.find((t) => t.id === id)
  if (!terminal || terminal.status !== 'running') return
  if (terminal.busy) {
    const ok = await ui.confirm({
      title: 'Session jetzt neu starten?',
      description: 'Claude arbeitet gerade. Die laufende Antwort bricht ab, danach geht die Session mit ihrem Verlauf ohne Chrome weiter.',
      confirmText: 'Neu starten',
    })
    if (!ok) return
  }
  const info = await attempt(() => terminals.restartSession(id), 'Session konnte nicht neu gestartet werden')
  if (info) toast.success('Session läuft ohne Claude in Chrome weiter')
}

async function dismiss() {
  const done = await attempt(() => settings.update({ claude: { claudeInChromeHintDismissed: true } }).then(() => true))
  if (done) toast('Hinweis ausgeblendet', { description: 'Ausschalten lässt sich Claude in Chrome unter Einstellungen › Claude Code › Browser.' })
}
</script>

<template>
  <div
    role="status"
    class="glass flex max-w-full items-center gap-3 rounded-xl py-2 pr-2 pl-4 shadow-lg ring-1 ring-foreground/10"
  >
    <TriangleAlertIcon class="size-4 shrink-0 text-warning" />
    <span class="min-w-0 text-sm">
      <span class="font-medium">Claude in Chrome ist an.</span>
      <span class="text-muted-foreground"> Claude nimmt vielleicht deinen Chrome statt des Browsers der App.</span>
    </span>
    <Button size="sm" variant="secondary" class="shrink-0" :disabled="busy" @click="turnOff">Ausschalten</Button>
    <Button
      size="icon-sm"
      variant="ghost"
      class="shrink-0"
      aria-label="Nicht mehr anzeigen"
      title="Nicht mehr anzeigen"
      @click="dismiss"
    >
      <XIcon />
    </Button>
  </div>
</template>
