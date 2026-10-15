'use strict';
/* ==========================================================================
   charts.js · 可视化库
   ── 纯 SVG 手写，无任何依赖。主题感知（深浅底自动换色）。
   ── 设计原则：图形不只是"画出来"，而是**分析入口**——
      点柱子 = 加筛选条件，框选散点 = 加区间条件，点热力格 = 下钻。
   ── 形状与色彩分层：
      分类色板(10 色) 用于维度；顺序色阶用于量级；发散色阶用于相关/差值。
   ========================================================================== */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* ───────── 调色板 ───────── */
  // 深色主题下的分类色板：高亮度、高饱和，保证在黑底上清晰可辨
  const CAT = ['#38bdf8', '#34d399', '#fbbf24', '#a78bfa', '#f472b6', '#22d3ee', '#a3e635', '#fb923c', '#818cf8', '#facc15'];
  const cat = i => CAT[i % CAT.length];

  const mix = (a, b, f) => `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
  // 顺序色阶（深色主题）：暗底 → 亮色，量级越大越亮
  function seq(t, hue = 'teal') {
    t = Math.max(0, Math.min(1, t));
    const ramp = hue === 'amber' ? [[28, 20, 8], [122, 74, 12], [225, 160, 40], [253, 230, 138]]
      : hue === 'blue' ? [[10, 20, 34], [18, 64, 112], [32, 130, 200], [147, 219, 253]]
        : [[9, 22, 30], [16, 72, 86], [26, 140, 158], [134, 231, 231]];
    const seg = t * (ramp.length - 1), i = Math.min(ramp.length - 2, Math.floor(seg)), f = seg - i;
    return mix(ramp[i], ramp[i + 1], f);
  }
  // 发散色阶（深色主题）：品红(负) ← 暗底(0) → 青(正)
  function div(t) {
    t = Math.max(-1, Math.min(1, t));
    const base = [13, 27, 38];
    return t >= 0 ? mix(base, [56, 189, 248], Math.pow(t, .75)) : mix(base, [244, 114, 182], Math.pow(-t, .75));
  }
  // 热力格文字明暗：比较深字/浅字与单元格实际底色的对比度，谁高用谁
  const relLum = rgb => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(rgb[0]) + .7152 * f(rgb[1]) + .0722 * f(rgb[2]); };
  const parseRGB = s => {
    const t = String(s).trim();
    if (t[0] === '#') { const h = t.length === 4 ? t.slice(1).split('').map(c => c + c).join('') : t.slice(1); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
    const m = t.match(/[\d.]+/g); return m ? [+m[0], +m[1], +m[2]] : [0, 0, 0];
  };
  function textOn(fill) {
    const L = relLum(parseRGB(fill));
    const cDark = (L + .05) / (.05 + relLum([4, 18, 26]));
    const cLight = (relLum([234, 246, 251]) + .05) / (L + .05);
    return cDark >= cLight ? 'bright' : 'dim';
  }

  const fmt = v => (window.DF ? window.DF.fmtNum(v) : String(v));
  const fmtTick = v => {
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k';
    if (a >= 1000) return (v / 1000).toFixed(1) + 'k';
    if (a > 0 && a < 1) return v.toFixed(2);
    return String(Math.round(v * 100) / 100);
  };

  /* ───────── 尺度 ───────── */
  function niceTicks(min, max, count = 5) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
    if (min === max) return [min];
    const span = max - min;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
    const start = Math.ceil(min / step) * step;
    const out = [];
    for (let v = start; v <= max + step * 1e-6; v += step) out.push(Math.round(v / step) * step);
    return out;
  }
  // 真正要画到轴上的刻度：把「格式化后完全一样」的标签合并，并保证最小像素间距。
  // 数据只有一两个不同值时，niceTicks 会给出 5 个几乎相同的值，fmtTick 又把它们压成同一个
  // 字符串（例如 62399 / 62399.5 / … 全是 "62.4k"），不过滤就会叠成一排看不清的字。
  function axisTicks(min, max, count, posOf, minGap = 44) {
    const raw = niceTicks(min, max, count), seen = new Set(), out = [];
    raw.forEach(v => {
      const lab = fmtTick(v);
      if (seen.has(lab)) return;
      if (out.length && posOf && Math.abs(posOf(v) - posOf(out[out.length - 1])) < minGap) return;
      seen.add(lab); out.push(v);
    });
    return out;
  }
  const lin = (d0, d1, r0, r1) => v => r0 + ((v - d0) / ((d1 - d0) || 1)) * (r1 - r0);
  // maxW：条目很少时（例如只有 1 根柱子）别让柱子撑成一整块色板，收窄并居中
  const band = (n, r0, r1, pad = 0.12, maxW = Infinity) => {
    const step = (r1 - r0) / Math.max(n, 1);
    const w = Math.min(step * (1 - pad * 2), maxW);
    return { width: w, pos: i => r0 + step * i + (step - w) / 2, step };
  };

  /* ───────── 提示框 ───────── */
  let tipEl = null;
  function tip() {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'viz-tip'; document.body.appendChild(tipEl); }
    return tipEl;
  }
  function showTip(html, x, y) {
    const t = tip();
    t.innerHTML = html;
    t.classList.add('show');
    const r = t.getBoundingClientRect();
    t.style.left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x - r.width / 2)) + 'px';
    t.style.top = Math.max(8, y - r.height - 14) + 'px';
  }
  const hideTip = () => { if (tipEl) tipEl.classList.remove('show'); };
  window.addEventListener('scroll', hideTip, { passive: true });

  function bindTip(node, htmlFn) {
    node.addEventListener('pointerenter', e => showTip(htmlFn(), e.clientX, e.clientY));
    node.addEventListener('pointermove', e => showTip(htmlFn(), e.clientX, e.clientY));
    node.addEventListener('pointerleave', hideTip);
    node.setAttribute('tabindex', '0');
    node.addEventListener('focus', () => { const r = node.getBoundingClientRect(); showTip(htmlFn(), r.left + r.width / 2, r.top); });
    node.addEventListener('blur', hideTip);
  }

  /* ───────── 动画与骨架 ───────── */
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function replay(host, sel, anim) {
    if (reduce()) return;
    host.querySelectorAll(sel).forEach((n, i) => {
      n.style.animation = 'none';
      void n.getBoundingClientRect();
      n.style.animation = anim.replace('{i}', i);
    });
  }
  function frame(host, title, sub) {
    host.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'viz';
    box.innerHTML = `<div class="viz-head">${title ? `<span class="viz-title">${title}</span>` : ''}${sub ? `<span class="viz-sub">${sub}</span>` : ''}</div>`;
    const body = document.createElement('div');
    body.className = 'viz-body';
    box.appendChild(body);
    host.appendChild(box);
    return body;
  }
  // 每个 svg 带上自身固有宽度：只允许等比缩小，绝不放大——放大后字体会发虚、行距会失控
  // 图形内部文案统一取字典：英文模式下绝不能残留中文
  const T = (k, v) => window.I18N.t(k, v);

  // 图形宽度跟随卡片实际宽度：既填满卡片、又不会被放大到发虚（窗口过窄时回退到设计宽度）
  const fitW = (host, def = 720) => {
    const w = host && host.clientWidth;
    return (!w || w < 240) ? def : Math.max(320, Math.min(1180, w));
  };

  const svg = (w, h) => el('svg', { viewBox: `0 0 ${w} ${h}`, class: 'viz-svg', preserveAspectRatio: 'xMidYMid meet', style: `max-width:${w}px` });
  function axisY(g, sc, ticks, x0, opts = {}) {
    const c = css('--viz-axis') || '#7d8f9a';
    const seen = new Set();
    ticks.forEach(t => {
      const y = sc(t);
      const lab = opts.fmt ? opts.fmt(t) : fmtTick(t);
      if (seen.has(lab)) return;   // 格式化后一模一样的标签只画一次，否则会叠字
      seen.add(lab);
      if (opts.grid !== false) g.appendChild(el('line', { x1: x0, x2: opts.x1 || 0, y1: y, y2: y, class: 'viz-grid' }));
      const label = el('text', { x: x0 - 7, y: y + 3.5, class: 'viz-tick', 'text-anchor': 'end' });
      label.textContent = lab;
      g.appendChild(label);
    });
    void c;
  }

  /* ======================================================================
     1) 柱状图 —— 点击柱子即按该类别筛选
     ====================================================================== */
  function bar(host, spec) {
    const { data, x, y, onPick, picked = [], color = null, horizontal = false, title, sub, unit = '' } = spec;
    const body = frame(host, title, sub);
    const W = fitW(host), H = 300, P = { t: 18, r: 16, b: 46, l: 62 };
    const s = svg(W, H);
    const g = el('g'); s.appendChild(g);
    if (!data.length) { body.innerHTML = `<p class="viz-empty">${T('vizNoData')}</p>`; return; }
    const vals = data.map(d => d[y]);
    const maxV = Math.max(0, ...vals), minV = Math.min(0, ...vals);
    const sc = lin(minV, maxV * 1.08 || 1, H - P.b, P.t);
    axisY(g, sc, niceTicks(minV, maxV * 1.08 || 1, 5), P.l, { x1: W - P.r });
    const b = band(data.length, P.l, W - P.r, 0.18, 116);
    const zero = sc(0);
    data.forEach((d, i) => {
      const v = d[y];
      const isPicked = picked.includes(String(d[x]));
      const col = color ? color(d, i) : (isPicked ? css('--viz-accent') || '#2bb894' : cat(i));
      const rect = el('rect', {
        x: b.pos(i), width: b.width, y: Math.min(zero, sc(v)), height: Math.abs(sc(v) - zero),
        rx: 3, fill: col, class: 'viz-bar', 'data-i': i,
        opacity: picked.length && !isPicked ? 0.32 : 1,
      });
      g.appendChild(rect);
      if (data.length <= 14) {
        const t = el('text', { x: b.pos(i) + b.width / 2, y: Math.min(zero, sc(v)) - 6, class: 'viz-val', 'text-anchor': 'middle' });
        t.textContent = fmtTick(v); g.appendChild(t);
      }
      const lab = el('text', { x: b.pos(i) + b.width / 2, y: H - P.b + 17, class: 'viz-tick viz-cat', 'text-anchor': 'middle' });
      lab.textContent = String(d[x]).length > 10 ? String(d[x]).slice(0, 9) + '…' : d[x];
      g.appendChild(lab);
      if (d.__n != null) {
        const n = el('text', { x: b.pos(i) + b.width / 2, y: H - P.b + 31, class: 'viz-tick viz-dim', 'text-anchor': 'middle' });
        n.textContent = 'n=' + d.__n; g.appendChild(n);
      }
      bindTip(rect, () => `<b>${d[x]}</b><i>${y}: ${fmt(v)}${unit}</i>${d.__n != null ? `<i>${T('vizRows')}: ${d.__n}</i>` : ''}${onPick ? `<i class="viz-hint">${T('clickFilter')}</i>` : ''}`);
      if (onPick) rect.addEventListener('click', () => onPick(String(d[x])));
      rect.style.cursor = onPick ? 'pointer' : 'default';
    });
    body.appendChild(s);
    replay(body, '.viz-bar', 'viz-grow-y .6s cubic-bezier(.2,.8,.2,1) both; animation-delay: calc({i} * 35ms)');
  }

  /* ======================================================================
     2) 分组柱 —— 多系列对比（带图例，可点图例隐藏系列）
     ====================================================================== */
  function groupedBar(host, spec) {
    const { data, x, series, title, sub, onPick, horizontal = false } = spec;
    const body = frame(host, title, sub);
    const W = fitW(host), H = 320, P = { t: 26, r: 16, b: 50, l: 62 };
    const s = svg(W, H), g = el('g'); s.appendChild(g);
    const hidden = new Set();
    const draw = () => {
      g.innerHTML = '';
      const vis = series.filter(k => !hidden.has(k));
      const maxV = Math.max(0, ...data.flatMap(d => vis.map(k => d[k] ?? 0)));
      const sc = lin(0, maxV * 1.1 || 1, H - P.b, P.t);
      axisY(g, sc, niceTicks(0, maxV * 1.1 || 1, 5), P.l, { x1: W - P.r });
      const b = band(data.length, P.l, W - P.r, 0.22, 96);
      const bw = b.width / Math.max(vis.length, 1);
      data.forEach((d, i) => {
        vis.forEach((k, j) => {
          const v = d[k] ?? 0;
          const rect = el('rect', {
            x: b.pos(i) + bw * j, width: bw * 0.9, y: sc(v), height: Math.max(1, H - P.b - sc(v)),
            rx: 2, fill: cat(series.indexOf(k)), class: 'viz-bar', opacity: .95,
          });
          g.appendChild(rect);
          bindTip(rect, () => `<b>${d[x]} · ${k}</b><i>${fmt(v)}</i>`);
          if (onPick) { rect.style.cursor = 'pointer'; rect.addEventListener('click', () => onPick(String(d[x]))); }
        });
        const lab = el('text', { x: b.pos(i) + b.width / 2, y: H - P.b + 17, class: 'viz-tick viz-cat', 'text-anchor': 'middle' });
        lab.textContent = String(d[x]).length > 9 ? String(d[x]).slice(0, 8) + '…' : d[x];
        g.appendChild(lab);
      });
    };
    draw();
    const legend = document.createElement('div');
    legend.className = 'viz-legend';
    series.forEach((k, j) => {
      const b2 = document.createElement('button');
      b2.type = 'button'; b2.className = 'viz-legend-item';
      b2.innerHTML = `<i style="background:${cat(j)}"></i>${k}`;
      b2.addEventListener('click', () => { hidden.has(k) ? hidden.delete(k) : hidden.add(k); b2.classList.toggle('off', hidden.has(k)); draw(); });
      legend.appendChild(b2);
    });
    body.appendChild(s); body.appendChild(legend);
    replay(body, '.viz-bar', 'viz-grow-y .55s cubic-bezier(.2,.8,.2,1) both; animation-delay: calc({i} * 20ms)');
  }

  /* ======================================================================
     3) 堆叠柱 —— 结构与占比
     ====================================================================== */
  function stackedBar(host, spec) {
    const { data, x, series, title, sub, percent = false } = spec;
    const body = frame(host, title, sub);
    const W = fitW(host), H = 320, P = { t: 26, r: 16, b: 50, l: 62 };
    const s = svg(W, H), g = el('g'); s.appendChild(g);
    const totals = data.map(d => series.reduce((n, k) => n + (d[k] || 0), 0));
    const maxV = percent ? 1 : Math.max(...totals, 1);
    const sc = lin(0, maxV * 1.06, H - P.b, P.t);
    axisY(g, sc, niceTicks(0, maxV * 1.06, 5), P.l, { x1: W - P.r, fmt: percent ? v => (v * 100).toFixed(0) + '%' : undefined });
    const b = band(data.length, P.l, W - P.r, 0.28, 96);
    data.forEach((d, i) => {
      let acc = 0;
      series.forEach((k, j) => {
        const raw = d[k] || 0;
        const v = percent ? raw / (totals[i] || 1) : raw;
        const y0 = sc(acc), y1 = sc(acc + v);
        const rect = el('rect', { x: b.pos(i), width: b.width, y: y1, height: Math.max(0.5, y0 - y1), fill: cat(j), class: 'viz-bar' });
        g.appendChild(rect);
        bindTip(rect, () => `<b>${d[x]} · ${k}</b><i>${fmt(raw)}（${((raw / (totals[i] || 1)) * 100).toFixed(1)}%）</i>`);
        acc += v;
      });
      const lab = el('text', { x: b.pos(i) + b.width / 2, y: H - P.b + 17, class: 'viz-tick viz-cat', 'text-anchor': 'middle' });
      lab.textContent = String(d[x]).length > 9 ? String(d[x]).slice(0, 8) + '…' : d[x];
      g.appendChild(lab);
    });
    body.appendChild(s);
    const legend = document.createElement('div'); legend.className = 'viz-legend';
    series.forEach((k, j) => { const sp = document.createElement('span'); sp.className = 'viz-legend-item'; sp.innerHTML = `<i style="background:${cat(j)}"></i>${k}`; legend.appendChild(sp); });
    body.appendChild(legend);
    replay(body, '.viz-bar rect, .viz-bar', 'viz-grow-y .55s cubic-bezier(.2,.8,.2,1) both; animation-delay: calc({i} * 18ms)');
  }

  /* ======================================================================
     4) 折线 / 面积 —— 时间趋势，支持多条线上叠加对比
     ====================================================================== */
  function line(host, spec) {
    const { data, x, series, title, sub, area = true, dash = [], smooth = false } = spec;
    const body = frame(host, title, sub);
    const W = fitW(host), H = 300, P = { t: 22, r: 18, b: 46, l: 62 };
    const s = svg(W, H), g = el('g'); s.appendChild(g);
    const vals = data.flatMap(d => series.map(k => (typeof d[k] === 'number' ? d[k] : null))).filter(v => v != null);
    const minV = Math.min(...vals), maxV = Math.max(...vals);
    const pad = (maxV - minV) * 0.12 || 1;
    const sc = lin(minV - pad, maxV + pad, H - P.b, P.t);
    const scx = lin(0, Math.max(1, data.length - 1), P.l, W - P.r);
    axisY(g, sc, niceTicks(minV - pad, maxV + pad, 5), P.l, { x1: W - P.r });
    // x 轴：均匀抽 6 个刻度
    const step = Math.max(1, Math.ceil(data.length / 6));
    for (let i = 0; i < data.length; i += step) {
      const t = el('text', { x: scx(i), y: H - P.b + 17, class: 'viz-tick', 'text-anchor': 'middle' });
      t.textContent = String(data[i][x]).slice(-5); g.appendChild(t);
    }
    const defs = el('defs'); s.insertBefore(defs, g);
    series.forEach((k, j) => {
      const pts = data.map((d, i) => (typeof d[k] === 'number' && Number.isFinite(d[k]) ? [scx(i), sc(d[k])] : null)).filter(Boolean);
      if (pts.length < 2) return;
      const col = cat(j);
      if (area) {
        const gid = 'grad-' + Math.random().toString(36).slice(2, 8);
        const lg = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
        lg.appendChild(el('stop', { offset: '0%', 'stop-color': col, 'stop-opacity': .34 }));
        lg.appendChild(el('stop', { offset: '100%', 'stop-color': col, 'stop-opacity': .02 }));
        defs.appendChild(lg);
        const dArea = `M ${pts[0][0]} ${H - P.b} ` + pts.map(p => `L ${p[0]} ${p[1]}`).join(' ') + ` L ${pts[pts.length - 1][0]} ${H - P.b} Z`;
        g.appendChild(el('path', { d: dArea, fill: `url(#${gid})`, class: 'viz-area' }));
      }
      const dLine = 'M ' + pts.map(p => `${p[0]} ${p[1]}`).join(' L ');
      const path = el('path', { d: dLine, fill: 'none', stroke: col, 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'viz-line', 'stroke-dasharray': dash.includes(k) ? '6 5' : null });
      g.appendChild(path);
      const len = path.getTotalLength ? path.getTotalLength() : 0;
      if (len && !reduce()) {
        path.style.strokeDasharray = `${len} ${len}`;
        path.style.strokeDashoffset = len;
        path.style.animation = `viz-draw .9s cubic-bezier(.3,.8,.3,1) ${j * 120}ms forwards`;
      }
      // 数据点 + 悬停十字
      pts.forEach((p, i) => {
        const dot = el('circle', { cx: p[0], cy: p[1], r: data.length > 60 ? 0 : 3, fill: col, class: 'viz-dot' });
        bindTip(dot, () => `<b>${data[i][x]}</b><i>${k}: ${fmt(data[i][k])}</i>`);
        g.appendChild(dot);
      });
    });
    body.appendChild(s);
    if (series.length > 1) {
      const legend = document.createElement('div'); legend.className = 'viz-legend';
      series.forEach((k, j) => { const sp = document.createElement('span'); sp.className = 'viz-legend-item'; sp.innerHTML = `<i style="background:${cat(j)}"></i>${k}`; legend.appendChild(sp); });
      body.appendChild(legend);
    }
  }

  /* ======================================================================
     5) 散点 / 气泡 —— 框选即筛选（拖动矩形）
     ====================================================================== */
  function scatter(host, spec) {
    const { data, x, y, size = null, colorBy = null, title, sub, onBrush, brushLabel, brushHint = '' } = spec;
    const body = frame(host, title, sub);
    const W = fitW(host), H = 340, P = { t: 20, r: 18, b: 46, l: 62 };
    const s = svg(W, H), g = el('g'); s.appendChild(g);
    const xs = data.map(d => d[x]).filter(Number.isFinite), ys = data.map(d => d[y]).filter(Number.isFinite);
    const padX = (Math.max(...xs) - Math.min(...xs)) * 0.06 || 1, padY = (Math.max(...ys) - Math.min(...ys)) * 0.08 || 1;
    const scx = lin(Math.min(...xs) - padX, Math.max(...xs) + padX, P.l, W - P.r);
    const scy = lin(Math.min(...ys) - padY, Math.max(...ys) + padY, H - P.b, P.t);
    axisY(g, scy, niceTicks(Math.min(...ys) - padY, Math.max(...ys) + padY, 5), P.l, { x1: W - P.r });
    axisTicks(Math.min(...xs) - padX, Math.max(...xs) + padX, 5, scx).forEach(t => {
      const tt = el('text', { x: scx(t), y: H - P.b + 17, class: 'viz-tick', 'text-anchor': 'middle' });
      tt.textContent = fmtTick(t); g.appendChild(tt);
    });
    const xl = el('text', { x: (W + P.l) / 2, y: H - 6, class: 'viz-axis-name', 'text-anchor': 'middle' }); xl.textContent = x; g.appendChild(xl);
    const yl = el('text', { x: 14, y: H / 2, class: 'viz-axis-name', 'text-anchor': 'middle', transform: `rotate(-90 14 ${H / 2})` }); yl.textContent = y; g.appendChild(yl);
    const cats = colorBy ? [...new Set(data.map(d => String(d[colorBy])))] : [];
    const maxS = size ? Math.max(...data.map(d => d[size] || 0)) : 0;
    const dots = [];
    data.forEach((d, i) => {
      if (!Number.isFinite(d[x]) || !Number.isFinite(d[y])) return;
      const r = size ? 2.6 + 9 * Math.sqrt((d[size] || 0) / (maxS || 1)) : 3.4;
      const fill = colorBy ? cat(cats.indexOf(String(d[colorBy]))) : (css('--viz-accent') || '#2bb894');
      const c = el('circle', { cx: scx(d[x]), cy: scy(d[y]), r, fill, 'fill-opacity': .62, class: 'viz-dot', 'data-i': i });
      bindTip(c, () => `<b>${x}: ${fmt(d[x])}　${y}: ${fmt(d[y])}</i></b>${size ? `<i>${size}: ${fmt(d[size])}</i>` : ''}${colorBy ? `<i>${colorBy}: ${d[colorBy]}</i>` : ''}${onBrush ? `<i class="viz-hint">${T('dragBrush')}</i>` : ''}`);
      g.appendChild(c); dots.push({ c, i });
    });
    // 框选
    if (onBrush) {
      let sx = 0, sy = 0, sel = null, dragging = false;
      const toLocal = e => { const r = s.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H }; };
      s.addEventListener('pointerdown', e => { dragging = true; const p = toLocal(e); sx = p.x; sy = p.y; s.setPointerCapture(e.pointerId); });
      s.addEventListener('pointermove', e => {
        if (!dragging) return;
        const p = toLocal(e);
        if (!sel) { sel = el('rect', { class: 'viz-brush' }); g.appendChild(sel); }
        sel.setAttribute('x', Math.min(sx, p.x)); sel.setAttribute('y', Math.min(sy, p.y));
        sel.setAttribute('width', Math.abs(p.x - sx)); sel.setAttribute('height', Math.abs(p.y - sy));
      });
      s.addEventListener('pointerup', e => {
        if (!dragging) return; dragging = false;
        const p = toLocal(e);
        const x0 = Math.min(sx, p.x), x1 = Math.max(sx, p.x), y0 = Math.min(sy, p.y), y1 = Math.max(sy, p.y);
        if (sel) sel.remove(); sel = null;
        if (x1 - x0 < 8 || y1 - y0 < 8) return;
        const invX = v => Math.min(...xs) - padX + (v - P.l) / ((W - P.r) - P.l) * ((Math.max(...xs) + padX) - (Math.min(...xs) - padX));
        const invY = v => (Math.max(...ys) + padY) - (v - P.t) / ((H - P.b) - P.t) * ((Math.max(...ys) + padY) - (Math.min(...ys) - padY));
        onBrush({ x: [invX(x0), invX(x1)], y: [invY(y1), invY(y0)], label: brushLabel });
      });
      s.classList.add('viz-brushable');
    }
    body.appendChild(s);
    if (cats.length) {
      const legend = document.createElement('div'); legend.className = 'viz-legend';
      cats.forEach((c, j) => { const sp = document.createElement('span'); sp.className = 'viz-legend-item'; sp.innerHTML = `<i style="background:${cat(j)}"></i>${c}`; legend.appendChild(sp); });
      body.appendChild(legend);
    }
    if (onBrush && brushHint) body.insertAdjacentHTML('beforeend', '<p class="viz-hintline"></p>'), body.lastElementChild.textContent = brushHint;
    replay(body, '.viz-dot', 'viz-pop .45s cubic-bezier(.2,.9,.3,1.3) both; animation-delay: calc({i} * 4ms)');
  }

  /* ======================================================================
     6) 直方图 —— 分布形态，柱可点选区间
     ====================================================================== */
  function hist(host, spec) {
    const { values, bins = 24, title, sub, onPick, unit = '' } = spec;
    const body = frame(host, title, sub);
    const W = fitW(host), H = 260, P = { t: 18, r: 16, b: 44, l: 56 };
    const s = svg(W, H), g = el('g'); s.appendChild(g);
    const clean = values.filter(v => typeof v === 'number' && Number.isFinite(v));
    if (!clean.length) { body.innerHTML = `<p class="viz-empty">${T('vizNoNum')}</p>`; return; }
    const min = Math.min(...clean), max = Math.max(...clean);
    const step = (max - min) / bins || 1;
    const counts = new Array(bins).fill(0);
    clean.forEach(v => { const i = Math.min(bins - 1, Math.floor((v - min) / step)); counts[i]++; });
    const maxC = Math.max(...counts);
    const sc = lin(0, maxC * 1.1, H - P.b, P.t);
    axisY(g, sc, niceTicks(0, maxC * 1.1, 4), P.l, { x1: W - P.r, fmt: v => String(Math.round(v)) });
    const b = band(bins, P.l, W - P.r, 0.06);
    counts.forEach((c, i) => {
      const x0 = min + i * step;
      const rect = el('rect', { x: b.pos(i), width: b.width, y: sc(c), height: Math.max(1, H - P.b - sc(c)), rx: 2, fill: seq(c / (maxC || 1), 'blue'), class: 'viz-bar' });
      g.appendChild(rect);
      bindTip(rect, () => `<b>${fmtTick(x0)} – ${fmtTick(x0 + step)}${unit}</b><i>${T('vizFreq')} ${c}　${T('vizShare')} ${(c / clean.length * 100).toFixed(1)}%</i>${onPick ? `<i class="viz-hint">${T('clickBin')}</i>` : ''}`);
      if (onPick) { rect.style.cursor = 'pointer'; rect.addEventListener('click', () => onPick([x0, x0 + step])); }
    });
    axisTicks(min, max, 6, t => b.pos(0) + (t - min) / step * b.step, 52).forEach(t => {
      const tt = el('text', { x: b.pos(0) + (t - min) / step * b.step, y: H - P.b + 17, class: 'viz-tick', 'text-anchor': 'middle' });
      tt.textContent = fmtTick(t); g.appendChild(tt);
    });
    body.appendChild(s);
    replay(body, '.viz-bar', 'viz-grow-y .5s cubic-bezier(.2,.8,.2,1) both; animation-delay: calc({i} * 14ms)');
  }

  /* ======================================================================
     7) 箱线图 —— 分组分布对比（四分位 / 须 / 离群点）
     ====================================================================== */
  function box(host, spec) {
    const { groups, title, sub, unit = '' } = spec;   // groups: [{name, values:[]}]
    const body = frame(host, title, sub);
    const W = fitW(host), H = 320, P = { t: 20, r: 16, b: 48, l: 62 };
    const s = svg(W, H), g = el('g'); s.appendChild(g);
    const all = groups.flatMap(x => x.values).filter(Number.isFinite);
    if (!all.length) { body.innerHTML = `<p class="viz-empty">${T('vizNoData')}</p>`; return; }
    const min = Math.min(...all), max = Math.max(...all);
    const sc = lin(min - (max - min) * .06, max + (max - min) * .06, H - P.b, P.t);
    axisY(g, sc, niceTicks(min, max, 5), P.l, { x1: W - P.r });
    const b = band(groups.length, P.l, W - P.r, 0.3, 150);
    groups.forEach((grp, i) => {
      const v = [...grp.values].filter(Number.isFinite).sort((a, c) => a - c);
      if (!v.length) return;
      const q = p => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
      const q1 = q(.25), q2 = q(.5), q3 = q(.75), iqr = q3 - q1;
      const lo = Math.max(v[0], q1 - 1.5 * iqr), hi = Math.min(v[v.length - 1], q3 + 1.5 * iqr);
      const cx = b.pos(i) + b.width / 2, col = cat(i);
      g.appendChild(el('line', { x1: cx, x2: cx, y1: sc(hi), y2: sc(q3), stroke: col, 'stroke-width': 1.4, class: 'viz-whisker' }));
      g.appendChild(el('line', { x1: cx, x2: cx, y1: sc(q1), y2: sc(lo), stroke: col, 'stroke-width': 1.4, class: 'viz-whisker' }));
      [hi, lo].forEach(y => g.appendChild(el('line', { x1: cx - 9, x2: cx + 9, y1: sc(y), y2: sc(y), stroke: col, 'stroke-width': 1.4 })));
      const rect = el('rect', { x: b.pos(i), width: b.width, y: sc(q3), height: Math.max(1, sc(q1) - sc(q3)), rx: 3, fill: col, 'fill-opacity': .34, stroke: col, 'stroke-width': 1.4, class: 'viz-box' });
      g.appendChild(rect);
      g.appendChild(el('line', { x1: b.pos(i), x2: b.pos(i) + b.width, y1: sc(q2), y2: sc(q2), stroke: col, 'stroke-width': 2.4 }));
      v.filter(x => x < lo || x > hi).forEach(x => g.appendChild(el('circle', { cx, cy: sc(x), r: 2.6, fill: col, 'fill-opacity': .55 })));
      bindTip(rect, () => `<b>${grp.name}</b><i>${T('vizMedian')} ${fmt(q2)}${unit}</i><i>Q1 ${fmt(q1)}　Q3 ${fmt(q3)}</i><i>${T('vizRange')} ${fmt(lo)} – ${fmt(hi)}</i><i>n=${v.length}</i>`);
      const lab = el('text', { x: cx, y: H - P.b + 18, class: 'viz-tick viz-cat', 'text-anchor': 'middle' });
      lab.textContent = String(grp.name).length > 8 ? String(grp.name).slice(0, 7) + '…' : grp.name; g.appendChild(lab);
    });
    body.appendChild(s);
  }

  /* ======================================================================
     8) 热力图 —— 相关矩阵 / 透视表，格可点选下钻
     ====================================================================== */
  function heatmap(host, spec) {
    const { rows, cols, value, title, sub, diverging = false, onPick, unit = '', fmtv, scale = 'global', scaleNote = '' } = spec;
    const body = frame(host, title, sub);
    const n = cols.length, m = rows.length;
    const P = { t: 8, l: 96, r: 8, b: 34 };
    // 格子尺寸跟随容器宽度：列少时铺满（但不超过 76px，避免格子过大显得空），列多时自动收紧
    const avail = Math.max(300, (host.clientWidth || 720) - 24);
    const cell = Math.max(26, Math.min(88, (avail - P.l - P.r) / Math.max(n, 1)));
    const W = P.l + n * cell + P.r, H = P.t + m * cell + P.b + 14;
    const s = svg(W, H), g = el('g'); s.appendChild(g);
    const vals = rows.flatMap((r, i) => cols.map((c, j) => value(r, c, i, j))).filter(Number.isFinite);
    const min = Math.min(...vals), max = Math.max(...vals);
    // 各列量纲差别很大时（例如 describe 里 count=631 与 minutes=17900 同框），
    // 用全局色阶会把除最大值列以外的格子全压成一片黑，所以支持按列各自归一化
    const colMin = cols.map((c, j) => Math.min(...rows.map((r, i) => value(r, c, i, j)).filter(Number.isFinite)));
    const colMax = cols.map((c, j) => Math.max(...rows.map((r, i) => value(r, c, i, j)).filter(Number.isFinite)));
    const colorOf = (v, j) => {
      if (v == null || !Number.isFinite(v)) return css('--viz-empty') || '#16232e';
      if (diverging) return div(v);
      const lo = scale === 'column' ? colMin[j] : min, hi = scale === 'column' ? colMax[j] : max;
      return seq((v - lo) / ((hi - lo) || 1), 'teal');
    };
    rows.forEach((r, i) => {
      const rl = el('text', { x: P.l - 7, y: P.t + i * cell + cell / 2 + 3.5, class: 'viz-tick', 'text-anchor': 'end' });
      rl.textContent = String(rows[i].__label).length > 11 ? String(rows[i].__label).slice(0, 10) + '…' : rows[i].__label;
      g.appendChild(rl);
      cols.forEach((c, j) => {
        const v = value(r, c, i, j);
        const fill = colorOf(v, j);
        const rect = el('rect', { x: P.l + j * cell, y: P.t + i * cell, width: cell - 1.5, height: cell - 1.5, rx: 2, fill, class: 'viz-cell' });
        g.appendChild(rect);
        const text = (v != null && Number.isFinite(v) && cell >= 30) ? (fmtv ? fmtv(v) : (Math.abs(v) < 1 && !diverging ? v.toFixed(2) : fmtTick(v))) : '';
        if (text) {
          const t = el('text', { x: P.l + j * cell + (cell - 1.5) / 2, y: P.t + i * cell + cell / 2 + 3.5, class: 'viz-celltext', 'text-anchor': 'middle', 'data-lum': textOn(fill) });
          t.textContent = text; g.appendChild(t);
        }
        bindTip(rect, () => `<b>${r.__label} × ${c}</b><i>${unit}${fmt(v)}</i>${onPick ? `<i class="viz-hint">${T('clickDrill')}</i>` : ''}`);
        if (onPick) { rect.style.cursor = 'pointer'; rect.addEventListener('click', () => onPick({ row: r.__label, col: c })); }
      });
    });
    cols.forEach((c, j) => {
      const t = el('text', { x: P.l + j * cell + cell / 2, y: P.t + m * cell + 15, class: 'viz-tick viz-cat', 'text-anchor': 'middle', transform: n > 6 ? `rotate(-38 ${P.l + j * cell + cell / 2} ${P.t + m * cell + 15})` : '' });
      t.textContent = String(c).length > 9 ? String(c).slice(0, 8) + '…' : c; g.appendChild(t);
    });
    body.appendChild(s);
    // 注意：这里不能把这个 div 命名成 scale，否则会遮蔽上面同名的 spec 参数（colorOf 里会读不到）
    const scaleEl = document.createElement('div');
    scaleEl.className = 'viz-scalebar';
    const lo = scale === 'column' ? Math.min(...colMin) : min;
    const hi = scale === 'column' ? Math.max(...colMax) : max;
    scaleEl.innerHTML = (scale === 'column' && scaleNote ? `<span class="viz-scale-note">${scaleNote}</span>` : '')
      + `<span>${fmtTick(lo)}</span><i style="background:linear-gradient(90deg,${seq(0)},${seq(.5)},${seq(1)})"></i><span>${fmtTick(hi)}</span>`;
    body.appendChild(scaleEl);
    replay(body, '.viz-cell', 'viz-fade .5s ease both; animation-delay: calc(({i} % 14) * 18ms)');
  }

  /* ======================================================================
     9) 环形图 —— 类别占比（可点击下钻）
     ====================================================================== */
  function donut(host, spec) {
    const { data, name, value, title, sub, onPick, unit = '' } = spec;
    const body = frame(host, title, sub);
    const W = Math.min(560, fitW(host, 460)), H = 280, cx = Math.round(W / 2), cy = 140, R = 96, r = 56;
    const s = svg(W, H), g = el('g'); s.appendChild(g);
    const total = data.reduce((n, d) => n + (d[value] || 0), 0) || 1;
    let a0 = -Math.PI / 2;
    data.forEach((d, i) => {
      const frac = (d[value] || 0) / total;
      const a1 = a0 + frac * Math.PI * 2;
      const large = frac > 0.5 ? 1 : 0;
      const p = (ang, rad) => [cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad];
      const [x0, y0] = p(a0, R), [x1, y1] = p(a1, R), [x2, y2] = p(a1, r), [x3, y3] = p(a0, r);
      const path = el('path', {
        d: `M ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${r} ${r} 0 ${large} 0 ${x3} ${y3} Z`,
        fill: cat(i), class: 'viz-arc', stroke: css('--viz-bg') || '#fff', 'stroke-width': 1.5,
      });
      g.appendChild(path);
      // 引线标签
      if (frac > 0.055) {
        const mid = (a0 + a1) / 2;
        const [lx, ly] = p(mid, (R + r) / 2);
        const t = el('text', { x: lx, y: ly + 4, class: 'viz-arc-label', 'text-anchor': 'middle' });
        t.textContent = (frac * 100).toFixed(1) + '%'; g.appendChild(t);
      }
      bindTip(path, () => `<b>${d[name]}</b><i>${fmt(d[value])}${unit}　${(frac * 100).toFixed(1)}%</i>${onPick ? `<i class="viz-hint">${T('clickFilter')}</i>` : ''}`);
      if (onPick) { path.style.cursor = 'pointer'; path.addEventListener('click', () => onPick(String(d[name]))); }
      a0 = a1;
    });
    const t1 = el('text', { x: cx, y: cy - 2, class: 'viz-donut-main', 'text-anchor': 'middle' }); t1.textContent = fmtTick(total); g.appendChild(t1);
    const t2 = el('text', { x: cx, y: cy + 16, class: 'viz-tick', 'text-anchor': 'middle' }); t2.textContent = T('vizTotal'); g.appendChild(t2);
    body.appendChild(s);
    const legend = document.createElement('div'); legend.className = 'viz-legend viz-legend-col';
    data.forEach((d, i) => {
      const item = document.createElement(onPick ? 'button' : 'span');
      if (onPick) item.type = 'button';
      item.className = 'viz-legend-item';
      item.innerHTML = `<i style="background:${cat(i)}"></i>${d[name]}<b>${fmt(d[value])}</b>`;
      if (onPick) item.addEventListener('click', () => onPick(String(d[name])));
      legend.appendChild(item);
    });
    body.appendChild(legend);
    replay(body, '.viz-arc', 'viz-fade .6s ease both; animation-delay: calc({i} * 45ms)');
  }

  /* ======================================================================
     10) 矩形树图 —— 层级占比（一眼看出结构）
     ====================================================================== */
  function treemap(host, spec) {
    const { data, name, value, title, sub, onPick, unit = '', colorBy = null } = spec;
    const body = frame(host, title, sub);
    const W = fitW(host), H = 320;
    const s = svg(W, H), g = el('g'); s.appendChild(g);
    const total = data.reduce((n, d) => n + (d[value] || 0), 0) || 1;
    // squarified 简化版：按面积排序后递归二分
    const items = [...data].sort((a, b) => (b[value] || 0) - (a[value] || 0));
    const cats = colorBy ? [...new Set(data.map(d => String(d[colorBy])))] : [];
    const rects = [];
    (function split(list, x, y, w, h, depth) {
      if (!list.length) return;
      if (list.length === 1) { rects.push({ d: list[0], x, y, w, h }); return; }
      const sum = list.reduce((n, d) => n + (d[value] || 0), 0) || 1;
      let acc = 0, cut = 1;
      for (let i = 0; i < list.length; i++) { acc += list[i][value] || 0; if (acc >= sum / 2) { cut = i + 1; break; } }
      const a = list.slice(0, cut), b = list.slice(cut);
      const frac = a.reduce((n, d) => n + (d[value] || 0), 0) / sum;
      if (w >= h) { split(a, x, y, w * frac, h, depth + 1); split(b, x + w * frac, y, w * (1 - frac), h, depth + 1); }
      else { split(a, x, y, w, h * frac, depth + 1); split(b, x, y + h * frac, w, h * (1 - frac), depth + 1); }
    })(items, 0, 0, W, H, 0);
    rects.forEach((r, i) => {
      const idx = data.indexOf(r.d);
      const col = colorBy ? cat(cats.indexOf(String(r.d[colorBy]))) : cat(idx);
      const rect = el('rect', { x: r.x + 1, y: r.y + 1, width: Math.max(0, r.w - 2), height: Math.max(0, r.h - 2), rx: 4, fill: col, 'fill-opacity': .88, class: 'viz-tile' });
      g.appendChild(rect);
      const frac = (r.d[value] || 0) / total;
      if (r.w > 74 && r.h > 30) {
        const t = el('text', { x: r.x + 8, y: r.y + 20, class: 'viz-tile-label' });
        t.textContent = String(r.d[name]).length > Math.floor(r.w / 9) ? String(r.d[name]).slice(0, Math.max(3, Math.floor(r.w / 9) - 1)) + '…' : r.d[name];
        g.appendChild(t);
        if (r.h > 46) {
          const t2 = el('text', { x: r.x + 8, y: r.y + 38, class: 'viz-tile-value' });
          t2.textContent = (frac * 100).toFixed(1) + '%'; g.appendChild(t2);
        }
      }
      bindTip(rect, () => `<b>${r.d[name]}</b><i>${fmt(r.d[value])}${unit}　${T('vizPctOf')} ${(frac * 100).toFixed(1)}%</i>${onPick ? `<i class="viz-hint">${T('clickFilterShort')}</i>` : ''}`);
      if (onPick) { rect.style.cursor = 'pointer'; rect.addEventListener('click', () => onPick(String(r.d[name]))); }
    });
    body.appendChild(s);
    replay(body, '.viz-tile', 'viz-fade .5s ease both; animation-delay: calc({i} * 30ms)');
  }

  /* ======================================================================
     11) 雷达图 —— 多指标轮廓对比
     ====================================================================== */
  function radar(host, spec) {
    const { axes, series, title, sub, unit = '' } = spec;   // series: [{name, values:[]}]，values 与 axes 等长
    const body = frame(host, title, sub);
    const W = Math.min(540, fitW(host, 480)), H = 340, cx = W / 2, cy = H / 2 + 6, R = 118;
    const s = svg(W, H), g = el('g'); s.appendChild(g);
    const n = axes.length;
    const ang = i => -Math.PI / 2 + (i / n) * Math.PI * 2;
    // 归一化每个轴到 0..1
    const norm = axes.map((_, j) => {
      const vs = series.map(se => se.values[j]).filter(Number.isFinite);
      const mx = Math.max(...vs, 0.0001);
      return v => Math.max(0, v) / mx;
    });
    for (let ring = 1; ring <= 4; ring++) {
      const rr = R * ring / 4;
      const pts = Array.from({ length: n }, (_, i) => `${cx + Math.cos(ang(i)) * rr},${cy + Math.sin(ang(i)) * rr}`).join(' ');
      g.appendChild(el('polygon', { points: pts, class: 'viz-radar-ring', fill: 'none' }));
    }
    axes.forEach((a, i) => {
      const x = cx + Math.cos(ang(i)) * R, y = cy + Math.sin(ang(i)) * R;
      g.appendChild(el('line', { x1: cx, y1: cy, x2: x, y2: y, class: 'viz-radar-spoke' }));
      const t = el('text', {
        x: cx + Math.cos(ang(i)) * (R + 22), y: cy + Math.sin(ang(i)) * (R + 22) + 4,
        class: 'viz-radar-label', 'text-anchor': Math.abs(Math.cos(ang(i))) < 0.25 ? 'middle' : (Math.cos(ang(i)) > 0 ? 'start' : 'end'),
      });
      t.textContent = a; g.appendChild(t);
    });
    series.forEach((se, k) => {
      const pts = se.values.map((v, j) => {
        const rr = R * norm[j](v);
        return [cx + Math.cos(ang(j)) * rr, cy + Math.sin(ang(j)) * rr];
      });
      const col = cat(k);
      g.appendChild(el('polygon', { points: pts.map(p => p.join(',')).join(' '), fill: col, 'fill-opacity': .16, stroke: col, 'stroke-width': 2, class: 'viz-radar-area' }));
      pts.forEach((p, j) => {
        const dot = el('circle', { cx: p[0], cy: p[1], r: 3.2, fill: col, class: 'viz-dot' });
        g.appendChild(dot);
        bindTip(dot, () => `<b>${se.name} · ${axes[j]}</b><i>${fmt(se.values[j])}${unit}</i>`);
      });
    });
    body.appendChild(s);
    const legend = document.createElement('div'); legend.className = 'viz-legend';
    series.forEach((se, k) => { const sp = document.createElement('span'); sp.className = 'viz-legend-item'; sp.innerHTML = `<i style="background:${cat(k)}"></i>${se.name}`; legend.appendChild(sp); });
    body.appendChild(legend);
    replay(body, '.viz-radar-area', 'viz-fade .6s ease both; animation-delay: calc({i} * 120ms)');
  }

  /* ======================================================================
     12) 缺失矩阵 —— 每一格代表一个单元格是否缺失（缺失值可视化）
     ====================================================================== */
  function missing(host, spec) {
    const { rows, cols, isNull, title, sub, maxCols = 130 } = spec;
    const body = frame(host, title, sub);
    // 转置布局：一行一个变量（左侧横向标签，永不重叠），横轴为抽样行序号
    const step = Math.max(1, Math.ceil(rows.length / maxCols));
    const sampled = [];
    for (let i = 0; i < rows.length; i += step) sampled.push(i);
    const LABEL_W = 108, ROW_H = Math.max(9, Math.min(17, 220 / Math.max(cols.length, 1)));
    const CW = Math.max(5, Math.min(14, 640 / Math.max(sampled.length, 1)));
    const P = { t: 6, b: 26 };
    const W = LABEL_W + sampled.length * CW + 46, H = P.t + cols.length * ROW_H + P.b;
    const sv = svg(W, H), g = el('g'); sv.appendChild(g);
    cols.forEach((c, r) => {
      const lab = el('text', { x: LABEL_W - 8, y: P.t + r * ROW_H + ROW_H * 0.74, class: 'viz-tick viz-cat', 'text-anchor': 'end' });
      lab.textContent = String(c).length > 13 ? String(c).slice(0, 12) + '…' : c;
      g.appendChild(lab);
      let miss = 0;
      sampled.forEach((i, k) => {
        const m = isNull(rows[i], c);
        if (m) miss++;
        g.appendChild(el('rect', {
          x: LABEL_W + k * CW, y: P.t + r * ROW_H + 0.6,
          width: Math.max(1, CW - 1.2), height: Math.max(1, ROW_H - 1.6), rx: 1.5,
          fill: m ? '#f472b6' : (css('--viz-present') || '#2b4351'), class: 'viz-cell',
        }));
      });
      const pct = el('text', { x: W - 4, y: P.t + r * ROW_H + ROW_H * 0.74, class: 'viz-strip-pct', 'text-anchor': 'end' });
      pct.textContent = miss ? ((miss / sampled.length) * 100).toFixed(0) + '%' : '—';
      g.appendChild(pct);
    });
    [0, Math.floor(sampled.length / 2), sampled.length - 1].forEach(k => {
      const t = el('text', {
        x: LABEL_W + k * CW, y: P.t + cols.length * ROW_H + 16, class: 'viz-tick',
        'text-anchor': k === 0 ? 'start' : (k === sampled.length - 1 ? 'end' : 'middle'),
      });
      t.textContent = '#' + (sampled[k] + 1); g.appendChild(t);
    });
    body.appendChild(sv);
    const legend = document.createElement('div'); legend.className = 'viz-legend';
    legend.innerHTML = `<span class="viz-legend-item"><i style="background:#ff7ba8"></i>${T('vizMissing')}</span>`
      + `<span class="viz-legend-item"><i style="background:${css('--viz-present') || '#cddbd8'}"></i>${T('vizPresent')}</span>`
      + `<span class="viz-tick">${T('vizSampled', { a: sampled.length, b: rows.length })}</span>`;
    body.appendChild(legend);
  }

  /* ======================================================================
     13) 迷你分布条 —— 逐列概览（小倍数图） 
     ====================================================================== */
  function strip(host, spec) {
    const { items, title, sub, unit = '' } = spec;   // items: [{label, values:[], kind:'num'|'cat'}]
    const body = frame(host, title, sub);
    const rowsHTML = items.map(it => {
      const w = Math.max(300, fitW(host, 380) - 118);
      // 高度按行数计算：行高必须大于字号，否则文字会互相压住
      const ROW_H = 13.5, TOPN = 6;
      let nCat = 0;
      if (it.kind !== 'num') {
        const m = new Map();
        it.values.forEach(x => { const k = String(x); m.set(k, (m.get(k) || 0) + 1); });
        nCat = Math.min(TOPN, m.size) + (m.size > TOPN ? 1 : 0);
      }
      const h = it.kind === 'num' ? 34 : 3 + nCat * ROW_H;
      const s = svg(w, h);
      if (it.kind === 'num') {
        const v = it.values.filter(Number.isFinite).sort((a, b) => a - b);
        if (!v.length) return '';
        const min = v[0], max = v[v.length - 1];
        const sc = lin(min, max, w - 12, 12);
        const q = p => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
        const bins = 20, counts = new Array(bins).fill(0);
        const stepv = (max - min) / bins || 1;
        v.forEach(x => { counts[Math.min(bins - 1, Math.floor((x - min) / stepv))]++; });
        const mc = Math.max(...counts);
        counts.forEach((c, i) => {
          const bh = (c / mc) * 22;
          s.appendChild(el('rect', { x: 12 + i * ((w - 24) / bins), y: h - 6 - bh, width: (w - 24) / bins - 1.4, height: Math.max(0.8, bh), rx: 1, fill: seq(c / mc, 'blue') }));
        });
        s.appendChild(el('line', { x1: 12, x2: w - 12, y1: h - 5.5, y2: h - 5.5, stroke: css('--viz-axis'), 'stroke-width': 1 }));
        [0.25, 0.5, 0.75].forEach(p => {
          s.appendChild(el('line', { x1: sc(q(p)), x2: sc(q(p)), y1: 4, y2: h - 7, stroke: '#fbbf24', 'stroke-width': 1.2, 'stroke-dasharray': '2 2' }));
        });
        s.appendChild(el('circle', { cx: sc(q(.5)), cy: 8, r: 2.6, fill: '#fbbf24' }));
      } else {
        // 分类列：前几名 + 占比（行高足够，标签不与条形重叠）
        const counts = new Map();
        it.values.forEach(x => { const k = String(x); counts.set(k, (counts.get(k) || 0) + 1); });
        const arr = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const top = arr.slice(0, TOPN);
        const tot = it.values.length || 1;
        const mx = top[0] ? top[0][1] : 1;
        const LABEL_W = 108, PCT_W = 34;
        top.forEach(([k, c], i) => {
          const y = 3 + i * ROW_H;
          const trackX = LABEL_W, trackW = w - LABEL_W - PCT_W;
          const lab = el('text', { x: 0, y: y + 8, class: 'viz-strip-cat' });
          lab.textContent = k.length > 15 ? k.slice(0, 14) + '…' : k;
          s.appendChild(lab);
          s.appendChild(el('rect', { x: trackX, y: y + 1.5, width: trackW, height: 7, rx: 3.5, fill: css('--viz-grid') || '#eef2f6' }));
          s.appendChild(el('rect', { x: trackX, y: y + 1.5, width: Math.max(2.5, (c / mx) * trackW), height: 7, rx: 3.5, fill: cat(i) }));
          const pct = el('text', { x: w - 2, y: y + 8, class: 'viz-strip-pct', 'text-anchor': 'end' });
          pct.textContent = ((c / tot) * 100).toFixed(0) + '%';
          s.appendChild(pct);
        });
        if (arr.length > TOPN) {
          const more = el('text', { x: 0, y: 3 + TOPN * ROW_H + 7, class: 'viz-strip-cat' });
          more.textContent = `+ ${arr.length - TOPN}`; s.appendChild(more);
        }
      }
      return `<div class="viz-strip-row"><span class="viz-strip-label">${it.label}</span><span class="viz-strip-chart">${s.outerHTML}</span></div>`;
    }).join('');
    body.insertAdjacentHTML('beforeend', `<div class="viz-strips">${rowsHTML}</div>`);
    void unit;
  }

  /* ======================================================================
     14) 合并连接图 —— merge 匹配情况可视化
     ====================================================================== */
  function join(host, spec) {
    const { leftName, rightName, leftKeys, rightKeys, matched, how, title, sub } = spec;
    const body = frame(host, title, sub);
    const W = fitW(host), H = 300, cx = W / 2, cy = H / 2;
    const s = svg(W, H), g = el('g'); s.appendChild(g);
    const R = 92, off = 46;
    const drawSet = (x, n, color, side) => {
      g.appendChild(el('circle', { cx: x, cy, r: R, fill: color, 'fill-opacity': .2, stroke: color, 'stroke-width': 2, class: 'viz-venn' }));
      const t = el('text', { x, y: cy - R - 12, class: 'viz-venn-label', 'text-anchor': 'middle' });
      t.textContent = `${side}　${T('vizShortRows', { n })}`; g.appendChild(t);
    };
    drawSet(cx - off, leftKeys, cat(0), leftName);
    drawSet(cx + off, rightKeys, cat(2), rightName);
    const tm = el('text', { x: cx, y: cy + 4, class: 'viz-venn-main', 'text-anchor': 'middle' });
    tm.textContent = matched; g.appendChild(tm);
    const tm2 = el('text', { x: cx, y: cy + 22, class: 'viz-tick', 'text-anchor': 'middle' });
    tm2.textContent = T('vizMatchKey'); g.appendChild(tm2);
    // 匹配键样例
    const list = (spec.matchedSample || []).slice(0, 8).map(k =>
      `<span class="viz-key">${k}</span>`).join('');
    body.appendChild(s);
    body.insertAdjacentHTML('beforeend',
      `<div class="viz-joininfo"><span>how = <b>${how}</b></span>${list ? `<span class="viz-keys">${T('vizMatchSample')}${list}</span>` : ''}</div>`);
    replay(body, '.viz-venn', 'viz-fade .5s ease both; animation-delay: calc({i} * 140ms)');
  }

  /* ======================================================================
     导出
     ====================================================================== */
  window.Charts = {
    bar, groupedBar, stackedBar, line, scatter, hist, box, heatmap, donut, treemap, radar, missing, strip, join,
    bubble: scatter,   // 气泡图 = 带 size 的散点，必须挂上别名，否则「气泡」卡片会渲染成空白
    cat, seq, div, fmtTick, showTip, hideTip, replay,
  };
})();
