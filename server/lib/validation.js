const fs = require('fs')
const path = require('path')

function fail(message, status = 400) {
	throw Object.assign(new Error(message), { status })
}

function publicSlug(value) {
	if (typeof value !== 'string') fail('Public URL name must be text')
	if (/[\p{Cc}\p{Cf}]/u.test(value)) fail('Public URL name cannot contain control characters')
	const name = value.trim().normalize('NFC').toLowerCase().normalize('NFC')
	if ([...name].length < 2 || [...name].length > 80) fail('Public URL name must contain 2–80 characters')
	if (!/^[\p{Script=Latin}\p{Script=Cyrillic}0-9-]+$/u.test(name) || !/^[\p{L}0-9-]+$/u.test(name) || /^-|-$/.test(name)) fail('Use Latin or Cyrillic letters, numbers and hyphens, starting and ending with a letter or number')
	if (['api', 'b', 'embed', 'manifest', 'editor', 'assets', 'pages', 'storage', 'admin', 'login', 'logout', 'healthz'].includes(name)) fail('This public URL name is reserved; choose another name')
	return name
}

function safeJoin(base, rel) {
	if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.includes('\0') || rel.includes(':')) return null
	const parts = rel.split('/')
	if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || /[. ]$/.test(part))) return null
	const root = path.resolve(base)
	const full = path.resolve(root, ...parts)
	const relative = path.relative(root, full)
	if (relative.startsWith('..') || path.isAbsolute(relative)) return null
	let current = root
	for (const part of parts) {
		current = path.join(current, part)
		try {
			if (fs.lstatSync(current).isSymbolicLink()) return null
		} catch (error) {
			if (error.code !== 'ENOENT') return null
		}
	}
	return full
}

const MEDIA = /\.(?:jpe?g|png|webp|gif|mp4|webm|mp3|wav|ogg)$/i
function assetPath(storage, slug, value, imagesOnly = false) {
	if (typeof value !== 'string' || value.length > 2048 || /[?#\s]/.test(value)) return null
	let decoded
	try { decoded = decodeURIComponent(value) } catch { return null }
	const prefix = '/storage/' + slug + '/'
	if (!decoded.startsWith(prefix)) return null
	const rel = decoded.slice(prefix.length)
	if (!/^(assets|pages)\//.test(rel) || !MEDIA.test(rel)) return null
	if (imagesOnly && !/\.(?:jpe?g|png|webp|gif)$/i.test(rel)) return null
	return safeJoin(storage, slug + '/' + rel)
}

function ownedUrl(storage, slug, value, imagesOnly = false) {
	if (value === null || value === '') return null
	const file = assetPath(storage, slug, value, imagesOnly)
	if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) fail('src must reference an existing asset owned by this book')
	return value
}

function safeLink(value) {
	if (value === null || value === '') return null
	if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f\\]/.test(value)) fail('Invalid link')
	if (/^#[a-zA-Z0-9_=.-]+$/.test(value)) return value
	if (/^\/(?!\/)/.test(value)) return value
	let url
	try { url = new URL(value) } catch { fail('Invalid link') }
	if (!['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol) || url.username || url.password) fail('Unsupported link protocol')
	return value
}

function object(value, name) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) fail(name + ' must be an object')
	return value
}

function number(value, min, max, name) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail('Invalid ' + name)
	return value
}

function text(value, max, name) {
	if (typeof value !== 'string' || value.length > max) fail('Invalid ' + name)
	return value
}

function id(value) {
	if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('Invalid id')
	return value
}

function color(value) {
	if (typeof value !== 'string' || !/^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|transparent|[a-z]{1,24}|rgba?\([\d.,% ]{1,60}\)|hsla?\([\d.,% ]{1,60}\))$/i.test(value)) fail('Invalid color')
	return value
}

function originAllowed(req) {
	if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true
	if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return false
	const supplied = req.headers.origin || req.headers.referer
	if (!supplied) return !req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin'
	try {
		const expected = process.env.FLIPVIO_ORIGIN ? new URL(process.env.FLIPVIO_ORIGIN).origin : new URL((require('./auth').secure(req) ? 'https://' : 'http://') + req.headers.host).origin
		return new URL(supplied).origin === expected
	} catch { return false }
}

module.exports = { fail, publicSlug, safeJoin, assetPath, ownedUrl, safeLink, object, number, text, id, color, originAllowed, MEDIA }
