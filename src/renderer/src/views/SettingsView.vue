<script setup lang="ts">
import { ref } from 'vue'
import PageContainer from '@/components/common/PageContainer.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import SettingsAbout from '@/components/settings/SettingsAbout.vue'
import SettingsApi from '@/components/settings/SettingsApi.vue'
import SettingsAppearance from '@/components/settings/SettingsAppearance.vue'
import SettingsClaude from '@/components/settings/SettingsClaude.vue'
import SettingsTerminal from '@/components/settings/SettingsTerminal.vue'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const tab = ref('appearance')
</script>

<template>
  <PageContainer class="max-w-4xl">
    <PageHeader title="Einstellungen" description="Änderungen werden sofort übernommen und gespeichert." />
    <Tabs v-model="tab" class="gap-4">
      <TabsList>
        <TabsTrigger value="appearance">Darstellung</TabsTrigger>
        <TabsTrigger value="terminal">Terminal</TabsTrigger>
        <TabsTrigger value="claude">Claude Code</TabsTrigger>
        <TabsTrigger value="api">API</TabsTrigger>
        <TabsTrigger value="about">Info</TabsTrigger>
      </TabsList>
      <TabsContent value="appearance"><SettingsAppearance /></TabsContent>
      <TabsContent value="terminal"><SettingsTerminal /></TabsContent>
      <TabsContent value="claude"><SettingsClaude /></TabsContent>
      <TabsContent value="api"><SettingsApi /></TabsContent>
      <TabsContent value="about"><SettingsAbout /></TabsContent>
    </Tabs>
  </PageContainer>
</template>
