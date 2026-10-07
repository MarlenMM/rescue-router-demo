// Rescue Router web viewer (PLAN §6.4). Plain ES module + Leaflet 1.9 (global L), no build step.
// Scenes come from src/export_web_assets.py; routing runs in the browser with js/router.js.

import { sceneGrids, parseScene, eta, tier, TRUCK, BOAT, FOOT, ISOLATED } from './router.js';

const CELL = 4;
const KIND = ['truck', 'boat', 'foot', 'isolated'];
const WORD = ['truck', 'boat', 'on foot', 'no route'];
const TITLE = ['Truck can reach it', 'Boat needed', 'Last stretch on foot', 'No route: send an air team'];
const LEG = [{ name: 'truck', icon: '🚚', color: '#ffffff' }, { name: 'boat', icon: '🚤', color: 'var(--accent)' },
             { name: 'on foot', icon: '🚶', color: 'var(--foot)', dash: '1 9' }];
const SIDE = { pred: 'Prediction', gt: 'Labelled map' };
const SVG = {
  truck: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M2 6h11v9H2zM14 9h4l3 3v3h-7z"/><circle cx="6" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>',
  boat: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M3 14h18l-3 5H6zM11 4v9H6zM13 7l5 6h-5z"/></svg>',
  foot: '<svg viewBox="0 0 24 24" fill="#fff"><circle cx="13" cy="4" r="2.4"/><path d="M11 7.5l-3 4 1.8 1.2 2-2.4 1 4-3.3 6.4 2 1 3-5.8 2.2 5.8 2-.8-2.6-7.4-.9-3.6 2 1.4 2.4-.4-.3-2-2-.3z"/></svg>',
  isolated: '<svg viewBox="0 0 24 24" stroke="#fff" stroke-width="3.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
SVG.check = SVG.truck;                                              // 'probably truck: check first' badge
const CLASS_LABEL = {
  floodnet: { 2: 'flooded building', 3: 'dry building' },
  rescuenet: { 2: 'intact building', 3: 'damaged building' },
};
const DATASET = {
  floodnet: { name: 'FloodNet', event: 'Hurricane Harvey, Texas 2017',
    attrib: '<a href="https://github.com/BinaLab/FloodNet-Supervised_v1.0">FloodNet</a> (CDLA-Permissive-1.0)' },
  rescuenet: { name: 'RescueNet', event: 'Hurricane Michael, Florida 2018',
    attrib: '<a href="https://springernature.figshare.com/collections/RescueNet_A_High_Resolution_UAV_Semantic_Segmentation_Benchmark_Dataset_for_Natural_Disaster_Damage_Assessment/6647354/1">RescueNet</a> (figshare CC0; GitHub release CC BY-NC-ND 4.0)' },
};
// colour-blind palette (Okabe-Ito) for the five class slots, by meaning: clear road sky blue, flooded road dark blue /
// blocked road bluish green (pink is the on-foot status), flooded or damaged building vermillion, dry or intact building yellow, water navy
const CB_CLASS = {
  floodnet: [[86, 180, 233], [0, 114, 178], [213, 94, 0], [240, 228, 66], [0, 31, 120]],
  rescuenet: [[86, 180, 233], [0, 158, 115], [240, 228, 66], [213, 94, 0], [0, 31, 120]],
};
const MODEL_ATTRIB = '<a href="https://github.com/GitGyun/chameleon">Chameleon</a> (Kim et al., ECCV 2024)';

const $ = (id) => document.getElementById(id);
const state = { index: null, key: null, s: null, src: 'pred', layer: 'classes', lam: 5, swipe: 0.5, sel: null, anim: null,
  entry: null, picking: false, ds: 'floodnet', sort: 'id', cb: false };

// ---------- map and panes ----------
const map = L.map('map', { crs: L.CRS.Simple, zoomSnap: 0.25, zoomDelta: 0.5, minZoom: -4, maxZoom: 4,
  attributionControl: true, zoomControl: false, boxZoom: false });
L.control.zoom({ position: 'bottomright' }).addTo(map);
map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
const pane = (name, z) => { const p = map.createPane(name); p.style.zIndex = z; return p; };
const panes = { pred: pane('pred', 410), gt: pane('gt', 411), base: pane('base', 440), dis: pane('dis', 445), route: pane('route', 460) };
const rend = Object.fromEntries(['pred', 'gt', 'dis', 'route'].map(k => [k, L.svg({ pane: k, padding: 0.5 })]));
const baseRend = L.canvas({ pane: 'base' });
const groups = Object.fromEntries(['photo', 'pred', 'gt', 'predHouses', 'gtHouses', 'base', 'dis', 'route']
  .map(k => [k, L.layerGroup().addTo(map)]));

// ---------- helpers ----------
const ll = (x, y) => L.latLng(state.s.H - y, x);                 // image px -> map
const cellLL = ([cy, cx]) => ll(cx * CELL + CELL / 2, cy * CELL + CELL / 2);
const fmt = (v) => (v == null ? '–' : v.toFixed(2).replace(/^0/, ''));

function pointInPoly([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function badgeIcon(kind, sel) {
  return L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11],
    html: `<div class="st ${kind}${sel ? ' sel' : ''}">${SVG[kind]}</div>` });
}

// ---------- scene loading ----------
async function loadIndex() {
  state.index = await (await fetch('scenes/scenes.json')).json();
  const box = $('scenes');
  for (const sc of state.index.scenes.filter(s => s.showcase)) {
    const b = document.createElement('button');
    b.dataset.key = sc.key;
    b.title = sc.caption;
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', `${sc.dataset} ${sc.id}: ${sc.caption}`);
    const fail = /failure/i.test(sc.caption) ? '<span class="warn">fail</span>' : '';
    b.innerHTML = `<img src="scenes/${sc.key}/thumb.jpg" alt="" loading="lazy"><span class="tag">${sc.dataset === 'floodnet' ? 'FN' : 'RN'} ${sc.id}</span>${fail}`;
    b.addEventListener('click', () => goScene(sc.key));
    box.appendChild(b);
  }
}

// ---------- browsing all eval100 photos ----------
const cutOff = (sc) => sc.n_buildings - sc.status_pred.TRUCK;    // houses not reachable by truck on the prediction
const SORTS = {
  id: (a, b) => +a.id - +b.id,
  cut: (a, b) => cutOff(b) - cutOff(a) || +a.id - +b.id,
  dis: (a, b) => b.n_disagree - a.n_disagree || +a.id - +b.id,
  iou: (a, b) => (a.miou ?? 2) - (b.miou ?? 2) || +a.id - +b.id,
};
const browseList = () => state.index.scenes.filter(s => s.dataset === state.ds).sort(SORTS[state.sort]);

function drawBrowse() {
  const box = $('allScenes');
  box.innerHTML = '';
  document.querySelectorAll('.seg.ds button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.ds === state.ds)));
  for (const sc of browseList()) {
    const b = document.createElement('button');
    const cut = cutOff(sc);
    b.dataset.key = sc.key;
    b.setAttribute('role', 'listitem');
    b.setAttribute('aria-pressed', String(sc.key === state.key));
    b.title = `${DATASET[sc.dataset].name} ${sc.id}: ${sc.n_buildings} houses, ${cut} not reachable by truck (prediction), ` +
      `${sc.n_disagree} disagreement${sc.n_disagree === 1 ? '' : 's'} with the labelled map${sc.miou != null ? `, mean IoU ${fmt(sc.miou)}` : ''}`;
    b.setAttribute('aria-label', b.title);
    b.innerHTML = `<img src="scenes/${sc.key}/thumb.jpg" alt="" loading="lazy"><span class="tag">${sc.id}</span>` +
      (sc.n_buildings ? `<span class="cnt${cut ? ' cut' : ''}">${cut}/${sc.n_buildings}</span>` : '') +
      (sc.n_disagree ? '<span class="dis" aria-hidden="true"></span>' : '');
    b.addEventListener('click', () => goScene(sc.key));
    box.appendChild(b);
  }
}

function step(d) {
  const list = browseList(), k = list.findIndex(s => s.key === state.key);
  const next = k < 0 ? list[0] : list[(k + d + list.length) % list.length];
  goScene(next.key);
}

async function goScene(key) {
  await loadScene(key);
  writeHash(true);
}

function markPressed() {
  document.querySelectorAll('#scenes button, #allScenes button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.key === state.key)));
  const cur = document.querySelector('#allScenes button[aria-pressed="true"]');
  if (cur) {                                                       // keep it visible without scrolling the page
    const box = $('allScenes'), top = cur.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top + cur.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top - box.clientHeight / 2;
  }
}

// an uploaded photo (Gradio app, src/gradio_viewer.py): scenes/up/<token>/, not in the index, no labels
const uploadEntry = (key) => (/^up\/[\w-]+$/.test(key || '') ? { key, dataset: 'floodnet', id: 'upload', caption: '', upload: true } : null);

function setNoLabels(on) {                                         // hide everything that compares with labels
  state.nolabels = on;
  document.querySelectorAll('.seg button[data-src="gt"], .seg button[data-src="swipe"]').forEach(b => { b.style.display = on ? 'none' : ''; });
  $('tDisagree').closest('label').style.display = on ? 'none' : '';
  if (on && state.src !== 'pred') setSource('pred');
}

async function loadScene(key) {
  const sc = state.index.scenes.find(s => s.key === key) || uploadEntry(key) || state.index.scenes[0];
  const dir = `scenes/${sc.key}/`;
  const [meta, { grid, buildings: blds }] = await Promise.all([
    fetch(dir + 'meta.json').then(r => r.json()),
    fetch(dir + 'scene.rrb').then(r => r.arrayBuffer()).then(parseScene)]);
  stopAnim();
  state.key = sc.key;
  state.sel = null;
  state.entry = null;
  setPicking(false);
  const [W, H] = meta.size;
  if (meta.upload) sc.caption = meta.caption;
  setNoLabels(Boolean(meta.upload));                               // before state.s: setSource redraws the old scene
  state.s = { sc, dir, meta, grid, blds, W, H, ds: meta.dataset };
  if (sc.dataset !== state.ds) { state.ds = sc.dataset; drawBrowse(); }
  markPressed();
  $('caption').textContent = `${DATASET[meta.dataset].event} · ${sc.caption || `Test photo ${sc.id}: ` +
    (!sc.n_buildings ? 'no houses in the labelled map' : sc.n_disagree
      ? `${sc.n_disagree} of ${sc.n_buildings} houses differ from the labelled map` : `all ${sc.n_buildings} houses agree with the labelled map`)}`;
  const shots = meta.run.match(/_(\d+)shot/)[1];
  const ious = Object.values(meta.iou).filter(v => v != null);
  $('model').innerHTML = `${DATASET[meta.dataset].name} · Chameleon adapted from <b>${shots}</b> labelled photos · ` +
    (ious.length ? `this photo: mean IoU ${fmt(ious.reduce((a, b) => a + b, 0) / ious.length)}` : 'uploaded photo: no labels to score it');
  for (const k of Object.keys(groups)) groups[k].clearLayers();
  const bounds = [[0, 0], [H, W]];
  L.imageOverlay(dir + 'photo.jpg', bounds).addTo(groups.photo);
  state.overlays = {
    pred: L.imageOverlay(dir + 'pred.png', bounds, { pane: 'pred', opacity: opacity() }).addTo(groups.pred),
    gt: L.imageOverlay(dir + 'gt.png', bounds, { pane: 'gt', opacity: opacity() }).addTo(groups.gt),
    pwet: L.imageOverlay(pwetImage(grid), bounds, { pane: 'pred', opacity: 0, className: 'pwet' }).addTo(groups.pred),
  };
  setOpacities();
  drawPwetLegend();
  if (state.cb) applyPalette();
  map.attributionControl._attributions = {};
  map.attributionControl.addAttribution(`${DATASET[meta.dataset].attrib} · ${MODEL_ATTRIB}`);
  drawLegend();
  $('routeCard').hidden = true;
  solve();
  fit();
}

function fit() {
  if (!state.s) return;
  const panel = $('panel').getBoundingClientRect();
  const phone = innerWidth <= 760;
  document.documentElement.style.setProperty('--sheet-h', `${Math.round(panel.height)}px`);
  const top = $('caption').closest('.title').getBoundingClientRect().bottom + 8;
  const counter = $('counter').getBoundingClientRect().height;
  map.invalidateSize();
  map.fitBounds([[0, 0], [state.s.H, state.s.W]], {
    paddingTopLeft: [12, phone ? top : 12],
    paddingBottomRight: phone ? [12, panel.height + counter + 16] : [panel.width + 24, 12],
  });
}

// ---------- routing ----------
function solve() {
  const s = state.s;
  s.grids = sceneGrids(s.grid, state.lam);
  s.sol = { pred: s.grids.pred.solve(base()), gt: s.grids.gt.solve(base()), cautious: s.grids.pred_cautious.solve(base()) };
  s.status = { pred: s.blds.map(b => s.sol.pred.status(b.goals)), gt: s.blds.map(b => s.sol.gt.status(b.goals)) };
  s.tier = s.blds.map((b, i) => tier(s.status.pred[i], s.sol.cautious.status(b.goals)));
  drawHouses();
  drawHouseList();
  drawBase();
  drawCounter();
  if (state.sel) select(state.sel.i, state.sel.side, false);
  else { groups.route.clearLayers(); $('routeCard').hidden = true; }
}

const base = () => state.entry || state.s.grid.base;

// ---------- entry point chosen by the user ----------
function setPicking(on) {
  state.picking = on;
  $('map').classList.toggle('picking', on);
  $('entryPick').setAttribute('aria-pressed', String(on));
  if (state.s) drawCounter();
}

function setEntry(x, y) {
  const s = state.s, g = s.grids.gt, w = s.grid.w, h = s.grid.h;
  const cx = Math.min(w - 1, Math.max(0, Math.floor(x / CELL))), cy = Math.min(h - 1, Math.max(0, Math.floor(y / CELL)));
  const c = cy * w + cx;
  if (g.wall[c] && !g.boatOk[c]) { state.entryMsg = 'That is a building: tap a road, a yard or water.'; drawCounter(); return; }
  const mode = g.truckOk[c] ? 'TRUCK' : g.boatOk[c] ? 'BOAT' : 'TRUCK';
  const cells = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {      // a 3x3-cell staging area
    const yy = cy + dy, xx = cx + dx, k = yy * w + xx;
    if (yy >= 0 && yy < h && xx >= 0 && xx < w && !(mode === 'TRUCK' ? !g.truckOk[k] && k !== c : !g.boatOk[k])) cells.push(k);
  }
  state.entry = { cells, mode, at: [x, y] };
  state.entryMsg = null;
  setPicking(false);
  solve();
  writeHash();
}

function drawHouses() {
  const s = state.s;
  groups.predHouses.clearLayers(); groups.gtHouses.clearLayers(); groups.dis.clearLayers();
  const show = $('tStatus').checked;
  let nDis = 0;
  s.blds.forEach((b, i) => {
    const poly = b.polygon.map(([x, y]) => ll(x, y));
    for (const side of ['pred', 'gt']) {
      const kind = side === 'pred' && s.tier[i] === 'PROBABLE_TRUCK' ? 'check' : KIND[s.status[side][i]];
      const g = side === 'pred' ? groups.predHouses : groups.gtHouses;
      if (show) {
        L.polygon(poly, { renderer: rend[side], interactive: false, color: getVar(`--${kind}`), weight: 2,
          fillColor: getVar(`--${kind}`), fillOpacity: 0.14 }).addTo(g);
        const sel = state.sel && state.sel.i === i && state.sel.side === side;
        L.marker(ll(...b.centroid), { pane: side, icon: badgeIcon(kind, sel), interactive: false, keyboard: false }).addTo(g);
      }
    }
    if (s.status.pred[i] !== s.status.gt[i]) {
      nDis++;
      if ($('tDisagree').checked) {
        L.polygon(poly, { renderer: rend.dis, interactive: false, color: getVar('--disagree'), weight: 4,
          dashArray: '6 5', fill: false }).addTo(groups.dis);
      }
    }
  });
  $('nDisagree').textContent = nDis;
}

// ---------- house list (keyboard access to every house) ----------
function drawHouseList() {
  const s = state.s, side = state.src === 'gt' ? 'gt' : 'pred', box = $('houses');
  $('housesNote').textContent = s.blds.length ? `${s.blds.length} · ${SIDE[side].toLowerCase()}` : '';
  box.innerHTML = '';
  s.blds.forEach((b, i) => {
    const st = s.status[side][i], tr = side === 'pred' ? s.tier[i] : null;
    const kind = tr === 'PROBABLE_TRUCK' ? 'check' : KIND[st];
    const word = tr === 'PROBABLE_TRUCK' ? 'truck, check first' : tr === 'CONFIDENT_TRUCK' ? 'truck (confident)' : WORD[st];
    const dis = s.status.pred[i] !== s.status.gt[i];
    const el = document.createElement('button');
    el.setAttribute('role', 'option');
    el.dataset.i = i;
    el.innerHTML = `<span class="st ${kind}" aria-hidden="true">${SVG[kind]}</span><span class="what">House ${b.id}: ${word}` +
      `<br><span class="sub">${CLASS_LABEL[s.ds][b.cls]}</span></span>` +
      (dis ? `<span class="dis" title="Prediction and labelled map disagree">≠ ${WORD[s.status[side === 'pred' ? 'gt' : 'pred'][i]]}</span>` : '');
    el.setAttribute('aria-label', `House ${b.id}: ${word}, ${CLASS_LABEL[s.ds][b.cls]}` +
      (dis ? `; the ${side === 'pred' ? 'labelled map' : 'prediction'} says ${WORD[s.status[side === 'pred' ? 'gt' : 'pred'][i]]}` : ''));
    el.addEventListener('click', () => { if (base()) { select(i, side); writeHash(); } });
    box.appendChild(el);
  });
  markHouse();
}

function markHouse() {                                             // aria-selected + roving tabindex
  const items = [...$('houses').children], cur = state.sel ? state.sel.i : 0;
  items.forEach((el, k) => {
    el.setAttribute('aria-selected', String(Boolean(state.sel) && k === cur));
    el.tabIndex = k === cur ? 0 : -1;
  });
}

$('houses').addEventListener('keydown', (e) => {
  const items = [...$('houses').children], k = items.indexOf(document.activeElement);
  if (k < 0) return;
  const to = { ArrowDown: k + 1, ArrowUp: k - 1, Home: 0, End: items.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  const el = items[Math.max(0, Math.min(items.length - 1, to))];
  items.forEach(x => { x.tabIndex = -1; });
  el.tabIndex = 0;
  el.focus();
});

function drawBase() {
  const s = state.s, b = base();
  groups.base.clearLayers();
  $('entryMode').textContent = state.entry ? `chosen (${b.mode === 'BOAT' ? 'boat' : 'truck'})` : 'auto: largest road or dry land at the edge';
  if (!b || !$('tBase').checked) return;
  const color = b.mode === 'BOAT' ? getVar('--accent') : '#ffffff';
  if (state.entry) {
    L.marker(ll(...state.entry.at), { pane: 'route', interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'vehicle', html: '🚩', iconSize: [24, 24], iconAnchor: [5, 22] }) }).addTo(groups.base);
  }
  for (const c of b.cells) {
    const cy = Math.floor(c / s.grid.w), cx = c % s.grid.w;
    L.rectangle([ll(cx * CELL, cy * CELL + CELL), ll(cx * CELL + CELL, cy * CELL)],
      { renderer: baseRend, interactive: false, stroke: false, fillColor: color, fillOpacity: 0.95 }).addTo(groups.base);
  }
}

function drawCounter() {
  const s = state.s, M = s.blds.length;
  const block = (side, label) => {
    const st = s.status[side], n = (k) => st.filter(v => v === k).length;
    const none = n(ISOLATED);
    const check = side === 'pred' ? s.tier.filter(t => t === 'PROBABLE_TRUCK').length : 0;
    return `<div>${label ? `<div class="side">${label}</div>` : ''}<div class="big">${M - n(TRUCK)} <small>/ ${M} houses</small></div>` +
      `<div class="split"><span><b>${n(BOAT)}</b> by boat</span><span><b>${n(FOOT)}</b> on foot</span>` +
      `${none ? `<span><b>${none}</b> no route</span>` : ''}</div>` +
      (check ? `<div class="split check"><span><b>${check}</b> more look truck-reachable: check first</span></div>` : '') + '</div>';
  };
  const hint = state.picking ? '<p class="hint pick">Tap where the rescue team enters (road, yard or water).</p>'
    : state.entryMsg ? `<p class="hint pick">${state.entryMsg}</p>`
      : state.sel ? '' : '<p class="hint">Tap a house to send a rescue team.</p>';
  $('counter').innerHTML = !M ? '<div class="lbl">No houses in this photo</div><p class="hint">Try the next photo: › (or the N key).</p>'
    : !base() ? '<div class="lbl">No entry point in this photo: choose one</div>' + hint
    : '<div class="lbl">Unreachable by road</div>' + (state.src === 'swipe'
      ? `<div class="duo">${block('pred', 'Prediction')}${block('gt', 'Labelled map')}</div>`
      : block(state.src, state.src === 'gt' ? 'Labelled map' : '')) + hint;
}

function select(i, side, animate = true) {
  const s = state.s, b = s.blds[i];
  state.sel = { i, side };
  markHouse();
  stopAnim();
  groups.route.clearLayers();
  drawHouses();
  const st = s.status[side][i];
  const tr = side === 'pred' ? s.tier[i] : null;
  // a confident-truck house gets its route on the cautious map (it avoids land that may be wet)
  const solR = tr === 'CONFIDENT_TRUCK' ? s.sol.cautious : s.sol[side];
  const r = solR.route(b.goals);                                     // ends in the mode of the status, as router.py
  const other = side === 'pred' ? 'gt' : 'pred', stO = s.status[other][i];
  L.polygon(b.polygon.map(([x, y]) => ll(x, y)), { renderer: rend.route, interactive: false, color: getVar('--accent'),
    weight: 3, fill: false }).addTo(groups.route);
  const card = $('routeCard');
  let body = '';
  if (r) {
    const steps = [0, 0, 0];
    for (let k = 1; k < r.modes.length; k++) steps[r.modes[k]]++;
    const parts = steps.map((n, m) => (n ? `${LEG[m].name} <b>${n}</b>` : null)).filter(Boolean);
    const e = eta(r, solR.grid, s.grid.eta, s.meta.m_per_cell);
    const km = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} km` : `${Math.round(v / 10) * 10} m`);
    const legs = e.metres.map((v, m) => (v > 0 ? `${LEG[m].name} ${km(v)}` : null)).filter(Boolean);
    body += `<p class="eta">≈ <b>${Math.max(1, Math.round(e.minutes))} min</b> · ${legs.length ? legs.join(' → ') : 'at the entry point'}</p>`;
    body += `<div class="legs">${steps.map((n, m) => `<span style="flex:${n};background:${LEG[m].color}"></span>`).join('')}</div>`;
    body += `<p class="gtline">Route cost ${r.cost.toFixed(0)} (${parts.length ? parts.join(' → ') + ' cells' : 'no steps'})</p>`;
  } else {
    body += '<p>No truck, boat or walking route from the entry point on this map.</p>';
  }
  const agree = st === stO || state.nolabels;
  if (!state.nolabels) body += `<p class="${agree ? 'gtline' : 'mismatch'}">${SIDE[other]}: ${WORD[stO]}${agree ? ' ✓' : ` (${SIDE[side].toLowerCase()} says ${WORD[st]})`}</p>`;
  body += `<p class="gtline">${state.nolabels ? 'Predicted' : 'Label'}: ${CLASS_LABEL[s.ds][b.cls]} · ${SIDE[side]}${state.lam ? ', risk-aware truck' : ', shortest truck'}</p>`;
  const ts = s.meta.tier_stats, pct = (v) => `${Math.round(100 * v)} %`;
  let kind = KIND[st], title = TITLE[st];
  if (tr === 'CONFIDENT_TRUCK') {
    title = 'Truck can reach it: confident';
    if (ts) body = `<p class="tierline">Safe route: avoids land that may be wet. On the test photos ${pct(ts.confident)} of such houses were truly truck-reachable.</p>` + body;
  } else if (tr === 'PROBABLE_TRUCK') {
    kind = 'check'; title = 'Probably reachable by truck: check first';
    if (ts) body = `<p class="tierline warn">The only truck route crosses land that may be wet. On the test photos only ${pct(ts.probable)} of such houses were truly truck-reachable (confident tier: ${pct(ts.confident)}). Confirm by drone or radio before sending a truck.</p>` + body;
  }
  // on disagreement, the other map's route as a dashed ghost (under this map's route)
  const rO = agree ? null : s.sol[other].route(b.goals);
  if (rO && rO.cells.length > 1) {
    L.polyline(rO.cells.map(cellLL), { renderer: rend.route, color: '#000', weight: 6, opacity: 0.35, interactive: false,
      lineCap: 'round', lineJoin: 'round' }).addTo(groups.route);
    L.polyline(rO.cells.map(cellLL), { renderer: rend.route, color: getVar('--disagree'), weight: 3, opacity: 0.95,
      dashArray: '7 6', interactive: false, lineCap: 'butt', lineJoin: 'round' }).addTo(groups.route);
    const mO = [...new Set(rO.modes.slice(1))].map(m => LEG[m].name).join(' → ');
    body += `<p class="gtline"><span class="line ghostline"></span> ${SIDE[other]} route: ${mO || 'at the entry point'}</p>`;
  }
  card.innerHTML = `<h3><span class="st ${kind}" style="width:20px;height:20px">${SVG[KIND[st]]}</span>${title}</h3>${body}`;
  card.hidden = false;
  drawCounter();
  if (r && r.cells.length > 1) drawRoute(r, animate);
}

function drawRoute(r, animate) {
  const pts = r.cells.map(cellLL);
  const mk = (color, w, op = 1, dash = null) => L.polyline([], { renderer: rend.route, color, weight: w, opacity: op,
    interactive: false, lineCap: 'round', lineJoin: 'round', dashArray: dash }).addTo(groups.route);
  const legs = [];
  for (let m = 0; m < 3; m++) {                                    // one leg per mode, joined at the switch cell
    const first = r.modes.indexOf(m), last = r.modes.lastIndexOf(m);
    if (first < 0) continue;
    const seg = pts.slice(Math.max(first - 1, 0), last + 1);
    if (seg.length < 2) continue;
    const color = LEG[m].color.startsWith('var') ? getVar(LEG[m].color.slice(4, -1)) : LEG[m].color;
    legs.push({ pts: seg, icon: LEG[m].icon, lines: [mk('#000', 8, 0.45), mk(color, LEG[m].dash ? 5 : 4, 1, LEG[m].dash)] });
  }
  if (!legs.length) return;
  L.circleMarker(pts[0], { renderer: rend.route, radius: 6, color: '#000', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false })
    .addTo(groups.route);
  if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    legs.forEach(l => l.lines.forEach(p => p.setLatLngs(l.pts)));
    return;
  }
  const lenOf = (p) => p.slice(1).reduce((a, q, j) => a + map.distance(p[j], q), 0);
  const total = legs.reduce((a, l) => a + lenOf(l.pts), 0);
  const speed = total / Math.min(5000, Math.max(1800, total * 6));       // map units per ms
  const veh = L.marker(pts[0], { icon: L.divIcon({ className: 'vehicle', html: legs[0].icon, iconSize: [26, 26], iconAnchor: [13, 13] }),
    pane: 'route', interactive: false, zIndexOffset: 1000 }).addTo(groups.route);
  let li = 0, seg = 0, along = 0, last = performance.now(), pause = 0;
  const done = [];
  const step = (now) => {
    let dt = now - last; last = now;
    if (pause > 0) { pause -= dt; state.anim = requestAnimationFrame(step); return; }
    let move = dt * speed;
    while (move > 0 && li < legs.length) {
      const P = legs[li].pts;
      const d = map.distance(P[seg], P[seg + 1]) - along;
      if (move < d) { along += move; move = 0; break; }
      move -= d; along = 0; seg++;
      if (seg >= P.length - 1) {
        legs[li].lines.forEach(p => p.setLatLngs(P));
        done.push(li); li++; seg = 0;
        if (li < legs.length) { veh.setIcon(L.divIcon({ className: 'vehicle', html: legs[li].icon, iconSize: [26, 26], iconAnchor: [13, 13] })); pause = 350; break; }
      }
    }
    if (li >= legs.length) { veh.setLatLng(pts[pts.length - 1]); state.anim = null; return; }
    const P = legs[li].pts, a = P[seg], b = P[seg + 1], f = along / Math.max(map.distance(a, b), 1e-9);
    const cur = L.latLng(a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f);
    legs[li].lines.forEach(p => p.setLatLngs([...P.slice(0, seg + 1), cur]));
    veh.setLatLng(cur);
    state.anim = requestAnimationFrame(step);
  };
  state.anim = requestAnimationFrame(step);
}

function stopAnim() { if (state.anim) cancelAnimationFrame(state.anim); state.anim = null; }

map.on('click', (e) => {
  const s = state.s;
  if (!s) return;
  const p = [e.latlng.lng, s.H - e.latlng.lat];
  if (state.picking) { setEntry(...p); return; }
  if (!base()) return;
  let hit = s.blds.findIndex(b => pointInPoly(p, b.polygon));
  if (hit < 0) {                                                   // forgiving tap: nearest badge within 22 px
    let best = 22;
    s.blds.forEach((b, i) => {
      const d = map.latLngToContainerPoint(ll(...b.centroid)).distanceTo(e.containerPoint);
      if (d < best) { best = d; hit = i; }
    });
  }
  if (hit < 0) return;
  const side = state.src === 'swipe' ? (e.containerPoint.x < map.getSize().x * state.swipe ? 'pred' : 'gt') : state.src;
  select(hit, side);
  writeHash();
});

// ---------- map source, swipe ----------
function setSource(src) {
  if (state.nolabels && src !== 'pred') return;                     // an upload has no labelled map
  if (src === 'swipe' && state.src !== 'swipe' && state.s) {
    const c = map.latLngToContainerPoint(ll(state.s.W / 2, state.s.H / 2));
    state.swipe = Math.min(0.9, Math.max(0.1, c.x / map.getSize().x));
  }
  state.src = src;
  document.querySelectorAll('.seg button[data-src]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.src === src)));
  $('swipe').hidden = src !== 'swipe';
  panes.pred.style.display = src === 'gt' ? 'none' : '';
  panes.gt.style.display = src === 'pred' ? 'none' : '';
  updateClip();
  if (state.s) {
    drawCounter();
    drawHouseList();
    if (state.sel) {
      const side = src === 'swipe' ? state.sel.side : src;
      if (side !== state.sel.side || src !== 'swipe') select(state.sel.i, side);
    }
  }
}

function updateClip() {
  if (state.src !== 'swipe') { panes.pred.style.clipPath = panes.gt.style.clipPath = ''; return; }
  const size = map.getSize();
  const nw = map.containerPointToLayerPoint([0, 0]), se = map.containerPointToLayerPoint(size);
  const x = map.containerPointToLayerPoint([size.x * state.swipe, 0]).x;
  const box = (l, r) => `polygon(${l}px ${nw.y}px, ${r}px ${nw.y}px, ${r}px ${se.y}px, ${l}px ${se.y}px)`;
  panes.pred.style.clipPath = box(nw.x, x);                        // clip-path, not the deprecated clip: rect()
  panes.gt.style.clipPath = box(x, se.x);
  $('swipe').style.setProperty('--x', `${state.swipe * 100}%`);
}
map.on('move zoom resize viewreset', updateClip);

const handle = $('swipeHandle');
handle.addEventListener('pointerdown', (e) => {
  handle.setPointerCapture(e.pointerId);
  const move = (ev) => { state.swipe = Math.min(0.98, Math.max(0.02, ev.clientX / innerWidth)); updateClip(); };
  const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
});
handle.addEventListener('keydown', (e) => {
  const d = { ArrowLeft: -0.05, ArrowRight: 0.05 }[e.key];
  if (d) { state.swipe = Math.min(0.98, Math.max(0.02, state.swipe + d)); updateClip(); e.preventDefault(); }
});

// ---------- legend, controls ----------
function drawLegend() {
  const m = state.s.meta;
  const cols = classColors();
  $('legend').innerHTML = m.class_names.map((n, c) =>
    `<li><span class="sw" style="background:rgb(${cols[c].join(',')})"></span>${n}</li>`).join('');
}

// ---------- colour-blind palette ----------
const classColors = () => (state.cb ? CB_CLASS[state.s.ds] : state.s.meta.class_colors);

async function recolored(url, from, to) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height), a = d.data;
  const key = (r, g, b) => (r << 16) | (g << 8) | b, lut = new Map(from.map((f, k) => [key(...f), to[k]]));
  for (let i = 0; i < a.length; i += 4) {                          // overlays are exact colours, alpha 0 or 255
    if (!a[i + 3]) continue;
    const q = lut.get(key(a[i], a[i + 1], a[i + 2]));
    if (q) { a[i] = q[0]; a[i + 1] = q[1]; a[i + 2] = q[2]; }
  }
  ctx.putImageData(d, 0, 0);
  return c.toDataURL();
}

async function applyPalette() {
  document.documentElement.classList.toggle('cb', state.cb);
  const s = state.s;
  if (!s) return;
  if (state.cb && !s.cbUrls) {
    const [p, g] = await Promise.all(['pred', 'gt'].map(k => recolored(s.dir + k + '.png', s.meta.class_colors, CB_CLASS[s.ds])));
    if (state.s !== s) return;                                     // the scene changed meanwhile
    s.cbUrls = { pred: p, gt: g };
  }
  for (const k of ['pred', 'gt']) state.overlays[k].setUrl(state.cb ? s.cbUrls[k] : s.dir + k + '.png');
  drawLegend();
  drawHouses();
  drawHouseList();
  if (state.sel) select(state.sel.i, state.sel.side, false);
}

function getVar(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function opacity() { return $('tClasses').checked ? $('opacity').value / 100 : 0; }
function setOpacities() {
  const o = state.overlays;
  if (!o) return;
  o.pred.setOpacity(state.layer === 'classes' ? opacity() : 0);
  o.pwet.setOpacity(state.layer === 'pwet' ? Math.min(1, opacity() * 1.4) : 0);   // its colours carry their own alpha
  o.gt.setOpacity(opacity());
}

// ---------- water probability layer (prediction): p_wet = p1 + p4 per routing cell, coloured by the gates ----------
// solid yellow: a truck may cross the cell on the normal map but not on the cautious one (what makes "check first");
// faint yellow: other cells between the two gates; blue: at or above the normal gate. Buildings are left clear.
function pwetColor(p, cautious, tuned, gateCell = false) {
  if (gateCell) return [250, 204, 21, 190];
  if (p < cautious) return [0, 0, 0, 0];
  if (p < tuned) return [250, 204, 21, 80];
  const t = Math.min(1, (p - tuned) / (1 - tuned));             // light -> deep blue
  return [56 + (30 - 56) * t, 189 + (64 - 189) * t, 248 + (175 - 248) * t, 150 + 90 * t];
}

function pwetImage(grid) {
  const c = document.createElement('canvas');
  c.width = grid.w; c.height = grid.h;
  const ctx = c.getContext('2d'), img = ctx.createImageData(grid.w, grid.h), r = grid.pred.risk;
  const f = grid.pred.flags, fc = grid.pred_cautious.flags;
  const { offroad_maxwet_cautious: cg, offroad_maxwet_pred: tg } = grid.params;
  for (let i = 0; i < r.length; i++) {
    if (f[i] & 64) continue;                                       // building cell
    img.data.set(pwetColor(r[i], cg, tg, (f[i] & 1) && !(fc[i] & 1)).map(Math.round), 4 * i);
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

function drawPwetLegend() {
  const s = state.s, { offroad_maxwet_cautious: cg, offroad_maxwet_pred: tg } = s.grid.params;
  const stops = [];
  for (let k = 0; k <= 100; k += 2) {
    const [r, g, b, a] = pwetColor(k / 100, cg, tg);
    stops.push(`rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${(a / 255).toFixed(2)}) ${k}%`);
  }
  $('pwetRamp').style.background = `linear-gradient(90deg, ${stops.join(',')}), #1e293b`;
  $('pwetRamp').innerHTML = [0, cg, tg, 1].map(v => `<span style="left:${v * 100}%">${v === 0 || v === 1 ? v : fmt(v)}</span>`).join('');
  const what = s.ds === 'rescuenet' ? 'water or blocked road' : 'water';
  $('pwetText').innerHTML = `Model's probability of ${what} per cell. <b class="b">Blue</b> (≥ ${fmt(tg)}): treated as wet; ` +
    `trucks keep off it off-road. <b class="y">Yellow</b> (${fmt(cg)}–${fmt(tg)}), solid where a truck may cross only on the ` +
    'normal map, not the cautious one: houses reached through it are "check first". Prediction only: the labelled map has no probabilities.';
  $('pwetLegend').hidden = state.layer !== 'pwet';
}

function setLayer(layer) {
  state.layer = layer === 'pwet' ? 'pwet' : 'classes';
  document.querySelectorAll('.seg button[data-layer]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.layer === state.layer)));
  $('pwetLegend').hidden = state.layer !== 'pwet';
  setOpacities();
}

document.querySelectorAll('.seg button[data-src]').forEach(b => b.addEventListener('click', () => { setSource(b.dataset.src); writeHash(); }));
document.querySelectorAll('.seg button[data-layer]').forEach(b => b.addEventListener('click', () => { setLayer(b.dataset.layer); writeHash(); }));
document.querySelectorAll('.seg.ds button').forEach(b => b.addEventListener('click', () => { state.ds = b.dataset.ds; drawBrowse(); markPressed(); }));
$('sortScenes').addEventListener('change', (e) => { state.sort = e.target.value; drawBrowse(); markPressed(); });
$('prevScene').addEventListener('click', () => step(-1));
$('nextScene').addEventListener('click', () => step(1));
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === 'n' || e.key === 'N') step(1);
  else if (e.key === 'p' || e.key === 'P') step(-1);
});
$('copyLink').addEventListener('click', async () => {
  writeHash();
  let ok = true;
  try { await navigator.clipboard.writeText(location.href); } catch { ok = false; }
  $('copyLink').textContent = ok ? 'Link copied' : 'Copy the address bar';
  setTimeout(() => { $('copyLink').textContent = 'Copy link to this view'; }, 1800);
});
$('opacity').addEventListener('input', () => { $('tClasses').checked = true; setOpacities(); });
$('tClasses').addEventListener('change', setOpacities);
$('tStatus').addEventListener('change', drawHouses);
$('tDisagree').addEventListener('change', drawHouses);
$('tBase').addEventListener('change', drawBase);
$('tCb').addEventListener('change', () => { state.cb = $('tCb').checked; applyPalette(); writeHash(); });
$('tRisk').addEventListener('change', () => { state.lam = $('tRisk').checked ? 5 : 0; solve(); writeHash(); });
$('entryPick').addEventListener('click', () => setPicking(!state.picking));
$('entryAuto').addEventListener('click', () => { state.entry = null; state.entryMsg = null; setPicking(false); solve(); writeHash(); });
$('sheetToggle').addEventListener('click', () => {
  const p = $('panel'), c = p.classList.toggle('collapsed');
  $('sheetToggle').setAttribute('aria-expanded', String(!c));
  if (!c) markPressed();                                           // the photo list can only scroll once visible
  setTimeout(fit, 50);
});
addEventListener('resize', () => { clearTimeout(state.rt); state.rt = setTimeout(fit, 150); });
addEventListener('hashchange', applyHash);                          // back/forward, or a pasted link

// ---------- the view in the URL: #s=<scene>&h=<house id>[gt]&e=<x>,<y>&m=gt|swipe&l=pwet&r=0&cb=1 ----------
function readHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  const q = new URLSearchParams(h.includes('=') ? h : `s=${h}`);   // old links: #floodnet_7241
  return Object.fromEntries(['s', 'h', 'e', 'm', 'l', 'r', 'cb'].map(k => [k, q.get(k)]));
}

function writeHash(push = false) {
  if (!state.s) return;
  const q = [`s=${state.key}`];
  if (state.sel) q.push(`h=${state.s.blds[state.sel.i].id}${state.src === 'swipe' && state.sel.side === 'gt' ? 'gt' : ''}`);
  if (state.entry) q.push(`e=${state.entry.at.map(Math.round).join(',')}`);
  if (state.src !== 'pred') q.push(`m=${state.src}`);
  if (state.layer !== 'classes') q.push(`l=${state.layer}`);
  if (!state.lam) q.push('r=0');
  if (state.cb) q.push('cb=1');
  const url = `#${q.join('&')}`;
  if (url !== location.hash) history[push ? 'pushState' : 'replaceState'](null, '', url);
}

async function applyHash() {
  const p = readHash();
  if (!state.s || (p.s && p.s !== state.key)) await loadScene(p.s);
  if (p.r != null && (p.r !== '0') !== Boolean(state.lam)) { $('tRisk').checked = p.r !== '0'; state.lam = p.r === '0' ? 0 : 5; solve(); }
  if (p.l) setLayer(p.l);
  if (p.cb != null && (p.cb === '1') !== state.cb) { state.cb = p.cb === '1'; $('tCb').checked = state.cb; await applyPalette(); }
  if (p.m && ['pred', 'gt', 'swipe'].includes(p.m)) setSource(p.m);
  if (p.e) {
    const [x, y] = p.e.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) setEntry(Math.min(state.s.W - 1, Math.max(0, x)), Math.min(state.s.H - 1, Math.max(0, y)));
  }
  if (p.h) {
    const i = state.s.blds.findIndex(b => b.id === parseInt(p.h, 10));
    if (i >= 0 && base()) select(i, state.src === 'swipe' ? (p.h.endsWith('gt') ? 'gt' : 'pred') : state.src);
  }
  writeHash();
}

(async () => {
  if (innerWidth <= 760) { $('panel').classList.add('collapsed'); $('sheetToggle').setAttribute('aria-expanded', 'false'); }
  await loadIndex();
  drawBrowse();
  setSource('pred');
  await applyHash();
})();

window.rr = { state, map };                                         // for debugging in the console
