import { routes, type Route } from './routes'

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** `code` spans in descriptions → <code>, everything else escaped. */
const inline = (value: string) => escapeHtml(value).replace(/`([^`]+)`/g, '<code>$1</code>')

function curlExample(route: Route, baseUrl: string): string {
  const path = route.path.replace(/\{(\w+)\}/g, (_m, name: string) => `<${name}>`)
  const parts = ['curl']
  if (route.method !== 'GET') parts.push(`-X ${route.method}`)
  if (!route.doc.public) parts.push('-H "Authorization: Bearer $TOKEN"')
  if (route.doc.requestBody?.example !== undefined) {
    parts.push('-H "Content-Type: application/json"')
    parts.push(`-d '${JSON.stringify(route.doc.requestBody.example)}'`)
  }
  if (route.path.endsWith('/events')) parts.push('-N')
  parts.push(`"${baseUrl}${path}"`)
  return parts.join(' ')
}

function renderRoute(route: Route, baseUrl: string): string {
  const { doc } = route
  const params = [
    ...(doc.pathParams ?? []).map((p) => ({ ...p, where: 'Pfad' })),
    ...(doc.queryParams ?? []).map((p) => ({ ...p, where: 'Query' })),
  ]
  const id = `${route.method}-${route.path}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  return `
    <article class="route" id="${id}">
      <header>
        <span class="method ${route.method.toLowerCase()}">${route.method}</span>
        <code class="path">${escapeHtml(route.path)}</code>
        ${doc.public ? '<span class="badge">ohne Token</span>' : ''}
      </header>
      <h3>${escapeHtml(doc.summary)}</h3>
      ${doc.description ? `<p>${inline(doc.description)}</p>` : ''}
      ${
        params.length
          ? `<table><thead><tr><th>Parameter</th><th>Ort</th><th>Beschreibung</th></tr></thead><tbody>${params
              .map(
                (p) =>
                  `<tr><td><code>${escapeHtml(p.name)}</code></td><td>${p.where}</td><td>${inline(p.description)}</td></tr>`,
              )
              .join('')}</tbody></table>`
          : ''
      }
      ${
        doc.requestBody?.example !== undefined
          ? `<p class="label">Body</p><pre>${escapeHtml(JSON.stringify(doc.requestBody.example, null, 2))}</pre>`
          : ''
      }
      <p class="label">Antwort</p>
      <p>${doc.response ? inline(doc.response.description) : '204 No Content'}</p>
      <p class="label">Beispiel</p>
      <pre>${escapeHtml(curlExample(route, baseUrl))}</pre>
    </article>`
}

/** Self-contained documentation page (no external resources). */
export function renderDocsPage(baseUrl: string, version: string): string {
  const tags = [...new Set(routes.map((r) => r.doc.tag))]
  const nav = tags
    .map(
      (tag) =>
        `<li><a href="#tag-${tag.toLowerCase()}">${escapeHtml(tag)}</a></li>`,
    )
    .join('')
  const sections = tags
    .map(
      (tag) => `
      <section id="tag-${tag.toLowerCase()}">
        <h2>${escapeHtml(tag)}</h2>
        ${routes
          .filter((r) => r.doc.tag === tag)
          .map((r) => renderRoute(r, baseUrl))
          .join('')}
      </section>`,
    )
    .join('')

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Manager API</title>
<style>
  :root { --bg:#faf9f7; --fg:#1f1d1b; --muted:#6b6560; --card:#ffffff; --border:#e7e2dc; --code:#f3efea; --accent:#c4613f; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#1c1917; --fg:#ece6e1; --muted:#a8a19b; --card:#24201d; --border:#36302b; --code:#2c2723; --accent:#d97757; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif; }
  .layout { display:grid; grid-template-columns: 220px minmax(0,1fr); gap:40px; max-width:1100px; margin:0 auto; padding:40px 24px; }
  nav { position:sticky; top:40px; align-self:start; }
  nav ul { list-style:none; padding:0; margin:12px 0 0; }
  nav a { color:var(--muted); text-decoration:none; display:block; padding:4px 0; }
  nav a:hover { color:var(--fg); }
  h1 { font-size:28px; margin:0 0 8px; }
  h2 { font-size:20px; margin:48px 0 16px; padding-bottom:8px; border-bottom:1px solid var(--border); }
  h3 { font-size:16px; margin:12px 0 4px; }
  p { margin:6px 0; }
  code, pre { font-family:"Cascadia Mono",Consolas,monospace; font-size:13px; }
  code { background:var(--code); padding:1px 5px; border-radius:5px; }
  pre { background:var(--code); padding:12px 14px; border-radius:10px; overflow-x:auto; margin:6px 0; }
  .route { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:18px 20px; margin:14px 0; }
  .route header { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .path { background:none; padding:0; font-size:14px; }
  .method { font:600 12px/1 "Cascadia Mono",Consolas,monospace; padding:5px 8px; border-radius:6px; color:#fff; }
  .get { background:#2f855a; } .post { background:#2b6cb0; } .patch { background:#b7791f; } .delete { background:#c53030; }
  .badge { font-size:12px; color:var(--muted); border:1px solid var(--border); border-radius:999px; padding:1px 8px; }
  .label { font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin-top:14px; }
  table { border-collapse:collapse; width:100%; margin:8px 0; font-size:14px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--border); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  .intro { color:var(--muted); }
  a { color:var(--accent); }
  @media (max-width: 800px) { .layout { grid-template-columns:1fr; } nav { position:static; } }
</style>
</head>
<body>
<div class="layout">
  <nav>
    <strong>Claude Manager API</strong>
    <div class="intro">v${escapeHtml(version)}</div>
    <ul>
      <li><a href="#auth">Authentifizierung</a></li>
      ${nav}
      <li><a href="${escapeHtml(baseUrl)}/openapi.json">openapi.json</a></li>
    </ul>
  </nav>
  <main>
    <h1>Lokale API</h1>
    <p class="intro">Steuert Claude Manager von anderen Programmen aus: Accounts und Usage lesen, Sessions durchsuchen, Terminals öffnen und bedienen.</p>
    <section id="auth">
      <h2>Authentifizierung</h2>
      <p>Der Server lauscht ausschließlich auf <code>${escapeHtml(baseUrl)}</code>. Jede Anfrage (außer <code>/api/v1/health</code> und dieser Seite) braucht den Token aus <em>Einstellungen → API</em>:</p>
      <pre>Authorization: Bearer &lt;token&gt;</pre>
      <p>Fehler kommen einheitlich als <code>{"error": {"status": 404, "message": "…"}}</code>. Bodies sind JSON (<code>Content-Type: application/json</code>, max. 1 MB). Die maschinenlesbare Beschreibung liegt unter <a href="${escapeHtml(baseUrl)}/openapi.json">/openapi.json</a> (OpenAPI 3.1) und lässt sich z. B. in Postman, Insomnia oder einen Client-Generator importieren.</p>
      <p>Browser-Seiten anderer Herkunft (CORS) werden nicht unterstützt – die API ist für lokale Programme und Skripte gedacht.</p>
    </section>
    ${sections}
  </main>
</div>
</body>
</html>`
}
