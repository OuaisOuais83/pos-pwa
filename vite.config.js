import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      includeAssets: ['favicon.svg', 'robots.txt', 'logo.png'],
      manifest: {
        name: 'POS Nightclub',
        short_name: 'POS',
        description: 'Point of Sale PWA pour boîte de nuit',
        theme_color: '#1F2937',
        background_color: '#111827',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        runtimeCaching: [
          {
            urlPattern: /\/.*\.(js|css|html|json)/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'assets-cache'
            }
          }
        ]
      }
    })
  ]
})