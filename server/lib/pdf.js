const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

function run(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { maxBuffer: 1024 * 1024 * 4, timeout: 120000, windowsHide: true, ...opts }, (err, stdout, stderr) => {
			if (err) return reject(Object.assign(new Error(err.code === 'ENOENT' ? 'Conversion backend unavailable' : 'Document conversion failed'), { status: err.code === 'ENOENT' ? 503 : 415 }))
			resolve({ stdout, stderr })
		})
	})
}

// Проверяем доступность poppler/magick
let hasPoppler = null
async function checkPoppler() {
	if (hasPoppler !== null) return hasPoppler
	try {
		await run('pdfinfo', ['-v'])
		await run('magick', ['-version'])
		hasPoppler = true
	} catch {
		hasPoppler = false
	}
	return hasPoppler
}

// Количество страниц и геометрия страницы в пунктах (как meta.pageWidth у FlipHTML5)
async function pdfInfo(file) {
	const { stdout } = await run('pdfinfo', [file])
	const pages = Number(/Pages:\s+(\d+)/.exec(stdout)?.[1] || 0)
	const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(stdout)
	return {
		pages,
		ptWidth: size ? Number(size[1]) : 595.32,
		ptHeight: size ? Number(size[2]) : 841.92,
	}
}

// Растеризация всего PDF в JPEG с заданным dpi.
async function renderTier(pdfPath, outDir, dpi, quality) {
	fs.mkdirSync(outDir, { recursive: true })
	await run('pdftoppm', [
		'-jpeg',
		'-jpegopt', 'quality=' + quality + ',progressive=y,optimize=y',
		'-r', String(dpi),
		'-aa', 'yes',
		'-aaVector', 'yes',
		pdfPath,
		path.join(outDir, 'page'),
	])
	for (const f of fs.readdirSync(outDir)) {
		const m = /^page-0*(\d+)\.jpg$/.exec(f)
		if (!m) continue
		const want = 'page-' + Number(m[1]) + '.jpg'
		if (want !== f) fs.renameSync(path.join(outDir, f), path.join(outDir, want))
	}
}

// Миниатюры делаем из уже готового normal-тира
async function makeThumbs(normalDir, thumbDir, count, height = 220) {
	fs.mkdirSync(thumbDir, { recursive: true })
	for (let i = 1; i <= count; i++) {
		const src = path.join(normalDir, 'page-' + i + '.jpg')
		if (!fs.existsSync(src)) continue
		await run('magick', [
			src,
			'-resize', 'x' + height,
			'-strip',
			'-quality', '78',
			path.join(thumbDir, 'page-' + i + '.jpg'),
		])
	}
}

async function pixelSize(file) {
	const { stdout } = await run('magick', ['identify', '-format', '%w %h', file])
	const [w, h] = stdout.trim().split(/\s+/).map(Number)
	return { width: w, height: h }
}

// Запасной питоновский бэкенд растеризации (если на машине нет установленного poppler/magick)
function getPythonExe() {
	const venvPy = path.join(__dirname, '..', '..', '..', 'nexorai-flip-studio', '.venv', 'Scripts', 'python.exe')
	if (fs.existsSync(venvPy)) return venvPy
	return 'python'
}

async function runPythonRasterizer(args) {
	const py = getPythonExe()
	const script = path.join(__dirname, 'rasterize.py')
	const { stdout } = await run(py, [script, ...args])
	return JSON.parse(stdout)
}

async function processPdf({ pdfPath, outRoot, publicBase, dpiNormal = 110, dpiLarge = 200 }) {
	const popplerOk = await checkPoppler()
	if (!popplerOk) {
		return await runPythonRasterizer(['pdf', pdfPath, outRoot, publicBase, String(dpiNormal), String(dpiLarge)])
	}

	const info = await pdfInfo(pdfPath)
	if (info.pages < 1 || info.pages > 1000 || info.ptWidth * info.ptHeight * (dpiLarge / 72) ** 2 > 40000000) throw Object.assign(new Error('PDF exceeds page or pixel limits'), { status: 413 })
	const normalDir = path.join(outRoot, 'normal')
	const largeDir = path.join(outRoot, 'large')
	const thumbDir = path.join(outRoot, 'thumb')

	await renderTier(pdfPath, normalDir, dpiNormal, 82)
	await renderTier(pdfPath, largeDir, dpiLarge, 88)
	await makeThumbs(normalDir, thumbDir, info.pages)

	const first = path.join(normalDir, 'page-1.jpg')
	const px = fs.existsSync(first) ? await pixelSize(first) : { width: 800, height: 1131 }

	const pages = []
	for (let i = 1; i <= info.pages; i++) {
		pages.push({
			index: i,
			thumb: publicBase + '/thumb/page-' + i + '.jpg',
			normal: publicBase + '/normal/page-' + i + '.jpg',
			large: publicBase + '/large/page-' + i + '.jpg',
		})
	}

	return { pageCount: info.pages, page: px, pt: { width: info.ptWidth, height: info.ptHeight }, pages }
}

async function processImages({ imagePaths, outRoot, publicBase }) {
	const popplerOk = await checkPoppler()
	if (!popplerOk) {
		return await runPythonRasterizer(['images', outRoot, publicBase, ...imagePaths])
	}

	const dirs = {
		normal: path.join(outRoot, 'normal'),
		large: path.join(outRoot, 'large'),
		thumb: path.join(outRoot, 'thumb'),
	}
	Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }))

	for (let i = 0; i < imagePaths.length; i++) {
		const src = imagePaths[i]
		const size = await pixelSize(src)
		if (!Number.isFinite(size.width * size.height) || size.width * size.height > 20000000) throw Object.assign(new Error('Image exceeds pixel limits'), { status: 413 })
		const n = i + 1
		await run('magick', [src, '-resize', 'x1200>', '-strip', '-quality', '82', path.join(dirs.normal, 'page-' + n + '.jpg')])
		await run('magick', [src, '-resize', 'x2200>', '-strip', '-quality', '88', path.join(dirs.large, 'page-' + n + '.jpg')])
		await run('magick', [src, '-resize', 'x220', '-strip', '-quality', '78', path.join(dirs.thumb, 'page-' + n + '.jpg')])
	}

	const px = await pixelSize(path.join(dirs.normal, 'page-1.jpg'))
	const pages = imagePaths.map((_, i) => ({
		index: i + 1,
		thumb: publicBase + '/thumb/page-' + (i + 1) + '.jpg',
		normal: publicBase + '/normal/page-' + (i + 1) + '.jpg',
		large: publicBase + '/large/page-' + (i + 1) + '.jpg',
	}))
	return { pageCount: imagePaths.length, page: px, pt: null, pages }
}

module.exports = { run, pdfInfo, renderTier, makeThumbs, pixelSize, processPdf, processImages }
