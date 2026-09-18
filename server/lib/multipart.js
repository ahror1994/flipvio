const { fail } = require('./validation')

function parseMultipart(body, contentType) {
	const match = /^multipart\/form-data\s*;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))(?:\s*;.*)?$/i.exec(contentType || '')
	if (!match || (match[1] || match[2]).length > 70) fail('Invalid multipart boundary')
	const boundary = Buffer.from('--' + (match[1] || match[2]))
	const delimiter = Buffer.concat([Buffer.from('\r\n'), boundary])
	const fields = Object.create(null)
	const files = []
	let count = 0
	let pos = boundary.length
	if (!body.subarray(0, pos).equals(boundary)) fail('Malformed multipart body')
	while (pos < body.length) {
		if (body.subarray(pos, pos + 2).toString() === '--') return { fields, files }
		if (body.subarray(pos, pos + 2).toString() !== '\r\n') fail('Malformed multipart body')
		pos += 2
		const headerEnd = body.indexOf('\r\n\r\n', pos)
		if (headerEnd < 0 || headerEnd - pos > 8192 || ++count > 105) fail('Invalid multipart headers')
		const headers = body.subarray(pos, headerEnd).toString('utf8')
		const disposition = /^content-disposition:\s*form-data;([^\r\n]*)/im.exec(headers)
		const name = disposition && /(?:^|;)\s*name="([^"\r\n]{1,100})"/.exec(disposition[1])
		const filename = disposition && /(?:^|;)\s*filename="([^"\r\n]{1,255})"/.exec(disposition[1])
		if (!name) fail('Missing multipart field name')
		const start = headerEnd + 4
		let end = body.indexOf(delimiter, start)
		while (end >= 0 && !['--', '\r\n'].includes(body.subarray(end + delimiter.length, end + delimiter.length + 2).toString())) end = body.indexOf(delimiter, end + 1)
		if (end < 0) fail('Unterminated multipart body')
		const data = body.subarray(start, end)
		if (filename) {
			if (files.length >= 100) fail('Too many files')
			files.push({ field: name[1], filename: filename[1], mimeType: /^content-type:\s*([^\r\n]+)/im.exec(headers)?.[1]?.trim() || 'application/octet-stream', data })
		} else {
			if (data.length > 16384) fail('Field too large')
			fields[name[1]] = data.toString('utf8')
		}
		pos = end + delimiter.length
	}
	fail('Unterminated multipart body')
}

function readBody(req, maxBytes) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		let failed = false
		req.on('data', (chunk) => {
			if (failed) return
			size += chunk.length
			if (size > maxBytes) {
				failed = true
				chunks.length = 0
				reject(Object.assign(new Error('Payload too large'), { status: 413 }))
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)) })
		req.on('aborted', () => reject(Object.assign(new Error('Request aborted'), { status: 400 })))
		req.on('error', reject)
	})
}

module.exports = { parseMultipart, readBody }
