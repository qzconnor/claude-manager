<script setup lang="ts">
import { Columns2Icon, GlobeIcon, SquareTerminalIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { folderKey } from '@shared/folders'
import { keepTabs, MAX_TAB_SET_COMMAND, MAX_TAB_SET_NAME, tabSetNameError, tabSetTabLabel, tabSetTabs } from '@shared/tab-sets'
import { paneIds } from '@shared/panes'
import type { TabSetTab } from '@shared/types'
import AccountDot from '@/components/common/AccountDot.vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { toastError } from '@/lib/errors'
import { shortenPath } from '@/lib/format'
import { splitFolder } from '@/lib/recent-folders'
import { useAccountsStore } from '@/stores/accounts'
import { useAppStore } from '@/stores/app'
import { useTabSetsStore } from '@/stores/tab-sets'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'

/**
 * Saves the open tabs as a tab set, or changes one: its name, which tabs it holds, whether its
 * sessions go on with their conversation, and the command each shell runs when it starts.
 */
const ui = useUiStore()
const app = useAppStore()
const accounts = useAccountsStore()
const terminals = useTerminalsStore()
const tabSets = useTabSetsStore()

const open = computed({
  get: () => ui.tabSetRequest !== null,
  set: (value) => {
    if (!value) ui.tabSetRequest = null
  },
})
/** Kept while the dialog closes, so its text doesn't change during the animation. */
const editing = ref<string | null>(null)
const name = ref('')
const tabs = ref<TabSetTab[]>([])
const included = ref<boolean[]>([])
/** Start command of each shell, by index in `tabs`. */
const commands = ref<string[]>([])
const resume = ref(false)
const touched = ref(false)
const saving = ref(false)
const loading = ref(false)

/** The tabs open now, as tabs of a set (login tabs can't be in one). */
async function openTabs(): Promise<TabSetTab[]> {
  const [list, layouts] = await Promise.all([window.api.terminals.list(), window.api.terminals.layouts()])
  return tabSetTabs(list, layouts)
}

function take(next: TabSetTab[], previous: TabSetTab[] = []) {
  // Shells taken over from the open tabs keep the command a shell in the same folder had.
  const kept = new Map<string, string[]>()
  for (const tab of previous) {
    if (tab.mode !== 'shell' || !tab.command) continue
    const key = folderKey(tab.cwd)
    kept.set(key, [...(kept.get(key) ?? []), tab.command])
  }
  tabs.value = next
  included.value = next.map(() => true)
  commands.value = next.map((tab) => (tab.mode === 'shell' ? (tab.command ?? kept.get(folderKey(tab.cwd))?.shift() ?? '') : ''))
}

/** A name not taken yet: the folder of the tab in front, else „Tab-Set“, with a number if needed. */
function freeName(): string {
  const cwd = terminals.workingTerminal?.cwd
  const base = (cwd && splitFolder(cwd).name) || 'Tab-Set'
  const taken = new Set(tabSets.sets.map((s) => s.name.toLocaleLowerCase()))
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base} ${n}`
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate.slice(0, MAX_TAB_SET_NAME)
  }
}

let request = 0
watch(
  () => ui.tabSetRequest,
  async (next) => {
    if (!next) return
    const current = ++request
    touched.value = false
    saving.value = false
    if (next.mode === 'edit') {
      const set = tabSets.get(next.id)
      if (!set) {
        ui.tabSetRequest = null
        return
      }
      editing.value = set.id
      name.value = set.name
      take(set.tabs)
      resume.value = set.tabs.some((t) => t.mode === 'session' && t.sessionId)
      return
    }
    editing.value = null
    name.value = freeName()
    resume.value = false
    tabs.value = []
    loading.value = true
    const open = await openTabs().catch(() => [])
    if (current !== request) return
    take(open)
    loading.value = false
  },
  { immediate: true },
)

/** Replaces the set's tabs by the open ones. */
async function takeOpenTabs() {
  const previous = tabs.value.map((tab, i) => (tab.mode === 'shell' ? { ...tab, command: commands.value[i]?.trim() || null } : tab))
  loading.value = true
  try {
    take(await openTabs(), previous)
  } catch (error) {
    toastError(error, 'Die offenen Tabs ließen sich nicht lesen')
  } finally {
    loading.value = false
  }
}

const nameError = computed(() => {
  if (!touched.value) return null
  const error = tabSetNameError(name.value)
  if (error) return error
  const key = name.value.trim().toLocaleLowerCase()
  return tabSets.sets.some((s) => s.id !== editing.value && s.name.toLocaleLowerCase() === key)
    ? `Ein Tab-Set „${name.value.trim()}“ gibt es schon.`
    : null
})
/** Index of each tab that is part of a split tab. */
const splitParts = computed(() => new Set(tabs.value.flatMap((tab) => (tab.layout ? paneIds(tab.layout).map(Number) : []))))
const hasSessions = computed(() => tabs.value.some((t, i) => included.value[i] && t.mode === 'session' && t.sessionId))
const count = computed(() => included.value.filter(Boolean).length)
const canSave = computed(() => !saving.value && !loading.value && count.value > 0 && !tabSetNameError(name.value))

function accountOf(tab: TabSetTab) {
  return tab.mode === 'browser' ? undefined : accounts.get(tab.accountId)
}

/** Where the tab opens, in two parts: the end (the folder's name) stays whole, the start gives way. */
function detail(tab: TabSetTab): [head: string, tail: string] {
  if (tab.mode === 'browser') return [tab.url, '']
  const path = shortenPath(tab.cwd, app.info?.homeDir).replace(/(?<=.)[\\/]+$/, '')
  const at = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return at > 0 ? [path.slice(0, at), path.slice(at)] : [path, '']
}

function focusName() {
  const input = document.getElementById('tab-set-name') as HTMLInputElement | null
  input?.focus()
  input?.select()
}

async function save() {
  touched.value = true
  if (!canSave.value || nameError.value) return
  saving.value = true
  try {
    const shaped = tabs.value.map((tab, i): TabSetTab => {
      if (tab.mode === 'shell') return { ...tab, command: commands.value[i]?.trim() || null }
      if (tab.mode === 'session' && !resume.value) return { ...tab, sessionId: null }
      return tab
    })
    const saved = await tabSets.save({
      id: editing.value,
      name: name.value.trim(),
      tabs: keepTabs(shaped, (_tab, i) => included.value[i] === true),
    })
    toast.success(editing.value ? `Tab-Set „${saved.name}“ gespeichert` : `Tab-Set „${saved.name}“ angelegt`, {
      description: editing.value ? undefined : 'Öffnen über den Pfeil neben „+“ oder die Befehlspalette.',
    })
    open.value = false
  } catch (error) {
    toastError(error, 'Tab-Set konnte nicht gespeichert werden')
  } finally {
    saving.value = false
  }
}

async function remove() {
  const id = editing.value
  if (!id) return
  open.value = false
  await tabSets.remove(id)
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[calc(100vh-4rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl" @open-auto-focus.prevent="focusName">
      <DialogHeader>
        <DialogTitle>{{ editing ? 'Tab-Set bearbeiten' : 'Offene Tabs als Tab-Set speichern' }}</DialogTitle>
        <DialogDescription>
          Ein Klick öffnet alle Tabs des Sets wieder, geteilte Tabs wie gespeichert. Sessions starten in ihrem Ordner, Shells führen ihren
          Startbefehl aus.
        </DialogDescription>
      </DialogHeader>

      <form id="tab-set-form" class="-mx-1 flex min-h-0 flex-col gap-5 overflow-y-auto px-1" @submit.prevent="save">
        <FieldGroup>
          <Field :data-invalid="!!nameError || undefined">
            <FieldLabel for="tab-set-name">Name</FieldLabel>
            <Input
              id="tab-set-name"
              v-model="name"
              placeholder="z. B. Webseite"
              spellcheck="false"
              autocomplete="off"
              :maxlength="MAX_TAB_SET_NAME"
              :disabled="saving"
              @blur="touched = true"
            />
            <FieldError v-if="nameError">{{ nameError }}</FieldError>
          </Field>

          <Field>
            <div class="flex items-center justify-between gap-2">
              <FieldLabel>Tabs</FieldLabel>
              <Button
                v-if="editing"
                type="button"
                variant="ghost"
                size="sm"
                class="-my-1"
                :disabled="loading || saving"
                @click="takeOpenTabs"
              >
                Offene Tabs übernehmen
              </Button>
            </div>
            <div v-if="loading" class="flex justify-center py-6"><Spinner class="size-5 text-muted-foreground" /></div>
            <p v-else-if="!tabs.length" class="rounded-lg border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
              Es sind keine Tabs offen, die ein Tab-Set halten kann.
            </p>
            <ul v-else class="flex flex-col gap-1.5">
              <li
                v-for="(tab, i) in tabs"
                :key="i"
                class="flex items-start gap-2.5 rounded-lg border px-2.5 py-2"
                :class="!included[i] && 'opacity-60'"
              >
                <Checkbox
                  :id="`tab-set-tab-${i}`"
                  class="mt-0.5"
                  :model-value="included[i]"
                  :disabled="saving"
                  @update:model-value="included[i] = $event === true"
                />
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <label :for="`tab-set-tab-${i}`" class="flex min-w-0 items-center gap-2 text-sm leading-5 font-medium">
                    <GlobeIcon v-if="tab.mode === 'browser'" class="size-3.5 shrink-0 text-muted-foreground" />
                    <SquareTerminalIcon v-else-if="tab.mode === 'shell'" class="size-3.5 shrink-0 text-muted-foreground" />
                    <TriangleAlertIcon
                      v-else-if="!accountOf(tab)"
                      v-tooltip="'Den Account dieser Session gibt es nicht mehr: sie öffnet nicht.'"
                      class="size-3.5 shrink-0 text-warning"
                    />
                    <AccountDot v-else v-tooltip="accountOf(tab)?.name" :color="accountOf(tab)?.color" />
                    <span class="truncate">{{ tabSetTabLabel(tab) }}</span>
                    <Columns2Icon
                      v-if="splitParts.has(i)"
                      v-tooltip="'Teil eines geteilten Tabs'"
                      class="size-3.5 shrink-0 text-muted-foreground"
                    />
                  </label>
                  <p v-tooltip="tab.mode === 'browser' ? tab.url : tab.cwd" class="flex min-w-0 font-mono text-xs text-muted-foreground">
                    <span class="truncate">{{ detail(tab)[0] }}</span>
                    <span class="shrink-0">{{ detail(tab)[1] }}</span>
                  </p>
                  <Input
                    v-if="tab.mode === 'shell' && included[i]"
                    v-model="commands[i]"
                    :aria-label="`Startbefehl für ${tabSetTabLabel(tab)}`"
                    placeholder="Startbefehl, z. B. npm run dev"
                    spellcheck="false"
                    autocomplete="off"
                    :maxlength="MAX_TAB_SET_COMMAND"
                    :disabled="saving"
                    class="mt-1.5 h-8 font-mono text-xs"
                  />
                </div>
              </li>
            </ul>
          </Field>

          <Field v-if="hasSessions" orientation="horizontal">
            <Switch id="tab-set-resume" v-model="resume" :disabled="saving" />
            <FieldContent>
              <FieldLabel for="tab-set-resume">Sessions fortsetzen</FieldLabel>
              <FieldDescription>
                {{
                  resume
                    ? 'Jede Session geht mit dem Verlauf weiter, den sie beim Speichern hatte.'
                    : 'Jede Session startet neu, in ihrem Ordner und mit ihrem Account.'
                }}
              </FieldDescription>
            </FieldContent>
          </Field>
        </FieldGroup>
      </form>

      <DialogFooter class="sm:justify-between">
        <Button v-if="editing" variant="ghost" class="text-destructive hover:text-destructive" :disabled="saving" @click="remove">
          Löschen
        </Button>
        <span v-else />
        <div class="flex flex-col-reverse gap-2 sm:flex-row">
          <Button variant="outline" :disabled="saving" @click="open = false">Abbrechen</Button>
          <Button type="submit" form="tab-set-form" :disabled="!canSave">
            <Spinner v-if="saving" data-icon="inline-start" />
            {{ editing ? 'Speichern' : count === 1 ? '1 Tab speichern' : `${count} Tabs speichern` }}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
