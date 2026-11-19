import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/DB-radar/',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'DB-radar',
        short_name: 'DB-radar',
        description: '司機用的熱點雷達',
        lang: 'zh-TW',
        start_url: '/DB-radar/',
        scope: '/DB-radar/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#05100a',
        theme_color: '#05100a',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallback: '/DB-radar/index.html',
        // 宣傳頁是獨立的靜態頁，不要被 App 的離線殼攔截
        navigateFallbackDenylist: [/^\/DB-radar\/about\//],
        // 新版一裝好就接手，手機重開 App 就是最新版
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
