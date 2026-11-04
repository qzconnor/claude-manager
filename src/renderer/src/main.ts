import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './assets/main.css'

// Styles that differ between Windows and Linux (e.g. the width of the caption buttons) key off this.
document.documentElement.dataset.platform = window.api.platform

createApp(App).use(createPinia()).use(router).mount('#app')
