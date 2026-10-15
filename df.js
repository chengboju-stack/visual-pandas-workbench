'use strict';
/* ==========================================================================
   df.js · 迷你 pandas 引擎
   ── 纯前端实现，无任何依赖，不修改全局环境。
   ── 目标：把 pandas 里最常用的数据操作，用可检查、可回溯的方式实现出来，
      每一步的结果都能被表格与图形同时观察。
   支持：读取 CSV/TSV、选择列、行筛选（query/表达式）、排序、去重、缺失值处理、
        类型转换、重命名、新增列、描述统计、取值计数、分组聚合、透视表、交叉表、
        相关系数矩阵、滚动窗口、分箱、时间重采样、合并连接、拼接、长宽表重塑。
   ========================================================================== */

/* ───────────────────────── 表达式解析（不使用 eval） ───────────────────────── */
const FUNCS = {
  abs: v => Math.abs(v), round: (v, n = 0) => Math.round(v * Math.pow(10, n)) / Math.pow(10, n),
  floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt, log: Math.log, exp: Math.exp, pow: Math.pow,
  min: Math.min, max: Math.max, len: v => (v == null ? 0 : String(v).length),
  lower: v => (v == null ? '' : String(v).toLowerCase()),
  upper: v => (v == null ? '' : String(v).toUpperCase()),
  isnull: v => v == null || v === '' || (typeof v === 'number' && Number.isNaN(v)),
  notnull: v => !(v == null || v === '' || (typeof v === 'number' && Number.isNaN(v))),
  int: v => Math.trunc(Number(v)), float: v => Number(v), str: v => (v == null ? '' : String(v)),
};

function tokenize(src) {
  const out = [];
  let i = 0;
  const isDigit = c => c >= '0' && c <= '9';
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i; while (j < src.length && /[0-9._]/.test(src[j])) j++;
      out.push({ t: 'num', v: parseFloat(src.slice(i, j)) }); i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) { s += src[j]; j++; }
      out.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (/[A-Za-z_\u4e00-\u9fff]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_\u4e00-\u9fff]/.test(src[j])) j++;
      out.push({ t: 'id', v: src.slice(i, j) }); i = j; continue;
    }
    const three = src.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(three)) { out.push({ t: 'op', v: three }); i += 2; continue; }
    if ('+-*/%<>!(),'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error('无法识别的字符: ' + c);
  }
  return out;
}

// 递归下降：expr -> or -> and -> cmp -> add -> mul -> unary -> primary
function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const eat = v => { const t = tokens[p]; if (!t || (v && t.v !== v)) throw new Error('期望 ' + v); p++; return t; };
  const isOp = v => { const t = tokens[p]; return t && t.t === 'op' && t.v === v; };

  function primary() {
    const t = tokens[p];
    if (!t) throw new Error('表达式意外结束');
    if (t.t === 'num' || t.t === 'str') { p++; return () => t.v; }
    if (t.t === 'id') {
      p++;
      if (isOp('(')) {
        const fn = FUNCS[t.v];
        if (!fn) throw new Error('未知函数: ' + t.v);
        eat('(');
        const args = [];
        if (!isOp(')')) { args.push(expr()); while (isOp(',')) { eat(','); args.push(expr()); } }
        eat(')');
        return row => fn(...args.map(a => a(row)));
      }
      const name = t.v;
      if (name === 'true') return () => true;
      if (name === 'false') return () => false;
      return row => row[name];
    }
    if (t.t === 'op' && t.v === '(') { eat('('); const e = expr(); eat(')'); return e; }
    throw new Error('无法解析: ' + (t.v ?? ''));
  }
  function unary() {
    if (isOp('-')) { eat('-'); const e = unary(); return row => -e(row); }
    if (isOp('!')) { eat('!'); const e = unary(); return row => !e(row); }
    return primary();
  }
  function mul() {
    let l = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = tokens[p].v; p++;
      const r = unary();
      const prev = l;                                   // 必须先捕获，否则闭包会递归调用自身
      l = op === '*' ? (row => prev(row) * r(row)) : op === '/' ? (row => prev(row) / r(row)) : (row => prev(row) % r(row));
    }
    return l;
  }
  function add() {
    let l = mul();
    while (isOp('+') || isOp('-')) {
      const op = tokens[p].v; p++;
      const r = mul();
      const prev = l;
      l = op === '+' ? (row => prev(row) + r(row)) : (row => prev(row) - r(row));
    }
    return l;
  }
  function cmp() {
    let l = add();
    while (['==', '!=', '>', '>=', '<', '<='].includes(tokens[p] && tokens[p].t === 'op' ? tokens[p].v : null)) {
      const op = tokens[p].v; p++;
      const r = add();
      const prev = l;
      l = row => {
        const a = prev(row), b = r(row);
        if (op === '==') return a == b;      // eslint-disable-line eqeqeq
        if (op === '!=') return a != b;      // eslint-disable-line eqeqeq
        if (op === '>') return a > b;
        if (op === '>=') return a >= b;
        if (op === '<') return a < b;
        return a <= b;
      };
    }
    return l;
  }
  function and_() {
    let l = cmp();
    while (isOp('&&')) {
      eat('&&');
      const r = cmp();
      const prev = l;
      l = row => prev(row) && r(row);
    }
    return l;
  }
  function expr() {
    let l = and_();
    while (isOp('||')) {
      eat('||');
      const r = and_();
      const prev = l;
      l = row => prev(row) || r(row);
    }
    return l;
  }
  const fn = expr();
  if (p < tokens.length) throw new Error('表达式尾部有多余内容');
  return fn;
}

function compile(expr) { return parse(tokenize(String(expr))); }

/* ───────────────────────── 类型推断与工具 ───────────────────────── */
const isMissing = v => v == null || v === '' || (typeof v === 'number' && Number.isNaN(v));

function inferType(values) {
  const nums = values.filter(v => !isMissing(v));
  if (!nums.length) return 'object';
  let nNumber = 0, nDate = 0, nBool = 0;
  for (const v of nums) {
    if (typeof v === 'boolean' || v === 'true' || v === 'false') nBool++;
    else if (v instanceof Date || /^\d{4}-\d{2}-\d{2}/.test(String(v))) nDate++;
    else if (Number.isFinite(Number(v))) nNumber++;
  }
  const n = nums.length;
  if (nBool / n > 0.95) return 'bool';
  if (nNumber / n > 0.95) return 'float64';
  if (nDate / n > 0.95) return 'datetime64';
  return 'object';
}

function castValue(v, dtype) {
  if (isMissing(v)) return null;
  if (dtype === 'float64' || dtype === 'int64') { const n = Number(v); return Number.isFinite(n) ? (dtype === 'int64' ? Math.trunc(n) : n) : null; }
  if (dtype === 'bool') return v === true || v === 'true' || v === 1 || v === '1';
  if (dtype === 'datetime64') { const d = v instanceof Date ? v : new Date(v); return Number.isNaN(+d) ? null : d; }
  return String(v);
}

const fmtNum = (v, digits = 2) => {
  if (v == null || Number.isNaN(v)) return '';
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && a < 1e-4) return v.toExponential(2);
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(digits).replace(/\.?0+$/, '') || '0';
};

/* ───────────────────────── DataFrame ───────────────────────── */
class DataFrame {
  /** @param {Array<object>} rows  @param {Array<{name,dtype}>} [columns] */
  constructor(rows = [], columns = null) {
    this.rows = rows;
    this.columns = columns || DataFrame.inferColumns(rows);
    this.meta = {};               // 供 UI 记录操作来源等
  }

  static inferColumns(rows) {
    const names = [];
    const seen = new Set();
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); names.push(k); }
    return names.map(name => ({ name, dtype: inferType(rows.map(r => r[name])) }));
  }

  static empty(cols = []) { return new DataFrame([], cols.map(c => (typeof c === 'string' ? { name: c, dtype: 'object' } : c))); }

  /* ---------- 读取 / 写出 ---------- */
  static fromCSV(text, { delimiter = null, hasHeader = true } = {}) {
    const raw = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (!raw) throw new Error('CSV 为空');
    if (!delimiter) {
      const head = raw.split('\n')[0];
      const counts = [[',', (head.match(/,/g) || []).length], ['\t', (head.match(/\t/g) || []).length], [';', (head.match(/;/g) || []).length]];
      counts.sort((a, b) => b[1] - a[1]);
      delimiter = counts[0][1] > 0 ? counts[0][0] : ',';
    }
    const rows = [];
    const lines = DataFrame.splitLines(raw, delimiter);
    let header = null, start = 0;
    if (hasHeader) { header = lines[0].map(h => h.trim()); start = 1; }
    const width = header ? header.length : lines[0].length;
    for (let i = start; i < lines.length; i++) {
      const cells = lines[i];
      if (cells.length === 1 && cells[0] === '') continue;
      const obj = {};
      for (let c = 0; c < width; c++) {
        const key = header ? header[c] : 'col' + (c + 1);
        const cell = cells[c];
        obj[key] = cell === '' || cell == null ? null : (Number.isFinite(Number(cell)) && cell.trim() !== '' ? Number(cell) : cell);
      }
      rows.push(obj);
    }
    return new DataFrame(rows);
  }

  // 处理引号包裹与转义
  static splitLines(text, delimiter) {
    const out = [];
    let cell = '', line = [], inQuote = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuote) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQuote = false; }
        else cell += c;
      } else if (c === '"') inQuote = true;
      else if (c === delimiter) { line.push(cell); cell = ''; }
      else if (c === '\n') { line.push(cell); out.push(line); line = []; cell = ''; }
      else cell += c;
    }
    line.push(cell); out.push(line);
    return out;
  }

  toCSV() {
    const names = this.columns.map(c => c.name);
    const esc = v => {
      if (v == null) return '';
      const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [names.join(','), ...this.rows.map(r => names.map(n => esc(r[n])).join(','))].join('\n');
  }

  /* ---------- 基本信息 ---------- */
  get shape() { return [this.rows.length, this.columns.length]; }
  get dtypes() { return this.columns.map(c => ({ column: c.name, dtype: c.dtype })); }

  memory() {
    let bytes = 0;
    for (const r of this.rows) for (const c of this.columns) {
      const v = r[c.name];
      if (v == null) bytes += 4;
      else if (c.dtype === 'float64') bytes += 8;
      else if (c.dtype === 'datetime64') bytes += 8;
      else bytes += String(v).length * 2 + 8;
    }
    return bytes;
  }

  head(n = 5) { return this._slice(0, n); }
  tail(n = 5) { return this._slice(Math.max(0, this.rows.length - n), this.rows.length); }
  sample(n = 5, seed = 42) {
    const idx = this.rows.map((_, i) => i);
    const rnd = DataFrame.rng(seed);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    return new DataFrame(idx.slice(0, n).map(i => ({ ...this.rows[i] })), this.columns);
  }
  static rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  _slice(a, b) { return new DataFrame(this.rows.slice(a, b).map(r => ({ ...r })), this.columns); }

  clone() { return new DataFrame(this.rows.map(r => ({ ...r })), this.columns.map(c => ({ ...c }))); }

  /* ---------- 选择 ---------- */
  select(cols) {
    const names = Array.isArray(cols) ? cols : [cols];
    const bad = names.filter(n => !this.columns.some(c => c.name === n));
    if (bad.length) throw new Error('列不存在: ' + bad.join(', '));
    return new DataFrame(this.rows.map(r => Object.fromEntries(names.map(n => [n, r[n]]))),
      names.map(n => this.columns.find(c => c.name === n)));
  }

  /* ---------- 筛选 ---------- */
  query(expr) {
    const fn = compile(expr);
    return new DataFrame(this.rows.filter(r => !!fn(r)).map(r => ({ ...r })), this.columns);
  }

  /* ---------- 排序 ---------- */
  sort_values(by, ascending = true) {
    const keys = Array.isArray(by) ? by : [by];
    const dir = Array.isArray(ascending) ? ascending : keys.map(() => ascending);
    const rows = this.rows.map((r, i) => ({ r, i })).sort((A, B) => {
      for (let k = 0; k < keys.length; k++) {
        const a = A.r[keys[k]], b = B.r[keys[k]];
        const am = isMissing(a), bm = isMissing(b);
        if (am && bm) continue;
        if (am) return 1;
        if (bm) return -1;
        let c = 0;
        if (typeof a === 'number' && typeof b === 'number') c = a - b;
        else if (a instanceof Date && b instanceof Date) c = a - b;
        else c = String(a).localeCompare(String(b), 'zh-Hans-CN');
        if (c !== 0) return dir[k] ? c : -c;
      }
      return A.i - B.i;   // 稳定排序
    });
    return new DataFrame(rows.map(x => x.r), this.columns);
  }

  /* ---------- 去重 / 缺失 ---------- */
  drop_duplicates(subset = null) {
    const keys = subset && subset.length ? subset : this.columns.map(c => c.name);
    const seen = new Set();
    const out = [];
    for (const r of this.rows) {
      const k = keys.map(n => { const v = r[n]; return v instanceof Date ? +v : String(v); }).join('\u0001');
      if (seen.has(k)) continue;
      seen.add(k); out.push({ ...r });
    }
    return new DataFrame(out, this.columns);
  }

  isna() {
    return this.columns.map(c => ({
      column: c.name,
      missing: this.rows.reduce((n, r) => n + (isMissing(r[c.name]) ? 1 : 0), 0),
      total: this.rows.length,
    }));
  }

  dropna({ subset = null, how = 'any' } = {}) {
    const cols = subset && subset.length ? subset : this.columns.map(c => c.name);
    const out = this.rows.filter(r => {
      const miss = cols.filter(n => isMissing(r[n])).length;
      return how === 'all' ? miss < cols.length : miss === 0;
    });
    return new DataFrame(out.map(r => ({ ...r })), this.columns);
  }

  fillna(col, value) {
    return new DataFrame(this.rows.map(r => ({ ...r, [col]: isMissing(r[col]) ? (value === 'mean' || value === 'median' ? this._stat(col, value) : value) : r[col] })), this.columns);
  }

  _stat(col, kind) {
    const nums = this.rows.map(r => r[col]).filter(v => typeof v === 'number' && Number.isFinite(v));
    if (!nums.length) return 0;
    if (kind === 'mean') return nums.reduce((a, b) => a + b, 0) / nums.length;
    const s = [...nums].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* ---------- 结构改动 ---------- */
  rename(map) {
    const names = this.columns.map(c => map[c.name] || c.name);
    const cols = this.columns.map((c, i) => ({ name: names[i], dtype: c.dtype }));
    const rows = this.rows.map(r => {
      const o = {};
      this.columns.forEach((c, i) => { o[names[i]] = r[c.name]; });
      return o;
    });
    return new DataFrame(rows, cols);
  }

  astype(col, dtype) {
    const cols = this.columns.map(c => (c.name === col ? { name: c.name, dtype } : c));
    const rows = this.rows.map(r => ({ ...r, [col]: castValue(r[col], dtype) }));
    return new DataFrame(rows, cols);
  }

  assign(name, exprOrFn) {
    const fn = typeof exprOrFn === 'function' ? exprOrFn : compile(exprOrFn);
    const rows = this.rows.map(r => ({ ...r, [name]: fn(r) }));
    const exists = this.columns.some(c => c.name === name);
    const cols = exists ? this.columns.map(c => (c.name === name ? { name, dtype: inferType(rows.map(r => r[name])) } : c))
      : [...this.columns, { name, dtype: inferType(rows.map(r => r[name])) }];
    return new DataFrame(rows, cols);
  }

  /* ---------- 描述统计 ---------- */
  describe() {
    const numeric = this.columns.filter(c => c.dtype === 'float64' || c.dtype === 'int64');
    const stats = ['count', 'mean', 'std', 'min', '25%', '50%', '75%', 'max'];
    const rows = stats.map(s => ({ statistic: s }));
    for (const c of numeric) {
      const v = this.rows.map(r => r[c.name]).filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
      const q = p => (v.length ? v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))] : null);
      const mean = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
      const std = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : null;
      const map = { count: v.length, mean, std, min: v[0] ?? null, '25%': q(0.25), '50%': q(0.5), '75%': q(0.75), max: v[v.length - 1] ?? null };
      rows.forEach(r => { r[c.name] = map[r.statistic]; });
    }
    return new DataFrame(rows, [{ name: 'statistic', dtype: 'object' }, ...numeric.map(c => ({ name: c.name, dtype: 'float64' }))]);
  }

  value_counts(col, { normalize = false, top = null } = {}) {
    const counts = new Map();
    for (const r of this.rows) {
      const k = isMissing(r[col]) ? '(缺失)' : String(r[col]);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let arr = [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
    if (top) arr = arr.slice(0, top);
    const total = this.rows.length || 1;
    return new DataFrame(arr.map(x => ({ value: x.value, count: x.count, ratio: +(x.count / total).toFixed(4) })),
      [{ name: 'value', dtype: 'object' }, { name: 'count', dtype: 'int64' }, { name: normalize ? 'ratio' : 'ratio', dtype: 'float64' }]);
  }

  nunique() {
    return new DataFrame(this.columns.map(c => ({
      column: c.name,
      nunique: new Set(this.rows.map(r => r[c.name]).filter(v => !isMissing(v)).map(v => (v instanceof Date ? +v : v))).size,
      missing: this.rows.reduce((n, r) => n + (isMissing(r[c.name]) ? 1 : 0), 0),
    })), [{ name: 'column', dtype: 'object' }, { name: 'nunique', dtype: 'int64' }, { name: 'missing', dtype: 'int64' }]);
  }

  /* ---------- 分组聚合 ---------- */
  groupby(by, aggs) {
    const keys = Array.isArray(by) ? by : [by];
    const buckets = new Map();
    for (const r of this.rows) {
      const k = keys.map(n => (isMissing(r[n]) ? '(缺失)' : String(r[n]))).join(' | ');
      if (!buckets.has(k)) buckets.set(k, { key: k, vals: [] });
      buckets.get(k).vals.push(r);
    }
    const aggList = Object.entries(aggs);   // [[col, fn], ...]
    const out = [];
    for (const { key, vals } of buckets.values()) {
      const row = {};
      keys.forEach((k, i) => { row[k] = key.split(' | ')[i]; });
      for (const [col, fn] of aggList) {
        const nums = vals.map(v => v[col]).filter(x => typeof x === 'number' && Number.isFinite(x));
        const all = vals.map(v => v[col]).filter(x => !isMissing(x));
        row[col + ' (' + fn + ')'] = DataFrame.agg(nums, all, fn);
      }
      row['count'] = vals.length;
      out.push(row);
    }
    out.sort((a, b) => {
      const ka = keys.map(k => a[k]).join('|'), kb = keys.map(k => b[k]).join('|');
      return ka.localeCompare(kb, 'zh-Hans-CN');
    });
    const cols = [...keys.map(k => ({ name: k, dtype: 'object' })),
      ...aggList.map(([col, fn]) => ({ name: col + ' (' + fn + ')', dtype: 'float64' })),
      { name: 'count', dtype: 'int64' }];
    return new DataFrame(out, cols);
  }

  static agg(nums, all, fn) {
    switch (fn) {
      case 'count': return all.length;
      case 'nunique': return new Set(all.map(v => (v instanceof Date ? +v : v))).size;
      case 'min': return nums.length ? Math.min(...nums) : null;
      case 'max': return nums.length ? Math.max(...nums) : null;
      case 'median': { const s = [...nums].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; }
      case 'std': { if (nums.length < 2) return null; const mean = nums.reduce((a, b) => a + b, 0) / nums.length; return Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1)); }
      case 'var': { if (nums.length < 2) return null; const mean = nums.reduce((a, b) => a + b, 0) / nums.length; return nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1); }
      case 'sum': return nums.reduce((a, b) => a + b, 0);
      case 'mean': return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
      default: return null;
    }
  }

  /* ---------- 透视表 / 交叉表 ---------- */
  pivot_table({ index, columns, values, aggfunc = 'mean' }) {
    const idxs = [...new Set(this.rows.map(r => (isMissing(r[index]) ? '(缺失)' : String(r[index]))))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    const cols = [...new Set(this.rows.map(r => (isMissing(r[columns]) ? '(缺失)' : String(r[columns]))))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    const table = new Map();
    for (const r of this.rows) {
      const i = isMissing(r[index]) ? '(缺失)' : String(r[index]);
      const c = isMissing(r[columns]) ? '(缺失)' : String(r[columns]);
      const k = i + '\u0001' + c;
      if (!table.has(k)) table.set(k, []);
      const v = r[values];
      if (v != null) table.get(k).push(v);
    }
    const rows = idxs.map(i => {
      const row = { [index]: i };
      for (const c of cols) {
        const vals = table.get(i + '\u0001' + c) || [];
        const nums = vals.filter(v => typeof v === 'number' && Number.isFinite(v));
        row[c] = vals.length ? DataFrame.agg(nums, vals, aggfunc) : null;
      }
      return row;
    });
    return new DataFrame(rows, [{ name: index, dtype: 'object' }, ...cols.map(c => ({ name: c, dtype: 'float64' }))]);
  }

  crosstab(index, columns) {
    return this.pivot_table({ index, columns, values: columns, aggfunc: 'count' });
  }

  /* ---------- 相关 / 协方差 ---------- */
  corr(method = 'pearson') {
    const numeric = this.columns.filter(c => c.dtype === 'float64' || c.dtype === 'int64');
    const data = {};
    for (const c of numeric) data[c.name] = this.rows.map(r => r[c.name]).map(v => (typeof v === 'number' && Number.isFinite(v) ? v : null));
    const pair = (a, b) => {
      const xs = [], ys = [];
      for (let i = 0; i < data[a].length; i++) {
        if (data[a][i] != null && data[b][i] != null) { xs.push(data[a][i]); ys.push(data[b][i]); }
      }
      const n = xs.length;
      if (n < 2) return null;
      const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
      if (sxx === 0 || syy === 0) return null;
      if (method === 'spearman') {
        const rank = arr => { const s = arr.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(arr.length); s.forEach(([, i], k) => { r[i] = k + 1; }); return r; };
        const rx = rank(xs), ry = rank(ys);
        const mrx = rx.reduce((s, v) => s + v, 0) / n, mry = ry.reduce((s, v) => s + v, 0) / n;
        let a1 = 0, a2 = 0, a3 = 0;
        for (let i = 0; i < n; i++) { const dx = rx[i] - mrx, dy = ry[i] - mry; a1 += dx * dy; a2 += dx * dx; a3 += dy * dy; }
        return a2 && a3 ? a1 / Math.sqrt(a2 * a3) : null;
      }
      return sxy / Math.sqrt(sxx * syy);
    };
    const rows = numeric.map(a => {
      const row = { column: a.name };
      for (const b of numeric) row[b.name] = a.name === b.name ? 1 : +(pair(a.name, b.name) ?? NaN).toFixed(4);
      return row;
    });
    return new DataFrame(rows, [{ name: 'column', dtype: 'object' }, ...numeric.map(c => ({ name: c.name, dtype: 'float64' }))]);
  }

  /* ---------- 滚动窗口 ---------- */
  rolling(window, col, fn = 'mean') {
    const vals = this.rows.map(r => r[col]);
    const rows = this.rows.map((r, i) => {
      const win = vals.slice(Math.max(0, i - window + 1), i + 1).filter(v => typeof v === 'number' && Number.isFinite(v));
      const out = { ...r };
      out[col + '_rolling' + window + '_' + fn] = win.length === window ? DataFrame.agg(win, win, fn) : null;
      return out;
    });
    return new DataFrame(rows, [...this.columns, { name: col + '_rolling' + window + '_' + fn, dtype: 'float64' }]);
  }

  /* ---------- 分箱 ---------- */
  cut(col, bins = 4, labels = null) {
    const nums = this.rows.map(r => r[col]).filter(v => typeof v === 'number' && Number.isFinite(v));
    const min = Math.min(...nums), max = Math.max(...nums);
    const step = (max - min) / bins || 1;
    const edges = Array.from({ length: bins + 1 }, (_, i) => min + step * i);
    const name = col + '_bin';
    const rows = this.rows.map(r => {
      const v = r[col];
      let idx = null;
      if (typeof v === 'number' && Number.isFinite(v)) {
        idx = Math.min(bins - 1, Math.max(0, Math.floor((v - min) / step)));
      }
      const label = idx == null ? '(缺失)' : (labels && labels[idx]) || `[${fmtNum(edges[idx])}, ${fmtNum(edges[idx + 1])})`;
      return { ...r, [name]: label };
    });
    return new DataFrame(rows, [...this.columns, { name, dtype: 'object' }]);
  }

  /* ---------- 时间重采样 ---------- */
  resample(freq, dateCol, aggs) {
    const keyOf = d => {
      const dt = d instanceof Date ? d : new Date(d);
      if (Number.isNaN(+dt)) return '(缺失)';
      const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1;
      if (freq === 'D') return `${y}-${String(m).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
      if (freq === 'M') return `${y}-${String(m).padStart(2, '0')}`;
      if (freq === 'Q') return `${y}-Q${Math.floor(dt.getUTCMonth() / 3) + 1}`;
      return String(y);
    };
    const buckets = new Map();
    for (const r of this.rows) {
      const k = keyOf(r[dateCol]);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }
    const aggList = Object.entries(aggs);
    const out = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, vals]) => {
      const row = { period };
      for (const [col, fn] of aggList) {
        const nums = vals.map(v => v[col]).filter(x => typeof x === 'number' && Number.isFinite(x));
        row[col + ' (' + fn + ')'] = DataFrame.agg(nums, vals.map(v => v[col]).filter(v => !isMissing(v)), fn);
      }
      row.count = vals.length;
      return row;
    });
    return new DataFrame(out, [{ name: 'period', dtype: 'object' },
      ...aggList.map(([c, f]) => ({ name: c + ' (' + f + ')', dtype: 'float64' })), { name: 'count', dtype: 'int64' }]);
  }

  /* ---------- 合并 / 拼接 / 重塑 ---------- */
  merge(other, { on = null, how = 'inner', left_on = null, right_on = null } = {}) {
    const lk = left_on || on, rk = right_on || on;
    if (!lk || !rk) throw new Error('merge 需要指定 on');
    const rIdx = new Map();
    for (const r of other.rows) {
      const k = String(r[rk]);
      if (!rIdx.has(k)) rIdx.set(k, []);
      rIdx.get(k).push(r);
    }
    const out = [];
    const matched = new Set();
    let unmatchedLeft = 0;
    for (const lr of this.rows) {
      const k = String(lr[lk]);
      const hit = rIdx.get(k);
      if (!hit) { unmatchedLeft++; if (how === 'left' || how === 'outer') out.push({ ...lr, _merge: 'left_only' }); continue; }
      matched.add(k);
      for (const rr of hit) {
        const o = { ...lr, _merge: 'both' };
        for (const c of other.columns) if (!(c.name in o) || c.name === rk) o[c.name === rk && lk !== rk ? rk : c.name] = rr[c.name];
        out.push(o);
      }
    }
    if (how === 'right' || how === 'outer') {
      for (const rr of other.rows) {
        const k = String(rr[rk]);
        if (!matched.has(k)) out.push({ ...rr, _merge: 'right_only' });
      }
    }
    return new DataFrame(out, DataFrame.inferColumns(out));
  }

  static concat(dfs) {
    if (!dfs.length) return DataFrame.empty();
    const names = [];
    const seen = new Set();
    for (const d of dfs) for (const c of d.columns) if (!seen.has(c.name)) { seen.add(c.name); names.push(c.name); }
    const rows = [];
    for (const d of dfs) for (const r of d.rows) {
      const o = {};
      for (const n of names) o[n] = n in r ? r[n] : null;
      rows.push(o);
    }
    return new DataFrame(rows, names.map(n => ({ name: n, dtype: inferType(rows.map(r => r[n])) })));
  }

  melt(id_vars, value_vars) {
    const ids = Array.isArray(id_vars) ? id_vars : [id_vars];
    const vals = (value_vars && value_vars.length ? value_vars : this.columns.map(c => c.name).filter(n => !ids.includes(n)));
    const rows = [];
    for (const r of this.rows) for (const v of vals) rows.push({ ...Object.fromEntries(ids.map(i => [i, r[i]])), variable: v, value: r[v] });
    return new DataFrame(rows, [...ids.map(i => ({ name: i, dtype: 'object' })), { name: 'variable', dtype: 'object' }, { name: 'value', dtype: 'float64' }]);
  }

  pivot(index, columns, values) {
    return this.pivot_table({ index, columns, values, aggfunc: 'mean' });
  }
}

/* 便于在控制台与测试中使用 */
if (typeof window !== 'undefined') window.DF = { DataFrame, compile, fmtNum, isMissing };
if (typeof module !== 'undefined' && module.exports) module.exports = { DataFrame, compile, fmtNum, isMissing };
