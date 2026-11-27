/**
 * oEmbed resolution for page asks.
 *
 * Why the daemon and not the page: the page runs in an opaque-origin sandbox, so a
 * `fetch` to a provider's oEmbed endpoint is cross-origin from `null` and CORS refuses
 * it. Resolving server-side also leaves room for providers that need a token
 * (Instagram) without shipping the token into an agent-authored document.
 *
 * What this deliberately is NOT: a URL fetcher. The endpoint host comes from the table
 * below and is chosen by matching the *input host* against a fixed list — the input can
 * select a row, never supply an address. That is what keeps this out of SSRF territory;
 * a provider added later must be added here, by name, with its own endpoint.
 */

export const OEMBED_PROVIDERS = Object.freeze([
  { name: 'youtube', hosts: ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'], endpoint: 'https://www.youtube.com/oembed' },
  { name: 'vimeo', hosts: ['vimeo.com', 'www.vimeo.com'], endpoint: 'https://vimeo.com/api/oembed.json' },
  { name: 'twitter', hosts: ['twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'x.com', 'www.x.com'], endpoint: 'https://publish.twitter.com/oembed' },
])

const MAX_RESPONSE_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 4000

/** The provider row a URL selects, or null. Host match only — never a substring test. */
export function oembedProviderFor(rawUrl) {
  let parsed
  try {
    parsed = new URL(String(rawUrl ?? ''))
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase()
  return OEMBED_PROVIDERS.find((provider) => provider.hosts.includes(host)) ?? null
}

/** Provider HTML is embedded in a sandboxed page; scripts have no business in it. */
function stripScripts(html) {
  return String(html).replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*\/?>/gi, '')
}

/**
 * Resolve a URL to its provider's embed.
 *
 * Returns `{ ok: true, provider, html, title, providerName, type }`, or
 * `{ ok: false, reason }` where reason is 'unsupported' (no provider row: the caller
 * leaves the link alone) or 'failed' (the provider was unreachable or refused).
 */
export async function resolveOembed(rawUrl, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const provider = oembedProviderFor(rawUrl)
  if (!provider) return { ok: false, reason: 'unsupported' }

  const endpoint = new URL(provider.endpoint)
  endpoint.searchParams.set('url', String(rawUrl))
  if (provider.name !== 'twitter') endpoint.searchParams.set('format', 'json')

  let response
  try {
    response = await fetchImpl(endpoint.toString(), {
      headers: { accept: 'application/json', 'user-agent': 'unblock-oembed/1' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    })
  } catch {
    return { ok: false, reason: 'failed', provider: provider.name }
  }
  if (!response.ok) return { ok: false, reason: 'failed', provider: provider.name }

  let body
  try {
    body = await response.text()
  } catch {
    return { ok: false, reason: 'failed', provider: provider.name }
  }
  if (body.length > MAX_RESPONSE_BYTES) return { ok: false, reason: 'failed', provider: provider.name }

  let data
  try {
    data = JSON.parse(body)
  } catch {
    return { ok: false, reason: 'failed', provider: provider.name }
  }
  if (!data || typeof data.html !== 'string' || !data.html.trim()) {
    return { ok: false, reason: 'failed', provider: provider.name }
  }

  return {
    ok: true,
    provider: provider.name,
    providerName: typeof data.provider_name === 'string' ? data.provider_name : provider.name,
    html: stripScripts(data.html),
    title: typeof data.title === 'string' ? data.title : '',
    type: typeof data.type === 'string' ? data.type : 'rich',
    thumbnailUrl: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : null,
  }
}
