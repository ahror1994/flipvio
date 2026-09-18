// Экспорт книг с живого сервера в статический сайт для GitHub Pages.
// Использование: node tools/export-static.mjs <базовый-URL> <логин> <пароль> [выходная-папка]
// Результат: папка dist с /b/<имя>/ (манифест, страницы, PDF) + читалка + ассеты.
const [,, base, login, password, outDir = 'dist'] = process.argv
if (!base || !login || !password) { console.error('Usage: node tools/export-static.mjs <url> <login> <password> [out]'); process.exit(1) }

const fs = await import('node:fs')
const path = await import('node:path')

// постоянные короткие адреса на Pages: префикс слага -> имя
const NAMES = [['суши', 'sushi'], ['каталог', 'catalog-2026'], ['коммерческое', 'kp'], ['01', '01']]

const api = (p) => base.replace(/\/$/, '') + p
const loginRes = await fetch(api('/api/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password }) })
if (!loginRes.ok) { console.error('Login failed: ' + loginRes.status); process.exit(1) }
const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0]

const list = (await (await fetch(api('/api/books'), { headers: { cookie } })).json()).books
// дубликаты по названию: берём самую свежую версию
const fresh = new Map()
for (const b of list) {
  const prev = fresh.get(b.title)
  if (!prev || b.createdAt > prev.createdAt) fresh.set(b.title, b)
}

const ROOT = path.resolve(outDir)
fs.mkdirSync(ROOT, { recursive: true })
for (const dir of ['assets/sfx', 'b']) fs.mkdirSync(path.join(ROOT, dir), { recursive: true })
for (const f of ['viewer.css', 'viewer.js']) fs.copyFileSync(path.resolve('public/assets', f), path.join(ROOT, 'assets', f))
for (const f of fs.readdirSync(path.resolve('public/assets/sfx'))) fs.copyFileSync(path.resolve('public/assets/sfx', f), path.join(ROOT, 'assets/sfx', f))
fs.copyFileSync(path.resolve('public/viewer.html'), path.join(ROOT, 'viewer.html'))

const viewerHtml = fs.readFileSync(path.resolve('public/viewer.html'), 'utf8')
const staticPage = viewerHtml
  .replace('<body>', '<body data-static data-root="../.." data-manifest="./manifest.json">')
  .replace(/(href|src)="\/assets\//g, '$1="../../assets/')

const exported = []
for (const b of fresh.values()) {
  const name = (NAMES.find(([prefix]) => b.slug.startsWith(prefix)) || [])[1]
  if (!name) { console.log('пропуск (нет короткого имени):', b.slug); continue }
  const m = await (await fetch(api('/api/books/' + encodeURIComponent(b.slug)), { headers: { cookie } })).json()
  const dir = path.join(ROOT, 'b', name)
  fs.mkdirSync(dir, { recursive: true })

  // манифест: пути из /storage/... -> локальные относительные
  const rewrite = (u) => typeof u === 'string' ? u.replace(/^\/storage\/[^/]+\/pages\/[^/]+\//, './pages/') : u
  const out = { ...m, url: './', pdfUrl: m.pdfUrl ? './source.pdf' : null }
  for (const key of ['logoUrl', 'logoLink']) if (out.settings) out.settings[key] = null
  out.pages = m.pages.map((p) => ({ ...p, thumb: rewrite(p.thumb), normal: rewrite(p.normal), large: rewrite(p.large) }))
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(out, null, 2))
  fs.writeFileSync(path.join(dir, 'index.html'), staticPage)

  // страницы трёх качеств + исходный PDF
  let count = 0
  for (const p of m.pages) {
    for (const tier of ['thumb', 'normal', 'large']) {
      const r = await fetch(api(p[tier]), { headers: { cookie } })
      if (!r.ok) { console.error('  нет файла:', p[tier], r.status); continue }
      const f = path.join(dir, 'pages', tier, 'page-' + p.index + '.jpg')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()))
      count++
    }
  }
  if (m.pdfUrl) {
    const r = await fetch(api(m.pdfUrl), { headers: { cookie } })
    if (r.ok) fs.writeFileSync(path.join(dir, 'source.pdf'), Buffer.from(await r.arrayBuffer()))
  }
  exported.push({ name, title: m.title, pages: m.pageCount })
  console.log('экспорт:', name, '«' + m.title + '»', m.pageCount + ' стр,', count + ' файлов')
}

const cards = exported.map((e) => `<a class="card" href="./b/${e.name}/"><b>${e.title}</b><span>${e.pages} стр.</span></a>`).join('\n')
fs.writeFileSync(path.join(ROOT, 'index.html'), `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Публикации</title><link rel="stylesheet" href="./assets/viewer.css">
<style>
body { display: flex; min-height: 100vh; align-items: center; justify-content: center; background: radial-gradient(120% 120% at 50% 10%, #2b2b2b, #161616); user-select: none; }
main { width: min(560px, 92vw); }
h1 { color: #eee; font-weight: 600; letter-spacing: .02em; }
.card { display: flex; justify-content: space-between; gap: 12px; padding: 16px 18px; margin: 10px 0; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); border-radius: 12px; color: #eee; text-decoration: none; transition: background .15s, transform .15s; }
.card:hover { background: #1e40af; transform: translateY(-1px); }
.card span { color: #9a9a9a; }
.card:hover span { color: #dde6ff; }
</style></head><body><main>
<h1>Публикации</h1>
${cards}
</main></body></html>
`)
console.log('Готово:', ROOT)
