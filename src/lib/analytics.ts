type EventProperties = Record<string, string | number | boolean | null | undefined>

const env = import.meta.env as Record<string, string | undefined>
const url = env.VITE_SUPABASE_URL
const key = env.VITE_SUPABASE_ANON_KEY

function stableId(storage: Storage, keyName: string): string {
  let value = storage.getItem(keyName)
  if (!value) {
    value = crypto.randomUUID()
    storage.setItem(keyName, value)
  }
  return value
}

export function trackEvent(eventName: string, properties: EventProperties = {}): void {
  if (!url || !key) return
  const params = new URLSearchParams(location.search)
  const body = {
    event_name: eventName,
    page: location.pathname,
    session_id: stableId(sessionStorage, 'landediq_session_id'),
    visitor_id: stableId(localStorage, 'landediq_visitor_id'),
    properties: {
      ...properties,
      utm_source: params.get('utm_source'),
      utm_medium: params.get('utm_medium'),
      utm_campaign: params.get('utm_campaign'),
      utm_term: params.get('utm_term'),
      utm_content: params.get('utm_content'),
      device: matchMedia('(max-width: 767px)').matches ? 'mobile' : 'desktop',
    },
  }

  fetch(`${url}/rest/v1/analytics_events`, {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  }).catch(() => undefined)

  ;(window as Window & { plausible?: (name: string, options?: unknown) => void }).plausible?.(eventName, {
    props: properties,
  })
}
