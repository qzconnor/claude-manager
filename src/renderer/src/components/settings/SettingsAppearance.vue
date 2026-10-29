<script setup lang="ts">
import type { WindowMaterial } from '@shared/types'
import { Switch } from '@/components/ui/switch'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { useSetting } from '@/composables/useSetting'
import SettingField from './SettingField.vue'
import SettingsSection from './SettingsSection.vue'
import SliderControl from './SliderControl.vue'
import ThemePicker from './ThemePicker.vue'

const themeId = useSetting(
  (s) => s.appearance.themeId,
  (themeId) => ({ appearance: { themeId } }),
)
const material = useSetting(
  (s) => s.appearance.material,
  (material) => ({ appearance: { material } }),
)
const keepActive = useSetting(
  (s) => s.appearance.keepMaterialWhenInactive,
  (keepMaterialWhenInactive) => ({ appearance: { keepMaterialWhenInactive } }),
)
const surfaceOpacity = useSetting(
  (s) => s.appearance.surfaceOpacity,
  (surfaceOpacity) => ({ appearance: { surfaceOpacity } }),
  150,
)
const uiFontSize = useSetting(
  (s) => s.appearance.uiFontSize,
  (uiFontSize) => ({ appearance: { uiFontSize } }),
  150,
)
const radius = useSetting(
  (s) => s.appearance.radius,
  (radius) => ({ appearance: { radius } }),
  150,
)

const MATERIALS: { value: WindowMaterial; label: string }[] = [
  { value: 'acrylic', label: 'Acryl' },
  { value: 'mica', label: 'Mica' },
  { value: 'tabbed', label: 'Mica Alt' },
  { value: 'none', label: 'Aus' },
]

function onMaterial(value: unknown) {
  const match = MATERIALS.find((m) => m.value === value)
  if (match) material.value = match.value
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <SettingsSection title="Theme" description="Farben für App und Terminal.">
      <ThemePicker v-model="themeId" />
    </SettingsSection>

    <SettingsSection title="Fenster" description="Windows-11-Material hinter der App." reset-section="appearance">
      <SettingField label="Material" description="Acryl ist am stärksten transparent, Mica übernimmt dezent die Farbe des Desktops.">
        <SegmentedControl :model-value="material" :options="MATERIALS" aria-label="Material" @update:model-value="onMaterial" />
      </SettingField>
      <SettingField
        for="keep-material"
        label="Auch ohne Fokus beibehalten"
        description="Windows schaltet das Material sonst ab, sobald ein anderes Fenster aktiv ist."
      >
        <Switch id="keep-material" v-model="keepActive" :disabled="material === 'none'" />
      </SettingField>
      <SettingField
        for="surface-opacity"
        label="Deckkraft"
        description="Wie stark die Theme-Farbe das Material überdeckt. 100 % = undurchsichtig."
      >
        <SliderControl
          id="surface-opacity"
          v-model="surfaceOpacity"
          :min="0"
          :max="100"
          :format="(v) => `${v} %`"
        />
      </SettingField>
      <SettingField for="ui-font-size" label="Schriftgröße der Oberfläche">
        <SliderControl id="ui-font-size" v-model="uiFontSize" :min="12" :max="18" :format="(v) => `${v} px`" />
      </SettingField>
      <SettingField for="radius" label="Eckenradius">
        <SliderControl id="radius" v-model="radius" :min="0" :max="1.25" :step="0.125" :format="(v) => `${Math.round(v * 16)} px`" />
      </SettingField>
    </SettingsSection>
  </div>
</template>
