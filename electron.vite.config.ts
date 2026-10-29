import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

const shared = resolve('src/shared')

/**
 * The xterm WebGL renderer paints a background rectangle for every cell that carries a
 * background flag (dim, overline, extended attributes, …) and always does so with alpha 1.
 * With our transparent theme background that turns dim text – e.g. Claude Code's prompt
 * placeholder – into black boxes. Cells without inverse or explicit background now use the
 * theme background's own alpha. Fails the build if a new addon version changes the code.
 */
function xtermWebglTransparency(): Plugin {
  const target = /[\\/]@xterm[\\/]addon-webgl[\\/]lib[\\/]addon-webgl\.m?js$/
  const rectangle =
    /(_updateRectangle\([\w$]+,[\w$]+,([\w$]+),([\w$]+),[\w$]+,[\w$]+,[\w$]+\)\{[\s\S]*?\(([\w$]+)>>8&255\)\/255,[\w$]+=)1(,this\._addRectangle\()/
  return {
    name: 'xterm-webgl-transparency',
    enforce: 'pre',
    transform(code, id) {
      if (!target.test(id.split('?')[0])) return null
      if (!rectangle.test(code)) this.error('xterm-webgl-transparency: Patch passt nicht zur installierten @xterm/addon-webgl-Version.')
      return {
        code: code.replace(
          rectangle,
          (_m, head: string, fg: string, bg: string, rgba: string, tail: string) =>
            `${head}(${fg}&67108864||${bg}&50331648?1:(${rgba}&255)/255)${tail}`,
        ),
        map: null,
      }
    },
  }
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': shared,
      },
    },
    // Pre-bundling would bypass the transform above in dev.
    optimizeDeps: { exclude: ['@xterm/addon-webgl'] },
    plugins: [xtermWebglTransparency(), vue(), tailwindcss()],
  },
})
