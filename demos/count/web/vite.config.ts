import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
  },
  // NOTE: this makes npm run dev work when including the DIPLOMATIC package from npm.
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2022',
    },
  },
})
