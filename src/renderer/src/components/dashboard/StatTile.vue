<script setup lang="ts">
import type { Component } from 'vue'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

defineProps<{ label: string; value: string; hint?: string; icon?: Component }>()
</script>

<template>
  <Card size="sm">
    <CardHeader>
      <CardDescription class="flex items-center gap-1.5">
        <component :is="icon" v-if="icon" class="size-3.5" />
        {{ label }}
      </CardDescription>
      <CardTitle class="text-xl font-semibold tabular-nums">{{ value }}</CardTitle>
    </CardHeader>
    <CardContent v-if="hint" class="text-xs text-muted-foreground">{{ hint }}</CardContent>
  </Card>
</template>
