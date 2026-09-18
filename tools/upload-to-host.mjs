// Разовая загрузка локальных книг на хостинг Flipvio.
// Использование: node tools/upload-to-host.mjs <базовый-URL> <логин> <пароль>
const [,, base, login, password] = process.argv
if (!base || !login || !password) { console.error('Usage: node tools/upload-to-host.mjs <url> <login> <password>'); process.exit(1) }

const fs = await import('node:fs')
const path = await import('node:path')
const db = JSON.parse(fs.readFileSync(new URL('../storage/db.json', import.meta.url), 'utf8'))

// какие книги и с какими короткими адресами публикуем на хостинге
const PLAN = [
  { localSlug: 'каталог-2026-тест-d259ac', slug: 'каталог-2026-тест', toc: [
    { title: 'салаты', pageId: 'page-24' },
    { title: 'салаты', pageId: 'page-21' },
  ] },
  { localSlug: 'коммерческое-предложение-и-договор-на-ра-a79d9a', slug: 'коммерческое-предложение' },
]

const api = (p) => base.replace(/\/$/, '') + p
const loginRes = await fetch(api('/api/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password }) })
if (!loginRes.ok) { console.error('Login failed: ' + loginRes.status); process.exit(1) }
const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0]
const authHeaders = { cookie }

for (const item of PLAN) {
  const local = db.books.find((b) => b.slug === item.localSlug)
  if (!local) { console.error('Не найдена локальная книга: ' + item.localSlug); continue }
  const pdfPath = path.resolve('storage', item.localSlug, 'source.pdf')
  if (!fs.existsSync(pdfPath)) { console.error('Нет source.pdf: ' + pdfPath); continue }

  const form = new FormData()
  form.append('title', local.title)
  form.append('slug', item.slug)
  form.append('file', new Blob([fs.readFileSync(pdfPath)], { type: 'application/pdf' }), 'source.pdf')

  process.stdout.write('Загрузка «' + local.title + '» ... ')
  const up = await fetch(api('/api/books'), { method: 'POST', headers: authHeaders, body: form })
  if (!up.ok) { console.error('ОШИБКА ' + up.status + ': ' + (await up.text()).slice(0, 200)); continue }
  const book = await up.json()
  console.log('ok, ' + book.pageCount + ' стр., slug: ' + book.slug)

  const patch = { published: true }
  if (item.toc) patch.toc = item.toc
  const pp = await fetch(api('/api/books/' + encodeURIComponent(book.slug)), { method: 'PATCH', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify(patch) })
  console.log(pp.ok ? '  опубликована' + (item.toc ? ', оглавление восстановлено' : '') : '  ошибка публикации: ' + pp.status + ' ' + (await pp.text()).slice(0, 200))
}
