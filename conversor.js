// Conversor do HTML 3D: lê STEP/IGES/BREP (OCCT), IFC (web-ifc), GLB/GLTF/OBJ/STL (three.js) e monta o HTML
// no MESMO formato do montar_navio.py: um bloco gzip+base64 por disciplina, vértice soldado, coordenada em 16 bits na
// caixa de cada geometria, índice 16/32 bits, instâncias com matriz. Tudo roda no navegador; nada sai do aparelho.
import * as THREE from 'three';
import { gzipSync, gunzipSync, unzlibSync, inflateSync } from './lib/fflate/browser.js';

const BASE = new URL('.', import.meta.url).href;
const EXT = { step: 'step', stp: 'step', iges: 'iges', igs: 'iges', brep: 'brep', ifc: 'ifc', glb: 'gltf', gltf: 'gltf',
  obj: 'obj', stl: 'stl', html: 'html', htm: 'html', sldasm: 'sw', sldprt: 'sw', slddrw: 'sw' };
export const formato = nome => EXT[nome.split('.').pop().toLowerCase()] || null;
// unidade (metro por unidade do arquivo; null = deduzir) e eixo vertical de cada formato
const PADRAO = { step: [0.001, 'Z'], iges: [0.001, 'Z'], brep: [0.001, 'Z'], ifc: [1, 'Y'], gltf: [1, 'Y'], obj: [null, 'Y'], stl: [null, 'Z'] };
const tick = () => new Promise(r => setTimeout(r, 0));

// ---------- leitores: devolvem {geos:[{pos,idx}], inst:[{name,group,color,gi,mat}]} ----------
let occtP = null, ifcP = null;
function script(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res;
    s.onerror = () => rej(Error('Não carregou ' + src.split('/').pop() + ' (sem internet na primeira vez?)')); document.head.append(s) });
}
function occt() {
  return occtP ||= script(BASE + 'lib/occt/occt-import-js.js').then(() => globalThis.occtimportjs({ locateFile: f => BASE + 'lib/occt/' + f }));
}
function ifcApi() {
  return ifcP ||= (async () => { const W = await import('./lib/web-ifc/web-ifc-api.js'); const api = new W.IfcAPI();
    api.SetWasmPath(BASE + 'lib/web-ifc/', true); await api.Init(undefined, true); return api })();
}

async function lerOcct(bytes, fmt) {
  const o = await occt(), p = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.5 };
  const r = fmt === 'step' ? o.ReadStepFile(bytes, p) : fmt === 'iges' ? o.ReadIgesFile(bytes, p) : o.ReadBrepFile(bytes, p);
  if (!r || !r.success) throw Error('O arquivo não foi lido (STEP/IGES inválido ou sem sólido).');
  const geos = [], inst = [], I = new THREE.Matrix4(), cor = c => c && c.length >= 3 ? c.map(x => x > 1 ? x / 255 : x).slice(0, 3) : null;
  const walk = (node, path) => {
    for (const mi of node.meshes || []) {
      const m = r.meshes[mi], pos = new Float32Array(m.attributes.position.array), idx = Uint32Array.from(m.index.array);
      const base = cor(m.color) || [0.72, 0.74, 0.76], faces = m.brep_faces || [], porCor = new Map();
      for (const f of faces) { const c = cor(f.color) || base, k = c.join(); if (!porCor.has(k)) porCor.set(k, { c, t: [] }); porCor.get(k).t.push(f.first, f.last) }
      const partes = porCor.size > 1 ? [...porCor.values()].map(({ c, t }) => {
        let n = 0; for (let i = 0; i < t.length; i += 2) n += t[i + 1] - t[i] + 1;
        const ix = new Uint32Array(n * 3); let o = 0;
        for (let i = 0; i < t.length; i += 2) { ix.set(idx.subarray(t[i] * 3, (t[i + 1] + 1) * 3), o); o += (t[i + 1] - t[i] + 1) * 3 }
        return { c, ix } }) : [{ c: porCor.size ? [...porCor.values()][0].c : base, ix: idx }];
      for (const pt of partes) { geos.push({ pos, idx: pt.ix }); inst.push({ name: node.name || m.name || 'Peça', group: path.join('/'), color: pt.c, gi: geos.length - 1, mat: I }) }
    }
    for (const ch of node.children || []) walk(ch, node.name ? [...path, node.name] : path);
  };
  walk(r.root, []);
  return { geos, inst };
}

async function lerIfc(bytes) {
  const api = await ifcApi(), id = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true });
  const geos = [], gmap = new Map(), inst = [];
  try {
    api.StreamAllMeshes(id, fm => {
      let nome = '', tipo = '';
      try { const l = api.GetLine(id, fm.expressID); nome = l && l.Name && l.Name.value || ''; tipo = api.GetNameFromTypeCode(api.GetLineType(id, fm.expressID)) || '' } catch (e) { }
      for (let i = 0, n = fm.geometries.size(); i < n; i++) {
        const pg = fm.geometries.get(i);
        let gi = gmap.get(pg.geometryExpressID);
        if (gi === undefined) {
          const g = api.GetGeometry(id, pg.geometryExpressID), v = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
          const ix = Uint32Array.from(api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize())), pos = new Float32Array(v.length / 2);
          for (let k = 0, j = 0; k < v.length; k += 6) { pos[j++] = v[k]; pos[j++] = v[k + 1]; pos[j++] = v[k + 2] }
          g.delete(); gi = geos.length; geos.push({ pos, idx: ix }); gmap.set(pg.geometryExpressID, gi);
        }
        inst.push({ name: nome || tipo || '#' + fm.expressID, group: tipo, color: [pg.color.x, pg.color.y, pg.color.z], gi, mat: new THREE.Matrix4().fromArray(pg.flatTransformation) });
      }
    });
  } finally { api.CloseModel(id) }
  if (!inst.length) throw Error('O IFC não tem geometria.');
  return { geos, inst };
}

function extrair(geo, start, count) {
  const a = geo.attributes.position, ix = geo.index;
  if (ix) {
    const fim = Math.min(ix.count, start + count), idx = new Uint32Array(fim - start);
    for (let k = start; k < fim; k++) idx[k - start] = ix.getX(k);
    const pos = new Float32Array(a.count * 3); for (let k = 0; k < a.count; k++) { pos[3 * k] = a.getX(k); pos[3 * k + 1] = a.getY(k); pos[3 * k + 2] = a.getZ(k) }
    return { pos, idx };
  }
  const fim = Math.min(a.count, start + count), pos = new Float32Array((fim - start) * 3);
  for (let k = start; k < fim; k++) { const o = 3 * (k - start); pos[o] = a.getX(k); pos[o + 1] = a.getY(k); pos[o + 2] = a.getZ(k) }
  return { pos, idx: null };
}

async function lerThree(buf, fmt, nome) {
  let root;
  if (fmt === 'gltf') {
    const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([import('./lib/three/examples/jsm/loaders/GLTFLoader.js'), import('./lib/three/examples/jsm/loaders/DRACOLoader.js')]);
    const l = new GLTFLoader(), d = new DRACOLoader(); d.setDecoderPath(BASE + 'lib/three/examples/jsm/libs/draco/gltf/'); l.setDRACOLoader(d);
    root = (await new Promise((res, rej) => l.parse(buf, '', res, e => rej(Error('GLB/GLTF não lido: ' + (e.message || e) + '. GLTF com arquivos separados: exporte como GLB.'))))).scene;
  } else if (fmt === 'obj') {
    const { OBJLoader } = await import('./lib/three/examples/jsm/loaders/OBJLoader.js');
    root = new OBJLoader().parse(new TextDecoder().decode(buf));
  } else {
    const { STLLoader } = await import('./lib/three/examples/jsm/loaders/STLLoader.js');
    root = new THREE.Mesh(new STLLoader().parse(buf), new THREE.MeshStandardMaterial({ color: 0xb4bcc2 })); root.name = nome.replace(/\.[^.]+$/, '');
  }
  root.updateMatrixWorld(true);
  const geos = [], gmap = new Map(), inst = [];
  root.traverse(o => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const path = []; for (let p = o.parent; p && p !== root.parent; p = p.parent) if (p.name && p !== o) path.unshift(p.name);
    const geo = o.geometry, mats = Array.isArray(o.material) ? o.material : [o.material];
    const partes = Array.isArray(o.material) && geo.groups.length ? geo.groups.map(g => ({ s: g.start, c: g.count, m: mats[g.materialIndex] })) : [{ s: 0, c: Infinity, m: mats[0] }];
    const mats4 = [];
    if (o.isInstancedMesh) for (let i = 0; i < o.count; i++) { const m = new THREE.Matrix4(); o.getMatrixAt(i, m); mats4.push(new THREE.Matrix4().multiplyMatrices(o.matrixWorld, m)) }
    else mats4.push(o.matrixWorld.clone());
    partes.forEach((pt, k) => {
      const key = geo.uuid + ':' + k; let gi = gmap.get(key);
      if (gi === undefined) { gi = geos.length; geos.push(extrair(geo, pt.s, pt.c)); gmap.set(key, gi) }
      let c = pt.m && pt.m.color ? [pt.m.color.r, pt.m.color.g, pt.m.color.b] : [0.7, 0.72, 0.74];
      if (fmt !== 'gltf' && c.every(x => x > 0.99)) c = [0.7, 0.72, 0.74];   // OBJ sem MTL vem branco
      mats4.forEach((M, i) => inst.push({ name: (o.name || path[path.length - 1] || nome) + (mats4.length > 1 ? ' #' + (i + 1) : ''), group: path.join('/'), color: c, gi, mat: M }));
    });
  });
  if (!inst.length) throw Error('O arquivo não tem malha.');
  return { geos, inst };
}

export async function ler(arq, fmt) {
  const buf = await arq.arrayBuffer();
  if (fmt === 'step' || fmt === 'iges' || fmt === 'brep') return lerOcct(new Uint8Array(buf), fmt);
  if (fmt === 'ifc') return lerIfc(new Uint8Array(buf));
  if (fmt === 'gltf' || fmt === 'obj' || fmt === 'stl') return lerThree(buf, fmt, arq.name);
  throw Error('Formato não convertido no navegador: ' + arq.name);
}

// ---------- geometria: tabela de hash de triplas inteiras (solda e simplificação) ----------
function tab3(n) {
  let cap = 16; while (cap < n * 2) cap *= 2;
  const mask = cap - 1, t = new Int32Array(cap).fill(-1), k = new Int32Array(n * 3 + 3); let m = 0;
  return { get n() { return m }, id(a, b, c) {
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & mask, j;
    while ((j = t[h]) !== -1) { if (k[3 * j] === a && k[3 * j + 1] === b && k[3 * j + 2] === c) return j; h = (h + 1) & mask }
    j = m++; t[h] = j; k[3 * j] = a; k[3 * j + 1] = b; k[3 * j + 2] = c; return j } };
}
// vértice soldado exato (mesmos bits) e só os vértices usados
function soldar(pos, idx) {
  const n = pos.length / 3, u = new Int32Array(pos.buffer, pos.byteOffset, pos.length), ni = idx ? idx.length : n;
  const T = tab3(Math.min(n, ni)), rm = new Int32Array(n).fill(-1), ix = new Uint32Array(ni), out = new Int32Array(Math.min(n, ni) * 3);
  for (let k = 0; k < ni; k++) {
    const i = idx ? idx[k] : k;
    if (rm[i] < 0) { const m0 = T.n, j = T.id(u[3 * i], u[3 * i + 1], u[3 * i + 2]); if (j === m0) { out[3 * j] = u[3 * i]; out[3 * j + 1] = u[3 * i + 1]; out[3 * j + 2] = u[3 * i + 2] } rm[i] = j }
    ix[k] = rm[i];
  }
  return { v: new Float32Array(out.buffer, 0, T.n * 3), ix };
}
function caixa(v) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) { const x = v[i + k]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x }
  return [lo, hi];
}
// agrupamento de vértices numa grade (igual ao reduzir do montar_navio): some só o detalhe menor que a célula
function reduzir(v, ix, lim, cel) {
  const n = v.length / 3, [lo] = caixa(v);
  for (let it = 0; it < 80; it++, cel *= 1.5) {
    const T = tab3(n), cid = new Int32Array(n);
    for (let i = 0; i < n; i++) cid[i] = T.id(Math.floor((v[3 * i] - lo[0]) / cel), Math.floor((v[3 * i + 1] - lo[1]) / cel), Math.floor((v[3 * i + 2] - lo[2]) / cel));
    const D = tab3(ix.length / 3), out = new Uint32Array(ix.length); let t = 0;
    for (let k = 0; k < ix.length; k += 3) {
      const a = cid[ix[k]], b = cid[ix[k + 1]], c = cid[ix[k + 2]];
      if (a === b || b === c || a === c) continue;
      const s0 = Math.min(a, b, c), s2 = Math.max(a, b, c), s1 = a + b + c - s0 - s2, m0 = D.n;
      if (D.id(s0, s1, s2) !== m0) continue;
      out[t++] = a; out[t++] = b; out[t++] = c;
    }
    if (t / 3 <= lim) {
      const m = T.n, s = new Float64Array(m * 3), c = new Uint32Array(m), rep = new Float32Array(m * 3);
      for (let i = 0; i < n; i++) { const j = cid[i]; s[3 * j] += v[3 * i]; s[3 * j + 1] += v[3 * i + 1]; s[3 * j + 2] += v[3 * i + 2]; c[j]++ }
      for (let j = 0; j < m * 3; j++) rep[j] = s[j] / c[(j / 3) | 0];
      return { v: rep, ix: out.slice(0, t), cel };
    }
  }
  return { v, ix, cel };
}

// ---------- montagem do bloco de uma disciplina (formato do montar_navio.py) ----------
const QUAL = { normal: [10000, 1000, 20000], leve: [4000, 500, 8000], maxima: null };
const fmtN = n => n.toLocaleString('pt-BR');
const prec = x => +(+x).toPrecision(9);

export async function bloco(d, prog) {
  const { src, unit, up, label, key, qual, arquivo } = d, Q = QUAL[qual];
  if (src.bloco) return src.bloco;   // bloco do navio que veio pronto de um HTML: entra como está
  const U = new THREE.Matrix4().makeScale(unit, unit, unit);
  if (up === 'Y') U.premultiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));   // Y para cima -> Z para cima
  const parts = [], meshes = [], red = []; let off = 0, conta = 0;
  const put = u8 => { const pad = (4 - u8.byteLength % 4) % 4; parts.push(u8); if (pad) parts.push(new Uint8Array(pad)); const o = off; off += u8.byteLength + pad; return o };
  const enc = new Map(), meshDe = new Map();
  const codificar = gi => {
    let { v, ix } = soldar(src.geos[gi].pos, src.geos[gi].idx);
    let [lo, hi] = caixa(v);
    if (Q && ix.length / 3 > Q[2] / 4) {
      const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * unit, lim = Math.max(Q[1], Math.min(Q[2], Math.floor(diag * Q[0])));
      if (ix.length / 3 > lim) {
        const antes = ix.length / 3, r = reduzir(v, ix, lim, 0.0005 / unit), s = soldar(r.v, r.ix);
        v = s.v; ix = s.ix; [lo, hi] = caixa(v);
        red.push(`${src.nomeGeo?.[gi] || 'geometria ' + gi}: ${fmtN(antes)} → ${fmtN(ix.length / 3)} triângulos (grade ${(r.cel * unit * 1000).toFixed(1)} mm)`);
      }
    }
    const vn = v.length / 3, sz = [0, 1, 2].map(k => Math.max(hi[k] - lo[k], 1e-9)), q = new Uint16Array(vn * 3);
    for (let i = 0; i < vn * 3; i++) { const k = i % 3; q[i] = Math.round((v[i] - lo[k]) / sz[k] * 65535) }
    const w = vn > 65535 ? 4 : 2, io = w === 4 ? ix : Uint16Array.from(ix);
    return { b: [...lo.map(prec), ...sz.map(x => x / 65535)], vn, ni: ix.length, w, qo: put(new Uint8Array(q.buffer)), io: put(new Uint8Array(io.buffer, io.byteOffset, io.byteLength)) };
  };
  const tab = { g: [], f: [], c: [] }, ixt = { g: new Map(), f: new Map(), c: new Map() };
  const t = (k, s) => { if (!ixt[k].has(s)) { ixt[k].set(s, tab[k].length); tab[k].push(s) } return ixt[k].get(s) };
  const I = { n: [], g: [], f: [], c: [], m: [], t: [], h: [] }, M = new THREE.Matrix4();
  for (const it of src.inst) {
    if (!enc.has(it.gi)) { enc.set(it.gi, codificar(it.gi)); if (++conta % 200 === 0) { prog(`${label}: ${fmtN(conta)} de ${fmtN(src.geos.length)} geometrias`); await tick() } }
    const e = enc.get(it.gi), c = it.color.map(x => Math.round(x * 1e4) / 1e4), mk = it.gi + '|' + c.join();
    if (!meshDe.has(mk)) { meshDe.set(mk, meshes.length); meshes.push({ c, ...e }) }
    M.multiplyMatrices(U, it.mat); const a = M.elements;
    I.n.push(it.name); I.g.push(t('g', label + (it.group ? '/' + it.group : ''))); I.f.push(t('f', arquivo)); I.c.push(t('c', ''));
    if (it.hidden) I.h.push(I.n.length - 1);
    I.m.push(meshDe.get(mk)); I.t.push(...[a[0], a[1], a[2], a[4], a[5], a[6], a[8], a[9], a[10], a[12], a[13], a[14]].map(prec), 1);
  }
  const tri = I.m.reduce((s, m) => s + meshes[m].ni / 3, 0);
  const H = { reduced: red, key, label, source: arquivo, exportedAt: new Date().toLocaleString('pt-BR'), meshes, inst: I, groups: tab.g, files: tab.f,
    configs: tab.c, omitted: [], counts: { triangles: tri, suppressed: 0, hidden: 0 } };
  prog(`${label}: compactando…`); await tick();
  const head = new TextEncoder().encode(JSON.stringify(H)), hp = (4 - (4 + head.length) % 4) % 4;
  const payload = new Uint8Array(4 + head.length + hp + off); new DataView(payload.buffer).setUint32(0, head.length, true);
  payload.set(head, 4); payload.fill(32, 4 + head.length, 4 + head.length + hp);
  let o = 4 + head.length + hp; for (const p of parts) { payload.set(p, o); o += p.byteLength }
  const gz = gzipSync(payload, { level: 6, mtime: 0 });
  // caixa do conjunto (para conferir unidade e eixo antes de publicar)
  const bb = new THREE.Box3(), gb = new Map();
  for (let k = 0; k < I.n.length; k++) {
    const m = meshes[I.m[k]]; let b = gb.get(I.m[k]);
    if (!b) { b = new THREE.Box3(new THREE.Vector3(m.b[0], m.b[1], m.b[2]), new THREE.Vector3(m.b[0] + m.b[3] * 65535, m.b[1] + m.b[4] * 65535, m.b[2] + m.b[5] * 65535)); gb.set(I.m[k], b) }
    const a = I.t.slice(k * 13, k * 13 + 13); M.set(a[0], a[3], a[6], a[9], a[1], a[4], a[7], a[10], a[2], a[5], a[8], a[11], 0, 0, 0, 1); bb.union(b.clone().applyMatrix4(M));
  }
  const tam = bb.isEmpty() ? [0, 0, 0] : bb.getSize(new THREE.Vector3()).toArray();
  return { key, label, n: I.n.length, tri, b64: base64(gz), bruto: payload.length, red, tam };
}

export function base64(u8) {
  const out = []; for (let i = 0; i < u8.length; i += 49152) out.push(btoa(String.fromCharCode.apply(null, u8.subarray(i, i + 49152))));
  return out.join('');
}
export function padrao(fmt, src) {
  let [unit, up] = PADRAO[fmt];
  if (unit === null) {   // STL/OBJ não dizem a unidade: modelo com mais de 200 unidades de diagonal = milímetro
    const bb = new THREE.Box3(), b = new THREE.Box3(), seen = new Map();
    for (const it of src.inst) { let g = seen.get(it.gi); if (!g) { const [lo, hi] = caixa(src.geos[it.gi].pos); g = new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(...hi)); seen.set(it.gi, g) } bb.union(b.copy(g).applyMatrix4(it.mat)) }
    unit = bb.getSize(new THREE.Vector3()).length() > 200 ? 0.001 : 1;
  }
  return { unit, up };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function montarHtml(molde, discs, meta) {
  let s = molde.split('__TITULO__').join(esc(meta.titulo)).split('__PROJETO__').join(esc(meta.projeto)).split('__SUB__').join(esc(meta.sub));
  s = s.replace('<script type="application/json" id="meta">{}</script>', () => '<script type="application/json" id="meta">' + JSON.stringify(meta).replace(/</g, '\\u003c') + '</script>');
  // data-off: a disciplina abre desligada (liga pela lista), p.ex. a 2ª configuração do berço, que se sobrepõe à 1ª
  const blocos = discs.map(d => `<script class="disc" type="application/octet-stream" data-k="${esc(d.key)}" data-label="${esc(d.label)}" data-n="${d.n}" data-tri="${d.tri}"${d.cor ? ` data-c="${d.cor}"` : ''}${d.off ? ' data-off="1"' : ''}>${d.b64}</script>`).join('');
  return s.replace('<!--DISCIPLINAS-->', () => blocos);
}

// malha única com cor por vértice (HTML do Codex) -> uma peça por parte conexa, agrupada pela cor
function pecasConexas(pos, ix, cor) {
  const nv = pos.length / 3, pai = new Int32Array(nv); for (let i = 0; i < nv; i++) pai[i] = i;
  const raiz = i => { while (pai[i] !== i) { pai[i] = pai[pai[i]]; i = pai[i] } return i };
  for (let k = 0; k < ix.length; k += 3) { const a = raiz(ix[k]); for (const v of [ix[k + 1], ix[k + 2]]) { const b = raiz(v); if (a !== b) pai[b] = a } }
  const comp = new Map();   // raiz -> lista de triângulos
  for (let k = 0; k < ix.length; k += 3) { const r = raiz(ix[k]); let l = comp.get(r); if (!l) comp.set(r, l = []); l.push(k) }
  const geos = [], inst = [], I = new THREE.Matrix4(), local = new Int32Array(nv).fill(-1), nPorCor = new Map();
  for (const [r, tris] of comp) {
    const usados = [], idx = new Uint32Array(tris.length * 3);
    tris.forEach((k, t) => { for (let j = 0; j < 3; j++) { const v = ix[k + j]; if (local[v] < 0) { local[v] = usados.length; usados.push(v) } idx[t * 3 + j] = local[v] } });
    const p = new Float32Array(usados.length * 3); usados.forEach((v, i) => { p[3 * i] = pos[3 * v]; p[3 * i + 1] = pos[3 * v + 1]; p[3 * i + 2] = pos[3 * v + 2]; local[v] = -1 });
    const c = (cor[3 * r] << 16) | (cor[3 * r + 1] << 8) | cor[3 * r + 2], hx = c.toString(16).padStart(6, '0'), n = (nPorCor.get(hx) || 0) + 1; nPorCor.set(hx, n);
    geos.push({ pos: p, idx });
    inst.push({ name: 'Peça ' + n + ' (cor #' + hx + ')', group: 'cor #' + hx, color: [(c >> 16) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255], gi: geos.length - 1, mat: I });
  }
  return { geos, inst };
}

// ---------- HTML já gerado (versões antigas) -> disciplinas ----------
const b64bytes = t => { const s = atob(t.replace(/\s+/g, '')), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u };
const abrir = u => { try { return gunzipSync(u) } catch (e) { try { return unzlibSync(u) } catch (e2) { return inflateSync(u) } } };
const buf = u => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
// JSON literal logo depois de `marca` num script (var P=[...], RES={...}); respeita colchete dentro de texto
function jsonDepois(t, marca) {
  let i = t.indexOf(marca); if (i < 0) return null; i += marca.length; while (/\s/.test(t[i])) i++;
  let dep = 0, str = false;
  for (let j = i; j < t.length; j++) { const c = t[j];
    if (str) { if (c === '\\') j++; else if (c === '"') str = false; continue }
    if (c === '"') str = true; else if (c === '[' || c === '{') dep++; else if ((c === ']' || c === '}') && --dep === 0) return JSON.parse(t.slice(i, j + 1)) }
  return null;
}
// formato "peças × instâncias por configuração" (berço CN-043, three r1xx embutido): var P=[{k,r,g,c,cc,mn,e,v,n,qL,tL,nmL,fL,...}]
// v = Int16 em base64, posição = (q+32767)·e + mn (mm), triângulos soltos; tK = 12 floats por instância (rotação coluna a
// coluna + translação), fK = 'C' na instância que só existe naquela configuração (cor cc). Cada configuração vira uma disciplina.
function lerPecasPorConfiguracao(t, titulo) {
  const P = jsonDepois(t, 'var P='), RES = jsonDepois(t, 'RES=') || {};
  const GRUPO = { pil: 'Pilares', vig: 'Vigas', par: 'Parafusos e arruelas' };
  const hex = h => { const c = parseInt(String(h).replace('#', ''), 16); return [(c >> 16) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255] };
  const nomes = x => Array.isArray(x) ? x : String(x || '').match(/'[^']*'/g)?.map(s => s.slice(1, -1)) || [];
  const cfgs = [...new Set(P.flatMap(p => Object.keys(p).filter(k => /^q[A-Z]$/.test(k) && p[k] > 0).map(k => k[1])))];
  return cfgs.map((k, ci) => {
    const geos = P.map(p => { const q = new Int16Array(buf(b64bytes(p.v))), pos = new Float32Array(q.length);
      for (let i = 0; i < q.length; i += 3) for (let j = 0; j < 3; j++) pos[i + j] = (q[i + j] + 32767) * p.e[j] + p.mn[j];
      return { pos, idx: null } });
    const inst = [];
    P.forEach((p, gi) => { const n = p['q' + k] || 0; if (!n) return;
      const tr = new Float32Array(buf(b64bytes(p['t' + k]))), nm = nomes(p['nm' + k]), so = p['f' + k] || '';
      for (let i = 0; i < n; i++) { const a = tr.subarray(i * 12, i * 12 + 12);
        inst.push({ name: nm[i] || p.r + ' ' + (i + 1), group: (GRUPO[p.g] || p.g || 'Peças') + '/' + p.r, color: hex(so[i] === 'C' && p.cc ? p.cc : p.c), gi,
          mat: new THREE.Matrix4().set(a[0], a[3], a[6], a[9], a[1], a[4], a[7], a[10], a[2], a[5], a[8], a[11], 0, 0, 0, 1) }) } });
    const r = RES[k] || {}, rot = (r.cfg || 'Configuração ' + k).toLowerCase().replace(/^berço\s*/, '').replace(/(^|\s)\S/g, c => c.toUpperCase()).replace('Loadout', 'Load out');
    return { label: rot, unit: 0.001, off: ci > 0, src: { geos, inst, nomeGeo: P.map(p => p.r), origem: r.tit || titulo } };
  });
}
// devolve [{label, src}] onde src = {geos, inst} ou {bloco}; unidade metro e Z para cima (como os HTMLs foram gerados)
export function lerHtml(texto, nome) {
  const doc = new DOMParser().parseFromString(texto, 'text/html'), base = nome.replace(/\.html?$/i, '');
  const titulo = (doc.querySelector('title')?.textContent || base).trim();
  const discs = [...doc.querySelectorAll('script.disc')];
  if (discs.length)   // formato do navio: os blocos já estão no formato final
    return discs.map(el => ({ label: el.dataset.label, src: { bloco: { key: el.dataset.k, label: el.dataset.label, n: +el.dataset.n, tri: +el.dataset.tri, b64: el.textContent.trim(), red: [], bruto: 0 } } }));
  const md = doc.getElementById('modeldata');
  if (md && md.textContent.trim().length > 50) {   // formato movelaria/HVAC/elétrica: um bloco, floats soltos (ou indexados)
    const bin = abrir(b64bytes(md.textContent)), dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength), hl = dv.getUint32(0, true);
    const H = JSON.parse(new TextDecoder().decode(bin.subarray(4, 4 + hl))), st = bin.byteOffset + ((4 + hl + 3) & ~3), buf = bin.buffer;
    const fl = (o, n) => new Float32Array(buf.slice(st + o * 4, st + (o + n) * 4));
    const geos = H.meshes.map(m => m.ni ? { pos: fl(m.off, m.vn), idx: new Uint32Array(buf.slice(st + (m.off + m.vn) * 4, st + (m.off + m.vn + m.ni) * 4)) } : { pos: fl(m.off, m.n), idx: null });
    const inst = H.instances.map(it => { const a = it.transform, s = a[12] || 1;
      return { name: it.name, group: it.group && it.group !== 'Montagem geral' ? it.group : '', color: H.meshes[it.mesh].color, gi: it.mesh, hidden: !!it.hidden,
        mat: new THREE.Matrix4().set(a[0] * s, a[3] * s, a[6] * s, a[9], a[1] * s, a[4] * s, a[7] * s, a[10], a[2] * s, a[5] * s, a[8] * s, a[11], 0, 0, 0, 1) } });
    return [{ label: (H.title || titulo).replace(/^.*?[•·-]\s*/, '') || base, src: { geos, inst, origem: H.source } }];
  }
  const ms = [...doc.querySelectorAll('script[id^="mesh"]')].filter(el => /^mesh\d+$/.test(el.id) && el.textContent.trim());
  if (ms.length)   // formato do Codex: uma malha por disciplina com cor por vértice; cada cor vira um grupo
    return ms.map(el => {
      const raw = abrir(b64bytes(el.textContent)), ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), dv = new DataView(ab);
      const nv = dv.getUint32(0, true), ni = dv.getUint32(4, true), nj = dv.getUint32(8, true), meta = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 16, nj)));
      let o = 16 + nj; const pos = new Float32Array(ab, o, nv * 3); o += nv * 12; const ix = new Uint32Array(ab, o, ni); o += ni * 4; const cor = new Uint8Array(ab, o, nv * 3);
      const { geos, inst } = pecasConexas(pos, ix, cor);
      return { label: (meta.discipline || el.id).replace(/_/g, ' '), src: { geos, inst, origem: 'HTML do Codex · ' + (meta.source_publication || '') } };
    });
  const pc = [...doc.querySelectorAll('script:not([src])')].map(el => el.textContent).find(t => /\bvar P=\[\{"k":/.test(t) && /\bqL"?:|"q[A-Z]":/.test(t));
  if (pc) return lerPecasPorConfiguracao(pc, titulo);
  throw Error(nome + ': HTML sem geometria reconhecida (formatos aceitos: navio por disciplina, movelaria/HVAC/elétrica, Codex, berço por configuração).');
}
