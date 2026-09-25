import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The browser has no local database or workbook parser. Those belong to Lambda.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
