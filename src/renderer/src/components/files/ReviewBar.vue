<script setup lang="ts">
import { ChevronDownIcon, ChevronUpIcon, ClipboardCopyIcon, MessageSquareTextIcon, SendIcon, Trash2Icon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import AccountDot from '@/components/common/AccountDot.vue'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { attempt } from '@/lib/errors'
import { baseName, parentPath } from '@/lib/file-tree'
import { refLabel, sortComments, type ReviewComment } from '@/lib/review-comments'
import { useAccountsStore } from '@/stores/accounts'
import { useReviewStore } from '@/stores/review'

/**
 * Below the changes while there are comments for Claude in the folder: how many (a list of them to
 * look at, change or delete), and the button that puts them all into the prompt of the Claude session
 * working there, of the one chosen when there are several. `only`: the file the view shows; the
 * comments of other files are listed but can't be shown here.
 */
const props = defineProps<{ root: string; only?: string }>()
const emit = defineEmits<{ reveal: [comment: ReviewComment] }>()

const review = useReviewStore()
const accounts = useAccountsStore()

const comments = computed(() => sortComments(review.of(props.root)))
const countLabel = computed(() => (comments.value.length === 1 ? '1 Kommentar' : `${comments.value.length} Kommentare`))
const listOpen = ref(false)
watch(
  () => comments.value.length,
  (n) => {
    if (n === 0) listOpen.value = false
  },
)

const targets = computed(() => review.targets(props.root))
const chosenId = ref<string | null>(null)
const target = computed(() => targets.value.find((t) => t.id === chosenId.value) ?? targets.value[0] ?? null)
const sendHint = computed(() =>
  target.value
    ? `In den Prompt von „${target.value.title}“ einfügen, abgeschickt wird mit Enter`
    : 'In diesem Ordner läuft keine Claude-Session: in die Zwischenablage kopieren',
)

const canReveal = (comment: ReviewComment) => !props.only || comment.path === props.only

function reveal(comment: ReviewComment) {
  listOpen.value = false
  emit('reveal', comment)
}

const count = (n: number) => (n === 1 ? '1 Kommentar' : `${n} Kommentare`)

async function send() {
  const to = target.value
  const result = await attempt(() => review.send(props.root, to?.id ?? null), 'Kommentare nicht übergeben')
  if (!result) return
  const { pasted, taken } = result
  const back = { label: 'Zurückholen', onClick: () => review.restore(taken) }
  if (pasted && to) toast.success(`${count(taken.length)} im Prompt von „${to.title}“`, { description: 'Mit Enter an Claude schicken.', action: back })
  else {
    toast.success(`${count(taken.length)} in die Zwischenablage kopiert`, {
      description: to ? `„${to.title}“ ist gerade nicht offen.` : 'In diesem Ordner läuft keine Claude-Session.',
      action: back,
    })
  }
}

function discard() {
  const taken = review.take(props.root)
  if (taken.length) toast(`${count(taken.length)} verworfen`, { action: { label: 'Rückgängig', onClick: () => review.restore(taken) } })
}
</script>

<template>
  <div v-if="comments.length" class="flex h-[40px] shrink-0 items-center gap-1.5 border-t bg-background pr-2 pl-1.5 font-sans text-foreground">
    <Popover v-model:open="listOpen">
      <PopoverTrigger as-child>
        <Button variant="ghost" size="sm" :aria-label="`${countLabel} für Claude anzeigen`">
          <MessageSquareTextIcon class="text-primary" data-icon="inline-start" />
          {{ countLabel }}
          <ChevronUpIcon class="text-muted-foreground" data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" class="w-[min(26rem,90vw)] p-1">
        <ul class="flex max-h-80 flex-col overflow-y-auto" aria-label="Kommentare für Claude">
          <li v-for="comment in comments" :key="comment.id" class="group/item flex items-start gap-1 rounded-md hover:bg-accent">
            <button
              type="button"
              class="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default"
              :disabled="!canReveal(comment)"
              @click="reveal(comment)"
            >
              <span class="flex min-w-0 gap-1 text-xs" v-tooltip="comment.path">
                <span class="shrink-0 font-medium">{{ baseName(comment.path) }}</span>
                <span class="shrink-0 text-muted-foreground">· {{ refLabel(comment.ref) }}</span>
                <span v-if="parentPath(comment.path)" class="min-w-0 truncate text-muted-foreground/70">· {{ parentPath(comment.path) }}</span>
              </span>
              <span class="line-clamp-2 text-xs break-words whitespace-pre-line text-muted-foreground">{{ comment.text }}</span>
            </button>
            <button
              type="button"
              aria-label="Kommentar löschen"
              class="mt-1 mr-1 flex size-[24px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity outline-none group-hover/item:opacity-100 hover:bg-destructive/15 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50"
              v-tooltip="'Löschen'"
              @click="review.remove(comment.id)"
            >
              <Trash2Icon class="size-[14px]" />
            </button>
          </li>
        </ul>
      </PopoverContent>
    </Popover>
    <span class="flex-1" />
    <Button variant="ghost" size="sm" class="text-muted-foreground" v-tooltip="'Alle Kommentare dieses Ordners verwerfen'" @click="discard">
      Verwerfen
    </Button>
    <ButtonGroup>
      <Button size="sm" v-tooltip="sendHint" @click="send">
        <SendIcon v-if="target" data-icon="inline-start" />
        <ClipboardCopyIcon v-else data-icon="inline-start" />
        {{ target ? 'An Claude schicken' : 'Kopieren' }}
      </Button>
      <DropdownMenu v-if="targets.length > 1">
        <DropdownMenuTrigger as-child>
          <Button size="sm" class="border-l border-primary-foreground/20 px-1.5" aria-label="Session wählen">
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-64">
          <DropdownMenuLabel>An welche Session?</DropdownMenuLabel>
          <DropdownMenuRadioGroup :model-value="target?.id" @update:model-value="chosenId = String($event)">
            <DropdownMenuRadioItem v-for="t in targets" :key="t.id" :value="t.id">
              <AccountDot :color="accounts.get(t.authAccountId)?.color" />
              <span class="truncate">{{ t.title }}</span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  </div>
</template>
