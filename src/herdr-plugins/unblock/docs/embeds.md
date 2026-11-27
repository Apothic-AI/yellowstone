# Embeds inside a page ask

A page ask can show a video or a post without the agent writing embed code: a bare URL in
the page is resolved to the provider's oEmbed HTML by the **daemon** (`GET
/api/oembed?url=…`, and `<ticket>/oembed` for the page's own relative call) and injected by
the starter page's client. Resolution is server-side because a sandboxed document's own
fetch to a provider is cross-origin from an opaque origin and CORS refuses it.

## What was measured, and how

A real Chrome (156), driven over CDP, against a real daemon and the real scoped-link page:

| check | result |
|---|---|
| daemon resolves a YouTube watch URL | `200`, `access-control-allow-origin: *`, `provider: youtube` |
| the page's own fetch from its opaque origin | succeeded; the client injected the result |
| page document origin | opaque — `localStorage` throws `SecurityError` |
| provider frame navigated | `https://www.youtube.com/embed/aqz-KE-bpKQ?feature=oembed`, `200` |
| **player usable** | **no** — `video: false`, no `.ytp-error`, two `error_204?t=jserror` beacons |
| control: the SAME embed with no sandbox | `storage: readable`, `video: true` |

Same machine, same Chrome, same URL, same 12 s wait. The only difference was the sandbox,
so the sandbox is the cause: **every nested document inherits the sandbox**, so the
provider's frame also runs on an opaque origin, cannot open its own storage, and YouTube's
player aborts before it creates a `<video>` element — leaving a black rectangle.

## Which allowances would fix it

None that stay safe. A nested frame cannot be granted more than its parent has, so no
`sandbox` attribute on the embed can restore the provider's origin; and the only flag that
would (`allow-same-origin`) puts agent-authored script back on the daemon's origin — the
exact thing the sandbox exists to prevent. That is why the page ships a **poster card** for
video providers (thumbnail, title, "Watch on …", target `_blank`) and keeps inline HTML for
providers whose embed is just markup (a quote, a photo).

If real playback is ever wanted, the architecture that allows it is **an origin boundary
rather than sandbox flags**: serve agent pages from their own loopback origin (a second
port), with no cookies for it. The daemon would then treat that origin as foreign — which
its origin guard already refuses — while frames the page creates keep that origin and behave
normally. That is a design change, not an allowance.

## Reproducing

The harness lives outside the repo (it needs a local Chrome): it files a page ask, inserts a
provider URL into the template's `data-embed-container`, marks the ask ready, opens the
scoped link in headless Chrome over CDP, and reads the sandboxed frame and the provider
frame directly. The control is the same URL opened with no sandbox.
