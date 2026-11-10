<script setup lang="ts">
import { FolderPlusIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { folderKey } from '@shared/folders'
import { workspaceNameError } from '@shared/workspaces'
import AccountSelect from '@/components/common/AccountSelect.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useLauncher } from '@/composables/useLauncher'
import { toastError } from '@/lib/errors'
import { shortenPath } from '@/lib/format'
import { useAccountsStore } from '@/stores/accounts'
import { useAppStore } from '@/stores/app'
import { useUiStore } from '@/stores/ui'
import { useWorkspacesStore } from '@/stores/workspaces'

/** A new project in a workspace: a folder in it, and a session that starts there right away. */
const ui = useUiStore()
const app = useAppStore()
const accounts = useAccountsStore()
const workspaces = useWorkspacesStore()
const launcher = useLauncher()

const open = computed({
  get: () => ui.projectRequest !== null,
  set: (value) => {
    if (!value) ui.projectRequest = null
  },
})
/** Kept while the dialog closes, so its text doesn't change during the animation. */
const workspace = ref('')
const workspaceName = ref('')
const name = ref('')
const accountId = ref('')
const touched = ref(false)
const creating = ref(false)

watch(
  () => ui.projectRequest,
  (request) => {
    if (!request) return
    workspace.value = request.workspace
    workspaceName.value = request.name
    name.value = ''
    accountId.value = launcher.defaultAccountId()
    touched.value = false
    creating.value = false
  },
  { immediate: true },
)

/** The projects the workspace has, to say so before the folder is made. */
const existing = computed(
  () => new Set((workspaces.workspaces.find((w) => folderKey(w.path) === folderKey(workspace.value))?.projects ?? []).map((p) => p.toLowerCase())),
)
const nameError = computed(() => {
  const error = workspaceNameError(name.value, 'Projekt')
  if (error) return touched.value ? error : null
  return existing.value.has(name.value.trim().toLowerCase()) ? `„${name.value.trim()}“ gibt es in „${workspaceName.value}“ schon.` : null
})
const target = computed(() => {
  const trimmed = name.value.trim()
  if (!trimmed) return ''
  const dir = workspace.value
  return /[\\/]$/.test(dir) ? `${dir}${trimmed}` : `${dir}${dir.includes('/') && !dir.includes('\\') ? '/' : '\\'}${trimmed}`
})
const canCreate = computed(() => !creating.value && !workspaceNameError(name.value, 'Projekt') && !nameError.value)

async function create() {
  touched.value = true
  if (!canCreate.value) return
  creating.value = true
  try {
    const path = await workspaces.createProject(workspace.value, name.value.trim())
    toast.success(`Projekt „${name.value.trim()}“ angelegt`)
    open.value = false
    // The folder is there now: a session that doesn't start says so itself, the dialog doesn't stay for it.
    await launcher.newSession(accountId.value, path)
  } catch (error) {
    toastError(error, 'Projekt konnte nicht angelegt werden')
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle class="truncate">Neues Projekt in „{{ workspaceName }}“</DialogTitle>
        <DialogDescription>
          Legt einen Ordner im Workspace an und startet darin eine Session. Der Prompt des Workspaces gilt auch dort,
          und Claude Code arbeitet darin ohne Nachfrage.
        </DialogDescription>
      </DialogHeader>

      <form id="project-form" class="flex flex-col gap-5" @submit.prevent="create">
        <FieldGroup>
          <Field :data-invalid="!!nameError || undefined">
            <FieldLabel for="project-name">Name</FieldLabel>
            <Input
              id="project-name"
              v-model="name"
              placeholder="z. B. websiteD"
              spellcheck="false"
              autocomplete="off"
              :disabled="creating"
              @blur="touched = name.trim().length > 0 || touched"
            />
            <FieldError v-if="nameError">{{ nameError }}</FieldError>
            <!-- Wrapped, not cut: the name of the new folder is at the end. -->
            <FieldDescription v-else-if="target" class="font-mono text-xs break-all">
              {{ shortenPath(target, app.info?.homeDir) }}
            </FieldDescription>
          </Field>

          <Field v-if="accounts.accounts.length > 1">
            <FieldLabel for="project-account">Account</FieldLabel>
            <AccountSelect id="project-account" v-model="accountId" />
          </Field>
        </FieldGroup>
      </form>

      <DialogFooter>
        <Button variant="outline" :disabled="creating" @click="open = false">Abbrechen</Button>
        <Button type="submit" form="project-form" :disabled="!canCreate">
          <Spinner v-if="creating" data-icon="inline-start" />
          <FolderPlusIcon v-else data-icon="inline-start" />
          Anlegen und starten
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
