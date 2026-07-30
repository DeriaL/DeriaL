#!/usr/bin/env node
/**
 * Generates stats.svg and chart.svg from live GitHub data.
 * No dependencies — Node 20+ (global fetch).
 *
 * Env:
 *   GH_TOKEN  classic PAT with read:user + repo (repo is what makes
 *             private contributions visible)
 *   GH_LOGIN  github handle (default: DeriaL)
 */

import { writeFileSync } from 'node:fs';

const TOKEN = process.env.GH_TOKEN;
const LOGIN = process.env.GH_LOGIN || 'DeriaL';
if (!TOKEN) throw new Error('GH_TOKEN is required');

const ACCENT = { from: '#0E7490', mid: '#1D4ED8', to: '#6D28D9' };
const FONT = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

async function gql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': `${LOGIN}-profile-stats`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

const Q_PROFILE = `
query ($login: String!) {
  user(login: $login) {
    createdAt
    repositories(ownerAffiliations: OWNER, first: 1) { totalCount }
    pullRequests(first: 1) { totalCount }
    issues(first: 1) { totalCount }
  }
}`;

const Q_YEAR = `
query ($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

/** contributionsCollection spans at most one year, so walk year by year. */
async function collect() {
  const profile = await gql(Q_PROFILE, { login: LOGIN });
  const createdAt = new Date(profile.user.createdAt);
  const now = new Date();

  let commitsAllTime = 0;
  let contributionsAllTime = 0;

  for (let y = createdAt.getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    const from = new Date(Date.UTC(y, 0, 1)).toISOString();
    const to = new Date(Date.UTC(y, 11, 31, 23, 59, 59)).toISOString();
    const { user } = await gql(Q_YEAR, { login: LOGIN, from, to });
    const c = user.contributionsCollection;
    commitsAllTime += c.totalCommitContributions + c.restrictedContributionsCount;
    contributionsAllTime += c.contributionCalendar.totalContributions;
  }

  // rolling 365 days for the calendar-derived numbers and the chart
  const to = now.toISOString();
  const from = new Date(now.getTime() - 364 * 864e5).toISOString();
  const { user } = await gql(Q_YEAR, { login: LOGIN, from, to });
  const cal = user.contributionsCollection.contributionCalendar;
  const days = cal.weeks.flatMap((w) => w.contributionDays);

  const activeDays = days.filter((d) => d.contributionCount > 0).length;
  let best = 0, run = 0, current = 0;
  for (const d of days) {
    if (d.contributionCount > 0) { run++; best = Math.max(best, run); }
    else run = 0;
  }
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) current++;
    else break;
  }

  // monthly buckets, oldest → newest
  const buckets = new Map();
  for (const d of days) {
    const key = d.date.slice(0, 7);
    buckets.set(key, (buckets.get(key) || 0) + d.contributionCount);
  }
  const months = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-12);

  return {
    commitsAllTime,
    contributionsAllTime,
    contributionsYear: cal.totalContributions,
    activeDays,
    bestStreak: best,
    currentStreak: current,
    repos: profile.user.repositories.totalCount,
    prs: profile.user.pullRequests.totalCount,
    since: createdAt.getUTCFullYear(),
    months,
  };
}

const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function defs() {
  return `
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
}

function statsSvg(s) {
  const cells = [
    [fmt(s.commitsAllTime), 'TOTAL COMMITS'],
    [fmt(s.contributionsYear), 'CONTRIBUTIONS / YEAR'],
    [fmt(s.activeDays), 'ACTIVE DAYS'],
    [fmt(s.bestStreak), 'LONGEST STREAK'],
    [fmt(s.repos), 'REPOSITORIES'],
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

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(fmt(s.commitsAllTime))} total commits, ${esc(fmt(s.contributionsYear))} contributions in the last year, ${s.activeDays} active days, longest streak ${s.bestStreak} days, ${s.repos} repositories">
${defs()}
  <rect width="${W}" height="${H}" rx="14" fill="url(#band)"/>
  <rect width="${W}" height="${H}" rx="14" fill="url(#sheen)"/>
  ${rules}
  <g font-family="${FONT}" text-anchor="middle">
    ${text}
  </g>
</svg>
`;
}

function chartSvg(s) {
  const W = 1200, H = 300;
  const padL = 56, padR = 24, padT = 62, padB = 46;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(1, ...s.months.map(([, v]) => v));
  const niceMax = Math.ceil(max / 50) * 50 || 50;
  const n = s.months.length;
  const slot = plotW / n;
  const barW = Math.min(52, slot * 0.56);

  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(niceMax * f));
  const grid = gridVals.map((v) => {
    const y = (padT + plotH - (v / niceMax) * plotH).toFixed(1);
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#ffffff" stroke-opacity="0.13"/>
  <text x="${padL - 12}" y="${(+y + 4).toFixed(1)}" font-size="11" fill="#ffffff" fill-opacity="0.55" text-anchor="end">${v}</text>`;
  }).join('\n  ');

  const bars = s.months.map(([key, v], i) => {
    const h = (v / niceMax) * plotH;
    const x = padL + slot * i + (slot - barW) / 2;
    const y = padT + plotH - h;
    const label = new Date(key + '-01T00:00:00Z')
      .toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const valTxt = v > 0
      ? `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 7).toFixed(1)}" font-size="11" font-weight="600" fill="#ffffff" fill-opacity="0.85" text-anchor="middle">${v}</text>`
      : '';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, 1.5).toFixed(1)}" rx="4" fill="url(#bar)"/>
  ${valTxt}
  <text x="${(x + barW / 2).toFixed(1)}" y="${(padT + plotH + 22).toFixed(1)}" font-size="11" fill="#ffffff" fill-opacity="0.62" text-anchor="middle">${label}</text>`;
  }).join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Monthly contributions over the last twelve months, ${esc(fmt(s.contributionsYear))} in total">
${defs()}
  <rect width="${W}" height="${H}" rx="14" fill="url(#band)"/>
  <rect width="${W}" height="${H}" rx="14" fill="url(#sheen)"/>
  <g font-family="${FONT}">
    <text x="${padL - 12}" y="34" font-size="16" font-weight="700" fill="#ffffff">Contributions per month</text>
    <text x="${padL - 12}" y="52" font-size="12" fill="#ffffff" fill-opacity="0.70">last 12 months &#183; ${esc(fmt(s.contributionsYear))} total &#183; ${s.activeDays} active days &#183; current streak ${s.currentStreak}d</text>
  ${grid}
  ${bars}
  </g>
</svg>
`;
}

const s = await collect();
writeFileSync('stats.svg', statsSvg(s));
writeFileSync('chart.svg', chartSvg(s));
console.log(JSON.stringify(s, null, 2));
