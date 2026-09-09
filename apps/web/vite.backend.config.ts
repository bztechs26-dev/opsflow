import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The browser has no local database or workbook parser. Those belong to Lambda.
export default defineConfig({ plugins: [react()] })
