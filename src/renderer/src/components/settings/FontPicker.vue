<script setup lang="ts">
import { CheckIcon, ChevronDownIcon, SearchIcon } from '@lucide/vue'
import { ComboboxInput } from 'reka-ui'
import { computed, onMounted, ref, watch } from 'vue'
import { RECOMMENDED_TERMINAL_FONTS } from '@shared/defaults'
import { Button } from '@/components/ui/button'
import {
  Combobox,
  ComboboxAnchor,
  ComboboxEmpty,
  ComboboxGroup,
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
/**
 * Shown in each font next to its name; the terminal preview above shows the chosen one in full.
 * Short, so long names stay whole ("JetBrainsMonoNL Nerd Font Mono" next to "… Nerd Font").
 */
const SAMPLE = 'Abc'

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
const groups = computed(() => [
  { heading: 'Empfohlen', fonts: recommended.value },
  { heading: 'Installiert', fonts: others.value },
])

function select(value: unknown) {
  if (typeof value === 'string' && value.trim()) model.value = value.trim()
}
</script>

<template>
  <Combobox v-model:open="open" :model-value="model" @update:model-value="select">
    <ComboboxAnchor as-child>
      <ComboboxTrigger as-child>
        <Button :id="id" variant="outline" class="w-80 justify-between gap-2 pr-2 pl-2.5 font-normal">
          <span class="truncate">{{ model }}</span>
          <ChevronDownIcon class="text-muted-foreground" />
        </Button>
      </ComboboxTrigger>
    </ComboboxAnchor>
    <!-- As wide as the button; taller than a usual list, there are hundreds of fonts. -->
    <ComboboxList class="max-h-96">
      <!-- reka lays the list out as a flex column: without shrink-0 the long list squeezes the search. -->
      <div class="flex h-9 shrink-0 items-center gap-2 border-b px-2.5">
        <SearchIcon class="size-4 shrink-0 text-muted-foreground" />
        <!-- Starts empty instead of with the chosen font's name. -->
        <ComboboxInput
          v-model="search"
          :display-value="() => ''"
          placeholder="Schrift suchen oder eingeben…"
          class="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <ComboboxViewport class="max-h-[min(calc(--spacing(96)---spacing(9)),calc(var(--available-height)---spacing(9)))]">
        <ComboboxEmpty>Keine passende Schrift installiert.</ComboboxEmpty>
        <template v-for="(group, index) in groups" :key="group.heading">
          <template v-if="group.fonts.length">
            <!-- Not while searching: a group without matches would leave its line alone. -->
            <ComboboxSeparator v-if="index > 0 && !search" />
            <ComboboxGroup :heading="group.heading">
              <!-- Off screen the items aren't drawn, so their fonts load only when scrolled to. -->
              <ComboboxItem
                v-for="font in group.fonts"
                :key="font"
                :value="font"
                :text-value="font"
                class="[contain-intrinsic-size:auto_1.75rem] [content-visibility:auto]"
              >
                <span class="min-w-0 flex-1 truncate">{{ font }}</span>
                <span class="shrink-0 text-xs text-muted-foreground" :style="{ fontFamily: buildFontStack(font) }">
                  {{ SAMPLE }}
                </span>
                <ComboboxItemIndicator><CheckIcon /></ComboboxItemIndicator>
              </ComboboxItem>
            </ComboboxGroup>
          </template>
        </template>
        <!-- Last, so Enter takes the first font found and not the typed text. -->
        <ComboboxGroup v-if="custom" heading="Eigene Eingabe">
          <ComboboxItem :value="custom">
            <span class="truncate">„{{ custom }}“ verwenden</span>
          </ComboboxItem>
        </ComboboxGroup>
      </ComboboxViewport>
    </ComboboxList>
  </Combobox>
</template>
