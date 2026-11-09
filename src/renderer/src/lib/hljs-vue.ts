import type { HLJSApi, Language, Mode } from 'highlight.js'

/**
 * Single-file components (Vue, Svelte) for highlight.js, which has no grammar of its own for them: the
 * markup as HTML, `<script>` as JavaScript or (with `lang="ts"`) TypeScript, `<style>` as CSS, SCSS or
 * Less, and `{{ … }}` in the markup as an expression.
 */

/** A block between `open` and its closing tag in another language; the tags stay HTML. */
function block(open: RegExp, close: RegExp, language: string): Mode {
  return { begin: open, end: close, subLanguage: language, excludeBegin: true, excludeEnd: true }
}

export default function vue(hljs: HLJSApi): Language {
  const SCRIPT_END = /<\/script\s*>/
  const STYLE_END = /<\/style\s*>/
  return {
    name: 'Vue',
    aliases: ['svelte'],
    case_insensitive: true,
    subLanguage: 'xml',
    contains: [
      // A tag in a comment opens no block.
      hljs.COMMENT('<!--', '-->', { relevance: 10 }),
      // The first block that matches wins: those with a `lang` before the plain ones.
      block(/<script\b[^>]*\blang\s*=\s*["']?tsx?["']?[^>]*>/, SCRIPT_END, 'typescript'),
      block(/<script\b[^>]*>/, SCRIPT_END, 'javascript'),
      block(/<style\b[^>]*\blang\s*=\s*["']?s[ac]ss["']?[^>]*>/, STYLE_END, 'scss'),
      block(/<style\b[^>]*\blang\s*=\s*["']?less["']?[^>]*>/, STYLE_END, 'less'),
      block(/<style\b[^>]*>/, STYLE_END, 'css'),
      block(/\{\{/, /\}\}/, 'typescript'),
    ],
  }
}
