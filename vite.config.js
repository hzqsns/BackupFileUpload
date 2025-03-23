import { defineConfig } from 'vite'
import { createVuePlugin } from 'vite-plugin-vue2'

export default defineConfig({
  plugins: [createVuePlugin()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    },
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    }
  },
  optimizeDeps: {
    exclude: ['hash-wasm']
  },
  build: {
    target: 'esnext',
    minify: 'terser',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'hash-worker': ['spark-md5']
        }
      }
    }
  },
  worker: {
    format: 'es',
    plugins: []
  },
  experimental: {
    renderBuiltUrl(filename, { hostType }) {
      if (filename.endsWith('.wasm')) {
        return { relative: true };
      }
      return { relative: true };
    }
  }
})