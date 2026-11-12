<script setup lang="ts">
import type { SessionContext } from '@shared/types'
import { computed, ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { contextGauge, modelName, shortTokens } from '@/lib/context'
import { formatNumber } from '@/lib/format'
import { usageFillClass, usageLevel, usageTextClass } from '@/lib/usage'
import { cn } from '@/lib/utils'

/**
 * How full the context of the session in the active tab is, on its way to Claude Code's next
 * auto-compact: a small bar and `136k/367k 37%` in the title bar, the details in a popover. From the
 * start of the session: until its first answer tells the tokens, `0/367k 0%`.
 */
const props = defineProps<{ context: SessionContext; compacting: boolean }>()

const open = ref(false)
const gauge = computed(() => contextGauge(props.context))
const level = computed(() => usageLevel(gauge.value.percent))
const auto = computed(() => props.context.compactAt !== null)
const model = computed(() => modelName(props.context.model))
/** Null before the first answer. */
const tokens = computed(() => props.context.tokens)
const label = computed(() => {
  if (props.compacting) return 'Kontext: Claude Code fasst den Verlauf gerade zusammen'
  const until = `${shortTokens(gauge.value.limit)}${auto.value ? ' bis zum Auto-Compact' : ''}`
  if (tokens.value === null) return `Kontext: noch keine Antwort, ${until}`
  return `Kontext ${shortTokens(tokens.value)} von ${until}, ${gauge.value.percent} %`
})
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        variant="outline"
        size="sm"
        class="app-no-drag gap-2 bg-background/40 px-2.5 font-normal text-muted-foreground"
        :aria-label="label"
      >
        <template v-if="compacting">
          <Spinner class="size-3.5" />
          <span>Komprimiert …</span>
        </template>
        <template v-else>
          <!-- Empty it would only be a grey bar: it comes with the first percent. -->
          <span
            v-if="gauge.percent > 0"
            aria-hidden="true"
            class="relative h-1.5 w-6 shrink-0 overflow-hidden rounded-full bg-foreground/15"
          >
            <span
              :class="cn('absolute inset-y-0 left-0 rounded-full bg-current transition-[width] duration-500', usageTextClass[level])"
              :style="{ width: `${gauge.percent}%` }"
            />
          </span>
          <span class="tabular-nums">
            <span class="font-medium text-foreground">{{ shortTokens(tokens ?? 0) }}</span>/{{ shortTokens(gauge.limit) }}
          </span>
          <span :class="cn('font-medium tabular-nums', level === 'low' ? 'text-foreground' : usageTextClass[level])">
            {{ gauge.percent }}&nbsp;%
          </span>
        </template>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-80 gap-0 p-0" @open-auto-focus.prevent @close-auto-focus.prevent>
      <div class="flex flex-col gap-3 p-3">
        <div class="flex items-center justify-between gap-3">
          <span class="font-heading font-medium">Kontext</span>
          <Badge v-if="model" variant="secondary">{{ model }}</Badge>
        </div>
        <div class="flex flex-col gap-1.5">
          <div class="flex items-baseline justify-between gap-3 text-xs">
            <span class="text-muted-foreground tabular-nums">
              <span class="text-sm font-medium text-foreground">{{ formatNumber(tokens ?? 0) }}</span>
              / {{ formatNumber(gauge.limit) }} Tokens
            </span>
            <span :class="cn('font-medium tabular-nums', usageTextClass[level])">{{ gauge.percent }} %</span>
          </div>
          <Progress :model-value="gauge.percent" :class="cn('h-1.5', usageFillClass[level])" />
          <p class="text-xs text-muted-foreground">
            <template v-if="compacting">Claude Code fasst den Verlauf gerade zusammen.</template>
            <template v-else-if="tokens === null">Wie voll der Kontext ist, zeigt die erste Antwort.</template>
            <template v-else-if="auto">Noch {{ shortTokens(gauge.left) }} Tokens bis zum Auto-Compact.</template>
            <template v-else>Auto-Compact ist aus: noch {{ shortTokens(gauge.left) }} Tokens bis das Kontextfenster voll ist.</template>
          </p>
        </div>
      </div>
      <Separator />
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 p-3 text-xs">
        <dt class="text-muted-foreground">Fenster</dt>
        <dd class="tabular-nums">
          {{ shortTokens(context.window) }}
          <span class="text-muted-foreground">· {{ context.configured ? 'per /autocompact' : 'Kontextfenster des Modells' }}</span>
        </dd>
        <template v-if="auto">
          <dt class="text-muted-foreground">Puffer</dt>
          <dd class="tabular-nums">
            {{ shortTokens(gauge.buffer) }}
            <span class="text-muted-foreground">· für Antwort und Zusammenfassung</span>
          </dd>
        </template>
      </dl>
      <p class="px-3 pb-3 text-xs text-muted-foreground">
        Ändern mit <code class="rounded bg-muted px-1 py-px font-mono">/autocompact</code> in der Session.
      </p>
    </PopoverContent>
  </Popover>
</template>
