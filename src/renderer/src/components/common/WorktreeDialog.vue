<script setup lang="ts">
import { CircleAlertIcon, FolderGit2Icon } from '@lucide/vue'
import { refDebounced } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import type { WorktreeCheck } from '@shared/types'
import AccountSelect from '@/components/common/AccountSelect.vue'
import DirectoryInput from '@/components/common/DirectoryInput.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useLauncher } from '@/composables/useLauncher'
import { worktreeArgs, worktreeNameError } from '@/lib/worktree'
import { useAccountsStore } from '@/stores/accounts'
import { useUiStore } from '@/stores/ui'

/**
 * A new session in a worktree of its own (`claude --worktree <name>`): Claude Code makes a second
 * checkout of the repository with its own branch, so several sessions can work on it at once.
 */
const ui = useUiStore()
const accounts = useAccountsStore()
const launcher = useLauncher()

const open = computed({
  get: () => ui.worktreeRequest !== null,
  set: (value) => {
    if (!value) ui.worktreeRequest = null
  },
})
const accountId = ref('')
const folder = ref('')
const name = ref('')
const starting = ref(false)

watch(
  () => ui.worktreeRequest,
  (request) => {
    if (!request) return
    accountId.value = accounts.get(request.accountId) ? request.accountId : launcher.defaultAccountId()
    folder.value = request.cwd ?? ''
    name.value = ''
    starting.value = false
  },
  { immediate: true },
)

// The folder is checked as it is typed, the latest answer wins.
const checkedFolder = refDebounced(folder, 300)
const check = ref<WorktreeCheck | null>(null)
const checking = ref(false)
let request = 0
watch(
  [checkedFolder, open],
  async ([dir, isOpen]) => {
    const current = ++request
    check.value = null
    if (!isOpen || !dir.trim()) return
    checking.value = true
    const result = await window.api.git
      .worktreeCheck(dir.trim())
      .catch((error: unknown): WorktreeCheck => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }))
    if (current !== request) return
    check.value = result
    checking.value = false
  },
  { immediate: true },
)

const nameError = computed(() => worktreeNameError(name.value))
const existing = computed(() => (check.value?.ok ? check.value.existing : []))
const reused = computed(() => existing.value.includes(name.value.trim()))
const preview = computed(() => {
  const trimmed = name.value.trim()
  return trimmed && !nameError.value ? trimmed : '<Name>'
})
const canStart = computed(() => check.value?.ok === true && !nameError.value && !starting.value)

function focusFirstField() {
  document.getElementById(folder.value.trim() ? 'worktree-name' : 'worktree-folder')?.focus()
}

async function start() {
  if (!canStart.value) return
  starting.value = true
  const info = await launcher.launch({ accountId: accountId.value, cwd: folder.value.trim(), args: worktreeArgs(name.value) })
  starting.value = false
  if (info) open.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <!-- The folder is mostly given: the keyboard goes to the name, or to the folder when it is missing. -->
    <DialogContent class="sm:max-w-lg" @open-auto-focus.prevent="focusFirstField">
      <DialogHeader>
        <DialogTitle>Neue Session in Worktree</DialogTitle>
        <DialogDescription>
          Claude Code legt einen zweiten Arbeitsordner des Repositorys mit eigenem Branch an. So kommen sich mehrere
          Sessions im selben Projekt nicht in die Quere.
        </DialogDescription>
      </DialogHeader>

      <form id="worktree-form" class="flex flex-col gap-5" @submit.prevent="start">
        <FieldGroup>
          <Field :data-invalid="check?.ok === false || undefined">
            <FieldLabel for="worktree-folder">Repository</FieldLabel>
            <DirectoryInput id="worktree-folder" v-model="folder" :disabled="starting" />
            <FieldError v-if="check?.ok === false" class="flex items-start gap-1.5">
              <CircleAlertIcon class="mt-px size-3.5 shrink-0" />
              {{ check.reason }}
            </FieldError>
            <FieldDescription v-else-if="checking" class="flex items-center gap-1.5">
              <Spinner class="size-3.5" />
              Wird geprüft…
            </FieldDescription>
          </Field>

          <Field :data-invalid="!!nameError || undefined">
            <FieldLabel for="worktree-name">Name</FieldLabel>
            <Input
              id="worktree-name"
              v-model="name"
              placeholder="z. B. login-fix, leer für einen zufälligen Namen"
              spellcheck="false"
              autocomplete="off"
              :disabled="starting"
            />
            <FieldError v-if="nameError">{{ nameError }}</FieldError>
            <FieldDescription v-else-if="reused">
              Den Worktree „{{ name.trim() }}“ gibt es schon: Claude Code arbeitet darin weiter.
            </FieldDescription>
            <FieldDescription v-else class="font-mono text-xs">
              .claude/worktrees/{{ preview }} · Branch worktree-{{ preview }}
            </FieldDescription>
            <div v-if="existing.length" class="flex flex-wrap items-center gap-1.5 pt-1">
              <span class="text-xs text-muted-foreground">Vorhanden:</span>
              <Badge
                v-for="item in existing"
                :key="item"
                as="button"
                type="button"
                variant="outline"
                class="cursor-pointer font-mono"
                @click="name = item"
              >
                <FolderGit2Icon />
                {{ item }}
              </Badge>
            </div>
          </Field>

          <Field v-if="accounts.accounts.length > 1">
            <FieldLabel for="worktree-account">Account</FieldLabel>
            <AccountSelect id="worktree-account" v-model="accountId" />
          </Field>
        </FieldGroup>

        <p class="text-xs text-muted-foreground">
          Beim Beenden räumt Claude Code einen Worktree ohne Änderungen selbst weg und fragt sonst, ob er bleiben soll.
          Damit Git die Worktrees nicht als neue Dateien zeigt, gehört <code class="font-mono">.claude/worktrees/</code>
          in die <code class="font-mono">.gitignore</code>.
        </p>
      </form>

      <DialogFooter>
        <Button variant="outline" @click="open = false">Abbrechen</Button>
        <Button type="submit" form="worktree-form" :disabled="!canStart">
          <Spinner v-if="starting" data-icon="inline-start" />
          <FolderGit2Icon v-else data-icon="inline-start" />
          Session starten
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
