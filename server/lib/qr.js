const QRCode = require('qrcode')
const { fail } = require('./validation')

function createQrHandler(now = Date.now) {
	const cache = new Map()
	const pending = new Map()
	let windowEnd = 0
	let requests = 0
	return async function serveQr(req, res) {
		if (!['GET', 'HEAD'].includes(req.method)) {
			res.setHeader('allow', 'GET, HEAD')
			fail('Method not allowed', 405)
		}
		const time = now()
		if (time >= windowEnd) {
			windowEnd = time + 60000
			requests = 0
		}
		if (++requests > 120) {
			res.setHeader('retry-after', String(Math.max(1, Math.ceil((windowEnd - time) / 1000))))
			fail('QR request limit reached; retry later', 429)
		}
		const values = new URL(req.url, 'http://localhost').searchParams.getAll('text')
		if (values.length !== 1 || !values[0]) fail('Exactly one text URL is required')
		const text = values[0]
		if (Buffer.byteLength(text, 'utf8') > 2048) fail('QR URL exceeds 2048 bytes', 413)
		if (!/^https?:\/\//i.test(text) || /[\s\x00-\x1f\x7f\\\ufffd]/u.test(text) || /%(?![\da-f]{2})/i.test(text)) fail('Invalid HTTP(S) URL')
		let url
		try { url = new URL(text) } catch { fail('Invalid HTTP(S) URL') }
		if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) fail('Invalid HTTP(S) URL')
		for (const [key, entry] of cache) {
			if (entry.expires <= time) cache.delete(key)
		}
		let body = cache.get(text)?.body
		if (body) {
			const entry = cache.get(text)
			cache.delete(text)
			cache.set(text, entry)
		} else {
			let task = pending.get(text)
			if (!task) {
				if (pending.size >= 4) {
					res.setHeader('retry-after', '1')
					fail('QR generation capacity reached; retry later', 429)
				}
				task = QRCode.toBuffer(text, { type: 'png', errorCorrectionLevel: 'M', margin: 4, scale: 4 }).then((png) => {
					if (cache.size >= 64) cache.delete(cache.keys().next().value)
					cache.set(text, { body: png, expires: now() + 300000 })
					return png
				}).finally(() => pending.delete(text))
				pending.set(text, task)
			}
			body = await task
		}
		res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length, 'cache-control': 'private, no-store' })
		res.end(req.method === 'HEAD' ? undefined : body)
	}
}

module.exports = { createQrHandler }
