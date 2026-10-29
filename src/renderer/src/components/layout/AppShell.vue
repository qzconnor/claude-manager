<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TerminalWorkspace from '@/components/terminal/TerminalWorkspace.vue'
import { useTerminalsStore } from '@/stores/terminals'
import NavRail from './NavRail.vue'
import TitleBar from './TitleBar.vue'

const route = useRoute()
const router = useRouter()
const terminals = useTerminalsStore()
const onTerminals = computed(() => route.name === 'terminals')

// Terminals opened through the local API with `activate: true`.
const offActivate = window.api.terminals.onActivate((id) => {
  terminals.activate(id)
  if (route.name !== 'terminals') void router.push({ name: 'terminals' })
})
onBeforeUnmount(offActivate)
</script>

<template>
  <div class="flex h-full flex-col">
    <TitleBar />
    <div class="flex min-h-0 flex-1">
      <NavRail />
      <main class="relative min-w-0 flex-1 overflow-hidden rounded-tl-xl border-t border-l bg-surface">
        <!-- Terminals stay mounted while other pages are shown so their state survives. -->
        <TerminalWorkspace v-show="onTerminals" class="absolute inset-0" :visible="onTerminals" />
        <!-- No v-if on the child: the compiler would give every route the same key and
             KeepAlive would mix up the cached pages. The terminals route renders an empty view. -->
        <RouterView v-slot="{ Component }">
          <KeepAlive>
            <component :is="Component" />
          </KeepAlive>
        </RouterView>
      </main>
    </div>
  </div>
</template>
