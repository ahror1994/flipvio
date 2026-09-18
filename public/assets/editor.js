const $ = (selector) => document.querySelector(selector)
let slug = new URLSearchParams(location.search).get('slug') || ''
let endpoint = '/api/books/' + encodeURIComponent(slug)
const publicPath = (book) => book.url || '/b/' + encodeURIComponent(book.publicSlug || book.slug)
const normalizePublicSlug = (value) => value.trim().normalize('NFC').toLowerCase().normalize('NFC')

function publicSlugError(value) {
	const name = normalizePublicSlug(value)
	if (/[\p{Cc}\p{Cf}]/u.test(value)) return 'Название в ссылке не должно содержать управляющие символы.'
	if ([...name].length < 2 || [...name].length > 80) return 'Название в ссылке должно содержать 2–80 символов.'
	if (!/^[\p{Script=Latin}\p{Script=Cyrillic}0-9-]+$/u.test(name) || !/^[\p{L}0-9-]+$/u.test(name) || /^-|-$/.test(name)) return 'Используйте латиницу, кириллицу, цифры и дефисы только внутри названия.'
	return ''
}
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const copy = (value) => JSON.parse(JSON.stringify(value))
const uid = (prefix) => prefix + '-' + crypto.randomUUID()
const state = { book: null, pageId: null, elementId: null, undo: [], redo: [], saved: '', busy: false, crop: false, gesture: null, editKey: null }
const page = () => state.book?.pages.find((item) => item.id === state.pageId)
const selected = () => page()?.elements.find((item) => item.id === state.elementId)
const payload = () => ({ title: state.book.title, publicSlug: state.book.publicSlug, published: state.book.published, settings: state.book.settings, toc: state.book.toc, pages: state.book.pages })
const snapshot = () => JSON.stringify(payload())
const dirty = () => state.book && snapshot() !== state.saved
const mediaTypes = ['image', 'gif', 'video', 'audio']
const typeLabels = { link: 'Ссылка', text: 'Текст', image: 'Изображение', button: 'Кнопка', shape: 'Фигура', gif: 'GIF', video: 'Видео', audio: 'Аудио' }
const choices = (items) => Object.entries(items).map(([value, label]) => ({ value, label }))
let pageDrag = null
let suppressNextListClick = false
let suppressClickTimer = 0

function node(tag, className, text) {
	const item = document.createElement(tag)
	if (className) item.className = className
	if (text !== undefined) item.textContent = text
	return item
}

function button(text, action, disabled = false) {
	const item = node('button', '', text)
	item.type = 'button'
	item.disabled = disabled
	item.onclick = action
	return item
}

function message(error = '') {
	const text = error instanceof Error ? error.message : error
	$('#message').textContent = /[а-яё]/i.test(text) ? text : text ? 'Не удалось выполнить действие. Проверьте подключение и введённые данные, затем повторите попытку.' : ''
	$('#message').hidden = !error
}

async function request(url, options) {
	let response
	try { response = await fetch(url, options) } catch { throw new Error('Нет связи с сервером. Проверьте подключение и повторите попытку. Изменения не потеряны.') }
	const data = await response.json().catch(() => ({}))
	if (response.status === 401) throw new Error('Сеанс истёк. Войдите как администратор в другой вкладке и повторите попытку. Несохранённые изменения остаются здесь.')
	if (!response.ok) {
		const errors = { 403: 'Доступ запрещён. Проверьте права доступа.', 404: 'Книга или файл не найдены.', 409: 'Конфликт изменений или занятое название в ссылке. Проверьте данные и повторите попытку.', 413: 'Файл слишком большой.', 415: 'Этот тип файла не поддерживается.', 429: 'Сервер занят. Повторите попытку позже.' }
		throw new Error(errors[response.status] || (response.status >= 500 ? 'Ошибка сервера. Повторите попытку позже.' : 'Не удалось сохранить данные. Проверьте свойства, ссылки и загружаемые файлы.'))
	}
	return data
}

function updateStatus() {
	$('#saveState').textContent = state.busy ? 'Выполняется…' : dirty() ? 'Есть несохранённые изменения' : 'Сохранено · ' + (state.book?.published ? 'Опубликовано' : 'Черновик')
	$('#saveState').classList.toggle('dirty', Boolean(dirty()))
	$('#undo').disabled = state.busy || !state.undo.length
	$('#redo').disabled = state.busy || !state.redo.length
	$('#save').disabled = state.busy || !state.book
	$('#preview').disabled = state.busy || !state.book
	$('#bookTitle').textContent = state.book?.title || 'Редактор'
	document.title = (state.book?.title || 'Flipvio') + ' — Редактор'
}

function remember(before) {
	if (before === snapshot()) return
	state.undo.push(before)
	if (state.undo.length > 100) state.undo.shift()
	state.redo = []
}

function change(action, refresh = true, key = null) {
	if (state.busy || !state.book) return
	const before = snapshot()
	action()
	if (!key || state.editKey !== key) remember(before)
	else if (before !== snapshot()) state.redo = []
	state.editKey = key
	if (refresh) render()
	else { renderCanvas(); renderLayers(); updateStatus() }
}

function historyStep(redo = false) {
	if (state.busy || state.gesture) return
	document.activeElement?.blur()
	const from = redo ? state.redo : state.undo
	const to = redo ? state.undo : state.redo
	if (!from.length) return
	to.push(snapshot())
	Object.assign(state.book, JSON.parse(from.pop()))
	state.editKey = null
	render()
}

function safeLink(value) {
	if (!value) return true
	if (/[\s\x00-\x1f\x7f\\]/.test(value)) return false
	if (/^#[a-zA-Z0-9_=.-]+$/.test(value) || /^\/(?!\/)/.test(value)) return true
	try {
		const url = new URL(value)
		return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) && !url.username && !url.password
	} catch { return false }
}

function assetUrl(value) {
	if (!value) return null
	try {
		const url = new URL(value, location.origin)
		return url.origin === location.origin && decodeURIComponent(url.pathname).startsWith('/storage/' + slug + '/') ? url.href : null
	} catch { return null }
}

function field(parent, label, value, onChange, options = {}) {
	const wrapper = node('label', 'field' + (options.type === 'checkbox' ? ' check' : ''))
	const caption = node('span', '', label)
	const input = node(options.choices ? 'select' : options.type === 'textarea' ? 'textarea' : 'input')
	if (input.tagName === 'INPUT') input.type = options.type || 'text'
	if (options.choices) for (const choice of options.choices) {
		const option = node('option', '', typeof choice === 'string' ? choice : choice.label)
		option.value = typeof choice === 'string' ? choice : choice.value
		input.append(option)
	}
	for (const key of ['min', 'max', 'step', 'maxLength', 'accept']) if (options[key] !== undefined) input[key] = options[key]
	input.dataset.field = options.key || label
	if (options.type === 'checkbox') input.checked = Boolean(value)
	else input.value = value ?? ''
	const output = options.type === 'range' ? node('output', '', input.value) : null
	input.addEventListener(options.choices || options.type === 'checkbox' ? 'change' : 'input', () => {
		let next = options.type === 'checkbox' ? input.checked : ['number', 'range'].includes(options.type) ? input.valueAsNumber : input.value
		input.setCustomValidity('')
		if (options.link && !safeLink(next)) input.setCustomValidity('Укажите безопасный адрес сайта, почты, телефона или локальный путь.')
		if (!input.validity.valid && !input.validity.customError) input.setCustomValidity('Проверьте значение поля «' + label + '»' + (options.min !== undefined ? ': допустимо от ' + options.min + ' до ' + options.max : '') + '.')
		if (!input.checkValidity() || (typeof next === 'number' && !Number.isFinite(next))) return
		if (output) output.textContent = String(next)
		onChange(next, input)
	})
	input.addEventListener('blur', () => { state.editKey = null })
	wrapper.append(caption, input)
	if (output) wrapper.append(output)
	parent.append(wrapper)
	return input
}

function colorField(parent, label, value, onChange) {
	const wrapper = node('div', 'field')
	wrapper.append(node('span', '', label))
	const row = node('div', 'row')
	const picker = node('input')
	picker.type = 'color'
	picker.value = /^#[a-f\d]{6}$/i.test(value || '') ? value : '#ffffff'
	picker.setAttribute('aria-label', label + ' — выбор цвета')
	const text = node('input')
	text.type = 'text'
	text.value = !value || value === 'transparent' ? 'Прозрачный' : value
	text.dataset.field = label
	text.setAttribute('aria-label', label)
	picker.oninput = () => { text.value = picker.value; text.setCustomValidity(''); onChange(picker.value) }
	text.oninput = () => {
		const next = text.value.trim().toLowerCase() === 'прозрачный' ? 'transparent' : text.value
		const valid = CSS.supports('color', next) && /^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|transparent|[a-z]{1,24}|rgba?\([\d.,% ]{1,60}\)|hsla?\([\d.,% ]{1,60}\))$/i.test(next)
		text.setCustomValidity(valid ? '' : 'Введите код цвета или «Прозрачный».')
		if (valid) onChange(next)
	}
	for (const input of [picker, text]) input.onblur = () => { state.editKey = null }
	row.append(picker, text)
	wrapper.append(row)
	parent.append(wrapper)
}

async function withBusy(action) {
	if (state.busy) return
	state.busy = true
	$('#workspace').disabled = true
	updateStatus()
	message()
	try { return await action() } catch (error) { message(error); return false } finally {
		state.busy = false
		$('#workspace').disabled = !state.book
		updateStatus()
	}
}

function validInputs() {
	for (const input of document.querySelectorAll('input, textarea, select')) {
		if (!input.checkValidity()) { input.reportValidity(); return false }
	}
	return true
}

async function persist() {
	if (!state.book.title.trim()) throw new Error('Укажите название книги.')
	const error = publicSlugError(state.book.publicSlug)
	if (error) throw new Error(error)
	const updated = await request(endpoint, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: snapshot() })
	state.book = updated
	state.saved = snapshot()
	state.editKey = null
	render()
	return true
}

async function save() {
	document.activeElement?.blur()
	if (!state.book || !validInputs()) return false
	return withBusy(persist)
}

function assetControl(parent, label, value, accept, onUpload, onClear) {
	const wrapper = node('div', 'field')
	wrapper.append(node('span', '', label))
	if (value) wrapper.append(node('span', 'asset-name', value.split('/').pop()))
	const input = node('input')
	input.type = 'file'
	input.accept = accept
	input.hidden = true
	input.setAttribute('aria-label', label + ' — загрузка')
	input.onchange = async () => {
		const file = input.files[0]
		if (!file) return
		await withBusy(async () => {
			const body = new FormData()
			body.append('file', file)
			const result = await request(endpoint + '/assets', { method: 'POST', body })
			const before = snapshot()
			onUpload(result)
			remember(before)
			render()
		})
		input.value = ''
	}
	wrapper.append(input, button('Выбрать файл', () => input.click()), node('span', 'hint', 'Форматы: ' + accept.replaceAll('.', '').toUpperCase()))
	if (value) wrapper.append(button('Очистить', onClear))
	parent.append(wrapper)
}

function renderSettings() {
	const root = $('#settings')
	root.replaceChildren()
	field(root, 'Название книги', state.book.title, (value) => change(() => { state.book.title = value }, false, 'title'), { maxLength: 300, key: 'title' })
	const preview = node('p', 'hint')
	preview.id = 'publicLinkPreview'
	const updateLink = (input) => {
		const error = publicSlugError(input.value)
		input.setCustomValidity(error)
		const savedName = state.saved && JSON.parse(state.saved).publicSlug
		const path = input.value === savedName ? publicPath(state.book) : '/b/' + encodeURIComponent(normalizePublicSlug(input.value))
		preview.textContent = error || new URL(path, location.origin).href
	}
	const publicSlug = field(root, 'Название в ссылке', state.book.publicSlug, (value, input) => {
		change(() => { state.book.publicSlug = value }, false, 'publicSlug')
		updateLink(input)
	}, { key: 'publicSlug' })
	publicSlug.autocomplete = 'off'
	publicSlug.spellcheck = false
	publicSlug.setAttribute('aria-describedby', 'publicLinkPreview publicLinkHint')
	updateLink(publicSlug)
	const hint = node('p', 'hint', 'Не меняет название книги. 2–80 букв латиницы или кириллицы, цифры и дефисы внутри. Старые ссылки продолжат работать после сохранения.')
	hint.id = 'publicLinkHint'
	root.append(preview, hint)
	field(root, 'Опубликовано', state.book.published, (value) => change(() => { state.book.published = value }, false), { type: 'checkbox' })
	const settings = state.book.settings
	const set = (key, value) => change(() => { settings[key] = value }, false, 'settings-' + key)
	for (const [key, label] of [['bgColor', 'Фон сверху'], ['bgColor2', 'Фон снизу'], ['accent', 'Акцентный цвет']]) colorField(root, label, settings[key], (value) => set(key, value))
	for (const [key, label] of [['backgroundImage', 'Фоновое изображение'], ['logoUrl', 'Логотип']]) assetControl(root, label, settings[key], '.png,.jpg,.jpeg,.webp,.gif', (result) => {
		if (!['image', 'gif'].includes(result.type)) throw new Error('Выберите изображение.')
		settings[key] = result.url
	}, () => change(() => { settings[key] = null }))
	field(root, 'Ссылка логотипа', settings.logoLink, (value) => set('logoLink', value || null), { link: true, maxLength: 2048 })
	for (const [key, label, min, max] of [['logoWidth', 'Ширина логотипа, пикс.', 0, 1000], ['flipDuration', 'Длительность перелистывания, мс', 100, 5000], ['autoFlipSeconds', 'Автоперелистывание, сек. (0 — выключено)', 0, 3600]]) field(root, label, settings[key], (value) => set(key, value), { type: 'number', min, max, step: 1 })
	field(root, 'Одностраничный режим', settings.singlePageMode, (value) => set('singlePageMode', value), { choices: choices({ auto: 'Автоматически', always: 'Всегда', never: 'Никогда' }) })
	for (const [key, label] of [['flipSound', 'Звук перелистывания'], ['hardCover', 'Твёрдая обложка'], ['rtl', 'Справа налево'], ['showThumbnails', 'Показывать миниатюры'], ['allowDownload', 'Разрешить скачивание'], ['allowPrint', 'Разрешить печать']]) field(root, label, settings[key], (value) => set(key, value), { type: 'checkbox' })
}

function renderProperties() {
	const root = $('#properties')
	root.replaceChildren()
	const element = selected()
	if (!element) { root.append(node('p', 'hint', 'Выберите элемент на странице.')); return }
	root.append(node('strong', '', typeLabels[element.type]))
	const set = (key, value, refresh = false) => change(() => { element[key] = value }, refresh, element.id + '-' + key)
	const geometry = node('div', 'geometry')
	root.append(geometry)
	for (const key of ['x', 'y', 'w', 'h']) field(geometry, { x: 'Слева', y: 'Сверху', w: 'Ширина', h: 'Высота' }[key], element[key], (value, input) => {
		change(() => {
			element[key] = clamp(value, key === 'w' || key === 'h' ? .001 : 0)
			if (key === 'x') element.x = Math.min(element.x, 1 - element.w)
			if (key === 'y') element.y = Math.min(element.y, 1 - element.h)
			if (key === 'w') element.w = Math.min(element.w, 1 - element.x)
			if (key === 'h') element.h = Math.min(element.h, 1 - element.y)
		}, false, element.id + '-' + key)
		input.value = element[key]
	}, { type: 'number', min: 0, max: 1, step: 'any' })
	if (['link', 'text', 'button'].includes(element.type)) field(root, 'Текст', element.text || '', (value) => set('text', value), { type: 'textarea', maxLength: 20000 })
	if (element.type !== 'shape') field(root, 'Адрес ссылки', element.url, (value) => set('url', value || null), { link: true, maxLength: 2048 })
	if (mediaTypes.includes(element.type)) {
		assetControl(root, 'Медиафайл', element.src, element.type === 'audio' ? '.mp3,.wav,.ogg' : element.type === 'video' ? '.mp4,.webm' : '.png,.jpg,.jpeg,.webp,.gif', (result) => {
			const allowed = ['image', 'gif'].includes(element.type) ? ['image', 'gif'] : [element.type]
			if (!allowed.includes(result.type)) throw new Error('Выберите совместимый медиафайл для этого элемента.')
			element.src = result.url
			if (['image', 'gif'].includes(element.type)) element.type = result.type
		}, () => change(() => { element.src = null }))
		field(root, 'Размещение', element.objectFit || 'contain', (value) => set('objectFit', value), { choices: choices({ contain: 'Вписать целиком', cover: 'Заполнить с обрезкой', fill: 'Растянуть', none: 'Исходный размер', 'scale-down': 'Уменьшить при необходимости' }) })
		if (element.type !== 'audio') {
			for (const [key, max] of [['x', 1], ['y', 1], ['zoom', 20]]) field(root, { x: 'Кадрирование по горизонтали', y: 'Кадрирование по вертикали', zoom: 'Масштаб кадрирования' }[key], element.crop?.[key] ?? (key === 'zoom' ? 1 : .5), (value) => change(() => {
				element.crop = { x: .5, y: .5, zoom: 1, ...element.crop, [key]: value }
			}, false, element.id + '-crop-' + key), { type: 'range', min: key === 'zoom' ? 1 : 0, max, step: .01 })
			root.append(button('Сбросить кадрирование', () => change(() => { delete element.crop })))
		}
	}
	colorField(root, 'Цвет', element.color || '#000000', (value) => set('color', value))
	colorField(root, 'Фон', element.background || 'transparent', (value) => set('background', value))
	if (element.type === 'link') field(root, 'Невидимая ссылка', element.background === 'transparent' && !element.text, (value) => change(() => {
		element.background = value ? 'transparent' : '#1e40af'
		if (value) element.text = ''
	}), { type: 'checkbox' })
	if (['text', 'link', 'button'].includes(element.type)) field(root, 'Размер шрифта, пикс.', element.fontSize || 16, (value) => set('fontSize', value), { type: 'number', min: 1, max: 500 })
	field(root, 'Скругление углов, пикс.', element.borderRadius || 0, (value) => set('borderRadius', value), { type: 'number', min: 0, max: 1000 })
	field(root, 'Непрозрачность', element.opacity ?? 1, (value) => set('opacity', value), { type: 'range', min: 0, max: 1, step: .01 })
	if (['shape', 'button'].includes(element.type)) {
		field(root, 'Фигура', element.shape || 'rect', (value) => change(() => {
			element.shape = value
			if (value === 'polygon' && !element.points) element.points = [{ x: .5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
		}), { choices: choices({ rect: 'Прямоугольник', ellipse: 'Эллипс', polygon: 'Многоугольник' }) })
		if (element.shape === 'polygon') root.append(node('p', 'hint', 'Перетаскивайте вершины. Двойной щелчок добавляет вершину у ближайшего ребра. Щелчок с клавишей Alt удаляет вершину (минимум 3).'))
	}
}

function sectionRanges() {
	const positions = new Map(state.book.pages.map((item, index) => [item.id, index]))
	const entries = state.book.toc.map((entry) => ({ entry, start: positions.get(entry.pageId) })).filter((item) => item.start !== undefined).sort((a, b) => a.start - b.start)
	const starts = [...new Set(entries.map((item) => item.start))]
	return entries.map((item) => ({ ...item, end: (starts[starts.indexOf(item.start) + 1] ?? state.book.pages.length) - 1 }))
}

const sectionTitle = (entry) => entry.title.trim() || 'Без названия'
const rangeLabel = ({ start, end }) => start === end ? 'Страница ' + (start + 1) : 'Страницы ' + (start + 1) + '–' + (end + 1)
const pageDescription = (item) => item.elements.find((element) => element.text?.trim())?.text.trim().slice(0, 60) || (item.normal || item.thumb ? 'Изображение страницы' : 'Пустая страница')
const pageLabel = (item, index) => 'Страница ' + (index + 1) + ' — ' + pageDescription(item)

function pageSections(id, ranges = sectionRanges()) {
	const index = state.book.pages.findIndex((item) => item.id === id)
	return ranges.filter((item) => index >= item.start && index <= item.end)
}

function updateSectionIndicators() {
	const ranges = sectionRanges()
	for (const card of $('#pageList').children) {
		const owned = pageSections(card.dataset.pageId, ranges)
		const starts = owned.filter((item) => item.entry.pageId === card.dataset.pageId)
		card.classList.toggle('section-start', Boolean(starts.length))
		card.querySelector('.page-section').textContent = owned.length ? (starts.length ? 'Начало раздела: ' : 'Раздел: ') + owned.map((item) => sectionTitle(item.entry)).join('; ') : 'Без раздела'
	}
	for (const row of $('#tocList').children) {
		if (!row.dataset.tocId) continue
		const range = ranges.find((item) => item.entry.id === row.dataset.tocId)
		if (!range) continue
		const active = pageSections(state.pageId, ranges).some((item) => item.entry.id === range.entry.id)
		row.classList.toggle('current', active)
		const link = row.querySelector('.section-link')
		link.textContent = sectionTitle(range.entry) + ' · ' + rangeLabel(range)
		link.setAttribute('aria-label', 'Перейти к разделу «' + sectionTitle(range.entry) + '», ' + rangeLabel(range).toLowerCase())
		row.querySelector('.section-selected').textContent = active ? 'Текущая страница в этом разделе' : ''
		const preview = row.querySelector('.section-thumb')
		const start = state.book.pages[range.start]
		const url = assetUrl(start.thumb || start.normal)
		preview.hidden = !url
		if (url) preview.src = url
		else preview.removeAttribute('src')
		for (const option of row.querySelector('select').options) {
			const index = state.book.pages.findIndex((item) => item.id === option.value)
			const starts = ranges.filter((item) => item.start === index)
			option.textContent = pageLabel(state.book.pages[index], index) + (starts.length ? ' · Начало: ' + starts.map((item) => sectionTitle(item.entry)).join('; ') : '')
		}
	}
}

function renderPages() {
	const root = $('#pageList')
	root.replaceChildren()
	state.book.pages.forEach((item, index) => {
		const card = node('div', 'page-card' + (item.id === state.pageId ? ' current' : ''))
		card.dataset.pageId = item.id
		card.draggable = state.book.pages.length > 1
		const thumb = button('', () => selectPage(item.id))
		thumb.className = 'page-thumb'
		thumb.style.background = item.background || '#ffffff'
		thumb.setAttribute('aria-label', 'Выбрать: ' + pageLabel(item, index))
		thumb.setAttribute('aria-current', item.id === state.pageId ? 'page' : 'false')
		const url = assetUrl(item.thumb || item.normal)
		if (url) { const img = node('img'); img.src = url; img.alt = ''; img.loading = 'lazy'; img.draggable = false; thumb.append(img) }
		else thumb.append(node('span', '', 'Пустая'))
		const row = node('div', 'row')
		row.append(node('span', '', String(index + 1)), button('↑', () => movePage(index, -1), index === 0), button('↓', () => movePage(index, 1), index === state.book.pages.length - 1), button('×', () => {
			if (!confirm('Удалить страницу и разделы, которые начинаются на ней?')) return
			change(() => {
				state.book.pages.splice(index, 1)
				state.book.toc = state.book.toc.filter((entry) => entry.pageId !== item.id)
				if (state.pageId === item.id) state.pageId = state.book.pages[Math.min(index, state.book.pages.length - 1)]?.id
			})
		}))
		for (const [i, label] of [[1, 'Переместить страницу вверх'], [2, 'Переместить страницу вниз'], [3, 'Удалить страницу']]) {
			row.children[i].title = label
			row.children[i].setAttribute('aria-label', label + ' — ' + (index + 1))
		}
		const handle = button('↕ Переместить', () => {}, state.book.pages.length < 2)
		handle.className = 'page-drag-handle'
		handle.draggable = true
		handle.title = 'Перетащите страницу мышью; для клавиатуры используйте стрелки ниже'
		handle.setAttribute('aria-label', 'Перетащить страницу ' + (index + 1))
		handle.addEventListener('keydown', (event) => {
			if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return
			event.preventDefault()
			movePage(index, event.key === 'ArrowUp' ? -1 : 1)
		})
		card.append(handle, thumb, row, node('p', 'page-section'))
		root.append(card)
	})
	const props = $('#pageProperties')
	props.replaceChildren()
	const current = page()
	if (current) colorField(props, 'Фон страницы', current.background, (value) => change(() => { current.background = value }, false, current.id + '-background'))
	$('#addPage').disabled = state.book.pages.length >= 1000
}

function reorderPage(id, target) {
	if (state.busy || state.gesture) return
	const pages = state.book.pages
	const index = pages.findIndex((item) => item.id === id)
	if (index < 0 || target < 0 || target >= pages.length || target === index) return
	change(() => {
		const [item] = pages.splice(index, 1)
		pages.splice(target, 0, item)
		pages.forEach((item, i) => { item.index = i + 1 })
	})
	$('#pageMoveStatus').textContent = 'Страница перемещена с позиции ' + (index + 1) + ' на позицию ' + (target + 1) + '. Границы разделов обновлены.'
}

function movePage(index, direction) {
	const id = state.book.pages[index]?.id
	reorderPage(id, index + direction)
	const card = [...$('#pageList').children].find((item) => item.dataset.pageId === id)
	const control = card?.querySelectorAll('.row button')[direction < 0 ? 0 : 1]
	if (control && !control.disabled) control.focus({ preventScroll: true })
	else card?.querySelector('.page-thumb').focus({ preventScroll: true })
}

function clearPageDrag() {
	if (pageDrag) {
		suppressNextListClick = true
		clearTimeout(suppressClickTimer)
		suppressClickTimer = setTimeout(() => { suppressNextListClick = false }, 700)
	}
	pageDrag = null
	for (const card of $('#pageList').children) card.classList.remove('dragging', 'drop-before', 'drop-after')
}

$('#pageList').addEventListener('click', (event) => {
	if (!suppressNextListClick) return
	event.preventDefault()
	event.stopImmediatePropagation()
	suppressNextListClick = false
	clearTimeout(suppressClickTimer)
}, true)
$('#pageList').addEventListener('dragstart', (event) => {
	const card = event.target.closest('.page-card')
	if (!card || event.target.closest('.row button') || state.busy || state.gesture || state.book.pages.length < 2) { event.preventDefault(); return }
	document.activeElement?.blur()
	state.editKey = null
	pageDrag = { id: card.dataset.pageId, target: null }
	event.dataTransfer.effectAllowed = 'move'
	event.dataTransfer.setData('text/plain', pageDrag.id)
	event.dataTransfer.setDragImage(card, card.clientWidth / 2, 20)
	card.classList.add('dragging')
})
$('#pageList').addEventListener('dragover', (event) => {
	if (!pageDrag || state.busy) return
	event.preventDefault()
	event.dataTransfer.dropEffect = 'move'
	const cards = [...$('#pageList').children]
	for (const card of cards) card.classList.remove('drop-before', 'drop-after')
	const card = event.target.closest('.page-card') || cards.find((item) => event.clientY < item.getBoundingClientRect().bottom) || cards[cards.length - 1]
	if (!card) return
	const rect = card.getBoundingClientRect()
	const after = event.clientY >= rect.top + rect.height / 2
	const index = cards.indexOf(card) + (after ? 1 : 0)
	const from = state.book.pages.findIndex((item) => item.id === pageDrag.id)
	pageDrag.target = index > from ? index - 1 : index
	if (pageDrag.target !== from) card.classList.add(after ? 'drop-after' : 'drop-before')
	const panel = $('.pages-panel')
	const bounds = panel.getBoundingClientRect()
	if (event.clientY < bounds.top + 50) panel.scrollTop -= 18
	else if (event.clientY > bounds.bottom - 50) panel.scrollTop += 18
})
$('#pageList').addEventListener('dragleave', (event) => {
	if ($('#pageList').contains(event.relatedTarget)) return
	if (pageDrag) pageDrag.target = null
	for (const card of $('#pageList').children) card.classList.remove('drop-before', 'drop-after')
})
$('#pageList').addEventListener('drop', (event) => {
	if (!pageDrag) return
	event.preventDefault()
	const { id, target } = pageDrag
	clearPageDrag()
	if (target !== null) reorderPage(id, target)
})
addEventListener('dragend', clearPageDrag)
addEventListener('drop', clearPageDrag)
addEventListener('blur', clearPageDrag)

function selectPage(id) {
	state.pageId = id
	state.elementId = null
	state.crop = false
	state.editKey = null
	render()
}

function renderToc() {
	const root = $('#tocList')
	root.replaceChildren()
	if (!state.book.toc.length) root.append(node('p', 'hint', 'Разделов пока нет. Выберите страницу и нажмите «+ Раздел».'))
	for (const entry of state.book.toc.filter((item) => state.book.pages.some((page) => page.id === item.pageId))) {
		const row = node('div', 'toc-entry')
		row.dataset.tocId = entry.id
		const link = button('', () => {
			selectPage(entry.pageId)
			const card = [...$('#pageList').children].find((item) => item.dataset.pageId === entry.pageId)
			card?.scrollIntoView({ block: 'nearest' })
		})
		link.className = 'section-link'
		const preview = node('img', 'section-thumb')
		preview.alt = 'Миниатюра начальной страницы'
		preview.draggable = false
		preview.hidden = true
		row.append(preview, link, node('p', 'section-selected'))
		field(row, 'Название раздела', entry.title, (value) => {
			change(() => { entry.title = value }, false, entry.id + '-title')
			updateSectionIndicators()
		}, { maxLength: 300 })
		field(row, 'Начальная страница', entry.pageId, (value) => {
			change(() => { entry.pageId = value })
		}, { choices: state.book.pages.map((item, i) => ({ value: item.id, label: pageLabel(item, i) })) })
		row.append(button('Удалить раздел', () => change(() => { state.book.toc = state.book.toc.filter((item) => item.id !== entry.id) })))
		root.append(row)
	}
	$('#addToc').disabled = !state.book.pages.length || state.book.toc.length >= 1000
	updateSectionIndicators()
}

function place(item, element) {
	for (const [key, prop] of [['x', 'left'], ['y', 'top'], ['w', 'width'], ['h', 'height']]) item.style[prop] = element[key] * 100 + '%'
}

function paintElement(item, element) {
	place(item, element)
	item.classList.toggle('selected', element.id === state.elementId)
	item.classList.toggle('invisible', element.type === 'link' && (!element.background || element.background === 'transparent'))
	const visual = item.firstElementChild
	visual.style.color = element.color || '#000'
	visual.style.background = element.type === 'shape' ? element.background || element.color || '#000' : element.background || 'transparent'
	visual.style.opacity = element.opacity ?? 1
	visual.style.fontSize = 'calc(' + (element.fontSize || 16) + 'px * var(--page-scale))'
	visual.style.borderRadius = 'calc(' + (element.borderRadius || 0) + 'px * var(--page-scale))'
	visual.style.clipPath = ''
	if (['shape', 'button'].includes(element.type)) {
		if (element.shape === 'ellipse') visual.style.borderRadius = '50%'
		if (element.shape === 'polygon' && element.points?.length >= 3) visual.style.clipPath = 'polygon(' + element.points.map((point) => point.x * 100 + '% ' + point.y * 100 + '%').join(',') + ')'
	}
	const media = visual.querySelector('img, video, audio')
	if (media) {
		media.style.objectFit = element.objectFit || 'contain'
		const crop = element.crop || { x: .5, y: .5, zoom: 1 }
		media.style.objectPosition = crop.x * 100 + '% ' + crop.y * 100 + '%'
		media.style.transformOrigin = media.style.objectPosition
		media.style.transform = 'scale(' + crop.zoom + ')'
	}
}

function renderCanvas() {
	const current = page()
	$('#canvas').hidden = !current
	$('#emptyPage').hidden = Boolean(current)
	const root = $('#elements')
	root.replaceChildren()
	if (current) {
		$('#canvas').style.background = current.background || '#ffffff'
		const image = $('#pageImage')
		const url = assetUrl(current.normal || current.large)
		image.hidden = !url
		if (url && image.src !== url) image.src = url
		if (!url) image.removeAttribute('src')
		for (const element of current.elements) {
			const item = node('div', 'element')
			item.dataset.id = element.id
			item.setAttribute('aria-label', typeLabels[element.type] + ': ' + (element.text || 'элемент'))
			const visual = node('div', 'element-visual')
			if (mediaTypes.includes(element.type)) {
				const media = node(['image', 'gif'].includes(element.type) ? 'img' : element.type)
				const src = assetUrl(element.src)
				if (src) media.src = src
				if (media.tagName === 'IMG') { media.alt = element.text || ''; media.draggable = false }
				else { media.controls = true; media.preload = 'metadata'; media.playsInline = true }
				visual.append(media)
			} else if (element.type !== 'shape') visual.textContent = element.text || ''
			item.append(visual)
			paintElement(item, element)
			root.append(item)
		}
	}
	layoutCanvas()
	renderSelection()
	updateTools()
}

function layoutCanvas() {
	if (!state.book) return
	const width = state.book.page?.width || 600
	const height = state.book.page?.height || 800
	const stage = $('#stage')
	const availableWidth = Math.max(80, stage.clientWidth - 56)
	const availableHeight = Math.max(100, stage.clientHeight - 56)
	const scale = Math.min(availableWidth / width, availableHeight / height)
	$('#canvas').style.width = width * scale + 'px'
	$('#canvas').style.height = height * scale + 'px'
	$('#canvas').style.setProperty('--page-scale', scale)
	const owned = pageSections(state.pageId)
	$('#canvasInfo').textContent = page() ? 'Страница ' + (state.book.pages.indexOf(page()) + 1) + ' из ' + state.book.pages.length + ' · ' + (owned.length ? owned.map((item) => 'Раздел «' + sectionTitle(item.entry) + '»: ' + rangeLabel(item)).join('; ') : 'Без раздела') + ' · ' + Math.round(scale * 100) + '% · ' + (state.crop ? 'Перетаскивайте медиа для кадрирования.' : 'Перетаскивание — перемещение · 8 ручек — размер · Координаты 0–1') : 'Нет страниц'
}

function renderSelection() {
	const element = selected()
	const selection = $('#selection')
	selection.replaceChildren()
	selection.hidden = !element
	if (!element) return
	place(selection, element)
	for (const [name, x, y] of [['nw', 0, 0], ['n', .5, 0], ['ne', 1, 0], ['e', 1, .5], ['se', 1, 1], ['s', .5, 1], ['sw', 0, 1], ['w', 0, .5]]) {
		const handle = node('button', 'handle')
		handle.type = 'button'
		handle.dataset.handle = name
		handle.style.left = x * 100 + '%'
		handle.style.top = y * 100 + '%'
		handle.setAttribute('aria-label', 'Изменить размер: ' + { nw: 'сверху слева', n: 'сверху', ne: 'сверху справа', e: 'справа', se: 'снизу справа', s: 'снизу', sw: 'снизу слева', w: 'слева' }[name])
		selection.append(handle)
	}
	if (['shape', 'button'].includes(element.type) && element.shape === 'polygon') element.points?.forEach((point, index) => {
		const vertex = node('button', 'vertex')
		vertex.type = 'button'
		vertex.dataset.vertex = index
		vertex.style.left = point.x * 100 + '%'
		vertex.style.top = point.y * 100 + '%'
		vertex.setAttribute('aria-label', 'Вершина многоугольника ' + (index + 1))
		selection.append(vertex)
	})
}

function renderLayers() {
	const root = $('#layerList')
	root.replaceChildren()
	for (const element of [...(page()?.elements || [])].reverse()) {
		const item = button(typeLabels[element.type] + (element.text ? ' · ' + element.text : ''), () => selectElement(element.id))
		item.className = 'layer' + (element.id === state.elementId ? ' current' : '')
		root.append(item)
	}
}

function updateTools() {
	const element = selected()
	const items = page()?.elements || []
	for (const item of document.querySelectorAll('[data-add]')) item.disabled = !page() || items.length >= 200
	for (const id of ['duplicate', 'deleteElement']) $('#' + id).disabled = !element || (id === 'duplicate' && items.length >= 200)
	$('#forward').disabled = !element || items.indexOf(element) === items.length - 1
	$('#backward').disabled = !element || items.indexOf(element) === 0
	$('#cropMode').disabled = !element || !['image', 'gif', 'video'].includes(element.type)
	if ($('#cropMode').disabled) state.crop = false
	$('#cropMode').setAttribute('aria-pressed', String(state.crop))
	$('#canvas').classList.toggle('cropping', state.crop)
}

function selectElement(id) {
	state.elementId = id
	state.editKey = null
	for (const item of $('#elements').children) item.classList.toggle('selected', item.dataset.id === id)
	renderSelection()
	renderProperties()
	renderLayers()
	updateTools()
}

function render() {
	if (!state.book) return
	state.book.pages.forEach((item, index) => { item.index = index + 1; item.elements ||= [] })
	if (!page()) state.pageId = state.book.pages[0]?.id || null
	if (!selected()) state.elementId = null
	renderPages()
	renderToc()
	renderCanvas()
	renderProperties()
	renderSettings()
	renderLayers()
	updateStatus()
}

function addElement(type) {
	if (!page() || page().elements.length >= 200) return
	change(() => {
		const element = { id: uid('element'), type, x: .1, y: .1, w: .3, h: type === 'text' || type === 'link' || type === 'button' || type === 'audio' ? .1 : .25, opacity: 1, borderRadius: 0 }
		if (['text', 'button'].includes(type)) Object.assign(element, { text: type === 'text' ? 'Ваш текст' : 'Кнопка', fontSize: 24, color: type === 'text' ? '#000000' : '#ffffff' })
		if (['shape', 'button'].includes(type)) Object.assign(element, { background: '#1e40af', shape: 'rect' })
		if (type === 'link') Object.assign(element, { background: 'transparent', text: '', url: null })
		if (mediaTypes.includes(type)) Object.assign(element, { src: null, objectFit: 'contain' })
		page().elements.push(element)
		state.elementId = element.id
		state.crop = false
	})
}

function reorderElement(delta) {
	const element = selected()
	if (!element) return
	const items = page().elements
	const index = items.indexOf(element)
	if (index + delta < 0 || index + delta >= items.length) return
	change(() => { items.splice(index, 1); items.splice(index + delta, 0, element) })
}

function deleteElement() {
	if (!selected()) return
	change(() => { page().elements = page().elements.filter((item) => item.id !== state.elementId); state.elementId = null })
}

$('#canvas').addEventListener('pointerdown', (event) => {
	if (state.busy || state.gesture || event.button !== 0 || !page()) return
	const hit = event.target.closest('.element')
	const handle = event.target.closest('[data-handle]')
	const vertex = event.target.closest('[data-vertex]')
	if (!hit && !handle && !vertex) { selectElement(null); return }
	event.preventDefault()
	if (hit && hit.dataset.id !== state.elementId) selectElement(hit.dataset.id)
	const element = selected()
	if (!element) return
	if (vertex && event.altKey) {
		if (element.points.length > 3) change(() => { element.points.splice(Number(vertex.dataset.vertex), 1) })
		return
	}
	state.editKey = null
	state.gesture = { pointerId: event.pointerId, before: snapshot(), element, original: copy(element), startX: event.clientX, startY: event.clientY, rect: $('#canvas').getBoundingClientRect(), handle: handle?.dataset.handle, vertex: vertex ? Number(vertex.dataset.vertex) : null, crop: state.crop && !handle && !vertex }
	$('#canvas').setPointerCapture(event.pointerId)
})

$('#canvas').addEventListener('pointermove', (event) => {
	const gesture = state.gesture
	if (!gesture || event.pointerId !== gesture.pointerId) return
	const { element, original, rect, handle, vertex } = gesture
	const dx = (event.clientX - gesture.startX) / rect.width
	const dy = (event.clientY - gesture.startY) / rect.height
	if (vertex !== null) {
		element.points[vertex] = { x: clamp(original.points[vertex].x + dx / Math.max(original.w, .001)), y: clamp(original.points[vertex].y + dy / Math.max(original.h, .001)) }
	} else if (gesture.crop) {
		const crop = original.crop || { x: .5, y: .5, zoom: 1 }
		element.crop = { x: clamp(crop.x - dx / Math.max(original.w, .001)), y: clamp(crop.y - dy / Math.max(original.h, .001)), zoom: crop.zoom }
	} else if (handle) {
		let left = original.x
		let top = original.y
		let right = original.x + original.w
		let bottom = original.y + original.h
		if (handle.includes('w')) left = clamp(original.x + dx, 0, right - .001)
		if (handle.includes('e')) right = clamp(original.x + original.w + dx, left + .001, 1)
		if (handle.includes('n')) top = clamp(original.y + dy, 0, bottom - .001)
		if (handle.includes('s')) bottom = clamp(original.y + original.h + dy, top + .001, 1)
		Object.assign(element, { x: left, y: top, w: right - left, h: bottom - top })
	} else {
		element.x = clamp(original.x + dx, 0, 1 - original.w)
		element.y = clamp(original.y + dy, 0, 1 - original.h)
	}
	const item = [...$('#elements').children].find((child) => child.dataset.id === element.id)
	if (item) paintElement(item, element)
	renderSelection()
	updateStatus()
})

function endGesture(event) {
	const gesture = state.gesture
	if (!gesture || event.pointerId !== gesture.pointerId) return
	state.gesture = null
	if (event.type === 'pointercancel') {
		for (const key of Object.keys(gesture.element)) delete gesture.element[key]
		Object.assign(gesture.element, gesture.original)
	} else remember(gesture.before)
	if ($('#canvas').hasPointerCapture(event.pointerId)) $('#canvas').releasePointerCapture(event.pointerId)
	renderProperties()
	renderSelection()
	if (event.type === 'pointercancel') renderCanvas()
	updateStatus()
}
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) $('#canvas').addEventListener(name, endGesture)

$('#canvas').addEventListener('dblclick', (event) => {
	const element = selected()
	if (state.busy || !element || !['shape', 'button'].includes(element.type) || element.shape !== 'polygon' || element.points.length >= 100 || event.target.closest('[data-vertex], [data-handle]')) return
	const hit = [...$('#elements').children].find((item) => item.dataset.id === element.id)
	if (!hit) return
	const rect = hit.getBoundingClientRect()
	if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return
	const point = { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) }
	let nearest = 0
	let distance = Infinity
	element.points.forEach((a, index) => {
		const b = element.points[(index + 1) % element.points.length]
		const dx = (b.x - a.x) * rect.width
		const dy = (b.y - a.y) * rect.height
		const px = (point.x - a.x) * rect.width
		const py = (point.y - a.y) * rect.height
		const t = clamp((px * dx + py * dy) / (dx * dx + dy * dy || 1))
		const d = Math.hypot(px - t * dx, py - t * dy)
		if (d < distance) { distance = d; nearest = index }
	})
	change(() => { element.points.splice(nearest + 1, 0, point) })
})

$('#toolbar').addEventListener('click', (event) => {
	const item = event.target.closest('[data-add]')
	if (item) addElement(item.dataset.add)
})
$('#cropMode').onclick = () => { state.crop = !state.crop; updateTools(); layoutCanvas() }
$('#forward').onclick = () => reorderElement(1)
$('#backward').onclick = () => reorderElement(-1)
$('#duplicate').onclick = () => {
	if (!selected() || page().elements.length >= 200) return
	change(() => {
		const element = copy(selected())
		element.id = uid('element')
		element.x = clamp(element.x + .02, 0, 1 - element.w)
		element.y = clamp(element.y + .02, 0, 1 - element.h)
		page().elements.push(element)
		state.elementId = element.id
	})
}
$('#deleteElement').onclick = deleteElement
$('#addPage').onclick = () => change(() => {
	const item = { id: uid('page'), index: state.book.pages.length + 1, normal: null, thumb: null, large: null, background: '#ffffff', elements: [] }
	state.book.pages.push(item)
	state.pageId = item.id
	state.elementId = null
})
$('#appendPages').onclick = () => $('#pageFiles').click()
$('#pageFiles').onchange = async (event) => {
	const files = [...event.target.files]
	if (!files.length || !validInputs()) return
	await withBusy(async () => {
		await persist()
		const before = snapshot()
		const oldIds = new Set(state.book.pages.map((item) => item.id))
		const body = new FormData()
		for (const file of files) body.append('file', file)
		state.book = await request(endpoint + '/pages', { method: 'POST', body })
		remember(before)
		state.saved = snapshot()
		state.pageId = state.book.pages.find((item) => !oldIds.has(item.id))?.id || state.pageId
		state.elementId = null
		render()
	})
	event.target.value = ''
}
$('#addToc').onclick = () => change(() => { if (page()) state.book.toc.push({ id: uid('toc'), title: 'Новый раздел', pageId: page().id }) })
$('#undo').onclick = () => historyStep()
$('#redo').onclick = () => historyStep(true)
$('#save').onclick = save
$('#preview').onclick = async (event) => {
	event.preventDefault()
	if (state.busy || !state.book || !validInputs()) return
	const preview = window.open('about:blank', '_blank')
	if (preview) preview.opener = null
	const ok = await save()
	if (ok && preview) preview.location.replace(publicPath(state.book))
	else if (preview) preview.close()
	if (ok && !preview) message('Сохранено. Разрешите всплывающие окна и повторите «Сохранить и посмотреть».')
}
addEventListener('keydown', (event) => {
	if (!state.book || state.busy || state.gesture) return
	const key = event.key.toLowerCase()
	if ((event.ctrlKey || event.metaKey) && ['s', 'z', 'y'].includes(key)) {
		event.preventDefault()
		if (key === 's') save()
		else historyStep(key === 'y' || event.shiftKey)
		return
	}
	if (event.target.closest('input, textarea, select, [contenteditable=true]')) return
	if (key === 'delete' || key === 'backspace') { event.preventDefault(); deleteElement() }
	if (key === 'escape') { state.crop = false; selectElement(null) }
})
addEventListener('beforeunload', (event) => { if (dirty() || state.busy) { event.preventDefault(); event.returnValue = '' } })
new ResizeObserver(layoutCanvas).observe($('#stage'))

async function init() {
	try {
		if (!slug) throw new Error('Не указана книга. Откройте редактор из панели управления.')
		state.book = await request(endpoint + '/editor')
		slug = state.book.slug
		endpoint = '/api/books/' + encodeURIComponent(slug)
		state.book.publicSlug ||= slug
		state.book.toc ||= []
		state.pageId = state.book.pages[0]?.id || null
		state.saved = snapshot()
		$('#workspace').disabled = false
		render()
	} catch (error) { message(error); $('#saveState').textContent = 'Не удалось загрузить' }
}
init()
