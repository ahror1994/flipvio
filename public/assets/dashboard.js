const el = (selector) => document.querySelector(selector)
const bookPath = (slug) => '/api/books/' + encodeURIComponent(slug)
const publicPath = (book) => book.url || '/b/' + encodeURIComponent(book.publicSlug || book.slug)
const normalizePublicSlug = (value) => value.trim().normalize('NFC').toLowerCase().normalize('NFC')

function publicSlugError(value) {
	const name = normalizePublicSlug(value)
	if (/[\p{Cc}\p{Cf}]/u.test(value)) return 'Название в ссылке не должно содержать управляющие символы.'
	if ([...name].length < 2 || [...name].length > 80) return 'Название в ссылке должно содержать 2–80 символов.'
	if (!/^[\p{Script=Latin}\p{Script=Cyrillic}0-9-]+$/u.test(name) || !/^[\p{L}0-9-]+$/u.test(name) || /^-|-$/.test(name)) return 'Используйте латиницу, кириллицу, цифры и дефисы только внутри названия.'
	return ''
}

function updatePublicLink(manifest) {
	const input = el('#editorForm').elements.namedItem('publicSlug')
	const error = publicSlugError(input.value)
	input.setCustomValidity(error)
	el('#publicLinkPreview').textContent = error || new URL(manifest ? publicPath(manifest) : '/b/' + encodeURIComponent(normalizePublicSlug(input.value)), location.origin).href
}

async function request(url, options) {
	let response
	try { response = await fetch(url, options) } catch { throw new Error('Нет связи с сервером. Проверьте подключение и повторите попытку.') }
	if (response.status === 401) { location.href = '/login'; throw new Error('Войдите в кабинет владельца') }
	const data = await response.json().catch(() => ({}))
	if (!response.ok) throw new Error(/[а-яё]/i.test(data.error || '') ? data.error : 'Не удалось выполнить действие. Проверьте данные и повторите попытку.')
	return data
}

const api = {
	list: () => request('/api/books'),
	get: (slug) => request(bookPath(slug) + '/editor'),
	patch: (slug, body) => request(bookPath(slug), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
	remove: (slug) => request(bookPath(slug), { method: 'DELETE' }),
}

let uploading = false
let editing = null
let modalBusy = false
let modalVersion = 0

async function upload(files) {
	if (!files?.length || uploading) return
	uploading = true
	const body = new FormData()
	for (const file of files) body.append('file', file)
	if (el('#title').value) body.append('title', el('#title').value)
	el('#progress').hidden = false
	el('#pick').disabled = true
	try {
		const data = await request('/api/books', { method: 'POST', body })
		el('#title').value = ''
		location.href = '/editor.html?slug=' + encodeURIComponent(data.slug)
	} catch (error) { alert(error.message) } finally {
		el('#progress').hidden = true
		el('#pick').disabled = false
		el('#file').value = ''
		uploading = false
	}
}

function actionButton(text, action) {
	const button = document.createElement('button')
	button.type = 'button'
	button.textContent = text
	button.onclick = async () => {
		button.disabled = true
		try { await action() } catch (error) { alert(error.message) } finally { button.disabled = false }
	}
	return button
}

async function renderBooks() {
	const { books } = await api.list()
	const box = el('#books')
	box.replaceChildren()
	if (!books.length) { const empty = document.createElement('p'); empty.textContent = 'Пока ничего не загружено.'; box.append(empty); return }
	for (const book of books) {
		const card = document.createElement('div')
		card.className = 'book'
		const image = document.createElement('img')
		image.alt = ''
		image.loading = 'lazy'
		if (book.cover?.startsWith('/storage/')) image.src = book.cover
		const meta = document.createElement('div')
		meta.className = 'meta'
		const title = document.createElement('b')
		title.textContent = book.title
		const stats = document.createElement('small')
		stats.textContent = book.pageCount + ' стр. · ' + (book.views || 0) + ' просм.'
		const badge = document.createElement('span')
		badge.className = 'badge ' + (book.published ? 'published' : 'draft')
		badge.textContent = book.published ? 'Опубликовано' : 'Черновик'
		meta.append(title, stats, badge)
		const actions = document.createElement('div')
		actions.className = 'acts'
		const editor = document.createElement('a')
		editor.href = '/editor.html?slug=' + encodeURIComponent(book.slug)
		editor.textContent = 'Редактор'
		const preview = document.createElement('a')
		preview.href = publicPath(book)
		preview.target = '_blank'
		preview.rel = 'noopener'
		preview.textContent = 'Просмотр'
		const publish = actionButton(book.published ? 'Снять с публикации' : 'Опубликовать', async () => { await api.patch(book.slug, { published: !book.published }); await renderBooks() })
		publish.className = 'publish-toggle'
		publish.setAttribute('aria-pressed', String(Boolean(book.published)))
		actions.append(editor, preview, actionButton('Настройки', () => openEditor(book.slug)), publish, actionButton('Удалить', async () => {
			if (confirm('Удалить публикацию?')) { await api.remove(book.slug); await renderBooks() }
		}))
		card.append(image, meta, actions)
		box.append(card)
	}
}

function closeEditor() {
	if (modalBusy) return
	modalVersion++
	editing = null
	el('#editor').hidden = true
}

async function openEditor(slug) {
	if (modalBusy) return
	const version = ++modalVersion
	const manifest = await api.get(slug)
	if (version !== modalVersion) return
	editing = manifest.slug
	const form = el('#editorForm')
	form.reset()
	form.elements.namedItem('title').value = manifest.title || ''
	form.elements.namedItem('publicSlug').value = manifest.publicSlug || manifest.slug
	updatePublicLink(manifest)
	el('#settingsError').hidden = true
	form.elements.namedItem('published').checked = manifest.published
	for (const [key, value] of Object.entries(manifest.settings)) {
		const input = form.elements.namedItem(key)
		if (!input) continue
		if (input.type === 'checkbox') input.checked = Boolean(value)
		else input.value = value ?? ''
	}
	for (const key of ['backgroundImage', 'logoUrl']) el('[data-asset-status="' + key + '"]').textContent = manifest.settings[key]?.split('/').pop() || 'Не выбрано'
	el('#editor').hidden = false
}

el('#editorForm').elements.namedItem('publicSlug').addEventListener('input', () => {
	updatePublicLink()
	el('#settingsError').hidden = true
})

el('#editorForm').addEventListener('submit', async (event) => {
	event.preventDefault()
	if (modalBusy || !editing) return
	const form = event.target
	updatePublicLink()
	if (!form.reportValidity()) return
	const settings = {}
	for (const input of form.elements) {
		if (!input.name || ['title', 'publicSlug', 'published'].includes(input.name) || input.type === 'file') continue
		settings[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value || null
	}
	modalBusy = true
	const submit = form.querySelector('[type=submit]')
	submit.disabled = true
	try {
		const updated = await api.patch(editing, { title: form.elements.namedItem('title').value, publicSlug: form.elements.namedItem('publicSlug').value, published: form.elements.namedItem('published').checked, settings })
		form.elements.namedItem('publicSlug').value = updated.publicSlug || updated.slug
		updatePublicLink(updated)
		await renderBooks()
		modalBusy = false
		closeEditor()
	} catch (error) {
		el('#settingsError').textContent = error.message
		el('#settingsError').hidden = false
	} finally { modalBusy = false; submit.disabled = false }
})

for (const input of document.querySelectorAll('[data-asset]')) input.onchange = async () => {
	const file = input.files[0]
	if (!file || !editing || modalBusy) return
	modalBusy = true
	el('#editorForm').querySelector('[type=submit]').disabled = true
	try {
		const body = new FormData()
		body.append('file', file)
		const result = await request(bookPath(editing) + '/assets', { method: 'POST', body })
		if (!['image', 'gif'].includes(result.type)) throw new Error('Выберите изображение')
		el('#editorForm').elements.namedItem(input.dataset.asset).value = result.url
		el('[data-asset-status="' + input.dataset.asset + '"]').textContent = file.name
	} catch (error) { alert(error.message) } finally {
		modalBusy = false
		input.value = ''
		el('#editorForm').querySelector('[type=submit]').disabled = false
	}
}
for (const button of document.querySelectorAll('[data-clear-asset]')) button.onclick = () => {
	if (modalBusy) return
	el('#editorForm').elements.namedItem(button.dataset.clearAsset).value = ''
	el('[data-asset-status="' + button.dataset.clearAsset + '"]').textContent = 'Не выбрано'
}

el('#editorClose').onclick = closeEditor
el('#editor').onclick = (event) => { if (event.target === el('#editor')) closeEditor() }
addEventListener('keydown', (event) => { if (event.key === 'Escape') closeEditor() })
el('#pick').onclick = () => el('#file').click()
el('#file').onchange = (event) => upload(event.target.files)
const drop = el('#drop')
for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('hot') })
for (const name of ['dragleave', 'drop']) drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove('hot') })
drop.addEventListener('drop', (event) => upload(event.dataTransfer.files))
el('#logout').onclick = async () => {
	try { await request('/api/logout', { method: 'POST' }); location.href = '/login' } catch (error) { alert(error.message) }
}
renderBooks().catch((error) => { el('#books').textContent = error.message })
