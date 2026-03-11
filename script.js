// ── canvas setup ──────────────────────────────────────────────────────────────
const wrap   = document.getElementById('canvas-wrap');
const canvas = document.getElementById('flag-canvas');
const ctx    = canvas.getContext('2d');
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = 'high';

// Pre-render the SVG into an offscreen raster canvas once.
// Using a raster source is dramatically faster than re-drawing SVG each frame.
const SRC_W = 1050, SRC_H = 700;
const src    = document.createElement('canvas');
src.width    = SRC_W;
src.height   = SRC_H;
const srcCtx = src.getContext('2d');

// Two-gate readiness: state restore only runs after BOTH img and svgText are ready,
// so img.onload can't overwrite srcCtx after reloadSVG has already run.
let imgLoaded         = false;
let pendingStateHash  = new URLSearchParams(location.search).get('s');

function onBothReady() {
    if (!imgLoaded || !svgText) return;
    if (pendingStateHash) {
        // Pause before applying so reloadSVG's tmp.onload calls frame()
        cancelAnimationFrame(rafId);
        rafId = null;
        paused = true;
        pauseBtn.textContent = 'Play';
        pauseBtn.classList.add('active');
        applyStateHash(pendingStateHash);
        document.getElementById('hash-input').value = pendingStateHash;
        pendingStateHash = null;
    }
}

const img = new Image(2099, 1399);
img.onload  = () => { srcCtx.drawImage(img, 0, 0, SRC_W, SRC_H); startAnimation(); imgLoaded = true; onBothReady(); };
img.onerror = () => console.error('Could not load flag svg');
img.src     = 'tuebor-flag-v2.svg';

// ── slider wiring ─────────────────────────────────────────────────────────────
const FMT = {
    amp:     x => Math.round(x),  speed:   x => x.toFixed(1),
    freq:    x => x.toFixed(1),   angle:   x => Math.round(x),
    chaos:   x => x.toFixed(2),   hfold:   x => Math.round(x),
    vfold:   x => Math.round(x),  droop:   x => Math.round(x),
    crinkle: x => x.toFixed(2),   shading: x => x.toFixed(2),
    persp:      x => x.toFixed(2),   outline:    x => x.toFixed(1),
    dintensity: x => x.toFixed(1),   flaglevels: x => Math.round(x),
};
Object.keys(FMT).forEach(id => {
    const el  = document.getElementById('sl-' + id);
    const lbl = document.getElementById('lbl-' + id);
    lbl.textContent = FMT[id](+el.value);
    el.addEventListener('input', () => { lbl.textContent = FMT[id](+el.value); if (paused) frame(); });
});
const v = id => parseFloat(document.getElementById('sl-' + id).value);

// ── state hash encode / decode ─────────────────────────────────────────────────
// Encodes all controls into a compact base64url string that can be pasted into
// the URL (?s=…) to restore the exact same flag state.
const STATE_SCHEMA = [
    { id: 'amp',                type: 'slider' },
    { id: 'speed',              type: 'slider' },
    { id: 'freq',               type: 'slider' },
    { id: 'angle',              type: 'slider' },
    { id: 'chaos',              type: 'slider' },
    { id: 'hfold',              type: 'slider' },
    { id: 'vfold',              type: 'slider' },
    { id: 'droop',              type: 'slider' },
    { id: 'crinkle',            type: 'slider' },
    { id: 'shading',            type: 'slider' },
    { id: 'persp',              type: 'slider' },
    { id: 'outline',            type: 'slider' },
    { id: 'flaglevels',         type: 'slider' },
    { id: 'dintensity',         type: 'slider' },
    { id: 'sel-flag-dither',    type: 'select' },
    { id: 'sel-shadow-dither',  type: 'select' },
    { id: 'sel-outline-dither', type: 'select' },
    { id: 'cp-bg',              type: 'color'  },
    { id: 'cp-text',            type: 'color'  },
    { id: 'cp-shadow-color',    type: 'color'  },
];

function encodeStateHash() {
    const vals = STATE_SCHEMA.map(({ id, type }) =>
        type === 'slider'
            ? parseFloat(document.getElementById('sl-' + id).value)
            : document.getElementById(id).value
    );
    vals.push(parseFloat(time.toFixed(4))); // preserve wave position
    return btoa(JSON.stringify(vals))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function applyStateHash(encoded) {
    let vals;
    try {
        const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
        vals = JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)));
    } catch { return false; }
    if (!Array.isArray(vals) || vals.length < STATE_SCHEMA.length) return false;
    STATE_SCHEMA.forEach(({ id, type }, i) => {
        const val = vals[i];
        if (type === 'slider') {
            const el = document.getElementById('sl-' + id);
            if (!el) return;
            el.value = val;
            const lbl = document.getElementById('lbl-' + id);
            if (lbl) lbl.textContent = FMT[id](val);
        } else {
            const el = document.getElementById(id);
            if (el) el.value = val;
        }
    });
    currentBgColor   = document.getElementById('cp-bg').value;
    currentTextColor = document.getElementById('cp-text').value;
    if (vals.length > STATE_SCHEMA.length) time = vals[STATE_SCHEMA.length];
    if (svgText) reloadSVG();
    return true;
}

// ── mesh constants ────────────────────────────────────────────────────────────
const COLS = 52;
const ROWS = 30;
const TAU  = Math.PI * 2;

// ── Bayer ordered-dither matrices ─────────────────────────────────────────────
const BAYER = {
    // Dispersed-dot Bayer
    2: [[0, 2], [3, 1]],
    4: [[ 0,  8,  2, 10], [12,  4, 14,  6], [ 3, 11,  1,  9], [15,  7, 13,  5]],
    8: [
        [ 0, 32,  8, 40,  2, 34, 10, 42],
        [48, 16, 56, 24, 50, 18, 58, 26],
        [12, 44,  4, 36, 14, 46,  6, 38],
        [60, 28, 52, 20, 62, 30, 54, 22],
        [ 3, 35, 11, 43,  1, 33,  9, 41],
        [51, 19, 59, 27, 49, 17, 57, 25],
        [15, 47,  7, 39, 13, 45,  5, 37],
        [63, 31, 55, 23, 61, 29, 53, 21],
    ],
    // 4×4 clustered dot — pixels grow from cell center outward (print halftone look)
    dot4: [
        [12,  4,  5, 13],
        [ 6,  0,  1,  8],
        [ 7,  2,  3,  9],
        [14, 10, 11, 15],
    ],
    // Horizontal line screen — full rows switch on together
    hlines: [
        [ 0,  0,  0,  0,  0,  0,  0,  0],
        [ 8,  8,  8,  8,  8,  8,  8,  8],
        [16, 16, 16, 16, 16, 16, 16, 16],
        [24, 24, 24, 24, 24, 24, 24, 24],
        [32, 32, 32, 32, 32, 32, 32, 32],
        [40, 40, 40, 40, 40, 40, 40, 40],
        [48, 48, 48, 48, 48, 48, 48, 48],
        [56, 56, 56, 56, 56, 56, 56, 56],
    ],
    // 45° diagonal line screen
    dlines: [
        [ 0,  8, 16, 24, 32, 40, 48, 56],
        [56,  0,  8, 16, 24, 32, 40, 48],
        [48, 56,  0,  8, 16, 24, 32, 40],
        [40, 48, 56,  0,  8, 16, 24, 32],
        [32, 40, 48, 56,  0,  8, 16, 24],
        [24, 32, 40, 48, 56,  0,  8, 16],
        [16, 24, 32, 40, 48, 56,  0,  8],
        [ 8, 16, 24, 32, 40, 48, 56,  0],
    ],
};

// Offscreen canvases for dithered shadow and outline compositing
const shadowCanvas  = document.createElement('canvas');
const shadowCtx     = shadowCanvas.getContext('2d');
const outlineCanvas = document.createElement('canvas');
const outlineCtx    = outlineCanvas.getContext('2d');

// ── displacement function ─────────────────────────────────────────────────────
// Returns (dx, dy) pixel offset for a normalised point (nx, ny ∈ 0–1).
//
// Layers:
//   1. Primary wave  – travels in the "wind angle" direction; displaced perpendicular
//   2. Second harmonic – irrational freq ratio stops it ever perfectly repeating
//   3. Chaos field   – diagonal 2D waves; controlled separately
//   4. H Fold        – lateral wave (x displacement driven by ny)
//   5. V Fold        – vertical wave (y displacement driven by nx) ← complement to H Fold
//   6. Droop         – static downward displacement growing toward the free end
//   7. Crinkle       – high-frequency micro-waves giving fabric texture
function displace(nx, ny, t, amp, freq, angle, chaos, hfold, vfold, droop, crinkle) {
    const theta = angle * TAU / 360;

    // Envelope: flag is anchored at pole (left/low nx), free at right edge
    const env = Math.pow(nx, 0.6);

    // Wave phase: travels in direction (cos θ, sin θ) across the flag surface
    const proj  = nx * Math.cos(theta) + ny * Math.sin(theta);
    const phase = freq * proj * TAU - t;
    const phase2 = freq * 1.732 * proj * TAU - t * 1.28; // √3 ratio — never repeats

    const p = Math.sin(phase);
    const q = 0.30 * Math.sin(phase2);

    // Displacement is perpendicular to wave travel — so rotating wind angle
    // naturally rotates the direction the fabric flaps
    const perpX = -Math.sin(theta);
    const perpY =  Math.cos(theta);

    // Chaos: 2-D diagonal waves, always in screen x/y space
    const cx = Math.sin(freq * 1.91 * ny  * TAU + t * 0.82)
             * Math.cos(freq * 1.37 * nx  * TAU - t * 0.56);
    const cy = Math.sin(freq * 1.61 * (nx + ny * 0.68) * TAU - t * 1.04)
             * Math.cos(freq * 2.13 * ny  * TAU + t * 0.73);

    // H Fold: lateral (x) wave driven by vertical position
    // Neighbouring vertical strips slide in opposite directions → cross over
    const fx = Math.sin(freq * 0.77 * ny * TAU - t * 0.88)
             * (0.65 + 0.35 * Math.cos(freq * 0.51 * nx * TAU + t * 0.31))
             + 0.38 * Math.sin(freq * 1.23 * ny * TAU + t * 0.63)
             *        Math.cos(freq * 0.89 * (nx + ny * 0.42) * TAU - t * 0.47);

    // V Fold: vertical (y) wave driven by horizontal position — complement to H Fold
    // Neighbouring horizontal bands slide up/down past each other
    const gy = Math.sin(freq * 0.82 * nx * TAU - t * 0.96)
             * (0.65 + 0.35 * Math.cos(freq * 0.56 * ny * TAU + t * 0.33))
             + 0.38 * Math.sin(freq * 1.19 * nx * TAU + t * 0.71)
             *        Math.cos(freq * 0.87 * (nx * 0.44 + ny) * TAU - t * 0.52);

    // Crinkle: high-frequency micro-waves layered on top (max ±20 px per unit)
    const cr_x = Math.sin(freq * 5.7 * nx * TAU - t * 2.1)
               * Math.cos(freq * 4.3 * ny * TAU + t * 1.8);
    const cr_y = Math.sin(freq * 6.1 * ny * TAU + t * 1.9)
               * Math.cos(freq * 5.2 * nx * TAU - t * 2.3);

    // Droop: static downward displacement growing toward free end
    const droopEnv = Math.pow(nx, 0.8);

    return {
        dx: amp * (env * (p + q) * perpX + chaos * cx) + hfold * fx + crinkle * 20 * cr_x,
        dy: amp * (env * (p + q) * perpY + chaos * cy) + vfold * gy + droop * droopEnv + crinkle * 20 * cr_y,
    };
}

// ── mesh builder ──────────────────────────────────────────────────────────────
function buildGrid(flagW, flagH, t, amp, freq, angle, chaos, hfold, vfold, droop, crinkle, persp, ox, oy) {
    const grid = [];
    for (let r = 0; r <= ROWS; r++) {
        const row = [];
        for (let c = 0; c <= COLS; c++) {
            const nx = c / COLS;
            const ny = r / ROWS;
            const { dx, dy } = displace(nx, ny, t, amp, freq, angle, chaos, hfold, vfold, droop, crinkle);
            // Perspective: scale y-extent around the flag's vertical centre based on x position.
            // Positive persp → right edge taller (tilts top toward viewer on right).
            // Negative persp → right edge shorter (tilts top away from viewer on right).
            const perspScale = 1 + persp * nx;
            row.push({
                sx: ox + nx * flagW + dx,
                sy: oy + flagH * 0.5 + (ny - 0.5) * flagH * perspScale + dy,
                u:  nx * SRC_W,
                v:  ny * SRC_H,
            });
        }
        grid.push(row);
    }
    return grid;
}

// ── affine quad renderer ───────────────────────────────────────────────────────
// One draw call per mesh cell instead of two triangles, exploiting the fact that
// the UV grid is axis-aligned so the affine coefficients simplify to simple
// differences. p11 is included only in the clip quad; the affine is derived
// from p00/p10/p01 (parallelogram approximation — sub-pixel error).
function drawQuad(p00, p10, p11, p01) {
    const du = p10.u - p00.u;
    const dv = p01.v - p00.v;
    if (Math.abs(du * dv) < 0.001) return;

    const a = (p10.sx - p00.sx) / du,  b = (p10.sy - p00.sy) / du;
    const c = (p01.sx - p00.sx) / dv,  d = (p01.sy - p00.sy) / dv;
    const e = p00.sx - a * p00.u - c * p00.v;
    const f = p00.sy - b * p00.u - d * p00.v;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p00.sx, p00.sy);
    ctx.lineTo(p10.sx, p10.sy);
    ctx.lineTo(p11.sx, p11.sy);
    ctx.lineTo(p01.sx, p01.sy);
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(src, 0, 0, SRC_W, SRC_H);
    ctx.restore();
}

// ── animation loop ────────────────────────────────────────────────────────────
let time          = 0;
let paused        = false;
let rafId         = null;
let lastUrlUpdate = 0;

const BASE_PAD = 48;

function frame() {
    const flagW   = wrap.clientWidth  * 0.75;
    const flagH   = wrap.clientHeight * 0.75;
    const amp     = v('amp');
    const speed   = v('speed');
    const freq    = v('freq');
    const angle   = v('angle');
    const chaos   = v('chaos');
    const hfold   = v('hfold');
    const vfold   = v('vfold');
    const droop   = v('droop');
    const crinkle = v('crinkle');
    const shading = v('shading');
    const persp   = v('persp');
    const outline = v('outline');

    // Canvas must accommodate worst-case displacement in every direction.
    // Droop can be negative (upward) so use Math.abs. Perspective can expand
    // the right edge vertically by |persp| * flagH / 2 on each side.
    const hPad = Math.ceil(amp + hfold + crinkle * 20) + BASE_PAD;
    const vPad = Math.ceil(amp + vfold + Math.abs(droop) + Math.abs(persp) * flagH / 2 + crinkle * 20) + BASE_PAD;
    const cw   = Math.round(flagW + hPad * 2);
    const ch   = Math.round(flagH + vPad * 2);

    if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width  = cw;
        canvas.height = ch;
    }

    ctx.clearRect(0, 0, cw, ch);

    const ox = hPad;
    const oy = Math.round(ch / 2 - flagH / 2);

    canvas.style.left = (-ox + (wrap.clientWidth  - flagW) / 2) + 'px';
    canvas.style.top  = (-oy + (wrap.clientHeight - flagH) / 2) + 'px';

    const grid = buildGrid(flagW, flagH, time, amp, freq, angle, chaos, hfold, vfold, droop, crinkle, persp, ox, oy);

    // Original cell area (used to compute compression ratio for shading)
    const origArea = (flagW / COLS) * (flagH / ROWS);

    // ── texture pass ──────────────────────────────────────────────────────────
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            const p00 = grid[r    ][c    ];
            const p10 = grid[r    ][c + 1];
            const p01 = grid[r + 1][c    ];
            const p11 = grid[r + 1][c + 1];
            drawQuad(p00, p10, p11, p01);
        }
    }

    // ── flag texture dithering ────────────────────────────────────────────────
    const flagDither = document.getElementById('sel-flag-dither').value;
    if (flagDither !== 'none') {
        const mat    = BAYER[flagDither];
        const n      = mat.length;
        const maxVal = n * n;
        const levels = Math.round(v('flaglevels'));
        const scale  = 1 / (levels - 1);
        const imgData = ctx.getImageData(0, 0, cw, ch);
        const data    = imgData.data;
        for (let y = 0; y < ch; y++) {
            for (let x = 0; x < cw; x++) {
                const i = (y * cw + x) * 4;
                if (data[i + 3] === 0) continue;
                const t = (mat[y % n][x % n] + 0.5) / maxVal;
                for (let c = 0; c < 3; c++) {
                    const val = data[i + c] / 255;
                    data[i + c] = Math.round(Math.min(1, Math.max(0, Math.floor(val / scale + t) * scale)) * 255);
                }
            }
        }
        ctx.putImageData(imgData, 0, 0);
    }

    // ── shading pass ──────────────────────────────────────────────────────────
    if (shading > 0) {
        const shadowDither = document.getElementById('sel-shadow-dither').value;
        const tgt = shadowDither === 'none' ? ctx : shadowCtx;

        if (shadowDither !== 'none') {
            if (shadowCanvas.width !== cw || shadowCanvas.height !== ch) {
                shadowCanvas.width  = cw;
                shadowCanvas.height = ch;
            }
            shadowCtx.clearRect(0, 0, cw, ch);
        }

        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const p00 = grid[r    ][c    ];
                const p10 = grid[r    ][c + 1];
                const p01 = grid[r + 1][c    ];
                const p11 = grid[r + 1][c + 1];
                const ex = p10.sx - p00.sx,  ey = p01.sx - p00.sx;
                const fx = p10.sy - p00.sy,  fy = p01.sy - p00.sy;
                const signedArea = ex * fy - fx * ey;
                const ratio      = signedArea / origArea;
                if (ratio < 0.99) {
                    const intensity = Math.min(1, Math.max(0, 1 - ratio));
                    tgt.save();
                    tgt.globalAlpha = shading * intensity * 0.75;
                    tgt.fillStyle   = document.getElementById('cp-shadow-color').value;
                    tgt.beginPath();
                    tgt.moveTo(p00.sx, p00.sy);
                    tgt.lineTo(p10.sx, p10.sy);
                    tgt.lineTo(p11.sx, p11.sy);
                    tgt.lineTo(p01.sx, p01.sy);
                    tgt.closePath();
                    tgt.fill();
                    tgt.restore();
                }
            }
        }

        if (shadowDither !== 'none') {
            // Threshold the alpha channel of the shadow layer with a Bayer matrix
            const mat      = BAYER[shadowDither];
            const n        = mat.length;
            const maxVal   = n * n;
            const density  = v('dintensity');
            const imgData  = shadowCtx.getImageData(0, 0, cw, ch);
            const data     = imgData.data;
            for (let y = 0; y < ch; y++) {
                for (let x = 0; x < cw; x++) {
                    const i = (y * cw + x) * 4;
                    if (data[i + 3] === 0) continue;
                    const t = (mat[y % n][x % n] + 0.5) / maxVal;
                    data[i + 3] = (data[i + 3] / 255 * density >= t) ? 255 : 0;
                }
            }
            shadowCtx.putImageData(imgData, 0, 0);
            ctx.drawImage(shadowCanvas, 0, 0);
        }
    }

    // ── flag outline ──────────────────────────────────────────────────────────
    if (outline > 0) {
        const outlineDither = document.getElementById('sel-outline-dither').value;
        const tgt = outlineDither === 'none' ? ctx : outlineCtx;

        if (outlineDither !== 'none') {
            if (outlineCanvas.width !== cw || outlineCanvas.height !== ch) {
                outlineCanvas.width  = cw;
                outlineCanvas.height = ch;
            }
            outlineCtx.clearRect(0, 0, cw, ch);
        }

        const tracePerim = (t) => {
            t.moveTo(grid[0][0].sx, grid[0][0].sy);
            for (let c = 1; c <= COLS; c++) t.lineTo(grid[0][c].sx,      grid[0][c].sy);
            for (let r = 1; r <= ROWS; r++) t.lineTo(grid[r][COLS].sx,   grid[r][COLS].sy);
            for (let c = COLS-1; c >= 0; c--) t.lineTo(grid[ROWS][c].sx, grid[ROWS][c].sy);
            for (let r = ROWS-1; r >= 0; r--) t.lineTo(grid[r][0].sx,    grid[r][0].sy);
            t.closePath();
        };

        tgt.save();
        tgt.beginPath();
        tgt.rect(0, 0, cw, ch);
        tracePerim(tgt);
        tgt.clip('evenodd');

        tgt.beginPath();
        tracePerim(tgt);
        tgt.strokeStyle = currentTextColor;
        tgt.lineWidth   = outline * 2;
        tgt.lineJoin    = 'round';
        tgt.stroke();
        tgt.restore();

        if (outlineDither !== 'none') {
            const mat     = BAYER[outlineDither];
            const n       = mat.length;
            const maxVal  = n * n;
            const density = v('dintensity');
            const imgData = outlineCtx.getImageData(0, 0, cw, ch);
            const data    = imgData.data;
            for (let y = 0; y < ch; y++) {
                for (let x = 0; x < cw; x++) {
                    const i = (y * cw + x) * 4;
                    if (data[i + 3] === 0) continue;
                    const t = (mat[y % n][x % n] + 0.5) / maxVal;
                    data[i + 3] = (data[i + 3] / 255 * density >= t) ? 255 : 0;
                }
            }
            outlineCtx.putImageData(imgData, 0, 0);
            ctx.drawImage(outlineCanvas, 0, 0);
        }
    }

    // ── sync URL and hash input with current state (throttled to ~2×/sec) ────
    const nowMs = Date.now();
    if (nowMs - lastUrlUpdate > 500) {
        const hash = encodeStateHash();
        try { history.replaceState(null, '', '?s=' + hash); } catch {}
        document.getElementById('hash-input').value = hash;
        lastUrlUpdate = nowMs;
    }

    if (!paused) {
        time += speed * 0.022;
        rafId = requestAnimationFrame(frame);
    }
}

function startAnimation() {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(frame);
}

// ── pause / play ──────────────────────────────────────────────────────────────
const pauseBtn = document.getElementById('btn-pause');
pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Play' : 'Pause';
    pauseBtn.classList.toggle('active', paused);
    if (!paused) startAnimation();
});

// ── export helpers ────────────────────────────────────────────────────────────
function getTimestamp() {
    const d   = new Date();
    const pad = n => String(n).padStart(2, '0');
    const file    = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    const display = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return { file, display };
}

function getSettingsText(displayTime) {
    const lbl  = id => document.getElementById('lbl-' + id).textContent;
    const hash = encodeStateHash();
    return [
        'TUEBOR FLAG EXPORT',
        `Exported: ${displayTime}`,
        `State:    ${hash}`,
        '',
        'WAVE',
        `  Amount:       ${lbl('amp')} px`,
        `  Speed:        ${lbl('speed')}`,
        `  Frequency:    ${lbl('freq')}`,
        `  Wind Angle:   ${lbl('angle')}°`,
        '',
        'DEFORMATION',
        `  Chaos:        ${lbl('chaos')}`,
        `  H Fold:       ${lbl('hfold')} px`,
        `  V Fold:       ${lbl('vfold')} px`,
        `  Droop:        ${lbl('droop')} px`,
        `  Crinkle:      ${lbl('crinkle')}`,
        '',
        'VISUAL',
        `  Shading:      ${lbl('shading')}`,
        `  Perspective:  ${lbl('persp')}`,
        `  Outline:      ${lbl('outline')} px`,
        `  Flag Dither:    ${document.getElementById('sel-flag-dither').options[document.getElementById('sel-flag-dither').selectedIndex].text}`,
        `  Flag Levels:    ${lbl('flaglevels')}`,
        `  Shadow Dither:  ${document.getElementById('sel-shadow-dither').options[document.getElementById('sel-shadow-dither').selectedIndex].text}`,
        `  Shadow Color:   ${document.getElementById('cp-shadow-color').value}`,
        `  Outline Dither: ${document.getElementById('sel-outline-dither').options[document.getElementById('sel-outline-dither').selectedIndex].text}`,

        `  Dither Density: ${lbl('dintensity')}`,
        '',
        'COLOR',
        `  Background:   ${currentBgColor}`,
        `  Text/Outline: ${currentTextColor}`,
    ].join('\n');
}

function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 200);
}

// ── export SVG (simplified two-shape) ─────────────────────────────────────────
// Exports as just two paths: one filled polygon for the flag background (the
// warped perimeter) and one compound path for all letters/stars with every
// coordinate individually warped through the same displacement function used
// by the canvas renderer. Shading/dithering effects are omitted.
function buildVectorSVG() {
    const flagW   = wrap.clientWidth  * 0.75;
    const flagH   = wrap.clientHeight * 0.75;
    const amp     = v('amp');
    const freq    = v('freq');
    const angle   = v('angle');
    const chaos   = v('chaos');
    const hfold   = v('hfold');
    const vfold   = v('vfold');
    const droop   = v('droop');
    const crinkle = v('crinkle');
    const persp   = v('persp');
    const outline = v('outline');

    const hPad = Math.ceil(amp + hfold + crinkle * 20) + BASE_PAD;
    const vPad = Math.ceil(amp + vfold + Math.abs(droop) + Math.abs(persp) * flagH / 2 + crinkle * 20) + BASE_PAD;
    const cw   = Math.round(flagW + hPad * 2);
    const ch   = Math.round(flagH + vPad * 2);
    const ox   = hPad;
    const oy   = Math.round(ch / 2 - flagH / 2);

    const grid = buildGrid(flagW, flagH, time, amp, freq, angle, chaos, hfold, vfold, droop, crinkle, persp, ox, oy);

    // ── flag background: warped perimeter polygon ──────────────────────────────
    let perimD = `M${grid[0][0].sx.toFixed(2)},${grid[0][0].sy.toFixed(2)}`;
    for (let c = 1; c <= COLS; c++) perimD += ` L${grid[0][c].sx.toFixed(2)},${grid[0][c].sy.toFixed(2)}`;
    for (let r = 1; r <= ROWS; r++) perimD += ` L${grid[r][COLS].sx.toFixed(2)},${grid[r][COLS].sy.toFixed(2)}`;
    for (let c = COLS - 1; c >= 0; c--) perimD += ` L${grid[ROWS][c].sx.toFixed(2)},${grid[ROWS][c].sy.toFixed(2)}`;
    for (let r = ROWS - 1; r >= 0; r--) perimD += ` L${grid[r][0].sx.toFixed(2)},${grid[r][0].sy.toFixed(2)}`;
    perimD += ' Z';

    // ── warp a point from SVG source coordinates to screen coordinates ─────────
    // Source SVG viewBox is "0 0 1617 1078".
    const SVG_W = 1617, SVG_H = 1078;
    function warpPt(x, y) {
        const nx = x / SVG_W;
        const ny = y / SVG_H;
        const perspScale = 1 + persp * nx;
        const { dx, dy } = displace(nx, ny, time, amp, freq, angle, chaos, hfold, vfold, droop, crinkle);
        return {
            x: ox + nx * flagW + dx,
            y: oy + flagH * 0.5 + (ny - 0.5) * flagH * perspScale + dy,
        };
    }

    // ── warp all coordinates in an SVG path d string ───────────────────────────
    // Handles M/m, L/l, H/h, V/v, C/c, S/s, Z/z. H/V become L since warping
    // breaks axis-alignment. All relative commands resolved to absolute first.
    // S/s (smooth cubic) requires tracking the last cubic control point for reflection.
    function warpPathD(d) {
        const tokens = d.match(/[MmLlHhVvCcSsZz]|[-+]?(?:[0-9]*\.)?[0-9]+(?:[eE][-+]?[0-9]+)?/g) || [];
        let out = '', cmd = 'M';
        let cx = 0, cy = 0, sx = 0, sy = 0;
        let lastCPX = 0, lastCPY = 0; // last cubic control point (for S/s reflection)
        let i = 0;
        const num = () => parseFloat(tokens[i++]);

        while (i < tokens.length) {
            if (/[MmLlHhVvCcSsZz]/.test(tokens[i])) cmd = tokens[i++];
            if (i >= tokens.length && cmd !== 'Z' && cmd !== 'z') break;

            switch (cmd) {
                case 'M': { const x=num(),y=num(); cx=x;cy=y;sx=x;sy=y; const p=warpPt(x,y); out+=`M${p.x.toFixed(2)},${p.y.toFixed(2)}`; cmd='L'; break; }
                case 'm': { const x=cx+num(),y=cy+num(); cx=x;cy=y;sx=x;sy=y; const p=warpPt(x,y); out+=`M${p.x.toFixed(2)},${p.y.toFixed(2)}`; cmd='l'; break; }
                case 'L': { const x=num(),y=num(); const p=warpPt(x,y); cx=x;cy=y; out+=`L${p.x.toFixed(2)},${p.y.toFixed(2)}`; break; }
                case 'l': { const x=cx+num(),y=cy+num(); const p=warpPt(x,y); cx=x;cy=y; out+=`L${p.x.toFixed(2)},${p.y.toFixed(2)}`; break; }
                case 'H': { const x=num(); const p=warpPt(x,cy); cx=x; out+=`L${p.x.toFixed(2)},${p.y.toFixed(2)}`; break; }
                case 'h': { const x=cx+num(); const p=warpPt(x,cy); cx=x; out+=`L${p.x.toFixed(2)},${p.y.toFixed(2)}`; break; }
                case 'V': { const y=num(); const p=warpPt(cx,y); cy=y; out+=`L${p.x.toFixed(2)},${p.y.toFixed(2)}`; break; }
                case 'v': { const y=cy+num(); const p=warpPt(cx,y); cy=y; out+=`L${p.x.toFixed(2)},${p.y.toFixed(2)}`; break; }
                case 'C': { const x1=num(),y1=num(),x2=num(),y2=num(),x=num(),y=num();
                    lastCPX=x2; lastCPY=y2;
                    const p1=warpPt(x1,y1),p2=warpPt(x2,y2),p=warpPt(x,y); cx=x;cy=y;
                    out+=`C${p1.x.toFixed(2)},${p1.y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)} ${p.x.toFixed(2)},${p.y.toFixed(2)}`; break; }
                case 'c': { const ocx=cx,ocy=cy; const x1=ocx+num(),y1=ocy+num(),x2=ocx+num(),y2=ocy+num(),x=ocx+num(),y=ocy+num();
                    lastCPX=x2; lastCPY=y2;
                    const p1=warpPt(x1,y1),p2=warpPt(x2,y2),p=warpPt(x,y); cx=x;cy=y;
                    out+=`C${p1.x.toFixed(2)},${p1.y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)} ${p.x.toFixed(2)},${p.y.toFixed(2)}`; break; }
                case 'S': { const x2=num(),y2=num(),x=num(),y=num();
                    const x1=2*cx-lastCPX, y1=2*cy-lastCPY; // reflected control point
                    lastCPX=x2; lastCPY=y2;
                    const p1=warpPt(x1,y1),p2=warpPt(x2,y2),p=warpPt(x,y); cx=x;cy=y;
                    out+=`C${p1.x.toFixed(2)},${p1.y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)} ${p.x.toFixed(2)},${p.y.toFixed(2)}`; break; }
                case 's': { const x2=cx+num(),y2=cy+num(),x=cx+num(),y=cy+num();
                    const x1=2*cx-lastCPX, y1=2*cy-lastCPY; // reflected control point
                    lastCPX=x2; lastCPY=y2;
                    const p1=warpPt(x1,y1),p2=warpPt(x2,y2),p=warpPt(x,y); cx=x;cy=y;
                    out+=`C${p1.x.toFixed(2)},${p1.y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)} ${p.x.toFixed(2)},${p.y.toFixed(2)}`; break; }
                case 'Z': case 'z': cx=sx;cy=sy; lastCPX=cx;lastCPY=cy; out+='Z'; break;
                default: i++; break;
            }
        }
        return out;
    }

    // ── extract and warp the white letter/star paths ───────────────────────────
    const warpedPaths = [];
    const gMatch = svgText.match(/<g[^>]*fill="#fff"[^>]*>([\s\S]*?)<\/g>/);
    if (gMatch) {
        const pathRe = /<path[^>]*\sd="([^"]*)"[^>]*\/?>/g;
        let m;
        while ((m = pathRe.exec(gMatch[1])) !== null) {
            warpedPaths.push(warpPathD(m[1]));
        }
    }

    // ── assemble SVG: background + text/stars + optional outline ──────────────
    const defs = [];
    const body = [];

    body.push(`<path fill="${currentBgColor}" d="${perimD}"/>`);

    if (warpedPaths.length > 0) {
        body.push(`<path fill="${currentTextColor}" d="${warpedPaths.join(' ')}"/>`);
    }

    if (outline > 0) {
        defs.push(`<clipPath id="oc"><path clip-rule="evenodd" d="M0,0 H${cw} V${ch} H0 Z ${perimD}"/></clipPath>`);
        body.push(`<g clip-path="url(#oc)"><path fill="none" stroke="${currentTextColor}" stroke-width="${(outline * 2).toFixed(1)}" stroke-linejoin="round" d="${perimD}"/></g>`);
    }

    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}">`];
    if (defs.length) parts.push('<defs>', ...defs, '</defs>');
    parts.push(...body, '</svg>');
    return parts.join('\n');
}

document.getElementById('btn-export').addEventListener('click', () => {
    const wasPlaying = !paused;
    if (wasPlaying) {
        paused = true;
        pauseBtn.textContent = 'Play';
        pauseBtn.classList.add('active');
    }

    const ts        = getTimestamp();
    const shortHash = encodeStateHash().slice(0, 8);

    downloadBlob(`tuebor-flag_${ts.file}_${shortHash}.svg`, new Blob([buildVectorSVG()], { type: 'image/svg+xml' }));
    downloadBlob(`tuebor-flag_${ts.file}_${shortHash}.txt`, new Blob([getSettingsText(ts.display)], { type: 'text/plain' }));

    if (wasPlaying) {
        paused = false;
        pauseBtn.textContent = 'Pause';
        pauseBtn.classList.remove('active');
        startAnimation();
    }
});

// ── export PNG ────────────────────────────────────────────────────────────────
// Renders the simplified vector SVG to an offscreen canvas, then exports as PNG.
document.getElementById('btn-export-png').addEventListener('click', () => {
    const ts        = getTimestamp();
    const shortHash = encodeStateHash().slice(0, 8);
    const svgStr    = buildVectorSVG();
    const svgBlob   = new Blob([svgStr], { type: 'image/svg+xml' });
    const svgUrl    = URL.createObjectURL(svgBlob);

    // Parse width/height from the SVG string to size the offscreen canvas correctly
    const wMatch = svgStr.match(/width="(\d+)"/);
    const hMatch = svgStr.match(/height="(\d+)"/);
    const pngW = wMatch ? parseInt(wMatch[1]) : canvas.width;
    const pngH = hMatch ? parseInt(hMatch[1]) : canvas.height;

    const tmpImg = new Image(pngW, pngH);
    tmpImg.onload = () => {
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width  = pngW;
        tmpCanvas.height = pngH;
        const tmpCtx = tmpCanvas.getContext('2d');
        tmpCtx.drawImage(tmpImg, 0, 0);
        URL.revokeObjectURL(svgUrl);
        downloadBlob(`tuebor-flag_${ts.file}_${shortHash}.png`, new Blob(
            [Uint8Array.from(atob(tmpCanvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0))],
            { type: 'image/png' }
        ));
        downloadBlob(`tuebor-flag_${ts.file}_${shortHash}.txt`, new Blob([getSettingsText(ts.display)], { type: 'text/plain' }));
    };
    tmpImg.src = svgUrl;
});

// ── SVG text / color replacement ─────────────────────────────────────────────
let svgText = '';

let currentBgColor   = '#000000';
let currentTextColor = '#ffffff';

function buildModifiedSVG() {
    let modified = svgText;
    // Color replacement — match quoted attribute values to avoid partial matches
    modified = modified.replaceAll('"#000"', `"${currentBgColor}"`);
    modified = modified.replaceAll('"#fff"', `"${currentTextColor}"`);
    return modified;
}

function reloadSVG() {
    if (!svgText) return;
    const blob = new Blob([buildModifiedSVG()], { type: 'image/svg+xml' });
    const url  = URL.createObjectURL(blob);
    const tmp  = new Image(2099, 1399);
    tmp.onload = () => {
        srcCtx.clearRect(0, 0, SRC_W, SRC_H);
        srcCtx.drawImage(tmp, 0, 0, SRC_W, SRC_H);
        URL.revokeObjectURL(url);
        if (paused) frame();
    };
    tmp.src = url;
}

fetch('tuebor-flag-v2.svg').then(r => r.text()).then(t => {
    svgText = t;
    onBothReady();
});

// ── hash bar ──────────────────────────────────────────────────────────────────
function loadFromHashInput() {
    const input = document.getElementById('hash-input');
    let hash = input.value.trim();
    // Accept full URLs — extract the ?s= param if present
    try { const p = new URL(hash).searchParams.get('s'); if (p) hash = p; } catch {}
    if (!hash) return;
    const ok = applyStateHash(hash);
    if (ok) {
        cancelAnimationFrame(rafId);
        rafId = null;
        paused = true;
        pauseBtn.textContent = 'Play';
        pauseBtn.classList.add('active');
        try { history.replaceState(null, '', '?s=' + hash); } catch {}
        input.classList.remove('invalid');
    } else {
        input.classList.add('invalid');
        setTimeout(() => input.classList.remove('invalid'), 1000);
    }
}

document.getElementById('btn-load-hash').addEventListener('click', loadFromHashInput);
document.getElementById('hash-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadFromHashInput();
});

document.getElementById('btn-copy-link').addEventListener('click', () => {
    const hash = encodeStateHash();
    history.replaceState(null, '', '?s=' + hash);
    document.getElementById('hash-input').value = hash;
    lastUrlUpdate = Date.now();
    navigator.clipboard.writeText(location.href).then(() => {
        const btn = document.getElementById('btn-copy-link');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy Link'; }, 1500);
    });
});

document.getElementById('cp-bg').addEventListener('input',   e => { currentBgColor   = e.target.value; reloadSVG(); });
document.getElementById('cp-text').addEventListener('input', e => { currentTextColor = e.target.value; reloadSVG(); });

document.getElementById('sel-flag-dither').addEventListener('change',       () => { if (paused) frame(); });
document.getElementById('sel-shadow-dither').addEventListener('change',      () => { if (paused) frame(); });
document.getElementById('sel-outline-dither').addEventListener('change',     () => { if (paused) frame(); });
document.getElementById('cp-shadow-color').addEventListener('input',         () => { if (paused) frame(); });


// ── randomize flag settings ────────────────────────────────────────────────────
document.getElementById('btn-randomize').addEventListener('click', () => {
    // Cancel any pending RAF and lock to paused state
    cancelAnimationFrame(rafId);
    rafId = null;
    paused = true;
    pauseBtn.textContent = 'Play';
    pauseBtn.classList.add('active');

    const rand = (min, max, step) => {
        const steps = Math.round((max - min) / step);
        return +(min + Math.round(Math.random() * steps) * step).toFixed(10);
    };

    const settings = {
        'sl-amp':     [10,  40,   1   ],
        'sl-speed':   [0.5, 5.0,  0.1 ],
        'sl-freq':    [0.5, 2.0,  0.5 ],
        'sl-angle':   [0,   100,  1   ],
        'sl-chaos':   [0,   0.10, 0.05],
        'sl-hfold':   [0,   5,    1   ],
        'sl-vfold':   [0,   5,    1   ],
        'sl-droop':   [-80, 80,   1   ],
        'sl-crinkle': [0,   0.10, 0.05],
        'sl-shading': [0.1, 0.7,  0.05],
        'sl-persp':   [-0.5, 0.5, 0.05],
    };

    for (const [id, [min, max, step]] of Object.entries(settings)) {
        const el  = document.getElementById(id);
        const key = id.replace('sl-', '');
        const val = rand(min, max, step);
        el.value = val;
        const lbl = document.getElementById('lbl-' + key);
        if (lbl) lbl.textContent = FMT[key](val);
    }

    // Schedule a single clean render (avoids calling frame() while a RAF may still be in flight)
    rafId = requestAnimationFrame(frame);
});
