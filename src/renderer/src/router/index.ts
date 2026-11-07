import { createRouter, createWebHashHistory } from 'vue-router'
import AccountsView from '@/views/AccountsView.vue'
import DashboardView from '@/views/DashboardView.vue'
import SessionsView from '@/views/SessionsView.vue'
import SettingsView from '@/views/SettingsView.vue'
import TerminalsView from '@/views/TerminalsView.vue'

export const SETTINGS_TABS = ['appearance', 'terminal', 'claude', 'tools', 'notifications', 'api', 'updates', 'about'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

/** The updates and release notes, a tab of the settings. */
export const UPDATES_ROUTE = { name: 'settings', query: { tab: 'updates' satisfies SettingsTab } }

/** The notification settings, a tab of the settings. */
export const NOTIFICATIONS_ROUTE = { name: 'settings', query: { tab: 'notifications' satisfies SettingsTab } }

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: { name: 'terminals' } },
    { path: '/terminals', name: 'terminals', component: TerminalsView },
    { path: '/sessions', name: 'sessions', component: SessionsView },
    { path: '/dashboard', name: 'dashboard', component: DashboardView },
    { path: '/accounts', name: 'accounts', component: AccountsView },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/updates', redirect: UPDATES_ROUTE },
    { path: '/:pathMatch(.*)*', redirect: { name: 'terminals' } },
  ],
})
