<script setup lang="ts">
import { LockKeyholeIcon, TriangleAlertIcon } from '@lucide/vue'
import { nextTick, ref, watch } from 'vue'
import type { BrowserLoginRequest } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

/**
 * A site (or a proxy) wants a user name and password before it shows the page (HTTP authentication),
 * over the page like Chrome's question. The page waits until the user answers or cancels.
 */
const props = defineProps<{ request: BrowserLoginRequest; active: boolean }>()
const emit = defineEmits<{ answer: [credentials: { username: string; password: string } | null] }>()

const username = ref('')
const password = ref('')
const userInput = ref<InstanceType<typeof Input> | null>(null)
const ids = `browser-login-${props.request.id}`

function focusUser() {
  void nextTick(() => (userInput.value?.$el as HTMLInputElement | undefined)?.focus())
}

// A new question starts empty; the keyboard goes to it while the pane has it.
watch(
  () => props.request.id,
  () => {
    username.value = ''
    password.value = ''
    if (props.active) focusUser()
  },
)
watch(
  () => props.active,
  (active) => active && focusUser(),
  { immediate: true },
)

function submit() {
  emit('answer', { username: username.value, password: password.value })
}
</script>

<template>
  <div class="pointer-events-auto absolute inset-0 z-20 flex justify-center bg-black/25 px-4 pt-10 animate-in fade-in duration-150">
    <form
      class="flex h-fit w-full max-w-sm flex-col gap-4 rounded-xl border bg-popover p-5 text-popover-foreground shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="`${ids}-title`"
      @submit.prevent="submit"
      @keydown.esc.prevent.stop="emit('answer', null)"
    >
      <div class="flex items-start gap-3">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <LockKeyholeIcon class="size-4" />
        </span>
        <div class="min-w-0 flex-1">
          <h2 :id="`${ids}-title`" class="text-sm font-semibold">Anmelden</h2>
          <p class="mt-0.5 text-xs break-words text-muted-foreground">
            <template v-if="request.proxy">Der Proxy</template>
            <span class="font-medium text-foreground">{{ request.host }}</span>
            verlangt einen Benutzernamen und ein Passwort<template v-if="request.realm"> für „{{ request.realm }}“</template>.
          </p>
        </div>
      </div>
      <p v-if="request.insecure" class="flex items-start gap-2 rounded-md bg-warning/10 px-2.5 py-2 text-xs text-warning">
        <TriangleAlertIcon class="mt-px size-3.5 shrink-0" />
        Die Verbindung ist nicht verschlüsselt: Das Passwort geht lesbar übers Netz.
      </p>
      <FieldGroup class="gap-3">
        <Field>
          <FieldLabel :for="`${ids}-user`">Benutzername</FieldLabel>
          <Input :id="`${ids}-user`" ref="userInput" v-model="username" autocomplete="username" spellcheck="false" />
        </Field>
        <Field>
          <FieldLabel :for="`${ids}-password`">Passwort</FieldLabel>
          <Input :id="`${ids}-password`" v-model="password" type="password" autocomplete="current-password" />
        </Field>
      </FieldGroup>
      <div class="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" @click="emit('answer', null)">Abbrechen</Button>
        <Button type="submit" size="sm">Anmelden</Button>
      </div>
    </form>
  </div>
</template>
