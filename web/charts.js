// hand-drawn charts: thin marks, 2px gaps, rounded data ends, a tooltip on every mark
import { dur, el, PHASE } from './core.js';

// one tooltip for the page: any element with data-tip shows it on hover or focus
export function installTooltip() {
  const tip = el('div', { id: 'tip', role: 'tooltip', hidden: true });
  document.body.append(tip);
  const show = (target, x, y) => {
    tip.replaceChildren(...target.dataset.tip.split('\n').map((line, i) => el('div', { class: i ? '' : 'tip-head' }, line)));
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 12));
    const top = y + 16 + r.height > window.innerHeight ? y - r.height - 10 : y + 16;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  document.addEventListener('mousemove', (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    if (t) show(t, e.clientX, e.clientY);
    else tip.hidden = true;
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    if (!t) return;
    const r = t.getBoundingClientRect();
    show(t, r.left, r.bottom - 8);
  });
  document.addEventListener('focusout', () => (tip.hidden = true));
  document.addEventListener('scroll', () => (tip.hidden = true), true);
}

// a horizontal stack of segments over a track; each segment is { value, tone, label }
export function stack(segments, total, opts = {}) {
  const sum = total ?? segments.reduce((a, s) => a + s.value, 0);
  const bar = el('div', { class: `stack${opts.size ? ` ${opts.size}` : ''}`, role: 'img', 'aria-label': segments.filter((s) => s.value).map((s) => `${s.value} ${s.label}`).join(', ') || 'empty' });
  if (!sum) return bar;
  for (const s of segments) {
    if (!s.value) continue;
    bar.append(el('i', { class: `t-${s.tone}${s.hatch ? ' hatch' : ''}`, style: { flexGrow: String(s.value) }, 'data-tip': `${s.label}\n${s.value} of ${sum} · ${Math.round((100 * s.value) / sum)}%` }));
  }
  const rest = sum - segments.reduce((a, s) => a + s.value, 0);
  if (rest > 0) bar.append(el('i', { class: 'track', style: { flexGrow: String(rest) }, 'data-tip': `${opts.restLabel || 'other'}\n${rest} of ${sum}` }));
  return bar;
}

// an epic's leaves by where they stand, in pipeline order
export function rollupSegments(r) {
  const working = Math.max(0, r.active - r.ci - r.ready);
  return [
    { value: r.done, tone: 'done', label: 'done' },
    { value: r.ready, tone: 'ready', label: 'ready to merge' },
    { value: r.ci, tone: 'ci', label: 'in ci' },
    { value: working, tone: 'work', label: 'being worked' },
    { value: r.attention, tone: 'bad', label: 'needs attention' },
    { value: r.queued, tone: 'queued', label: 'queued', hatch: true },
    { value: r.parked || 0, tone: 'parked', label: 'parked' },
  ];
}

export function rollupBar(r, size) {
  return stack(rollupSegments(r), r.total, { size, restLabel: 'open, nobody on it' });
}

export const ROLLUP_LEGEND = [
  ['done', 'done'],
  ['ready', 'ready'],
  ['ci', 'in ci'],
  ['work', 'worked'],
  ['bad', 'attention'],
  ['queued hatch', 'queued'],
  ['parked', 'parked'],
  ['track', 'unowned'],
];

export function legend(items) {
  return el('div', { class: 'legend' }, items.map(([tone, label]) => el('span', {}, el('i', { class: tone === 'track' ? 'track' : `t-${tone.split(' ')[0]}${tone.includes('hatch') ? ' hatch' : ''}` }), label)));
}

// a thin progress meter, done of total
export function meter(doneN, total, tip) {
  const pct = total ? (100 * doneN) / total : 0;
  return el('span', { class: 'meter', 'data-tip': tip || `${doneN} of ${total}` }, el('i', { style: { width: `${pct}%` } }));
}

// a chart drawn at its container's real width, and drawn again when that width changes, so text is never stretched
function responsive(draw, cls) {
  const box = el('div', { class: `chart-box${cls ? ` ${cls}` : ''}` });
  let last = 0;
  const paint = () => {
    const w = Math.round(box.clientWidth);
    if (!w || w === last) return;
    last = w;
    box.replaceChildren(draw(w));
  };
  new ResizeObserver(paint).observe(box);
  return box;
}

// a single-series column chart. points are { label, value, tip }, drawn left to right
export function columns(points, opts = {}) {
  return responsive((w) => drawColumns(points, { ...opts, width: w }));
}

function drawColumns(points, opts) {
  const w = opts.width;
  const h = opts.height || 140;
  const pad = { l: 28, r: 6, t: 8, b: 20 };
  const max = Math.max(1, ...points.map((p) => p.value));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const inner = w - pad.l - pad.r;
  const band = inner / Math.max(1, points.length);
  const bw = Math.min(24, Math.max(3, band - 2));
  const y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / top);
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: 'img', 'aria-label': opts.label || '' });
  for (let v = 0; v <= top; v += step) {
    svg.append(el('line', { class: v ? 'grid' : 'base', x1: pad.l, x2: w - pad.r, y1: y(v), y2: y(v) }));
    svg.append(el('text', { class: 'axis', x: pad.l - 6, y: y(v) + 3, 'text-anchor': 'end' }, String(v)));
  }
  const every = Math.ceil(points.length / Math.max(2, Math.floor(w / 70)));
  points.forEach((p, i) => {
    const x = pad.l + band * i + (band - bw) / 2;
    const top = y(p.value);
    const base = y(0);
    if (p.value > 0) svg.append(el('path', { class: `col t-${opts.tone || 'work'}`, d: roundTop(x, top, bw, base - top, Math.min(4, bw / 2)) }));
    svg.append(el('rect', { class: 'hit', x: pad.l + band * i, y: pad.t, width: band, height: h - pad.t - pad.b, 'data-tip': p.tip || `${p.label}\n${p.value}` }));
    if (i % every === 0) svg.append(el('text', { class: 'axis', x: x + bw / 2, y: h - 6, 'text-anchor': 'middle' }, p.label));
  });
  return svg;
}

function roundTop(x, y, w, h, r) {
  if (h <= r) return `M${x},${y + h}V${y}H${x + w}V${y + h}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceStep(max) {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag);
}

// a small trend line for a tile, no axes
export function spark(values, opts = {}) {
  const w = opts.width || 96;
  const h = opts.height || 26;
  if (values.length < 2) return el('svg', { class: 'spark', viewBox: `0 0 ${w} ${h}` });
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${((w - 2) * i) / (values.length - 1) + 1},${h - 2 - ((h - 4) * v) / max}`);
  return el('svg', { class: 'spark', viewBox: `0 0 ${w} ${h}`, width: w, height: h, 'aria-hidden': 'true' }, el('polyline', { points: pts.join(' ') }), el('circle', { cx: pts[pts.length - 1].split(',')[0], cy: pts[pts.length - 1].split(',')[1], r: 2.5 }));
}

// swimlanes over time: each row is { label, segments: [{ phase, from, to }] }
export function gantt(rows, from, to, opts = {}) {
  return responsive((w) => drawGantt(rows, from, to, { ...opts, width: Math.max(w, 480) }));
}

function drawGantt(rows, from, to, opts) {
  const w = opts.width;
  const lane = 22;
  const head = 22;
  const labelW = opts.labelWidth || 0;
  const h = head + rows.length * lane + 4;
  const x = (t) => labelW + ((w - labelW - 8) * (Math.min(to, Math.max(from, t)) - from)) / (to - from);
  const svg = el('svg', { class: 'chart gantt', viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: 'img', 'aria-label': opts.label || 'timeline' });
  for (const t of ticks(from, to, w - labelW)) {
    svg.append(el('line', { class: 'grid', x1: x(t.at), x2: x(t.at), y1: head - 4, y2: h }));
    svg.append(el('text', { class: 'axis', x: x(t.at) + 3, y: 12 }, t.label));
  }
  rows.forEach((r, i) => {
    const y = head + i * lane;
    if (i % 2) svg.append(el('rect', { class: 'band', x: labelW, y, width: w - labelW, height: lane }));
    for (const s of r.segments) {
      const x0 = x(s.from);
      const x1 = x(s.to);
      if (x1 - x0 < 0.5) continue;
      const tone = PHASE[s.phase]?.tone || 'queued';
      svg.append(el('rect', { class: `seg t-${tone}`, x: x0 + 1, y: y + 5, width: Math.max(1, x1 - x0 - 2), height: lane - 10, rx: Math.min(4, (x1 - x0) / 2), 'data-tip': `${r.label} · ${PHASE[s.phase]?.label || s.phase}\n${dur(s.to - s.from)}${s.open ? ' so far' : ''} · since ${new Date(s.from).toLocaleString()}` }));
    }
  });
  const now = Date.now();
  if (now >= from && now <= to) svg.append(el('line', { class: 'now', x1: x(now), x2: x(now), y1: head - 6, y2: h }));
  return svg;
}

function ticks(from, to, width = 1000) {
  const span = to - from;
  const hour = 3600_000;
  // the finest step that keeps labels at least 80px apart
  const steps = [hour, 2 * hour, 4 * hour, 6 * hour, 12 * hour, 86400_000, 2 * 86400_000, 4 * 86400_000, 7 * 86400_000];
  const step = steps.find((s) => (s / span) * width >= 80) || steps[steps.length - 1];
  const out = [];
  const start = Math.ceil(from / step) * step;
  for (let t = start; t <= to; t += step) {
    const d = new Date(t);
    const label = step < 86400_000 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    out.push({ at: t, label });
  }
  return out;
}

// phase segments of a work item from its history, the last one open to now
export function segmentsOf(w, now = Date.now()) {
  const h = (w.history || []).slice();
  if (!h.length) h.push({ phase: w.phase === 'done' ? 'done' : 'queued', at: w.queuedAt });
  if (h[h.length - 1].phase !== w.phase) h.push({ phase: w.phase, at: w.updatedAt });
  const end = w.finished ? w.finished.at : now;
  const out = [];
  for (let i = 0; i < h.length; i++) {
    const cur = h[i];
    if (cur.phase === 'done') break;
    const next = h[i + 1];
    out.push({ phase: cur.phase, from: cur.at, to: next ? next.at : end, open: !next && !w.finished });
  }
  return out;
}
