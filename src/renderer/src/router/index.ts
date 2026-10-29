import { createRouter, createWebHashHistory } from 'vue-router'
import AccountsView from '@/views/AccountsView.vue'
import DashboardView from '@/views/DashboardView.vue'
import SessionsView from '@/views/SessionsView.vue'
import SettingsView from '@/views/SettingsView.vue'
import TerminalsView from '@/views/TerminalsView.vue'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: { name: 'terminals' } },
    { path: '/terminals', name: 'terminals', component: TerminalsView },
    { path: '/sessions', name: 'sessions', component: SessionsView },
    { path: '/dashboard', name: 'dashboard', component: DashboardView },
    { path: '/accounts', name: 'accounts', component: AccountsView },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/:pathMatch(.*)*', redirect: { name: 'terminals' } },
  ],
})
