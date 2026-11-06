<script lang="ts" setup>
import type { ToasterProps } from 'vue-sonner'

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
} from '@lucide/vue'
import { reactiveOmit } from '@vueuse/core'
import { cn } from 'cn'
import { computed } from 'vue'
import { Toaster as Sonner } from 'vue-sonner'
import { buttonVariants } from '@/components/ui/button'

const props = defineProps<ToasterProps>()
const delegatedProps = reactiveOmit(props, 'class', 'toastOptions')

/*
 * Unstyled: Sonner keeps positioning, stacking and swiping, the look comes from here. Like the app's
 * popovers and the banners over the terminals: popover surface, faint ring, coloured icon, buttons of the app.
 * Icon and text sit in a grid, the action goes below the text so long descriptions keep their width.
 */
const toastOptions = computed<ToasterProps['toastOptions']>(() => ({
  unstyled: true,
  closeButtonAriaLabel: 'Schließen',
  ...props.toastOptions,
  classes: {
    toast: cn(
      'grid w-(--width) grid-cols-[auto_minmax(0,1fr)] items-start rounded-xl bg-popover py-3 pr-10 pl-3.5 font-sans text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
      // Collapsed stack: the toasts behind show only their edge.
      'data-[expanded=false]:data-[front=false]:*:opacity-0',
    ),
    icon: 'col-start-1 row-start-1 mr-2.5 flex h-5 items-center [&_svg]:size-4',
    content: 'col-start-2 row-start-1 flex min-w-0 flex-col gap-0.5',
    title: 'leading-5 font-medium',
    description: 'text-[0.8rem] leading-snug text-muted-foreground',
    actionButton: cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'col-start-2 mt-2.5 justify-self-start'),
    cancelButton: cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'col-start-2 mt-2.5 justify-self-start'),
    closeButton: cn(
      buttonVariants({ variant: 'ghost', size: 'icon-xs' }),
      // bg-transparent: Sonner's dark theme paints its own close button, also on unstyled toasts.
      'absolute top-2.5 right-2.5 bg-transparent text-muted-foreground hover:text-foreground',
    ),
    success: '[&_[data-icon]]:text-success',
    error: '[&_[data-icon]]:text-destructive',
    warning: '[&_[data-icon]]:text-warning',
    info: '[&_[data-icon]]:text-primary',
    loading: '[&_[data-icon]]:text-muted-foreground',
    ...props.toastOptions?.classes,
  },
}))
</script>

<template>
  <Sonner
    :class="cn('toaster group', props.class)"
    v-bind="delegatedProps"
    :toast-options="toastOptions"
    :container-aria-label="props.containerAriaLabel ?? 'Benachrichtigungen'"
  >
    <template #success-icon>
      <CircleCheckIcon />
    </template>
    <template #info-icon>
      <InfoIcon />
    </template>
    <template #warning-icon>
      <TriangleAlertIcon />
    </template>
    <template #error-icon>
      <OctagonXIcon />
    </template>
    <template #loading-icon>
      <Loader2Icon class="animate-spin" />
    </template>
    <template #close-icon>
      <XIcon />
    </template>
  </Sonner>
</template>
