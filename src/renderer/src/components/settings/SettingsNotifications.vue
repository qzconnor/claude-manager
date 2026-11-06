<script setup lang="ts">
import { BellRingIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import type { AppSettings, DeepPartial, NotificationSettings, NotifyWhen } from '@shared/types'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useSetting } from '@/composables/useSetting'
import { attempt } from '@/lib/errors'
import { isWindows } from '@/lib/platform'
import NumberControl from './NumberControl.vue'
import SettingField from './SettingField.vue'
import SettingsSection from './SettingsSection.vue'

function notificationSetting<K extends keyof NotificationSettings>(key: K, delay = 0) {
  return useSetting(
    (s) => s.notifications[key],
    (value) => ({ notifications: { [key]: value } }) as DeepPartial<AppSettings>,
    delay,
  )
}

const enabled = notificationSetting('enabled')
const onDone = notificationSetting('onDone')
const minBusySeconds = notificationSetting('minBusySeconds', 300)
const onInput = notificationSetting('onInput')
const onLimit = notificationSetting('onLimit')
const onNearLimit = notificationSetting('onNearLimit')
const nearLimitPercent = notificationSetting('nearLimitPercent', 300)
const when = notificationSetting('when')
const toast = notificationSetting('toast')
const preview = notificationSetting('preview')
const sound = notificationSetting('sound')
const flashTaskbar = notificationSetting('flashTaskbar')
const unreadDot = notificationSetting('unreadDot')

const off = computed(() => !enabled.value)
const toastName = isWindows ? 'Windows-Benachrichtigung' : 'Systembenachrichtigung'

const WHEN: { value: NotifyWhen; label: string }[] = [
  { value: 'background', label: 'Fenster im Hintergrund' },
  { value: 'hidden', label: 'Tab nicht sichtbar' },
]
const whenDescription = computed(() =>
  when.value === 'background'
    ? 'Nur, solange du in einem anderen Programm bist oder das Fenster minimiert ist. Den Punkt am Tab gibt es immer.'
    : 'Auch, wenn das Fenster vorne ist, aber ein anderer Tab oder eine andere Seite angezeigt wird.',
)

const testing = ref(false)
async function sendTest() {
  testing.value = true
  await attempt(() => window.api.notifications.test(), 'Benachrichtigung konnte nicht angezeigt werden')
  testing.value = false
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <SettingsSection
      anchor="notifications.main"
      title="Benachrichtigungen"
      description="Hinweise auf Tabs, in denen Claude fertig ist oder dich braucht, und auf fast verbrauchte Limits. Einzelne Tabs lassen sich über ihr Kontextmenü stummschalten."
      reset-section="notifications"
    >
      <SettingField
        anchor="notifications.enabled"
        for="notifications-enabled"
        label="Benachrichtigungen"
        description="Aus: keine Benachrichtigung, kein Blinken, kein Punkt am Tab. Schnell umschalten geht auch mit der Glocke oben rechts in der Titelleiste."
      >
        <Switch id="notifications-enabled" v-model="enabled" />
      </SettingField>
      <SettingField anchor="notifications.test" label="Ausprobieren" description="Zeigt eine Beispiel-Benachrichtigung mit den Einstellungen unten.">
        <Button variant="outline" size="sm" :disabled="testing || off || !toast" @click="sendTest">
          <Spinner v-if="testing" data-icon="inline-start" />
          <BellRingIcon v-else data-icon="inline-start" />
          Test-Benachrichtigung
        </Button>
      </SettingField>
    </SettingsSection>

    <SettingsSection anchor="notifications.events" title="Ereignisse" description="Worauf die App hinweist.">
      <SettingField anchor="notifications.onDone" for="notify-done" label="Claude ist fertig" description="Claude hat eine Antwort beendet.">
        <Switch id="notify-done" v-model="onDone" :disabled="off" />
      </SettingField>
      <SettingField
        anchor="notifications.minBusy"
        for="notify-min-busy"
        label="Erst nach längerer Arbeit (Sekunden)"
        description="Schneller fertige Antworten bekommen nur den Punkt am Tab, ohne Benachrichtigung und Blinken. 0 = immer."
      >
        <NumberControl id="notify-min-busy" v-model="minBusySeconds" :min="0" :max="3600" :step="5" :disabled="off || !onDone" />
      </SettingField>
      <SettingField
        anchor="notifications.onInput"
        for="notify-input"
        label="Claude braucht dich"
        description="Claude wartet auf eine Erlaubnis für ein Tool, auf die Antwort auf eine Frage oder auf die Freigabe eines Plans."
      >
        <Switch id="notify-input" v-model="onInput" :disabled="off" />
      </SettingField>
      <SettingField
        anchor="notifications.onLimit"
        for="notify-limit"
        label="Limit erreicht"
        description="Die Session ist an einem Nutzungslimit stehen geblieben, mit der Uhrzeit des Resets."
      >
        <Switch id="notify-limit" v-model="onLimit" :disabled="off" />
      </SettingField>
      <SettingField
        anchor="notifications.onNearLimit"
        for="notify-near-limit"
        label="Limit fast verbraucht"
        :description="`Ein Limit eines Accounts hat die Schwelle unten erreicht: 5-Stunden-Fenster, Woche oder das Wochenlimit eines Modells. Einmal pro Account und Zeitraum, nur als ${toastName}, ein Klick öffnet die Usage-Seite.`"
      >
        <Switch id="notify-near-limit" v-model="onNearLimit" :disabled="off || !toast" />
      </SettingField>
      <SettingField
        anchor="notifications.nearLimitPercent"
        for="notify-near-limit-percent"
        label="Schwelle (%)"
        description="Die Werte kommen mit jeder Abfrage der Limits (Usage-Aktualisierung unter Claude Code) und aus laufenden Sessions."
      >
        <NumberControl
          id="notify-near-limit-percent"
          v-model="nearLimitPercent"
          :min="10"
          :max="99"
          :step="5"
          :disabled="off || !toast || !onNearLimit"
        />
      </SettingField>
    </SettingsSection>

    <SettingsSection anchor="notifications.hints" title="Hinweise" description="Wie die App auf den Tab hinweist.">
      <SettingField anchor="notifications.when" label="Benachrichtigen, wenn" :description="whenDescription">
        <SegmentedControl v-model="when" :options="WHEN" :disabled="off" aria-label="Benachrichtigen, wenn" />
      </SettingField>
      <SettingField
        anchor="notifications.toast"
        for="notify-toast"
        :label="toastName"
        :description="
          isWindows
            ? 'Bleibt in der Mitteilungszentrale, bis du den Tab öffnest. Ein Klick darauf öffnet den Tab.'
            : 'Ein Klick darauf öffnet den Tab. Sobald du den Tab öffnest, verschwindet sie.'
        "
      >
        <Switch id="notify-toast" v-model="toast" :disabled="off" />
      </SettingField>
      <SettingField
        anchor="notifications.preview"
        for="notify-preview"
        label="Vorschau"
        description="Zeigt den Anfang der Antwort, den Befehl, der auf deine Erlaubnis wartet, oder Claudes Frage. Aus: nur Ereignis und Tab."
      >
        <Switch id="notify-preview" v-model="preview" :disabled="off || !toast" />
      </SettingField>
      <SettingField anchor="notifications.sound" for="notify-sound" label="Ton" description="Der Benachrichtigungston des Systems.">
        <Switch id="notify-sound" v-model="sound" :disabled="off || !toast" />
      </SettingField>
      <SettingField
        anchor="notifications.flash"
        for="notify-flash"
        :label="isWindows ? 'Taskleiste blinkt' : 'Fenster in der Taskleiste markieren'"
        description="Nur, wenn das Fenster im Hintergrund ist, und bis du es nach vorne holst."
      >
        <Switch id="notify-flash" v-model="flashTaskbar" :disabled="off" />
      </SettingField>
      <SettingField
        anchor="notifications.unreadDot"
        for="notify-dot"
        label="Punkt am Tab"
        description="Markiert Tabs mit Neuigkeiten, die du noch nicht gesehen hast, auch bei kurzen Antworten und stummgeschalteten Tabs. Orange: Claude wartet auf dich."
      >
        <Switch id="notify-dot" v-model="unreadDot" :disabled="off" />
      </SettingField>
    </SettingsSection>
  </div>
</template>
