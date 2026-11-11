<script setup lang="ts">
import { RotateCcwIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { createDefaultSettings } from '@shared/defaults'
import HighlightText from '@/components/common/HighlightText.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldGroup } from '@/components/ui/field'
import { useSettingsFilter } from '@/composables/useSettingsSearch'
import { attempt } from '@/lib/errors'
import type { SettingsAnchor } from '@/lib/settings-index'
import { resetPatches, type SettingsResetKeys } from '@/lib/settings-reset'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

/**
 * A card of the settings. `anchor`: its entry in lib/settings-index.ts, for the search and the command
 * palette. `reset`: the settings the card shows, which its „Zurücksetzen“ sets back (only those).
 */
const props = defineProps<{ anchor: SettingsAnchor; title: string; description?: string; reset?: SettingsResetKeys }>()

const settings = useSettingsStore()
const ui = useUiStore()
const filter = useSettingsFilter()

async function reset() {
  const keys = props.reset
  if (!keys) return
  const ok = await ui.confirm({
    title: `„${props.title}“ zurücksetzen?`,
    description: 'Die Einstellungen dieser Karte bekommen wieder ihre Standardwerte.',
    confirmText: 'Zurücksetzen',
  })
  if (!ok) return
  const { patch, previous } = resetPatches(keys, settings.settings, createDefaultSettings(window.api.platform))
  await attempt(async () => {
    await settings.update(patch)
    toast.success(`„${props.title}“ zurückgesetzt`, {
      action: {
        label: 'Rückgängig',
        onClick: () => void attempt(() => settings.update(previous), 'Rückgängig fehlgeschlagen'),
      },
    })
  }, 'Zurücksetzen fehlgeschlagen')
}
</script>

<template>
  <Card v-if="filter.shows(anchor)" :data-setting="anchor">
    <CardHeader>
      <CardTitle><HighlightText :text="title" :terms="filter.terms.value" /></CardTitle>
      <CardDescription v-if="description"><HighlightText :text="description" :terms="filter.terms.value" /></CardDescription>
      <CardAction v-if="props.reset || $slots.actions" class="flex items-center gap-1">
        <slot name="actions" />
        <Button v-if="props.reset" variant="ghost" size="sm" @click="reset">
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
