const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { fail, publicSlug } = require('./validation')

function nameKey(name) {
	return name.normalize('NFC').toLowerCase().normalize('NFC')
}

function namesOf(book) {
	return [...new Set([book.slug, book.publicSlug || book.slug, ...(book.publicSlugAliases || [])])]
}

class JsonDb {
	constructor(file) {
		this.file = file
		try {
			this.data = JSON.parse(fs.readFileSync(file, 'utf8'))
			if (!this.data || !Array.isArray(this.data.books)) throw new Error('Invalid database schema')
		} catch (error) {
			if (error.code !== 'ENOENT') throw new Error('Cannot read database; refusing to overwrite existing data', { cause: error })
			this.data = { books: [] }
			this.save()
		}
	}
	save(data = this.data) {
		fs.mkdirSync(path.dirname(this.file), { recursive: true })
		const temp = this.file + '.' + crypto.randomUUID() + '.tmp'
		try {
			const fd = fs.openSync(temp, 'wx', 0o600)
			try {
				fs.writeFileSync(fd, JSON.stringify(data, null, 2))
				fs.fsyncSync(fd)
			} finally { fs.closeSync(fd) }
			fs.renameSync(temp, this.file)
			this.data = data
		} finally {
			fs.rmSync(temp, { force: true })
		}
	}
	list() {
		return this.data.books
	}
	get(slug) {
		return this.data.books.find((book) => book.slug === slug) || null
	}
	resolve(name) {
		const key = nameKey(name)
		return this.get(name) || this.data.books.find((book) => namesOf(book).some((name) => nameKey(name) === key)) || null
	}
	assertAvailable(name, ownerSlug) {
		const key = nameKey(name)
		if ((this.data.reservedPublicSlugs || []).some((name) => nameKey(name) === key) || this.data.books.some((book) => book.slug !== ownerSlug && namesOf(book).some((name) => nameKey(name) === key))) {
			fail('This public URL name is already in use; choose another name', 409)
		}
	}
	insert(book) {
		const next = { ...book, publicSlug: book.publicSlug === undefined ? book.slug : publicSlug(book.publicSlug), publicSlugAliases: [...(book.publicSlugAliases || [])] }
		for (const name of namesOf(next)) this.assertAvailable(name)
		this.save({ ...this.data, books: [next, ...this.data.books] })
		return next
	}
	update(slug, patch) {
		const book = this.get(slug)
		if (!book) return null
		if (Object.hasOwn(patch, 'slug') && patch.slug !== slug) fail('Publication storage ID cannot be changed')
		const name = patch.publicSlug === undefined ? book.publicSlug || slug : publicSlug(patch.publicSlug)
		if (patch.publicSlug !== undefined) this.assertAvailable(name, slug)
		const aliases = [...new Set([...(book.publicSlugAliases || []), ...(name !== (book.publicSlug || slug) ? [book.publicSlug || slug] : [])])]
		const next = { ...book, ...patch, slug, publicSlug: name, publicSlugAliases: aliases, updatedAt: Date.now() }
		this.save({ ...this.data, books: this.data.books.map((entry) => entry.slug === slug ? next : entry) })
		return next
	}
	remove(slug) {
		const book = this.get(slug)
		const reservedPublicSlugs = [...new Set([...(this.data.reservedPublicSlugs || []), ...(book ? namesOf(book) : [])])]
		this.save({ ...this.data, reservedPublicSlugs, books: this.data.books.filter((book) => book.slug !== slug) })
	}
}

module.exports = { JsonDb }
