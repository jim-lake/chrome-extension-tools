import { crx } from '../../../dist/index.mjs'
import { defineConfig } from 'vite'
import manifest from './manifest.json' with { type: 'json' }

export default defineConfig({
  build: { minify: false },
  clearScreen: false,
  plugins: [crx({ manifest })],
})
