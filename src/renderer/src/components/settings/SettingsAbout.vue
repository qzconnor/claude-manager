<script setup lang="ts">
import { FolderOpenIcon, SparklesIcon } from '@lucide/vue'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import AppLogo from '@/components/common/AppLogo.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { attempt } from '@/lib/errors'
import { useAppStore } from '@/stores/app'

const app = useAppStore()
const router = useRouter()

const rows = computed(() => {
  const i = app.info
  if (!i) return []
  return [
    ['Version', i.version],
    ['Claude Code', i.claudeVersion ?? 'nicht gefunden'],
    ['Claude-Pfad', i.claudeExecutable ?? '–'],
    ['Electron', i.electron],
    ['Chromium', i.chrome],
    ['Node.js', i.node],
    ['Windows-Build', i.windowsBuild ? String(i.windowsBuild) : '–'],
    ['Datenordner', i.userDataDir],
  ]
})

function openDataDir() {
  if (app.info) void attempt(() => window.api.app.openPath(app.info!.userDataDir), 'Ordner konnte nicht geöffnet werden')
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="flex items-center gap-2">
        <AppLogo class="size-6" />
        {{ app.info?.name ?? 'Claude Manager' }}
      </CardTitle>
      <CardDescription>
        Verwaltet Claude-Code-Terminals, Accounts, Sessions und Usage. Anmeldedaten werden mit Windows DPAPI verschlüsselt.
      </CardDescription>
    </CardHeader>
    <CardContent class="flex flex-col gap-4">
      <Table>
        <TableBody>
          <TableRow v-for="[label, value] in rows" :key="label">
            <TableCell class="w-40 text-muted-foreground">{{ label }}</TableCell>
            <TableCell class="selectable font-mono text-xs break-all whitespace-normal">{{ value }}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" @click="router.push({ name: 'updates' })">
          <SparklesIcon data-icon="inline-start" />
          Updates und Versionshinweise
        </Button>
        <Button variant="outline" size="sm" @click="openDataDir">
          <FolderOpenIcon data-icon="inline-start" />
          Datenordner öffnen
        </Button>
      </div>
    </CardContent>
  </Card>
</template>
