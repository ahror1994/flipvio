const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SESSION_IDLE_MS = 30 * 60 * 1000
const COOKIE = 'fv_session'
const sessions = new Map()
const fails = new Map()
let owner

function passwordRecord(user, password) {
	const salt = crypto.randomBytes(32).toString('hex')
	return { user, algorithm: 'scrypt', salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') }
}

function initialize(storageDir) {
	const file = process.env.FLIPVIO_AUTH_FILE || path.join(__dirname, '..', '.owner.json')
	try {
		owner = JSON.parse(fs.readFileSync(file, 'utf8'))
	} catch (error) {
		if (error.code !== 'ENOENT') throw new Error('Invalid owner credentials file; refusing to overwrite it')
		if (!process.env.ADMIN_PASS || process.env.ADMIN_PASS.length < 12) throw new Error('Configure ADMIN_PASS (12+ characters) once or provide FLIPVIO_AUTH_FILE')
		owner = passwordRecord(process.env.ADMIN_USER || 'SuperAdmin', process.env.ADMIN_PASS)
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, JSON.stringify(owner, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
	}
	delete process.env.ADMIN_PASS
	if (owner.algorithm !== 'scrypt' || typeof owner.user !== 'string' || !owner.user || !/^[a-f0-9]{64}$/.test(owner.salt) || !/^[a-f0-9]{128}$/.test(owner.hash)) {
		throw new Error('Invalid owner credentials file; refusing to overwrite it')
	}
	fs.chmodSync(file, 0o600)
	return owner.user
}

function createSession() {
	const now = Date.now()
	for (const [key, session] of sessions) if (session.expires <= now || session.idleExpires <= now) sessions.delete(key)
	if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value)
	const token = crypto.randomBytes(32).toString('hex')
	sessions.set(token, { expires: now + SESSION_TTL_MS, idleExpires: now + SESSION_IDLE_MS })
	return token
}

function sessionFromCookie(cookieHeader) {
	if (typeof cookieHeader !== 'string') return null
	const match = ('; ' + cookieHeader).match(/;\s*fv_session=([a-f0-9]{64})(?:;|$)/)
	if (!match) return null
	const session = sessions.get(match[1])
	const now = Date.now()
	if (!session || now >= session.expires || now >= session.idleExpires) {
		sessions.delete(match[1])
		return null
	}
	session.idleExpires = now + SESSION_IDLE_MS
	return match[1]
}

function dropSession(token) {
	sessions.delete(token)
}

function isLocked(ip) {
	const f = fails.get(ip)
	return !!(f && f.until > Date.now())
}

function loginAttempt(ip, ok) {
	const now = Date.now()
	for (const [key, value] of fails) if (value.expires <= now) fails.delete(key)
	if (ok) {
		fails.delete(ip)
		return { locked: false }
	}
	if (fails.size >= 10000 && !fails.has(ip)) fails.delete(fails.keys().next().value)
	const f = fails.get(ip) || { n: 0, until: 0 }
	f.n++
	f.expires = now + 600000
	if (f.n >= 5) {
		f.until = now + 60000
		f.n = 0
	}
	fails.set(ip, f)
	return { locked: f.until > now }
}

function checkCredentials(user, password) {
	if (!owner || typeof user !== 'string' || typeof password !== 'string' || password.length > 1024) return false
	const actual = crypto.scryptSync(password, owner.salt, 64)
	const valid = crypto.timingSafeEqual(actual, Buffer.from(owner.hash, 'hex'))
	return valid && user === owner.user
}

function secure(req) {
	return process.env.COOKIE_SECURE === '1' || !!req?.socket.encrypted || (process.env.TRUST_PROXY === '1' && req?.headers['x-forwarded-proto'] === 'https')
}

function sessionCookie(token, req) {
	return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure(req) ? '; Secure' : ''}`
}

function clearCookie(req) {
	return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure(req) ? '; Secure' : ''}`
}

module.exports = { COOKIE, initialize, passwordRecord, createSession, sessionFromCookie, dropSession, loginAttempt, isLocked, checkCredentials, sessionCookie, clearCookie, secure }
