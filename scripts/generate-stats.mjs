#!/usr/bin/env node
/**
 * Renders stats.svg and chart.svg from GitHub's public contribution data.
 *
 * No token, no secret, no dependencies — Node 20+ (global fetch).
 * Private commits are included because the account has
 * "Include private contributions on my profile" enabled, which makes the
 * per-day counts public on /users/<login>/contributions.
 *
 * Env: GH_LOGIN (default: DeriaL)
 */

import { writeFileSync } from 'node:fs';

const LOGIN = process.env.GH_LOGIN || 'DeriaL';
const UA = { 'User-Agent': `${LOGIN}-profile-stats`, Accept: 'text/html,application/json' };

const ACCENT = { from: '#0E7490', mid: '#1D4ED8', to: '#6D28D9' };
const FONT = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
};

/** Exact per-day counts for one calendar year, parsed from the public fragment. */
async function year(y) {
  const url = `https://github.com/users/${LOGIN}/contributions?from=${y}-01-01&to=${y}-12-31`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const html = await res.text();

  // tool-tip[for=<cell id>] carries the exact number as text
  const tips = new Map();
  for (const m of html.matchAll(/<tool-tip\b([^>]*)>([\s\S]*?)<\/tool-tip>/g)) {
    const id = attr(m[1], 'for');
    if (id) tips.set(id, m[2].replace(/<[^>]*>/g, '').trim());
  }

  const days = [];
  for (const m of html.matchAll(/<td\b([^>]*)>/g)) {
    const date = attr(m[1], 'data-date');
    const id = attr(m[1], 'id');
    if (!date || !id) continue;
    const text = tips.get(id);
    if (!text) continue;
    const c = text.match(/^(No|[\d,]+)\s+contributions?/i);
    if (!c) continue;
    days.push({
      date,
      count: c[1].toLowerCase() === 'no' ? 0 : parseInt(c[1].replace(/,/g, ''), 10),
    });
  }

  days.sort((a, b) => a.date.localeCompare(b.date));
  const total = days.reduce((s, d) => s + d.count, 0);

  // cross-check against the heading GitHub renders itself
  const stated = html.match(/([\d,]+)\s*contributions?\s*in\s*\d{4}/i);
  if (stated) {
    const want = parseInt(stated[1].replace(/,/g, ''), 10);
    if (want !== total) console.warn(`⚠ ${y}: parsed ${total}, page says ${want}`);
  }
  return { days, total };
}

async function firstYear() {
  try {
    const res = await fetch(`https://api.github.com/users/${LOGIN}`, { headers: UA });
    if (res.ok) return new Date((await res.json()).created_at).getUTCFullYear();
  } catch {}
  return new Date().getUTCFullYear() - 3;
}

async function collect() {
  const now = new Date();
  const thisYear = now.getUTCFullYear();
  const start = Math.min(await firstYear(), thisYear);

  let allTime = 0;
  const byDate = new Map();
  for (let y = start; y <= thisYear; y++) {
    const { days, total } = await year(y);
    allTime += total;
    for (const d of days) byDate.set(d.date, d.count);
  }

  // rolling 365 days
  const window = [];
  for (let i = 364; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 864e5).toISOString().slice(0, 10);
    window.push({ date: d, count: byDate.get(d) ?? 0 });
  }

  const yearTotal = window.reduce((s, d) => s + d.count, 0);
  const activeDays = window.filter((d) => d.count > 0).length;
  const busiest = window.reduce((a, b) => (b.count > a.count ? b : a), window[0]);

  let best = 0, run = 0, current = 0;
  for (const d of window) { if (d.count > 0) { run++; best = Math.max(best, run); } else run = 0; }
  for (let i = window.length - 1; i >= 0; i--) { if (window[i].count > 0) current++; else break; }

  const buckets = new Map();
  for (const d of window) {
    const k = d.date.slice(0, 7);
    buckets.set(k, (buckets.get(k) || 0) + d.count);
  }
  const months = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-12);

  return { allTime, yearTotal, activeDays, best, current, busiest, months, since: start };
}

const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const DEFS = `
  <defs>
    <linearGradient id="band" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${ACCENT.from}"/>
      <stop offset="50%" stop-color="${ACCENT.mid}"/>
      <stop offset="100%" stop-color="${ACCENT.to}"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#67E8F9" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#818CF8" stop-opacity="0.55"/>
    </linearGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="50%" stop-color="#ffffff" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.5" cy="0" r="0.9">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>`;

export function statsSvg(s) {
  const cells = [
    [fmt(s.allTime), 'TOTAL CONTRIBUTIONS'],
    [fmt(s.yearTotal), 'LAST 12 MONTHS'],
    [fmt(s.activeDays), 'ACTIVE DAYS'],
    [fmt(s.best), 'LONGEST STREAK'],
    [fmt(s.busiest.count), 'BUSIEST DAY'],
  ];
  const W = 1200, H = 150, step = W / cells.length;
  const rules = cells.slice(1)
    .map((_, i) => `<rect x="${((i + 1) * step).toFixed(1)}" y="30" width="1.5" height="90" fill="url(#rule)"/>`)
    .join('\n  ');
  const text = cells.map(([v, l], i) => {
    const x = (step * i + step / 2).toFixed(1);
    return `<text x="${x}" y="78" font-size="42" font-weight="700" fill="#ffffff">${esc(v)}</text>
    <text x="${x}" y="104" font-size="12" font-weight="500" fill="#ffffff" fill-opacity="0.80" letter-spacing="1.4">${esc(l)}</text>`;
  }).join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(fmt(s.allTime))} contributions all time, ${esc(fmt(s.yearTotal))} in the last twelve months, ${s.activeDays} active days, longest streak ${s.best} days, busiest day ${s.busiest.count}">
${DEFS}
  <rect width="${W}" height="${H}" rx="14" fill="url(#band)"/>
  <rect width="${W}" height="${H}" rx="14" fill="url(#sheen)"/>
  ${rules}
  <g font-family="${FONT}" text-anchor="middle">
    ${text}
  </g>
</svg>
`;
}

export function chartSvg(s) {
  const W = 1200, H = 300;
  const padL = 58, padR = 26, padT = 64, padB = 46;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(1, ...s.months.map(([, v]) => v));
  const niceMax = Math.max(50, Math.ceil(max / 50) * 50);
  const n = Math.max(1, s.months.length);
  const slot = plotW / n;
  const barW = Math.min(54, slot * 0.56);

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = Math.round(niceMax * f);
    const y = (padT + plotH - f * plotH).toFixed(1);
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#ffffff" stroke-opacity="0.13"/>
  <text x="${padL - 12}" y="${(+y + 4).toFixed(1)}" font-size="11" fill="#ffffff" fill-opacity="0.55" text-anchor="end">${v}</text>`;
  }).join('\n  ');

  const bars = s.months.map(([key, v], i) => {
    const h = (v / niceMax) * plotH;
    const x = padL + slot * i + (slot - barW) / 2;
    const y = padT + plotH - h;
    const label = new Date(`${key}-01T00:00:00Z`)
      .toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const val = v > 0
      ? `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 7).toFixed(1)}" font-size="11" font-weight="600" fill="#ffffff" fill-opacity="0.88" text-anchor="middle">${v}</text>`
      : '';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, 1.5).toFixed(1)}" rx="4" fill="url(#bar)"/>
  ${val}
  <text x="${(x + barW / 2).toFixed(1)}" y="${(padT + plotH + 22).toFixed(1)}" font-size="11" fill="#ffffff" fill-opacity="0.62" text-anchor="middle">${label}</text>`;
  }).join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Contributions per month over the last twelve months, ${esc(fmt(s.yearTotal))} in total">
${DEFS}
  <rect width="${W}" height="${H}" rx="14" fill="url(#band)"/>
  <rect width="${W}" height="${H}" rx="14" fill="url(#sheen)"/>
  <g font-family="${FONT}">
    <text x="${padL - 12}" y="34" font-size="16" font-weight="700" fill="#ffffff">Contributions per month</text>
    <text x="${padL - 12}" y="52" font-size="12" fill="#ffffff" fill-opacity="0.70">last 12 months &#183; ${esc(fmt(s.yearTotal))} total &#183; ${s.activeDays} active days &#183; longest streak ${s.best}d</text>
  ${grid}
  ${bars}
  </g>
</svg>
`;
}

// run as a script, not when imported
if (process.argv[1] && process.argv[1].endsWith('generate-stats.mjs')) {
  const s = await collect();
  writeFileSync('stats.svg', statsSvg(s));
  writeFileSync('chart.svg', chartSvg(s));
  console.log(JSON.stringify({ ...s, months: undefined, busiest: s.busiest }, null, 2));
}
