<script setup lang="ts">
import { CircleCheckIcon, CircleXIcon, RefreshCwIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import type { CloseOnExit } from '@shared/types'
import AccountSelect from '@/components/common/AccountSelect.vue'
import DirectoryInput from '@/components/common/DirectoryInput.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useSetting } from '@/composables/useSetting'
import { formatArgs, parseArgs } from '@/lib/args'
import { attempt } from '@/lib/errors'
import { shortenPath } from '@/lib/format'
import { isLinux, isWindows } from '@/lib/platform'
import { useAppStore } from '@/stores/app'
import NumberControl from './NumberControl.vue'
import SettingField from './SettingField.vue'
import SettingsCommand from './SettingsCommand.vue'
import SettingsSection from './SettingsSection.vue'

const app = useAppStore()

const executablePath = useSetting(
  (s) => s.claude.executablePath,
  (executablePath) => ({ claude: { executablePath } }),
)
const defaultCwd = useSetting(
  (s) => s.claude.defaultCwd,
  (defaultCwd) => ({ claude: { defaultCwd } }),
  400,
)
const defaultArgs = useSetting(
  (s) => formatArgs(s.claude.defaultArgs),
  (value) => ({ claude: { defaultArgs: parseArgs(value) } }),
)
const continuePrompt = useSetting(
  (s) => s.claude.continuePrompt,
  (continuePrompt) => ({ claude: { continuePrompt } }),
)
const autoSwitch = useSetting(
  (s) => s.claude.autoSwitch,
  (autoSwitch) => ({ claude: { autoSwitch } }),
)
const usageRefreshMinutes = useSetting(
  (s) => s.claude.usageRefreshMinutes,
  (usageRefreshMinutes) => ({ claude: { usageRefreshMinutes } }),
  300,
)
const defaultAccountId = useSetting(
  (s) => s.general.defaultAccountId,
  (defaultAccountId) => ({ general: { defaultAccountId } }),
)
const confirmCloseRunning = useSetting(
  (s) => s.general.confirmCloseRunning,
  (confirmCloseRunning) => ({ general: { confirmCloseRunning } }),
)
const closeOnExit = useSetting(
  (s) => s.general.closeOnExit,
  (closeOnExit) => ({ general: { closeOnExit } }),
)
const restoreTerminals = useSetting(
  (s) => s.general.restoreTerminals,
  (restoreTerminals) => ({ general: { restoreTerminals } }),
)
const runInTray = useSetting(
  (s) => s.general.runInTray,
  (runInTray) => ({ general: { runInTray } }),
)
const launchAtLogin = useSetting(
  (s) => s.general.launchAtLogin,
  (launchAtLogin) => ({ general: { launchAtLogin } }),
)

const launchAtLoginHint = computed(() => {
  if (app.info && !app.info.packaged) return 'Nur in der installierten App, nicht im Entwicklungs-Build.'
  if (isLinux && app.info && !app.info.linuxPackage) return 'Nur als AppImage oder aus dem deb- bzw. rpm-Paket.'
  return runInTray.value
    ? 'Startet beim Anmelden ohne Fenster, nur im Infobereich. Die API ist dann sofort erreichbar.'
    : 'Startet beim Anmelden mit Fenster. Zusammen mit „Im Infobereich weiterlaufen“ nur im Infobereich.'
})

/** Linux needs a file that starts the installation: an AppImage or the executable of a package. */
const canLaunchAtLogin = computed(() => !app.info || (app.info.packaged && (!isLinux || app.info.linuxPackage !== null)))

const CLOSE_ON_EXIT: { value: CloseOnExit; label: string }[] = [
  { value: 'graceful', label: 'Ohne Fehler' },
  { value: 'always', label: 'Immer' },
  { value: 'never', label: 'Nie' },
]

const checking = ref(false)

/** Text fields are committed on blur / Enter (change event) instead of on every keystroke. */
const inputValue = (event: Event) => (event.target as HTMLInputElement).value.trim()
const commitPath = (event: Event) => (executablePath.value = inputValue(event))
const commitArgs = (event: Event) => (defaultArgs.value = inputValue(event))
const commitPrompt = (event: Event) => (continuePrompt.value = inputValue(event))

async function recheck() {
  checking.value = true
  await attempt(() => app.load(), 'Prüfung fehlgeschlagen')
  checking.value = false
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <SettingsSection title="Claude Code" description="Programm und Startoptionen." reset-section="claude">
      <SettingField label="Gefundene Installation">
        <Badge v-if="app.info?.claudeExecutable" variant="outline" class="max-w-80">
          <CircleCheckIcon class="text-success" />
          <span class="truncate">{{ app.info.claudeVersion ?? 'Version unbekannt' }}</span>
        </Badge>
        <Badge v-else variant="destructive">
          <CircleXIcon />
          Nicht gefunden
        </Badge>
        <Button variant="ghost" size="icon-sm" aria-label="Erneut prüfen" :disabled="checking" @click="recheck">
          <Spinner v-if="checking" />
          <RefreshCwIcon v-else />
        </Button>
      </SettingField>
      <SettingField
        for="claude-path"
        :label="isWindows ? 'Pfad zur claude.exe' : 'Pfad zu claude'"
        :description="app.info?.claudeExecutable ? `Automatisch: ${app.info.claudeExecutable}` : 'Leer lassen für automatische Suche im PATH.'"
      >
        <Input
          id="claude-path"
          :model-value="executablePath"
          placeholder="Automatisch"
          spellcheck="false"
          class="w-80 font-mono text-xs"
          @change="commitPath"
        />
      </SettingField>
      <SettingField
        for="claude-args"
        label="Standard-Argumente"
        description="Werden an jede neue Session angehängt, z. B. --model sonnet."
      >
        <Input
          id="claude-args"
          :model-value="defaultArgs"
          placeholder="keine"
          spellcheck="false"
          class="w-80 font-mono text-xs"
          @change="commitArgs"
        />
      </SettingField>
      <SettingField for="claude-cwd" label="Standard-Arbeitsordner" description="Leer = Downloads-Ordner. Accounts können eigene Ordner festlegen.">
        <div class="w-80">
          <DirectoryInput
            id="claude-cwd"
            v-model="defaultCwd"
            :placeholder="app.info ? shortenPath(app.info.fallbackCwd, app.info.homeDir) : 'Downloads'"
          />
        </div>
      </SettingField>
      <SettingField
        for="auto-switch"
        label="Bei einem Limit automatisch wechseln"
        description="Stößt eine Session an ein Limit, läuft sie von selbst mit dem nächsten freien Account weiter, wie mit „Mit … fortsetzen“ im Tab. Ohne freien Account bleibt der Hinweis."
      >
        <Switch id="auto-switch" v-model="autoSwitch" />
      </SettingField>
      <SettingField
        for="continue-prompt"
        label="Nachricht nach Account-Wechsel"
        description="Wechselst du bei einer Session am Limit den Account, wird sie geschickt, damit Claude weitermacht. Leer = nichts schicken."
      >
        <Input
          id="continue-prompt"
          :model-value="continuePrompt"
          placeholder="nichts schicken"
          class="w-80"
          @change="commitPrompt"
        />
      </SettingField>
    </SettingsSection>

    <SettingsCommand />

    <SettingsSection title="Allgemein" reset-section="general">
      <SettingField for="default-account" label="Standard-Account" description="Wird für „+“ und Strg+Umschalt+T verwendet.">
        <AccountSelect id="default-account" v-model="defaultAccountId" size="sm" class="w-56" />
      </SettingField>
      <SettingField
        for="restore-terminals"
        label="Tabs beim Start wiederherstellen"
        description="Merkt sich Ordner und Session jedes offenen Tabs. Beim nächsten Start wird die Session fortgesetzt, ohne gespeicherte Session startet eine neue im selben Ordner."
      >
        <Switch id="restore-terminals" v-model="restoreTerminals" />
      </SettingField>
      <SettingField for="confirm-close" label="Schließen laufender Terminals bestätigen">
        <Switch id="confirm-close" v-model="confirmCloseRunning" />
      </SettingField>
      <SettingField
        label="Tab schließen, wenn der Prozess endet"
        description="Ohne Fehler: nach Strg+C oder /exit in Claude bzw. exit in der Shell. Bei einem Fehler bleibt der Tab zum Nachlesen offen."
      >
        <SegmentedControl v-model="closeOnExit" :options="CLOSE_ON_EXIT" aria-label="Tab schließen, wenn der Prozess endet" />
      </SettingField>
      <SettingField
        for="usage-refresh"
        label="Usage-Aktualisierung"
        description="Minuten zwischen zwei Live-Abfragen der Plan-Limits (min. 2)."
      >
        <NumberControl id="usage-refresh" v-model="usageRefreshMinutes" :min="2" :max="120" />
      </SettingField>
    </SettingsSection>

    <SettingsSection title="Start und Infobereich" description="Damit Terminals und die lokale API auch ohne Fenster weiterlaufen.">
      <SettingField
        for="run-in-tray"
        label="Im Infobereich weiterlaufen"
        :description="
          isLinux
            ? 'Schließen blendet das Fenster nur aus, Terminals und API laufen weiter. Öffnen und Beenden über das Menü des Symbols im Infobereich. GNOME zeigt es erst mit der Erweiterung „AppIndicator“, ohne Symbol holt ein erneuter Start der App das Fenster zurück.'
            : 'Schließen blendet das Fenster nur aus, Terminals und API laufen weiter. Öffnen per Klick auf das Symbol im Infobereich, Beenden über sein Kontextmenü.'
        "
      >
        <Switch id="run-in-tray" v-model="runInTray" />
      </SettingField>
      <SettingField for="launch-at-login" :label="isWindows ? 'Mit Windows starten' : 'Beim Anmelden starten'" :description="launchAtLoginHint">
        <Switch id="launch-at-login" v-model="launchAtLogin" :disabled="!canLaunchAtLogin" />
      </SettingField>
    </SettingsSection>
  </div>
</template>
