const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { once } = require('events')

test('database preserves metadata and refuses corrupt data', () => {
	const { JsonDb } = require('./lib/db')
	const storage = tempStorage()
	const file = path.join(storage, 'db.json')
	try {
		fs.writeFileSync(file, JSON.stringify({ metadata: { keep: true }, books: [{ slug: 'legacy', custom: 7 }] }))
		const db = new JsonDb(file)
		db.update('legacy', { title: 'Updated' })
		const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
		assert.equal(saved.metadata.keep, true)
		assert.equal(saved.books[0].custom, 7)
		fs.writeFileSync(file, '{broken')
		assert.throws(() => new JsonDb(file), /refusing to overwrite/)
		assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
	} finally { fs.rmSync(storage, { recursive: true, force: true }) }
})

const ROOT = path.dirname(__filename)
const PASSWORD = require('crypto').randomBytes(24).toString('hex')
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+v//Z', 'base64')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')

function tempStorage() {
	const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'flipvio-http-'))
	return storage
}

async function startServer(storage, env = {}, args = [path.join(ROOT, 'index.js')]) {
	const child = spawn(process.execPath, args, {
		env: { ...process.env, PORT: '0', FLIPVIO_STORAGE: storage, FLIPVIO_AUTH_FILE: path.join(storage, '.owner.json'), ADMIN_USER: 'SuperAdmin', ADMIN_PASS: PASSWORD, ...env },
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let output = ''
	child.stdout.on('data', (chunk) => { output += chunk })
	child.stderr.on('data', (chunk) => { output += chunk })
	let port = null
	try {
		for (let i = 0; i < 200 && !port; i++) {
			if (child.exitCode !== null) throw new Error('server exited: ' + output)
			await new Promise((resolve) => setTimeout(resolve, 50))
			port = /localhost:(\d+)/.exec(output)?.[1]
		}
	} catch (error) {
		child.kill()
		throw error
	}
	assert.ok(port && port !== '0', 'Server did not report a port: ' + output)
	return { child, base: 'http://127.0.0.1:' + port, output: () => output }
}

async function stopServer(child) {
	if (child.exitCode === null) {
		child.kill()
		await once(child, 'exit').catch(() => {})
	}
}

async function jsonOf(response, message) {
	const text = await response.text()
	assert.equal(response.status >= 200 && response.status < 300 && response.headers.get('content-type')?.includes('application/json'), true, (message || 'unexpected response') + ': ' + text)
	try { return JSON.parse(text) } catch { throw new Error('Invalid JSON response: ' + text) }
}

async function login(base, password = PASSWORD, user = 'SuperAdmin') {
	const response = await fetch(base + '/api/login', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ login: user, password }),
	})
	assert.equal(response.status, 200, 'login failed: ' + (await response.text()))
	return response.headers.get('set-cookie')
}

function fileForm(files) {
	const form = new FormData()
	for (const [name, data, type] of files) form.append('file', new Blob([data], { type }), name)
	return form
}

test('auth hardening: owner bootstrap, lockout, bad requests', async () => {
	const storage = tempStorage()
	try {
		const { child, base } = await startServer(storage)
		try {
			let response = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'SuperAdmin', password: 'wrong-password' }) })
			assert.equal(response.status, 401)
			response = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'SuperAdmin', password: 'wrong-password' }) })
			assert.equal(response.status, 401)
			assert.equal((await fetch(base + '/api/books')).status, 401)
			response = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'SuperAdmin', password: PASSWORD }) })
			assert.equal(response.status, 200)
			const cookie = response.headers.get('set-cookie')
			assert.match(cookie, /HttpOnly/)
			response = await fetch(base + '/api/me', { headers: { cookie } })
			assert.equal(response.status, 200)
			assert.equal((await response.json()).user, 'SuperAdmin')
			response = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' })
			assert.equal(response.status, 400)
		} finally {
			await stopServer(child)
		}
		assert.ok(fs.existsSync(path.join(storage, 'db.json')))
	} finally {
		fs.rmSync(storage, { recursive: true, force: true })
	}
})

test('public vs draft visibility and manifest contract', async () => {
	const storage = tempStorage()
	fs.writeFileSync(path.join(storage, 'db.json'), JSON.stringify({ books: [
		{ slug: 'legacy', title: 'Legacy', pages: [{ index: 1, thumb: '/storage/legacy/pages/thumb/page-1.jpg', normal: '/storage/legacy/pages/normal/page-1.jpg', large: '/storage/legacy/pages/large/page-1.jpg' }], pageCount: 1, settings: { accent: '#ff0000' } },
		{ slug: 'draft', title: 'Draft', pages: [], pageCount: 0, published: false },
	] }))
	try {
		const { child, base } = await startServer(storage)
		try {
			let response = await fetch(base + '/api/books/draft')
			assert.equal(response.status, 404)
			response = await fetch(base + '/api/books/legacy')
			assert.equal(response.status, 200)
			const manifest = await response.json()
			assert.equal(manifest.published, true)
			assert.equal(manifest.pages[0].id, 'page-1')
			assert.equal(manifest.pages[0].index, 1)
			assert.equal(manifest.toc.length, 0)
			assert.ok(manifest.settings.logoWidth !== undefined)
			assert.ok(manifest.settings.backgroundImage !== undefined)
			response = await fetch(base + '/api/books/draft/manifest')
			assert.equal(response.status, 404)
			const cookie = await login(base)
			response = await fetch(base + '/api/books/draft', { headers: { cookie } })
			assert.equal(response.status, 200)
			assert.equal((await response.json()).published, false)
			assert.equal((await fetch(base + '/api/books/draft/manifest', { headers: { cookie } })).status, 200)
			assert.equal((await fetch(base + '/api/books/draft/editor')).status, 401)
			assert.equal((await fetch(base + '/admin', { redirect: 'manual' })).status, 302)
			assert.equal((await fetch(base + '/admin', { headers: { cookie } })).status, 200)
			assert.equal((await fetch(base + '/api/logout', { method: 'POST', headers: { cookie } })).status, 200)
			assert.equal((await fetch(base + '/api/me', { headers: { cookie } })).status, 401)
		} finally {
			await stopServer(child)
		}
	} finally {
		fs.rmSync(storage, { recursive: true, force: true })
	}
})

test('patch validation: pages, elements, toc, settings, published', async () => {
	const storage = tempStorage()
	fs.writeFileSync(path.join(storage, 'db.json'), JSON.stringify({ books: [
		{ slug: 'legacy', title: 'Legacy', published: false, pages: [
			{ index: 1, normal: '/storage/legacy/pages/normal/page-1.jpg', thumb: '/storage/legacy/pages/thumb/page-1.jpg', large: '/storage/legacy/pages/large/page-1.jpg' },
			{ index: 2, normal: '/storage/legacy/pages/normal/page-2.jpg', thumb: '/storage/legacy/pages/thumb/page-2.jpg', large: '/storage/legacy/pages/large/page-2.jpg' },
		], pageCount: 2, toc: [] },
	] }))
	fs.mkdirSync(path.join(storage, 'legacy', 'pages', 'normal'), { recursive: true })
	fs.mkdirSync(path.join(storage, 'legacy', 'pages', 'thumb'), { recursive: true })
	fs.mkdirSync(path.join(storage, 'legacy', 'pages', 'large'), { recursive: true })
	for (const tier of ['normal', 'thumb', 'large']) {
		fs.writeFileSync(path.join(storage, 'legacy', 'pages', tier, 'page-1.jpg'), JPEG)
		fs.writeFileSync(path.join(storage, 'legacy', 'pages', tier, 'page-2.jpg'), JPEG)
	}
	try {
		const { child, base } = await startServer(storage)
		try {
			const cookie = await login(base)
			const headers = { cookie, 'content-type': 'application/json' }
			let response = await fetch(base + '/api/books/legacy', { method: 'PATCH', headers, body: JSON.stringify({ published: true }) })
			assert.equal(response.status, 200)
			assert.equal((await response.json()).published, true)
			response = await fetch(base + '/api/books/legacy', { method: 'PATCH', headers, body: JSON.stringify({ pages: [
				{ id: 'page-2', normal: '/storage/legacy/pages/normal/page-2.jpg', thumb: '/storage/legacy/pages/thumb/page-2.jpg', large: '/storage/legacy/pages/large/page-2.jpg', elements: [] },
				{ id: 'page-1', normal: '/storage/legacy/pages/normal/page-1.jpg', thumb: '/storage/legacy/pages/thumb/page-1.jpg', large: '/storage/legacy/pages/large/page-1.jpg', background: '#ff0000', elements: [
					{ id: 'el1', type: 'text', x: 0.1, y: 0.1, w: 0.5, h: 0.2, text: 'Hello', color: '#111111', fontSize: 24, opacity: 1 },
					{ id: 'el2', type: 'link', x: 0.2, y: 0.2, w: 0.3, h: 0.1, url: 'https://example.com/page' },
				] },
			] }) })
			const body = await jsonOf(response, 'pages patch')
			assert.deepEqual(body.pages.map((page) => page.id), ['page-2', 'page-1'])
			assert.equal(body.pages[0].index, 1)
			assert.equal(body.pages[1].index, 2)
			assert.equal(body.pages[1].background, '#ff0000')
			assert.equal(body.pages[1].elements.length, 2)
			assert.equal(body.pages[1].elements[1].url, 'https://example.com/page')
			response = await fetch(base + '/api/books/legacy', { method: 'PATCH', headers, body: JSON.stringify({ toc: [
				{ id: 'toc-1', title: 'Chapter', pageId: 'page-1' },
				{ id: 'toc-2', title: 'Bad', pageId: 'missing' },
			] }) })
			assert.equal(response.status, 400)
			response = await fetch(base + '/api/books/legacy', { method: 'PATCH', headers, body: JSON.stringify({ toc: [{ id: 'toc-1', title: 'Chapter', pageId: 'page-2' }] }) })
			const tocBody = await jsonOf(response, 'toc patch')
			assert.equal(tocBody.toc[0].pageId, 'page-2')
			response = await fetch(base + '/api/books/legacy', { method: 'PATCH', headers, body: JSON.stringify({ settings: { unknown: true } }) })
			assert.equal(response.status, 400)
			response = await fetch(base + '/api/books/legacy', { method: 'PATCH', headers, body: JSON.stringify({ settings: { accent: 'not a color' } }) })
			assert.equal(response.status, 400)
			response = await fetch(base + '/api/books/legacy', { method: 'PATCH', headers, body: JSON.stringify({ pages: [{ id: 'p1', elements: [{ id: 'e1', type: 'image', x: 0, y: 0, w: 1, h: 1, src: '/storage/other/assets/x.jpg' }] }] }) })
			assert.equal(response.status, 400)
			response = await fetch(base + '/api/books/legacy', { method: 'PATCH', headers, body: JSON.stringify({ pages: [{ id: 'p1', elements: [{ id: 'e1', type: 'link', x: 0, y: 0, w: 1, h: 1, url: 'javascript:alert(1)' }] }] }) })
			assert.equal(response.status, 400)
			response = await fetch(base + '/api/books/legacy', { method: 'PATCH', headers, body: JSON.stringify({ pages: [{ id: 'p1', elements: [{ id: 'e1', type: 'text', x: 0, y: 0, w: 1, h: 1 }] }] }) })
			assert.equal(response.status, 200)
		} finally {
			await stopServer(child)
		}
	} finally {
		fs.rmSync(storage, { recursive: true, force: true })
	}
})

test('asset upload, serving, and storage restrictions', async () => {
	const storage = tempStorage()
	fs.writeFileSync(path.join(storage, 'db.json'), JSON.stringify({ books: [{ slug: 'book', title: 'Book', published: true, pages: [{ index: 1, normal: null, thumb: null, large: null, background: '#ffffff', elements: [] }], pageCount: 1 }] }))
	fs.mkdirSync(path.join(storage, 'book'), { recursive: true })
	fs.writeFileSync(path.join(storage, 'book', 'secret.txt'), 'top secret')
	fs.mkdirSync(path.join(storage, 'book', 'pages', 'normal'), { recursive: true })
	fs.writeFileSync(path.join(storage, 'book', 'pages', 'normal', 'page-1.jpg'), JPEG)
	fs.writeFileSync(path.join(storage, 'db.json') + '.bak', 'backup')
	try {
		const { child, base } = await startServer(storage)
		try {
			const cookie = await login(base)
			let response = await fetch(base + '/api/books/book/assets', { method: 'POST', headers: { cookie }, body: fileForm([['photo.jpg', JPEG, 'image/jpeg']]) })
			const asset = await jsonOf(response, 'asset upload')
			assert.match(asset.url, /^\/storage\/book\/assets\/[0-9a-f-]+\.jpg$/)
			assert.equal(asset.type, 'image')
			response = await fetch(base + asset.url)
			assert.equal(response.status, 200)
			assert.equal(response.headers.get('content-type'), 'image/jpeg')
			assert.equal((await fetch(base + asset.url, { headers: { range: 'bytes=0-3' } })).status, 206)
			assert.equal((await fetch(base + asset.url, { headers: { range: 'bytes=999999-' } })).status, 416)
			response = await fetch(base + '/api/books/book', { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ published: false, settings: { logoUrl: asset.url, backgroundImage: asset.url, logoLink: 'https://example.com', logoWidth: 180 } }) })
			assert.equal(response.status, 200)
			assert.equal((await fetch(base + asset.url)).status, 404)
			assert.equal((await fetch(base + asset.url, { headers: { cookie } })).status, 200)
			response = await fetch(base + '/api/books/book', { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ published: true }) })
			assert.equal(response.status, 200)
			response = await fetch(base + '/storage/book/secret.txt')
			assert.equal(response.status, 404)
			response = await fetch(base + '/storage/db.json')
			assert.equal(response.status, 404)
			response = await fetch(base + '/storage/book/pages/normal/page-1.jpg')
			assert.equal(response.status, 200)
			response = await fetch(base + '/storage/book/pages/thumb/page-9.jpg')
			assert.equal(response.status, 404)
			const raw = await new Promise((resolve, reject) => {
				const socket = require('net').connect(Number(new URL(base).port), '127.0.0.1', () => {
					socket.write('GET /storage/%2e%2e/db.json HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
				})
				let data = ''
				socket.on('data', (chunk) => { data += chunk })
				socket.on('end', () => resolve(Number(/^HTTP\/1\.\d (\d{3})/.exec(data)?.[1])))
				socket.on('error', reject)
			})
			assert.equal(raw, 400)
			response = await fetch(base + '/api/books/book/assets', { method: 'POST', body: fileForm([['photo.jpg', JPEG, 'image/jpeg']]) })
			assert.equal(response.status, 401)
			response = await fetch(base + '/api/books/book/assets', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: 'x' })
			assert.equal(response.status, 400)
			response = await fetch(base + '/api/books/book/assets', { method: 'POST', headers: { cookie }, body: fileForm([['evil.jpg', Buffer.from('<script>alert(1)</script>'), 'image/jpeg']]) })
			assert.equal(response.status, 415)
			response = await fetch(base + '/api/books/book/assets', { method: 'POST', headers: { cookie }, body: fileForm([['image.png', PNG, 'image/png']]) })
			assert.equal(response.status, 201)
		} finally {
			await stopServer(child)
		}
	} finally {
		fs.rmSync(storage, { recursive: true, force: true })
	}
})

test('import creates draft book with unique versioned page directory', async () => {
	const storage = tempStorage()
	try {
		const { child, base } = await startServer(storage)
		try {
			const cookie = await login(base)
			let response = await fetch(base + '/api/books', { method: 'POST', headers: { cookie }, body: fileForm([['page-a.jpg', JPEG, 'image/jpeg'], ['page-b.jpg', JPEG, 'image/jpeg']]) })
			const created = await jsonOf(response, 'import')
			assert.equal(created.published, false)
			assert.equal(created.pageCount, 2)
			assert.match(created.pages[0].id, /^page-[0-9a-f-]{36}$/)
			assert.match(created.pages[0].normal, /^\/storage\/[^/]+\/pages\/v-[0-9a-f-]{36}\/normal\/page-1\.jpg$/)
			const version = created.pages[0].normal.match(/pages\/(v-[0-9a-f-]{36})\//)[1]
			assert.ok(fs.existsSync(path.join(storage, created.slug, 'pages', version, 'normal', 'page-1.jpg')))
			response = await fetch(base + '/api/books')
			assert.equal(response.status, 401)
			response = await fetch(base + '/api/books', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })
			assert.equal(response.status, 400)
			const slug = created.slug
			response = await fetch(base + '/api/books/' + slug + '/pages', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: 'x' })
			assert.equal(response.status, 400)
			response = await fetch(base + '/api/books/' + slug + '/pages', { method: 'POST', headers: { cookie }, body: fileForm([['doc.pdf', PDF, 'application/pdf']]) })
			assert.ok([200, 415, 503].includes(response.status), 'pdf conversion status ' + response.status)
		} finally {
			await stopServer(child)
		}
	} finally {
		fs.rmSync(storage, { recursive: true, force: true })
	}
})

test('pdf and image conversion pipeline on temp storage', async () => {
	const storage = tempStorage()
	try {
		const { child, base } = await startServer(storage)
		try {
			const cookie = await login(base)
			let response = await fetch(base + '/api/books', { method: 'POST', headers: { cookie }, body: fileForm([['demo.pdf', fs.readFileSync(path.join(ROOT, '..', 'test-demo-24p.pdf')), 'application/pdf']]) })
			if (response.status === 201) {
				const created = await jsonOf(response, 'pdf import')
				assert.equal(created.pageCount, 24)
				assert.match(created.pages[0].normal, /\/pages\/v-[0-9a-f-]+\/normal\/page-1\.jpg$/)
				assert.ok(fs.existsSync(path.join(storage, created.slug, 'pages')))
				const slug = created.slug
				response = await fetch(base + '/api/books/' + slug + '/pages', { method: 'POST', headers: { cookie }, body: fileForm([['extra.jpg', JPEG, 'image/jpeg']]) })
				const appended = await jsonOf(response, 'append pages')
				assert.equal(appended.pageCount, 25)
				assert.notEqual(appended.pages[0].normal.split('/')[4], appended.pages[24].normal.split('/')[4])
				response = await fetch(base + '/api/books/' + slug, { method: 'DELETE', headers: { cookie } })
				assert.equal(response.status, 200)
				assert.ok(!fs.existsSync(path.join(storage, slug)))
			} else {
				assert.ok([415, 503].includes(response.status), 'conversion unavailable: ' + response.status)
			}
		} finally {
			await stopServer(child)
		}
	} finally {
		fs.rmSync(storage, { recursive: true, force: true })
	}
})

test('origin checks and auth for writes', async () => {
	const storage = tempStorage()
	fs.writeFileSync(path.join(storage, 'db.json'), JSON.stringify({ books: [{ slug: 'book', title: 'Book', published: true, pages: [], pageCount: 0 }] }))
	try {
		const { child, base } = await startServer(storage)
		try {
			let response = await fetch(base + '/api/books/book', { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })
			assert.equal(response.status, 403)
			response = await fetch(base + '/api/books/book', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })
			assert.equal(response.status, 401)
			const cookie = await login(base)
			response = await fetch(base + '/api/books/book', { method: 'PATCH', headers: { cookie, 'content-type': 'application/json', origin: base }, body: JSON.stringify({ title: 'New' }) })
			assert.equal(response.status, 200)
		} finally {
			await stopServer(child)
		}
	} finally {
		fs.rmSync(storage, { recursive: true, force: true })
	}
})

test('public QR endpoint validates URLs and returns locally generated PNGs', async (t) => {
	const storage = tempStorage()
	const decoder = spawnSync('python', ['-c', 'import cv2, numpy'], { timeout: 10000 })
	try {
		const { child, base } = await startServer(storage)
		try {
			for (const text of ['https://example.invalid/b/demo?x=1&y=%26#p=12', 'http://localhost:8080/b/книга#p=2']) {
				const endpoint = base + '/api/qr?text=' + encodeURIComponent(text)
				const response = await fetch(endpoint)
				assert.equal(response.status, 200)
				assert.equal(response.headers.get('content-type'), 'image/png')
				assert.equal(response.headers.get('cache-control'), 'private, no-store')
				assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
				const png = Buffer.from(await response.arrayBuffer())
				assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
				assert.equal(Number(response.headers.get('content-length')), png.length)
				assert.deepEqual(Buffer.from(await (await fetch(endpoint)).arrayBuffer()), png)
				const head = await fetch(endpoint, { method: 'HEAD' })
				assert.equal(head.status, 200)
				assert.equal(Number(head.headers.get('content-length')), png.length)
				assert.equal((await head.arrayBuffer()).byteLength, 0)
				await t.test('decode ' + text, { skip: decoder.status !== 0 && 'Python OpenCV unavailable' }, () => {
					const decoded = spawnSync('python', ['-c', 'import sys,json,cv2,numpy as np; image=cv2.imdecode(np.frombuffer(sys.stdin.buffer.read(),dtype=np.uint8),cv2.IMREAD_GRAYSCALE); print(json.dumps(cv2.QRCodeDetector().detectAndDecode(image)[0]))'], { input: png, timeout: 15000 })
					assert.equal(decoded.status, 0, decoded.stderr?.toString())
					assert.equal(JSON.parse(decoded.stdout.toString()), text)
				})
			}
			for (const text of ['', '/b/book', '//example.com', 'ftp://example.com', 'javascript:alert(1)', 'https://', 'https:example.com', 'https://u:p@example.com', 'https://example.com/\nbook', 'https://example.com/a b', 'https://example.com/%zz', 'https://[broken']) {
				const response = await fetch(base + '/api/qr?text=' + encodeURIComponent(text))
				assert.equal(response.status, 400, text)
				assert.ok((await response.json()).error)
			}
			assert.equal((await fetch(base + '/api/qr')).status, 400)
			assert.equal((await fetch(base + '/api/qr?text=https://example.com&text=https://example.org')).status, 400)
			assert.equal((await fetch(base + '/api/qr?text=%FF')).status, 400)
			const prefix = 'https://example.invalid/'
			assert.equal((await fetch(base + '/api/qr?text=' + encodeURIComponent(prefix + 'a'.repeat(2048 - prefix.length)))).status, 200)
			for (const text of [prefix + 'a'.repeat(2049 - prefix.length), prefix + 'я'.repeat(1024)]) {
				assert.equal((await fetch(base + '/api/qr?text=' + encodeURIComponent(text))).status, 413)
			}
			const method = await fetch(base + '/api/qr?text=https://example.com', { method: 'POST' })
			assert.equal(method.status, 405)
			assert.equal(method.headers.get('allow'), 'GET, HEAD')
			let fetched = false
			const target = require('http').createServer((req, res) => { fetched = true; res.end() })
			target.listen(0, '127.0.0.1')
			await once(target, 'listening')
			try {
				assert.equal((await fetch(base + '/api/qr?text=' + encodeURIComponent('http://127.0.0.1:' + target.address().port + '/book'))).status, 200)
				assert.equal(fetched, false)
			} finally { await new Promise((resolve) => target.close(resolve)) }
		} finally { await stopServer(child) }
	} finally { fs.rmSync(storage, { recursive: true, force: true }) }
})

test('QR endpoint rate limit includes cache hits and returns retry-after', async () => {
	const storage = tempStorage()
	try {
		const { child, base } = await startServer(storage)
		try {
			for (let i = 0; i < 120; i++) {
				const response = await fetch(base + '/api/qr?text=https://example.invalid/book')
				assert.equal(response.status, 200)
				await response.arrayBuffer()
			}
			const response = await fetch(base + '/api/qr?text=https://example.invalid/book')
			assert.equal(response.status, 429)
			assert.ok(Number(response.headers.get('retry-after')) > 0)
			assert.ok((await response.json()).error)
			assert.equal((await fetch(base + '/healthz')).status, 200)
		} finally { await stopServer(child) }
	} finally { fs.rmSync(storage, { recursive: true, force: true }) }
})

test('QR cache bounds, expiry, concurrency and rate reset', async (t) => {
	const QRCode = require('qrcode')
	const { createQrHandler } = require('./lib/qr')
	let time = 0
	let calls = 0
	t.mock.method(QRCode, 'toBuffer', async () => Buffer.from(String(++calls)))
	const handler = createQrHandler(() => time)
	const request = async (id) => {
		let body
		await handler({ method: 'GET', url: '/api/qr?text=https://example.invalid/' + id }, { setHeader() {}, writeHead() {}, end(value) { body = value } })
		return body.toString()
	}
	assert.equal(await request(0), '1')
	assert.equal(await request(0), '1')
	for (let i = 1; i < 64; i++) await request(i)
	assert.equal(await request(0), '1')
	await request(64)
	assert.equal(await request(0), '1')
	assert.equal(await request(1), '66')
	time = 300000
	assert.equal(await request(0), '67')
	for (let i = 1; i < 120; i++) await request(0)
	await assert.rejects(request(0), { status: 429 })
	time += 60000
	assert.equal(await request(0), '67')
	let resolve
	t.mock.method(QRCode, 'toBuffer', () => new Promise((done) => { resolve = done }))
	const same = [request('same'), request('same')]
	resolve(Buffer.from('shared'))
	assert.deepEqual(await Promise.all(same), ['shared', 'shared'])
	const resolvers = []
	t.mock.method(QRCode, 'toBuffer', () => new Promise((done) => resolvers.push(done)))
	const active = Array.from({ length: 4 }, (_, i) => request('pending' + i))
	await assert.rejects(request('overflow'), { status: 429 })
	resolvers.forEach((done) => done(Buffer.from('ok')))
	await Promise.all(active)
	t.mock.method(QRCode, 'toBuffer', async () => { throw new Error('encode failed') })
	await assert.rejects(request('failure'), /encode failed/)
	t.mock.method(QRCode, 'toBuffer', async () => Buffer.from('recovered'))
	assert.equal(await request('failure'), 'recovered')
})

test('public names persist, reserve every namespace and keep legacy metadata', () => {
	const { JsonDb } = require('./lib/db')
	const storage = tempStorage()
	const file = path.join(storage, 'db.json')
	try {
		fs.writeFileSync(file, JSON.stringify({ metadata: { keep: true }, books: [{ slug: 'legacy', custom: 7 }] }))
		let db = new JsonDb(file)
		assert.equal(db.get('legacy').publicSlug, undefined)
		assert.equal(db.update('legacy', { publicSlug: ' First-Name ' }).publicSlug, 'first-name')
		db.update('legacy', { publicSlug: 'КНИГА-2026' })
		db = new JsonDb(file)
		for (const name of ['legacy', 'first-name', 'книга-2026']) {
			assert.equal(db.resolve(name).slug, 'legacy')
			assert.throws(() => db.insert({ slug: name }), { status: 409 })
			assert.throws(() => db.insert({ slug: 'fresh', publicSlug: name }), { status: 409 })
		}
		assert.throws(() => db.insert({ slug: 'FIRST-NAME' }), { status: 409 })
		assert.throws(() => db.update('legacy', { slug: 'changed' }), { status: 400 })
		assert.equal(db.get('legacy').custom, 7)
		assert.deepEqual(db.data.metadata, { keep: true })
		assert.equal(db.insert({ slug: 'fresh', title: 'New import' }).publicSlug, 'fresh')
		db.update('legacy', { publicSlug: 'first-name', publicSlugAliases: [] })
		assert.equal(db.resolve('книга-2026').slug, 'legacy')
		db.remove('legacy')
		db = new JsonDb(file)
		for (const name of ['legacy', 'first-name', 'книга-2026']) {
			assert.equal(db.resolve(name), null)
			assert.throws(() => db.insert({ slug: name }), { status: 409 })
			assert.throws(() => db.update('fresh', { publicSlug: name }), { status: 409 })
		}
	} finally { fs.rmSync(storage, { recursive: true, force: true }) }
})

test('editable public names: auth, validation, canonical routes, manifests and draft assets', async () => {
	const storage = tempStorage()
	const asset = '/storage/legacy/assets/abcdef.jpg'
	fs.mkdirSync(path.join(storage, 'legacy', 'assets'), { recursive: true })
	fs.mkdirSync(path.join(storage, 'other', 'assets'), { recursive: true })
	fs.writeFileSync(path.join(storage, 'legacy', 'assets', 'abcdef.jpg'), JPEG)
	fs.writeFileSync(path.join(storage, 'other', 'assets', 'abcdef.jpg'), JPEG)
	fs.writeFileSync(path.join(storage, 'legacy', 'source.pdf'), PDF)
	fs.writeFileSync(path.join(storage, 'db.json'), JSON.stringify({ books: [
		{ slug: 'legacy', title: 'Legacy', pages: [{ id: 'p1', normal: asset }], pdfUrl: '/storage/legacy/source.pdf', settings: { allowDownload: false } },
		{ slug: 'other', publicSlug: 'taken', publicSlugAliases: ['previous'], published: false, pages: [] },
		{ slug: 'draft', published: false, pages: [] },
	] }))
	try {
		const { child, base } = await startServer(storage)
		try {
			const cookie = await login(base)
			const headers = { cookie, 'content-type': 'application/json' }
			const patch = (name, body, requestHeaders = headers) => fetch(base + '/api/books/' + encodeURIComponent(name), { method: 'PATCH', headers: requestHeaders, body: JSON.stringify(body) })
			for (const name of ['legacy', 'draft', 'missing']) {
				assert.equal((await patch(name, { publicSlug: 'new-name' }, { 'content-type': 'application/json' })).status, 401)
				assert.equal((await patch(name, { publicSlug: 'new-name' }, { cookie: 'fv_session=invalid', 'content-type': 'application/json' })).status, 401)
			}
			assert.equal((await patch('legacy', { publicSlug: 'new-name' }, { ...headers, origin: 'https://evil.example' })).status, 403)
			for (const name of [null, 12, {}, [], '', 'a', 'a'.repeat(81), 'a/b', 'a?b', 'a#b', 'a.b', 'a\\b', 'a%2fb', 'a b', 'a\nb', '\tvalid', 'ab\u0000', 'ab\u007f', 'ab\u200b', 'ab\u202e', '-ab', 'ab-', '中文', 'api', 'EMBED', 'manifest', 'storage', 'editor', 'admin']) {
				const response = await patch('legacy', { publicSlug: name, title: 'Must not save' })
				assert.equal(response.status, 400, JSON.stringify(name))
				assert.ok((await response.json()).error)
			}
			for (const name of ['other', 'taken', 'previous', 'TAKEN']) {
				const response = await patch('legacy', { publicSlug: name, title: 'Must not save' })
				assert.equal(response.status, 409)
				assert.equal((await response.json()).error, 'This public URL name is already in use; choose another name')
			}
			let manifest = await jsonOf(await fetch(base + '/api/books/legacy/manifest'))
			assert.equal(manifest.title, 'Legacy')
			assert.equal(manifest.publicSlug, 'legacy')
			assert.equal(manifest.url, '/b/legacy')
			for (const name of ['ab', 'a'.repeat(80), ' E\u0301TÉ-ЇЖАК-42 ', ' First-Name ', ' КНИГА-2026 ']) {
				manifest = await jsonOf(await patch('legacy', { publicSlug: name }))
				assert.equal(manifest.publicSlug, name.trim().normalize('NFC').toLowerCase())
				assert.equal(manifest.slug, 'legacy')
				assert.equal(manifest.pages[0].normal, asset)
			}
			const canonicalName = encodeURIComponent('книга-2026')
			const canonical = '/b/' + canonicalName
			assert.equal(manifest.url, canonical)
			const list = await jsonOf(await fetch(base + '/api/books', { headers: { cookie } }))
			assert.equal(list.books.find((book) => book.slug === 'legacy').url, canonical)
			assert.equal(list.books.find((book) => book.slug === 'legacy').publicSlug, 'книга-2026')
			for (const name of ['legacy', 'first-name', 'книга-2026']) {
				for (const suffix of ['', '/manifest']) {
					const response = await fetch(base + '/api/books/' + encodeURIComponent(name) + suffix)
					assert.equal(response.status, 200)
					assert.equal(response.headers.get('location'), null)
					assert.equal((await response.json()).url, canonical)
				}
				assert.equal((await fetch(base + '/api/books/' + encodeURIComponent(name) + '/editor')).status, 401)
				for (const prefix of ['/b/', '/embed/']) {
					for (const method of ['GET', 'HEAD']) {
						const query = '?p=2&value=%26&value=x+z'
						const response = await fetch(base + prefix + encodeURIComponent(name) + query + '#p=7', { method, redirect: 'manual' })
						assert.equal(response.status, name === 'книга-2026' ? 200 : 302)
						if (name !== 'книга-2026') {
							assert.equal(response.headers.get('location'), prefix + canonicalName + query)
							assert.equal(response.headers.get('location').includes('#'), false)
							assert.equal(response.headers.get('cache-control'), 'no-store')
						}
					}
				}
			}
			assert.equal((await fetch(base + canonical + '/', { redirect: 'manual' })).headers.get('location'), canonical)
			assert.equal((await fetch(base + asset)).status, 200)
			assert.equal((await fetch(base + '/storage/' + canonicalName + '/assets/abcdef.jpg')).status, 404)
			assert.equal((await fetch(base + '/storage/legacy/source.pdf')).status, 404)
			assert.equal((await fetch(base + '/storage/legacy/source.pdf', { headers: { cookie } })).status, 200)
			assert.equal((await patch('first-name', { settings: { logoUrl: '/storage/other/assets/abcdef.jpg' } })).status, 400)
			assert.equal((await patch('first-name', { settings: { logoUrl: asset } })).status, 200)
			const uploaded = await jsonOf(await fetch(base + '/api/books/' + canonicalName + '/assets', { method: 'POST', headers: { cookie }, body: fileForm([['photo.jpg', JPEG, 'image/jpeg']]) }))
			assert.match(uploaded.url, /^\/storage\/legacy\/assets\//)
			assert.equal((await patch('legacy', { published: false })).status, 200)
			for (const name of ['legacy', 'first-name', 'книга-2026']) {
				for (const route of ['/b/', '/embed/', '/api/books/']) {
					for (const method of ['GET', 'HEAD']) {
						const response = await fetch(base + route + encodeURIComponent(name), { method, redirect: 'manual' })
						assert.equal(response.status, 404)
						assert.equal(response.headers.get('location'), null)
						if (method === 'GET') assert.deepEqual(await response.json(), { error: 'Not found' })
					}
				}
				assert.equal((await fetch(base + '/api/books/' + encodeURIComponent(name) + '/manifest')).status, 404)
				assert.equal((await fetch(base + '/api/books/' + encodeURIComponent(name) + '/manifest', { headers: { cookie } })).status, 200)
			}
			assert.equal((await fetch(base + '/b/legacy', { headers: { cookie }, redirect: 'manual' })).headers.get('location'), canonical)
			for (const url of [asset, uploaded.url, '/storage/legacy/source.pdf']) {
				assert.equal((await fetch(base + url)).status, 404)
				assert.equal((await fetch(base + url, { headers: { cookie } })).status, 200)
			}
			assert.equal((await patch('legacy', { published: true })).status, 200)
			assert.equal((await fetch(base + '/b/first-name', { redirect: 'manual' })).headers.get('location'), canonical)
			assert.ok(fs.existsSync(path.join(storage, 'legacy', 'assets', 'abcdef.jpg')))
			assert.equal(fs.existsSync(path.join(storage, 'книга-2026')), false)
			const saved = JSON.parse(fs.readFileSync(path.join(storage, 'db.json'), 'utf8')).books.find((book) => book.slug === 'legacy')
			assert.ok(saved.publicSlugAliases.includes('legacy'))
			assert.ok(saved.publicSlugAliases.includes('first-name'))
			const race = await Promise.all([patch('legacy', { publicSlug: 'shared-name' }), patch('other', { publicSlug: 'shared-name' })])
			assert.deepEqual(race.map((response) => response.status).sort(), [200, 409])
		} finally { await stopServer(child) }
	} finally { fs.rmSync(storage, { recursive: true, force: true }) }
})

test('imports reject immutable, public and historical names before conversion and recheck at insert', async () => {
	const storage = tempStorage()
	const candidate = 'collision-010101010101'
	fs.writeFileSync(path.join(storage, 'db.json'), JSON.stringify({ books: [
		{ slug: 'owner', publicSlug: candidate, published: false, pages: [] },
		{ slug: 'immutable-010101010101', pages: [] },
	] }))
	const script = `const crypto = require('crypto'); const randomBytes = crypto.randomBytes; crypto.randomBytes = (size) => size === 6 ? Buffer.alloc(6, 1) : randomBytes(size); const uploads = require(${JSON.stringify(path.join(ROOT, 'lib', 'uploads.js'))}); uploads.convert = async () => { await new Promise((resolve) => setTimeout(resolve, 300)); return { result: { pages: [] } } }; require(${JSON.stringify(path.join(ROOT, 'index.js'))})`
	try {
		const { child, base } = await startServer(storage, {}, ['-e', script])
		try {
			const cookie = await login(base)
			const patch = (publicSlug) => fetch(base + '/api/books/owner', { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ publicSlug }) })
			const upload = (slug) => {
				const form = fileForm([['page.jpg', JPEG, 'image/jpeg']])
				form.append('slug', slug)
				return fetch(base + '/api/books', { method: 'POST', headers: { cookie }, body: form })
			}
			assert.equal((await upload('collision')).status, 409)
			assert.equal((await upload('immutable')).status, 409)
			assert.equal(fs.existsSync(path.join(storage, candidate)), false)
			assert.equal((await patch('renamed')).status, 200)
			assert.equal((await upload('collision')).status, 409)
			const pending = upload('racing')
			const racing = 'racing-010101010101'
			for (let i = 0; i < 100 && !fs.existsSync(path.join(storage, racing)); i++) await new Promise((resolve) => setTimeout(resolve, 5))
			assert.ok(fs.existsSync(path.join(storage, racing)))
			assert.equal((await patch(racing)).status, 200)
			assert.equal((await pending).status, 409)
			assert.equal(fs.existsSync(path.join(storage, racing)), false)
			const created = await jsonOf(await upload('fresh'))
			assert.equal(created.publicSlug, created.slug)
			assert.equal(created.url, '/b/' + encodeURIComponent(created.slug))
			assert.equal(created.published, false)
			assert.equal((await patch(created.slug)).status, 409)
		} finally { await stopServer(child) }
	} finally { fs.rmSync(storage, { recursive: true, force: true }) }
})

test('login throttle applies per ip', async () => {
	const storage = tempStorage()
	try {
		const { child, base } = await startServer(storage)
		try {
			const attempt = () => fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'SuperAdmin', password: 'nope' }) })
			await attempt()
			await attempt()
			await attempt()
			await attempt()
			const response = await attempt()
			assert.equal(response.status, 429)
		} finally {
			await stopServer(child)
		}
	} finally {
		fs.rmSync(storage, { recursive: true, force: true })
	}
})
