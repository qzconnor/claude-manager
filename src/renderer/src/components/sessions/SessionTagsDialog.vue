<script setup lang="ts">
import { PlusIcon, XIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { allTags, cleanTag, cleanTags, hasTag, MAX_SESSION_TAGS, MAX_TAG_LENGTH, tagKey } from '@shared/session-marks'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { toastError } from '@/lib/errors'
import { useSessionsStore } from '@/stores/sessions'
import { useUiStore } from '@/stores/ui'

/**
 * A session's tags in the app, e.g. „Bug“ or „Release“: the list shows them under its title, finds the
 * session by them and filters by one. Tags other sessions have are offered to take with a click.
 */
const ui = useUiStore()
const sessions = useSessionsStore()

const open = computed({
  get: () => ui.sessionTagsRequest !== null,
  set: (value) => {
    if (!value) ui.sessionTagsRequest = null
  },
})
/** Kept while the dialog closes, so its text doesn't change during the animation. */
const sessionId = ref('')
const title = ref('')
const tags = ref<string[]>([])
const initial = ref<string[]>([])
const draft = ref('')
const saving = ref(false)

watch(
  () => ui.sessionTagsRequest,
  (request) => {
    if (!request) return
    sessionId.value = request.sessionId
    title.value = request.title
    tags.value = [...request.tags]
    initial.value = [...request.tags]
    draft.value = ''
    saving.value = false
  },
  { immediate: true },
)

const full = computed(() => tags.value.length >= MAX_SESSION_TAGS)
/** The tags of all sessions, in the spelling they have there. */
const known = computed(() => allTags(sessions.groups.flatMap((g) => g.sessions)))
/** Tags of the other sessions this one hasn't got, with the text typed; those that start with it first. */
const suggestions = computed(() => {
  const typed = tagKey(cleanTag(draft.value))
  const others = known.value.filter((tag) => !hasTag(tags.value, tag) && tagKey(tag).includes(typed))
  return [...others.filter((tag) => tagKey(tag).startsWith(typed)), ...others.filter((tag) => !tagKey(tag).startsWith(typed))].slice(0, 12)
})
const changed = computed(() => tags.value.join('\n') !== initial.value.join('\n'))

/**
 * Takes the tags in `text` (separated by commas), each in the spelling another session has it in,
 * unless the session has it already.
 */
function add(text: string) {
  for (const part of text.split(',')) {
    const tag = cleanTag(part)
    if (!tag || full.value || hasTag(tags.value, tag)) continue
    tags.value = cleanTags([...tags.value, known.value.find((t) => tagKey(t) === tagKey(tag)) ?? tag])
  }
}

function remove(tag: string) {
  tags.value = tags.value.filter((t) => t !== tag)
}

// A comma (typed or pasted) ends a tag: what comes before it is taken.
watch(draft, (text) => {
  const end = text.lastIndexOf(',')
  if (end === -1) return
  add(text.slice(0, end))
  draft.value = text.slice(end + 1).trimStart()
})

/** Enter takes what was typed, in an empty field it saves; Backspace in it takes the last tag away. */
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && draft.value.trim()) {
    event.preventDefault()
    add(draft.value)
    draft.value = ''
  } else if (event.key === 'Backspace' && !draft.value && tags.value.length) {
    event.preventDefault()
    tags.value = tags.value.slice(0, -1)
  }
}

async function save() {
  if (saving.value) return
  // Typed but not yet taken: it counts too.
  add(draft.value)
  draft.value = ''
  if (!changed.value) {
    open.value = false
    return
  }
  saving.value = true
  try {
    await sessions.mark(sessionId.value, { tags: tags.value })
    open.value = false
  } catch (error) {
    toastError(error, 'Tags konnten nicht gespeichert werden')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Tags bearbeiten</DialogTitle>
        <DialogDescription class="break-words">
          Tags für „{{ title }}“. Die Liste zeigt sie unter dem Titel, findet die Session über sie und filtert danach.
        </DialogDescription>
      </DialogHeader>

      <form id="session-tags-form" class="flex flex-col gap-4" @submit.prevent="save">
        <Field>
          <FieldLabel for="session-tag">Tags</FieldLabel>
          <div class="flex min-h-[36px] flex-wrap items-center gap-1.5 rounded-md border border-input px-2 py-1.5 dark:bg-input/30">
            <Badge v-for="tag in tags" :key="tag" variant="secondary" class="h-[24px] gap-0.5 pr-0.5 pl-2">
              {{ tag }}
              <button
                type="button"
                class="flex size-[20px] items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                :aria-label="`Tag „${tag}“ entfernen`"
                @click="remove(tag)"
              >
                <XIcon class="size-[12px]" />
              </button>
            </Badge>
            <Input
              id="session-tag"
              v-model="draft"
              :maxlength="MAX_TAG_LENGTH + 2"
              spellcheck="false"
              autocomplete="off"
              :placeholder="full ? '' : tags.length ? 'Weiterer Tag…' : 'z. B. Bug, Release…'"
              :disabled="saving || full"
              class="h-[24px] min-w-28 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
              @keydown="onKeydown"
            />
          </div>
          <FieldDescription>
            Enter oder Komma übernimmt den Tag, Rücktaste im leeren Feld nimmt den letzten weg. Höchstens {{ MAX_SESSION_TAGS }}.
          </FieldDescription>
        </Field>

        <div v-if="suggestions.length && !full" class="flex flex-col gap-2">
          <span class="text-xs text-muted-foreground">Tags anderer Sessions</span>
          <div class="flex flex-wrap gap-1.5">
            <Button
              v-for="tag in suggestions"
              :key="tag"
              type="button"
              variant="outline"
              size="xs"
              class="h-[24px] rounded-full font-normal"
              @click="add(tag)"
            >
              <PlusIcon data-icon="inline-start" />
              {{ tag }}
            </Button>
          </div>
        </div>
      </form>

      <DialogFooter>
        <Button variant="outline" :disabled="saving" @click="open = false">Abbrechen</Button>
        <Button type="submit" form="session-tags-form" :disabled="saving">
          <Spinner v-if="saving" data-icon="inline-start" />
          Speichern
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
