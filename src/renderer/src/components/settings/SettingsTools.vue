<script setup lang="ts">
import { Trash2Icon } from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useSetting } from '@/composables/useSetting'
import { attempt } from '@/lib/errors'
import { useBrowsersStore } from '@/stores/browsers'
import { useUiStore } from '@/stores/ui'
import SettingField from './SettingField.vue'
import SettingsSection from './SettingsSection.vue'

const ui = useUiStore()
const browsers = useBrowsersStore()

const browserTools = useSetting(
  (s) => s.claude.browserTools,
  (browserTools) => ({ claude: { browserTools } }),
)
const browserToolsAllowed = useSetting(
  (s) => s.claude.browserToolsAllowed,
  (browserToolsAllowed) => ({ claude: { browserToolsAllowed } }),
)
const noClaudeInChrome = useSetting(
  (s) => s.claude.noClaudeInChrome,
  (noClaudeInChrome) => ({ claude: { noClaudeInChrome } }),
)
const appContext = useSetting(
  (s) => s.claude.appContext,
  (appContext) => ({ claude: { appContext } }),
)
const hookState = useSetting(
  (s) => s.claude.hookState,
  (hookState) => ({ claude: { hookState } }),
)
const limitsTool = useSetting(
  (s) => s.claude.limitsTool,
  (limitsTool) => ({ claude: { limitsTool } }),
)
const sessionsTool = useSetting(
  (s) => s.claude.sessionsTool,
  (sessionsTool) => ({ claude: { sessionsTool } }),
)
const shellTools = useSetting(
  (s) => s.claude.shellTools,
  (shellTools) => ({ claude: { shellTools } }),
)
const shellToolsAllowed = useSetting(
  (s) => s.claude.shellToolsAllowed,
  (shellToolsAllowed) => ({ claude: { shellToolsAllowed } }),
)

const clearingBrowser = ref(false)

/** Logs the browser out everywhere; open pages load again, so they show it (not one Claude is busy in). */
async function clearBrowserData() {
  const ok = await ui.confirm({
    title: 'Browserdaten löschen?',
    description:
      'Du wirst auf allen Seiten im Browser der App abgemeldet, auch für Claude-Sessions. Cookies, gespeicherte Daten der Seiten und der Cache werden gelöscht, offene Seiten laden neu.',
    confirmText: 'Löschen',
    destructive: true,
  })
  if (!ok) return
  clearingBrowser.value = true
  try {
    const done = await attempt(async () => {
      await window.api.browser.clearData()
      return true
    }, 'Browserdaten konnten nicht gelöscht werden')
    if (!done) return
    for (const [id, view] of browsers.views) if (!browsers.controls.get(id)?.busy) view.reload()
    toast.success('Browserdaten gelöscht')
  } finally {
    clearingBrowser.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <SettingsSection
      anchor="claude.browser"
      title="Browser"
      description="Claude-Sessions aus Claude Manager bedienen einen Browser neben sich: Seiten öffnen, klicken, tippen, Screenshots. Du siehst jeden Schritt und kannst jederzeit übernehmen. Logins im Browser gelten auch für Claude."
    >
      <SettingField
        anchor="claude.browserTools"
        for="browser-tools"
        label="Browser für Claude-Sessions"
        description="Gibt jeder Session, die die App danach startet, den Browser als MCP-Server. Andere Claude-Code-Instanzen und deine Einstellungen in ~/.claude bleiben unberührt."
      >
        <Switch id="browser-tools" v-model="browserTools" />
      </SettingField>
      <SettingField
        anchor="claude.browserToolsAllowed"
        for="browser-tools-allowed"
        label="Ohne Nachfrage bedienen"
        description="Claude fragt nicht vor jedem Schritt im Browser um Erlaubnis. Aus: Claude Code fragt wie bei anderen Werkzeugen."
      >
        <Switch id="browser-tools-allowed" v-model="browserToolsAllowed" :disabled="!browserTools" />
      </SettingField>
      <SettingField
        anchor="claude.noClaudeInChrome"
        for="no-claude-in-chrome"
        label="Ohne Claude in Chrome"
        description="Sessions aus der App starten ohne Claude in Chrome (--no-chrome), damit Claude den Browser der App nimmt und nicht deinen Chrome. Claude Codes eigene Einstellung bleibt, wie sie ist."
      >
        <Switch id="no-claude-in-chrome" v-model="noClaudeInChrome" :disabled="!browserTools" />
      </SettingField>
      <SettingField
        anchor="claude.clearBrowserData"
        label="Browserdaten löschen"
        description="Meldet dich auf allen Seiten im Browser der App ab: Cookies, gespeicherte Daten der Seiten und Cache."
      >
        <Button variant="outline" size="sm" :disabled="clearingBrowser" @click="clearBrowserData">
          <Spinner v-if="clearingBrowser" data-icon="inline-start" />
          <Trash2Icon v-else data-icon="inline-start" />
          Löschen…
        </Button>
      </SettingField>
    </SettingsSection>

    <SettingsSection
      anchor="tools.app"
      title="Claude Manager"
      description="Was Claude-Sessions aus der App über die App wissen und mit ihr tun können. Die Werkzeuge laufen über denselben MCP-Server wie der Browser. Änderungen gelten für Sessions, die danach starten."
    >
      <SettingField
        anchor="claude.appContext"
        for="app-context"
        label="Claude kennt die App"
        description="Claude weiß, dass es in Claude Manager läuft, und versteht, was du mit „dem Tab“, „dem Browser daneben“ oder einer Einstellung meinst. Dafür hängt die App Claude Codes Systemprompt eine kurze Beschreibung an, etwa 400 Tokens pro Anfrage, meist aus dem Prompt-Cache."
      >
        <Switch id="app-context" v-model="appContext" />
      </SettingField>
      <SettingField
        anchor="claude.hookState"
        for="hook-state"
        label="Zustand über Hooks melden"
        description="Claude Code meldet der App über Hooks, wann eine Antwort fertig ist, wann Claude auf dich wartet und was gerade läuft. Benachrichtigungen kommen dadurch ohne Verzögerung, die Infokarte des Tabs zeigt Werkzeug und Subagents. Deine eigenen Hooks laufen weiter, keine Tokens. Aus: Die App liest den Zustand wie bisher aus dem Verlauf."
      >
        <Switch id="hook-state" v-model="hookState" />
      </SettingField>
      <SettingField
        anchor="claude.limitsTool"
        for="limits-tool"
        label="Eigene Limits lesen"
        description="Claude sieht die 5-Stunden- und Wochenlimits des Accounts, über den die Session läuft, und kann große Aufgaben danach einteilen."
      >
        <Switch id="limits-tool" v-model="limitsTool" />
      </SettingField>
      <SettingField
        anchor="claude.sessionsTool"
        for="sessions-tool"
        label="Sessions durchsuchen"
        description="Claude durchsucht den Verlauf früherer Sessions aller Accounts und liest einzelne nach, etwa um nachzusehen, wie etwas schon einmal gelöst wurde."
      >
        <Switch id="sessions-tool" v-model="sessionsTool" />
      </SettingField>
      <SettingField
        anchor="claude.shellTools"
        for="shell-tools"
        label="Shell-Tabs steuern"
        description="Claude öffnet Shell-Tabs neben sich, startet darin Befehle (z. B. den Dev-Server) und liest die Ausgabe. Nur Tabs, die die Session selbst geöffnet hat. Die Befehle laufen außerhalb von Claude Codes Berechtigungen."
      >
        <Switch id="shell-tools" v-model="shellTools" />
      </SettingField>
      <SettingField
        anchor="claude.shellToolsAllowed"
        for="shell-tools-allowed"
        label="Ohne Nachfrage"
        description="Claude fragt nicht vor jedem Befehl in einem Shell-Tab um Erlaubnis. Aus: Claude Code fragt jedes Mal."
      >
        <Switch id="shell-tools-allowed" v-model="shellToolsAllowed" :disabled="!shellTools" />
      </SettingField>
    </SettingsSection>
  </div>
</template>
