'use strict';
/* ==========================================================================
   app.js · 工作台应用
   结构：
     base（原始数据，永不修改） → steps[]（操作流水线） → result（当前结果）
   每个操作同时产出三样东西：结果数据、等价 pandas 代码、可观察该结果的图形。
   图形可反向驱动分析：点柱子 / 环扇 / 树块 / 热力格 → 追加一步筛选。
   ========================================================================== */
(function () {
  const { DataFrame, fmtNum, isMissing } = window.DF;
  const T = (k, v) => window.I18N.t(k, v);

  /* ───────── 全局状态 ───────── */
  const state = {
    base: null,
    baseLabel: 'srcSample',
    steps: [],
    result: null,
    view: 'charts',        // charts | table | code
    page: 0,
    perPage: 14,
    search: '',
    autoCharts: [],        // 每个步骤记录它建议的图形，供"图形总览"使用
  };

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const numCols = df => df.columns.filter(c => c.dtype === 'float64' || c.dtype === 'int64').map(c => c.name);
  const catCols = df => df.columns.filter(c => c.dtype === 'object' || c.dtype === 'bool').map(c => c.name);
  const dateCols = df => df.columns.filter(c => c.dtype === 'datetime64').map(c => c.name);
  const colSelectable = df => df.columns.map(c => c.name);

  /* ======================================================================
     操作注册表
     每个操作：group 分组 / label 名称 / fields 参数 / code 等价 pandas 代码 / run 执行
     ====================================================================== */
  const AGGS = ['mean', 'sum', 'count', 'min', 'max', 'median', 'std', 'var', 'nunique'];
  const aggLabel = a => ({ mean: T('aggMean'), sum: T('aggSum'), count: T('aggCount'), min: T('aggMin'), max: T('aggMax'), median: T('aggMedian'), std: T('aggStd'), var: T('aggVar'), nunique: T('aggNunique') }[a]);

  const OPS = {
    /* ── 查看 ── */
    head: {
      group: 'grpInspect', labelKey: 'opHead',
      fields: [{ k: 'n', type: 'num', label: 'pN', def: 5, min: 1, max: 200 }],
      code: p => `df.head(${p.n})`,
      run: (df, p) => df.head(+p.n),
    },
    tail: {
      group: 'grpInspect', labelKey: 'opTail',
      fields: [{ k: 'n', type: 'num', label: 'pN', def: 5, min: 1, max: 200 }],
      code: p => `df.tail(${p.n})`,
      run: (df, p) => df.tail(+p.n),
    },
    sample: {
      group: 'grpInspect', labelKey: 'opSample',
      fields: [{ k: 'n', type: 'num', label: 'pN', def: 8, min: 1, max: 200 }],
      code: p => `df.sample(${p.n}, random_state=42)`,
      run: (df, p) => df.sample(+p.n, 42),
    },
    describe: {
      group: 'grpInspect', labelKey: 'opDescribe',
      fields: [],
      code: () => 'df.describe()',
      run: df => df.describe(),
    },
    dtypes: {
      group: 'grpInspect', labelKey: 'opDtypes',
      fields: [],
      code: () => 'df.dtypes.to_frame("dtype").join(pd.DataFrame({"missing": df.isna().sum()}))\n# 等价：df.isna().sum() 与 df.dtypes 合并查看',
      run: df => {
        const na = df.isna();
        const rows = df.dtypes.map(d => ({ column: d.column, dtype: d.dtype, missing: (na.find(x => x.column === d.column) || {}).missing ?? 0 }));
        return new DataFrame(rows, [{ name: 'column', dtype: 'object' }, { name: 'dtype', dtype: 'object' }, { name: 'missing', dtype: 'int64' }]);
      },
    },
    value_counts: {
      group: 'grpInspect', labelKey: 'opValueCounts',
      fields: [{ k: 'col', type: 'col', label: 'pColumn' }, { k: 'top', type: 'num', label: 'pN', def: 12, min: 2, max: 40 }],
      code: p => `df["${p.col}"].value_counts().head(${p.top})`,
      run: (df, p) => df.value_counts(p.col, { top: +p.top }),
    },
    /* ── 选择 ── */
    select: {
      group: 'grpSelect', labelKey: 'opSelect',
      fields: [{ k: 'cols', type: 'cols', label: 'pColumns' }],
      code: p => `df[[${JSON.stringify(p.cols).replace(/"/g, "'").slice(1, -1)}]]`,
      run: (df, p) => df.select(p.cols),
    },
    query: {
      group: 'grpSelect', labelKey: 'opQuery',
      fields: [{ k: 'expr', type: 'text', label: 'pExpression', def: 'revenue > users * 3' }],
      code: p => `df.query("${p.expr}")`,
      run: (df, p) => df.query(p.expr),
    },
    sort: {
      group: 'grpSelect', labelKey: 'opSort',
      fields: [{ k: 'col', type: 'col', label: 'pColumn' }, { k: 'asc', type: 'bool', label: 'pAscending', def: true }],
      code: p => `df.sort_values("${p.col}", ascending=${p.asc ? 'True' : 'False'})`,
      run: (df, p) => df.sort_values(p.col, !!p.asc),
    },
    /* ── 清洗 ── */
    dropna: {
      group: 'grpClean', labelKey: 'opDropna',
      fields: [{ k: 'how', type: 'enum', label: 'pHow', opts: [['any', 'any'], ['all', 'all']], def: 'any' }],
      code: p => `df.dropna(how="${p.how}")`,
      run: (df, p) => df.dropna({ how: p.how }),
    },
    fillna: {
      group: 'grpClean', labelKey: 'opFillna',
      fields: [{ k: 'col', type: 'col', label: 'pColumn' }, { k: 'mode', type: 'enum', label: 'pFillValue', opts: [['mean', 'pFillMean'], ['median', 'pFillMedian'], ['zero', '0'], ['empty', "''"]], def: 'mean' }],
      code: p => `df["${p.col}"].fillna(${p.mode === 'mean' ? `df["${p.col}"].mean()` : p.mode === 'median' ? `df["${p.col}"].median()` : p.mode === 'zero' ? '0' : '""'})`,
      run: (df, p) => df.fillna(p.col, p.mode === 'zero' ? 0 : p.mode === 'empty' ? '' : p.mode),
    },
    drop_duplicates: {
      group: 'grpClean', labelKey: 'opDropDup',
      fields: [],
      code: () => 'df.drop_duplicates()',
      run: df => df.drop_duplicates(),
    },
    astype: {
      group: 'grpClean', labelKey: 'opAstype',
      fields: [{ k: 'col', type: 'col', label: 'pColumn' }, { k: 'dtype', type: 'enum', label: 'pDtype', opts: [['int64', 'int64'], ['float64', 'float64'], ['object', 'object'], ['datetime64', 'datetime64']], def: 'float64' }],
      code: p => `df["${p.col}"].astype("${p.dtype}")`,
      run: (df, p) => df.astype(p.col, p.dtype),
    },
    rename: {
      group: 'grpClean', labelKey: 'opRename',
      fields: [{ k: 'col', type: 'col', label: 'pColumn' }, { k: 'to', type: 'text', label: 'pFactor', def: '' }],
      code: p => `df.rename(columns={"${p.col}": "${p.to || p.col + '_2'}"})`,
      run: (df, p) => df.rename({ [p.col]: (p.to && p.to.trim()) || p.col + '_2' }),
    },
    /* ── 派生 ── */
    assign: {
      group: 'grpCompute', labelKey: 'opAssign',
      fields: [{ k: 'name', type: 'text', label: 'pColumn', def: 'rev_per_user' }, { k: 'expr', type: 'text', label: 'pExpression', def: 'revenue / users' }],
      code: p => `df.assign(${p.name} = ${p.expr})`,
      run: (df, p) => df.assign(p.name, p.expr),
    },
    cut: {
      group: 'grpCompute', labelKey: 'opCut',
      fields: [{ k: 'col', type: 'col', label: 'pColumn', num: true }, { k: 'bins', type: 'num', label: 'pBins', def: 4, min: 2, max: 10 }],
      code: p => `pd.cut(df["${p.col}"], bins=${p.bins})`,
      run: (df, p) => df.cut(p.col, +p.bins),
    },
    /* ── 聚合 ── */
    groupby: {
      group: 'grpAgg', labelKey: 'opGroupby',
      fields: [{ k: 'keys', type: 'cols', label: 'pGroupKeys', cat: true }, { k: 'col', type: 'col', label: 'pAggCol', num: true }, { k: 'fn', type: 'enum', label: 'pAggFunc', opts: AGGS.map(a => [a, a]), def: 'mean' }],
      code: p => `df.groupby(${JSON.stringify(p.keys).replace(/"/g, "'")}).agg({"${p.col}": "${p.fn}"})`,
      run: (df, p) => df.groupby(p.keys, { [p.col]: p.fn }),
    },
    pivot: {
      group: 'grpAgg', labelKey: 'opPivot',
      fields: [{ k: 'index', type: 'col', label: 'pIndex', cat: true }, { k: 'columns', type: 'col', label: 'pColsDim', cat: true }, { k: 'values', type: 'col', label: 'pValues', num: true }, { k: 'fn', type: 'enum', label: 'pAggFunc', opts: AGGS.map(a => [a, a]), def: 'mean' }],
      code: p => `pd.pivot_table(df, index="${p.index}", columns="${p.columns}", values="${p.values}", aggfunc="${p.fn}")`,
      run: (df, p) => df.pivot_table({ index: p.index, columns: p.columns, values: p.values, aggfunc: p.fn }),
    },
    crosstab: {
      group: 'grpAgg', labelKey: 'opCrosstab',
      fields: [{ k: 'index', type: 'col', label: 'pIndex', cat: true }, { k: 'columns', type: 'col', label: 'pColsDim', cat: true }],
      code: p => `pd.crosstab(df["${p.index}"], df["${p.columns}"])`,
      run: (df, p) => df.crosstab(p.index, p.columns),
    },
    resample: {
      group: 'grpAgg', labelKey: 'opResample',
      fields: [{ k: 'freq', type: 'enum', label: 'pFreq', opts: [['M', 'freqMonthly'], ['D', 'freqDaily'], ['Q', 'freqQuarterly'], ['Y', 'freqYearly']], def: 'M' }, { k: 'col', type: 'col', label: 'pAggCol', num: true }, { k: 'fn', type: 'enum', label: 'pAggFunc', opts: AGGS.map(a => [a, a]), def: 'sum' }],
      code: p => `df.resample("${p.freq}", on="date").agg({"${p.col}": "${p.fn}"})`,
      run: (df, p) => df.resample(p.freq, dateCols(df)[0] || 'date', { [p.col]: p.fn }),
    },
    rolling: {
      group: 'grpAgg', labelKey: 'opRolling',
      fields: [{ k: 'window', type: 'num', label: 'pWindow', def: 7, min: 2, max: 60 }, { k: 'col', type: 'col', label: 'pAggCol', num: true }, { k: 'fn', type: 'enum', label: 'pAggFunc', opts: [['mean', 'aggMean'], ['std', 'aggStd'], ['sum', 'aggSum']], def: 'mean' }],
      code: p => `df.assign(${p.col}_rolling = df["${p.col}"].rolling(${p.window}).${p.fn}())`,
      run: (df, p) => df.rolling(+p.window, p.col, p.fn),
    },
    /* ── 关联 ── */
    corr: {
      group: 'grpRelate', labelKey: 'opCorr',
      fields: [{ k: 'method', type: 'enum', label: 'pMethod', opts: [['pearson', 'methodPearson'], ['spearman', 'methodSpearman']], def: 'pearson' }],
      code: p => `df.corr(method="${p.method}")`,
      run: (df, p) => df.corr(p.method),
    },
    merge: {
      group: 'grpRelate', labelKey: 'opMerge',
      fields: [{ k: 'key', type: 'enum', label: 'pLeftKey', opts: [] }, { k: 'how', type: 'enum', label: 'pMergeHow', opts: [['left', 'joinLeft'], ['inner', 'joinInner'], ['right', 'joinRight'], ['outer', 'joinOuter']], def: 'left' }],
      code: p => `df.merge(courses, on="${p.key}", how="${p.how}", indicator=True)`,
      run: (df, p, ctx) => df.merge(ctx.lookup, { on: p.key, how: p.how }),
    },
    concat: {
      group: 'grpRelate', labelKey: 'opConcat',
      fields: [{ k: 'n', type: 'num', label: 'pN', def: 30, min: 1, max: 400 }],
      code: p => `pd.concat([df.head(${p.n}), df.tail(${p.n})], ignore_index=True)`,
      run: (df, p) => DataFrame.concat([df.head(+p.n), df.tail(+p.n)]),
    },
    melt: {
      group: 'grpRelate', labelKey: 'opMelt',
      fields: [{ k: 'id', type: 'col', label: 'pIdVars' }, { k: 'vals', type: 'cols', label: 'pValueVars', num: true }],
      code: p => `df.melt(id_vars=["${p.id}"], value_vars=${JSON.stringify(p.vals).replace(/"/g, "'")})`,
      run: (df, p) => df.melt(p.id, p.vals),
    },
  };

  /* ======================================================================
     执行与流水线
     ====================================================================== */
  const lookupTable = new DataFrame(window.SAMPLE.coursesTable());

  const AGG_OPS = new Set(['groupby', 'pivot', 'crosstab', 'resample', 'value_counts', 'describe', 'corr', 'dtypes', 'rolling']);
  function recompute() {
    let df = state.base;
    let aggregated = false;
    for (const s of state.steps) {
      const op = OPS[s.op];
      try {
        df = op.run(df, s.params, { lookup: lookupTable });
        if (AGG_OPS.has(s.op)) aggregated = true;
      } catch (e) { s.error = e.message; break; }
    }
    df.meta = { ...(df.meta || {}), aggregated };
    state.result = df;
  }

  function addStep(opKey, params, opts = {}) {
    const op = OPS[opKey];
    let code;
    try { code = op.code(params); } catch { code = ''; }
    const step = { op: opKey, params: { ...params }, code, at: Date.now(), fromChart: !!opts.fromChart };
    // 来自图形的筛选要插到**最前面**：先按类别筛选源数据，再重新聚合。
    // 这与 pandas 的 df[df.x == v].groupby(...) 语义一致；
    // 若追加在聚合之后，聚合结果里已没有原列名，会筛成 0 行。
    if (opts.prepend) state.steps.unshift(step);
    else state.steps.push(step);
    state.page = 0;
    recompute();
    renderAll();
    scrollToResult();
  }

  function removeStep(i) { state.steps.splice(i, 1); state.page = 0; recompute(); renderAll(); }
  function clearSteps() { state.steps = []; state.page = 0; recompute(); renderAll(); }
  const scrollToResult = () => { const n = $('#result-anchor'); if (n) n.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  // 图形联动：把图形上选到的类别/区间变成一步筛选
  function filterFromChart(payload) {
    // 列是否存在于原始数据：存在就插到最前（先筛源数据），否则退化为追加
    const inBase = state.base.columns.some(c => c.name === payload.col);
    const prepend = inBase;
    if (!inBase && !(state.result && state.result.columns.some(c => c.name === payload.col))) return;
    if (payload.kind === 'eq') {
      addStep('query', { expr: payload.col + ' == "' + String(payload.value).replace(/"/g, '') + '"' }, { prepend, fromChart: true });
    } else if (payload.kind === 'range') {
      const [lo, hi] = payload.range;
      const fmt = v => (Math.round(v * 1000) / 1000);
      addStep('query', { expr: `${payload.col} >= ${fmt(lo)} && ${payload.col} <= ${fmt(hi)}` }, { prepend, fromChart: true });
    }
  }

  /* ======================================================================
     表格视图
     ====================================================================== */
  function renderTable(df) {
    const host = $('#table-host');
    host.innerHTML = '';
    if (!df || !df.shape[0]) { host.appendChild(el('p', 'empty', T('noData'))); return; }
    let rows = df.rows;
    if (state.search) {
      const q = state.search.toLowerCase();
      rows = rows.filter(r => df.columns.some(c => String(r[c.name] ?? '').toLowerCase().includes(q)));
    }
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / state.perPage));
    state.page = Math.min(state.page, pages - 1);
    const slice = rows.slice(state.page * state.perPage, (state.page + 1) * state.perPage);
    const wrap = el('div', 'tbl-wrap');
    const tbl = el('table', 'tbl');
    const thead = el('thead');
    const hr = el('tr');
    df.columns.forEach(c => {
      const th = el('th', 'tbl-th');
      th.innerHTML = `<span class="tbl-col">${esc(c.name)}</span><small>${esc(c.dtype)}</small>`;
      hr.appendChild(th);
    });
    thead.appendChild(hr); tbl.appendChild(thead);
    const tb = el('tbody');
    slice.forEach(r => {
      const tr = el('tr');
      df.columns.forEach(c => {
        const v = r[c.name];
        const td = el('td', 'tbl-td' + (isMissing(v) ? ' is-null' : ''));
        td.textContent = v instanceof Date ? v.toISOString().slice(0, 10) : (isMissing(v) ? '—' : String(v));
        if (isMissing(v)) td.title = T('cellNull');
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl); host.appendChild(wrap);
    const bar = el('div', 'tbl-bar');
    bar.innerHTML = `<span>${T('showingRows', { a: state.page * state.perPage + 1, b: Math.min(total, (state.page + 1) * state.perPage), n: total })}</span>`;
    const mk = (label, fn, disabled) => { const b = el('button', 'btn btn-ghost', label); b.disabled = disabled; b.addEventListener('click', fn); return b; };
    bar.appendChild(mk(T('prevPage'), () => { state.page--; renderTable(state.result); }, state.page === 0));
    bar.appendChild(mk(T('nextPage'), () => { state.page++; renderTable(state.result); }, state.page >= pages - 1));
    const exp = el('button', 'btn', T('exportCSV'));
    exp.addEventListener('click', () => {
      const blob = new Blob(['\uFEFF' + df.toCSV()], { type: 'text/csv;charset=utf-8' });
      const a = el('a'); a.href = URL.createObjectURL(blob); a.download = 'result.csv'; a.click(); URL.revokeObjectURL(a.href);
    });
    bar.appendChild(exp);
    host.appendChild(bar);
  }

  /* ======================================================================
     图形推荐：按当前结果的数据形状自动挑选合适的图
     ====================================================================== */
  function suggestCharts(df) {
    const out = [];
    if (!df || !df.shape[0]) return out;
    const cols = df.columns.map(c => c.name);
    const num = numCols(df), cat = catCols(df), dates = dateCols(df);
    const has = n => cols.includes(n);
    const first = arr => arr[0];

    // 取值计数结果（value/count）
    if (has('value') && has('count')) {
      out.push({ type: 'bar', spec: { data: df.rows, x: 'value', y: 'count', title: T('chCount'), onPick: v => filterFromChart({ kind: 'eq', col: cols[cols.indexOf('value')] === 'value' ? lastFilterCol() : lastFilterCol(), value: v }) } });
      out.push({ type: 'donut', spec: { data: df.rows, name: 'value', value: 'count', title: T('chShare'), onPick: v => filterFromChart({ kind: 'eq', col: lastFilterCol(), value: v }) } });
      out.push({ type: 'treemap', spec: { data: df.rows, name: 'value', value: 'count', title: T('chShareArea'), onPick: v => filterFromChart({ kind: 'eq', col: lastFilterCol(), value: v }) } });
      return out;
    }
    // 相关矩阵（column + 数值列）
    if (has('column') && num.length > 2) {
      const dims = num.filter(c => c !== 'column');
      out.push({
        type: 'heatmap', spec: {
          rows: df.rows.map(r => ({ ...r, __label: r.column })), cols: dims, value: (r, c) => r[c], diverging: true,
          title: T('chCorr'), sub: 'Pearson r ∈ [−1, 1]', fmtv: v => v.toFixed(2),
        },
      });
      return out;
    }
    // 透视表 / 交叉表（第一列是索引名，其余为列维度）
    if (has('count') === false && cat.length && num.length >= 2 && df.columns.length <= 14 && !has('date') && !has('statistic')) {
      out.push({
        type: 'heatmap', spec: {
          rows: df.rows.map(r => ({ ...r, __label: r[cols[0]] })), cols: cols.slice(1),
          value: (r, c) => r[c], title: T('chPivot'),
        },
      });
    }
    // 合并结果
    if (has('_merge')) {
      const keys = df.rows.map(r => r[cols[0]]);
      const both = df.rows.filter(r => r._merge === 'both').length;
      out.push({
        type: 'join', spec: {
          leftName: 'df', rightName: 'lookup', leftKeys: df.shape[0], rightKeys: lookupTable.shape[0],
          matched: both, how: 'left', title: T('chJoin'),
          matchedSample: [...new Set(keys)].slice(0, 8).map(String),
        },
      });
    }
    // describe 结果：各统计量的量纲差好几个数量级，按列归一化配色才有可读性。
    // count 行在所有列上几乎相同（都是样本量），放进色阶会把整列的其他统计量压成黑色，
    // 因此图形里去掉这一行——表格页与代码页仍然完整保留它。
    if (has('statistic')) {
      const statRows = df.rows.filter(r => String(r.statistic) !== 'count');
      out.push({
        type: 'heatmap', spec: {
          rows: statRows.map(r => ({ ...r, __label: r.statistic })), cols: numCols(df),
          value: (r, c) => r[c], title: T('chDist'), sub: `${T('opDescribe')} · ${T('descNoCount')}`,
          scale: 'column', scaleNote: T('scalePerCol'),
        },
      });
      return out;
    }
    // 逐列概览（小倍数）—— 日期列按时间轴当成数值看待，否则会被当作分类列、
    // 把 "2026-02-01" 之类截断成一堆看起来一模一样的标签
    const stripItems = df.columns.slice(0, 10).map(c => {
      const isNum = c.dtype === 'float64' || c.dtype === 'int64';
      const isTime = c.dtype === 'datetime64';
      const vals = df.rows.map(r => r[c.name]).filter(v => !isMissing(v));
      return {
        label: c.name, kind: (isNum || isTime) ? 'num' : 'cat',
        values: isTime ? vals.map(v => Date.parse(v)).filter(Number.isFinite) : vals,
      };
    });
    if (stripItems.length) out.push({ type: 'strip', spec: { items: stripItems, title: T('chOverview') } });

    // 是否为"未聚合的原始数据"：此时不能对每一行画一根柱，必须先按类别计数
    const raw = !df.meta.aggregated && df.shape[0] > 30;
    const dim = cat.length ? first(cat) : null;
    const counts = dim ? df.value_counts(dim, { top: 12 }) : null;

    // 分类 + 数值对比：仅当已聚合（或行数很少）时直接画
    if (dim && num.length && !raw) {
      const metrics = num.filter(c => c !== 'count').slice(0, 4);
      if (metrics.length > 1) out.push({ type: 'groupedBar', spec: { data: df.rows, x: dim, series: metrics, title: T('chCompare') } });
      else if (metrics.length === 1) out.push({ type: 'bar', spec: { data: df.rows, x: dim, y: metrics[0], title: T('chCompare'), onPick: v => filterFromChart({ kind: 'eq', col: dim, value: v }) } });
      if (metrics.length > 1) out.push({ type: 'stackedBar', spec: { data: df.rows, x: dim, series: metrics, title: T('chStack'), percent: true } });
      if (metrics.length >= 3 && df.shape[0] >= 3) {
        out.push({
          type: 'radar', spec: {
            axes: metrics, title: T('chRadar'),
            series: df.rows.slice(0, 4).map(r => ({ name: String(r[dim]), values: metrics.map(m => r[m] || 0) })),
          },
        });
      }
    }
    // 原始数据：先聚合为类别计数，再画（避免逐行画柱造成文字重叠）
    if (raw && counts) {
      out.push({
        type: 'bar', spec: {
          data: counts.rows, x: 'value', y: 'count', title: `${T('chCount')} · ${dim}`,
          onPick: v => filterFromChart({ kind: 'eq', col: dim, value: v }),
        },
      });
    }
    // 时间趋势
    if (dates.length && num.length) {
      const dcol = first(dates);
      const y = num.filter(c => c !== 'count')[0];
      const rolling = num.find(c => /rolling/.test(c));
      out.push({ type: 'line', spec: { data: df.rows, x: dcol, series: rolling ? [y, rolling] : [y], title: T('chTrend'), area: true } });
    }
    // 分类 + 数值：箱线
    if (cat.length && num.length && df.shape[0] >= 8) {
      const dim = first(cat), y = num[0];
      const groups = new Map();
      df.rows.forEach(r => { const k = String(r[dim]); if (!groups.has(k)) groups.set(k, []); if (typeof r[y] === 'number') groups.get(k).push(r[y]); });
      const arr = [...groups.entries()].filter(([, v]) => v.length >= 3).slice(0, 8).map(([name, values]) => ({ name, values }));
      if (arr.length >= 2) out.push({ type: 'box', spec: { groups: arr, title: `${T('chBox')} · ${y}` } });
    }
    // 数值分布直方图（前两个）—— 样本太少或取值过于集中时分箱没有意义，直接跳过
    num.slice(0, 2).forEach(c => {
      const vs = df.rows.map(r => r[c]).filter(v => typeof v === 'number' && Number.isFinite(v));
      if (vs.length < 12 || new Set(vs).size < 6) return;
      out.push({ type: 'hist', spec: { values: df.rows.map(r => r[c]), title: `${T('chFreq')} · ${c}`, onPick: r => filterFromChart({ kind: 'range', col: c, range: r }) } });
    });
    // 双数值散点（可框选）
    if (num.length >= 2) {
      out.push({
        type: 'scatter', spec: {
          data: df.rows, x: num[0], y: num[1], colorBy: cat.length ? first(cat) : null,
          title: T('chScatter'), brushHint: T('brushInCard'),
          onBrush: b => filterFromChart({ kind: 'range', col: num[0], range: b.x }),
        },
      });
    }
    // 三数值气泡
    if (num.length >= 3) {
      out.push({ type: 'bubble', spec: { data: df.rows, x: num[0], y: num[1], size: num[2], title: T('chBubble'), scatter: true } });
    }
    // 分类占比
    if (cat.length) {
      const dim = first(cat);
      const vc = df.value_counts(dim, { top: 10 });
      out.push({ type: 'donut', spec: { data: vc.rows, name: 'value', value: 'count', title: `${T('chShare')} · ${dim}`, onPick: v => filterFromChart({ kind: 'eq', col: dim, value: v }) } });
    }
    // 缺失矩阵（只要有缺失）
    const na = df.isna().filter(x => x.missing > 0);
    if (na.length) {
      out.push({ type: 'missing', spec: { rows: df.rows, cols: df.columns.map(c => c.name), isNull: (r, c) => isMissing(r[c]), title: T('chMissing') } });
    }
    return out;
  }

  // 记住最近一次用于筛选的列名（供 value_counts 结果联动）
  function lastFilterCol() {
    for (let i = state.steps.length - 1; i >= 0; i--) {
      const s = state.steps[i];
      if (s.op === 'value_counts' && s.params.col) return s.params.col;
      if (s.op === 'query' && s.expr) { const m = String(s.params.expr).match(/^(\S+)/); if (m) return m[1]; }
    }
    return catCols(state.result)[0] || state.result.columns[0].name;
  }

  /* ======================================================================
     渲染：图形区
     ====================================================================== */
  /* 每个数据形状可以切换的图形类型（同一份数据换不同图形看） */
  function switchableTypes(spec, df) {
    switch (spec.type) {
      case 'bar': return ['bar', 'donut', 'treemap'];
      case 'donut': return ['donut', 'bar', 'treemap'];
      case 'treemap': return ['treemap', 'donut', 'bar'];
      case 'hist': return ['hist'];
      case 'scatter': return ['scatter', 'bubble'];
      case 'bubble': return ['bubble', 'scatter'];
      case 'groupedBar': return ['groupedBar', 'stackedBar'];
      case 'stackedBar': return ['stackedBar', 'groupedBar'];
      case 'line': return ['line'];
      case 'heatmap': return ['heatmap'];
      case 'box': return ['box'];
      case 'radar': return ['radar'];
      case 'strip': return ['strip', 'box'];
      case 'missing': return ['missing'];
      case 'join': return ['join'];
      default: return [spec.type];
    }
  }
  const TYPE_NAME = {
    bar: ['柱状', 'Bar'], donut: ['环形', 'Donut'], treemap: ['矩形树', 'Treemap'], hist: ['直方', 'Histogram'],
    scatter: ['散点', 'Scatter'], bubble: ['气泡', 'Bubble'], groupedBar: ['分组柱', 'Grouped'], stackedBar: ['堆叠', 'Stacked'],
    line: ['折线', 'Line'], heatmap: ['热力', 'Heatmap'], box: ['箱线', 'Box'], radar: ['雷达', 'Radar'],
    strip: ['小倍数', 'Small mult.'], missing: ['缺失', 'Missing'], join: ['连接', 'Join'],
  };
  const tName = k => (TYPE_NAME[k] ? TYPE_NAME[k][window.I18N.getLang() === 'zh' ? 0 : 1] : k);

  // 把一条 spec 转成另一种图形（用于卡片上的类型切换）
  function convertSpec(spec, to, df) {
    if (to === spec.type) return spec;
    const s = spec.spec;
    if (s.rows && (s.value || s.rows.length)) {
      // 分类 + 计数类结果：柱 ↔ 环 ↔ 树
      const recs = s.data || s.rows;
      if (recs && recs[0] && (s.name || s.x) && (s.value || s.y)) {
        const nameKey = s.name || s.x, valKey = s.value || s.y;
        return { type: to, spec: { data: recs, name: nameKey, value: valKey, x: nameKey, y: valKey, title: s.title, unit: s.unit, onPick: s.onPick } };
      }
    }
    if (spec.type === 'groupedBar' || spec.type === 'stackedBar') {
      return { type: to, spec: { ...s, percent: to === 'stackedBar' } };
    }
    if (spec.type === 'scatter' || spec.type === 'bubble') {
      return { type: to, spec: { ...s, size: to === 'bubble' ? (s.size || numCols(df)[2]) : null } };
    }
    if (spec.type === 'strip') {
      // 小倍数 → 箱线：把每列数值变成一组
      return { type: 'box', spec: { groups: s.items.filter(i => i.kind === 'num').map(i => ({ name: i.label, values: i.values })), title: s.title } };
    }
    if (to === 'box' && s.items) {
      return { type: 'box', spec: { groups: s.items.filter(i => i.kind === 'num').map(i => ({ name: i.label, values: i.values })), title: s.title } };
    }
    return spec;
  }

  // 需要整行宽度的图形：横向元素多或需要横向比较
  const WIDE_TYPES = new Set(['missing', 'strip', 'line', 'scatter', 'bubble', 'join', 'treemap']);

  function renderCharts() {
    const host = $('#charts-host');
    host.innerHTML = '';
    const df = state.result;
    const specs = suggestCharts(df);
    if (!specs.length) { host.appendChild(el('p', 'empty', T('noData'))); return; }
    if (specs.some(s => s.type === 'scatter' || s.type === 'hist')) {
      const cap = el('p', 'charts-cap', T('brushLine'));
      cap.style.gridColumn = '1 / -1';
      host.appendChild(cap);
    }
    specs.forEach((s, i) => {
      const box = el('div', 'chart-card');
      // 宽图（趋势、矩阵、小倍数、关系图）占两列，其余按内容自然排布
      if (WIDE_TYPES.has(s.type) || i === 0) box.classList.add('chart-wide');
      // 小倍数的高度由列数决定，不要跟着同排的邻居一起被拉高、在卡片底部留一大块空白
      if (s.type === 'strip') box.classList.add('card-fit');
      host.appendChild(box);
      const types = switchableTypes(s, df);
      if (types.length > 1) {
        const bar = el('div', 'viz-switch');
        const lb = el('span', 'viz-switch-label', window.I18N.getLang() === 'zh' ? '图形' : 'Chart');
        bar.appendChild(lb);
        types.forEach(k => {
          const b = el('button', 'viz-switch-btn' + (k === s.type ? ' active' : ''), tName(k));
          b.type = 'button';
          b.addEventListener('click', () => {
            const next = convertSpec({ ...s, type: k }, k, df);
            s.type = k; s.spec = next.spec;
            renderOne(box, s, df);
            bar.querySelectorAll('.viz-switch-btn').forEach(x => x.classList.toggle('active', x === b));
          });
          bar.appendChild(b);
        });
        box.appendChild(bar);
      }
      const mount = el('div', 'card-mount');
      box.appendChild(mount);
      renderInto(mount, s);
    });
  }

  function renderInto(mount, s) {
    mount.innerHTML = '';
    try {
      if (window.Charts[s.type]) window.Charts[s.type](mount, s.spec);
      else mount.appendChild(el('p', 'empty', 'n/a'));
    } catch (e) {
      mount.innerHTML = `<p class="empty">${T('chartFail')}${esc(e.message)}</p>`;
    }
  }

  // 单卡重绘（类型切换）
  function renderOne(box, s, df) {
    const mount = box.querySelector('.card-mount');
    const next = convertSpec(s, s.type, df);
    s.spec = next.spec;
    renderInto(mount, s);
  }

  /* ======================================================================
     渲染：操作面板
     ====================================================================== */
  const GROUP_ORDER = ['grpInspect', 'grpSelect', 'grpClean', 'grpCompute', 'grpAgg', 'grpRelate'];
  const openGroups = new Set(['grpInspect']);
  let activeOp = null;

  function defaultParams(opKey) {
    const op = OPS[opKey];
    const df = state.result || state.base;
    const p = {};
    op.fields.forEach(f => {
      if (f.type === 'num') p[f.k] = f.def;
      else if (f.type === 'enum') p[f.k] = f.def ?? f.opts[0][0];
      else if (f.type === 'bool') p[f.k] = f.def ?? true;
      else if (f.type === 'text') p[f.k] = f.def ?? '';
      else if (f.type === 'col') {
        const pool = f.num ? numCols(df) : f.cat ? catCols(df) : colSelectable(df);
        p[f.k] = (pool[0] || colSelectable(df)[0] || '');
        p['__opts_' + f.k] = pool;
      } else if (f.type === 'cols') {
        const pool = f.num ? numCols(df) : f.cat ? catCols(df) : colSelectable(df);
        p[f.k] = [pool[0]].filter(Boolean);
        p['__opts_' + f.k] = pool;
      }
    });
    return p;
  }

  function renderPalette() {
    const host = $('#ops-host');
    host.innerHTML = '';
    GROUP_ORDER.forEach(g => {
      const items = Object.entries(OPS).filter(([, o]) => o.group === g);
      const sec = el('section', 'op-group');
      const head = el('button', 'op-group-head');
      head.type = 'button';
      head.setAttribute('aria-expanded', String(openGroups.has(g)));
      head.innerHTML = `<span>${T(g)}</span><i class="op-caret"></i>`;
      head.addEventListener('click', () => { openGroups.has(g) ? openGroups.delete(g) : openGroups.add(g); renderPalette(); });
      sec.appendChild(head);
      const body = el('div', 'op-group-body');
      body.hidden = !openGroups.has(g);
      items.forEach(([key, op]) => {
        const b = el('button', 'op-btn' + (activeOp === key ? ' active' : ''));
        b.type = 'button';
        b.textContent = T(op.labelKey);
        b.addEventListener('click', () => { activeOp = activeOp === key ? null : key; renderPalette(); renderOpForm(); });
        body.appendChild(b);
      });
      sec.appendChild(body);
      host.appendChild(sec);
    });
  }

  function renderOpForm() {
    const host = $('#op-form');
    host.innerHTML = '';
    if (!activeOp) {
      host.appendChild(el('p', 'form-hint', T('pipelineEmpty')));
      return;
    }
    const op = OPS[activeOp];
    const df = state.result || state.base;
    const p = defaultParams(activeOp);
    const form = el('div', 'op-form-inner');
    form.appendChild(el('h4', 'form-title', T(op.labelKey)));

    const mkField = f => {
      const row = el('label', 'field');
      const label = el('span', 'field-label');
      label.textContent = f.type === 'enum' && /^p/.test(f.label) ? T(f.label) : T(f.label);
      row.appendChild(label);
      const opts = p['__opts_' + f.k] || [];
      if (f.type === 'num') {
        const inp = el('input'); inp.type = 'range'; inp.min = f.min; inp.max = f.max; inp.value = p[f.k];
        const out = el('output', 'field-out', String(p[f.k]));
        inp.addEventListener('input', () => { out.textContent = inp.value; });
        const line = el('span', 'field-line'); line.appendChild(inp); line.appendChild(out);
        row.appendChild(line);
      } else if (f.type === 'text') {
        const inp = el('input'); inp.type = 'text'; inp.value = p[f.k] || ''; inp.spellcheck = false;
        inp.addEventListener('input', () => { p[f.k] = inp.value; });
        row.appendChild(inp);
      } else if (f.type === 'bool') {
        const inp = el('input'); inp.type = 'checkbox'; inp.checked = !!p[f.k];
        inp.addEventListener('change', () => { p[f.k] = inp.checked; });
        row.appendChild(inp);
      } else if (f.type === 'enum') {
        const sel = el('select');
        f.opts.forEach(([v, lk]) => { const o = el('option', null, /^[a-z]+$/.test(lk) && T(lk) !== lk ? T(lk) : lk); o.value = v; sel.appendChild(o); });
        sel.value = p[f.k];
        sel.addEventListener('change', () => { p[f.k] = sel.value; });
        row.appendChild(sel);
      } else if (f.type === 'col') {
        const sel = el('select');
        opts.forEach(v => { const o = el('option', null, v); o.value = v; sel.appendChild(o); });
        sel.value = p[f.k];
        sel.addEventListener('change', () => { p[f.k] = sel.value; });
        row.appendChild(sel);
      } else if (f.type === 'cols') {
        const box = el('div', 'multi');
        opts.forEach(v => {
          const lab = el('label', 'multi-item');
          const cb = el('input'); cb.type = 'checkbox'; cb.value = v; cb.checked = (p[f.k] || []).includes(v);
          cb.addEventListener('change', () => {
            const set = new Set(p[f.k] || []);
            cb.checked ? set.add(v) : set.delete(v);
            p[f.k] = [...set];
          });
          lab.appendChild(cb); lab.appendChild(document.createTextNode(v));
          box.appendChild(lab);
        });
        row.appendChild(box);
      }
      return row;
    };
    op.fields.forEach(f => form.appendChild(mkField(f)));
    if (activeOp === 'query' || activeOp === 'assign') {
      form.appendChild(el('p', 'form-hint', T('expressionHelp')));
    }
    if (activeOp === 'merge') {
      const f = op.fields.find(x => x.k === 'key');
      const common = colSelectable(df).filter(c => lookupTable.columns.some(l => l.name === c));
      f.opts = common.map(c => [c, c]);
      if (!f.opts.length) f.opts = [['course', 'course']];
    }
    const run = el('button', 'btn btn-primary', T('run'));
    run.type = 'button';
    run.addEventListener('click', () => {
      const clean = {};
      Object.keys(p).forEach(k => { if (!k.startsWith('__')) clean[k] = p[k]; });
      try { addStep(activeOp, clean); activeOp = null; renderPalette(); renderOpForm(); }
      catch (e) { form.appendChild(el('p', 'form-error', T('loadError') + e.message)); }
    });
    form.appendChild(run);
    host.appendChild(form);
  }

  /* ======================================================================
     渲染：流水线
     ====================================================================== */
  function renderPipeline() {
    const host = $('#pipeline-host');
    host.innerHTML = '';
    const chip = el('div', 'pipe-chip pipe-base', `<b>${T('base')}</b><span>df · ${state.base.shape[0]} × ${state.base.shape[1]}</span>`);
    host.appendChild(chip);
    if (!state.steps.length) {
      host.appendChild(el('p', 'pipe-empty', T('pipelineEmpty')));
    }
    state.steps.forEach((s, i) => {
      host.appendChild(el('span', 'pipe-arrow', '→'));
      const prev = i === 0 ? state.base : null;
      const card = el('div', 'pipe-chip' + (s.fromChart ? ' pipe-fromchart' : ''));
      card.innerHTML = `<b>${T('stepN', { n: i + 1 })}</b><span>${esc(T(OPS[s.op].labelKey))}</span>${s.fromChart ? '<i class="pipe-src" title="来自图形点击">▣</i>' : ''}`;
      const del = el('button', 'pipe-del', '×');
      del.title = T('removeStep'); del.setAttribute('aria-label', T('removeStep'));
      del.addEventListener('click', () => removeStep(i));
      card.appendChild(del);
      host.appendChild(card);
      void prev;
    });
    if (state.steps.length) {
      const acts = el('div', 'pipe-actions');
      const u = el('button', 'btn btn-ghost', T('undo')); u.addEventListener('click', () => removeStep(state.steps.length - 1));
      const c = el('button', 'btn btn-ghost', T('clearAll')); c.addEventListener('click', clearSteps);
      acts.appendChild(u); acts.appendChild(c);
      host.appendChild(acts);
    }
    // 代码回显
    const code = buildCode();
    $('#code-host').textContent = code;
  }

  function buildCode() {
    const lines = ['import pandas as pd', '', 'df = pd.read_csv("sample.csv")', ''];
    let cur = 'df';
    state.steps.forEach((s, i) => {
      const v = 'df' + (i + 1);
      lines.push(`${v} = ${s.code.replace(/^df/, cur)}`);
      cur = v;
    });
    if (state.steps.length) lines.push('', `result = ${cur}    # ${state.result.shape[0]} × ${state.result.shape[1]}`);
    else lines.push('# ' + T('noStepsYet'));
    return lines.join('\n');
  }

  /* ======================================================================
     渲染：总览与视图
     ====================================================================== */
  function renderSummary() {
    const df = state.result;
    $('#result-shape').textContent = `${df.shape[0]} ${T('rows')} × ${df.shape[1]} ${T('cols')}`;
    $('#result-mem').textContent = `${T('memoryUse')} ${(df.memory() / 1024).toFixed(1)} KB`;
    const dtHost = $('#result-dtypes');
    dtHost.innerHTML = df.dtypes.slice(0, 14).map(d =>
      `<span class="dtype-chip" title="${esc(d.dtype)}"><b>${esc(d.column)}</b><i>${esc(d.dtype)}</i></span>`).join('')
      + (df.dtypes.length > 14 ? `<span class="dtype-chip more">+${df.dtypes.length - 14}</span>` : '');
    // 缺失概览
    const na = df.isna().filter(x => x.missing > 0);
    $('#result-null').innerHTML = na.length
      ? na.slice(0, 6).map(x => `<span class="null-chip">${esc(x.column)} <b>${x.missing}</b></span>`).join('')
      : `<span class="ok-chip">✓ ${T('noMissing')}</span>`;
  }

  function setView(v) {
    state.view = v;
    $$('.tab-btn').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
    ['charts', 'table', 'code'].forEach(k => { $('#view-' + k).hidden = k !== v; });
    if (v === 'charts') renderCharts();
    if (v === 'table') renderTable(state.result);
  }

  function renderAll() {
    recompute();
    renderPalette();
    renderOpForm();
    renderPipeline();
    renderSummary();
    if (state.view === 'charts') renderCharts();
    if (state.view === 'table') renderTable(state.result);
    renderDatasetBar();
  }

  function renderDatasetBar() {
    const b = state.base;
    $('#ds-name').textContent = T(state.baseLabel);
    $('#ds-shape').textContent = `${b.shape[0]} ${T('rows')} × ${b.shape[1]} ${T('cols')}`;
    const na = b.isna().reduce((n, x) => n + x.missing, 0);
    $('#ds-null').textContent = na ? `${na} ${T('cellNull')}` : '0';
    $('#ds-note').textContent = state.baseLabel === 'srcSample' ? T('dataDefaultNote') : '';
  }

  /* ======================================================================
     数据载入
     ====================================================================== */
  function loadSample() {
    state.base = new DataFrame(window.SAMPLE.build());
    state.baseLabel = 'srcSample';
    state.steps = []; state.page = 0; state.search = '';
    $('#search-input').value = '';
    renderAll(); setView('charts');
  }
  function loadText(text, label) {
    try {
      const df = DataFrame.fromCSV(text);
      if (!df.shape[0] || !df.shape[1]) throw new Error(T('noRowsParsed'));
      state.base = df; state.baseLabel = label;
      state.steps = []; state.page = 0; state.search = '';
      $('#search-input').value = '';
      renderAll(); setView('charts');
      return true;
    } catch (e) {
      $('#data-error').textContent = T('loadError') + e.message;
      $('#data-error').hidden = false;
      return false;
    }
  }

  /* ======================================================================
     双语切换
     ====================================================================== */
  function applyStaticText() {
    document.documentElement.lang = window.I18N.getLang() === 'zh' ? 'zh-CN' : 'en';
    $$('[data-t]').forEach(n => {
      const k = n.dataset.t;
      if (k === 'aboutBody' || k === 'dataDefaultNote') { n.textContent = T(k); n.hidden = !T(k); return; }
      n.textContent = T(k);
    });
    $$('[data-t-title]').forEach(n => { n.title = T(n.dataset.tTitle); n.setAttribute('aria-label', T(n.dataset.tTitle)); });
    $('#lang-btn').textContent = T('langBtn');
    // 说明区列表：aboutPoints / limits 是「[中文, English]」成对的条目数组，
    // 所以要先遍历所有条目、再按语言取对应的一侧；直接 [语言下标] 会只取到其中一条。
    const langIdx = window.I18N.getLang() === 'zh' ? 0 : 1;
    const toLi = pair => `<li>${String(pair[langIdx]).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>`;
    const pts = $('#about-points'); if (pts) pts.innerHTML = window.I18N.DICT.aboutPoints.map(toLi).join('');
    const lim = $('#limit-list'); if (lim) lim.innerHTML = window.I18N.DICT.limits.map(toLi).join('');
  }

  /* ======================================================================
     初始化
     ====================================================================== */
  function init() {
    // 静态文案
    applyStaticText();

    // 数据集信息条
    loadSample();

    // 语言切换
    $('#lang-btn').addEventListener('click', () => {
      window.I18N.setLang(window.I18N.getLang() === 'zh' ? 'en' : 'zh');
      applyStaticText();
      renderAll();
    });

    // 视图切换
    $$('.tab-btn').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

    // 数据面板
    $('#data-toggle').addEventListener('click', () => {
      const box = $('#data-box');
      box.hidden = !box.hidden;
      $('#data-toggle').setAttribute('aria-expanded', String(!box.hidden));
    });
    $('#btn-load').addEventListener('click', () => {
      const txt = $('#data-text').value.trim();
      if (!txt) return;
      loadText(txt, 'srcPaste');
    });
    $('#btn-file').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => { $('#data-text').value = String(r.result).slice(0, 200000); loadText(String(r.result), 'srcFile'); };
      r.readAsText(f, 'utf-8');
    });
    $('#btn-reset').addEventListener('click', () => loadSample());
    $('#data-drop').addEventListener('dragover', e => { e.preventDefault(); $('#data-drop').classList.add('over'); });
    $('#data-drop').addEventListener('dragleave', () => $('#data-drop').classList.remove('over'));
    $('#data-drop').addEventListener('drop', e => {
      e.preventDefault(); $('#data-drop').classList.remove('over');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => { $('#data-text').value = String(r.result).slice(0, 200000); loadText(String(r.result), 'srcFile'); };
      r.readAsText(f, 'utf-8');
    });

    // 搜索
    $('#search-input').addEventListener('input', e => { state.search = e.target.value.trim(); state.page = 0; renderTable(state.result); });

    // 复制代码
    $('#copy-btn').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('#code-host').textContent); $('#copy-btn').textContent = T('copied'); }
      catch { $('#copy-btn').textContent = T('copyHint'); }
      setTimeout(() => { $('#copy-btn').textContent = T('copyCode'); }, 1800);
    });

    setView('charts');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* 供测试脚本调用 */
  window.Workbench = { state, OPS, addStep, recompute, suggestCharts, filterFromChart, loadText, loadSample, setView, renderAll };
})();
