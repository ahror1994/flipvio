// Восстановление книг на хостинге после деплоя (free-тариф Render стирает /data).
// Использование: node tools/restore-books.mjs <базовый-URL> <логин> <пароль>
const [,, base, login, password] = process.argv
if (!base || !login || !password) { console.error('Usage: node tools/restore-books.mjs <url> <login> <password>'); process.exit(1) }

const fs = await import('node:fs')
const path = await import('node:path')

const api = (p) => base.replace(/\/$/, '') + p
const loginRes = await fetch(api('/api/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password }) })
if (!loginRes.ok) { console.error('Login failed: ' + loginRes.status); process.exit(1) }
const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0]
const auth = { cookie }

const jobs = []

// 1. PDF-книги из локальной базы
const db = JSON.parse(fs.readFileSync(new URL('../storage/db.json', import.meta.url), 'utf8'))
const pdfBooks = [
  { localSlug: 'каталог-2026-тест-d259ac', slug: 'каталог-2026-тест', toc: [
    { title: 'салаты', page: 24 },
    { title: 'салаты', page: 21 },
  ] },
  { localSlug: 'коммерческое-предложение-и-договор-на-ра-a79d9a', slug: 'коммерческое-предложение' },
]
for (const item of pdfBooks) {
  const local = db.books.find((b) => b.slug === item.localSlug)
  const pdf = local && path.resolve('storage', item.localSlug, 'source.pdf')
  if (local && fs.existsSync(pdf)) jobs.push({ title: local.title, slug: item.slug, files: [{ name: 'source.pdf', type: 'application/pdf', buf: fs.readFileSync(pdf) }], toc: item.toc })
}

// 2. Книга из фотографий (восстанавливается из бэкапа large-страниц)
const backupDir = 'C:/Users/ahror/.flipvio-backup/суши-студио'
if (fs.existsSync(backupDir + '/manifest.json')) {
  const files = fs.readdirSync(backupDir + '/large').filter((f) => f.endsWith('.jpg'))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((f) => ({ name: f, type: 'image/jpeg', buf: fs.readFileSync(backupDir + '/large/' + f) }))
  jobs.push({ title: 'суши студио', slug: 'суши-студио', files })
}

for (const job of jobs) {
  process.stdout.write('Загрузка «' + job.title + '» (' + job.files.length + ' файл.) ... ')
  const form = new FormData()
  form.append('title', job.title)
  form.append('slug', job.slug)
  for (const f of job.files) form.append('file', new Blob([f.buf], { type: f.type }), f.name)
  const up = await fetch(api('/api/books'), { method: 'POST', headers: auth, body: form })
  if (!up.ok) { console.error('ОШИБКА ' + up.status + ': ' + (await up.text()).slice(0, 200)); continue }
  const book = await up.json()
  console.log('ok, ' + book.pageCount + ' стр.')
  const patch = { published: true }
  if (job.toc) {
    // ID страниц генерируются при конвертации — берём их из свежего манифеста
    const { randomUUID } = await import('node:crypto')
    const man = await (await fetch(api('/api/books/' + encodeURIComponent(book.slug)), { headers: auth })).json()
    patch.toc = job.toc.map((t) => ({ id: randomUUID(), title: t.title, pageId: man.pages[t.page - 1]?.id })).filter((t) => t.pageId)
  }
  const pp = await fetch(api('/api/books/' + encodeURIComponent(book.slug)), { method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(patch) })
  console.log(pp.ok ? '  опубликована' + (job.toc ? ' + оглавление' : '') : '  ошибка публикации: ' + pp.status + ' ' + (await pp.text()).slice(0, 150))
}
console.log('Готово.')
