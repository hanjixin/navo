import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve('src/shared') }

/**
 * Main / agent-host code is bundled with all its JS dependencies; only native modules stay external
 * (they are the only runtime `dependencies` in package.json). This keeps the app self-contained —
 * some packages (e.g. @langchain/langgraph-sdk) ship vendored files under nested node_modules that
 * electron-builder would otherwise drop — and makes the installer smaller.
 */
const nodeDeps = externalizeDepsPlugin()

export default defineConfig({
  main: {
    plugins: [nodeDeps],
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        output: {
          // some bundled CommonJS libraries (turndown) call require() at load time; give the ESM output one
          banner: "import { createRequire as __navoCreateRequire } from 'node:module'; const require = __navoCreateRequire(import.meta.url);",
        },
        input: {
          index: resolve('src/main/index.ts'),
          'agent-host': resolve('src/main/agent-host/index.ts'),
          'parser-host': resolve('src/main/files/parser-host.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [nodeDeps],
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          tab: resolve('src/preload/tab.ts'),
        },
        // sandboxed preloads must be CommonJS
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    resolve: {
      alias: { '@': resolve('src/renderer/src'), ...shared },
    },
    plugins: [react(), tailwindcss()],
  },
})
