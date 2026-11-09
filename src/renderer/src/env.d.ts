/// <reference types="vite/client" />

// highlight.js ships no declarations for its single languages.
declare module 'highlight.js/lib/languages/*' {
  import type { LanguageFn } from 'highlight.js'
  const language: LanguageFn
  export default language
}
