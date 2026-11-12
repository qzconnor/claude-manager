<script setup lang="ts">
import { CloudOffIcon, RefreshCwIcon, SearchIcon, ShapesIcon, XIcon } from '@lucide/vue'
import { computed, onActivated, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { SYSTEM_ACCOUNT_ID } from '@shared/defaults'
import type { Artifact } from '@shared/types'
import ArtifactCard from '@/components/artifacts/ArtifactCard.vue'
import ArtifactRenameDialog from '@/components/artifacts/ArtifactRenameDialog.vue'
import AccountSelect from '@/components/common/AccountSelect.vue'
import PageContainer from '@/components/common/PageContainer.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useClock } from '@/composables/useClock'
import { useLauncher } from '@/composables/useLauncher'
import { filterArtifacts, pinnedFirst, type ArtifactFilter } from '@/lib/artifacts'
import { attempt, toastError } from '@/lib/errors'
import { useAccountsStore } from '@/stores/accounts'
import { useArtifactsStore } from '@/stores/artifacts'
import { useSettingsStore } from '@/stores/settings'
import { useThemesStore } from '@/stores/themes'
import { useUiStore } from '@/stores/ui'

/**
 * The pages and documents Claude published on claude.ai with the Artifact tool, per account: open them,
 * copy their link, find the session they were made in, pin, rename and delete them.
 */
const accounts = useAccountsStore()
const store = useArtifactsStore()
const settings = useSettingsStore()
const themes = useThemesStore()
const ui = useUiStore()
const launcher = useLauncher()
const router = useRouter()
// Every 30 seconds: `formatRelative` takes a time up to 45 seconds ahead of it as just now.
const now = useClock(30_000)

/** Accounts with a login at claude.ai; the standard account only while its login has no account of its own. */
const loginAccounts = computed(() =>
  accounts.accounts.filter((a) => a.kind !== 'apiKey' && !(accounts.standardTwin && a.id === SYSTEM_ACCOUNT_ID)),
)

const accountId = ref('')
watch(
  () => loginAccounts.value.map((a) => a.id),
  (ids) => {
    if (ids.includes(accountId.value)) return
    const preferred = launcher.defaultAccountId()
    accountId.value = ids.includes(preferred) ? preferred : (ids[0] ?? '')
  },
  { immediate: true },
)

const list = computed(() => (accountId.value ? (store.lists[accountId.value] ?? null) : null))
const loading = computed(() => store.loading[accountId.value] === true)

const load = () => {
  if (accountId.value) void attempt(() => store.load(accountId.value), 'Artefakte konnten nicht geladen werden')
}
watch(
  accountId,
  (id) => {
    if (id && !store.lists[id]) load()
  },
  { immediate: true },
)
// Back on the page after a while: what changed on claude.ai meanwhile.
onActivated(() => {
  const fetched = list.value ? Date.parse(list.value.fetchedAt) : 0
  if (Date.now() - fetched > 5 * 60_000) load()
})

const filter = ref<ArtifactFilter>('all')
const query = ref('')
const filterOptions = computed(() => [
  { value: 'all' as const, label: 'Alle' },
  { value: 'mine' as const, label: 'Eigene' },
  { value: 'shared' as const, label: 'Geteilt' },
  ...(list.value?.pinsEnabled ? [{ value: 'pinned' as const, label: 'Angepinnt' }] : []),
])
watch(filterOptions, (options) => {
  if (!options.some((o) => o.value === filter.value)) filter.value = 'all'
})
const shown = computed(() => (list.value ? pinnedFirst(filterArtifacts(list.value.artifacts, filter.value, query.value)) : []))
const summary = computed(() => {
  const total = list.value?.artifacts.length ?? 0
  const count = shown.value.length
  const noun = (n: number) => (n === 1 ? 'Artefakt' : 'Artefakte')
  return count === total ? `${total} ${noun(total)}` : `${count} von ${total} ${noun(total)}`
})

/** Thumbnails in the theme's brightness. */
const dark = computed(() => themes.find(settings.settings.appearance.themeId).mode === 'dark')

const failure = computed(() => {
  const status = list.value?.status
  if (!status || status === 'ok') return null
  const titles = { unavailable: 'Keine Artefakte für diesen Account', 'signed-out': 'Nicht angemeldet', error: 'Artefakte nicht erreichbar' }
  return { title: titles[status], message: list.value!.message, signedOut: status === 'signed-out' }
})

function open(artifact: Artifact) {
  void attempt(() => window.api.app.openExternal(artifact.url), 'Artefakt konnte nicht geöffnet werden')
}

async function copy(artifact: Artifact) {
  await navigator.clipboard.writeText(artifact.url)
  toast.success('Link kopiert')
}

function showSession(artifact: Artifact) {
  const session = store.sessionOf(accountId.value, artifact.id)
  if (!session) return
  ui.sessionToShow = { ...session, query: '' }
  void router.push({ name: 'sessions' })
}

async function pin(artifact: Artifact, pinned: boolean) {
  try {
    await store.setPinned(accountId.value, artifact.id, pinned)
  } catch (error) {
    toastError(error, pinned ? 'Anpinnen fehlgeschlagen' : 'Lösen fehlgeschlagen')
  }
}

const renaming = ref<Artifact | null>(null)
const renameOpen = ref(false)
function rename(artifact: Artifact) {
  renaming.value = artifact
  renameOpen.value = true
}

async function remove(artifact: Artifact) {
  const confirmed = await ui.confirm({
    title: 'Artefakt löschen?',
    description: `„${artifact.title}“ wird auf claude.ai gelöscht, auch für alle, mit denen es geteilt ist. Das lässt sich nicht rückgängig machen.`,
    confirmText: 'Löschen',
    destructive: true,
  })
  if (!confirmed) return
  try {
    const result = await store.remove(accountId.value, artifact.id)
    toast.success(result === 'gone' ? 'Das Artefakt war schon gelöscht' : 'Artefakt gelöscht')
  } catch (error) {
    toastError(error, 'Löschen fehlgeschlagen')
  }
}
</script>

<template>
  <PageContainer>
    <PageHeader title="Artefakte" description="Seiten und Dokumente, die Claude für deine Accounts auf claude.ai veröffentlicht hat.">
      <template v-if="loginAccounts.length" #actions>
        <AccountSelect v-model="accountId" :accounts="loginAccounts" class="w-52" />
        <Button variant="outline" :disabled="loading" @click="load">
          <Spinner v-if="loading" data-icon="inline-start" />
          <RefreshCwIcon v-else data-icon="inline-start" />
          Aktualisieren
        </Button>
      </template>
    </PageHeader>

    <Empty v-if="!loginAccounts.length" class="border">
      <EmptyHeader>
        <EmptyMedia variant="icon"><ShapesIcon /></EmptyMedia>
        <EmptyTitle>Kein Account mit Login</EmptyTitle>
        <EmptyDescription>Artefakte gehören zu einem Login bei claude.ai. Accounts mit API-Key haben keine.</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <template v-else>
      <div v-if="list?.status === 'ok' && list.artifacts.length" class="flex flex-wrap items-center gap-3">
        <InputGroup class="h-[32px] w-72">
          <InputGroupAddon><SearchIcon /></InputGroupAddon>
          <InputGroupInput v-model="query" placeholder="Artefakte durchsuchen…" spellcheck="false" @keydown.esc="query = ''" />
          <InputGroupAddon v-if="query" align="inline-end">
            <InputGroupButton size="icon-xs" class="size-[24px]" aria-label="Suche leeren" @click="query = ''">
              <XIcon class="size-[16px]" />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <SegmentedControl v-model="filter" :options="filterOptions" />
        <span class="ml-auto text-xs text-muted-foreground tabular-nums">{{ summary }}</span>
      </div>

      <div v-if="!list" class="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4">
        <div v-for="i in 6" :key="i" class="flex flex-col overflow-hidden rounded-2xl border">
          <Skeleton class="aspect-[2/1] w-full rounded-none" />
          <div class="flex flex-col gap-2 p-3">
            <Skeleton class="h-4 w-2/3" />
            <Skeleton class="h-3 w-1/2" />
          </div>
        </div>
      </div>

      <Empty v-else-if="failure" class="border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><CloudOffIcon /></EmptyMedia>
          <EmptyTitle>{{ failure.title }}</EmptyTitle>
          <EmptyDescription>{{ failure.message }}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent class="flex-row justify-center">
          <Button variant="outline" :disabled="loading" @click="load">Erneut versuchen</Button>
          <Button v-if="failure.signedOut" variant="ghost" @click="router.push({ name: 'accounts' })">Zu den Accounts</Button>
        </EmptyContent>
      </Empty>

      <Empty v-else-if="list.artifacts.length === 0" class="border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><ShapesIcon /></EmptyMedia>
          <EmptyTitle>Noch keine Artefakte</EmptyTitle>
          <EmptyDescription>
            Bittest du Claude in einer Session um eine Seite, ein Diagramm oder ein Dokument zum Teilen, veröffentlicht es sie auf
            claude.ai. Sie erscheinen dann hier.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>

      <Empty v-else-if="shown.length === 0" class="border">
        <EmptyHeader>
          <EmptyTitle>Keine Treffer</EmptyTitle>
          <EmptyDescription>Kein Artefakt passt zu Suche und Filter.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" @click="(query = ''), (filter = 'all')">Suche und Filter zurücksetzen</Button>
        </EmptyContent>
      </Empty>

      <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4">
        <ArtifactCard
          v-for="artifact in shown"
          :key="artifact.id"
          :artifact="artifact"
          :account-id="accountId"
          :dark="dark"
          :pins-enabled="list.pinsEnabled"
          :session="store.sessionOf(accountId, artifact.id)"
          :now="now"
          @open="open(artifact)"
          @copy="copy(artifact)"
          @show-session="showSession(artifact)"
          @pin="pin(artifact, $event)"
          @rename="rename(artifact)"
          @remove="remove(artifact)"
        />
      </div>

      <p v-if="list?.truncated" class="text-xs text-muted-foreground">
        Es gibt mehr Artefakte, als die App auflistet. Alle stehen auf claude.ai.
      </p>
    </template>

    <ArtifactRenameDialog v-model:open="renameOpen" :account-id="accountId" :artifact="renaming" />
  </PageContainer>
</template>
