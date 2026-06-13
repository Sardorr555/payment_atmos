import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Base path — must match where the app is served on the server
  base: '/payment/',
  server: {
    proxy: {
      // All /api/* requests go to our secure Express backend
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    }
  }
})
