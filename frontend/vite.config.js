import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Without this the dev server tries to watch src-tauri/target and dies with
      // EBUSY the moment cargo locks the freshly built app.exe.
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    rollupOptions: {
      input: {
        index: 'index.html',
        assistant: 'assistant.html',
      }
    }
  }
})
