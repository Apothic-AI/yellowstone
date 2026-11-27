/**
 * The starter page for a directory-authored page ask.
 *
 * The page is a FILE the agent edits, not a string it passes in a tool call, so this
 * template is only the starting point: it carries the form contract already wired, a
 * self-contained theme (no CDN — the brief requires the page to render when the network
 * is not the page's business), and a small oEmbed client so a bare link to a provider
 * becomes its rich embed without the agent writing embed code.
 *
 * Everything here is served from the per-ticket directory, so relative URLs are the rule:
 * `src="chart.png"` is the asset next to this file, and `action="submit"` is this ticket's
 * submit endpoint.
 */

const escapeText = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const PAGE_FILE = 'index.html'

export function renderPageTemplate({ title = 'A question from your agent', why = '', ticket = '' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(title)}</title>
<!--
  PAGE ASK CONTRACT — this file is yours to edit.

  * Edit this file in place, iterate as many times as you need, and add any assets you
    want (images, CSS, JS) to this same directory. Reference them RELATIVELY:
    src="chart.png", href="style.css" — they are served from this ticket's directory.
  * The form already posts to the right place. Keep action="submit" and
    method="post" enctype="multipart/form-data" or the answer will not arrive.
  * Field names are yours: whatever the human types is recorded by name and returned to
    you, including file attachments.
  * This page is SANDBOXED: it cannot read the daemon, the queue, or your session. It
    cannot navigate the top window. Scripts and forms are allowed.
  * Paste any URL from an oEmbed provider (YouTube, Vimeo, Twitter/X) into a container
    marked data-embed, and it becomes the provider's embed. If the provider is
    unsupported or the fetch fails, the link stays a plain link.
  * When the page is ready for a human, call unblock_update with ready: true. Until
    then the ask stays in draft: not in the operator's queue and not answerable.

  Ticket: ${escapeText(ticket)}
-->
<style>
  :root {
    color-scheme: dark;
    --bg: #0d1117; --panel: #111823; --line: #263041; --text: #e6edf3;
    --muted: #8b949e; --accent: #2f81f7; --radius: 10px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px; background: var(--bg); color: var(--text);
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size: 1.4rem; line-height: 1.3; margin: 0 0 .5rem; }
  .why { color: var(--muted); margin: 0 0 1.5rem; }
  form { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 1.25rem; }
  label { display: block; margin: 0 0 .4rem; color: #c9d5e1; font-size: .95rem; }
  textarea, input[type=text], input[type=file] {
    width: 100%; padding: .8rem .9rem; margin: 0 0 1rem; font: inherit; color: var(--text);
    background: #0b0f14; border: 1px solid var(--line); border-radius: 8px;
  }
  textarea { min-height: 7rem; resize: vertical; }
  textarea:focus, input:focus { outline: none; border-color: var(--accent); }
  button {
    padding: .85rem 1.4rem; font: inherit; font-weight: 600; color: #fff; background: var(--accent);
    border: 0; border-radius: 8px; cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  .embed { margin: 0 0 1.25rem; }
  .embed iframe { width: 100%; aspect-ratio: 16 / 9; border: 0; border-radius: var(--radius); background: #000; }
  .embed blockquote { margin: 0; padding: 1rem; border: 1px solid var(--line); border-radius: var(--radius); }
  .embed a.card { display: block; position: relative; border: 1px solid var(--line); border-radius: var(--radius);
    overflow: hidden; color: inherit; text-decoration: none; background: #000; }
  .embed a.card img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; opacity: .9; }
  .embed a.card .meta { position: absolute; inset: auto 0 0 0; padding: .75rem 1rem;
    background: linear-gradient(transparent, rgba(0, 0, 0, .85)); }
  .embed a.card strong { display: block; font-size: .95rem; }
  .embed a.card span { color: #b9c4d0; font-size: .8rem; }
  .ticket { color: var(--muted); font-size: .8rem; margin-top: 1.5rem; }
</style>
</head>
<body>
<main>
  <h1>${escapeText(title)}</h1>
  ${why ? `<p class="why">${escapeText(why)}</p>` : ''}

  <div id="embeds" data-embed-container></div>

  <form method="post" action="submit" enctype="multipart/form-data">
    <label for="answer">Your answer</label>
    <textarea id="answer" name="answer" placeholder="Type your answer here"></textarea>

    <label for="attachment">Attach a file (optional)</label>
    <input id="attachment" type="file" name="attachment">

    <button type="submit">Send answer</button>
  </form>

  <p class="ticket">${escapeText(ticket)}</p>
</main>
<script>
  // oEmbed: a bare provider link becomes its embed. The fetch goes through the daemon,
  // because a sandboxed page cannot call provider endpoints (CORS, and tokens later).
  (() => {
    const container = document.querySelector('[data-embed-container]') || document.body;
    const links = [...container.querySelectorAll('a[data-embed], a[href^="http"]')];
    for (const link of links) {
      const url = link.dataset.embed || link.href;
      fetch('oembed?url=' + encodeURIComponent(url), { headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data || !data.html) return;
          const holder = document.createElement('div');
          holder.className = 'embed';
          // MEASURED: a live video player cannot start inside this page. The sandbox is
          // inherited by every nested document, so the provider's own frame runs on an
          // opaque origin too and cannot open its storage — YouTube's player then aborts
          // before it creates a <video> element and paints a black rectangle. It is not
          // something a different allowance fixes: a nested frame cannot be granted more
          // than its parent has, and the one flag that would help (allow-same-origin)
          // would put agent-authored script back on the daemon's origin. So a video gets a
          // poster card that opens the provider in a new tab; providers whose embed is
          // just markup (a quote, a photo) still render inline.
          if (data.type === 'video' || /<iframe/i.test(data.html)) {
            const card = document.createElement('a');
            card.className = 'card';
            card.href = url;
            card.target = '_blank';
            card.rel = 'noopener noreferrer';
            if (data.thumbnailUrl) {
              const img = document.createElement('img');
              img.src = data.thumbnailUrl;
              img.alt = '';
              card.appendChild(img);
            }
            const meta = document.createElement('div');
            meta.className = 'meta';
            const title = document.createElement('strong');
            title.textContent = data.title || url;
            const watch = document.createElement('span');
            watch.textContent = 'Watch on ' + (data.providerName || 'the provider');
            meta.append(title, watch);
            card.appendChild(meta);
            holder.appendChild(card);
          } else {
            holder.innerHTML = data.html;
          }
          link.replaceWith(holder);
        })
        .catch(() => { /* the link stays a plain link */ });
    }
  })();
</script>
</body>
</html>
`
}
