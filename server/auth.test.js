const test = require('node:test')
const assert = require('node:assert/strict')
const auth = require('./lib/auth')

const MINUTE = 60 * 1000
const WEEK = 7 * 24 * 60 * MINUTE

function clock(t) {
	let now = 1000000000
	t.mock.method(Date, 'now', () => now)
	return (elapsed) => { now += elapsed }
}

function session(t) {
	const token = auth.createSession()
	t.after(() => auth.dropSession(token))
	return { token, cookie: `${auth.COOKIE}=${token}` }
}

test('sessions expire at exactly thirty idle minutes and cannot be revived', (t) => {
	const advance = clock(t)
	const { cookie } = session(t)
	advance(30 * MINUTE)
	assert.equal(auth.sessionFromCookie(cookie), null)
	advance(-MINUTE)
	assert.equal(auth.sessionFromCookie(cookie), null)
})

test('valid session activity renews the idle deadline', (t) => {
	const advance = clock(t)
	const { token, cookie } = session(t)
	advance(29 * MINUTE)
	assert.equal(auth.sessionFromCookie(cookie), token)
	advance(29 * MINUTE)
	assert.equal(auth.sessionFromCookie(cookie), token)
	advance(30 * MINUTE)
	assert.equal(auth.sessionFromCookie(cookie), null)
})

test('activity cannot extend the seven day absolute deadline', (t) => {
	const advance = clock(t)
	const { token, cookie } = session(t)
	for (let elapsed = 15 * MINUTE; elapsed < WEEK; elapsed += 15 * MINUTE) {
		advance(15 * MINUTE)
		assert.equal(auth.sessionFromCookie(cookie), token)
	}
	advance(15 * MINUTE - 1)
	assert.equal(auth.sessionFromCookie(cookie), token)
	advance(1)
	assert.equal(auth.sessionFromCookie(cookie), null)
})

test('session creation prunes expired sessions and logout invalidates tokens', (t) => {
	const advance = clock(t)
	const first = session(t)
	advance(30 * MINUTE)
	const second = session(t)
	advance(-MINUTE)
	assert.equal(auth.sessionFromCookie(first.cookie), null)
	assert.equal(auth.sessionFromCookie(second.cookie), second.token)
	auth.dropSession(second.token)
	assert.equal(auth.sessionFromCookie(second.cookie), null)
	assert.equal(auth.sessionFromCookie(undefined), null)
	assert.equal(auth.sessionFromCookie(`${auth.COOKIE}=invalid`), null)
	assert.equal(auth.sessionFromCookie(`${auth.COOKIE}=${'a'.repeat(64)}`), null)
})
