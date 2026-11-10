import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { vTooltip } from './lib/tooltip'
import { router } from './router'
import './assets/main.css'

declare module 'vue' {
  interface GlobalDirectives {
    /** The app's tooltip instead of `title` (see lib/tooltip.ts). */
    vTooltip: typeof vTooltip
  }
}

// Styles that differ between Windows and Linux (e.g. the width of the caption buttons) key off this.
document.documentElement.dataset.platform = window.api.platform

createApp(App).use(createPinia()).use(router).directive('tooltip', vTooltip).mount('#app')
