#!/usr/bin/env node
// Click a song, hear its most replayed part. Zero dependencies (Node 18+).
//
//   node index.js [playlist url or id]
//
// PORT sets the port (default 3000). REFRESH_MINUTES sets how often the
// playlist is re-checked (default 5).
//
// This has to be a server: YouTube's replay heatmap isn't in any public API,
// and browsers can't read it from youtube.com because of CORS.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PLAYLIST = 'PLNsE3uFd0UN4';
const input = process.argv[2] || DEFAULT_PLAYLIST;
const PLAYLIST_ID = (input.match(/[?&]list=([\w-]+)/) || [, input])[1];
const START_PORT = Number(process.env.PORT) || 3000;
const REFRESH_MS = (Number(process.env.REFRESH_MINUTES) || 5) * 60 * 1000;

const HEAT_MAX_AGE = 7 * 24 * 3600 * 1000;   // replay data changes slowly
const NO_HEAT_MAX_AGE = 24 * 3600 * 1000;    // newer songs may gain it soon
const CACHE_FILE = path.join(os.tmpdir(), `hover-playlist-v1-${PLAYLIST_ID}.json`);

// ---------------------------------------------------------------- YouTube

const CONTEXT = { client: { clientName: 'WEB', clientVersion: '2.20251101.01.00', hl: 'en', gl: 'US' } };
const HEADERS = {
  'content-type': 'application/json',
  origin: 'https://www.youtube.com',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
};

async function yt(endpoint, body) {
  const res = await fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ context: CONTEXT, ...body }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`YouTube ${endpoint} returned HTTP ${res.status}`);
  return res.json();
}

function find(node, key, out = []) {
  if (node && typeof node === 'object') {
    for (const k in node) {
      if (k === key) out.push(node[k]);
      find(node[k], key, out);
    }
  }
  return out;
}

// Pages also contain lockups and tokens for unrelated shelves, so only read
// arrays that actually hold the video list. Its next-page token is that
// array's own trailing item.
function readPage(node, page = { items: [], token: null }) {
  if (Array.isArray(node) && node.some(el => el && el.lockupViewModel)) {
    for (const el of node) {
      if (el.lockupViewModel) page.items.push(el.lockupViewModel);
      else if (el.continuationItemViewModel && !page.token) {
        page.token = find(el, 'token').find(Boolean) || null;
      }
    }
  } else if (node && typeof node === 'object') {
    for (const k in node) readPage(node[k], page);
  }
  return page;
}

function parseClock(text) {
  return text.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}

function toSong(lockup) {
  const meta = lockup.metadata.lockupMetadataViewModel;
  const rows = find(meta, 'metadataRows')[0] || [];
  const parts = (rows[0] && rows[0].metadataParts) || [];
  const artist = (parts[0] && parts[0].text && parts[0].text.content) || '';
  const badge = find(lockup.contentImage, 'thumbnailBadgeViewModel')
    .map(b => b.text).find(t => /^\d+(:\d+)+$/.test(t || ''));
  return { id: lockup.contentId, title: meta.title.content, artist, length: badge ? parseClock(badge) : 0 };
}

// Throws on any failed page, so a partial list never replaces a complete one.
async function fetchPlaylist() {
  const first = await yt('browse', { browseId: 'VL' + PLAYLIST_ID });
  const title = find(first.header, 'pageTitle')[0] || 'Playlist';
  const songs = new Map();
  let data = first;
  for (let pages = 0; pages < 200; pages++) {
    const page = readPage(data);
    const before = songs.size;
    for (const l of page.items) {
      if (l.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && !songs.has(l.contentId)) songs.set(l.contentId, toSong(l));
    }
    if (!page.token || songs.size === before) break;
    data = await yt('browse', { continuation: page.token });
  }
  if (!songs.size) throw new Error('YouTube returned an empty playlist. Is it public?');
  return { title, songs: [...songs.values()] };
}

async function fetchHeat(id) {
  const data = await yt('next', { videoId: id });
  const mutations = (data.frameworkUpdates && data.frameworkUpdates.entityBatchUpdate && data.frameworkUpdates.entityBatchUpdate.mutations) || [];
  for (const m of mutations) {
    const list = m.payload && m.payload.macroMarkersListEntity && m.payload.macroMarkersListEntity.markersList;
    if (list && list.markerType === 'MARKER_TYPE_HEATMAP' && list.markers.length) return list.markers;
  }
  return null;
}

// YouTube's curve mostly measures viewers leaving: it starts at its maximum
// on nearly every song, so the raw peak is just the intro. Subtracting a wide
// rolling median leaves the bumps people actually come back to.
function findHotspot(values, stepSeconds) {
  const n = values.length;
  const smooth = values.map((_, i) => {
    const w = values.slice(Math.max(0, i - 1), i + 2);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
  const reach = Math.round(n * 0.2);
  const lift = smooth.map((x, i) => {
    const w = smooth.slice(Math.max(0, i - reach), i + reach + 1).sort((a, b) => a - b);
    return x - w[w.length >> 1];
  });
  const from = Math.round(n * 0.1);
  const to = Math.round(n * 0.92);
  let peak = from;
  for (let i = from; i < to; i++) if (lift[i] > lift[peak]) peak = i;
  let rise = peak;
  while (rise > from && lift[rise - 1] > lift[peak] * 0.4) rise--;
  const leadIn = Math.ceil(8 / stepSeconds);   // at most 8s before the peak
  return { start: Math.round(Math.max(rise, peak - leadIn) * stepSeconds), clear: lift[peak] >= 0.03 };
}

function toHeatEntry(markers) {
  if (!markers) return { none: true, at: Date.now() };
  const values = markers.map(m => Number(m.intensityScoreNormalized));
  const stepSeconds = Number(markers[0].durationMillis) / 1000;
  const spot = findHotspot(values, stepSeconds);
  return {
    curve: values.map(v => Math.round(v * 100)),
    total: Math.round(stepSeconds * values.length),
    start: spot.start,
    clear: spot.clear,
    at: Date.now(),
  };
}

// ------------------------------------------------------------------ state

let title = '';
let songs = [];
let heat = {};
let checkedAt = 0;
let lastError = null;
let version = 1;

try {
  const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  ({ title, songs, heat, checkedAt } = saved);
} catch { /* first run */ }

function saveCache() {
  const tmp = CACHE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ title, songs, heat, checkedAt }));
  fs.renameSync(tmp, CACHE_FILE);
}

function isFresh(entry) {
  return entry && Date.now() - entry.at < (entry.none ? NO_HEAT_MAX_AGE : HEAT_MAX_AGE);
}

const clients = new Set();
let notifyTimer = null;

function changed() {
  version++;
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const res of clients) res.write(`data: ${version}\n\n`);
  }, 800);
}

async function fillHeat() {
  const queue = songs.filter(s => !isFresh(heat[s.id])).map(s => s.id);
  let failures = 0;
  const worker = async () => {
    while (queue.length && failures < 5) {   // 5 in a row is likely rate limiting
      const id = queue.shift();
      try {
        heat[id] = toHeatEntry(await fetchHeat(id));
        failures = 0;
        changed();
      } catch (err) {
        failures++;
        console.error(`Couldn't read replay data for ${id}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 100));
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const list = await fetchPlaylist();
    const added = list.songs.filter(s => !songs.some(o => o.id === s.id)).length;
    const removed = songs.filter(s => !list.songs.some(o => o.id === s.id)).length;
    title = list.title;
    songs = list.songs;
    checkedAt = Date.now();
    lastError = null;
    changed();
    if (added || removed) console.log(`"${title}": ${songs.length} songs (+${added} / -${removed})`);
    await fillHeat();
    saveCache();
  } catch (err) {
    lastError = err.message;
    changed();
    console.error(`Playlist check failed, keeping the last list: ${err.message}`);
  } finally {
    refreshing = false;
  }
}

function snapshot() {
  return {
    title,
    checkedAt,
    error: lastError,
    songs: songs.map(s => {
      const h = heat[s.id];
      const length = s.length || (h && h.total) || 0;
      const hasCurve = h && !h.none;
      return {
        id: s.id,
        title: s.title,
        artist: s.artist,
        length,
        curve: hasCurve ? h.curve : null,
        start: hasCurve && h.clear ? h.start : Math.round(length * 0.3),
        clear: Boolean(hasCurve && h.clear),
        pending: !h,
      };
    }),
  };
}

// ----------------------------------------------------------------- server

function onRequest(req, res) {
  const url = req.url.split('?')[0];
  if (url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
  } else if (url === '/api/songs') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(snapshot()));
  } else if (url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`data: ${version}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else if (url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
}

setInterval(() => { for (const res of clients) res.write(': keep-alive\n\n'); }, 25000);

function listen(port, triesLeft) {
  const server = http.createServer(onRequest);
  server.once('error', err => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) listen(port + 1, triesLeft - 1);
    else throw err;
  });
  // localhost, not 127.0.0.1: the YouTube player needs a named origin.
  server.listen(port, 'localhost', () => {
    console.log(`Open http://localhost:${port}`);
    refresh();
    setInterval(refresh, REFRESH_MS);
  });
}

// ------------------------------------------------------------------- page

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MUSIC</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anybody:wdth,wght@50..150,100..900&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: light;
    --sky: #c9d1ff;
    --ridge: #9aa8f7;
    --ridge-soft: #b3bffa;
    --ink: #14154a;
    --ink-soft: #3b3e85;
    --hot: #ff1f83;
    --on-ink: #f1f3ff;
  }
  * { box-sizing: border-box; }
  html { background: var(--sky); }
  body {
    margin: 0; color: var(--ink); background: var(--sky);
    font-family: Anybody, system-ui, sans-serif; font-size: 16px; line-height: 1.3;
  }
  .page {
    display: grid; grid-template-columns: minmax(0, 1fr) 400px;
    align-items: start; gap: 0 32px; padding: 0 32px 64px 0;
  }
  header { grid-column: 1 / -1; padding: 32px 0 28px 32px; }
  h1 {
    margin: 0; font-size: clamp(72px, 15vw, 210px); line-height: .86;
    font-weight: 900; font-stretch: 150%; letter-spacing: -.02em; overflow-wrap: anywhere;
  }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin-top: 20px; }
  #status { margin: 0; font-size: 18px; font-weight: 500; }
  #status.bad { color: #a30052; font-weight: 700; }
  #shuffle, #unshuffle {
    flex: none; padding: 12px 24px; border: 0; background: var(--ink); color: var(--on-ink);
    font: inherit; font-size: 18px; font-weight: 700; cursor: pointer;
  }
  #shuffle:hover:enabled, #unshuffle:hover:enabled { background: var(--ink-soft); }
  #shuffle:disabled, #unshuffle:disabled { opacity: .5; cursor: default; }
  #search {
    flex: 0 1 260px; min-width: 0; align-self: stretch; padding: 0 14px; border: 2px solid var(--ink);
    border-radius: 0; background: var(--on-ink); color: var(--ink); font: inherit; font-size: 18px;
    font-weight: 500; -webkit-appearance: none; appearance: none;
  }
  #search::placeholder { color: var(--ink-soft); opacity: 1; }

  main { min-width: 0; }
  #empty { padding: 0 32px; font-size: 18px; }
  ol { list-style: none; margin: 0; padding: 0; }
  .row { position: relative; height: 68px; }
  .row.pinned { position: fixed; left: 0; right: 464px; bottom: 0; z-index: 3; }
  #list:has(.row.pinned) { padding-bottom: 68px; }
  .curve { position: absolute; inset: 0 0 0 76px; pointer-events: none; }
  .curve svg { display: block; width: 100%; height: 100%; }
  .curve path { fill: var(--ridge); transition: fill .15s; }
  .row.pending .curve { background: linear-gradient(transparent 92%, var(--ridge-soft) 92%); }
  .mark, .head { position: absolute; top: 0; bottom: 0; width: 3px; margin-left: -1px; }
  .mark { background: var(--hot); }
  .row.fuzzy .mark { background: repeating-linear-gradient(var(--hot) 0 5px, transparent 5px 10px); }
  .head { background: var(--hot); display: none; }

  .main {
    position: absolute; inset: 0; width: 100%; display: flex; align-items: center; gap: 16px;
    padding: 0 16px 0 0; border: 0; background: none; color: inherit; font: inherit;
    text-align: left; cursor: pointer;
  }
  .main img { flex: none; width: 76px; height: 68px; object-fit: cover; display: block; }
  .text { flex: 1; min-width: 0; }
  .name, .artist { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .name { font-size: 19px; font-weight: 650; transition: font-stretch .2s, font-weight .2s; }
  .artist { font-size: 14px; color: var(--ink-soft); }
  .time { flex: none; font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; padding-right: 40px; }
  .open {
    position: absolute; right: 10px; top: 50%; width: 32px; height: 32px; margin-top: -16px;
    display: grid; place-items: center; color: inherit;
  }
  .open svg { width: 18px; height: 18px; }

  .row.now { background: var(--ink); color: var(--on-ink); }
  .row.now .curve path { fill: #33378f; }
  .row.now .artist { color: #c3c8f5; }
  .row.now .name { font-stretch: 135%; font-weight: 850; }
  .row.now .head { display: block; }
  .row.now .mark { opacity: .4; }
  .row.now::after { content: ''; position: absolute; inset: 0; border: 3px solid var(--hot); pointer-events: none; }
  .row.blocked { opacity: .55; }
  .row.fresh { animation: fresh 2.4s ease-out; }
  @keyframes fresh { from { background: var(--hot); } }
  .open:focus-visible, #shuffle:focus-visible, #unshuffle:focus-visible, #search:focus-visible { outline: 3px solid var(--hot); outline-offset: -3px; }
  .main:focus-visible { outline: 3px solid var(--ink); outline-offset: -3px; }
  .row.now .main:focus-visible { outline-color: var(--on-ink); outline-offset: -6px; }

  aside { position: sticky; top: 24px; }
  .frame { aspect-ratio: 16 / 9; background: var(--ink); }
  .frame iframe, #player { display: block; width: 100%; height: 100%; border: 0; }
  #np-title { margin: 14px 0 0; font-size: 26px; line-height: 1.1; font-weight: 800; font-stretch: 120%; }
  #np-sub { margin: 4px 0 0; color: var(--ink-soft); }

  @media (max-width: 860px) {
    .page { display: flex; flex-direction: column; padding: 0 0 48px; align-items: stretch; }
    header { order: 0; padding: 20px 16px 18px; }
    #search { flex: 1 1 140px; }
    aside { order: 1; top: 0; z-index: 2; background: var(--sky); padding: 0 0 10px; }
    #np-title, #np-sub { margin-left: 16px; margin-right: 16px; }
    #np-title { font-size: 20px; margin-top: 8px; }
    main { order: 2; }
    .row { height: 60px; scroll-margin-top: calc(56.25vw + 80px); }
    .row.pinned { right: 0; }
    #list:has(.row.pinned) { padding-bottom: 60px; }
    .curve { left: 64px; }
    .main { gap: 10px; }
    .main img { width: 64px; height: 60px; }
    .name { font-size: 17px; }
    .row.now .name { font-stretch: 110%; }
    .time { font-size: 16px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .name, .curve path { transition: none; }
    .row.fresh { animation: none; }
  }
</style>
</head>
<body>
<div class="page">
  <header>
    <h1 id="title">music.</h1>
    <div class="bar">
      <button id="shuffle" type="button" disabled>Shuffle</button>
      <button id="unshuffle" type="button" disabled>Unshuffle</button>
      <input id="search" type="search" placeholder="Search" aria-label="Search songs" autocomplete="off" spellcheck="false">
      <p id="status" role="status">Loading the playlist</p>
    </div>
  </header>
  <main>
    <p id="empty" hidden></p>
    <ol id="list"></ol>
  </main>
  <aside>
    <div class="frame"><div id="player"></div></div>
    <p id="np-title">Nothing playing</p>
    <p id="np-sub">Click a song to start.</p>
  </aside>
</div>

<script>
const $ = s => document.querySelector(s);
const list = $('#list');
const SVG = 'http://www.w3.org/2000/svg';
const rows = new Map();     // id -> { li, song, ... }
let state = null;
let current = null;         // row now playing
let player = null, ready = false, loadedId = null, waiting = null;
let order = null;          // shuffled song ids, or null for playlist order
let query = [], shown = 0; // search words, and how many songs match them

const clock = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

function ago(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
  const h = Math.floor(m / 60);
  return h + (h === 1 ? ' hour ago' : ' hours ago');
}

function showStatus() {
  if (!state) return;
  const el = $('#status');
  const n = state.songs.length;
  const count = (query.length ? shown + ' of ' : '') + n + (n === 1 ? ' song' : ' songs');
  if (state.error) {
    el.className = 'bad';
    el.textContent = n
      ? "Can't reach YouTube, so this is the list from " + ago(state.checkedAt) + '. Trying again every few minutes.'
      : "Can't load the playlist: " + state.error;
  } else if (state.checkedAt) {
    el.className = '';
    el.textContent = count + ', checked for changes ' + ago(state.checkedAt);
  }
}

// ---- rows

function createRow(song) {
  const li = document.createElement('li');
  li.className = 'row';
  const curve = document.createElement('div');
  curve.className = 'curve';
  const mark = document.createElement('div');
  mark.className = 'mark';
  const head = document.createElement('div');
  head.className = 'head';
  curve.append(mark, head);

  const main = document.createElement('button');
  main.className = 'main';
  main.type = 'button';
  const img = document.createElement('img');
  img.src = 'https://i.ytimg.com/vi/' + song.id + '/mqdefault.jpg';
  img.alt = '';
  img.loading = 'lazy';
  const text = document.createElement('span');
  text.className = 'text';
  const name = document.createElement('span');
  name.className = 'name';
  const artist = document.createElement('span');
  artist.className = 'artist';
  text.append(name, artist);
  const time = document.createElement('span');
  time.className = 'time';
  main.append(img, text, time);

  const open = document.createElement('a');
  open.className = 'open';
  open.href = 'https://music.youtube.com/watch?v=' + song.id;
  open.target = '_blank';
  open.rel = 'noopener';
  open.setAttribute('aria-label', 'Open in YouTube Music');
  open.title = 'Open in YouTube Music';
  open.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';

  li.append(curve, main, open);
  const row = { li, curve, mark, head, name, artist, time, song, drawn: null, blocked: false };

  main.addEventListener('click', e => clickRow(row, e));
  return row;
}

function drawCurve(row, values) {
  const key = values ? values.join() : '';
  if (row.drawn === key) return;
  row.drawn = key;
  const old = row.curve.querySelector('svg');
  if (old) old.remove();
  if (!values) return;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const step = 100 / values.length;
  let d = 'M0 100';
  values.forEach((v, i) => { d += 'L' + (i * step).toFixed(2) + ' ' + (100 - v) + 'L' + ((i + 1) * step).toFixed(2) + ' ' + (100 - v); });
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', d + 'L100 100Z');
  svg.append(path);
  row.curve.prepend(svg);
}

function updateRow(row, song) {
  row.song = song;
  row.name.textContent = song.title;
  row.artist.textContent = song.artist;
  row.time.textContent = (song.clear ? '' : '~') + clock(song.start);
  row.time.title = song.clear ? 'Most replayed part starts here'
    : song.pending ? 'Still reading replay data for this song'
    : song.curve ? 'No clear peak, so this is a guess' : 'YouTube has no replay data for this song, so this is a guess';
  row.li.classList.toggle('fuzzy', !song.clear);
  row.li.classList.toggle('pending', song.pending);
  drawCurve(row, song.curve);
  row.mark.style.left = (song.length ? song.start / song.length * 100 : 0) + '%';
}

// Keeps a shuffle in place across list updates. Songs added since go on top.
function ordered(songs) {
  if (!order) return songs;
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...songs].sort((a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1));
}

function render(data) {
  const firstRender = !state;
  state = data;

  const keep = new Set(data.songs.map(s => s.id));
  for (const [id, row] of rows) {
    if (keep.has(id)) continue;
    if (current === row) stop();
    row.li.remove();
    rows.delete(id);
  }
  $('#unshuffle').disabled = !order;
  ordered(data.songs).forEach((song, i) => {
    let row = rows.get(song.id);
    if (!row) {
      row = createRow(song);
      rows.set(song.id, row);
      if (!firstRender) row.li.classList.add('fresh');
    }
    updateRow(row, song);
    if (list.children[i] !== row.li) list.insertBefore(row.li, list.children[i] || null);
  });
  applySearch();
}

// ---- search

const fold = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function matches(song) {
  const text = fold(song.title + ' ' + (song.artist || ''));
  return query.every(word => text.includes(word));
}

// Runs after every list update too, so new songs and reorders respect the search.
// The song playing stays on screen, pinned to the bottom, when the search leaves it out.
function applySearch() {
  const input = $('#search').value;
  query = fold(input).split(/\s+/).filter(Boolean);
  shown = 0;
  for (const row of rows.values()) {
    row.match = matches(row.song);
    row.li.hidden = !row.match && row !== current;
    row.li.classList.toggle('pinned', !row.match && row === current);
    if (row.match) shown++;
  }
  if (!state) return;
  const total = state.songs.length;
  $('#shuffle').disabled = shown === 0;
  const empty = $('#empty');
  empty.hidden = total > 0 ? shown > 0 : !state.error;
  empty.textContent = empty.hidden ? ''
    : total > 0 ? 'No songs match "' + input.trim() + '".'
    : 'Check that the playlist is public, then reload this page.';
  showStatus();
}

let loading = false, loadAgain = false, loadFailed = true, lastLoad = 0;

async function load() {
  if (loading) { loadAgain = true; return; }
  loading = true;
  lastLoad = Date.now();
  try {
    const res = await fetch('/api/songs', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('the server answered ' + res.status);
    const data = await res.json();
    if (!data || !Array.isArray(data.songs)) throw new Error('the server sent something unexpected');
    render(data);
    loadFailed = false;
  } catch (err) {
    loadFailed = true;
    console.error('Loading the playlist failed:', err);
    const el = $('#status');
    el.className = 'bad';
    el.textContent = rows.size
      ? 'The local server stopped. Reconnecting.'
      : "Can't load the playlist (" + err.message + '). Check that node index.js is running. Trying again.';
  }
  loading = false;
  if (loadAgain) { loadAgain = false; load(); }
}

// ---- playback

// The first click on a song starts it at its peak. After that, a click on the
// curve jumps there. The thumbnail and the keyboard pause and resume.
function clickRow(row, e) {
  if (current !== row || loadedId !== row.song.id) { play(row); return; }
  const box = row.curve.getBoundingClientRect();
  if (e.detail === 0 || e.clientX < box.left || !row.song.length) togglePause();
  else play(row, (e.clientX - box.left) / box.width * row.song.length);
}

function togglePause() {
  if (!ready || !current || loadedId !== current.song.id) return;
  const state = player.getPlayerState();
  if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) player.pauseVideo();
  else player.playVideo();
}

function play(row, from = row.song.start) {
  if (row.blocked) {
    if (ready && current) player.pauseVideo();   // don't leave the last song playing
    setNow(row);
    showBlocked(row);
    return;
  }
  setNow(row);
  showNowPlaying();
  if (!ready) { waiting = row; return; }
  player.unMute();
  if (loadedId === row.song.id) {
    player.seekTo(from, true);
    player.playVideo();
  } else {
    loadedId = row.song.id;
    player.loadVideoById({ videoId: row.song.id, startSeconds: from });
  }
}

function stop() {
  waiting = null;
  if (ready && current) player.pauseVideo();
  setNow(null);
  $('#np-title').textContent = 'Nothing playing';
  $('#np-sub').textContent = 'Click a song to start.';
}

// A song already playing carries on and leads the new order, so the rest all follow it.
function shuffle() {
  const ids = state.songs.map(s => s.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const playing = current && !current.blocked ? current.song.id : null;
  if (playing) ids.unshift(...ids.splice(ids.indexOf(playing), 1));
  order = ids;
  render(state);
  if (!playing) playFrom(0);
  scrollToCurrent();
}

function unshuffle() {
  order = null;
  render(state);
  scrollToCurrent();
}

// A pinned row is already on screen.
function scrollToCurrent() {
  if (current && current.match) current.li.scrollIntoView({ block: 'center' });
}

// Plays the first playable song at or after this place in the shuffle,
// skipping any the search is hiding.
function playFrom(index) {
  const next = order.slice(index).map(id => rows.get(id)).find(row => row && !row.blocked && row.match);
  if (next) play(next); else stop();
}

function playNextShuffled(row) {
  if (order && current === row) playFrom(order.indexOf(row.song.id) + 1);
}

function setNow(row) {
  if (current) current.li.classList.remove('now');
  current = row;
  if (row) row.li.classList.add('now');
  applySearch();
}

function showNowPlaying() {
  if (!current) return;
  $('#np-title').textContent = current.song.title;
  $('#np-sub').textContent = current.song.artist;
}

function showBlocked(row) {
  $('#np-title').textContent = row.song.title;
  $('#np-sub').textContent = 'The owner blocks this video outside YouTube. Use the arrow to open it there.';
}

$('#shuffle').addEventListener('click', shuffle);
$('#unshuffle').addEventListener('click', unshuffle);
$('#search').addEventListener('input', applySearch);
$('#search').addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !e.target.value) return;
  e.target.value = '';
  applySearch();
});

// A mouse click must not leave a button focused, or Space would press it again.
addEventListener('click', e => {
  if (e.detail > 0 && document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
});

// A button reached with Tab keeps its normal Space behaviour, and the search box types one.
addEventListener('keydown', e => {
  if (e.code !== 'Space' || e.ctrlKey || e.metaKey || e.altKey || !current || e.target.closest('button, input')) return;
  e.preventDefault();
  if (!e.repeat) togglePause();
});

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('player', {
    width: '100%', height: '100%',
    playerVars: { playsinline: 1, rel: 0, origin: location.origin },
    events: {
      onReady() {
        ready = true;
        if (waiting) { const row = waiting; waiting = null; play(row); }
      },
      onStateChange(e) {
        if (e.data === YT.PlayerState.ENDED && current && loadedId === current.song.id) playNextShuffled(current);
      },
      onError(e) {
        // 100: removed or private. 101 and 150: embedding disabled by the owner.
        const row = rows.get(loadedId);
        loadedId = null;
        if (!row) return;
        if (e.data === 100 || e.data === 101 || e.data === 150) {
          row.blocked = true;
          row.li.classList.add('blocked');
          if (current === row) showBlocked(row);
          playNextShuffled(row);
        } else if (current === row) {
          $('#np-sub').textContent = "This video didn't load. Click it again to retry.";
        }
      },
    },
  });
};

// Move the playhead along the current row's curve.
setInterval(() => {
  if (!ready || !current || !current.song.length || typeof player.getCurrentTime !== 'function') return;
  if (loadedId === current.song.id) current.head.style.left = player.getCurrentTime() / current.song.length * 100 + '%';
}, 200);

setInterval(showStatus, 30000);

// The event stream makes updates instant, but the list must not depend on it:
// load now, retry quickly after a failure, and check every 30 seconds regardless.
load();
setInterval(() => { if (loadFailed || Date.now() - lastLoad >= 30000) load(); }, 3000);

const events = new EventSource('/events');
events.onmessage = load;
events.onerror = load;

const api = document.createElement('script');
api.src = 'https://www.youtube.com/iframe_api';
document.head.append(api);
</script>
</body>
</html>
`;

listen(START_PORT, 20);
