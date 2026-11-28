// The whole pixel app: one full-size WebView on one page ask's own URL.
//
// This is the spike's app (spike/tui-render/app.mjs) with the install-locating
// problem solved and the report kept: what it receives is evidence, and a page
// that renders nothing should say so rather than leave a blank pane.
//
//   pixel <this file> -- <page-url>
//   node <pixel-bin> <this file> -- <page-url>
//
// pixel is NOT a dependency of this plugin (see docs/tui-open-page.md). The
// bare import below resolves when pixel is installed in this plugin's own
// node_modules; UNBLOCK_PIXEL_MODULE is the absolute entry plugin/open-page.js
// derives from where the pixel binary it found actually lives, for an install
// somewhere else on PATH.
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const url = process.argv[2] || process.env.UNBLOCK_PAGE_URL
if (!url) {
  console.error('usage: pixel <this-file> -- <page-url>')
  process.exit(2)
}

const report = (line) => {
  if (process.env.UNBLOCK_PIXEL_REPORT) appendFileSync(process.env.UNBLOCK_PIXEL_REPORT, line + '\n')
  console.error('[unblock] ' + line)
}

async function loadPixel() {
  try {
    return await import('@zenbu-labs/pixel')
  } catch (bare) {
    const entry = process.env.UNBLOCK_PIXEL_MODULE
    if (!entry) throw bare
    return import(pathToFileURL(entry).href)
  }
}

let createRoot
try {
  ({ createRoot } = await loadPixel())
} catch (error) {
  // The one failure a person can act on: the module is missing even though a
  // pixel binary was found. Say which install is broken, not just "failed".
  console.error(
    `[unblock] pixel is installed but @zenbu-labs/pixel cannot be imported (${error.message}).\n` +
      'Install it inside the plugin root: npm i --no-save @zenbu-labs/pixel react',
  )
  process.exit(2)
}

const root = createRoot({
  onKey(event) {
    report('key ' + JSON.stringify(event))
    if (event.kind === 'press' && event.mods?.ctrl && event.key === 'c') {
      root.stop()
      return true
    }
  },
})

const info = root.info
report('info ' + JSON.stringify({
  width: info?.width, height: info?.height,
  cellWidth: info?.cellWidth, cellHeight: info?.cellHeight,
  basePx: info?.basePx, renderer: info?.renderer,
  device: info?.device, hosted: info?.hosted, kittyKeyboard: info?.kittyKeyboard,
}))

// A terminal that cannot do kitty graphics silently renders cells, so the
// renderer it picked is the honest answer to "did the page actually draw".
// Printed, not enforced: the gate that refuses that case lives in
// plugin/open-page.js, before a pane is ever split.
if (info?.renderer && !/kitty/i.test(String(info.renderer))) {
  report('degraded renderer ' + JSON.stringify(info.renderer) + ' — this terminal cannot show a page')
}

const page = root.loadURL(url)
page.onChange((state) => {
  report('page ' + JSON.stringify({ url: state.url, title: state.title, loading: state.loading }))
  root.setTitle?.(state.title || 'page ask')
})
