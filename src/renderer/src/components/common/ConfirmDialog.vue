<script setup lang="ts">
import { TriangleAlertIcon } from '@lucide/vue'
import { computed, onBeforeUnmount } from 'vue'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { useUiStore } from '@/stores/ui'

/**
 * Renders the confirmation requested through `useUiStore().confirm()` and the message boxes
 * of the main process (closing with running terminals, `cm` errors).
 * Plain buttons instead of AlertDialogAction/Cancel: those close the dialog before our
 * click handler runs, which would settle the promise with `false` first.
 */
const ui = useUiStore()
const state = computed(() => ui.confirmState)

function onOpenChange(open: boolean) {
  if (!open) ui.settleConfirm(false)
}

const offDialog = window.api.window.onDialog(async ({ id, ...options }) => {
  window.api.window.answerDialog(id, await ui.confirm(options))
})
onBeforeUnmount(offDialog)
</script>

<template>
  <AlertDialog :open="state?.open ?? false" @update:open="onOpenChange">
    <AlertDialogContent v-if="state">
      <AlertDialogHeader>
        <AlertDialogMedia v-if="state.warning" class="bg-warning/15 text-warning">
          <TriangleAlertIcon />
        </AlertDialogMedia>
        <AlertDialogTitle>{{ state.title }}</AlertDialogTitle>
        <AlertDialogDescription v-if="state.description" class="selectable [overflow-wrap:anywhere]">
          {{ state.description }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <Button v-if="state.kind !== 'alert'" variant="outline" @click="ui.settleConfirm(false)">
          {{ state.cancelText ?? 'Abbrechen' }}
        </Button>
        <Button :variant="state.destructive ? 'destructive' : 'default'" @click="ui.settleConfirm(true)">
          {{ state.confirmText ?? 'OK' }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
