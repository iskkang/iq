/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { existsSync, readdirSync } from 'node:fs'
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
/**
 * 발행된 에디토리얼을 입력에 넣는다.
 *
 * 글이 늘 때마다 이 파일을 고치게 하면 언젠가 잊는다 — 그러면 링크는 존재하는데
 * 배포 파일이 없는 상태가 되고, 그건 이 파일 위쪽 주석이 이미 경고한 실패다.
 * blog/ 는 npm run blog:build 가 생성해 커밋한다.
 */
function blogPosts(): Record<string, string> {
  const dir = resolve(root, 'blog')
  if (!existsSync(dir)) return {}
  const out: Record<string, string> = {}
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.html')) out[`blog-${f.replace(/\.html$/, '')}`] = resolve(dir, f)
  }
  return out
}

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
        blog: resolve(root, 'blog.html'),
        ...blogPosts(),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
