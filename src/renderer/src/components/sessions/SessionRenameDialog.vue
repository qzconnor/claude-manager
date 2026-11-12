<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { toastError } from '@/lib/errors'
import { useUiStore } from '@/stores/ui'

/**
 * A session's name in the app: its tabs, the session list and the API show it, also once Claude Code
 * gives the session another title. Empty, the session shows Claude Code's title again.
 */
const ui = useUiStore()

const open = computed({
  get: () => ui.sessionRenameRequest !== null,
  set: (value) => {
    if (!value) ui.sessionRenameRequest = null
  },
})
/** Kept while the dialog closes, so its text doesn't change during the animation. */
const sessionId = ref('')
const named = ref(false)
const name = ref('')
/** What the field showed when the dialog opened. */
const initial = ref('')
const saving = ref(false)

watch(
  () => ui.sessionRenameRequest,
  (request) => {
    if (!request) return
    sessionId.value = request.sessionId
    named.value = request.name !== null
    name.value = request.name ?? request.title
    initial.value = name.value
    saving.value = false
  },
  { immediate: true },
)

/**
 * Enter without a change only closes: without a name of its own, saving would make Claude's title of
 * the moment the session's name, and later titles of Claude wouldn't show any more.
 */
function submit() {
  if (name.value.trim() === initial.value.trim()) open.value = false
  else void save(name.value)
}

async function save(next: string) {
  if (saving.value) return
  saving.value = true
  try {
    await window.api.sessions.rename(sessionId.value, next)
    open.value = false
  } catch (error) {
    toastError(error, 'Umbenennen fehlgeschlagen')
  } finally {
    saving.value = false
  }
}

function selectAll(event: Event) {
  const input = document.getElementById('session-name')
  event.preventDefault()
  if (input instanceof HTMLInputElement) {
    input.focus()
    input.select()
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md" @open-auto-focus="selectAll">
      <DialogHeader>
        <DialogTitle>Session umbenennen</DialogTitle>
        <DialogDescription>
          Der Name steht in der Liste und im Tab der Session, auch wenn Claude ihr später einen neuen Titel gibt.
        </DialogDescription>
      </DialogHeader>

      <form id="session-rename-form" class="flex flex-col gap-5" @submit.prevent="submit">
        <FieldGroup>
          <Field>
            <FieldLabel for="session-name">Name</FieldLabel>
            <Input id="session-name" v-model="name" maxlength="120" spellcheck="false" autocomplete="off" :disabled="saving" />
            <FieldDescription>Leer übernimmt die Session wieder den Titel von Claude.</FieldDescription>
          </Field>
        </FieldGroup>
      </form>

      <DialogFooter>
        <Button v-if="named" variant="ghost" class="sm:mr-auto" :disabled="saving" @click="save('')">Titel von Claude</Button>
        <Button variant="outline" :disabled="saving" @click="open = false">Abbrechen</Button>
        <Button type="submit" form="session-rename-form" :disabled="saving">
          <Spinner v-if="saving" data-icon="inline-start" />
          Umbenennen
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
