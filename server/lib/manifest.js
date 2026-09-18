const crypto = require('crypto')
const v = require('./validation')

const DEFAULT_SETTINGS = {
	flipSound: true,
	flipDuration: 800,
	hardCover: true,
	rtl: false,
	singlePageMode: 'auto',
	bgColor: '#2b2b2b',
	bgColor2: '#161616',
	accent: '#1e40af',
	showThumbnails: true,
	allowDownload: true,
	allowPrint: true,
	autoFlipSeconds: 0,
	backgroundImage: null,
	logoUrl: null,
	logoLink: null,
	logoWidth: 120,
}

function pagesOf(book) {
	const reserved = new Set((book.pages || []).map((p) => p.id).filter(Boolean))
	return (book.pages || []).map((page, i) => {
		let pageId = page.id
		if (!pageId) {
			pageId = 'page-' + (i + 1)
			while (reserved.has(pageId)) pageId += '-legacy'
			reserved.add(pageId)
		}
		return { ...page, id: pageId, index: i + 1, normal: page.normal ?? null, thumb: page.thumb ?? null, large: page.large ?? null, background: page.background || '#ffffff', elements: page.elements || [] }
	})
}

function bookManifest(book) {
	const pages = pagesOf(book)
	const toc = (book.toc || []).map((entry, i) => ({
		id: entry.id || 'toc-' + (i + 1),
		title: entry.title || '',
		pageId: entry.pageId || pages[Number(entry.page || entry.pageNumber || 1) - 1]?.id,
	})).filter((entry) => pages.some((page) => page.id === entry.pageId))
	return {
		slug: book.slug, publicSlug: book.publicSlug || book.slug, url: '/b/' + encodeURIComponent(book.publicSlug || book.slug), title: book.title, pageCount: pages.length, page: book.page,
		pages, pdfUrl: book.pdfUrl || null, createdAt: book.createdAt, updatedAt: book.updatedAt,
		published: book.published !== false, toc,
		settings: { ...DEFAULT_SETTINGS, ...(book.settings || {}) },
		links: book.links || [], sfx: { flip: ['/assets/sfx/flip.mp3'], hard: null },
	}
}

function validateElement(value, storage, slug) {
	v.object(value, 'element')
	const types = ['link', 'text', 'image', 'button', 'shape', 'gif', 'video', 'audio']
	if (!types.includes(value.type)) v.fail('Invalid element type')
	const result = { id: v.id(value.id), type: value.type }
	for (const key of ['x', 'y', 'w', 'h']) result[key] = v.number(value[key], 0, 1, key)
	for (const key of ['text', 'url', 'src', 'color', 'background', 'fontSize', 'borderRadius', 'shape', 'points', 'opacity', 'objectFit', 'crop']) {
		if (value[key] === undefined) continue
		switch (key) {
			case 'text': result[key] = v.text(value[key], 20000, key); break
			case 'url': result[key] = v.safeLink(value[key]); break
			case 'src': result[key] = v.ownedUrl(storage, slug, value[key], ['image', 'gif'].includes(value.type)); break
			case 'color': case 'background': result[key] = v.color(value[key]); break
			case 'fontSize': result[key] = v.number(value[key], 1, 500, key); break
			case 'borderRadius': result[key] = v.number(value[key], 0, 1000, key); break
			case 'opacity': result[key] = v.number(value[key], 0, 1, key); break
			case 'shape':
				if (!['rect', 'ellipse', 'polygon'].includes(value[key])) v.fail('Invalid shape')
				result[key] = value[key]
				break
			case 'objectFit':
				if (!['contain', 'cover', 'fill', 'none', 'scale-down'].includes(value[key])) v.fail('Invalid objectFit')
				result[key] = value[key]
				break
			case 'points':
				if (!Array.isArray(value[key]) || value[key].length < 3 || value[key].length > 100) v.fail('Invalid polygon points')
				result[key] = value[key].map((point) => {
					v.object(point, 'point')
					return { x: v.number(point.x, 0, 1, 'point.x'), y: v.number(point.y, 0, 1, 'point.y') }
				})
				break
			case 'crop':
				if (value[key] === null) break
				v.object(value[key], 'crop')
				result[key] = { x: v.number(value[key].x, 0, 1, 'crop.x'), y: v.number(value[key].y, 0, 1, 'crop.y'), zoom: v.number(value[key].zoom, 1, 20, 'crop.zoom') }
				break
		}
	}
	return result
}

function validatePatch(book, patch, storage) {
	v.object(patch, 'patch')
	const next = {}
	if (patch.publicSlug !== undefined) next.publicSlug = v.publicSlug(patch.publicSlug)
	if (patch.title !== undefined) {
		next.title = v.text(patch.title, 300, 'title').trim()
		if (!next.title) v.fail('Title is required')
	}
	if (patch.published !== undefined) {
		if (typeof patch.published !== 'boolean') v.fail('published must be boolean')
		next.published = patch.published
	}
	if (patch.settings !== undefined) {
		v.object(patch.settings, 'settings')
		next.settings = { ...book.settings }
		for (const [key, value] of Object.entries(patch.settings)) {
			if (!Object.hasOwn(DEFAULT_SETTINGS, key)) v.fail('Unknown setting: ' + key)
			if (typeof DEFAULT_SETTINGS[key] === 'boolean') {
				if (typeof value !== 'boolean') v.fail('Invalid setting: ' + key)
				next.settings[key] = value
			} else if (['bgColor', 'bgColor2', 'accent'].includes(key)) next.settings[key] = v.color(value)
			else if (['backgroundImage', 'logoUrl'].includes(key)) next.settings[key] = v.ownedUrl(storage, book.slug, value, true)
			else if (key === 'logoLink') next.settings[key] = v.safeLink(value)
			else if (key === 'singlePageMode') {
				if (!['auto', 'always', 'never'].includes(value)) v.fail('Invalid singlePageMode')
				next.settings[key] = value
			} else {
				const ranges = { flipDuration: [100, 5000], autoFlipSeconds: [0, 3600], logoWidth: [0, 1000] }
				next.settings[key] = v.number(value, ...ranges[key], key)
			}
		}
	}
	const previous = pagesOf(book)
	if (patch.pages !== undefined) {
		if (!Array.isArray(patch.pages) || patch.pages.length > 1000) v.fail('pages must contain at most 1000 pages')
		const ids = new Set()
		const elementIds = new Set()
		next.pages = patch.pages.map((page, i) => {
			v.object(page, 'page')
			const pageId = page.id === undefined ? 'page-' + crypto.randomUUID() : v.id(page.id)
			if (ids.has(pageId)) v.fail('Duplicate page id')
			ids.add(pageId)
			const old = previous.find((p) => p.id === pageId)
			const result = { ...(old || {}), id: pageId, index: i + 1 }
			for (const key of ['normal', 'thumb', 'large']) {
				result[key] = page[key] === undefined ? old?.[key] ?? null : v.ownedUrl(storage, book.slug, page[key], true)
			}
			result.background = page.background === undefined ? old?.background || '#ffffff' : v.color(page.background)
			const elements = page.elements === undefined ? old?.elements || [] : page.elements
			if (!Array.isArray(elements) || elements.length > 200) v.fail('Too many elements')
			result.elements = elements.map((element) => {
				const normalized = validateElement(element, storage, book.slug)
				if (elementIds.has(normalized.id)) v.fail('Duplicate element id')
				elementIds.add(normalized.id)
				return normalized
			})
			return result
		})
		next.pageCount = next.pages.length
	}
	const pages = next.pages || previous
	if (patch.toc !== undefined) {
		if (!Array.isArray(patch.toc) || patch.toc.length > 1000) v.fail('Invalid toc')
		const ids = new Set()
		next.toc = patch.toc.map((entry) => {
			v.object(entry, 'toc entry')
			const result = { id: v.id(entry.id), title: v.text(entry.title, 300, 'toc title'), pageId: v.id(entry.pageId) }
			if (ids.has(result.id) || !pages.some((page) => page.id === result.pageId)) v.fail('Invalid toc reference or duplicate id')
			ids.add(result.id)
			return result
		})
	} else if (next.pages) next.toc = bookManifest(book).toc.filter((entry) => pages.some((page) => page.id === entry.pageId))
	return next
}

module.exports = { DEFAULT_SETTINGS, pagesOf, bookManifest, validatePatch }
