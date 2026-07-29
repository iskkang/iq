import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { CONFIG_ERROR } from './lib/env'

/**
 * 설정이 빠진 채로는 앱을 띄우지 않는다.
 *
 * 예전에는 env 가 없으면 인메모리 데모 저장소로 조용히 전환됐다. 사용자는 경고 없이
 * 선적을 만들고 분류를 돌린 다음 새로고침에 전부 잃는다. 저장이 안 되는 상태를
 * 정상 화면으로 보여주느니 여기서 멈추고 원인을 말하는 편이 낫다.
 */
function ConfigError({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-5">
      <div className="max-w-lg rounded-xl border border-rose-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-rose-700">서비스를 시작할 수 없습니다</h1>
        <p className="mt-2 text-sm text-slate-700">
          데이터베이스 설정이 없어 저장이 불가능한 상태입니다. 이대로 진행하면 입력한 내용이
          저장되지 않으므로 화면을 열지 않았습니다.
        </p>
        <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600">{message}</p>
        <p className="mt-3 text-sm text-slate-600">
          잠시 후 다시 시도해 주세요. 계속되면{' '}
          <a href="mailto:support@landediq.app" className="font-medium text-indigo-600 underline">
            support@landediq.app
          </a>{' '}
          으로 알려주시면 바로 확인하겠습니다.
        </p>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>{CONFIG_ERROR ? <ConfigError message={CONFIG_ERROR} /> : <App />}</StrictMode>,
)
