const $ = (sel) => document.querySelector(sel)
const rawSlug = location.pathname.split('/').filter(Boolean).pop() || ''
const slug = decodeURIComponent(rawSlug)
const EMBED = location.pathname.startsWith('/embed/')
// статический режим (GitHub Pages): манифест и ресурсы лежат рядом с книгой, бэкенда нет
const STATIC = document.body.dataset.static !== undefined
const ROOT = document.body.dataset.root || ''
const MANIFEST_URL = document.body.dataset.manifest

const IS_MOBILE = () => Math.min(innerWidth, innerHeight) < 820 || matchMedia('(pointer: coarse)').matches

const S = {
	mf: null,
	spread: 0,
	currentPage: 1,
	single: false,
	layoutPending: false,
	sound: true,
	animating: false,
	dragging: false,
	pinch: false,
	auto: null,
	sizes: { w: 0, h: 0 },
	tex: new Map(),
	imgCache: new Map(),
	thumbCache: new Map(),
	largeCache: new Map(),
	imgCacheLimit: 24,
	pendingImg: new Map(),
	curThumb: null,
	preloadToken: 0,
}

const Sfx = {
	audio: null,
	lastPlay: -Infinity,
	unlocked: false,
	unlock(e) {
		if (!e.isTrusted) return
		this.unlocked = true
		if (S.sound && !this.audio) this.init()
	},
	init() {
		try {
			this.audio = new Audio(ROOT + '/assets/sfx/flip.mp3')
			this.audio.preload = 'auto'
			this.audio.load()
		} catch (_) {}
	},
	play() {
		if (!S.sound || !this.unlocked) return
		const now = performance.now()
		if (now - this.lastPlay < 500) return
		this.lastPlay = now
		try {
			if (!this.audio) this.init()
			if (this.audio) {
				this.audio.currentTime = 0
				const p = this.audio.play()
				if (p && typeof p.catch === 'function') p.catch(() => {})
			}
		} catch (_) {}
	},
}

const VERT = `#version 300 es
precision highp float;
in vec2 aGrid;
out vec2 vUv;
out vec3 vNorm;
out float vZ;
out float vS;
uniform vec2 uPage;
uniform vec2 uViewport;
uniform float uPan;
uniform float uDir;
uniform vec2 uFoldPoint;
uniform vec2 uFoldDir;
uniform vec2 uFoldNormal;
uniform float uRadius;
const float PI = 3.141592653589793;
void main() {
	vUv = aGrid;
	float W = uPage.x;
	float H = uPage.y;
	float x0 = aGrid.x * W;
	float y0 = (aGrid.y - 0.5) * H;
	vec2 P = vec2(x0, y0);
	vec2 A = normalize(uFoldDir);
	vec2 N = normalize(uFoldNormal);
	vec2 F = uFoldPoint;
	float s = dot(P - F, N);
	float t = dot(P - F, A);
	float R = max(1.0, uRadius);
	float phi = s / R;
	vec3 pLocal;
	vec3 nLocal;
	if (s <= 0.0) {
		pLocal = vec3(P, 0.0);
		nLocal = vec3(0.0, 0.0, 1.0);
	} else if (phi < PI) {
		float sn = sin(phi);
		float cs = cos(phi);
		pLocal = vec3(F + A * t + N * (R * sn), R * (1.0 - cs));
		nLocal = vec3(-N * sn, cs);
	} else {
		float extra = s - PI * R;
		pLocal = vec3(F + A * t - N * extra, 2.0 * R);
		nLocal = vec3(0.0, 0.0, -1.0);
	}
	if (uDir < 0.0) {
		pLocal.x = -pLocal.x;
		nLocal.x = -nLocal.x;
	}
	pLocal.x += uPan;
	vNorm = nLocal;
	vZ = pLocal.z;
	vS = s;
	vec2 clip = vec2(pLocal.x / (uViewport.x * 0.5), -pLocal.y / (uViewport.y * 0.5));
	gl_Position = vec4(clip, clamp(0.5 - vZ / 1000.0, 0.0, 1.0), 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
in vec3 vNorm;
in float vZ;
in float vS;
uniform sampler2D uFront;
uniform sampler2D uBack;
uniform float uDir;
uniform float uRadius;
out vec4 outColor;
const float PI = 3.141592653589793;
void main() {
	bool isFront = vNorm.z >= 0.0;
	vec3 N = normalize(isFront ? vNorm : -vNorm);
	vec3 L = normalize(vec3(-0.35, -0.45, 1.25));
	float diff = max(0.0, dot(N, L));
	float flatness = clamp(N.z, 0.0, 1.0);
	float light = mix(mix(0.62, 1.0, diff), 1.0, flatness);
	vec3 V = vec3(0.0, 0.0, 1.0);
	vec3 H = normalize(L + V);
	float spec = pow(max(0.0, dot(N, H)), 18.0) * 0.07 * (1.0 - flatness);
	float R = max(1.0, uRadius);
	float crest = 0.5 * PI * R;
	float inCurl = step(0.0, vS) * step(vS, PI * R);
	float glossDist = (vS - crest) / (0.35 * PI * R);
	float gloss = exp(-glossDist * glossDist) * inCurl * 0.18 * (1.0 - flatness);
	float depthShadow = clamp(1.0 - (vZ / 220.0) * 0.18, 0.65, 1.0);
	vec2 uv;
	if (uDir > 0.0) {
		uv = isFront ? vUv : vec2(1.0 - vUv.x, vUv.y);
	} else {
		uv = isFront ? vec2(1.0 - vUv.x, vUv.y) : vUv;
	}
	vec4 base = isFront ? texture(uFront, uv) : texture(uBack, uv);
	outColor = vec4(base.rgb * light * depthShadow + spec + gloss, base.a);
}`

const SHADOW_VERT = `#version 300 es
precision highp float;
in vec2 aQuad;
uniform vec2 uPage;
uniform vec2 uViewport;
uniform float uPan;
uniform float uDir;
out vec2 vLocal;
void main() {
	float W = uPage.x;
	float H = uPage.y;
	vec2 P = vec2(aQuad.x * W, (aQuad.y - 0.5) * H);
	vLocal = P;
	if (uDir < 0.0) P.x = -P.x;
	P.x += uPan;
	vec2 clip = vec2(P.x / (uViewport.x * 0.5), -P.y / (uViewport.y * 0.5));
	gl_Position = vec4(clip, 0.8, 1.0);
}`

const SHADOW_FRAG = `#version 300 es
precision highp float;
in vec2 vLocal;
uniform vec2 uFoldPoint;
uniform vec2 uFoldNormal;
uniform float uRadius;
out vec4 outColor;
void main() {
	float s = dot(vLocal - uFoldPoint, uFoldNormal);
	float R = max(1.0, uRadius);
	float flatSide = exp(-max(0.0, -s) / (R * 1.35));
	float liftedSide = exp(-max(0.0, s) / (R * 2.2)) * 0.45;
	float a = (0.34 * flatSide + 0.16 * liftedSide) * (1.0 - smoothstep(0.0, 1.0, s / (R * 5.0)));
	if (a < 0.012) discard;
	outColor = vec4(0.0, 0.0, 0.0, min(a, 0.55));
}`

const GL = {
	gl: null,
	prog: null,
	shadowProg: null,
	pageBuf: null,
	pageIdxBuf: null,
	shadowBuf: null,
	pageVao: null,
	shadowVao: null,
	indexCount: 0,
	u: {},
	shadowU: {},
	pageLoc: -1,
	shadowLoc: -1,
	boundCanvas: null,
	init(canvas) {
		if (this.gl && !this.gl.isContextLost()) return true
		if (this.boundCanvas !== canvas) {
			this.boundCanvas = canvas
			canvas.addEventListener('webglcontextlost', (e) => {
				e.preventDefault()
				S.tex.clear()
				this.gl = null
			})
			canvas.addEventListener('webglcontextrestored', () => {
				try { this.init(canvas) } catch (_) { this.gl = null }
			})
		}
		const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: false, powerPreference: 'high-performance' })
		if (!gl) return false
		this.gl = gl
		const compile = (type, src) => {
			const sh = gl.createShader(type)
			gl.shaderSource(sh, src)
			gl.compileShader(sh)
			if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh))
			return sh
		}
		const prog = gl.createProgram()
		gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
		gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
		gl.linkProgram(prog)
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog))
		this.prog = prog
		const sProg = gl.createProgram()
		gl.attachShader(sProg, compile(gl.VERTEX_SHADER, SHADOW_VERT))
		gl.attachShader(sProg, compile(gl.FRAGMENT_SHADER, SHADOW_FRAG))
		gl.linkProgram(sProg)
		if (!gl.getProgramParameter(sProg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(sProg))
		this.shadowProg = sProg
		for (const name of ['uPage', 'uViewport', 'uPan', 'uDir', 'uFoldPoint', 'uFoldDir', 'uFoldNormal', 'uRadius', 'uFront', 'uBack']) this.u[name] = gl.getUniformLocation(prog, name)
		for (const name of ['uPage', 'uViewport', 'uPan', 'uDir', 'uFoldPoint', 'uFoldNormal', 'uRadius']) this.shadowU[name] = gl.getUniformLocation(sProg, name)
		this.pageLoc = gl.getAttribLocation(prog, 'aGrid')
		this.shadowLoc = gl.getAttribLocation(sProg, 'aQuad')

		const mobileGrid = IS_MOBILE()
		const NX = mobileGrid ? 150 : 240
		const NY = mobileGrid ? 75 : 120
		const rows = NY + 1
		const verts = new Float32Array((NX + 1) * rows * 2)
		let vi = 0
		for (let i = 0; i <= NX; i++) {
			const u = i / NX
			for (let j = 0; j <= NY; j++) {
				verts[vi++] = u
				verts[vi++] = j / NY
			}
		}
		const indices = new Uint16Array(NX * NY * 6)
		let ii = 0
		for (let i = 0; i < NX; i++) {
			for (let j = 0; j < NY; j++) {
				const a = i * rows + j
				const b = (i + 1) * rows + j
				const c = (i + 1) * rows + (j + 1)
				const d = i * rows + (j + 1)
				indices[ii++] = a
				indices[ii++] = b
				indices[ii++] = c
				indices[ii++] = a
				indices[ii++] = c
				indices[ii++] = d
			}
		}
		this.indexCount = indices.length

		this.pageVao = gl.createVertexArray()
		gl.bindVertexArray(this.pageVao)
		this.pageBuf = gl.createBuffer()
		gl.bindBuffer(gl.ARRAY_BUFFER, this.pageBuf)
		gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW)
		this.pageIdxBuf = gl.createBuffer()
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.pageIdxBuf)
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
		gl.enableVertexAttribArray(this.pageLoc)
		gl.vertexAttribPointer(this.pageLoc, 2, gl.FLOAT, false, 0, 0)

		this.shadowVao = gl.createVertexArray()
		gl.bindVertexArray(this.shadowVao)
		this.shadowBuf = gl.createBuffer()
		gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowBuf)
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), gl.STATIC_DRAW)
		gl.enableVertexAttribArray(this.shadowLoc)
		gl.vertexAttribPointer(this.shadowLoc, 2, gl.FLOAT, false, 0, 0)
		gl.bindVertexArray(null)

		gl.useProgram(prog)
		gl.uniform1i(this.u.uFront, 0)
		gl.uniform1i(this.u.uBack, 1)
		return true
	},
	texture(img) {
		if (!img || !this.gl || this.gl.isContextLost() || !img.complete || !img.naturalWidth) return null
		if (S.tex.has(img.src)) return touchCache(S.tex, img.src)
		const gl = this.gl
		const t = gl.createTexture()
		gl.bindTexture(gl.TEXTURE_2D, t)
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
		gl.generateMipmap(gl.TEXTURE_2D)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
		S.tex.set(img.src, t)
		trimCache(S.tex, 12, (texture) => gl.deleteTexture(texture))
		return t
	},
	draw({ front, back, fold, dir = 1, page = S.sizes, viewport = S.sizes }) {
		const gl = this.gl
		if (!gl || gl.isContextLost() || !front || !back || !fold) return
		const dpr = Math.min(window.devicePixelRatio || 1, 2)
		const cw = Math.max(1, Math.round(viewport.w * dpr))
		const ch = Math.max(1, Math.round(viewport.h * dpr))
		if (gl.canvas.width !== cw || gl.canvas.height !== ch) {
			gl.canvas.width = cw
			gl.canvas.height = ch
		}
		gl.viewport(0, 0, cw, ch)
		gl.clearColor(0, 0, 0, 0)
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
		gl.disable(gl.DEPTH_TEST)
		gl.enable(gl.BLEND)
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
		if (fold.radius > 2.0) {
			gl.useProgram(this.shadowProg)
			gl.uniform2f(this.shadowU.uPage, page.w, page.h)
			gl.uniform2f(this.shadowU.uViewport, viewport.w, viewport.h)
			gl.uniform1f(this.shadowU.uPan, S.single ? -dir * page.w * 0.5 : 0)
			gl.uniform1f(this.shadowU.uDir, dir)
			gl.uniform2f(this.shadowU.uFoldPoint, fold.point.x, fold.point.y)
			gl.uniform2f(this.shadowU.uFoldNormal, fold.normal.x, fold.normal.y)
			gl.uniform1f(this.shadowU.uRadius, fold.radius)
			gl.bindVertexArray(this.shadowVao)
			gl.drawArrays(gl.TRIANGLES, 0, 6)
		}
		gl.useProgram(this.prog)
		gl.bindVertexArray(this.pageVao)
		gl.enable(gl.DEPTH_TEST)
		gl.depthFunc(gl.LEQUAL)
		gl.depthMask(true)
		gl.uniform2f(this.u.uPage, page.w, page.h)
		gl.uniform2f(this.u.uViewport, viewport.w, viewport.h)
		gl.uniform1f(this.u.uPan, S.single ? -dir * page.w * 0.5 : 0)
		gl.uniform1f(this.u.uDir, dir)
		gl.uniform2f(this.u.uFoldPoint, fold.point.x, fold.point.y)
		gl.uniform2f(this.u.uFoldDir, fold.dir.x, fold.dir.y)
		gl.uniform2f(this.u.uFoldNormal, fold.normal.x, fold.normal.y)
		gl.uniform1f(this.u.uRadius, fold.radius)
		gl.activeTexture(gl.TEXTURE0)
		gl.bindTexture(gl.TEXTURE_2D, front)
		gl.activeTexture(gl.TEXTURE1)
		gl.bindTexture(gl.TEXTURE_2D, back)
		gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0)
		gl.bindVertexArray(null)
	},
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const smoothstep = (a, b, v) => {
	const t = clamp((v - a) / (b - a), 0, 1)
	return t * t * (3 - 2 * t)
}
const easePaper = (t) => 0.5 - 0.5 * Math.cos(t * Math.PI)
const FINGER_HEIGHT = 46
const MIN_RADIUS = 1.5
const MAX_RADIUS = 220

function spreadPages(idx) {
	if (S.single) return { left: null, right: idx >= 0 && idx < S.mf.pageCount ? idx + 1 : null }
	if (idx < 0) return { left: null, right: null }
	if (idx === 0) return { left: null, right: 1 }
	const left = 2 * idx
	const right = 2 * idx + 1
	const n = S.mf.pageCount
	return { left: left <= n ? left : null, right: right <= n ? right : null }
}

function maxSpread() {
	return S.single ? S.mf.pageCount - 1 : Math.floor(S.mf.pageCount / 2)
}

function safeUrl(value, link = false) {
	if (typeof value !== 'string' || !value.trim()) return null
	try {
		const url = new URL(value, location.href)
		return (link ? ['http:', 'https:', 'mailto:', 'tel:'] : ['http:', 'https:']).includes(url.protocol) ? url.href : null
	} catch (_) { return null }
}

function color(value, fallback = 'transparent') {
	return typeof value === 'string' && CSS.supports('color', value) ? value : fallback
}

function blankUrl(p) {
	const canvas = document.createElement('canvas')
	canvas.width = 2
	canvas.height = 2
	const ctx = canvas.getContext('2d')
	ctx.fillStyle = color(p?.background, '#fff')
	ctx.fillRect(0, 0, 2, 2)
	return canvas.toDataURL()
}

function pageUrl(n, tier = 'normal') {
	const p = S.mf.pages[n - 1]
	return p ? safeUrl(p[tier]) || safeUrl(p.normal) || safeUrl(p.large) || blankUrl(p) : null
}

function touchCache(cache, key) {
	const value = cache.get(key)
	cache.delete(key)
	cache.set(key, value)
	return value
}

function trimCache(cache, limit, dispose = () => {}) {
	while (cache.size > limit) {
		const key = cache.keys().next().value
		dispose(cache.get(key))
		cache.delete(key)
	}
}

function findCachedImg(src) {
	for (const cache of [S.imgCache, S.thumbCache, S.largeCache]) {
		if (cache.has(src)) return touchCache(cache, src)
	}
	return null
}

function loadImg(src, cache = S.imgCache, limit = S.imgCacheLimit) {
	if (!src) return Promise.resolve(null)
	const hit = findCachedImg(src)
	if (hit) return Promise.resolve(hit)
	if (S.pendingImg.has(src)) return S.pendingImg.get(src)
	const p = new Promise((resolve) => {
		const img = new Image()
		img.crossOrigin = 'anonymous'
		img.decoding = 'async'
		let settled = false
		const finish = (loaded) => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			img.onload = null
			img.onerror = null
			S.pendingImg.delete(src)
			if (loaded) {
				cache.set(src, img)
				trimCache(cache, limit)
			}
			resolve(loaded ? img : null)
		}
		const timeout = setTimeout(() => finish(false), 8000)
		img.onload = () => finish(true)
		img.onerror = () => finish(false)
		img.src = src
	})
	S.pendingImg.set(src, p)
	return p
}

function idleWait(ms = 60) {
	return new Promise((resolve) => {
		if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: ms + 120 })
		else setTimeout(resolve, ms)
	})
}

function waitImageDisplay(im) {
	if (!im || !im.getAttribute('src') || (im.complete && im.naturalWidth > 0)) return Promise.resolve()
	return new Promise((resolve) => {
		const done = () => {
			im.removeEventListener('load', done)
			im.removeEventListener('error', done)
			resolve()
		}
		im.addEventListener('load', done, { once: true })
		im.addEventListener('error', done, { once: true })
	})
}

// Умная предзагрузка от текущего разворота наружу — не вытесняет соседние страницы из кэша
async function schedulePreload() {
	if (!S.mf) return
	const token = ++S.preloadToken
	await Promise.all([$('#imgLeft'), $('#imgRight')].map(waitImageDisplay))
	if (token !== S.preloadToken || !S.mf) return

	const conn = navigator.connection
	const lowData = Boolean(conn && (conn.saveData || conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g'))
	const perSpread = S.single ? 1 : 2
	const total = maxSpread()
	const maxDist = lowData ? 1 : Math.min(total, Math.max(3, Math.floor((S.imgCacheLimit - 2) / (2 * perSpread))))

	// Сначала гарантируем загрузку текущего разворота в кэш и прогреваем текстуры для мгновенного старта анимации
	const cur = spreadPages(S.spread)
	for (const n of [cur.left, cur.right]) {
		if (!n) continue
		const img = await loadImg(pageUrl(n))
		if (token !== S.preloadToken || !S.mf) return
		if (img && GL.gl) GL.texture(img)
	}

	const queue = []
	for (let d = 1; d <= maxDist; d++) {
		if (S.spread + d <= total) queue.push(S.spread + d)
		if (S.spread - d >= 0) queue.push(S.spread - d)
	}

	for (let i = 0; i < queue.length; i++) {
		if (token !== S.preloadToken || !S.mf) return
		const sp = spreadPages(queue[i])
		const tasks = []
		for (const n of [sp.left, sp.right]) {
			if (!n) continue
			tasks.push(loadImg(safeUrl(S.mf.pages[n - 1]?.thumb), S.thumbCache, 64))
			tasks.push(loadImg(pageUrl(n)).then((img) => {
				if (i < 2 && img && GL.gl && token === S.preloadToken) GL.texture(img)
			}))
		}
		await Promise.all(tasks)
		await idleWait(lowData ? 160 : 50)
	}
}

// текстура для старта анимации: HD из кэша или лёгкое превью — без ожидания сети
function pageTex(n) {
	const src = pageUrl(n)
	const cached = src && findCachedImg(src)
	if (cached) return Promise.resolve(cached)
	const t = safeUrl(S.mf.pages[n - 1]?.thumb)
	return t ? loadImg(t, S.thumbCache, 64) : Promise.resolve(null)
}

function layout() {
	if (!S.mf) return
	if (S.animating || S.dragging) {
		S.layoutPending = true
		return
	}
	S.layoutPending = false
	Hover.cancel()
	const toolbarHeight = $('#toolbar').getBoundingClientRect().height
	document.documentElement.style.setProperty('--toolbar-height', toolbarHeight + 'px')
	const stage = $('#stage')
	const style = getComputedStyle(stage)
	const vw = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
	const vh = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
	const mode = S.mf.settings.singlePageMode
	S.single = mode === 'always' || (mode !== 'never' && (innerWidth < 780 || matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && Math.min(innerWidth, innerHeight) < 900)))
	S.spread = S.single ? S.currentPage - 1 : Math.floor(S.currentPage / 2)
	const ratio = S.mf.page.height / S.mf.page.width
	const cols = S.single ? 1 : 2
	let w = Math.min(vw * 0.94, (vh * 0.94) / ratio * cols)
	let h = (w / cols) * ratio
	if (h > vh * 0.94) {
		h = vh * 0.94
		w = (h / ratio) * cols
	}
	const book = $('#book')
	book.style.width = Math.round(w) + 'px'
	book.style.height = Math.round(h) + 'px'
	book.classList.toggle('single', S.single)
	S.sizes = { w: Math.round(w / cols), h: Math.round(h) }
}

function setImage(el, n) {
	const key = String(n || '')
	if (el.dataset.page === key) return
	el.dataset.page = key
	delete el.dataset.tier
	delete el.dataset.upgrading
	if (n) {
		// лёгкое мини-превью видно сразу, HD-страница догружается поверх
		const thumb = safeUrl(S.mf.pages[n - 1].thumb)
		el.style.backgroundImage = thumb ? 'url("' + thumb + '")' : ''
		el.src = pageUrl(n)
		el.dataset.tier = 'normal'
		el.style.visibility = 'visible'
	} else {
		el.style.backgroundImage = ''
		el.removeAttribute('src')
		el.style.visibility = 'hidden'
	}
}

function upgradeVisibleToLarge() {
	if (!S.mf) return
	for (const el of [$('#imgLeft'), $('#imgRight')]) {
		const n = Number(el.dataset.page)
		if (!n || el.dataset.tier === 'large' || el.dataset.upgrading === String(n)) continue
		const largeSrc = pageUrl(n, 'large')
		if (!largeSrc || largeSrc === el.src) {
			el.dataset.tier = 'large'
			continue
		}
		el.dataset.upgrading = String(n)
		loadImg(largeSrc, S.largeCache, 8).then((img) => {
			if (el.dataset.page !== String(n)) return
			delete el.dataset.upgrading
			if (!img) return
			el.src = largeSrc
			el.dataset.tier = 'large'
		})
	}
}

function renderSpread() {
	const { left, right } = spreadPages(S.spread)
	setImage($('#imgLeft'), left)
	setImage($('#imgRight'), right)
	const book = $('#book')
	book.classList.toggle('cover-front', !S.single && S.spread === 0)
	book.classList.toggle('cover-back', !S.single && S.spread >= maxSpread() && !right)
	book.classList.toggle('has-left', Boolean(left))
	const coverOffset = S.single ? 0 : !left ? -0.25 : !right ? 0.25 : 0
	book.style.left = Math.round(book.offsetWidth * coverOffset) + 'px'
	if (![left, right].includes(S.currentPage)) S.currentPage = right || left || 1
	const cur = S.currentPage
	renderOverlays(left, right)
	$('#pageInput').value = cur
	if (!EMBED) history.replaceState(null, '', '#p=' + cur)
	if (S.curThumb) S.curThumb.classList.remove('cur')
	const nextThumb = $('#thumbList')?.querySelector('img[data-page="' + cur + '"]')
	if (nextThumb) nextThumb.classList.add('cur')
	S.curThumb = nextThumb || null
	const navLeft = $('#navLeft')
	const navRight = $('#navRight')
	if (navLeft) navLeft.style.opacity = S.spread > 0 ? '1' : '0.25'
	if (navRight) navRight.style.opacity = S.spread < maxSpread() ? '1' : '0.25'
	schedulePreload()
}

function pauseMedia() {
	document.querySelectorAll('#overlays video, #overlays audio').forEach((media) => media.pause())
}

function hideOverlays() {
	pauseMedia()
	$('#overlays').hidden = true
}

function renderOverlays(left, right) {
	const root = $('#overlays')
	const key = [left, right, S.single].join(':')
	root.hidden = false
	root.style.setProperty('--page-scale', S.sizes.w / S.mf.page.width)
	if (root.dataset.pages === key) return
	pauseMedia()
	root.replaceChildren()
	root.dataset.pages = key
	for (const [side, n] of [['left', left], ['right', right]]) {
		if (!n) continue
		const page = S.mf.pages[n - 1]
		const layer = document.createElement('div')
		layer.className = 'page-overlay ' + side
		layer.dataset.pageId = page.id
		for (const element of page.elements || []) {
			const link = safeUrl(element.url, true)
			const el = document.createElement(link ? 'a' : 'div')
			el.className = 'page-element'
			el.dataset.elementId = element.id
			if (link) {
				el.href = link
				el.target = '_blank'
				el.rel = 'noopener noreferrer'
				el.setAttribute('aria-label', element.text || 'Открыть ссылку')
			}
			for (const [key, prop] of [['x', 'left'], ['y', 'top'], ['w', 'width'], ['h', 'height']]) el.style[prop] = clamp(Number(element[key]) || 0, 0, 1) * 100 + '%'
			el.style.color = color(element.color, '#000')
			el.style.background = color(element.background)
			el.style.opacity = clamp(element.opacity ?? 1, 0, 1)
			el.style.fontSize = 'calc(' + clamp(Number(element.fontSize) || 16, 1, 500) + 'px * var(--page-scale))'
			el.style.borderRadius = 'calc(' + clamp(Number(element.borderRadius) || 0, 0, 1000) + 'px * var(--page-scale))'
			if (element.type === 'shape') {
				el.style.background = color(element.background || element.color, '#000')
				if (element.shape === 'ellipse') el.style.borderRadius = '50%'
				if (element.shape === 'polygon' && Array.isArray(element.points) && element.points.length >= 3) el.style.clipPath = 'polygon(' + element.points.map((p) => clamp(Number(p.x) || 0, 0, 1) * 100 + '% ' + clamp(Number(p.y) || 0, 0, 1) * 100 + '%').join(',') + ')'
			} else if (['image', 'gif', 'video', 'audio'].includes(element.type)) {
				const media = document.createElement(['image', 'gif'].includes(element.type) ? 'img' : element.type)
				const src = safeUrl(element.src)
				if (src) media.src = src
				if (media.tagName === 'IMG') {
					media.alt = element.text || ''
					media.loading = 'lazy'
					media.decoding = 'async'
					media.draggable = false
				} else {
					media.controls = true
					media.preload = 'metadata'
					media.playsInline = true
					el.classList.add('interactive')
				}
				media.style.objectFit = ['contain', 'cover', 'fill', 'none', 'scale-down'].includes(element.objectFit) ? element.objectFit : 'contain'
				if (element.crop) {
					const x = clamp(Number(element.crop.x) || 0, 0, 1) * 100 + '%'
					const y = clamp(Number(element.crop.y) || 0, 0, 1) * 100 + '%'
					media.style.objectPosition = x + ' ' + y
					media.style.transformOrigin = x + ' ' + y
					media.style.transform = 'scale(' + clamp(Number(element.crop.zoom) || 1, 1, 20) + ')'
				}
				el.appendChild(media)
			} else el.textContent = element.text || ''
			layer.appendChild(el)
		}
		root.appendChild(layer)
	}
}

function switchTab(name) {
	document.querySelectorAll('#panel .tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name))
	$('#thumbList').hidden = name !== 'thumbs'
	$('#tocList').hidden = name !== 'toc'
}

function applySettings() {
	const settings = S.mf.settings
	document.body.classList.toggle('print-disabled', settings.allowPrint === false)
	document.documentElement.style.setProperty('--page-ratio', S.mf.page.width / S.mf.page.height)
	for (const [key, variable, fallback] of [['bgColor', '--bg1', '#2b2b2b'], ['bgColor2', '--bg2', '#161616'], ['accent', '--accent', '#1e40af']]) document.documentElement.style.setProperty(variable, color(settings[key], fallback))
	const background = safeUrl(settings.backgroundImage)
	if (background) $('#app').style.backgroundImage = 'url(' + JSON.stringify(background) + ')'
	const logo = safeUrl(settings.logoUrl)
	if (logo) {
		$('#brand').hidden = false
		$('#brand img').src = logo
		$('#brand img').style.width = clamp(settings.logoWidth ?? 120, 0, 1000) + 'px'
		const link = safeUrl(settings.logoLink, true)
		if (link) $('#brand').href = link
	}
	for (const [act, enabled] of [['print', settings.allowPrint !== false], ['download', settings.allowDownload !== false && Boolean(safeUrl(S.mf.pdfUrl))]]) document.querySelectorAll('[data-act="' + act + '"]').forEach((el) => { el.hidden = !enabled })
	S.sound = settings.flipSound !== false
	$('[data-act="sound"]').classList.toggle('active', S.sound)
	$('[data-act="sound"]').setAttribute('aria-pressed', String(S.sound))
	for (const entry of S.mf.toc || []) {
		const index = S.mf.pages.findIndex((p) => p.id === entry.pageId)
		if (index < 0) continue
		const button = document.createElement('button')
		button.textContent = entry.title || 'Страница ' + (index + 1)
		button.dataset.tocId = entry.id
		button.onclick = () => { goToPage(index + 1); $('#panel').classList.remove('open') }
		$('#tocList').appendChild(button)
	}
	const hasToc = $('#tocList').childElementCount > 0
	const thumbsEnabled = settings.showThumbnails !== false
	$('.tab[data-tab="thumbs"]').hidden = !thumbsEnabled
	$('.tab[data-tab="toc"]').hidden = !hasToc
	document.querySelectorAll('[data-act="panel"]').forEach((el) => { el.hidden = !(thumbsEnabled || hasToc) })
	switchTab(hasToc ? 'toc' : 'thumbs')
	$('#pageInput').setAttribute('aria-label', 'Текущая страница')
	document.querySelectorAll('#toolbar button').forEach((button) => button.setAttribute('aria-label', button.title))
	if (STATIC) $('#shareQr').hidden = true
	const canFullscreen = Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled || document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)
	if (!canFullscreen) document.querySelectorAll('[data-act="full"]').forEach((el) => { el.hidden = true })
}

let glHideToken = 0
function finishTurn() {
	pendingDraw = null
	S.animating = false
	if (S.layoutPending) layout()
	renderSpread()
	// не гасим WebGL-кадр, пока страницы разворота не проявились — иначе виден скачок на мини-превью
	const imgs = [$('#imgLeft'), $('#imgRight')]
	const ready = imgs.every((im) => !im.getAttribute('src') || (im.complete && im.naturalWidth > 0))
	if (ready) {
		$('#gl').classList.remove('on')
		return
	}
	const token = ++glHideToken
	const allReady = Promise.all(imgs.map(waitImageDisplay))
	const timeout = new Promise((resolve) => setTimeout(resolve, 2500))
	Promise.race([allReady, timeout]).then(() => {
		if (token !== glHideToken || S.animating || S.dragging) return
		$('#gl').classList.remove('on')
	})
}

function setSpread(target) {
	S.spread = target
	const pages = spreadPages(target)
	S.currentPage = pages.right || pages.left || 1
}

function pagePoint(e, rect, forward) {
	const bx = e.clientX - rect.left
	const by = e.clientY - rect.top - S.sizes.h * 0.5
	if (S.single) return { x: forward ? bx : S.sizes.w - bx, y: by }
	return { x: forward ? bx - S.sizes.w : S.sizes.w - bx, y: by }
}

function rayDistanceToPageBoundary(p, dx, dy) {
	const W = S.sizes.w
	const H = S.sizes.h
	let t = Infinity
	if (dx > 1e-6) t = Math.min(t, (W - p.x) / dx)
	else if (dx < -1e-6) t = Math.min(t, (0 - p.x) / dx)
	if (dy > 1e-6) t = Math.min(t, (H * 0.5 - p.y) / dy)
	else if (dy < -1e-6) t = Math.min(t, (-H * 0.5 - p.y) / dy)
	return isFinite(t) ? Math.max(0, t) : Math.hypot(W, H)
}

function foldFromDrag(grab, finger) {
	const W = S.sizes.w
	const H = S.sizes.h
	const dx = finger.x - grab.x
	const dy = finger.y - grab.y
	const dist = Math.hypot(dx, dy)
	if (dist < 3) return null
	const ux = dx / dist
	const uy = dy / dist
	let delta = 2 * Math.atan2(dist, FINGER_HEIGHT)
	let sG = (FINGER_HEIGHT * FINGER_HEIGHT + dist * dist) / (2 * dist)
	sG *= 0.2 + 0.8 * smoothstep(0, 40, dist)
	const sMax = Math.max(3, rayDistanceToPageBoundary(grab, ux, uy))
	if (sG > sMax) {
		sG = sMax
		delta = Math.acos(clamp(1 - dist / sG, -1, 1))
	}
	const point = {
		x: clamp(grab.x + sG * ux, 0.5, W - 0.5),
		y: clamp(grab.y + sG * uy, -H * 0.5 + 0.5, H * 0.5 - 0.5),
	}
	const spineTop = { x: 0, y: -H * 0.5 }
	const spineBottom = { x: 0, y: H * 0.5 }
	const dot = (a, b) => a.x * b.x + a.y * b.y
	const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y })
	const flatness = smoothstep(0, 0.35, Math.abs(uy))
	const angle0 = Math.atan2(-ux, uy)
	const spineAngle = Math.PI * 0.5
	let da = angle0 - spineAngle
	while (da > Math.PI) da -= Math.PI * 2
	while (da < -Math.PI) da += Math.PI * 2
	const angle = angle0 + da * (1 - flatness)
	const dir = { x: Math.cos(angle), y: Math.sin(angle) }
	let normal = { x: -dir.y, y: dir.x }
	if (dot(sub(grab, point), normal) < 0) {
		normal.x = -normal.x
		normal.y = -normal.y
	}
	const sGrab = Math.max(0.001, dot(sub(grab, point), normal))
	const completion = clamp(sG / Math.max(1, sMax), 0, 1)
	const relax = smoothstep(0.55, 1, completion)
	const startEase = smoothstep(0, 40, dist)
	let radius = (sGrab / Math.max(delta, 0.001)) * (1 - 0.82 * relax)
	radius = clamp(radius, MIN_RADIUS, MAX_RADIUS)
	radius = 90 + (radius - 90) * startEase
	return { point, dir, normal, radius, completion }
}

function restFold() {
	return {
		point: { x: S.sizes.w + 2, y: 0 },
		dir: { x: 0, y: 1 },
		normal: { x: 1, y: 0 },
		radius: 55,
		completion: 0,
	}
}

function finalFold() {
	return {
		point: { x: 0, y: 0 },
		dir: { x: 0, y: 1 },
		normal: { x: 1, y: 0 },
		radius: MIN_RADIUS,
		completion: 1,
	}
}

function foldFromProgress(progress) {
	const p = clamp(progress, 0, 1)
	const relax = smoothstep(0.55, 1, p)
	return {
		point: { x: (S.sizes.w + 2) * (1 - p), y: 0 },
		dir: { x: 0, y: 1 },
		normal: { x: 1, y: 0 },
		radius: 55 * (1 - p) + MIN_RADIUS * p,
		completion: p,
		relax,
	}
}

function smoothFold(prev, next, k) {
	if (!next) return prev
	if (!prev) return next
	const p = clamp(k, 0, 1)
	const mixv = (a, b) => a + (b - a) * p
	let dir = { x: mixv(prev.dir.x, next.dir.x), y: mixv(prev.dir.y, next.dir.y) }
	const dl = Math.hypot(dir.x, dir.y) || 1
	dir.x /= dl
	dir.y /= dl
	let normal = { x: -dir.y, y: dir.x }
	if (normal.x * next.normal.x + normal.y * next.normal.y < 0) normal = { x: -normal.x, y: -normal.y }
	return {
		point: { x: mixv(prev.point.x, next.point.x), y: mixv(prev.point.y, next.point.y) },
		dir,
		normal,
		radius: mixv(prev.radius, next.radius),
		completion: mixv(prev.completion, next.completion),
	}
}

function lerpFold(a, b, t) {
	const p = clamp(t, 0, 1)
	const dir = {
		x: a.dir.x + (b.dir.x - a.dir.x) * p,
		y: a.dir.y + (b.dir.y - a.dir.y) * p,
	}
	const dl = Math.hypot(dir.x, dir.y) || 1
	dir.x /= dl
	dir.y /= dl
	let normal = { x: -dir.y, y: dir.x }
	if (normal.x * a.normal.x + normal.y * a.normal.y < 0) normal = { x: -normal.x, y: -normal.y }
	return {
		point: { x: a.point.x + (b.point.x - a.point.x) * p, y: a.point.y + (b.point.y - a.point.y) * p },
		dir,
		normal,
		radius: a.radius + (b.radius - a.radius) * p,
		completion: a.completion + (b.completion - a.completion) * p,
	}
}

function viewportSize() {
	return { w: (S.single ? S.sizes.w : S.sizes.w * 2) * 2, h: S.sizes.h * 2 }
}

function constrainFold(fold, page) {
	const halfHeight = page.h * 0.5
	const point = { x: Math.max(0, fold.point.x), y: clamp(fold.point.y, -halfHeight, halfHeight) }
	const lower = -Math.atan2(point.x, halfHeight + point.y)
	const upper = Math.atan2(point.x, halfHeight - point.y)
	const angle = clamp(Math.atan2(fold.normal.y, fold.normal.x), lower, upper)
	const normal = { x: Math.cos(angle), y: Math.sin(angle) }
	return { ...fold, point, normal, dir: { x: -normal.y, y: normal.x } }
}

function drawFold(fold, front, back, dir) {
	const page = { w: S.sizes.w, h: S.sizes.h }
	queueDraw({ front, back, fold: constrainFold(fold, page), dir, page, viewport: viewportSize() })
}

let pendingDraw = null
let drawQueued = false
function queueDraw(args) {
	pendingDraw = args
	if (drawQueued) return
	drawQueued = true
	requestAnimationFrame(() => {
		drawQueued = false
		if (pendingDraw) {
			const next = pendingDraw
			pendingDraw = null
			GL.draw(next)
		}
	})
}

function animateFold(from, to, duration, onFrame) {
	return new Promise((resolve, reject) => {
		const start = performance.now()
		let lastFrame = start
		let raf = null
		let finished = false
		const finish = (error) => {
			if (finished) return
			finished = true
			if (raf !== null) cancelAnimationFrame(raf)
			clearInterval(guard)
			if (error) reject(error)
			else resolve()
		}
		const frame = (now) => {
			if (finished) return
			if (raf !== null) cancelAnimationFrame(raf)
			raf = null
			lastFrame = now
			try {
				const t = clamp((now - start) / Math.max(1, duration), 0, 1)
				const fold = lerpFold(from, to, easePaper(t))
				if (onFrame) onFrame(fold, t)
				if (t >= 1) finish()
				else raf = requestAnimationFrame(frame)
			} catch (error) { finish(error) }
		}
		// Timers settle the turn after backgrounding or stalled animation frames.
		const guard = setInterval(() => {
			const now = performance.now()
			if (now - lastFrame > 120) frame(now)
		}, 50)
		raf = requestAnimationFrame(frame)
	})
}

function prepareUnderlay(forward, target) {
	const cur = spreadPages(S.spread)
	const nxt = spreadPages(target)
	hideOverlays()
	if (S.single) {
		setImage($('#imgRight'), nxt.right)
		return
	}
	if (forward) {
		setImage($('#imgRight'), nxt.right)
		setImage($('#imgLeft'), cur.left)
	} else {
		setImage($('#imgLeft'), nxt.left)
		setImage($('#imgRight'), cur.right)
	}
}

async function flip(forward, opts = {}) {
	if (S.animating || S.dragging || Pinch.active) return
	if (S.pinch) Pinch.reset()
	const target = S.spread + (forward ? 1 : -1)
	if (target < 0 || target > maxSpread()) return
	const cur = spreadPages(S.spread)
	const nxt = spreadPages(target)
	const frontPage = S.single ? cur.right : forward ? cur.right : cur.left
	const backPage = S.single ? nxt.right : forward ? nxt.left : nxt.right
	if (!frontPage) return
	S.animating = true
	Hover.cancel()
	const canvas = $('#gl')
	const hasGl = GL.gl
	hideOverlays()
	Sfx.play()
	if (!hasGl) {
		setSpread(target)
		finishTurn()
		return
	}
	try {
		let [fImg, bImg] = await Promise.all([pageTex(frontPage), pageTex(backPage || frontPage)])
		let front = GL.texture(fImg)
		let back = GL.texture(bImg)
		if (!front || !back) throw new Error('Не удалось подготовить страницы')
		// HD-версии догоняют в полёте, если анимация началась на превью
		loadImg(pageUrl(frontPage)).then((img) => { if (img) front = GL.texture(img) })
		loadImg(pageUrl(backPage || frontPage)).then((img) => { if (img) back = GL.texture(img) })
		prepareUnderlay(forward, target)
		canvas.classList.add('on')
		const duration = opts.fromDrag ? Math.max(180, S.mf.settings.flipDuration * 0.55) : S.mf.settings.flipDuration
		const startFold = opts.startFold || foldFromProgress(0)
		const startRadius = opts.radius != null ? opts.radius : startFold.radius
		const startAngle = opts.angle != null ? opts.angle : null
		if (startRadius !== startFold.radius) startFold.radius = startRadius
		await animateFold(startFold, finalFold(), duration, (fold) => {
			if (startAngle != null) {
				const a = Math.PI * 0.5 + (startAngle - Math.PI * 0.5) * (1 - fold.completion)
				fold.dir = { x: Math.cos(a), y: Math.sin(a) }
				fold.normal = { x: -fold.dir.y, y: fold.dir.x }
			}
			drawFold(fold, front, back, forward ? 1 : -1)
		})
		setSpread(target)
	} catch (_) {
		setSpread(target)
	} finally {
		finishTurn()
	}
}

function goToPage(n) {
	if (S.animating || S.dragging) return
	if (S.pinch) Pinch.reset()
	Hover.cancel()
	const page = clamp(Math.floor(Number(n) || 1), 1, S.mf.pageCount)
	S.currentPage = page
	S.spread = S.single ? page - 1 : Math.floor(page / 2)
	renderSpread()
}

const Hover = {
	active: false,
	animId: null,
	corner: null,
	progress: 0,
	target: 0,
	dir: 1,
	grab: null,
	offset: null,
	front: null,
	back: null,
	currentFold: null,
	lastCheck: 0,
	cancel() {
		if (this.animId) {
			cancelAnimationFrame(this.animId)
			this.animId = null
		}
		this.active = false
		this.progress = 0
		this.target = 0
		this.corner = null
		this.grab = null
		this.offset = null
		this.currentFold = null
		const canvas = $('#gl')
		if (canvas && !S.animating && !S.dragging) {
			pendingDraw = null
			canvas.classList.remove('on')
			if (S.mf) renderSpread()
		}
	},
	cornerAt(mx, my, W, H) {
		const size = Math.min(120, Math.min(W * 0.22, H * 0.25))
		let best = null
		let bestDist = Infinity
		const add = (corner, dir, x, y, d) => {
			if (d >= size || d >= bestDist) return
			best = { corner, dir, x, y }
			bestDist = d
		}
		if (S.spread < maxSpread()) {
			add('br', 1, W, H * 0.5, Math.hypot(W - mx, H - my))
			add('tr', 1, W, -H * 0.5, Math.hypot(W - mx, my))
		}
		if (S.spread > 0) {
			add('bl', -1, W, H * 0.5, Math.hypot(mx, H - my))
			add('tl', -1, W, -H * 0.5, Math.hypot(mx, my))
		}
		return best
	},
	async check(e, book) {
		if (S.animating || S.dragging || S.pinch || !GL.gl || e.pointerType === 'touch' || matchMedia('(any-pointer: coarse)').matches || !matchMedia('(hover: hover)').matches || e.target.closest('a, button, video, audio, .interactive')) return
		const now = performance.now()
		if (now - this.lastCheck < 16) return
		this.lastCheck = now
		const r = book.getBoundingClientRect()
		const mx = e.clientX - r.left
		const my = e.clientY - r.top
		const hit = this.cornerAt(mx, my, r.width, r.height)
		if (hit) {
			book.style.cursor = 'grab'
			const size = Math.min(120, Math.min(r.width * 0.22, r.height * 0.25))
			const dist = Math.hypot(hit.x - mx, hit.y - my)
			this.target = clamp((1 - dist / size) * 22, 4, 22)
			if (!this.active || this.corner !== hit.corner) {
				this.corner = hit.corner
				this.dir = hit.dir
				this.grab = { x: S.sizes.w, y: hit.y }
				this.offset = { x: -1, y: hit.corner[0] === 'b' ? -1 : 1 }
				this.active = true
				await this.prepare(hit.dir)
			}
			this.startAnim()
		} else if (this.active) {
			book.style.cursor = ''
			this.target = 0
			this.startAnim()
		} else {
			book.style.cursor = ''
		}
	},
	async prepare(dir) {
		const cur = spreadPages(S.spread)
		const target = S.spread + (dir > 0 ? 1 : -1)
		const nxt = spreadPages(target)
		const frontPage = S.single ? cur.right : dir > 0 ? cur.right : cur.left
		const backPage = S.single ? nxt.right : dir > 0 ? nxt.left : nxt.right
		if (!frontPage) return
		const [fImg, bImg] = await Promise.all([pageTex(frontPage), pageTex(backPage || frontPage)])
		if (!fImg || !bImg || !this.active || this.dir !== dir || S.animating || S.dragging) return
		this.front = GL.texture(fImg)
		this.back = GL.texture(bImg)
		prepareUnderlay(dir > 0, target)
		$('#gl').classList.add('on')
	},
	startAnim() {
		if (this.animId) return
		const step = () => {
			this.progress += (this.target - this.progress) * 0.22
			if (this.target === 0 && this.progress < 0.3) this.progress = 0
			const dist = this.progress
			let fold = null
			if (dist > 0.5 && this.grab && this.offset) {
				fold = smoothFold(this.currentFold, foldFromDrag(this.grab, { x: this.grab.x + this.offset.x * dist, y: this.grab.y + this.offset.y * dist }), 0.3)
			}
			this.currentFold = fold
			if (fold && this.front && this.back && !S.dragging && !S.animating) drawFold(fold, this.front, this.back, this.dir)
			if (this.progress > 0 || this.target > 0) {
				this.animId = requestAnimationFrame(step)
			} else {
				this.animId = null
				this.active = false
				if (!S.dragging && !S.animating) {
					$('#gl').classList.remove('on')
					renderSpread()
				}
			}
		}
		this.animId = requestAnimationFrame(step)
	},
}

// Пинч-зум с сохранением фокуса (100–400%), панорама одним пальцем/мышью и сброс двойным тапом/кликом
const Pinch = {
	pointers: new Map(),
	active: false,
	panning: false,
	panPointerId: null,
	scale: 1,
	startDist: 1,
	startScale: 1,
	startCenter: null,
	origin: null,
	basePan: null,
	pan: { x: 0, y: 0 },
	lastPoint: null,
	tapStart: null,
	lastTap: null,
	touchList() {
		const list = []
		for (const p of this.pointers.values()) if (p.type !== 'mouse') list.push(p)
		return list
	},
	bookOrigin() {
		const r = $('#book').getBoundingClientRect()
		return {
			x: r.left + r.width * 0.5 - this.pan.x,
			y: r.top + r.height * 0.5 - this.pan.y,
		}
	},
	reset() {
		this.scale = 1
		this.pan = { x: 0, y: 0 }
		this.active = false
		this.panning = false
		this.panPointerId = null
		this.lastPoint = null
		this.tapStart = null
		S.pinch = false
		this.apply()
	},
	apply() {
		const book = $('#book')
		const zoomBtn = $('[data-act="zoom"]')
		if (this.scale > 1.01) {
			const stage = $('#stage')
			const bw = book.offsetWidth
			const bh = book.offsetHeight
			const sw = stage.clientWidth
			const sh = stage.clientHeight
			const edgePad = 24 * clamp((this.scale - 1) / 0.3, 0, 1)
			const limX = Math.max(bw * (this.scale - 1) * 0.5, (bw * this.scale - sw) * 0.5 + edgePad, 0)
			const limY = Math.max(bh * (this.scale - 1) * 0.5, (bh * this.scale - sh) * 0.5 + edgePad, 0)
			this.pan.x = clamp(this.pan.x, -limX, limX)
			this.pan.y = clamp(this.pan.y, -limY, limY)
			book.classList.add('pinch')
			book.style.setProperty('--pinch-s', this.scale.toFixed(3))
			book.style.setProperty('--pinch-x', this.pan.x.toFixed(1) + 'px')
			book.style.setProperty('--pinch-y', this.pan.y.toFixed(1) + 'px')
			S.pinch = true
			if (zoomBtn) {
				zoomBtn.classList.add('active')
				zoomBtn.setAttribute('aria-pressed', 'true')
			}
			if (this.scale > 1.15) upgradeVisibleToLarge()
		} else {
			book.classList.remove('pinch')
			book.style.removeProperty('--pinch-s')
			book.style.removeProperty('--pinch-x')
			book.style.removeProperty('--pinch-y')
			S.pinch = false
			if (zoomBtn) {
				zoomBtn.classList.remove('active')
				zoomBtn.setAttribute('aria-pressed', 'false')
			}
		}
	},
	zoomAt(nextScale, clientX, clientY) {
		const s0 = this.scale
		const s1 = clamp(nextScale, 1, 4)
		if (s1 <= 1.01) {
			this.reset()
			return
		}
		const o = this.bookOrigin()
		const ratio = s1 / s0
		this.scale = s1
		this.pan.x = (clientX - o.x) - (clientX - o.x - this.pan.x) * ratio
		this.pan.y = (clientY - o.y) - (clientY - o.y - this.pan.y) * ratio
		this.apply()
	},
	dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) },
	beginPinch(stage) {
		const [a, b] = this.touchList()
		if (!a || !b) return
		this.active = true
		this.panning = false
		this.panPointerId = null
		this.tapStart = null
		this.startDist = Math.max(1, this.dist(a, b))
		this.startScale = this.scale
		this.startCenter = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 }
		this.origin = this.bookOrigin()
		this.basePan = { x: this.pan.x, y: this.pan.y }
		stage.dispatchEvent(new Event('flipvio-cancel-drag'))
		Hover.cancel()
	},
	init() {
		const stage = $('#stage')
		stage.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'mouse' && (this.scale <= 1.01 || e.button !== 0)) return
			if (e.target.closest('button, input, a, video, audio, .interactive')) return
			this.pointers.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType })
			const touches = this.touchList()
			if (touches.length === 2 && !S.animating) {
				this.beginPinch(stage)
			} else if (!this.active && this.scale > 1.01 && (e.pointerType === 'mouse' || touches.length === 1)) {
				this.panning = true
				this.panPointerId = e.pointerId
				this.lastPoint = { x: e.clientX, y: e.clientY }
				this.tapStart = e.pointerType !== 'mouse' ? { id: e.pointerId, x: e.clientX, y: e.clientY, time: performance.now(), moved: false } : null
			}
		})
		window.addEventListener('pointermove', (e) => {
			const entry = this.pointers.get(e.pointerId)
			if (!entry) return
			entry.x = e.clientX
			entry.y = e.clientY
			const touches = this.touchList()
			if (this.active && touches.length >= 2) {
				const [a, b] = touches
				const nextScale = clamp(this.startScale * (this.dist(a, b) / this.startDist), 1, 4)
				const c = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 }
				const ratio = nextScale / this.startScale
				this.scale = nextScale
				this.pan.x = (c.x - this.origin.x) - (this.startCenter.x - this.origin.x - this.basePan.x) * ratio
				this.pan.y = (c.y - this.origin.y) - (this.startCenter.y - this.origin.y - this.basePan.y) * ratio
				this.lastPoint = null
				this.apply()
			} else if (!this.active && this.panning && e.pointerId === this.panPointerId && this.scale > 1.01) {
				if (this.tapStart && this.tapStart.id === e.pointerId && Math.hypot(e.clientX - this.tapStart.x, e.clientY - this.tapStart.y) > 8) {
					this.tapStart.moved = true
				}
				if (this.lastPoint) {
					this.pan.x += e.clientX - this.lastPoint.x
					this.pan.y += e.clientY - this.lastPoint.y
					this.apply()
				}
				this.lastPoint = { x: e.clientX, y: e.clientY }
			}
		})
		const up = (e) => {
			if (!this.pointers.delete(e.pointerId)) return
			const touches = this.touchList()
			if (this.active) {
				if (touches.length === 1) {
					// остался один палец — переходим в панорамирование
					this.active = false
					if (this.scale > 1.01) {
						this.panning = true
						this.panPointerId = touches[0].id
						this.lastPoint = { x: touches[0].x, y: touches[0].y }
					}
				} else if (touches.length === 0) {
					this.active = false
					this.panning = false
					this.panPointerId = null
					this.lastPoint = null
					if (this.scale <= 1.02) this.reset()
				}
				return
			}
			if (e.pointerId === this.panPointerId) {
				this.panning = false
				this.panPointerId = null
				this.lastPoint = null
			}
			if (e.type !== 'pointercancel' && this.tapStart && this.tapStart.id === e.pointerId && !this.tapStart.moved && this.scale > 1.01) {
				const now = performance.now()
				if (this.lastTap && now - this.lastTap.time < 300 && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 28) {
					this.lastTap = null
					this.tapStart = null
					this.reset()
					return
				}
				this.lastTap = { x: e.clientX, y: e.clientY, time: now }
			}
			if (this.tapStart && this.tapStart.id === e.pointerId) this.tapStart = null
			if (this.pointers.size === 0 && this.scale <= 1.02 && (S.pinch || this.scale !== 1)) this.reset()
		}
		window.addEventListener('pointerup', up)
		window.addEventListener('pointercancel', up)
		window.addEventListener('blur', () => {
			this.pointers.clear()
			this.active = false
			this.panning = false
			this.panPointerId = null
			this.lastPoint = null
			this.tapStart = null
		})
		stage.addEventListener('dblclick', () => { if (this.scale > 1.01) this.reset() })
		stage.addEventListener('wheel', (e) => {
			if (S.animating || S.dragging) return
			if (e.ctrlKey || e.metaKey || this.scale > 1.01) {
				e.preventDefault()
				const factor = Math.exp(-e.deltaY * 0.0025)
				this.zoomAt(this.scale * factor, e.clientX, e.clientY)
			}
		}, { passive: false })
	},
}

function initDrag() {
	const book = $('#book')
	const canvas = $('#gl')
	let startInfo = null
	let drag = null
	let lastEvent = null
	S.dragging = false

	const beginDrag = async () => {
		if (!startInfo || drag || startInfo.preparing) return
		const info = startInfo
		info.preparing = true
		const forward = info.forward
		const backward = startInfo.backward
		if (!forward && !backward) return
		const target = S.spread + (forward ? 1 : -1)
		if (target < 0 || target > maxSpread()) return
		const cur = spreadPages(S.spread)
		const nxt = spreadPages(target)
		const frontPage = S.single ? cur.right : forward ? cur.right : cur.left
		const backPage = S.single ? nxt.right : forward ? nxt.left : nxt.right
		if (!frontPage) return
		const [fImg, bImg] = await Promise.all([pageTex(frontPage), pageTex(backPage || frontPage)])
		if (!fImg || !bImg || startInfo !== info || !S.dragging) return
		const front = GL.texture(fImg)
		const back = GL.texture(bImg)
		if (!front || !back) return
		prepareUnderlay(forward, target)
		canvas.classList.add('on')
		drag = {
			forward,
			target,
			pointerId: info.pointerId,
			grab: startInfo.grab,
			rect: startInfo.rect,
			fold: null,
			front,
			back,
			last: { x: startInfo.grab.x, y: startInfo.grab.y },
			moved: true,
		}
		// Подтягиваем HD-текстуру прямо во время перетаскивания, если старт был с превью
		loadImg(pageUrl(frontPage)).then((img) => {
			if (!img || !drag || drag.target !== target) return
			const tex = GL.texture(img)
			if (tex) {
				drag.front = tex
				if (drag.fold) drawFold(drag.fold, drag.front, drag.back, drag.forward ? 1 : -1)
			}
		})
		loadImg(pageUrl(backPage || frontPage)).then((img) => {
			if (!img || !drag || drag.target !== target) return
			const tex = GL.texture(img)
			if (tex) {
				drag.back = tex
				if (drag.fold) drawFold(drag.fold, drag.front, drag.back, drag.forward ? 1 : -1)
			}
		})
		if (lastEvent) {
			drag.last = pagePoint(lastEvent, drag.rect, drag.forward)
			drag.fold = foldFromDrag(drag.grab, drag.last)
			if (drag.fold) drawFold(drag.fold, drag.front, drag.back, drag.forward ? 1 : -1)
		}
	}

	const onMove = (e) => {
		lastEvent = e
		if (S.pinch || Pinch.active) return
		if (startInfo && e.pointerId !== startInfo.pointerId) return
		if (!drag) {
			if (!startInfo) return
			const dx = e.clientX - startInfo.clientX
			const dy = e.clientY - startInfo.clientY
			if (Math.hypot(dx, dy) > 7) {
				startInfo.moved = true
				if (S.single) {
					// листаем только явным горизонтальным жестом — иначе это скролл/зум
					if (Math.abs(dx) < Math.abs(dy) * 1.25) return
					startInfo.forward = e.clientX < startInfo.clientX
					startInfo.backward = !startInfo.forward
					// захват всегда у свободного края страницы — сгиб получается ровным
					startInfo.grab = { x: S.sizes.w, y: pagePoint(e, startInfo.rect, startInfo.forward).y }
				}
				const target = S.spread + (startInfo.forward ? 1 : -1)
				if (target < 0 || target > maxSpread()) return
				startInfo.gestureAccepted = true
				S.dragging = true
				Hover.cancel()
				beginDrag().catch(() => {})
			}
			return
		}
		const finger = pagePoint(e, drag.rect, drag.forward)
		drag.last = finger
		const fold = smoothFold(drag.fold, foldFromDrag(drag.grab, finger), 0.45)
		if (fold) drag.fold = fold
		if (drag.fold) drawFold(drag.fold, drag.front, drag.back, drag.forward ? 1 : -1)
	}

	const settle = async (d, complete) => {
		if (!d) return
		S.animating = true
		const from = d.fold || restFold()
		const to = complete ? finalFold() : restFold()
		const duration = complete ? Math.max(180, S.mf.settings.flipDuration * 0.55) : 220
		if (complete) Sfx.play()
		try {
			await animateFold(from, to, duration, (fold) => drawFold(fold, d.front, d.back, d.forward ? 1 : -1))
			if (complete) setSpread(d.target)
		} finally {
			finishTurn()
		}
	}

	const onUp = async (e) => {
		if (startInfo && e && e.pointerId !== undefined && e.pointerId !== startInfo.pointerId) return
		window.removeEventListener('pointermove', onMove)
		window.removeEventListener('pointerup', onUp)
		window.removeEventListener('pointercancel', onUp)
		const si = startInfo
		const d = drag
		startInfo = null
		drag = null
		lastEvent = null
		S.dragging = false
		if (S.pinch || Pinch.active) {
			if (d && !Pinch.active) settle(d, false)
			return
		}
		if (!d || !d.moved) {
			if (si && e.type !== 'pointercancel' && !S.animating) {
				const distance = Math.abs((e.clientX ?? si.clientX) - si.clientX)
				const quickSwipe = distance > 35 && performance.now() - si.startedAt < 350
				const fullSwipe = distance > si.rect.width * 0.22
				if (!si.moved || (si.gestureAccepted && (quickSwipe || fullSwipe))) {
					if (si.forward) flip(true)
					else if (si.backward) flip(false)
				}
			}
			return
		}
		if (S.animating) return
		const amount = clamp((d.grab.x - d.last.x) / Math.max(1, d.grab.x), 0, 1)
		const complete = e.type !== 'pointercancel' && (amount > 0.22 || (d.fold && d.fold.completion > 0.45))
		await settle(d, complete)
	}

	$('#stage').addEventListener('flipvio-cancel-drag', () => {
		window.removeEventListener('pointermove', onMove)
		window.removeEventListener('pointerup', onUp)
		window.removeEventListener('pointercancel', onUp)
		const wasDragging = Boolean(drag)
		startInfo = null
		drag = null
		lastEvent = null
		S.dragging = false
		if (wasDragging) {
			pendingDraw = null
			canvas.classList.remove('on')
			renderSpread()
		}
	})
	book.addEventListener('pointermove', (e) => {
		if (!startInfo && !S.dragging && !S.animating) Hover.check(e, book)
	})
	book.addEventListener('pointerleave', () => {
		if (!S.dragging && !S.animating && Hover.active) {
			Hover.target = 0
			Hover.startAnim()
		}
	})
	book.addEventListener('pointerdown', (e) => {
		if (S.animating || S.pinch || Pinch.active || startInfo || e.button !== 0 || e.isPrimary === false || e.target.closest('button, input, a, video, audio, .interactive')) return
		const r = book.getBoundingClientRect()
		const x = (e.clientX - r.left) / r.width
		const forward = S.single ? x >= 0.35 : x >= 0.5
		const backward = S.single ? x < 0.35 : x < 0.5
		startInfo = {
			clientX: e.clientX,
			clientY: e.clientY,
			startedAt: performance.now(),
			pointerId: e.pointerId,
			grab: pagePoint(e, r, forward),
			forward,
			backward,
			rect: r,
		}
		Hover.cancel()
		window.addEventListener('pointermove', onMove)
		window.addEventListener('pointerup', onUp)
		window.addEventListener('pointercancel', onUp)
	})
}

function buildThumbs() {
	const list = $('#thumbList')
	list.innerHTML = ''
	S.curThumb = null
	S.mf.pages.forEach((p) => {
		const img = new Image()
		img.loading = 'lazy'
		img.decoding = 'async'
		img.src = safeUrl(p.thumb) || blankUrl(p)
		img.dataset.page = p.index
		img.title = 'Страница ' + p.index
		img.onclick = () => {
			goToPage(p.index)
			if (innerWidth < 780) $('#panel').classList.remove('open')
		}
		list.appendChild(img)
	})
}

function openZoom() {
	pauseMedia()
	if (Pinch.scale > 1.01) {
		Pinch.reset()
		return
	}
	const o = Pinch.bookOrigin()
	Pinch.zoomAt(2.25, o.x, o.y)
}

function closeZoom() {
	if (Pinch.scale > 1.01) Pinch.reset()
	const el = $('#zoomView')
	el.setAttribute('hidden', '')
	el.classList.remove('open')
	el.style.setProperty('display', 'none', 'important')
}

function openShare() {
	pauseMedia()
	const n = S.currentPage
	if (STATIC) {
		$('#shareLink').value = location.href.split('#')[0] + '#p=' + n
		$('#shareEmbed').value = '<iframe src="' + location.href.split('#')[0] + '" width="100%" height="600" frameborder="0" allowfullscreen></iframe>'
		$('#qrBox').hidden = true
		$('#shareQr').hidden = true
		const el = $('#shareView')
		el.removeAttribute('hidden')
		el.classList.add('open')
		el.style.setProperty('display', 'flex', 'important')
		return
	}
	const path = S.mf.url || '/b/' + encodeURIComponent(S.mf.publicSlug || S.mf.slug)
	const base = new URL(path, location.origin).href
	const embed = new URL(path.replace(/^\/b\//, '/embed/'), location.origin).href
	$('#shareLink').value = base + '#p=' + n
	$('#shareEmbed').value = '<iframe src="' + embed + '#p=' + n + '" width="100%" height="600" frameborder="0" allowfullscreen></iframe>'
	$('#qrBox').hidden = true
	const el = $('#shareView')
	el.removeAttribute('hidden')
	el.classList.add('open')
	el.style.setProperty('display', 'flex', 'important')
}

function closeShare() {
	const el = $('#shareView')
	el.setAttribute('hidden', '')
	el.classList.remove('open')
	el.style.setProperty('display', 'none', 'important')
}

let qrObjectUrl = null
let qrRequest = 0
async function openQr() {
	const request = ++qrRequest
	$('#qrBox').hidden = false
	$('#qrDownload').disabled = true
	$('#qrStatus').textContent = 'Загрузка QR…'
	$('#qrImg').hidden = true
	try {
		const response = await fetch('/api/qr?text=' + encodeURIComponent($('#shareLink').value))
		if (!response.ok) throw new Error('QR недоступен')
		const blob = await response.blob()
		if (!['image/png', 'image/svg+xml'].includes(blob.type.split(';')[0])) throw new Error('Неверный формат QR')
		if (request !== qrRequest) return
		if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl)
		qrObjectUrl = URL.createObjectURL(blob)
		$('#qrImg').src = qrObjectUrl
		$('#qrImg').hidden = false
		$('#qrDownload').dataset.extension = blob.type.startsWith('image/png') ? 'png' : 'svg'
		$('#qrDownload').disabled = false
		$('#qrStatus').textContent = ''
	} catch (_) {
		if (request === qrRequest) $('#qrStatus').textContent = 'QR недоступен. Скопируйте ссылку.'
	}
}

function toggleAuto() {
	const btn = document.querySelector('[data-act="auto"]')
	if (S.auto) {
		clearInterval(S.auto)
		S.auto = null
		btn.classList.remove('active')
		return
	}
	const sec = S.mf.settings.autoFlipSeconds || 4
	S.auto = setInterval(() => {
		if (S.spread >= maxSpread()) {
			goToPage(1)
		} else {
			flip(true)
		}
	}, sec * 1000)
	btn.classList.add('active')
}

function initUi() {
	document.addEventListener('pointerdown', (e) => Sfx.unlock(e), { capture: true })
	document.addEventListener('keydown', (e) => Sfx.unlock(e), { capture: true })
	closeZoom()
	closeShare()
	const navLeft = $('#navLeft')
	const navRight = $('#navRight')
	if (navLeft) navLeft.addEventListener('click', (e) => { e.stopPropagation(); flip(false) })
	if (navRight) navRight.addEventListener('click', (e) => { e.stopPropagation(); flip(true) })
	document.querySelectorAll('#panel .tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)))
	document.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-act]')
		if (!btn) return
		const act = btn.dataset.act
		if (act === 'next') flip(true)
		if (act === 'prev') flip(false)
		if (act === 'first') goToPage(1)
		if (act === 'last') goToPage(S.mf.pageCount)
		if (act === 'panel') $('#panel').classList.toggle('open')
		if (act === 'zoom') openZoom()
		if (act === 'share') openShare()
		if (act === 'qr') openQr()
		if (act === 'auto') toggleAuto()
		if (act === 'single') {
			if (S.pinch) Pinch.reset()
			S.mf.settings.singlePageMode = S.single ? 'never' : 'always'
			layout()
			renderSpread()
		}
		if (act === 'sound') {
			S.sound = !S.sound
			btn.classList.toggle('active', S.sound)
			btn.setAttribute('aria-pressed', String(S.sound))
			if (!S.sound) Sfx.audio?.pause()
		}
		if (act === 'print' && S.mf.settings.allowPrint !== false) window.print()
		if (act === 'download' && S.mf.settings.allowDownload !== false && safeUrl(S.mf.pdfUrl)) location.href = safeUrl(S.mf.pdfUrl)
		if (act === 'full') {
			const doc = document
			const el = doc.documentElement
			const fsEl = doc.fullscreenElement || doc.webkitFullscreenElement
			if (fsEl) (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc)?.catch?.(() => {})
			else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {})
		}
	})
	$('#pageInput').addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			goToPage(e.target.value)
			e.target.blur()
		}
	})
	window.addEventListener('keydown', (e) => {
		if (e.target.closest('input, textarea, video, audio, a, button, [contenteditable="true"]') && e.key !== 'Escape') return
		if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
			e.preventDefault()
			flip(true)
		} else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
			e.preventDefault()
			flip(false)
		} else if (e.key === 'Home') {
			e.preventDefault()
			goToPage(1)
		} else if (e.key === 'End') {
			e.preventDefault()
			goToPage(S.mf.pageCount)
		} else if (e.key === 'Escape') {
			closeZoom()
			closeShare()
			$('#panel').classList.remove('open')
		}
	})
	$('#zoomClose').addEventListener('click', closeZoom)
	$('#zoomView').addEventListener('click', (e) => {
		if (e.target === $('#zoomView') || e.target === $('#zoomInner')) closeZoom()
	})
	$('#shareClose').addEventListener('click', closeShare)
	$('#shareView').addEventListener('click', (e) => {
		if (e.target === $('#shareView')) closeShare()
	})
	$('#qrDownload').addEventListener('click', () => {
		if (!qrObjectUrl || $('#qrDownload').disabled) return
		const link = document.createElement('a')
		link.href = qrObjectUrl
		link.download = 'flipvio-qr.' + $('#qrDownload').dataset.extension
		link.click()
	})
	$('#shareCopy').addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText($('#shareLink').value)
			$('#shareCopy').textContent = 'Скопировано!'
		} catch (_) {
			$('#shareLink').select()
			$('#shareCopy').textContent = 'Скопируйте выделенную ссылку'
		}
		setTimeout(() => ($('#shareCopy').textContent = 'Копировать ссылку'), 1500)
	})
	let resizeTimer = null
	window.addEventListener('resize', () => {
		clearTimeout(resizeTimer)
		resizeTimer = setTimeout(() => {
			layout()
			if (!S.animating && !S.dragging) {
				renderSpread()
				if (Pinch.scale > 1.01) Pinch.apply()
			}
		}, 80)
	})
	window.addEventListener('hashchange', () => {
		const hash = location.hash.match(/#p=(\d+)/)
		if (hash) goToPage(parseInt(hash[1], 10))
	})
}

async function init() {
	const initialHash = location.hash.match(/#p=(\d+)/)
	try {
		S.imgCacheLimit = IS_MOBILE() ? 20 : 36
		const res = await fetch(STATIC ? MANIFEST_URL : '/api/books/' + encodeURIComponent(slug))
		if (!res.ok) throw new Error('Не удалось загрузить книгу: ' + res.status)
		S.mf = await res.json()
		if (!Array.isArray(S.mf.pages) || !S.mf.pages.length) throw new Error('В книге пока нет страниц')
		S.mf.pageCount = S.mf.pages.length
		S.mf.settings = { flipDuration: 800, singlePageMode: 'auto', ...S.mf.settings }
		S.mf.page = { width: 600, height: 800, ...S.mf.page }
		document.title = (S.mf.title || 'Flipvio') + ' — Читалка'
		$('#pageTotal').textContent = S.mf.pageCount
		try { GL.init($('#gl')) } catch (_) { GL.gl = null }
		applySettings()
		buildThumbs()
		layout()
		initDrag()
		Pinch.init()
		initUi()
		if (initialHash) goToPage(parseInt(initialHash[1], 10))
		else renderSpread()
	} catch (err) {
		console.error(err)
		const message = document.createElement('p')
		message.textContent = 'Ошибка загрузки книги: ' + err.message
		$('#app').replaceChildren(message)
	} finally {
		$('#loader')?.classList.add('hide')
	}
}

document.addEventListener('DOMContentLoaded', init)

if (!window.__flipvio) window.__flipvio = { S, Sfx, Hover, GL, Pinch, foldFromDrag, restFold, finalFold }