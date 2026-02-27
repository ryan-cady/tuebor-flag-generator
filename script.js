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
img.onerror = () => console.error('Could not load tuebor-flag-example.svg');
img.src     = 'tuebor-flag-example.svg';

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
    { id: 'sel-shape',          type: 'select' },
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
    currentShape     = document.getElementById('sel-shape').value;
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

// ── affine triangle renderer ──────────────────────────────────────────────────
// Solves for the 2-D affine matrix M such that M·[u,v,1]ᵀ = [sx,sy,1]ᵀ for
// three known correspondences, clips to the triangle, then maps the source
// canvas through M so only the correct texture region is visible.
function drawTri(A, B, C) {
    const denom = (A.u - C.u) * (B.v - C.v) - (B.u - C.u) * (A.v - C.v);
    if (Math.abs(denom) < 0.001) return;

    const a = ((A.sx - C.sx) * (B.v - C.v) - (B.sx - C.sx) * (A.v - C.v)) / denom;
    const b = ((A.sy - C.sy) * (B.v - C.v) - (B.sy - C.sy) * (A.v - C.v)) / denom;
    const c = ((A.u  - C.u ) * (B.sx - C.sx) - (B.u - C.u) * (A.sx - C.sx)) / denom;
    const d = ((A.u  - C.u ) * (B.sy - C.sy) - (B.u - C.u) * (A.sy - C.sy)) / denom;
    const e = A.sx - a * A.u - c * A.v;
    const f = A.sy - b * A.u - d * A.v;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(A.sx, A.sy);
    ctx.lineTo(B.sx, B.sy);
    ctx.lineTo(C.sx, C.sy);
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
            drawTri(p00, p10, p11);
            drawTri(p00, p11, p01);
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
        tgt.strokeStyle = 'white';
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
        'SHAPE',
        `  Stars:        ${currentShape}`,
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

// ── export SVG ────────────────────────────────────────────────────────────────
document.getElementById('btn-export').addEventListener('click', () => {
    const wasPlaying = !paused;
    if (wasPlaying) {
        paused = true;
        pauseBtn.textContent = 'Play';
        pauseBtn.classList.add('active');
    }

    const ts        = getTimestamp();
    const shortHash = encodeStateHash().slice(0, 8);
    const w   = canvas.width;
    const h   = canvas.height;
    const png = canvas.toDataURL('image/png');

    const svgStr = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
        `  <image href="${png}" width="${w}" height="${h}"/>`,
        `</svg>`,
    ].join('\n');

    downloadBlob(`tuebor-flag_${ts.file}_${shortHash}.svg`, new Blob([svgStr], { type: 'image/svg+xml' }));
    downloadBlob(`tuebor-flag_${ts.file}_${shortHash}.txt`, new Blob([getSettingsText(ts.display)], { type: 'text/plain' }));

    if (wasPlaying) {
        paused = false;
        pauseBtn.textContent = 'Pause';
        pauseBtn.classList.remove('active');
        startAnimation();
    }
});

// ── export PNG ────────────────────────────────────────────────────────────────
document.getElementById('btn-export-png').addEventListener('click', () => {
    const ts        = getTimestamp();
    const shortHash = encodeStateHash().slice(0, 8);
    downloadBlob(`tuebor-flag_${ts.file}_${shortHash}.png`, new Blob(
        [Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0))],
        { type: 'image/png' }
    ));
    downloadBlob(`tuebor-flag_${ts.file}_${shortHash}.txt`, new Blob([getSettingsText(ts.display)], { type: 'text/plain' }));
});

// ── star shape replacement ────────────────────────────────────────────────────
let svgText = '';

const STAR_DEFS = [
    { d: 'm1280.95 1216.94-20.63-63.49h-66.75l54-39.23-20.62-63.48 54 39.23 54-39.23-20.63 63.48 54 39.23h-66.75z',   cx: 1280.95, cy: 1133.84 },
    { d: 'm1081.89 1035.09 20.63 63.49h66.75l-54 39.23 20.62 63.48-54-39.23-54 39.23 20.63-63.48-54-39.23h66.75z',     cx: 1081.89, cy: 1118.19 },
    { d: 'm875.185 1216.94-20.626-63.49h-66.747l54-39.23-20.627-63.48 54 39.23 54-39.23-20.626 63.48 54 39.23h-66.747z', cx: 875.19,  cy: 1133.84 },
];

const SHAPE_R = 78;

function polyPoints(cx, cy, r, n, rot) {
    const pts = [];
    for (let i = 0; i < n; i++) {
        const a = rot + (i / n) * Math.PI * 2;
        pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
    }
    return pts.join(' ');
}

function starPoints(cx, cy, R, ri, n) {
    const pts = [];
    for (let i = 0; i < n * 2; i++) {
        const a   = -Math.PI / 2 + (i / (n * 2)) * Math.PI * 2;
        const rad = i % 2 === 0 ? R : ri;
        pts.push(`${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`);
    }
    return pts.join(' ');
}

function heartPoints(cx, cy, r) {
    const scale = r / 16;
    const pts   = [];
    for (let i = 0; i <= 72; i++) {
        const t  = (i / 72) * Math.PI * 2;
        const hx = 16 * Math.pow(Math.sin(t), 3);
        const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
        pts.push(`${(cx + hx * scale).toFixed(2)},${(cy - (hy + 2.75) * scale).toFixed(2)}`);
    }
    return pts.join(' ');
}

function shapeToSVG(name, cx, cy, r) {
    const f = n => n.toFixed(2);
    switch (name) {
        case 'Circle':
            return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}"/>`;

        case 'Triangle':    return `<polygon points="${polyPoints(cx, cy, r, 3, -Math.PI / 2)}"/>`;
        case 'Square':      return `<polygon points="${polyPoints(cx, cy, r, 4, -Math.PI / 4)}"/>`;
        case 'Diamond':     return `<polygon points="${polyPoints(cx, cy, r, 4, 0)}"/>`;
        case 'Pentagon':    return `<polygon points="${polyPoints(cx, cy, r, 5, -Math.PI / 2)}"/>`;
        case 'Hexagon':     return `<polygon points="${polyPoints(cx, cy, r, 6, 0)}"/>`;
        case 'Octagon':     return `<polygon points="${polyPoints(cx, cy, r, 8, Math.PI / 8)}"/>`;

        case 'Star 4-pt':   return `<polygon points="${starPoints(cx, cy, r, r * 0.38, 4)}"/>`;
        case 'Star 6-pt':   return `<polygon points="${starPoints(cx, cy, r, r * 0.50, 6)}"/>`;

        case 'Heart':       return `<polygon points="${heartPoints(cx, cy, r)}"/>`;

        case 'Ring': {
            const r2 = r * 0.48;
            const d  = [
                `M${f(cx - r)} ${f(cy)} A${f(r)} ${f(r)} 0 1 0 ${f(cx + r)} ${f(cy)}`,
                `A${f(r)} ${f(r)} 0 1 0 ${f(cx - r)} ${f(cy)} Z`,
                `M${f(cx - r2)} ${f(cy)} A${f(r2)} ${f(r2)} 0 1 0 ${f(cx + r2)} ${f(cy)}`,
                `A${f(r2)} ${f(r2)} 0 1 0 ${f(cx - r2)} ${f(cy)} Z`,
            ].join(' ');
            return `<path fill-rule="evenodd" d="${d}"/>`;
        }

        case 'Cross': {
            const t  = r * 0.34;
            const d  = [
                `M${f(cx - t)} ${f(cy - r)}`,
                `h${f(t * 2)} v${f(r - t)} h${f(r - t)} v${f(t * 2)}`,
                `h${f(-(r - t))} v${f(r - t)} h${f(-t * 2)} v${f(-(r - t))}`,
                `h${f(-(r - t))} v${f(-t * 2)} h${f(r - t)} Z`,
            ].join(' ');
            return `<path d="${d}"/>`;
        }

        case 'Arrow': {
            const stem = r * 0.32, head = r * 0.52;
            const pts  = [
                `${f(cx)},${f(cy - r)}`,
                `${f(cx + r)},${f(cy - r + head)}`,
                `${f(cx + stem)},${f(cy - r + head)}`,
                `${f(cx + stem)},${f(cy + r)}`,
                `${f(cx - stem)},${f(cy + r)}`,
                `${f(cx - stem)},${f(cy - r + head)}`,
                `${f(cx - r)},${f(cy - r + head)}`,
            ].join(' ');
            return `<polygon points="${pts}"/>`;
        }

        default: return '';
    }
}

const SHAPE_NAMES = [
    'Circle', 'Triangle', 'Square', 'Diamond', 'Pentagon',
    'Hexagon', 'Octagon', 'Star 4-pt', 'Star 6-pt',
    'Heart', 'Ring', 'Cross', 'Arrow',
];

let currentShape     = 'Original';
let currentBgColor   = '#33393d';
let currentTextColor = '#ffffff';

function buildModifiedSVG() {
    let modified = svgText;
    // Shape replacement
    for (const { d, cx, cy } of STAR_DEFS) {
        const original    = `<path d="${d}"/>`;
        const replacement = currentShape === 'Original' ? original : shapeToSVG(currentShape, cx, cy, SHAPE_R);
        modified = modified.replace(original, replacement);
    }
    // Color replacement — match quoted attribute values to avoid partial matches
    modified = modified.replaceAll('"#33393d"', `"${currentBgColor}"`);
    modified = modified.replaceAll('"#fff"',    `"${currentTextColor}"`);
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

function applyShape(name) {
    if (!svgText) return;
    currentShape = name;
    document.getElementById('sel-shape').value = name;
    reloadSVG();
}

fetch('tuebor-flag-example.svg').then(r => r.text()).then(t => {
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

document.getElementById('sel-shape').addEventListener('change', e => {
    applyShape(e.target.value);
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
