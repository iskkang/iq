/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

/**
 * 멀티페이지 빌드.
 *
 *   /          index.html      랜딩 (정적, A/B 변형은 /a /b /c)
 *   /app       app/index.html  React SPA (가입·업로드·리포트)
 *   /privacy   privacy.html    개인정보 고지
 *
 * 예전에는 index.html 이 SPA 하나뿐이라 landing.html·privacy.html 이 dist 에
 * 들어가지 않았고, vercel.json 이 모든 경로를 SPA 로 rewrite 해서 / 가 곧장
 * 로그인 화면으로 갔다. 세 페이지를 전부 빌드 입력으로 잡는다.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        landing: resolve(root, 'index.html'),
        app: resolve(root, 'app/index.html'),
        privacy: resolve(root, 'privacy.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
