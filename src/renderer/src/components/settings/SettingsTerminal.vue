<script setup lang="ts">
import type { CursorStyle, DiffColors, PanelBackground, TerminalPadding, TerminalRenderer, TerminalSettings, UnicodeMode } from '@shared/types'
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { useSetting } from '@/composables/useSetting'
import { THEMES } from '@/themes/themes'
import FontPicker from './FontPicker.vue'
import NumberControl from './NumberControl.vue'
import SettingField from './SettingField.vue'
import SettingsSection from './SettingsSection.vue'
import SliderControl from './SliderControl.vue'
import TerminalPreview from './TerminalPreview.vue'

const t = <K extends keyof TerminalSettings>(key: K, delay = 0) =>
  useSetting(
    (s) => s.terminal[key],
    (value) => ({ terminal: { [key]: value } as Partial<TerminalSettings> }),
    delay,
  )
const pad = (side: keyof TerminalPadding) =>
  useSetting(
    (s) => s.terminal.padding[side],
    (value) => ({ terminal: { padding: { [side]: value } as Partial<TerminalPadding> } }),
    150,
  )

const fontFamily = t('fontFamily')
const fontSize = t('fontSize', 150)
const lineHeight = t('lineHeight', 150)
const letterSpacing = t('letterSpacing', 150)
const fontWeight = t('fontWeight')
const fontWeightBold = t('fontWeightBold')
const cursorStyle = t('cursorStyle')
const cursorBlink = t('cursorBlink')
const paddingTop = pad('top')
const paddingBottom = pad('bottom')
const paddingLeft = pad('left')
const paddingRight = pad('right')
const px = (v: number) => `${v} px`
const backgroundOpacity = t('backgroundOpacity', 150)
const scrollback = t('scrollback', 300)
const renderer = t('renderer')
const unicode = t('unicode')
const copyOnSelect = t('copyOnSelect')
const rightClickPaste = t('rightClickPaste')
const minimumContrastRatio = t('minimumContrastRatio', 150)
const colorSchemeId = t('colorSchemeId')
const panelBackground = t('panelBackground')
const diffColors = t('diffColors')

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900]
const CURSORS: { value: CursorStyle; label: string }[] = [
  { value: 'bar', label: 'Balken' },
  { value: 'block', label: 'Block' },
  { value: 'underline', label: 'Unterstrich' },
]
const RENDERERS: { value: TerminalRenderer; label: string }[] = [
  { value: 'webgl', label: 'WebGL' },
  { value: 'dom', label: 'DOM' },
]
const UNICODE_VERSIONS: { value: UnicodeMode; label: string }[] = [
  { value: 'graphemes', label: 'Unicode 15' },
  { value: 'unicode11', label: 'Unicode 11' },
]
const PANEL_BACKGROUNDS: { value: PanelBackground; label: string }[] = [
  { value: 'theme', label: 'Theme' },
  { value: 'terminal', label: 'Terminal' },
  { value: 'original', label: 'Original' },
]
const DIFF_COLORS: { value: DiffColors; label: string }[] = [
  { value: 'theme', label: 'Theme' },
  { value: 'original', label: 'Original' },
]
const FOLLOW_APP = '__app__'

function onCursor(value: unknown) {
  const match = CURSORS.find((c) => c.value === value)
  if (match) cursorStyle.value = match.value
}
function onRenderer(value: unknown) {
  if (value === 'webgl' || value === 'dom') renderer.value = value
}
function onUnicode(value: unknown) {
  if (value === 'graphemes' || value === 'unicode11') unicode.value = value
}
// Template refs are auto-unwrapped, so each select gets its own handler.
function parseWeight(value: unknown): number | null {
  const n = Number(value)
  return WEIGHTS.includes(n) ? n : null
}
function onWeight(value: unknown) {
  const n = parseWeight(value)
  if (n !== null) fontWeight.value = n
}
function onWeightBold(value: unknown) {
  const n = parseWeight(value)
  if (n !== null) fontWeightBold.value = n
}
function onScheme(value: unknown) {
  if (typeof value === 'string') colorSchemeId.value = value === FOLLOW_APP ? null : value
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <SettingsSection title="Vorschau" description="Änderungen wirken sofort auf alle offenen Terminals.">
      <TerminalPreview />
    </SettingsSection>

    <SettingsSection title="Schrift" reset-section="terminal">
      <SettingField for="terminal-font" label="Schriftart" description="Emoji und Symbole werden automatisch über Segoe UI Emoji ergänzt.">
        <FontPicker id="terminal-font" v-model="fontFamily" />
      </SettingField>
      <SettingField for="terminal-font-size" label="Schriftgröße" description="Auch mit Strg + / Strg − / Strg 0.">
        <NumberControl id="terminal-font-size" v-model="fontSize" :min="6" :max="40" />
      </SettingField>
      <SettingField for="terminal-line-height" label="Zeilenhöhe">
        <SliderControl id="terminal-line-height" v-model="lineHeight" :min="1" :max="2" :step="0.05" :format="(v) => v.toFixed(2)" />
      </SettingField>
      <SettingField for="terminal-letter-spacing" label="Zeichenabstand">
        <NumberControl id="terminal-letter-spacing" v-model="letterSpacing" :min="-5" :max="10" :step="0.5" />
      </SettingField>
      <SettingField label="Schriftstärke" description="Normal und fett.">
        <Select :model-value="String(fontWeight)" @update:model-value="onWeight">
          <SelectTrigger size="sm" class="w-24" aria-label="Normale Schriftstärke"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem v-for="w in WEIGHTS" :key="w" :value="String(w)">{{ w }}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select :model-value="String(fontWeightBold)" @update:model-value="onWeightBold">
          <SelectTrigger size="sm" class="w-24" aria-label="Fette Schriftstärke"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem v-for="w in WEIGHTS" :key="w" :value="String(w)">{{ w }}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </SettingField>
    </SettingsSection>

    <SettingsSection title="Aussehen">
      <SettingField label="Farbschema" description="Standardmäßig passend zum App-Theme.">
        <Select :model-value="colorSchemeId ?? FOLLOW_APP" @update:model-value="onScheme">
          <SelectTrigger size="sm" class="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem :value="FOLLOW_APP">Wie App-Theme</SelectItem>
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectItem v-for="theme in THEMES" :key="theme.id" :value="theme.id">{{ theme.name }}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </SettingField>
      <SettingField
        for="terminal-bg"
        label="Hintergrund-Deckkraft"
        description="0 % lässt das Fenster-Material (Acryl) durchscheinen."
      >
        <SliderControl id="terminal-bg" v-model="backgroundOpacity" :min="0" :max="100" :format="(v) => `${v} %`" />
      </SettingField>
      <SettingField
        label="Hintergrund von Claude-Flächen"
        description="Seitenleisten von Claude Code wie /diff und die Balken hinter deinen Eingaben im Verlauf. Theme: leicht getönt und durchscheinend. Terminal: ganz durchsichtig wie der Terminal-Hintergrund. Original: das deckende Grau von Claude Code. Ein Wechsel dieser Option wirkt auf alles, was Claude danach zeichnet."
      >
        <SegmentedControl v-model="panelBackground" :options="PANEL_BACKGROUNDS" aria-label="Hintergrund von Claude-Flächen" />
      </SettingField>
      <SettingField
        label="Diff-Farben"
        description="Grün und Rot hinter geänderten Zeilen, etwa bei Update. Theme: durchscheinend in den Farben des Farbschemas. Original: die deckenden Farben von Claude Code. Ein Wechsel dieser Option wirkt auf alles, was Claude danach zeichnet."
      >
        <SegmentedControl v-model="diffColors" :options="DIFF_COLORS" aria-label="Diff-Farben" />
      </SettingField>
      <SettingField label="Cursor">
        <SegmentedControl :model-value="cursorStyle" :options="CURSORS" aria-label="Cursor" @update:model-value="onCursor" />
      </SettingField>
      <SettingField for="terminal-blink" label="Cursor blinkt">
        <Switch id="terminal-blink" v-model="cursorBlink" />
      </SettingField>
      <SettingField
        for="terminal-contrast"
        label="Mindestkontrast"
        description="Hellt Text automatisch auf, wenn er sich zu wenig vom Hintergrund abhebt (1 = aus)."
      >
        <SliderControl id="terminal-contrast" v-model="minimumContrastRatio" :min="1" :max="7" :step="0.5" />
      </SettingField>
    </SettingsSection>

    <SettingsSection
      title="Innenabstand"
      description="Abstand zwischen Text und Rand. Was links und rechts nicht mehr für eine ganze Spalte reicht, kommt je zur Hälfte auf beide Seiten."
    >
      <SettingField
        for="terminal-padding-top"
        label="Oben"
        description="Solange der Anfang der Ausgabe zu sehen ist. Beim Scrollen reicht der Text bis an die Kante."
      >
        <SliderControl id="terminal-padding-top" v-model="paddingTop" :min="0" :max="48" :format="px" />
      </SettingField>
      <SettingField for="terminal-padding-bottom" label="Unten" description="Unter dem Prompt.">
        <SliderControl id="terminal-padding-bottom" v-model="paddingBottom" :min="0" :max="48" :format="px" />
      </SettingField>
      <SettingField for="terminal-padding-left" label="Links">
        <SliderControl id="terminal-padding-left" v-model="paddingLeft" :min="0" :max="48" :format="px" />
      </SettingField>
      <SettingField
        for="terminal-padding-right"
        label="Rechts"
        description="Die Scrollbar liegt in diesem Abstand. Unter 14 px kann sie beim Scrollen die letzte Spalte überdecken."
      >
        <SliderControl id="terminal-padding-right" v-model="paddingRight" :min="0" :max="48" :format="px" />
      </SettingField>
    </SettingsSection>

    <SettingsSection title="Verhalten">
      <SettingField for="terminal-copy-select" label="Beim Markieren kopieren">
        <Switch id="terminal-copy-select" v-model="copyOnSelect" />
      </SettingField>
      <SettingField
        for="terminal-right-click"
        label="Rechtsklick kopiert / fügt ein"
        description="Wie in Windows Terminal: mit Auswahl kopieren, sonst einfügen."
      >
        <Switch id="terminal-right-click" v-model="rightClickPaste" />
      </SettingField>
      <SettingField for="terminal-scrollback" label="Scrollback" description="Anzahl Zeilen, die pro Terminal gehalten werden.">
        <NumberControl id="terminal-scrollback" v-model="scrollback" :min="500" :max="200000" :step="1000" />
      </SettingField>
    </SettingsSection>

    <SettingsSection title="Rendering">
      <SettingField label="Renderer" description="WebGL ist schneller; DOM hilft bei Grafiktreiber-Problemen.">
        <SegmentedControl :model-value="renderer" :options="RENDERERS" aria-label="Renderer" @update:model-value="onRenderer" />
      </SettingField>
      <SettingField label="Unicode" description="Unicode 15 mit Graphem-Clustern stellt zusammengesetzte Emoji korrekt dar.">
        <SegmentedControl :model-value="unicode" :options="UNICODE_VERSIONS" aria-label="Unicode" @update:model-value="onUnicode" />
      </SettingField>
    </SettingsSection>
  </div>
</template>
