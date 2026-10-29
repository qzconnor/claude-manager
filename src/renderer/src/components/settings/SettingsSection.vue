<script setup lang="ts">
import { RotateCcwIcon } from '@lucide/vue'
import type { AppSettings } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldGroup } from '@/components/ui/field'
import { attempt } from '@/lib/errors'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

const props = defineProps<{ title: string; description?: string; resetSection?: keyof AppSettings }>()

const settings = useSettingsStore()
const ui = useUiStore()

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
  <Card>
    <CardHeader>
      <CardTitle>{{ title }}</CardTitle>
      <CardDescription v-if="description">{{ description }}</CardDescription>
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
