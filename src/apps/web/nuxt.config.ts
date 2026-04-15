import { defineNuxtConfig } from 'nuxt/config';
import type { NuxtConfig } from 'nuxt/schema';

const config: NuxtConfig & { nitro?: unknown } = {
  compatibilityDate: '2025-01-01',
  ssr: true,
  devtools: { enabled: true },
  runtimeConfig: {
    public: {
      apiBaseUrl: process.env.NUXT_PUBLIC_API_BASE_URL,
      wsUrl: process.env.NUXT_PUBLIC_WS_URL,
    },
    apiSecret: process.env.API_SECRET,
  },
  nitro: {
    // Azure App Service Linux uses Oryx and expects a Node server
    preset: 'node-server',
    devProxy: {
      '/api': {
        target: 'http://localhost:8080/api',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://localhost:8080/ws',
        changeOrigin: true,
        ws: true,
      },
    },
  },
};

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig(config) as NuxtConfig & { nitro?: unknown };
