import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The release version comes from CHANGELOG.md at build time, so the badge in
// the shell can never drift from what the changelog says shipped.
const release = /##\s+(\d+\.\d+\.\d+)/.exec(readFileSync('../CHANGELOG.md', 'utf8'))?.[1] ?? ''

export default defineConfig({
  plugins: [react()],
  define: { __MB_RELEASE__: JSON.stringify(release) },
})
