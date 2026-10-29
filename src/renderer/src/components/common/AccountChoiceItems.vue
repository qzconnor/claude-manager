<script setup lang="ts">
import { computed } from 'vue'
import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import type { AccountChoice } from '@/composables/useAccountSwitch'
import { cn } from '@/lib/utils'
import AccountDot from './AccountDot.vue'

/** The accounts a session can continue with, as items of a context or dropdown menu. */
const props = defineProps<{ choices: AccountChoice[]; menu: 'context' | 'dropdown' }>()
const emit = defineEmits<{ select: [accountId: string] }>()

const parts = computed(() =>
  props.menu === 'context'
    ? { Group: ContextMenuGroup, Item: ContextMenuItem, Label: ContextMenuLabel, Separator: ContextMenuSeparator }
    : { Group: DropdownMenuGroup, Item: DropdownMenuItem, Label: DropdownMenuLabel, Separator: DropdownMenuSeparator },
)
const copied = computed(() => props.choices.filter((c) => c.copies && !c.disabled).map((c) => `„${c.account.name}“`))
</script>

<template>
  <component :is="parts.Group">
    <component
      :is="parts.Item"
      v-for="choice in choices"
      :key="choice.account.id"
      :disabled="choice.disabled"
      @select="emit('select', choice.account.id)"
    >
      <AccountDot :color="choice.account.color" />
      <span class="min-w-0 flex-1 truncate">{{ choice.account.name }}</span>
      <span
        v-if="choice.hint"
        :class="cn('ml-auto shrink-0 text-xs tabular-nums', choice.limited ? 'text-warning' : 'text-muted-foreground')"
      >
        {{ choice.hint }}
      </span>
    </component>
    <component :is="parts.Item" v-if="choices.length === 0" disabled>Keine weiteren Accounts</component>
  </component>
  <template v-if="copied.length">
    <component :is="parts.Separator" />
    <component :is="parts.Label" class="max-w-72 text-xs font-normal text-muted-foreground">
      {{ copied.join(', ') }} {{ copied.length === 1 ? 'ist' : 'sind' }} per Browser angemeldet: Die Session wird dorthin
      kopiert.
    </component>
  </template>
</template>
