<script setup lang="ts">
import { CircleAlertIcon, CircleArrowDownIcon, CircleCheckIcon, CircleDashedIcon, InfoIcon, RotateCwIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { formatDateTime } from '@/lib/format'
import { useUpdatesStore } from '@/stores/updates'

/** What the updater is doing, with the action that fits: download, restart or nothing to do. */
const updates = useUpdatesStore()
const state = computed(() => updates.state)
const checkedAt = computed(() => (state.value.checkedAt ? formatDateTime(new Date(state.value.checkedAt).toISOString()) : null))
</script>

<template>
  <Alert v-if="state.status === 'unsupported'">
    <InfoIcon />
    <AlertTitle>Entwicklungsversion</AlertTitle>
    <AlertDescription>Updates gibt es nur in der installierten App. Die Versionshinweise stehen trotzdem unten.</AlertDescription>
  </Alert>

  <!-- A newer version: this one has to stand out. -->
  <Item v-else-if="updates.hasUpdate" variant="outline" class="border-primary/60 bg-primary/10">
    <ItemMedia class="size-9 rounded-lg bg-primary text-primary-foreground">
      <CircleArrowDownIcon class="size-5" />
    </ItemMedia>
    <ItemContent>
      <ItemTitle>Version {{ state.next }} ist verfügbar</ItemTitle>
      <ItemDescription>
        <template v-if="state.status === 'downloading'">Wird heruntergeladen … {{ Math.round(state.progress) }} %</template>
        <template v-else-if="state.status === 'downloaded'">
          Heruntergeladen – Claude Manager startet zum Installieren kurz neu.
        </template>
        <template v-else-if="state.status === 'error'">Download fehlgeschlagen: {{ state.error }}</template>
        <template v-else>Installiert ist {{ state.current }}. Was neu ist, steht unten.</template>
      </ItemDescription>
    </ItemContent>
    <ItemActions v-if="state.status !== 'downloading'">
      <Button v-if="state.status === 'downloaded'" @click="updates.install()">
        <RotateCwIcon data-icon="inline-start" />
        Neu starten und installieren
      </Button>
      <Button v-else @click="updates.download()">
        <CircleArrowDownIcon data-icon="inline-start" />
        {{ state.status === 'error' ? 'Erneut versuchen' : 'Herunterladen und installieren' }}
      </Button>
    </ItemActions>
    <Progress v-else :model-value="state.progress" class="basis-full" />
  </Item>

  <Alert v-else-if="state.status === 'error'" variant="destructive">
    <CircleAlertIcon />
    <AlertTitle>Update-Suche fehlgeschlagen</AlertTitle>
    <AlertDescription class="selectable">{{ state.error }}</AlertDescription>
  </Alert>

  <Item v-else variant="muted">
    <ItemMedia variant="icon">
      <Spinner v-if="state.status === 'checking'" />
      <CircleCheckIcon v-else-if="state.status === 'up-to-date'" class="text-success" />
      <CircleDashedIcon v-else />
    </ItemMedia>
    <ItemContent>
      <ItemTitle>
        {{
          state.status === 'checking'
            ? 'Suche nach Updates …'
            : state.status === 'up-to-date'
              ? 'Claude Manager ist auf dem neuesten Stand'
              : 'Noch nicht nach Updates gesucht'
        }}
      </ItemTitle>
      <ItemDescription v-if="checkedAt">Zuletzt geprüft: {{ checkedAt }}</ItemDescription>
    </ItemContent>
  </Item>
</template>
