// Página do Visualizador 3D: lista dos modelos publicados, conversão no aparelho e publicação no GitHub Pages.
import { formato, ler, lerHtml, bloco, padrao, montarHtml } from './conversor.js';

const $ = s => document.querySelector(s), fmtN = n => n.toLocaleString('pt-BR'), MB = b => (b / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' MB';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// dono e repositório saem do endereço (dono.github.io/repositorio); fora do GitHub (teste local) usa o padrão
const REPO = (() => { const h = location.hostname.match(/^([^.]+)\.github\.io$/i), p = location.pathname.split('/').filter(Boolean)[0];
  return h && p ? { owner: h[1], repo: p } : { owner: 'otherjorge', repo: 'visualizador-3d' } })();
const SITE = new URL('.', location.href).href;
const TOKEN_KEY = 'vis3d_token';
const store = { get(k) { try { return localStorage.getItem(k) } catch (e) { return null } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch (e) { } } };

// ---------- offline (service worker) ----------
let sw = null;
const pendentes = new Map();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(r => { sw = r.active; renderLista() }).catch(() => { });
  navigator.serviceWorker.addEventListener('message', e => { const d = e.data || {}, url = d.guardado || d.apagado || d.falhou; const f = pendentes.get(url); if (f) { pendentes.delete(url); f(d) } });
}
const pedir = msg => new Promise(res => { const url = msg.guardar || msg.apagar; pendentes.set(url, res); (navigator.serviceWorker.controller || sw).postMessage(msg); setTimeout(() => pendentes.has(url) && (pendentes.delete(url), res({ falhou: url, erro: 'tempo esgotado' })), 300000) });
const emCache = async url => { try { return !!(await caches.match(url)) } catch (e) { return false } };
const net = () => { const n = $('#net'); n.textContent = navigator.onLine ? 'ONLINE' : 'SEM INTERNET · MODO OFFLINE'; n.classList.toggle('off', !navigator.onLine) };
addEventListener('online', net); addEventListener('offline', net); net();

// ---------- lista ----------
let modelos = [];
async function carregarLista() {
  try { const r = await fetch('models.json?t=' + Date.now(), { cache: 'no-store' }); modelos = r.ok ? await r.json() : [] }
  catch (e) { try { const r = await caches.match(new URL('models.json', SITE).href); modelos = r ? await r.json() : [] } catch (e2) { modelos = [] } }
  renderLista();
}
async function renderLista() {
  const box = $('#lista');
  if (!modelos.length) { box.innerHTML = '<p class="muted">Nenhum modelo publicado ainda. Converta um arquivo abaixo.</p>'; return }
  const ord = [...modelos].sort((a, b) => (b.data || '').localeCompare(a.data || ''));
  box.replaceChildren(...await Promise.all(ord.map(async m => {
    const url = new URL(m.arquivo, SITE).href, off = await emCache(url), c = document.createElement('div'); c.className = 'card';
    c.innerHTML = `<b>${esc(m.projeto)} <span class="muted" style="font-weight:400">/ ${esc(m.sub)}</span></b>
      <div class="meta">${esc((m.disciplinas || []).map(d => d.label).join(' · '))}<br>${fmtN(m.pecas || 0)} peças · ${MB(m.bytes || 0)} · ${esc(m.dataTexto || m.data || '')}${off ? '<br><span class="ok">✓ guardado neste aparelho (abre sem sinal)</span>' : ''}</div>
      <div class="row"><a class="btn" href="${esc(m.arquivo)}">Abrir</a><button data-a="qr">Link / QR</button><button data-a="off">${off ? 'Tirar do aparelho' : 'Guardar offline'}</button><button data-a="del" class="bad" title="Apagar do site">Apagar</button></div>`;
    c.querySelector('[data-a=qr]').onclick = () => mostrarQr(m.projeto + ' / ' + m.sub, url);
    const bo = c.querySelector('[data-a=off]');
    bo.onclick = async () => {
      if (!sw && !navigator.serviceWorker?.controller) return alert('Modo offline indisponível neste navegador.');
      bo.disabled = true; bo.textContent = off ? 'Tirando…' : 'Baixando ' + MB(m.bytes || 0) + '…';
      const r = await pedir(off ? { apagar: url } : { guardar: url });
      if (r.falhou) alert('Não deu para guardar: ' + (r.erro || 'sem internet?')); renderLista();
    };
    c.querySelector('[data-a=del]').onclick = () => apagarModelo(m);
    return c;
  })));
}
$('#reload').onclick = carregarLista;

// ---------- QR ----------
function mostrarQr(titulo, url) {
  $('#qrt').textContent = titulo; $('#qrl').textContent = url;
  try { const q = qrcode(0, 'M'); q.addData(url); q.make(); $('#qr').innerHTML = q.createSvgTag({ cellSize: 5, margin: 3, scalable: true }) } catch (e) { $('#qr').textContent = '' }
  $('#copy').onclick = async () => { try { await navigator.clipboard.writeText(url); $('#copy').textContent = 'Copiado ✓' } catch (e) { prompt('Copie o link:', url) } };
  $('#copy').textContent = 'Copiar link'; $('#dqr').showModal();
}
$('#closeqr').onclick = () => $('#dqr').close();

// ---------- chave do GitHub ----------
$('#reponame').textContent = REPO.owner + '/' + REPO.repo;
const temChave = () => !!store.get(TOKEN_KEY);
function estadoChave(msg) { $('#tokst').textContent = msg || (temChave() ? 'Chave configurada neste aparelho ✓' : 'Sem chave: dá para converter e baixar, mas não publicar.') }
$('#cfg').onclick = () => { $('#tok').value = ''; estadoChave(); $('#dcfg').showModal() };
$('#closecfg').onclick = () => $('#dcfg').close();
$('#deltok').onclick = () => { store.set(TOKEN_KEY, null); estadoChave() };
$('#savetok').onclick = async () => {
  const t = $('#tok').value.trim(); if (!t) return;
  estadoChave('Testando…');
  try { const r = await gh('/repos/' + REPO.owner + '/' + REPO.repo, {}, t); if (!r.permissions || !r.permissions.push) throw Error('a chave não tem permissão de escrita em ' + REPO.repo);
    store.set(TOKEN_KEY, t); $('#tok').value = ''; estadoChave('Chave salva e testada ✓') }
  catch (e) { estadoChave('Não funcionou: ' + e.message) }
};
async function gh(path, opt = {}, tok = store.get(TOKEN_KEY)) {
  if (!tok) throw Error('configure a chave em "Publicação"');
  const r = await fetch('https://api.github.com' + path, { ...opt, headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + tok, 'X-GitHub-Api-Version': '2022-11-28', ...(opt.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (!r.ok) throw Error('GitHub ' + r.status + ': ' + (await r.text()).slice(0, 180));
  return r.status === 204 ? null : r.json();
}
const b64 = u8 => { const o = []; for (let i = 0; i < u8.length; i += 49152) o.push(btoa(String.fromCharCode.apply(null, u8.subarray(i, i + 49152)))); return o.join('') };
// um commit só com vários arquivos (bytes = null apaga)
async function commit(arquivos, msg, prog) {
  const R = '/repos/' + REPO.owner + '/' + REPO.repo, ref = await gh(R + '/git/ref/heads/main'), pai = ref.object.sha, cm = await gh(R + '/git/commits/' + pai), tree = [];
  for (const a of arquivos) {
    if (a.bytes === null) { tree.push({ path: a.path, mode: '100644', type: 'blob', sha: null }); continue }
    prog && prog('Enviando ' + a.path + ' (' + MB(a.bytes.length) + ')…');
    const b = await gh(R + '/git/blobs', { method: 'POST', body: JSON.stringify({ content: b64(a.bytes), encoding: 'base64' }) });
    tree.push({ path: a.path, mode: '100644', type: 'blob', sha: b.sha });
  }
  const t = await gh(R + '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: cm.tree.sha, tree }) });
  const c = await gh(R + '/git/commits', { method: 'POST', body: JSON.stringify({ message: msg, tree: t.sha, parents: [pai] }) });
  await gh(R + '/git/refs/heads/main', { method: 'PATCH', body: JSON.stringify({ sha: c.sha }) });
}
async function listaAtual() {
  try { const r = await gh('/repos/' + REPO.owner + '/' + REPO.repo + '/contents/models.json?ref=main'); const s = atob(r.content.replace(/\s/g, ''));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(s, c => c.charCodeAt(0)))) }
  catch (e) { if (/ 404:/.test(e.message)) return []; throw e }
}
const json = v => new TextEncoder().encode(JSON.stringify(v, null, 1) + '\n');
// espera o GitHub Pages pôr no ar (lista com o carimbo novo)
async function esperarNoAr(carimbo, prog) {
  for (let i = 0; i < 90; i++) {
    prog('Publicado. Aguardando o site atualizar (' + (i * 5) + ' s)…');
    try { const l = await (await fetch('models.json?t=' + Date.now(), { cache: 'no-store' })).json(); if (carimbo === null ? true : l.some(m => m.data === carimbo)) { modelos = l; return true } } catch (e) { }
    await new Promise(r => setTimeout(r, 5000));
  }
  return false;
}
async function apagarModelo(m) {
  if (!temChave()) return $('#cfg').click();
  if (!confirm('Apagar "' + m.projeto + ' / ' + m.sub + '" do site? O link deixa de funcionar.')) return;
  try { const l = (await listaAtual()).filter(x => x.slug !== m.slug);
    await commit([{ path: m.arquivo, bytes: null }, { path: 'models.json', bytes: json(l) }], 'Apaga ' + m.slug);
    modelos = l; renderLista() } catch (e) { alert('Não apagou: ' + e.message) }
}

// ---------- conversão ----------
let arquivos = [], gerado = null;
const log = (t, cls) => { const p = document.createElement('div'); if (cls) p.className = cls; p.textContent = t; $('#log').append(p); $('#log').scrollTop = 1e9 };
const estado = t => { $('#estado').textContent = t };
function addArquivos(lista) {
  for (const f of lista) {
    const fmt = formato(f.name);
    if (!fmt) { log(f.name + ': formato não aceito.', 'err'); continue }
    if (arquivos.some(a => a.f.name === f.name && a.f.size === f.size)) { log(f.name + ': já está na lista.', 'warn'); continue }
    if (fmt === 'sw') { log(f.name + ': arquivo do SolidWorks não converte no navegador (precisa da licença). No PC: python publicar_pc.py "' + f.name + '" — ou exporte STEP no SolidWorks e solte o STEP aqui.', 'warn'); continue }
    arquivos.push({ f, fmt, label: f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ') });
  }
  renderArquivos();
}
function renderArquivos() {
  const box = $('#files'); box.replaceChildren();
  arquivos.forEach((a, i) => {
    const r = document.createElement('div'); r.className = 'file';
    r.innerHTML = `<div><div class="nm">${esc(a.f.name)}</div><div class="fmt">${a.fmt.toUpperCase()} · ${MB(a.f.size)}${a.fmt === 'html' ? ' · disciplinas do próprio HTML' : ''}</div></div>
      <input type="text" value="${esc(a.label)}" aria-label="Nome da disciplina" ${a.fmt === 'html' ? 'placeholder="(nomes do HTML)"' : ''}><button class="bad" aria-label="Tirar arquivo">✕</button>`;
    r.querySelector('input').oninput = e => { a.label = e.target.value };
    r.querySelector('button').onclick = () => { arquivos.splice(i, 1); renderArquivos() };
    box.append(r);
  });
  $('#go').disabled = !arquivos.length;
  if (!$('#projeto').value && arquivos.length) $('#projeto').value = (arquivos[0].label.split(/[\s_-]+/)[0] || 'MODELO').toUpperCase();
}
const drop = $('#drop');
drop.onclick = () => $('#pick').click(); drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') $('#pick').click() };
$('#pick').onchange = e => { addArquivos(e.target.files); e.target.value = '' };
drop.ondragover = e => { e.preventDefault(); drop.classList.add('on') }; drop.ondragleave = () => drop.classList.remove('on');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('on'); addArquivos(e.dataTransfer.files) };

const tick = () => new Promise(r => setTimeout(r, 30));
$('#go').onclick = async () => {
  $('#go').disabled = true; $('#result').classList.remove('on'); $('#log').replaceChildren(); gerado = null;
  const t0 = performance.now(), discs = [], qual = $('#qual').value, origens = [];
  try {
    const molde = await (await fetch('molde.html')).text();
    let k = 0;
    for (const a of arquivos) {
      estado('Lendo ' + a.f.name + '…'); log('Lendo ' + a.f.name + ' (' + MB(a.f.size) + ')…'); await tick();
      let fontes;
      if (a.fmt === 'html') { fontes = lerHtml(await a.f.text(), a.f.name).map(x => ({ ...x, unit: 1, up: 'Z' })); if (fontes.length === 1 && a.label) fontes[0].label = a.label }
      else { const src = await ler(a.f, a.fmt), p = padrao(a.fmt, src);
        fontes = [{ label: a.label || a.f.name, src, unit: $('#unid').value === 'auto' ? p.unit : +$('#unid').value, up: $('#eixo').value === 'auto' ? p.up : $('#eixo').value }] }
      for (const fo of fontes) {
        const d = await bloco({ src: fo.src, unit: fo.unit, up: fo.up, label: fo.label, key: 'd' + (k++), qual, arquivo: a.f.name }, estado);
        if (fo.src.bloco) log(`  ${d.label}: ${fmtN(d.n)} peças (bloco reaproveitado como está)`);
        else { const [x, y, z] = d.tam, s = { x, y, z };
          log(`  ${d.label}: ${fmtN(d.n)} peças · ${fmtN(d.tri)} triângulos · ${MB(d.b64.length)} · caixa ${s.x.toFixed(2)} × ${s.y.toFixed(2)} × ${s.z.toFixed(2)} m (comprimento × largura × altura)`);
          if (d.red.length) log(`  ${d.red.length} geometrias simplificadas por excesso de detalhe`, 'warn');
          if (Math.max(s.x, s.y, s.z) > 2000 || Math.max(s.x, s.y, s.z) < 0.01) log('  Tamanho estranho: confira a unidade do arquivo.', 'warn') }
        discs.push(d); origens.push(fo.src.origem || a.f.name); await tick();
      }
    }
    const usadas = new Set();   // chave de disciplina única (dois HTMLs do navio trazem as mesmas chaves)
    for (const d of discs) { let k = d.key, i = 2; while (usadas.has(k)) k = d.key + '_' + i++; usadas.add(k); d.key = k }
    estado('Montando o HTML…'); await tick();
    const meta = { titulo: ($('#projeto').value || 'Modelo') + ' • ' + ($('#sub').value || '3D'), projeto: $('#projeto').value || 'MODELO', sub: $('#sub').value || 'modelo 3D',
      origem: [...new Set(origens)].join(' + '), nota: 'Cores originais do arquivo. Convertido pelo Visualizador 3D.', gerado: new Date().toLocaleString('pt-BR') };
    const html = montarHtml(molde, discs, meta), bytes = new TextEncoder().encode(html);
    gerado = { html, bytes, meta, discs: discs.map(d => ({ label: d.label, n: d.n })), pecas: discs.reduce((s, d) => s + d.n, 0) };
    const seg = ((performance.now() - t0) / 1000).toFixed(0);
    $('#resumo').innerHTML = `<b>${esc(meta.projeto)} / ${esc(meta.sub)}</b> · ${discs.length} disciplina(s) · ${fmtN(gerado.pecas)} peças · <b>${MB(bytes.length)}</b> · ${seg} s` +
      (bytes.length > 95e6 ? '<br><span class="err">Passa de 95 MB: o GitHub não aceita. Use qualidade Leve ou separe as disciplinas.</span>' : bytes.length > 40e6 ? '<br><span class="warn">Arquivo grande: no iPhone pode demorar ou faltar memória. A qualidade Leve ajuda.</span>' : '');
    const old = $('#prev').src; $('#prev').src = URL.createObjectURL(new Blob([bytes], { type: 'text/html' })); if (old.startsWith('blob:')) URL.revokeObjectURL(old);
    $('#result').classList.add('on'); $('#pub').disabled = bytes.length > 95e6; $('#pubst').textContent = temChave() ? '' : 'Para publicar, configure a chave em "Publicação".';
    estado('Pronto. Confira a prévia.'); log('Pronto em ' + seg + ' s.', 'ok');
  } catch (e) { console.error(e); estado(''); log('Erro: ' + (e.message || e), 'err') }
  $('#go').disabled = !arquivos.length;
};
$('#baixar').onclick = () => { if (!gerado) return; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([gerado.bytes], { type: 'text/html' }));
  a.download = (gerado.meta.projeto + '_' + gerado.meta.sub).replace(/[^\w\-]+/g, '_').toUpperCase() + '_3D.html'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000) };
const slugDe = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'modelo';
$('#pub').onclick = async () => {
  if (!gerado) return; if (!temChave()) return $('#cfg').click();
  const st = t => { $('#pubst').textContent = t }, slug = slugDe(gerado.meta.projeto + '-' + gerado.meta.sub);
  $('#pub').disabled = true;
  try {
    st('Lendo a lista do site…'); const l = await listaAtual(), ja = l.find(m => m.slug === slug);
    if (ja && !confirm('Já existe "' + ja.projeto + ' / ' + ja.sub + '". Substituir? (o link continua o mesmo)')) { st(''); $('#pub').disabled = false; return }
    const agora = new Date(), carimbo = agora.toISOString(), item = { slug, projeto: gerado.meta.projeto, sub: gerado.meta.sub, arquivo: 'm/' + slug + '.html',
      disciplinas: gerado.discs, pecas: gerado.pecas, bytes: gerado.bytes.length, data: carimbo, dataTexto: agora.toLocaleString('pt-BR') };
    const nova = [...l.filter(m => m.slug !== slug), item];
    await commit([{ path: item.arquivo, bytes: gerado.bytes }, { path: 'models.json', bytes: json(nova) }], (ja ? 'Atualiza ' : 'Publica ') + slug, st);
    const ok = await esperarNoAr(carimbo, st), url = new URL(item.arquivo, SITE).href;
    st(ok ? 'No ar ✓' : 'Enviado; o site ainda está atualizando (tente em 1–2 min).'); renderLista(); mostrarQr(item.projeto + ' / ' + item.sub, url);
  } catch (e) { st('Erro: ' + e.message) }
  $('#pub').disabled = false;
};

carregarLista();
