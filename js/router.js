// JavaScript port of src/router.py (PLAN §6.1): truck/boat Dijkstra on the 4x4-px cell grid.
// It must reproduce the Python statuses and route costs on the exported grids (app/test/router.test.mjs).
//
// States (cell, mode), mode TRUCK (layer 0), BOAT (layer 1) or FOOT (layer 2), 8-connected, step 1 or sqrt(2).
//   TRUCK enters a road_clear cell at len * (1 + lam * risk), or dry 'other' land at `offroad` x that
//         (on predicted maps only where risk < offroad_maxwet, the off-road gate); risk = p1 + p4
//   BOAT  enters a boat cell (class, or p_boat >= boat_p) at len * boat_cost
//   FOOT  enters dry land (road_clear, gated 'other') or RescueNet debris (blocked road) at len * foot_cost
//   launch TRUCK -> BOAT into a neighbouring boat cell: len * boat_cost + launch
//   alight TRUCK or BOAT -> FOOT into a neighbouring foot cell: len * foot_cost + alight
//          modes only go forward (truck -> boat -> foot), never back to a vehicle
//   walls  buildings are never entered (RescueNet road_blocked: by truck and boat only)
// Which cells each mode may enter (vehicle widths, the off-road gate, closed car gaps, canopy strips) is
// decided in Python (router.Grid.flags) and exported per cell, so the rules cannot drift between the two;
// this file does the search: costs, the corner rule, statuses and routes on per-mode goal rings.
// The truck cost is computed in float32 like NumPy does ((1 + lam * risk) on a float32 array), then
// multiplied by the float64 step length, so the costs match Python to the last bit (up to tie order).

export const TRUCK = 0, BOAT = 1, FOOT = 2, ISOLATED = 3;
export const STATUS = ['TRUCK', 'BOAT', 'FOOT', 'ISOLATED'];
export const TIERS = ['CONFIDENT_TRUCK', 'PROBABLE_TRUCK', 'BOAT', 'FOOT', 'ISOLATED'];

/** router.tier: truck-reachable with the cautious gate -> CONFIDENT_TRUCK, only with the tuned gate -> PROBABLE_TRUCK */
export function tier(stTuned, stCautious) {
  if (stCautious === TRUCK) return 'CONFIDENT_TRUCK';
  if (stTuned === TRUCK) return 'PROBABLE_TRUCK';
  return STATUS[stTuned];
}

/** router.eta: metres per mode and minutes of a route (speeds and handover minutes from grid.json `eta`) */
export function eta(route, grid, speeds, cellM = null) {
  cellM = cellM || grid.cellM;
  const metres = [0, 0, 0];
  let minutes = 0;
  const { cells, modes } = route;
  for (let k = 1; k < cells.length; k++) {
    const [y0, x0] = cells[k - 1], [y, x] = cells[k], m = modes[k], b = y * grid.w + x;
    const d = Math.hypot(y - y0, x - x0) * cellM;
    metres[m] += d;
    const v = m === TRUCK ? (grid.offroad[b] ? speeds.truck_offroad : speeds.truck)
      : m === BOAT ? (grid.canopy[b] ? speeds.boat_canopy : speeds.boat) : speeds.foot;
    minutes += d / (v * 1000 / 60);
    if (m !== modes[k - 1]) minutes += m === BOAT ? speeds.launch_min : speeds.alight_min;
  }
  return { metres, minutes };
}
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const f32 = Math.fround;

/** Read a scene.rrb file (src/export_web_assets.py pack_scene): gzip of [uint32 header length][header JSON]
 *  [arrays]. Returns {grid, buildings}: grid = the meta of the header with typed-array layers pred / gt
 *  ({cls, risk, flags}) and pred_cautious ({flags}), ready for sceneGrids. Accepts the raw gzip bytes or, when a
 *  server already decompressed them (Content-Encoding), the plain payload. */
export async function parseScene(buf) {
  let u8 = new Uint8Array(buf);
  if (u8[0] === 0x1f && u8[1] === 0x8b) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    u8 = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (u8.byteOffset % 4) u8 = u8.slice();                          // Float32Array views need 4-byte alignment
  const n = new DataView(u8.buffer, u8.byteOffset, 4).getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + n)));
  const base = u8.byteOffset + 4 + n;                                // 4-byte aligned by construction
  const grid = head.grid;
  for (const a of head.arrays) {
    const [layer, key] = a.name.split('.');
    const arr = a.dtype === 'f32' ? new Float32Array(u8.buffer, base + a.offset, a.length)
      : new Uint8Array(u8.buffer, base + a.offset, a.length);
    (grid[layer] ||= {})[key] = arr;
  }
  return { grid, buildings: head.buildings };
}

/** One map's routing graph. layer = {cls, risk, flags} (typed arrays from parseScene);
 *  flags bits (router.Grid.flags): 1 truck, 2 boat, 4 foot, 8 off-road (truck slow), 16 canopy (boat slow),
 *  32 wall, 64 building. */
export class Grid {
  constructor(gridJson, layer, opts = {}) {
    const g = gridJson;
    this.h = g.h; this.w = g.w; this.n = g.h * g.w;
    this.prof = g.profile;
    this.par = { lam: g.params.lam, boat_cost: g.params.boat_cost, launch: g.params.launch, offroad: g.params.offroad,
                 foot_cost: g.params.foot_cost, alight: g.params.alight, canopy_cost: g.params.canopy_cost,
                 corner: g.params.corner, ...opts };
    this.cls = layer.cls; this.risk = layer.risk;
    this.cellM = g.params.cell_m;
    const f = layer.flags, n = this.n, p = this.par;
    this.foot = p.foot_cost != null;
    this.layers = this.foot ? 3 : 2;
    this.truckOk = new Uint8Array(n); this.boatOk = new Uint8Array(n); this.footOk = new Uint8Array(n);
    this.wall = new Uint8Array(n); this.bldg = new Uint8Array(n);
    this.offroad = new Uint8Array(n); this.canopy = new Uint8Array(n);
    this.slow = new Float64Array(n); this.slowBoat = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.truckOk[i] = f[i] & 1; this.boatOk[i] = (f[i] >> 1) & 1; this.footOk[i] = this.foot && (f[i] >> 2) & 1;
      this.slow[i] = f[i] & 8 ? (p.offroad || 1) : 1;
      this.slowBoat[i] = f[i] & 16 ? p.canopy_cost : 1;
      this.wall[i] = (f[i] >> 5) & 1; this.bldg[i] = (f[i] >> 6) & 1;
      this.offroad[i] = (f[i] >> 3) & 1; this.canopy[i] = (f[i] >> 4) & 1;
    }
  }

  truckStep(L, b) {
    return L * f32(1 + f32(this.par.lam * this.risk[b])) * this.slow[b];
  }

  /** Multi-source Dijkstra from base = {cells: [flat ids], mode: 'TRUCK'|'BOAT'} (entry cost 0). */
  solve(base) {
    const n = this.n, w = this.w, h = this.h, p = this.par;
    const dist = new Float64Array(this.layers * n).fill(Infinity);
    const pred = new Int32Array(this.layers * n).fill(-1);
    const heap = new MinHeap();
    if (base) {
      const off = base.mode === 'BOAT' ? n : 0;
      for (const c of base.cells) { dist[c + off] = 0; heap.push(0, c + off); }
    }
    const boatL = [p.boat_cost, Math.SQRT2 * p.boat_cost];
    const wall = this.wall, bldg = this.bldg;
    const footL = this.foot ? [p.foot_cost, Math.SQRT2 * p.foot_cost] : null;
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > dist[u]) continue;
      const mode = Math.floor(u / n), a = u - mode * n, ay = (a / w) | 0, ax = a - ay * w;
      for (const [dy, dx] of DIRS) {
        const y = ay + dy, x = ax + dx;
        if (y < 0 || y >= h || x < 0 || x >= w) continue;
        const b = y * w + x, diag = dy !== 0 && dx !== 0, L = diag ? Math.SQRT2 : 1;
        // corner rule: no diagonal squeeze between two obstacle cells touching at a corner
        const o1 = y * w + ax, o2 = ay * w + x;
        const okV = !(diag && p.corner && wall[o1] && wall[o2]), okF = !(diag && p.corner && bldg[o1] && bldg[o2]);
        if (mode === TRUCK && okV && this.truckOk[b]) relax(b, d + this.truckStep(L, b), u);
        if (mode <= BOAT && okV && this.boatOk[b]) {
          const c = boatL[+diag] * this.slowBoat[b];
          relax(n + b, d + (mode === BOAT ? c : c + p.launch), u);
        }
        if (this.foot && okF && this.footOk[b]) relax(2 * n + b, d + (mode === FOOT ? footL[+diag] : footL[+diag] + p.alight), u);
      }
    }
    function relax(v, nd, u) {
      if (nd < dist[v]) { dist[v] = nd; pred[v] = u; heap.push(nd, v); }
    }
    return new Solution(this, dist, pred);
  }
}

export class Solution {
  constructor(grid, dist, pred) { this.grid = grid; this.dist = dist; this.pred = pred; }

  /** goals = [truck ring, boat ring, foot ring] of a building (buildings.json `goals`): a wide vehicle
   *  reaches a house when its edge is within the plain ring, so its goal ring is wider. */
  status(goals) {
    const n = this.grid.n;
    for (let layer = 0; layer < this.grid.layers; layer++) {
      if (goals[layer].some(c => Number.isFinite(this.dist[layer * n + c]))) return layer;
    }
    return ISOLATED;
  }

  /** Cheapest route to the house ending in `layer` (default: the layer of its status, as router.py):
   *  {cells: [[y, x]], modes: [0|1|2], cost} or null (first minimum, like np.argmin). */
  route(goals, layer = null) {
    const n = this.grid.n, w = this.grid.w;
    if (layer === null) layer = this.status(goals);
    if (layer === ISOLATED) return null;
    const ring = goals[layer];
    if (!ring.length) return null;
    let best = -1;
    for (const c of ring) { const j = layer * n + c; if (best < 0 || this.dist[j] < this.dist[best]) best = j; }
    if (best < 0 || !Number.isFinite(this.dist[best])) return null;
    const nodes = [best];
    while (this.pred[nodes[nodes.length - 1]] >= 0) nodes.push(this.pred[nodes[nodes.length - 1]]);
    nodes.reverse();
    return { cells: nodes.map(v => { const c = v % n; return [(c / w) | 0, c % w]; }),
             modes: nodes.map(v => Math.floor(v / n)), cost: this.dist[best] };
  }
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = [k[0], v[0]];
    const lk = k.pop(), lv = v.pop(), m = k.length;
    if (m) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= m) break;
        if (c + 1 < m && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

/** The maps of a scene: the prediction with the off-road gate, the labelled map without (as route_eval.py), and the
 *  prediction with the cautious gate (confidence tiers; same classes, its own passability flags). */
export function sceneGrids(gridJson, lam) {
  const o = lam == null ? {} : { lam };
  return { pred: new Grid(gridJson, gridJson.pred, o), gt: new Grid(gridJson, gridJson.gt, o),
           pred_cautious: new Grid(gridJson, { ...gridJson.pred, flags: gridJson.pred_cautious.flags }, o) };
}
