<script setup lang="ts">
import { ChevronRightIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import MarkdownContent from '@/components/sessions/MarkdownContent.vue'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useUpdatesStore } from '@/stores/updates'

/** The descriptions of the pull requests behind a release, from GitHub – loaded when opened. */
const props = defineProps<{ references: number[] }>()

const updates = useUpdatesStore()

const open = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)

const loaded = computed(() => props.references.flatMap((number) => updates.references[number] ?? []))

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  // Descriptions that arrived are shown even if another one fails.
  const results = await Promise.allSettled(props.references.map((number) => updates.loadReference(number)))
  const failed = results.find((result) => result.status === 'rejected')
  error.value = failed ? errorMessage(failed.reason) : null
  loading.value = false
}

watch(open, (isOpen) => {
  if (isOpen && !loading.value && loaded.value.length < props.references.length) void load()
})
</script>

<template>
  <Collapsible v-model:open="open">
    <CollapsibleTrigger as-child>
      <Button variant="ghost" size="sm" class="-ml-2.5 text-muted-foreground">
        <ChevronRightIcon data-icon="inline-start" :class="cn('transition-transform', open && 'rotate-90')" />
        Details
      </Button>
    </CollapsibleTrigger>

    <CollapsibleContent class="mt-2 flex flex-col gap-5 border-t pt-4">
      <article v-for="reference in loaded" :key="reference.number" class="flex flex-col gap-2">
        <!-- With one pull request its title is the line of the notes above. -->
        <h4 v-if="references.length > 1" class="flex items-baseline gap-2 font-medium">
          <span>{{ reference.title }}</span>
          <span class="font-normal text-muted-foreground tabular-nums">#{{ reference.number }}</span>
        </h4>
        <MarkdownContent
          v-if="reference.body"
          :source="reference.body"
          class="text-muted-foreground [&_:is(h1,h2,h3,h4,strong)]:text-foreground"
        />
        <p v-else class="text-muted-foreground">Auf GitHub steht dazu keine Beschreibung.</p>
      </article>

      <div v-if="loading" class="flex flex-col gap-2">
        <Skeleton class="h-4 w-2/3" />
        <Skeleton class="h-4 w-full" />
        <Skeleton class="h-4 w-5/6" />
      </div>

      <div v-else-if="error" class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p class="selectable text-destructive">{{ error }}</p>
        <Button variant="outline" size="xs" @click="load()">Erneut laden</Button>
      </div>
    </CollapsibleContent>
  </Collapsible>
</template>
