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
 *   /             index.html          랜딩 (정적, A/B 변형은 /a /b /c)
 *   /app          app/index.html      React SPA (가입·업로드·리포트)
 *   /privacy      privacy.html        개인정보 고지
 *   /about        about.html          회사·제품 소개
 *   /methodology  methodology.html    관세·랜디드 코스트 계산 방법론
 *   /terms        terms.html          이용약관
 *   /sample-report sample-report.html 엔진이 생성한 샘플 리포트
 *   /hts          hts.html            공개 HTS 조회
 *   /section-301  section-301.html    중국 301 리스트 조회
 *
 * 루트의 HTML 파일은 input 에 명시하지 않으면 Vite가 dist에 복사하지 않는다.
 * 공개 링크가 존재하지만 실제 배포 파일이 없는 상태를 막기 위해 모든 공개 페이지를
 * 여기서 명시적으로 빌드한다.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        landing: resolve(root, 'index.html'),
        app: resolve(root, 'app/index.html'),
        privacy: resolve(root, 'privacy.html'),
        about: resolve(root, 'about.html'),
        methodology: resolve(root, 'methodology.html'),
        terms: resolve(root, 'terms.html'),
        sampleReport: resolve(root, 'sample-report.html'),
        hts: resolve(root, 'hts.html'),
        section301: resolve(root, 'section-301.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
