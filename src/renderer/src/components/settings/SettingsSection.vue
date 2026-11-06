<script setup lang="ts">
import { RotateCcwIcon } from '@lucide/vue'
import type { AppSettings } from '@shared/types'
import HighlightText from '@/components/common/HighlightText.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldGroup } from '@/components/ui/field'
import { useSettingsFilter } from '@/composables/useSettingsSearch'
import { attempt } from '@/lib/errors'
import type { SettingsAnchor } from '@/lib/settings-index'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

/** A card of the settings. `anchor`: its entry in lib/settings-index.ts, for the search and the command palette. */
const props = defineProps<{ anchor: SettingsAnchor; title: string; description?: string; resetSection?: keyof AppSettings }>()

const settings = useSettingsStore()
const ui = useUiStore()
const filter = useSettingsFilter()

async function reset() {
  if (!props.resetSection) return
  const ok = await ui.confirm({
    title: `„${props.title}“ zurücksetzen?`,
    description: 'Alle Einstellungen dieses Bereichs werden auf die Standardwerte gesetzt.',
    confirmText: 'Zurücksetzen',
  })
  if (ok) await attempt(() => settings.reset(props.resetSection))
}
</script>

<template>
  <Card v-if="filter.shows(anchor)" :data-setting="anchor">
    <CardHeader>
      <CardTitle><HighlightText :text="title" :terms="filter.terms.value" /></CardTitle>
      <CardDescription v-if="description"><HighlightText :text="description" :terms="filter.terms.value" /></CardDescription>
      <CardAction v-if="resetSection">
        <Button variant="ghost" size="sm" @click="reset">
          <RotateCcwIcon data-icon="inline-start" />
          Zurücksetzen
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent>
      <FieldGroup>
        <slot />
      </FieldGroup>
    </CardContent>
  </Card>
</template>
