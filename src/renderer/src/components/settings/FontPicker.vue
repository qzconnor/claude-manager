<script setup lang="ts">
import { CheckIcon, ChevronsUpDownIcon } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { RECOMMENDED_TERMINAL_FONTS } from '@shared/defaults'
import { Button } from '@/components/ui/button'
import {
  Combobox,
  ComboboxAnchor,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxViewport,
} from '@/components/ui/combobox'
import { buildFontStack } from '@/composables/useTerminalAppearance'
import { listInstalledFonts } from '@/lib/fonts'

defineProps<{ id?: string }>()
const model = defineModel<string>({ required: true })

const installed = ref<string[]>([])
const open = ref(false)
const search = ref('')

onMounted(async () => {
  installed.value = await listInstalledFonts()
})

watch(open, (isOpen) => {
  if (isOpen) search.value = ''
})

const installedSet = computed(() => new Set(installed.value.map((f) => f.toLowerCase())))
/** Shipped with the app (fontsource), so it is always available. */
const BUNDLED_FONT = 'Geist Mono Variable'

const recommended = computed(() => [
  ...RECOMMENDED_TERMINAL_FONTS.filter((f) => installedSet.value.has(f.toLowerCase())),
  BUNDLED_FONT,
])
const others = computed(() => {
  const rec = new Set(recommended.value.map((f) => f.toLowerCase()))
  return installed.value.filter((f) => !rec.has(f.toLowerCase()))
})
const custom = computed(() => {
  const value = search.value.trim()
  if (!value) return null
  const lower = value.toLowerCase()
  const known = recommended.value.some((f) => f.toLowerCase() === lower) || installedSet.value.has(lower)
  return known ? null : value
})

function select(value: unknown) {
  if (typeof value === 'string' && value.trim()) model.value = value.trim()
}
</script>

<template>
  <Combobox v-model:open="open" :model-value="model" @update:model-value="select">
    <ComboboxAnchor as-child>
      <ComboboxTrigger as-child>
        <Button :id="id" variant="outline" class="w-64 justify-between font-normal">
          <span class="truncate" :style="{ fontFamily: buildFontStack(model) }">{{ model }}</span>
          <ChevronsUpDownIcon data-icon="inline-end" class="text-muted-foreground" />
        </Button>
      </ComboboxTrigger>
    </ComboboxAnchor>
    <ComboboxList align="end" class="w-72">
      <ComboboxInput v-model="search" placeholder="Schrift suchen oder eingeben…" />
      <ComboboxViewport>
        <ComboboxEmpty>Keine passende Schrift installiert.</ComboboxEmpty>
        <ComboboxGroup v-if="custom" heading="Eigene Eingabe">
          <ComboboxItem :value="custom">„{{ custom }}“ verwenden</ComboboxItem>
        </ComboboxGroup>
        <ComboboxGroup heading="Empfohlen">
          <ComboboxItem v-for="font in recommended" :key="font" :value="font">
            <span class="truncate" :style="{ fontFamily: buildFontStack(font) }">{{ font }}</span>
            <ComboboxItemIndicator><CheckIcon /></ComboboxItemIndicator>
          </ComboboxItem>
        </ComboboxGroup>
        <template v-if="others.length">
          <ComboboxSeparator />
          <ComboboxGroup heading="Installiert">
            <ComboboxItem v-for="font in others" :key="font" :value="font">
              <span class="truncate">{{ font }}</span>
              <ComboboxItemIndicator><CheckIcon /></ComboboxItemIndicator>
            </ComboboxItem>
          </ComboboxGroup>
        </template>
      </ComboboxViewport>
    </ComboboxList>
  </Combobox>
</template>
