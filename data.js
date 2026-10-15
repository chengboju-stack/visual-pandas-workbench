'use strict';
/* ==========================================================================
   data.js · 默认示例数据集
   ── 用固定种子生成，每次刷新完全一致（可复现）。
   ── 分类值使用简短英文码，使数据本身在中文/英文界面下完全相同（双语内容一致）。
   ── 这是**示例数据**，用于演示数据操作，不代表任何真实结论。
   列：date / region / channel / course / users / sessions / minutes /
      completion / revenue(含缺失) / rating(含缺失) / instructor
   ========================================================================== */
(function () {
  const REGIONS = ['East', 'North', 'South', 'West', 'Overseas'];
  const CHANNELS = ['Organic', 'Search', 'Social', 'Referral'];
  const COURSES = ['Python', 'Viz', 'Stats', 'ML'];
  const INSTRUCTORS = ['Chen', 'Liu', 'Wang', 'Zhao'];

  const REGION_W = { East: 1.35, North: 1.15, South: 1.05, West: 0.8, Overseas: 0.65 };
  const CHANNEL_W = { Organic: 1.2, Search: 1.0, Social: 0.85, Referral: 0.7 };
  const COURSE_W = { Python: 1.25, Viz: 1.0, Stats: 0.8, ML: 1.1 };

  function build(seed = 20261015) {
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const pick = (arr, w) => {
      const weight = w || null;
      if (!weight) return arr[Math.floor(rnd() * arr.length)];
      const total = arr.reduce((n, k) => n + weight[k], 0);
      let r = rnd() * total;
      for (const k of arr) { r -= weight[k]; if (r <= 0) return k; }
      return arr[arr.length - 1];
    };
    const round = (v, d = 1) => Math.round(v * Math.pow(10, d)) / Math.pow(10, d);

    const rows = [];
    const start = Date.UTC(2026, 0, 1);
    const DAYS = 180;
    for (let d = 0; d < DAYS; d++) {
      const date = new Date(start + d * 86400000).toISOString().slice(0, 10);
      const weekday = new Date(start + d * 86400000).getUTCDay();
      const weekend = weekday === 0 || weekday === 6 ? 0.72 : 1;
      const trend = 1 + (d / DAYS) * 0.55;               // 缓慢上升趋势
      const season = 1 + 0.18 * Math.sin((d / 30) * Math.PI * 2);
      // 每天 3~4 条组合行
      const combos = 3 + (rnd() > 0.55 ? 1 : 0);
      const used = new Set();
      for (let c = 0; c < combos; c++) {
        let region, channel, course, key;
        let guard = 0;
        do {
          region = pick(REGIONS, REGION_W);
          channel = pick(CHANNELS, CHANNEL_W);
          course = pick(COURSES, COURSE_W);
          key = region + '|' + channel + '|' + course;
        } while (used.has(key) && ++guard < 12);
        used.add(key);

        const base = 220 * REGION_W[region] * CHANNEL_W[channel] * COURSE_W[course] * weekend * trend * season;
        const users = Math.max(8, Math.round(base * (0.85 + rnd() * 0.3)));
        const sessions = Math.round(users * (1.15 + rnd() * 0.5));
        const minutes = round(users * (14 + rnd() * 12), 1);   // 总学习分钟数
        const completion = round(Math.min(0.99, 0.32 + 0.34 * (COURSE_W[course] - 0.8) + 0.12 * (REGION_W[region] - 0.8) + rnd() * 0.22), 3);
        const revenue = round(users * (2.4 + rnd() * 3.6) * (channel === 'Referral' ? 1.25 : 1), 2);
        const rating = Math.min(5, round(3.4 + 1.1 * rnd() + (course === 'Viz' ? 0.25 : 0), 2));
        const row = {
          date, region, channel, course,
          users, sessions, minutes, completion,
          revenue, rating,
          instructor: pick(INSTRUCTORS),
        };
        // 人为注入缺失值（约 6% / 4%）与少量重复行，用于演示缺失值处理与去重
        if (rnd() < 0.06) row.revenue = null;
        if (rnd() < 0.04) row.rating = null;
        rows.push(row);
        if (rnd() < 0.025) rows.push({ ...row });          // 完全重复行
      }
    }
    return rows;
  }

  // 第二张表：课程维表（用于演示 merge）
  function coursesTable() {
    return [
      { course: 'Python', level: 'Beginner', hours: 12, price: 199 },
      { course: 'Viz', level: 'Intermediate', hours: 16, price: 259 },
      { course: 'Stats', level: 'Intermediate', hours: 14, price: 229 },
      { course: 'ML', level: 'Advanced', hours: 22, price: 359 },
    ];
  }

  const api = { build, coursesTable, REGIONS, CHANNELS, COURSES, INSTRUCTORS, META: { seed: 20261015, days: 180 } };
  if (typeof window !== 'undefined') window.SAMPLE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
