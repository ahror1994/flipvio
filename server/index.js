const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { JsonDb } = require('./lib/db')
const { readBody } = require('./lib/multipart')
const auth = require('./lib/auth')
const { fail, safeJoin, assetPath, originAllowed } = require('./lib/validation')
const { DEFAULT_SETTINGS, pagesOf, bookManifest, validatePatch } = require('./lib/manifest')
const { multipart, validateImports, saveAsset, convert } = require('./lib/uploads')
const { createQrHandler } = require('./lib/qr')
const serveQr = createQrHandler()

const ROOT = path.join(__dirname, '..')
const PUBLIC = path.join(ROOT, 'public')
const STORAGE = path.resolve(process.env.FLIPVIO_STORAGE || path.join(ROOT, 'storage'))
const PORT = Number(process.env.PORT || 8080)
const MAX_UPLOAD_MB = Math.min(300, Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 300))
fs.mkdirSync(STORAGE, { recursive: true })
const db = new JsonDb(path.join(STORAGE, 'db.json'))
const ownerUser = auth.initialize(STORAGE)
const busy = new Set()
let conversions = 0

const MIME = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
	'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
	'.gif': 'image/gif', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
	'.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf', '.ico': 'image/x-icon',
}

function json(res, code, data) {
	const body = JSON.stringify(data)
	res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
	res.end(body)
}

function redirect(res, to) {
	res.writeHead(302, { location: to, 'cache-control': 'no-store' })
	res.end()
}

function sessionOf(req) {
	return auth.sessionFromCookie(req.headers.cookie)
}

function requireAuth(req) {
	if (!sessionOf(req)) fail('Authentication required', 401)
}

function visible(book, req) {
	return book && (book.published !== false || sessionOf(req))
}

async function readJson(req) {
	if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail('Expected application/json', 415)
	try { return JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString('utf8')) } catch (error) {
		if (error.status) throw error
		fail('Invalid JSON')
	}
}

function serveFile(req, res, filePath, cache = 'no-store') {
	let stat
	try { stat = fs.statSync(filePath) } catch { fail('Not found', 404) }
	if (!stat.isFile()) fail('Not found', 404)
	const headers = { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': cache }
	let start = 0
	let end = stat.size - 1
	let code = 200
	if (req.headers.range) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
		if (!match || (!match[1] && !match[2])) fail('Invalid range', 416)
		if (!match[1]) start = Math.max(0, stat.size - Number(match[2]))
		else {
			start = Number(match[1])
			if (match[2]) end = Math.min(Number(match[2]), end)
		}
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stat.size) {
			res.setHeader('content-range', 'bytes */' + stat.size)
			fail('Range not satisfiable', 416)
		}
		headers['content-range'] = `bytes ${start}-${end}/${stat.size}`
		code = 206
	}
	headers['content-length'] = Math.max(0, end - start + 1)
	res.writeHead(code, headers)
	if (req.method === 'HEAD' || !stat.size) return res.end()
	const stream = fs.createReadStream(filePath, { start, end })
	stream.on('error', () => res.destroy())
	res.on('close', () => stream.destroy())
	stream.pipe(res)
}

function slugify(name) {
	return (String(name || 'book').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9\u0430-\u044f\u0451]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'book') + '-' + crypto.randomBytes(6).toString('hex')
}

async function withConversion(operation) {
	if (conversions >= 2) fail('Conversion capacity reached; retry later', 429)
	conversions++
	try { return await operation() } finally { conversions-- }
}

async function handleUpload(req, res) {
	return withConversion(async () => {
		const { fields, files } = await multipart(req, MAX_UPLOAD_MB * 1024 * 1024)
		const entries = validateImports(files)
		const title = (fields.title || files[0].filename || 'Publication').replace(/\.[^.]+$/, '').trim().slice(0, 300)
		if (!title) fail('Title is required')
		const slug = slugify(fields.slug || title)
		const dir = safeJoin(STORAGE, slug)
		if (!dir || fs.existsSync(dir)) fail('Storage conflict', 409)
		db.assertAvailable(slug)
		fs.mkdirSync(dir)
		try {
			const { result } = await convert(entries, STORAGE, slug)
			let pdfUrl = null
			if (entries[0].type === 'pdf') {
				fs.writeFileSync(path.join(dir, 'source.pdf'), entries[0].data, { flag: 'wx', mode: 0o600 })
				pdfUrl = '/storage/' + slug + '/source.pdf'
			}
			const book = db.insert({ slug, title, createdAt: Date.now(), updatedAt: Date.now(), views: 0, pdfUrl, settings: { ...DEFAULT_SETTINGS }, toc: [], published: false, ...result })
			return json(res, 201, bookManifest(book))
		} catch (error) {
			if (!db.get(slug)) fs.rmSync(dir, { recursive: true, force: true })
			throw error
		}
	})
}

const server = http.createServer(async (req, res) => {
	res.setHeader('x-content-type-options', 'nosniff')
	res.setHeader('referrer-policy', 'same-origin')
	try {
		let p
		try { p = decodeURIComponent(req.url.split('?')[0]) } catch { fail('Invalid URL') }
		if (!p.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(p) || p.split('/').some((segment) => segment === '.' || segment === '..' || /[. ]$/.test(segment))) fail('Invalid path')
		if (!originAllowed(req)) fail('Origin not allowed', 403)
		const reading = req.method === 'GET' || req.method === 'HEAD'
		if (p === '/healthz' && reading) return json(res, 200, { ok: true })
		if (p === '/api/qr') return await serveQr(req, res)
		if (p === '/api/login' && req.method === 'POST') {
			const ip = req.socket.remoteAddress || '?'
			if (auth.isLocked(ip)) fail('Too many attempts; retry in one minute', 429)
			const raw = await readBody(req, 16384)
			let creds
			try { creds = JSON.parse(raw.toString('utf8')) } catch { fail('Invalid JSON') }
			const ok = auth.checkCredentials(creds?.login, creds?.password)
			if (auth.loginAttempt(ip, ok).locked) fail('Too many attempts; retry in one minute', 429)
			if (!ok) fail('Invalid credentials', 401)
			auth.dropSession(sessionOf(req))
			res.setHeader('set-cookie', auth.sessionCookie(auth.createSession(), req))
			return json(res, 200, { ok: true })
		}
		if (p === '/api/logout' && req.method === 'POST') {
			auth.dropSession(sessionOf(req))
			res.setHeader('set-cookie', auth.clearCookie(req))
			return json(res, 200, { ok: true })
		}
		if (p === '/api/me' && req.method === 'GET') {
			requireAuth(req)
			return json(res, 200, { ok: true, user: ownerUser })
		}
		if (p === '/api/books') {
			requireAuth(req)
			if (req.method === 'POST') return await handleUpload(req, res)
			if (req.method === 'GET') return json(res, 200, { books: db.list().map((book) => ({ slug: book.slug, title: book.title, pageCount: book.pages?.length || 0, cover: book.pages?.[0]?.thumb || null, createdAt: book.createdAt, views: book.views || 0, publicSlug: book.publicSlug || book.slug, url: '/b/' + encodeURIComponent(book.publicSlug || book.slug), published: book.published !== false })) })
			fail('Method not allowed', 405)
		}
		const api = /^\/api\/books\/([^/]+)(?:\/(manifest|editor|assets|pages))?$/.exec(p)
		if (api) {
			const [, name, action] = api
			if (!reading || ['editor', 'assets', 'pages'].includes(action)) requireAuth(req)
			const book = db.resolve(name)
			if (!visible(book, req) || !safeJoin(STORAGE, book.slug)) fail('Not found', 404)
			const slug = book.slug
			if (reading && (!action || ['manifest', 'editor'].includes(action))) return json(res, 200, bookManifest(book))
			if (busy.has(slug)) fail('Book is being updated; retry later', 409)
			busy.add(slug)
			try {
				if (req.method === 'POST' && action === 'assets') return json(res, 201, await saveAsset(req, STORAGE, slug))
				if (req.method === 'POST' && action === 'pages') return await withConversion(async () => {
					const { files } = await multipart(req, MAX_UPLOAD_MB * 1024 * 1024)
					const { result, dir } = await convert(validateImports(files), STORAGE, slug)
					try {
						const pages = [...pagesOf(book), ...result.pages].map((page, i) => ({ ...page, index: i + 1 }))
						if (pages.length > 1000) fail('Book exceeds 1000 pages')
						return json(res, 200, bookManifest(db.update(slug, { pages, pageCount: pages.length, page: book.page || result.page })))
					} catch (error) {
						fs.rmSync(dir, { recursive: true, force: true })
						throw error
					}
				})
				if (req.method === 'PATCH' && !action) return json(res, 200, bookManifest(db.update(slug, validatePatch(book, await readJson(req), STORAGE))))
				if (req.method === 'DELETE' && !action) {
					db.remove(slug)
					fs.rmSync(safeJoin(STORAGE, slug), { recursive: true, force: true })
					return json(res, 200, { ok: true })
				}
				fail('Method not allowed', 405)
			} finally { busy.delete(slug) }
		}
		if (p.startsWith('/api/')) fail('Not found', 404)
		if (!reading) fail('Method not allowed', 405)
		if (p.startsWith('/storage/')) {
			const match = /^\/storage\/([^/]+)\/(.+)$/.exec(p)
			const book = match && db.get(match[1])
			if (!visible(book, req)) fail('Not found', 404)
			let full = assetPath(STORAGE, book.slug, p)
			if (full) {
				const rel = match[2]
				if (!/^assets\/[a-f0-9-]+\.(?:jpg|png|webp|gif|mp4|webm|mp3|wav|ogg)$/.test(rel) && !/^pages\/(?:v-[a-f0-9-]+\/)?(?:normal|thumb|large)\/page-\d+\.jpg$/.test(rel)) full = null
			}
			if (match[2] === 'source.pdf' && book.pdfUrl && (sessionOf(req) || book.settings?.allowDownload !== false)) full = safeJoin(STORAGE, book.slug + '/source.pdf')
			if (!full) fail('Not found', 404)
			return serveFile(req, res, full, 'private, no-store')
		}
		if (p === '/login' || p === '/login.html') {
			if (sessionOf(req)) return redirect(res, '/')
			return serveFile(req, res, path.join(PUBLIC, 'login.html'))
		}
		const viewer = /^\/(b|embed)\/([^/]+)\/?$/.exec(p)
		if (viewer) {
			const book = db.resolve(viewer[2])
			if (!visible(book, req)) fail('Not found', 404)
			const canonical = '/' + viewer[1] + '/' + encodeURIComponent(book.publicSlug || book.slug)
			const queryAt = req.url.indexOf('?')
			if (req.url.split('?')[0] !== canonical) return redirect(res, canonical + (queryAt < 0 ? '' : req.url.slice(queryAt)))
			return serveFile(req, res, path.join(PUBLIC, 'viewer.html'))
		}
		if (['/', '/index.html', '/admin', '/admin/'].includes(p)) {
			if (!sessionOf(req)) return redirect(res, '/login')
			return serveFile(req, res, path.join(PUBLIC, 'index.html'))
		}
		if (p === '/editor' || p.startsWith('/editor/') || p === '/editor.html') {
			if (!sessionOf(req)) return redirect(res, '/login')
			return serveFile(req, res, path.join(PUBLIC, 'editor.html'))
		}
		if (p.startsWith('/assets/')) {
			const file = safeJoin(PUBLIC, p.slice(1))
			if (file) return serveFile(req, res, file, 'no-cache')
		}
		fail('Not found', 404)
	} catch (error) {
		if (res.headersSent) return res.destroy()
		json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' })
	}
})
server.requestTimeout = 120000
server.headersTimeout = 15000
server.listen(PORT, () => console.log('Flipvio → http://localhost:' + server.address().port))
