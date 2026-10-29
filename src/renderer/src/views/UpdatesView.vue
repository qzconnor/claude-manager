<script setup lang="ts">
import { CloudOffIcon, ExternalLinkIcon, RefreshCwIcon, ScrollTextIcon } from '@lucide/vue'
import { computed, onActivated, ref } from 'vue'
import PageContainer from '@/components/common/PageContainer.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import UpdateStatus from '@/components/updates/UpdateStatus.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { attempt } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { compareVersions } from '@/lib/version'
import { useUpdatesStore } from '@/stores/updates'

const updates = useUpdatesStore()

/** Version installed by an update since the notes were looked at last – highlighted this time. */
const justUpdated = ref<string | null>(null)

// The page stays alive in the background, so this runs every time it is shown.
onActivated(() => {
  if (updates.unseen) justUpdated.value = updates.state.current
  updates.markSeen()
  // Every time: a list loaded earlier may be outdated (or empty) by now.
  void updates.loadReleases()
})

const dateFormat = new Intl.DateTimeFormat('de', { day: 'numeric', month: 'long', year: 'numeric' })
const formatDate = (iso: string) => (iso && !Number.isNaN(Date.parse(iso)) ? dateFormat.format(new Date(iso)) : '')

const isInstalled = (version: string) => version === updates.state.current
const isNewer = (version: string) => !!updates.state.current && compareVersions(version, updates.state.current) > 0

const canCheck = computed(() => !['unsupported', 'checking', 'downloading', 'downloaded'].includes(updates.state.status))

function openLink(url: string) {
  void attempt(() => window.api.app.openExternal(url), 'Link konnte nicht geöffnet werden')
}

/** Links in the notes open in the browser; anchors within the notes are ignored. */
function onNotesClick(event: MouseEvent) {
  const link = (event.target as HTMLElement).closest('a')
  if (!link) return
  event.preventDefault()
  if (/^https?:/i.test(link.href)) openLink(link.href)
}
</script>

<template>
  <PageContainer class="max-w-4xl">
    <PageHeader
      title="Updates"
      description="Neue Versionen von Claude Manager und was sich darin geändert hat. Gesucht wird beim Start und alle 4 Stunden."
    >
      <template #actions>
        <Badge v-if="updates.state.current" variant="secondary" class="tabular-nums">Version {{ updates.state.current }}</Badge>
        <Button variant="outline" :disabled="!canCheck" @click="updates.check()">
          <RefreshCwIcon data-icon="inline-start" :class="updates.state.status === 'checking' && 'animate-spin'" />
          Jetzt suchen
        </Button>
      </template>
    </PageHeader>

    <UpdateStatus />

    <section class="flex flex-col gap-4" aria-labelledby="release-notes-heading">
      <h2 id="release-notes-heading" class="font-heading text-base font-semibold">Versionshinweise</h2>

      <div v-if="updates.releasesLoading && !updates.releases" class="flex flex-col gap-4">
        <Skeleton v-for="n in 2" :key="n" class="h-36 w-full rounded-xl" />
      </div>

      <Empty v-else-if="updates.releasesError" class="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CloudOffIcon />
          </EmptyMedia>
          <EmptyTitle>Versionshinweise nicht erreichbar</EmptyTitle>
          <EmptyDescription class="selectable">{{ updates.releasesError }}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" :disabled="updates.releasesLoading" @click="updates.loadReleases()">
            Erneut laden
          </Button>
        </EmptyContent>
      </Empty>

      <Empty v-else-if="!updates.releases?.length" class="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ScrollTextIcon />
          </EmptyMedia>
          <EmptyTitle>Noch keine Versionen</EmptyTitle>
          <EmptyDescription>Sobald eine Version veröffentlicht ist, steht sie hier.</EmptyDescription>
        </EmptyHeader>
        <!-- GitHub may answer with an empty list for a moment right after a release. -->
        <EmptyContent>
          <Button variant="outline" size="sm" :disabled="updates.releasesLoading" @click="updates.loadReleases()">
            Erneut laden
          </Button>
        </EmptyContent>
      </Empty>

      <template v-else>
        <Card
          v-for="release in updates.releases"
          :key="release.version"
          :class="cn((release.version === justUpdated || isNewer(release.version)) && 'bg-primary/5 ring-2 ring-primary/50')"
        >
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <span class="tabular-nums">{{ release.version }}</span>
              <Badge v-if="release.version === justUpdated">Gerade aktualisiert</Badge>
              <Badge v-else-if="isInstalled(release.version)" variant="secondary">Installiert</Badge>
              <Badge v-else-if="isNewer(release.version)">Neu</Badge>
            </CardTitle>
            <CardDescription v-if="release.date">
              <time :datetime="release.date">{{ formatDate(release.date) }}</time>
            </CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" @click="openLink(release.url)">
                Auf GitHub
                <ExternalLinkIcon data-icon="inline-end" />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <!-- Rendered and sanitized by GitHub. -->
            <div class="release-notes selectable" @click="onNotesClick" v-html="release.html" />
          </CardContent>
        </Card>
      </template>
    </section>
  </PageContainer>
</template>
