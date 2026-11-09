/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Трекер съёмок',
        short_name: 'Трекер',
        lang: 'ru',
        start_url: './',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#2e7d32',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
    }),
  ],
  test: {
    environment: 'node',
    // Фиксированный пояс, чтобы тесты календаря не зависели от машины (в ноябре UTC+2).
    env: { TZ: 'Europe/Athens' },
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
