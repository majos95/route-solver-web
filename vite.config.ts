/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/route-solver-web/',
  plugins: [react()],
  test: {
    environment: 'node',
  },
})
