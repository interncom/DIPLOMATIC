import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
  },
  server: {
    https: {
      key: fs.readFileSync('./localhost-key.pem'),
      cert: fs.readFileSync('./localhost.pem'),
    },
  }
})
