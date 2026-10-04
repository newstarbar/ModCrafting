import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Allow tests to resolve renderer-relative imports
      '../../../../packaging/appIcon.png': resolve(__dirname, 'src/renderer/public/blocks/stone.png')
    }
  },
  test: {
    environment: 'jsdom',
    root: resolve(__dirname, 'src/renderer'),
    include: ['src/**/*.snapshot.test.{ts,tsx}'],
    globals: true,
    setupFiles: [resolve(__dirname, 'src/renderer/src/__tests__/setup.ts')],
    css: false,
    server: {
      deps: {
        inline: [/react-markdown/, /remark-gfm/]
      }
    }
  }
})
