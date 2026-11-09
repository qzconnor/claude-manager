<script setup lang="ts">
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { OpenedImage } from '@/composables/useTerminal'

/** A pasted image in full size, opened by a click on its `[Image #N]`. */
defineProps<{ image: OpenedImage | null }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <Dialog :open="!!image" @update:open="(open) => !open && emit('close')">
    <!-- As wide as the image, at most the window: centred with left 50%, an auto width would end at
         half the window. The image's limits are in viewport units, so they count for that width. -->
    <DialogContent v-if="image" class="w-max min-w-64 max-w-[calc(100vw-4rem)] gap-3 p-3 sm:max-w-[calc(100vw-4rem)]">
      <DialogHeader class="pr-8 pl-1">
        <DialogTitle>
          Bild #{{ image.id }}
          <span v-if="!image.sent" class="font-normal text-muted-foreground">· nicht gesendet</span>
        </DialogTitle>
        <DialogDescription class="sr-only">Das Bild, das du als [Image #{{ image.id }}] eingefügt hast.</DialogDescription>
      </DialogHeader>
      <img :src="image.src" alt="" class="max-h-[calc(100vh-9rem)] max-w-[calc(100vw-5.5rem)] justify-self-center rounded-lg" />
    </DialogContent>
  </Dialog>
</template>
