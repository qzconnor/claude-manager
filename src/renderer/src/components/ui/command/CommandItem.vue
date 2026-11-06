<script setup lang="ts">
import type { ListboxItemEmits, ListboxItemProps } from 'reka-ui'

import type { HTMLAttributes } from 'vue'
import { CheckIcon } from '@lucide/vue'
import { reactiveOmit, useCurrentElement } from '@vueuse/core'
import { cn } from 'cn'
import { ListboxItem, useForwardPropsEmits, useId } from 'reka-ui'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useCommand, useCommandGroup } from '.'

const props = defineProps<ListboxItemProps & {
  class?: HTMLAttributes['class']
  /** Text the search is matched against instead of the item's content. */
  filterText?: string
  /** Only shown while searching; needs `filterText`, as it isn't rendered before. */
  searchOnly?: boolean
}>()
const emits = defineEmits<ListboxItemEmits>()

const delegatedProps = reactiveOmit(props, 'class', 'filterText', 'searchOnly')

const forwarded = useForwardPropsEmits(delegatedProps, emits)

const id = useId()
const { filterState, allItems, allGroups } = useCommand()
const groupContext = useCommandGroup()

const isRender = computed(() => {
  if (!filterState.search.trim()) {
    return !props.searchOnly
  }
  else {
    const filteredCurrentItem = filterState.filtered.items.get(id)
    // If the filtered items is undefined means not in the all times map yet
    // Do the first render to add into the map
    if (filteredCurrentItem === undefined) {
      return !props.searchOnly
    }

    // Check with filter
    return filteredCurrentItem > 0
  }
})

function register(text: string) {
  // textValue to perform filter
  allItems.value.set(id, text)

  const groupId = groupContext?.id
  if (groupId) {
    if (!allGroups.value.has(groupId)) {
      allGroups.value.set(groupId, new Set([id]))
    }
    else {
      allGroups.value.get(groupId)?.add(id)
    }
  }
}

// Known without rendering, so a search-only item is found before it is shown
if (props.filterText !== undefined)
  register(props.filterText)

const itemRef = ref()
const currentElement = useCurrentElement(itemRef)
onMounted(() => {
  if (props.filterText !== undefined || !(currentElement.value instanceof HTMLElement))
    return
  register(currentElement.value.textContent ?? (props.value?.toString() ?? ''))
})
onUnmounted(() => {
  allItems.value.delete(id)
})
</script>

<template>
  <ListboxItem
    v-if="isRender"
    v-bind="forwarded"
    :id="id"
    ref="itemRef"
    data-slot="command-item"
    :class="cn('data-highlighted:bg-muted data-highlighted:text-foreground data-highlighted:*:[svg]:text-foreground relative flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none in-data-[slot=dialog-content]:rounded-lg! [&_svg:not([class*=size-])]:size-4 group/command-item data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0', props.class)"
    @select="() => {
      filterState.search = ''
    }"
  >
    <slot />
    <CheckIcon class="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
  </ListboxItem>
</template>
