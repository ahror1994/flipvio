const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { parseMultipart, readBody } = require('./multipart')
const { processPdf, processImages } = require('./pdf')
const { fail, safeJoin } = require('./validation')

function inspectFile(file, allowPdf = false) {
	const data = file.data
	const ext = path.extname(file.filename).toLowerCase().replace('.jpeg', '.jpg').replace('.tiff', '.tif')
	const ascii = (start, end) => data.subarray(start, end).toString('ascii')
	let valid = false
	let type = 'image'
	let cap = 20 * 1024 * 1024
	if (data.length < 12) fail('Empty or truncated media')
	switch (ext) {
		case '.jpg': valid = data[0] === 255 && data[1] === 216 && data[2] === 255; break
		case '.png': valid = data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && ascii(12, 16) === 'IHDR'; break
		case '.webp': valid = ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(12, 16)); break
		case '.gif': valid = ['GIF87a', 'GIF89a'].includes(ascii(0, 6)); type = 'gif'; break
		case '.mp4': valid = ascii(4, 8) === 'ftyp' && data.readUInt32BE(0) >= 16 && data.readUInt32BE(0) <= data.length && /^(isom|iso[2-9]|mp4[12]|avc1|M4V |dash)$/.test(ascii(8, 12)); type = 'video'; cap = 100 * 1024 * 1024; break
		case '.webm': valid = data.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex')) && data.subarray(4, 4096).includes(Buffer.from('webm')); type = 'video'; cap = 100 * 1024 * 1024; break
		case '.mp3': valid = ascii(0, 3) === 'ID3' || (data[0] === 255 && (data[1] & 0xe0) === 0xe0 && (data[1] & 6) !== 0 && (data[2] & 0xf0) !== 0xf0 && (data[2] & 12) !== 12); type = 'audio'; cap = 50 * 1024 * 1024; break
		case '.wav': valid = ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE'; type = 'audio'; cap = 50 * 1024 * 1024; break
		case '.ogg': valid = ascii(0, 4) === 'OggS' && data[4] === 0 && (data.subarray(0, 4096).includes(Buffer.from('OpusHead')) || data.subarray(0, 4096).includes(Buffer.from('\x01vorbis'))); type = 'audio'; cap = 50 * 1024 * 1024; break
		case '.pdf': valid = allowPdf && /^%PDF-1\.[0-9]|^%PDF-2\.0/.test(ascii(0, 8)) && data.subarray(-4096).includes(Buffer.from('%%EOF')); type = 'pdf'; cap = 300 * 1024 * 1024; break
		case '.tif': valid = allowPdf && (data.subarray(0, 4).equals(Buffer.from('49492a00', 'hex')) || data.subarray(0, 4).equals(Buffer.from('4d4d002a', 'hex'))); break
	}
	if (!valid) fail('Unsupported file or invalid media signature: ' + ext, 415)
	if (data.length > cap) fail('File exceeds ' + cap / 1024 / 1024 + ' MB limit', 413)
	return { ext, type }
}

async function multipart(req, maxBytes) {
	return parseMultipart(await readBody(req, maxBytes), req.headers['content-type'])
}

async function saveAsset(req, storage, slug) {
	const { files } = await multipart(req, 100 * 1024 * 1024 + 65536)
	if (files.length !== 1 || files[0].field !== 'file') fail('Provide one multipart file field')
	const { ext, type } = inspectFile(files[0])
	const name = crypto.randomUUID() + ext
	const dir = safeJoin(storage, slug + '/assets')
	if (!dir) fail('Invalid storage path')
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(path.join(dir, name), files[0].data, { flag: 'wx', mode: 0o600 })
	return { url: '/storage/' + slug + '/assets/' + name, type }
}

function validateImports(files) {
	if (!files.length || files.length > 100) fail('Provide 1–100 images or one PDF')
	const entries = files.map((file) => ({ ...file, ...inspectFile(file, true) }))
	if (entries.some((file) => !['pdf', 'image', 'gif'].includes(file.type))) fail('Only PDF or images can become pages', 415)
	if (entries.some((file) => file.type === 'pdf') && entries.length !== 1) fail('Upload one PDF or multiple images, not both')
	return entries
}

async function convert(files, storage, slug) {
	const version = 'v-' + crypto.randomUUID()
	const dir = safeJoin(storage, slug + '/pages/' + version)
	if (!dir) fail('Invalid storage path')
	fs.mkdirSync(dir, { recursive: true })
	const source = path.join(dir, 'src')
	fs.mkdirSync(source)
	try {
		const paths = files.map((file, i) => {
			const target = path.join(source, 'input-' + i + file.ext)
			fs.writeFileSync(target, file.data, { flag: 'wx', mode: 0o600 })
			return target
		})
		const publicBase = '/storage/' + slug + '/pages/' + version
		const result = files[0].type === 'pdf'
			? await processPdf({ pdfPath: paths[0], outRoot: dir, publicBase })
			: await processImages({ imagePaths: paths, outRoot: dir, publicBase })
		if (!result.pages?.length || result.pages.length > 1000) fail('Conversion must produce 1–1000 pages')
		result.pages = result.pages.map((page) => ({ ...page, id: 'page-' + crypto.randomUUID(), background: '#ffffff', elements: [] }))
		fs.rmSync(source, { recursive: true, force: true })
		return { result, dir }
	} catch (error) {
		fs.rmSync(dir, { recursive: true, force: true })
		throw error
	}
}

module.exports = { inspectFile, multipart, validateImports, saveAsset, convert }
