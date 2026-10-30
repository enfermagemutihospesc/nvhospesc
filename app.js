// ════════════════════════════════════════════════════════════════════════════
// BUSCA ATIVA NSP / CCIH – Hospital dos Pescadores (Natal/RN)
// Sistema independente: GitHub Pages + Firebase próprio (Auth/Firestore)
// + Apps Script (Drive). Sem dados clínicos além do modelo de busca ativa.
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const CFG = window.NSP_CONFIG;

// ── ESTADO ──────────────────────────────────────────────────────────────────
let db = null, auth = null, modoLocal = false;
let usuarioEmail = '', perfil = null;
let dataRef = hojeISO();          // data da busca ativa exibida no painel
let setorAtivo = 'todos';
let mostrarVisitados = false;     // por padrão o painel esconde quem já foi visitado na semana

let LEITOS = {};                  // bedId → documento do leito (nsp_leitos)
let VISITAS = [];                 // visitas da SEMANA da dataRef (nsp_visitas)
let CENSO = null;                 // último censo importado (nsp_config/censo)

// ── ÍNDICE DE LEITOS (a partir do config.js) ────────────────────────────────
const BEDS = [];                  // lista ordenada
const BED = {};                   // bedId → { id, num, curto, setorId, setorNome, sigla, grupo, longo }
const SETOR = {};                 // setorId → setor do config

function construirIndices() {
  CFG.SETORES.forEach(s => {
    SETOR[s.id] = s;
    s.grupos.forEach(g => g.leitos.forEach(l => {
      const b = { id: l.id, num: l.num, curto: l.curto, setorId: s.id, setorNome: s.nome, sigla: s.sigla,
                  grupo: g.nome, longo: `${s.sigla} · ${g.nome} · ${l.curto}`,
                  notifLeito: g.notif ? g.notif + pad2(l.num) : `${s.sigla} ${g.nome} ${l.curto}`.toUpperCase(),
                  notifSetor: s.notifSetor || s.nome };
      BEDS.push(b); BED[b.id] = b;
    }));
  });
}

// ── HELPERS ─────────────────────────────────────────────────────────────────
function pad2(n) { return String(n).padStart(2, '0'); }
function isoDeData(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function hojeISO() { return isoDeData(new Date()); }
function agoraISO() { return new Date().toISOString(); }
function addDias(iso, n) { const [y, m, d] = iso.split('-').map(Number); return isoDeData(new Date(y, m - 1, d + n)); }
function fmtD(iso) { if (!iso) return '–'; const p = String(iso).slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso; }
function fmtDH(iso) { if (!iso) return '–'; const d = new Date(iso); return isNaN(d) ? iso : `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
// Dias desde uma data, contando o próprio dia como D1 (mesma conta do DI do censo)
function diasDesde(iso, ref) {
  if (!iso) return null;
  const a = new Date(iso + 'T00:00:00'), b = new Date((ref || hojeISO()) + 'T00:00:00');
  if (isNaN(a) || isNaN(b)) return null;
  const n = Math.round((b - a) / 86400000) + 1;
  return n > 0 ? n : null;
}
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// nv(): valor ou texto vazio (substitui o operador de coalescência, que celulares antigos não entendem)
function nv(v) { return v === null || v === undefined ? '' : v; }
function normTxt(s) {
  return String(nv(s)).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function gf(id) { const e = document.getElementById(id); return e ? e.value : ''; }
function sf(id, v) { const e = document.getElementById(id); if (e) e.value = nv(v); }
function gRadio(name) { const e = document.querySelector(`input[name="${name}"]:checked`); return e ? e.value : ''; }
function setRadio(name, val) {
  document.querySelectorAll(`input[name="${name}"]`).forEach(r => { r.checked = (val != null && r.value === val); });
}
function pct(x, n, casas = 0) { return n ? (100 * x / n).toFixed(casas).replace('.', ',') + '%' : '–'; }

function toast(msg, err = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), err ? 5000 : 3000);
}
function showLoading(msg) { document.getElementById('loading-msg').textContent = msg || 'Carregando...'; document.getElementById('loading-overlay').classList.add('show'); }
function hideLoading() { document.getElementById('loading-overlay').classList.remove('show'); }
function abrirModal(id) { document.getElementById(id).classList.add('show'); }
function fecharModal(id) { document.getElementById(id).classList.remove('show'); }

function _comTimeout(promessa, ms, msg) {
  return Promise.race([promessa, new Promise((_, rej) => setTimeout(() => rej(new Error(msg || 'timeout')), ms))]);
}

function msgErro(e) {
  const code = e && e.code;
  if (code === 'permission-denied') return 'Sem permissão no Firestore. Confira as regras (firestore.rules) e se seu usuário está ativo.';
  if (code === 'unavailable') return 'Servidor indisponível. Verifique a conexão.';
  return (e && (e.message || code)) || 'erro desconhecido';
}

// ── ARMAZENAMENTO (Firestore, com fallback "modo local" em localStorage) ─────
// Tudo fica numa coleção única (CFG.COLECAO, ex.: "busca_ativa_nsp").
// O tipo de registro vai como prefixo do ID do documento:
//   usuario__<email>   leito__<bedId>   visita__<data>_<internação>
//   mov__<id>          config__censo
// As listagens usam faixa de ID (FieldPath.documentId), sem precisar de índice.
// Gravações com persistência offline: se a rede cair, a escrita fica na fila
// do aparelho e sincroniza depois; a espera é limitada (10 s) e o retorno
// indica 'ok' ou 'pendente'.
const TIPOS = {
  usuarios_nsp: 'usuario', nsp_leitos: 'leito', nsp_visitas: 'visita',
  nsp_movimentos: 'mov', nsp_config: 'config'
};
function _docId(col, id) { return TIPOS[col] + '__' + id; }
function _ref(col, id) { return db.collection(CFG.COLECAO).doc(_docId(col, id)); }
function _faixa(col, de, ate) {
  const FP = firebase.firestore.FieldPath.documentId();
  return db.collection(CFG.COLECAO).where(FP, '>=', TIPOS[col] + '__' + de).where(FP, '<=', TIPOS[col] + '__' + ate + '\uf8ff');
}
function _semPrefixo(col, docId) { return docId.slice(TIPOS[col].length + 2); }
function _comTipo(col, data) { return { ...JSON.parse(JSON.stringify(data)), _tipo: TIPOS[col] }; }
function _semTipo(d) { if (d && typeof d === 'object') delete d._tipo; return d; }

const Store = {
  _k: col => 'nsp_local__' + col,
  _load(col) { try { return JSON.parse(localStorage.getItem(this._k(col)) || '{}'); } catch (e) { return {}; } },
  _save(col, obj) { try { localStorage.setItem(this._k(col), JSON.stringify(obj)); return true; } catch (e) { console.warn('localStorage:', e); return false; } },

  async get(col, id) {
    if (modoLocal) return this._load(col)[id] || null;
    try {
      const s = await _ref(col, id).get(_fonte());
      return s.exists ? _semTipo(s.data()) : null;
    } catch (e) {
      if (!navigator.onLine) return null;   // documento ainda não está no cache do aparelho
      throw e;
    }
  },
  async list(col) {
    if (modoLocal) return this._load(col);
    const snap = await _faixa(col, '', '').get(_fonte());
    const out = {}; snap.forEach(d => { out[_semPrefixo(col, d.id)] = _semTipo(d.data()); });
    return out;
  },
  // Faixa de datas: os IDs das visitas começam pela data (AAAA-MM-DD)
  async range(col, campo, de, ate) {
    if (modoLocal) return Object.values(this._load(col)).filter(x => x && x[campo] >= de && x[campo] <= ate);
    const snap = await _faixa(col, de, ate).get(_fonte());
    return snap.docs.map(d => _semTipo(d.data())).filter(x => x && x[campo] >= de && x[campo] <= ate);
  },
  async set(col, id, data) {
    const limpo = JSON.parse(JSON.stringify(data));
    if (modoLocal) {
      const all = this._load(col); all[id] = limpo;
      if (!this._save(col, all)) throw new Error('Armazenamento local cheio ou indisponível.');
      return 'ok';
    }
    return _escrever(_ref(col, id).set(_comTipo(col, limpo)));
  },
  async merge(col, id, data) {
    const limpo = JSON.parse(JSON.stringify(data));
    if (modoLocal) {
      const all = this._load(col); all[id] = { ...(all[id] || {}), ...limpo };
      if (!this._save(col, all)) throw new Error('Armazenamento local cheio ou indisponível.');
      return 'ok';
    }
    return _escrever(_ref(col, id).set(limpo, { merge: true }));
  },
  async add(col, data) { const id = (data.data || hojeISO()) + '_' + uid(); await this.set(col, id, { ...data, _id: id }); return id; },
  async del(col, id) {
    if (modoLocal) { const all = this._load(col); delete all[id]; this._save(col, all); return 'ok'; }
    return _escrever(_ref(col, id).delete());
  }
};
// Sem internet, a gravação já fica salva no aparelho (fila do Firestore) assim
// que é feita; não há o que esperar. Com internet, espera a confirmação do
// servidor por até 10 s.
function _fonte() { return navigator.onLine ? undefined : { source: 'cache' }; }
async function _escrever(promessa) {
  promessa.catch(e => console.warn('Firestore (gravação):', e));
  marcarSincPendente();
  if (!navigator.onLine) { await new Promise(r => setTimeout(r, 150)); return 'pendente'; }
  return Promise.race([
    promessa.then(() => 'ok'),
    new Promise(res => setTimeout(() => res('pendente'), 10000))
  ]);
}

// ── SINCRONIZAÇÃO (offline → online) ────────────────────────────────────────
// 1) Firestore: guarda as gravações no aparelho e envia sozinho ao reconectar.
//    waitForPendingWrites() avisa quando tudo chegou ao servidor.
// 2) Apps Script (planilhas): pedidos ficam numa fila no aparelho (OUTBOX) e são
//    reenviados ao reconectar, ao abrir o app e a cada 2 minutos.
let _sincPendente = false;
function marcarSincPendente() {
  if (modoLocal || !db || _sincPendente) return;
  _sincPendente = true;
  atualizarStatusConexao();
  db.waitForPendingWrites().then(() => {
    _sincPendente = false;
    atualizarStatusConexao();
    if (_avisarSinc) { _avisarSinc = false; toast('✓ Dados enviados ao servidor'); }
  }).catch(() => { _sincPendente = false; atualizarStatusConexao(); });
}
let _avisarSinc = false;

const OUTBOX_KEY = 'nsp_outbox';
function _outbox() { try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch (e) { return []; } }
function _salvarOutbox(lista) { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(lista)); } catch (e) { console.warn('outbox:', e); } }

// Coloca um envio para o Apps Script na fila e tenta enviar
function apsEnfileirar(payload) {
  if (!CFG.APPS_SCRIPT_URL || modoLocal) return;
  const lista = _outbox();
  lista.push({ id: uid(), payload, em: agoraISO() });
  _salvarOutbox(lista);
  atualizarStatusConexao();
  descarregarOutbox();
}

let _descarregando = false;
async function descarregarOutbox() {
  if (_descarregando || !navigator.onLine || !CFG.APPS_SCRIPT_URL || modoLocal) return;
  if (!auth || !auth.currentUser) return;
  _descarregando = true;
  try {
    for (const item of _outbox()) {
      try {
        const r = await apsFetch(item.payload);
        if (!r || r.status !== 'ok') { console.warn('Apps Script recusou:', r); if (r && /Sessão inválida/.test(r.msg || '')) break; }
        // enviado (ou recusado por erro de dados, que não adianta repetir): sai da fila
        _salvarOutbox(_outbox().filter(x => x.id !== item.id));
      } catch (e) { console.warn('Apps Script (fila):', e); break; }   // sem rede: tenta depois
    }
  } finally { _descarregando = false; atualizarStatusConexao(); }
}

async function aoFicarOnline() {
  atualizarStatusConexao();
  if (modoLocal) return;
  if (_sincPendente) _avisarSinc = true;
  await descarregarOutbox();
  await reenviarNotifsPendentes();
}

// Registro de movimentos (admissão, saída, transferência, bloqueio) — também
// enviado ao Apps Script, quando configurado.
async function registrarMovimento(mov) {
  const reg = { ...mov, por: usuarioEmail, porNome: perfil ? perfil.nome : '', em: agoraISO() };
  try { await Store.add('nsp_movimentos', reg); } catch (e) { console.warn('movimento:', e); }
  apsEnfileirar({ action: 'nsp_movimento', registro: { ...reg, leito: BED[reg.bedId] ? BED[reg.bedId].longo : reg.bedId } });
}

// ── APPS SCRIPT ─────────────────────────────────────────────────────────────
// Envia o ID Token do Firebase; o Code.gs confere o token antes de gravar/ler.
async function apsFetch(payload, fireAndForget = false) {
  if (!CFG.APPS_SCRIPT_URL || modoLocal) return null;
  let idToken = '';
  try { if (auth && auth.currentUser) idToken = await auth.currentUser.getIdToken(); } catch (_) {}
  const body = JSON.stringify({ ...payload, idToken });
  if (fireAndForget) {
    fetch(CFG.APPS_SCRIPT_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body })
      .catch(e => console.warn('Apps Script:', e));
    return null;
  }
  const resp = await fetch(CFG.APPS_SCRIPT_URL, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body });
  const txt = await resp.text();
  try { return JSON.parse(txt); } catch (e) { throw new Error('Resposta inválida do Apps Script: ' + txt.slice(0, 200)); }
}

// ── FIREBASE / LOGIN ────────────────────────────────────────────────────────
function firebaseConfigurado() {
  const f = CFG.FIREBASE || {};
  return !!(f.apiKey && f.projectId && !/COLE_AQUI|SEU-PROJETO/.test(f.apiKey + f.projectId));
}

function initFirebase() {
  try {
    if (typeof firebase === 'undefined') return false;
    if (!firebase.apps.length) firebase.initializeApp(CFG.FIREBASE);
    db = firebase.firestore();
    try { db.enablePersistence({ synchronizeTabs: true }).catch(e => console.warn('Persistência offline:', e && e.code)); } catch (_) {}
    auth = firebase.auth();
    return true;
  } catch (e) { console.error('Firebase:', e); return false; }
}

function _adminFixo(email) { return CFG.ADMIN_EMAILS.map(e => e.toLowerCase()).includes((email || '').toLowerCase()); }
function _isAdmin() { return modoLocal || _adminFixo(usuarioEmail) || !!(perfil && perfil.role === 'admin'); }

function _perfilCache(email, p) {
  const k = 'nsp_perfil__' + email;
  try { if (p) localStorage.setItem(k, JSON.stringify(p)); else return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; }
}

async function carregarPerfil(email) {
  try {
    const p = await _comTimeout(Store.get('usuarios_nsp', email), 8000);
    if (p) { _perfilCache(email, { email, ...p }); return { email, ...p }; }
    if (!navigator.onLine && _perfilCache(email)) return _perfilCache(email);
    if (_adminFixo(email)) {
      const novo = { nome: email.split('@')[0].toUpperCase(), funcao: 'NSP', role: 'admin', ativo: true, senhaTrocada: true, criadoEm: agoraISO() };
      Store.set('usuarios_nsp', email, novo).catch(e => console.warn('perfil admin:', e));
      return { email, ...novo };
    }
    return { email, ativo: false, semCadastro: true };
  } catch (e) {
    console.warn('Perfil:', e);
    const cache = _perfilCache(email);
    if (cache) return cache;
    if (_adminFixo(email)) return { email, nome: email.split('@')[0].toUpperCase(), role: 'admin', ativo: true, senhaTrocada: true };
    return { email, ativo: false, erroLeitura: true };
  }
}

async function fazerLogin() {
  const email = gf('li-email').trim().toLowerCase();
  const senha = gf('li-senha');
  const errEl = document.getElementById('login-err');
  const btn = document.getElementById('btn-entrar');
  errEl.textContent = '';
  if (!email || !senha) { errEl.textContent = 'Preencha e-mail e senha.'; return; }
  if (!auth) { errEl.textContent = 'Conexão com o servidor não iniciada. Recarregue a página.'; return; }
  btn.disabled = true; btn.textContent = 'Entrando...';
  try {
    // LOCAL: continua logado ao fechar o app, para poder abrir sem internet.
    try { await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch (_) {}
    await _comTimeout(auth.signInWithEmailAndPassword(email, senha), 15000, 'timeout_login');
  } catch (e) {
    const msgs = {
      'auth/user-not-found': 'Usuário não encontrado.', 'auth/wrong-password': 'Senha incorreta.',
      'auth/invalid-email': 'E-mail inválido.', 'auth/invalid-credential': 'E-mail ou senha incorretos.',
      'auth/too-many-requests': 'Muitas tentativas. Tente mais tarde.', 'auth/network-request-failed': 'Falha de conexão. Verifique a internet.'
    };
    errEl.textContent = e.message === 'timeout_login' ? 'O servidor demorou a responder. Tente de novo.' : (msgs[e.code] || 'Erro ao entrar: ' + (e.code || e.message));
  } finally {
    btn.disabled = false; btn.textContent = 'Entrar';
  }
}

async function aoMudarAuth(user) {
  if (!user) { perfil = null; usuarioEmail = ''; mostrarTela('t-login'); return; }
  usuarioEmail = (user.email || '').toLowerCase();
  showLoading('Verificando acesso...');
  perfil = await carregarPerfil(usuarioEmail);
  hideLoading();
  if (!perfil || perfil.ativo === false) {
    toast(perfil && perfil.semCadastro ? 'Este e-mail não tem acesso à busca ativa NSP/CCIH. Peça o cadastro ao NSP.'
        : perfil && perfil.erroLeitura ? 'Não foi possível verificar seu acesso. Confira a conexão e tente de novo.'
        : 'Seu acesso está desativado. Fale com o NSP.', true);
    await auth.signOut();
    return;
  }
  if (perfil.senhaTrocada === false) {
    document.getElementById('ts-sub').textContent = 'Primeiro acesso: defina uma senha pessoal para continuar.';
    document.getElementById('btn-cancelar-troca').style.display = 'none';
    mostrarTela('t-trocasenha');
    return;
  }
  irPainel();
}

function fazerLogout() {
  if (!confirm('Sair do sistema?')) return;
  if (modoLocal) { location.href = location.pathname; return; }
  if (_outbox().length || _sincPendente) {
    if (!confirm('Há dados ainda não enviados ao servidor. Se sair agora, eles só serão enviados quando você entrar de novo neste aparelho. Sair mesmo assim?')) return;
  }
  if (!navigator.onLine) { toast('Sem internet: para entrar de novo será preciso conexão. Saída cancelada.', true); return; }
  if (auth) auth.signOut();
}

function abrirTrocaSenha() {
  document.getElementById('ts-sub').textContent = 'Defina uma nova senha de acesso.';
  document.getElementById('btn-cancelar-troca').style.display = '';
  mostrarTela('t-trocasenha');
}

async function confirmarTrocaSenha() {
  const nova = gf('ts-nova'), conf = gf('ts-conf');
  const errEl = document.getElementById('ts-err'), btn = document.getElementById('btn-trocar-senha');
  errEl.textContent = '';
  if (!nova || nova.length < 6) { errEl.textContent = 'A senha deve ter ao menos 6 caracteres.'; return; }
  if (nova !== conf) { errEl.textContent = 'As senhas não coincidem.'; return; }
  btn.disabled = true; btn.textContent = 'Salvando...';
  try {
    const user = auth.currentUser;
    if (!user) throw new Error('Sessão expirada. Entre novamente.');
    await user.updatePassword(nova);
    await Store.merge('usuarios_nsp', usuarioEmail, { senhaTrocada: true }).catch(e => console.warn(e));
    if (perfil) perfil.senhaTrocada = true;
    sf('ts-nova', ''); sf('ts-conf', '');
    toast('✓ Senha alterada');
    irPainel();
  } catch (e) {
    errEl.textContent = e.code === 'auth/requires-recent-login' ? 'Por segurança, saia e entre novamente para trocar a senha.'
      : e.code === 'auth/weak-password' ? 'Senha muito fraca.' : (e.message || 'Erro ao trocar senha.');
  } finally { btn.disabled = false; btn.textContent = 'Salvar nova senha'; }
}

function usarModoLocal() {
  modoLocal = true;
  usuarioEmail = 'modo.local';
  perfil = { nome: 'MODO LOCAL (TESTE)', role: 'admin', ativo: true };
  irPainel();
}

// ── NAVEGAÇÃO ───────────────────────────────────────────────────────────────
function mostrarTela(id) {
  document.querySelectorAll('.tela').forEach(t => t.classList.remove('ativa'));
  const el = document.getElementById(id);
  if (el) el.classList.add('ativa');
  window.scrollTo(0, 0);
}

function irPainel() {
  mostrarTela('t-painel');
  atualizarCabecalhoUsuario();
  carregarPainel();
  if (navigator.onLine) descarregarOutbox();
  if (_outbox().length) atualizarStatusConexao();
}

function atualizarCabecalhoUsuario() {
  const nome = perfil && perfil.nome ? perfil.nome.split(/\s+/).slice(0, 2).join(' ') : usuarioEmail.split('@')[0];
  document.getElementById('badge-user').textContent = '👤 ' + nome + ' · Sair';
  document.getElementById('badge-local').style.display = modoLocal ? '' : 'none';
  document.querySelectorAll('.so-admin').forEach(el => { el.style.display = (_isAdmin() && !modoLocal) ? '' : 'none'; });
  document.querySelectorAll('.so-nuvem').forEach(el => { el.style.display = modoLocal ? 'none' : ''; });
  atualizarStatusConexao();
}

function atualizarStatusConexao() {
  const dot = document.getElementById('sync-dot'), txt = document.getElementById('sync-txt');
  if (!dot) return;
  const fila = modoLocal ? 0 : _outbox().length;
  const pend = _sincPendente || fila > 0;
  if (modoLocal) { dot.className = 'sync-dot err'; txt.textContent = 'modo local – os dados ficam só neste aparelho'; }
  else if (navigator.onLine) {
    dot.className = 'sync-dot ' + (pend ? 'pend' : 'ok');
    txt.textContent = pend ? `conectado – enviando dados guardados no aparelho${fila ? ` (${fila} para as planilhas)` : ''}...` : 'conectado – dados sincronizados';
  } else {
    dot.className = 'sync-dot err';
    txt.textContent = 'sem internet – pode continuar trabalhando; tudo fica no aparelho e é enviado quando a conexão voltar' + (pend ? ' · há dados aguardando envio' : '');
  }
  const bar = document.getElementById('barra-offline');
  if (bar) bar.style.display = (!modoLocal && !navigator.onLine) ? '' : 'none';
}

// ════════════════════════════════════════════════════════════════════════════
// PAINEL DE LEITOS
// ════════════════════════════════════════════════════════════════════════════
function leito(id) { return LEITOS[id] || { ocupado: false }; }

// ── Ciclo semanal: cada paciente internado recebe UMA busca ativa por semana ──
// Semana de segunda a domingo. A equipe divide os pacientes em
// CFG.VISITAS_POR_SEMANA dias de visita.
function semanaDe(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const desdeSeg = (dt.getDay() + 6) % 7;           // segunda = 0
  const ini = isoDeData(new Date(y, m - 1, d - desdeSeg));
  return { ini, fim: addDias(ini, 6) };
}
// Busca ativa do paciente deste leito na semana da dataRef (ou null)
function visitaDe(id) {
  const l = leito(id);
  if (!l.ocupado || !l.internacaoId) return null;
  const vs = VISITAS.filter(v => v.internacaoId === l.internacaoId);
  return vs.sort((a, b) => b.data.localeCompare(a.data))[0] || null;
}

function mudarDataRef(v) {
  if (!v) { sf('p-data', dataRef); return; }
  if (v > hojeISO()) { toast('Não é possível registrar busca ativa em data futura.', true); sf('p-data', dataRef); return; }
  dataRef = v;
  carregarPainel();
}

async function carregarPainel() {
  sf('p-data', dataRef);
  showLoading('Carregando leitos...');
  try {
    const sem = semanaDe(dataRef);
    const [leitos, visitas, censo] = await Promise.all([
      Store.list('nsp_leitos'),
      Store.range('nsp_visitas', 'data', sem.ini, sem.fim),
      Store.get('nsp_config', 'censo')
    ]);
    LEITOS = leitos || {}; VISITAS = visitas || []; CENSO = censo;
  } catch (e) {
    console.error(e);
    toast('Erro ao carregar o painel: ' + msgErro(e), true);
  } finally { hideLoading(); }
  preencherDatalistEnfermeiros();
  renderPainel();
  reenviarNotifsPendentes();
}

// Tenta reenviar notificações que ficaram pendentes (sem rede ou sem Apps Script)
let _reenviando = false;
async function reenviarNotifsPendentes() {
  if (_reenviando || !CFG.APPS_SCRIPT_URL || modoLocal || !navigator.onLine) return;
  const pend = VISITAS.filter(v => ((v.notif && v.notif.itens) || []).some(n => !n.enviada));
  if (!pend.length) return;
  _reenviando = true;
  let total = 0;
  for (const v of pend) total += (await enviarNotifsPendentes(v)).enviadas;
  _reenviando = false;
  if (total) { toast(`✓ ${total} notificação(ões) pendente(s) enviada(s) ao NSP`); renderPainel(); }
}

function contagem(setorId) {
  const lista = BEDS.filter(b => setorId === 'todos' || b.setorId === setorId);
  const ativos = lista.filter(b => !leito(b.id).bloqueado);
  const ocup = ativos.filter(b => leito(b.id).ocupado);
  return {
    total: lista.length, ativos: ativos.length, ocupados: ocup.length,
    bloqueados: lista.length - ativos.length,
    visitados: ocup.filter(b => visitaDe(b.id)).length,
    visitadosHoje: ocup.filter(b => { const v = visitaDe(b.id); return v && v.data === dataRef; }).length
  };
}

function renderPainel() {
  // Abas por setor
  const tabs = [{ id: 'todos', sigla: 'Todos' }, ...CFG.SETORES];
  document.getElementById('setor-tabs').innerHTML = tabs.map(s => {
    const c = contagem(s.id);
    return `<button class="setor-tab${setorAtivo === s.id ? ' ativa' : ''}" data-setor="${s.id}">
      ${esc(s.sigla)} <span class="setor-tab-n">${c.ocupados - c.visitados} pend.</span></button>`;
  }).join('');

  // Resumo
  const c = contagem(setorAtivo);
  const chips = [];
  chips.push(`<span class="rchip">🛏 <b>${c.ocupados}</b> ocupados de ${c.ativos} ativos · ${pct(c.ocupados, c.ativos)}</span>`);
  const sem = semanaDe(dataRef), pend = c.ocupados - c.visitados;
  const diasVisita = new Set(VISITAS.map(v => v.data)).size;
  const porVisita = Math.ceil(c.ocupados / (CFG.VISITAS_POR_SEMANA || 3));
  chips.push(`<span class="rchip ${pend === 0 && c.ocupados ? 'rchip-ok' : ''}">📅 Semana ${fmtD(sem.ini).slice(0, 5)} a ${fmtD(sem.fim).slice(0, 5)}: <b>${c.visitados}</b> de ${c.ocupados} pacientes visitados · <b>${pend}</b> pendente${pend === 1 ? '' : 's'}</span>`);
  chips.push(`<span class="rchip rchip-sutil">🩺 ${diasVisita} de ${CFG.VISITAS_POR_SEMANA || 3} visitas na semana · meta ≈ ${porVisita} pacientes por visita · ${c.visitadosHoje} hoje</span>`);
  if (_isAdmin() && c.bloqueados) chips.push(`<span class="rchip">🔒 ${c.bloqueados} bloqueados</span>`);
  if (CENSO && CENSO.importadoEm) chips.push(`<span class="rchip rchip-sutil">📥 Censo de ${fmtDH(CENSO.importadoEm)}</span>`);
  document.getElementById('resumo-chips').innerHTML = chips.join('');

  // Grade
  const setores = setorAtivo === 'todos' ? CFG.SETORES : [SETOR[setorAtivo]];
  let html = '';
  setores.forEach(s => {
    let htmlSetor = '';
    s.grupos.forEach(g => {
      const cards = g.leitos.filter(lc => {
        const l = leito(lc.id);
        if (l.bloqueado && !_isAdmin()) return false;
        if (!mostrarVisitados && l.ocupado && visitaDe(lc.id)) return false;
        return true;
      }).map(lc => cardLeito(lc.id));
      if (!cards.length) return;
      const ocup = g.leitos.filter(lc => leito(lc.id).ocupado).length;
      htmlSetor += `<div class="grupo-t">${esc(g.nome)} <span>${ocup}/${g.leitos.length} ocupados</span></div>
        <div class="leitos-grid">${cards.join('')}</div>`;
    });
    if (htmlSetor) html += (setorAtivo === 'todos' ? `<div class="setor-t">${esc(s.nome)}</div>` : '') + htmlSetor;
  });
  document.getElementById('painel-grid').innerHTML = html ||
    `<div class="ind-vazio">${c.ocupados && c.visitados === c.ocupados ? '✓ Todos os pacientes internados já foram visitados nesta semana.' : 'Nenhum leito para mostrar com os filtros atuais.'}</div>`;
}

function chipsDispositivos(disp) {
  const d = disp || {}, out = [];
  if (d.elim === 'SVD') out.push('SVD');
  if (d.cvc) out.push(d.cvcTipo ? d.cvcTipo.split(' ')[0] : 'CVC');
  if (d.avp) out.push('AVP');
  if (d.o2 === 'TOT') out.push('VM/TOT');
  else if (d.o2 && d.o2 !== 'AA') out.push(d.o2);
  return out;
}

function cardLeito(id) {
  const b = BED[id], l = leito(id), v = visitaDe(id);
  const cls = ['leito-card', l.bloqueado ? 'bloqueado' : l.ocupado ? 'ocupado' : 'vago', v ? 'visitado' : ''].join(' ');
  const cab = `<div class="leito-num"><span>${esc(b.curto)}</span>${v ? '<span title="Visitado nesta semana">✓</span>' : ''}</div>`;

  if (l.bloqueado) {
    return `<div class="${cls}" data-bed="${id}">${cab}
      <div class="leito-info"><div class="leito-vazio leito-vazio--bloqueado">🔒 Bloqueado${l.bloqueadoDesde ? ' desde ' + fmtD(l.bloqueadoDesde) : ''}</div>
      ${l.bloqueadoMotivo ? `<div class="leito-diag">${esc(l.bloqueadoMotivo)}</div>` : ''}</div>
      ${_isAdmin() ? `<button class="leito-bloqueio-btn leito-bloqueio-btn--liberar" data-acao="liberar">🔓 LIBERAR LEITO</button>` : ''}</div>`;
  }

  if (!l.ocupado) {
    const ce = CENSO && CENSO.leitos && CENSO.leitos[id];
    return `<div class="${cls}" data-bed="${id}" role="button" tabindex="0" aria-label="${esc(b.longo)} vago – admitir paciente">${cab}
      <div class="leito-info"><div class="leito-vazio">Vago · toque para admitir</div>
      ${ce && ce.presente ? `<div class="leito-censo">📥 No censo: ${esc(ce.pac)}</div>` : ''}</div>
      ${_isAdmin() ? `<button class="leito-bloqueio-btn leito-bloqueio-btn--bloquear" data-acao="bloquear">🔒 BLOQUEAR LEITO</button>` : ''}</div>`;
  }

  const di = diasDesde(l.adm, dataRef);
  const badges = [];
  chipsDispositivos(l.disp).forEach(t => badges.push(`<span class="lb lb-disp">${esc(t)}</span>`));
  if (l.isolamento && l.isolamento !== 'Não') badges.push(`<span class="lb lb-isol">🦠 ${esc(l.isolamento)}</span>`);
  if (l.alergia === 'Sim') badges.push(`<span class="lb lb-high">⚠ Alergia</span>`);
  if (v) {
    const nc = v.scores && v.scores.nsp ? v.scores.nsp.naoConformes : 0;
    badges.push(`<span class="lb lb-ok">✓ Visitado ${fmtD(v.data).slice(0, 5)}${v.parcial ? ' (parcial)' : ''}</span>`);
    const nts = (v.notif && v.notif.itens) || [];
    if (nts.length) badges.push(`<span class="lb ${nts.some(n => !n.enviada) ? 'lb-warn' : 'lb-isol'}">⚠ ${nts.length} notif.${nts.some(n => !n.enviada) ? ' ⏳' : ''}</span>`);
    if (nc) badges.push(`<span class="lb lb-high">${nc} NC NSP</span>`);
  } else badges.push(`<span class="lb lb-warn">Pendente na semana</span>`);

  return `<div class="${cls}" data-bed="${id}" role="button" tabindex="0" aria-label="${esc(b.longo)} – ${esc(l.pac)}">${cab}
    <div class="leito-info"><div class="leito-pac">${esc(l.pac) || '–'}</div>
      <div class="leito-diag">${di ? 'DI ' + di : ''}${l.procedencia ? ' · ' + esc(l.procedencia) : ''}</div></div>
    <div class="leito-badge-row">${badges.join('')}</div>
    <button class="leito-iras-btn${v ? ' leito-iras-btn--preenchido' : ''}" data-acao="visita">${v ? '✓ VISITADO EM ' + fmtD(v.data).slice(0, 5) : '🩺 BUSCA ATIVA'}</button>
    <div class="leito-acoes-row">
      <button class="leito-alta-btn" data-acao="saida">SAÍDA</button>
      <button class="leito-transf-btn" data-acao="transf">↔ TRANSFERIR</button>
    </div></div>`;
}

function aoClicarGrade(ev) {
  const card = ev.target.closest('.leito-card');
  if (!card) return;
  const id = card.dataset.bed;
  const btn = ev.target.closest('[data-acao]');
  if (btn) {
    ev.stopPropagation();
    const a = btn.dataset.acao;
    if (a === 'visita') abrirVisita(id);
    else if (a === 'saida') abrirSaida(id);
    else if (a === 'transf') abrirTransferencia(id);
    else if (a === 'bloquear') abrirBloqueio(id, 'bloquear');
    else if (a === 'liberar') abrirBloqueio(id, 'liberar');
    return;
  }
  const l = leito(id);
  if (l.bloqueado) return;
  if (l.ocupado) abrirVisita(id); else abrirAdmissao(id);
}

function preencherDatalistEnfermeiros() {
  const nomes = [...new Set(VISITAS.map(v => v.enfermeiro).filter(Boolean))].sort();
  document.getElementById('dl-enfermeiros').innerHTML = nomes.map(n => `<option value="${esc(n)}">`).join('');
}

// ════════════════════════════════════════════════════════════════════════════
// ADMISSÃO (pode vir preenchida pelo censo importado)
// ════════════════════════════════════════════════════════════════════════════
let admBedId = null, admDoCenso = false;

function abrirAdmissao(bedId) {
  const b = BED[bedId], l = leito(bedId);
  if (l.bloqueado) { toast('Leito bloqueado. Libere-o antes de admitir.', true); return; }
  admBedId = bedId; admDoCenso = false;
  const editando = !!l.ocupado;
  let src = editando ? l : null;
  const aviso = document.getElementById('adm-aviso-censo');
  aviso.style.display = 'none';
  if (!editando) {
    const ce = CENSO && CENSO.leitos && CENSO.leitos[bedId];
    if (ce && ce.presente) {
      src = { pac: ce.pac, adm: ce.adm, procedencia: ce.procedencia, hd: ce.hd, isolamento: ce.isolamento || 'Não', disp: { o2: ce.o2 } };
      admDoCenso = true;
      aviso.innerHTML = `📥 Dados trazidos do censo importado em <b>${fmtDH(CENSO.importadoEm)}</b>${ce.situacao ? ' (situação: ' + esc(ce.situacao) + ')' : ''}. Confira antes de admitir.`;
      aviso.style.display = '';
    }
  }
  document.getElementById('adm-titulo').textContent = (editando ? 'Editar admissão – ' : 'Admissão – ') + b.longo;
  sf('m-pac', src ? src.pac : '');
  sf('m-adm', src && src.adm ? src.adm : dataRef);
  sf('m-proc', src ? src.procedencia : '');
  sf('m-hd', src ? src.hd : '');
  sf('m-alergia', src && src.alergia ? src.alergia : '');
  sf('m-isol', src && src.isolamento ? src.isolamento : 'Não');
  sf('m-o2', src && src.disp && src.disp.o2 ? src.disp.o2 : '');
  document.getElementById('btn-salvar-adm').textContent = editando ? 'Salvar alterações' : 'Admitir';
  abrirModal('modal-adm');
  setTimeout(() => document.getElementById('m-pac').focus(), 50);
}

function novoDocLeito(bedId, dados, fonte) {
  return {
    ocupado: true, setor: BED[bedId].setorId,
    pac: dados.pac, adm: dados.adm, procedencia: dados.procedencia || '', hd: dados.hd || '',
    alergia: dados.alergia || '', isolamento: dados.isolamento || 'Não',
    disp: { o2: dados.o2 || '' },
    internacaoId: uid(), admEm: agoraISO(), admPor: usuarioEmail, fonte: fonte || 'manual',
    bloqueado: false, bloqueadoMotivo: '', bloqueadoDesde: '', bloqueadoPor: ''
  };
}

async function salvarAdmissao() {
  const pac = gf('m-pac').trim().toUpperCase(), adm = gf('m-adm');
  if (!pac) { toast('Informe o nome do paciente.', true); return; }
  if (!adm) { toast('Informe a data de admissão.', true); return; }
  if (adm > hojeISO()) { toast('A data de admissão não pode ser futura.', true); return; }
  const bedId = admBedId;
  const btn = document.getElementById('btn-salvar-adm');
  btn.disabled = true;
  try {
    const atual = (await Store.get('nsp_leitos', bedId)) || {};
    const editando = !!(LEITOS[bedId] && LEITOS[bedId].ocupado);
    if (!editando && atual.ocupado) { toast('Este leito acabou de ser ocupado por outro usuário. O painel foi atualizado.', true); fecharModal('modal-adm'); carregarPainel(); return; }
    if (editando && atual.internacaoId && LEITOS[bedId].internacaoId !== atual.internacaoId) { toast('O paciente deste leito mudou em outro aparelho. O painel foi atualizado.', true); fecharModal('modal-adm'); carregarPainel(); return; }
    const dados = { pac, adm, procedencia: gf('m-proc').trim().toUpperCase(), hd: gf('m-hd').trim().toUpperCase(),
                    alergia: gf('m-alergia'), isolamento: gf('m-isol') || 'Não', o2: gf('m-o2') };
    let doc;
    if (editando) {
      doc = { ...atual, pac: dados.pac, adm: dados.adm, procedencia: dados.procedencia, hd: dados.hd,
              alergia: dados.alergia, isolamento: dados.isolamento,
              disp: { ...(atual.disp || {}), o2: dados.o2 || (atual.disp || {}).o2 || '' },
              editadoEm: agoraISO(), editadoPor: usuarioEmail };
    } else {
      doc = novoDocLeito(bedId, dados, admDoCenso ? 'censo' : 'manual');
    }
    const r = await Store.set('nsp_leitos', bedId, doc);
    LEITOS[bedId] = doc;
    if (!editando) registrarMovimento({ tipo: 'admissao', bedId, setor: doc.setor, pac: doc.pac, data: doc.adm, internacaoId: doc.internacaoId, fonte: doc.fonte });
    fecharModal('modal-adm');
    toast(r === 'pendente' ? 'Salvo no aparelho – sincroniza quando a conexão voltar' : (editando ? '✓ Admissão atualizada' : '✓ Paciente admitido'));
    if (document.getElementById('t-visita').classList.contains('ativa') && visitaBedId === bedId) {
      renderIdentVisita();
      setRadio('v-alergia', doc.alergia); setRadio('v-isol', doc.isolamento);
      onMudaContexto();
    } else {
      renderPainel();
    }
  } catch (e) { toast('Erro ao salvar: ' + msgErro(e), true); }
  finally { btn.disabled = false; }
}

// ── SAÍDA ───────────────────────────────────────────────────────────────────
let saidaBedId = null;
function abrirSaida(bedId) {
  const l = leito(bedId);
  if (!l.ocupado) return;
  saidaBedId = bedId;
  document.getElementById('saida-titulo').textContent = 'Saída – ' + BED[bedId].longo;
  document.getElementById('saida-pac').textContent = l.pac;
  sf('s-tipo', 'Alta'); sf('s-data', dataRef); sf('s-obs', '');
  abrirModal('modal-saida');
}

function docLeitoVazio(l, extra) {
  return { ocupado: false, setor: l.setor || '', bloqueado: !!l.bloqueado, bloqueadoMotivo: l.bloqueadoMotivo || '',
           bloqueadoDesde: l.bloqueadoDesde || '', bloqueadoPor: l.bloqueadoPor || '', ...(extra || {}) };
}

async function darSaida(bedId, subtipo, data, obs) {
  const l = leito(bedId);
  const vazio = docLeitoVazio(l, { ultimaSaida: { pac: l.pac, tipo: subtipo, data, em: agoraISO() } });
  vazio.setor = BED[bedId].setorId;
  const r = await Store.set('nsp_leitos', bedId, vazio);
  LEITOS[bedId] = vazio;
  registrarMovimento({ tipo: 'saida', subtipo, bedId, setor: BED[bedId].setorId, pac: l.pac, internacaoId: l.internacaoId || '', data, obs: obs || '' });
  return r;
}

async function confirmarSaida() {
  const bedId = saidaBedId, l = leito(bedId);
  const tipo = gf('s-tipo'), data = gf('s-data') || dataRef;
  if (!confirm(`Registrar "${tipo}" de ${l.pac} e liberar ${BED[bedId].longo}?`)) return;
  try {
    showLoading('Registrando saída...');
    const r = await darSaida(bedId, tipo, data, gf('s-obs').trim());
    fecharModal('modal-saida');
    toast(r === 'pendente' ? 'Saída salva no aparelho – sincroniza depois' : '✓ Saída registrada, leito liberado');
    renderPainel();
  } catch (e) { toast('Erro: ' + msgErro(e), true); }
  finally { hideLoading(); }
}

// ── TRANSFERÊNCIA INTERNA ───────────────────────────────────────────────────
let transfBedId = null;
function abrirTransferencia(bedId) {
  const l = leito(bedId);
  if (!l.ocupado) return;
  transfBedId = bedId;
  document.getElementById('transf-pac').textContent = `${l.pac} · hoje em ${BED[bedId].longo}`;
  const sel = document.getElementById('t-destino');
  sel.innerHTML = '<option value="">– selecione um leito vago –</option>' + CFG.SETORES.map(s => {
    const vagos = BEDS.filter(b => b.setorId === s.id && b.id !== bedId && !leito(b.id).ocupado && !leito(b.id).bloqueado);
    return vagos.length ? `<optgroup label="${esc(s.nome)}">${vagos.map(b => `<option value="${b.id}">${esc(b.grupo)} · ${esc(b.curto)}</option>`).join('')}</optgroup>` : '';
  }).join('');
  abrirModal('modal-transf');
}

async function confirmarTransferencia() {
  const de = transfBedId, para = gf('t-destino');
  if (!para) { toast('Escolha o leito de destino.', true); return; }
  try {
    showLoading('Transferindo...');
    const destino = (await Store.get('nsp_leitos', para)) || {};
    if (destino.ocupado || destino.bloqueado) { toast('O leito de destino não está mais vago. Atualize o painel.', true); return; }
    const orig = leito(de);
    const novo = { ...orig, setor: BED[para].setorId, transferidoDe: de, transferidoEm: agoraISO(),
                   bloqueado: false, bloqueadoMotivo: '', bloqueadoDesde: '', bloqueadoPor: '' };
    delete novo.ultimaSaida;
    await Store.set('nsp_leitos', para, novo);
    const vazio = docLeitoVazio(orig, { ultimaSaida: { pac: orig.pac, tipo: 'Transferência interna → ' + BED[para].longo, data: dataRef, em: agoraISO() } });
    vazio.setor = BED[de].setorId;
    await Store.set('nsp_leitos', de, vazio);
    LEITOS[para] = novo; LEITOS[de] = vazio;
    registrarMovimento({ tipo: 'transferencia', bedId: para, de, para, setor: novo.setor, pac: orig.pac, internacaoId: orig.internacaoId || '', data: dataRef });
    fecharModal('modal-transf');
    toast('✓ Paciente transferido para ' + BED[para].longo);
    renderPainel();
  } catch (e) { toast('Erro: ' + msgErro(e), true); }
  finally { hideLoading(); }
}

// ── BLOQUEIO / LIBERAÇÃO (admin) ────────────────────────────────────────────
let blBedId = null, blModo = null;
function abrirBloqueio(bedId, modo) {
  if (!_isAdmin()) { toast('Acesso restrito ao administrador.', true); return; }
  const l = leito(bedId);
  if (modo === 'bloquear' && l.ocupado) { toast('Leito ocupado não pode ser bloqueado.', true); return; }
  blBedId = bedId; blModo = modo;
  const bloq = modo === 'bloquear';
  document.getElementById('bl-titulo').textContent = (bloq ? '🔒 Bloquear ' : '🔓 Liberar ') + BED[bedId].longo;
  document.getElementById('bl-motivo-wrap').style.display = bloq ? '' : 'none';
  document.getElementById('bl-confirmar').textContent = bloq ? 'Bloquear' : 'Liberar';
  sf('bl-motivo', ''); sf('bl-data', dataRef);
  abrirModal('modal-bloqueio');
}

async function confirmarBloqueio() {
  const bedId = blBedId, modo = blModo, data = gf('bl-data') || dataRef, motivo = gf('bl-motivo').trim().toUpperCase();
  try {
    showLoading(modo === 'bloquear' ? 'Bloqueando...' : 'Liberando...');
    const atual = (await Store.get('nsp_leitos', bedId)) || {};
    if (modo === 'bloquear' && atual.ocupado) { toast('O leito foi ocupado em outro aparelho.', true); return; }
    const doc = modo === 'bloquear'
      ? { ...docLeitoVazio(atual), setor: BED[bedId].setorId, bloqueado: true, bloqueadoMotivo: motivo, bloqueadoDesde: data, bloqueadoPor: usuarioEmail }
      : { ...atual, setor: BED[bedId].setorId, bloqueado: false, bloqueadoMotivo: '', bloqueadoDesde: '', bloqueadoPor: '' };
    await Store.set('nsp_leitos', bedId, doc);
    LEITOS[bedId] = doc;
    registrarMovimento({ tipo: modo, bedId, setor: BED[bedId].setorId, data, motivo });
    fecharModal('modal-bloqueio');
    toast(modo === 'bloquear' ? '✓ Leito bloqueado' : '✓ Leito liberado');
    renderPainel();
  } catch (e) { toast('Erro: ' + msgErro(e), true); }
  finally { hideLoading(); }
}

// ════════════════════════════════════════════════════════════════════════════
// AVALIAÇÃO (compartilhada entre formulário e indicadores)
// ════════════════════════════════════════════════════════════════════════════
function nspVisiveis(ctx) {
  return CFG.NSP_ITENS.filter(it => !it.se || ctx[it.se]);
}
// C / NC / NA → conforme | nao_conforme | na
function avaliarNSP(itens, respostas) {
  let conformes = 0, naoConformes = 0, na = 0, pendentes = 0;
  itens.forEach(it => {
    const r = respostas[it.id];
    if (r === 'C') conformes++; else if (r === 'NC') naoConformes++; else if (r === 'NA') na++; else pendentes++;
  });
  const avaliados = conformes + naoConformes;
  return { conformes, naoConformes, na, pendentes, avaliados, pct: avaliados ? Math.round(100 * conformes / avaliados) : null };
}

// ════════════════════════════════════════════════════════════════════════════
// VISITA (busca ativa do leito)
// ════════════════════════════════════════════════════════════════════════════
let visitaBedId = null, visitaExistente = null, visitaData = null, visitaSuja = false;
const VIS = { nsp: {} };

function abrirVisita(bedId) {
  const l = leito(bedId);
  if (!l.ocupado) { abrirAdmissao(bedId); return; }
  const v = visitaDe(bedId);
  // Paciente já visitado nesta semana: não abre visita nova, só a existente (consulta/correção)
  if (v && !confirm(`${l.pac} já recebeu a busca ativa desta semana (${fmtD(v.data)}, por ${v.autorNome || v.autor}).\n\nAbrir essa visita para consultar ou corrigir?`)) return;
  visitaBedId = bedId;
  visitaExistente = v;
  visitaData = v ? v.data : dataRef;
  const disp = v ? (v.disp || {}) : (l.disp || {});

  document.getElementById('v-titulo').textContent = 'Busca ativa – ' + BED[bedId].curto;
  document.getElementById('v-sub').textContent = `${BED[bedId].setorNome} · ${BED[bedId].grupo} · ${fmtD(visitaData)}${v ? ' · corrigindo a visita da semana' : ''}`;
  renderIdentVisita();

  sf('v-enf', v ? v.enfermeiro : '');
  setRadio('v-alergia', v ? v.alergia : l.alergia);
  setRadio('v-isol', v ? v.isolamento : (l.isolamento || ''));
  VIS.nsp = { ...((v && v.nsp) || {}) };

  setRadio('v-elim', disp.elim || '');
  sf('v-svd-data', disp.svdData); setRadio('v-svd-ck', disp.svdCk || '');
  setRadio('v-cvc', disp.cvc === true ? 'Sim' : disp.cvc === false ? 'Não' : '');
  sf('v-cvc-tipo', disp.cvcTipo); sf('v-cvc-data', disp.cvcData);
  setRadio('v-cvc-ck', disp.cvcCk || ''); sf('v-cvc-curativo', disp.cvcCurativo);
  setRadio('v-avp', disp.avp === true ? 'Sim' : disp.avp === false ? 'Não' : '');
  sf('v-avp-data', disp.avpData);
  setRadio('v-o2', disp.o2 || '');
  sf('v-va-data', disp.vaData); sf('v-filtro-data', disp.filtroData);

  NOTIFS = JSON.parse(JSON.stringify((v && v.notif && v.notif.itens) || []));
  renderNotifs();
  sf('v-obs', v ? v.obs : '');

  renderNSPItens();
  onMudaDisp(true);
  visitaSuja = false;
  mostrarTela('t-visita');
}

function renderIdentVisita() {
  const l = leito(visitaBedId), di = diasDesde(l.adm, visitaData);
  document.getElementById('v-ident').innerHTML = `
    <div><span class="ident-l">Paciente</span><span class="ident-v">${esc(l.pac)}</span></div>
    <div><span class="ident-l">Admissão</span><span class="ident-v">${fmtD(l.adm)}${di ? ' · DI ' + di : ''}</span></div>
    <div><span class="ident-l">Procedência</span><span class="ident-v">${esc(l.procedencia) || '–'}</span></div>
    <div><span class="ident-l">HD</span><span class="ident-v">${esc(l.hd) || '–'}</span></div>`;
}

function ctxVisita() {
  const isol = gRadio('v-isol');
  return { alergia: gRadio('v-alergia') === 'Sim', isolamento: !!isol && isol !== 'Não' };
}

function botoesResposta(opcoes, atual) {
  return opcoes.map(o => `<button type="button" class="iras-radio-btn ${o.cls}${atual === o.v ? ' ativo' : ''}" data-r="${o.v}" aria-pressed="${atual === o.v}">${o.t}</button>`).join('');
}

const OPC_CNC = [{ v: 'C', t: '✓ Conforme', cls: 'sim' }, { v: 'NC', t: '✗ Não conforme', cls: 'nao' }];
const OPC_NA = { v: 'NA', t: 'N/A', cls: 'na' };

function classeNSP(r) { return r === 'C' ? ' aderente' : r === 'NC' ? ' nao-aderente' : r === 'NA' ? ' item-na' : ''; }

function renderNSPItens() {
  const itens = nspVisiveis(ctxVisita());
  let html = '', grupo = '';
  itens.forEach(it => {
    if (it.grupo !== grupo) { grupo = it.grupo; html += `<div class="chk-grupo">${esc(grupo)}</div>`; }
    const r = VIS.nsp[it.id] || '';
    const opcoes = it.tipo === 'cnc_na' ? [...OPC_CNC, OPC_NA] : OPC_CNC;
    html += `<div class="iras-item${classeNSP(r)}" data-nsp="${it.id}">
      <div class="iras-item-texto">${esc(it.texto)}</div>
      <div class="iras-radios">${botoesResposta(opcoes, r)}${r === 'NC' ? `<button type="button" class="btn-mini btn-mini-nsp btn-notificar" data-notificar="${it.id}">⚠ Notificar</button>` : ''}</div></div>`;
  });
  document.getElementById('v-nsp-itens').innerHTML = html;
}

function onMudaContexto() {
  visitaSuja = true;
  renderNSPItens();
  atualizarScore();
}

function dispAtual() {
  const elim = gRadio('v-elim'), cvc = gRadio('v-cvc'), avp = gRadio('v-avp'), o2 = gRadio('v-o2');
  const via = o2 === 'TOT' || o2 === 'TQT';
  return {
    elim, svdData: elim === 'SVD' ? gf('v-svd-data') : '', svdCk: elim === 'SVD' ? gRadio('v-svd-ck') : '',
    cvc: cvc === 'Sim' ? true : cvc === 'Não' ? false : null,
    cvcTipo: cvc === 'Sim' ? gf('v-cvc-tipo') : '', cvcData: cvc === 'Sim' ? gf('v-cvc-data') : '',
    cvcCk: cvc === 'Sim' ? gRadio('v-cvc-ck') : '', cvcCurativo: cvc === 'Sim' ? gf('v-cvc-curativo') : '',
    avp: avp === 'Sim' ? true : avp === 'Não' ? false : null,
    avpData: avp === 'Sim' ? gf('v-avp-data') : '',
    o2, vaData: via ? gf('v-va-data') : '', filtroData: via ? gf('v-filtro-data') : ''
  };
}

function onMudaDisp(inicial) {
  if (!inicial) visitaSuja = true;
  const d = dispAtual();
  document.getElementById('wrap-svd').style.display = d.elim === 'SVD' ? '' : 'none';
  document.getElementById('wrap-cvc').style.display = d.cvc ? '' : 'none';
  document.getElementById('wrap-avp').style.display = d.avp ? '' : 'none';
  document.getElementById('wrap-va').style.display = (d.o2 === 'TOT' || d.o2 === 'TQT') ? '' : 'none';
  atualizarDias();
  atualizarScore();
}

function atualizarDias() {
  [['v-svd-data', 'd-svd'], ['v-cvc-data', 'd-cvc'], ['v-cvc-curativo', 'd-cvc-curativo'], ['v-avp-data', 'd-avp'], ['v-va-data', 'd-va'], ['v-filtro-data', 'd-filtro']].forEach(([inp, tag]) => {
    const n = diasDesde(gf(inp), visitaData);
    const el = document.getElementById(tag);
    el.textContent = n ? 'D' + n : '';
    el.title = n ? `${n}º dia (contando a data informada como D1)` : '';
  });
}

function aoClicarResposta(ev) {
  const btn = ev.target.closest('.iras-radio-btn');
  if (!btn || btn.disabled) return;
  const item = btn.closest('.iras-item');
  if (!item) return;
  ev.preventDefault();
  visitaSuja = true;
  const r = btn.dataset.r;
  item.querySelectorAll('.iras-radio-btn').forEach(x => { x.classList.remove('ativo'); x.setAttribute('aria-pressed', 'false'); });
  btn.classList.add('ativo'); btn.setAttribute('aria-pressed', 'true');
  item.classList.remove('aderente', 'nao-aderente', 'item-na');
  if (item.dataset.nsp) {
    VIS.nsp[item.dataset.nsp] = r;
    const c = classeNSP(r).trim(); if (c) item.classList.add(c);
    const radios = item.querySelector('.iras-radios'), bn = radios.querySelector('[data-notificar]');
    if (r === 'NC' && !bn) radios.insertAdjacentHTML('beforeend', `<button type="button" class="btn-mini btn-mini-nsp btn-notificar" data-notificar="${item.dataset.nsp}">⚠ Notificar</button>`);
    if (r !== 'NC' && bn) bn.remove();
  }
  atualizarScore();
}

// ── NOTIFICAÇÕES (uma linha por notificação na planilha do NSP) ─────────────
let NOTIFS = [];

function horaAgora() { const d = new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

function addNotif(categoria, descricao) {
  const b = BED[visitaBedId];
  NOTIFS.push({ id: uid(), categoria: categoria || '', outros: '', data: visitaData, hora: horaAgora(),
                descricao: descricao || '', dano: 'Desconhecido', danoDesc: '', obs: '', comPaciente: 'Sim',
                leito: b.notifLeito, setor: b.notifSetor, enviada: false });
  visitaSuja = true;
  renderNotifs();
  const cards = document.querySelectorAll('#v-notifs .notif-card');
  if (cards.length) cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderNotifs() {
  const cont = document.getElementById('v-notifs');
  if (!NOTIFS.length) { cont.innerHTML = '<div class="hint">Nenhuma notificação nesta visita.</div>'; return; }
  const opt = (lista, v) => lista.map(o => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('');
  const setores = [...new Set(CFG.SETORES.map(s => s.notifSetor).filter(Boolean))];
  cont.innerHTML = NOTIFS.map((n, i) => {
    const ro = n.enviada ? ' disabled' : '';
    return `<div class="notif-card${n.enviada ? ' enviada' : ''}" data-i="${i}">
      <div class="notif-cab"><b>Notificação ${i + 1}</b>
        <span class="notif-status">${n.enviada ? '✓ Enviada à planilha do NSP em ' + fmtDH(n.enviadaEm) : '⏳ Será enviada ao salvar'}</span>
        ${n.enviada ? '' : `<button type="button" class="btn-mini btn-mini-nsp" data-rm="${i}">Remover</button>`}</div>
      <div class="fl"><label>Relacionada a</label><select data-f="categoria"${ro}><option value="">– selecione –</option>${opt(CFG.NOTIF_CATEGORIAS, n.categoria)}</select></div>
      <div class="fl" ${n.categoria === 'Outros' ? '' : 'hidden'}><label>Descreva "Outros"</label><input type="text" data-f="outros" value="${esc(n.outros)}"${ro}></div>
      <div class="fl"><label>Setor</label><select data-f="setor"${ro}>${opt(setores.includes(n.setor) ? setores : [n.setor, ...setores], n.setor)}</select></div>
      <div class="dc">
        <div class="fl"><label>Data em que ocorreu</label><input type="date" data-f="data" value="${esc(n.data)}" max="${hojeISO()}"${ro}></div>
        <div class="fl"><label>Horário</label><input type="time" data-f="hora" value="${esc(n.hora)}"${ro}></div>
      </div>
      <div class="fl"><label>Leito</label><input type="text" data-f="leito" value="${esc(n.leito)}"${ro}></div>
      <div class="fl notif-desc"><label>Descreva o incidente/evento</label><textarea data-f="descricao" rows="3"${ro}>${esc(n.descricao)}</textarea></div>
      <div class="dc">
        <div class="fl"><label>Houve dano ao paciente?</label><select data-f="dano"${ro}>${opt(['Desconhecido', 'Não', 'Sim'], n.dano)}</select></div>
        <div class="fl"><label>Evento com paciente?</label><select data-f="comPaciente"${ro}>${opt(['Sim', 'Não'], n.comPaciente)}</select></div>
      </div>
      <div class="fl" ${n.dano === 'Sim' ? '' : 'hidden'}><label>Descreva o dano</label><input type="text" data-f="danoDesc" value="${esc(n.danoDesc)}"${ro}></div>
      <div class="fl"><label>Outras observações</label><input type="text" data-f="obs" value="${esc(n.obs)}"${ro}></div>
    </div>`;
  }).join('');
}

function aoEditarNotif(ev) {
  const el = ev.target, card = el.closest('.notif-card');
  if (!card || !el.dataset.f) return;
  const n = NOTIFS[+card.dataset.i];
  if (!n || n.enviada) return;
  n[el.dataset.f] = el.value;
  visitaSuja = true;
  if (ev.type === 'change' && (el.dataset.f === 'categoria' || el.dataset.f === 'dano')) renderNotifs();
}

function validarNotifs() {
  const erros = [];
  NOTIFS.forEach((n, i) => {
    if (n.enviada) return;
    if (!n.categoria) erros.push(`Notificação ${i + 1}: escolha a que está relacionada`);
    if (n.categoria === 'Outros' && !n.outros.trim()) erros.push(`Notificação ${i + 1}: descreva o "Outros"`);
    if (!n.descricao.trim()) erros.push(`Notificação ${i + 1}: descreva o incidente`);
    if (!n.data) erros.push(`Notificação ${i + 1}: informe a data`);
  });
  return erros;
}

// Linha no formato da planilha de respostas do formulário do NSP
function linhaNotif(n, v) {
  return {
    id: n.id, categoria: n.categoria, outros: n.categoria === 'Outros' ? n.outros.trim() : '',
    setor: n.setor, data: n.data, hora: n.hora || '', descricao: n.descricao.trim(),
    dano: n.dano, danoDesc: n.dano === 'Sim' ? n.danoDesc.trim() : '',
    obs: [n.obs.trim(), `Registrada na busca ativa NSP/CCIH por ${v.autorNome || v.autor}`].filter(Boolean).join(' · '),
    comPaciente: n.comPaciente, leito: n.leito + (n.comPaciente === 'Sim' && v.pac ? ' - ' + v.pac : '')
  };
}

// Envia à planilha as notificações ainda não enviadas de uma visita salva
async function enviarNotifsPendentes(v) {
  const pend = ((v.notif && v.notif.itens) || []).filter(n => !n.enviada);
  if (!pend.length || !CFG.APPS_SCRIPT_URL || modoLocal || !navigator.onLine) return { enviadas: 0, pendentes: pend.length };
  try {
    const r = await apsFetch({ action: 'nsp_notificacao', itens: pend.map(n => linhaNotif(n, v)) });
    if (!r || r.status !== 'ok') throw new Error((r && r.msg) || 'sem resposta');
    const ok = new Set(r.gravados || pend.map(n => n.id));
    const em = agoraISO();
    v.notif.itens.forEach(n => { if (ok.has(n.id)) { n.enviada = true; n.enviadaEm = em; } });
    await Store.set('nsp_visitas', v.id, v);
    return { enviadas: ok.size, pendentes: pend.length - ok.size };
  } catch (e) {
    console.warn('Notificações:', e);
    return { enviadas: 0, pendentes: pend.length, erro: msgErro(e) };
  }
}

function atualizarScore() {
  const nsp = avaliarNSP(nspVisiveis(ctxVisita()), VIS.nsp);
  const corNSP = nsp.pct === null ? '' : nsp.pct === 100 ? 'ok' : nsp.pct >= 80 ? 'medio' : 'ruim';
  document.getElementById('v-score').innerHTML = `
    <span class="score-chip ${corNSP}">NSP: ${nsp.conformes}/${nsp.avaliados} conformes${nsp.pct !== null ? ' (' + nsp.pct + '%)' : ''}${nsp.pendentes ? ` · ${nsp.pendentes} pendente${nsp.pendentes > 1 ? 's' : ''}` : ''}</span>`;
}

function voltarPainel() {
  if (visitaSuja && !confirm('Sair sem salvar a busca ativa deste leito?')) return;
  visitaSuja = false;
  mostrarTela('t-painel');
  renderPainel();
}

async function salvarVisita() {
  const bedId = visitaBedId, l = leito(bedId), b = BED[bedId];
  if (!l.ocupado) { toast('Este leito não tem paciente.', true); return; }
  const ctx = ctxVisita(), visiveis = nspVisiveis(ctx);
  const nsp = {}; visiveis.forEach(it => { if (VIS.nsp[it.id]) nsp[it.id] = VIS.nsp[it.id]; });
  const disp = dispAtual();
  const alergia = gRadio('v-alergia'), isolamento = gRadio('v-isol');
  const sc = avaliarNSP(visiveis, nsp);

  const faltando = [];
  if (!gf('v-enf').trim()) faltando.push('enfermeiro(a) do plantão');
  if (!alergia) faltando.push('alergia');
  if (!isolamento) faltando.push('isolamento');
  if (sc.pendentes) faltando.push(`${sc.pendentes} item(ns) de segurança`);
  if (!disp.elim) faltando.push('eliminação/SVD');
  if (disp.cvc === null) faltando.push('CVC');
  if (disp.avp === null) faltando.push('AVP');
  if (!disp.o2) faltando.push('O₂/VM');
  if (disp.elim === 'SVD' && !disp.svdCk) faltando.push('check-list de inserção da SVD');
  if (disp.cvc && !disp.cvcCk) faltando.push('check-list de inserção do CVC');
  const errosNotif = validarNotifs();
  if (errosNotif.length) { toast(errosNotif[0], true); document.getElementById('v-notifs').scrollIntoView({ behavior: 'smooth' }); return; }
  if (faltando.length && !confirm('Ainda falta preencher:\n• ' + faltando.join('\n• ') + '\n\nSalvar como visita PARCIAL?')) return;

  const id = visitaData + '_' + l.internacaoId;
  const doc = {
    id, data: visitaData, semana: semanaDe(visitaData).ini, bedId, setor: b.setorId, grupo: b.grupo, leito: b.longo,
    internacaoId: l.internacaoId, pac: l.pac, adm: l.adm, procedencia: l.procedencia || '', hd: l.hd || '',
    enfermeiro: gf('v-enf').trim().toUpperCase(), alergia, isolamento,
    nsp, disp,
    notif: { itens: JSON.parse(JSON.stringify(NOTIFS)) },
    obs: gf('v-obs').trim(),
    scores: { nsp: sc },
    parcial: faltando.length > 0,
    autor: usuarioEmail, autorNome: perfil ? perfil.nome : '',
    criadoEm: visitaExistente ? (visitaExistente.criadoEm || visitaExistente.salvoEm) : agoraISO(), salvoEm: agoraISO()
  };

  const btn = document.getElementById('btn-salvar-visita');
  btn.disabled = true;
  showLoading('Salvando busca ativa...');
  try {
    const r = await Store.set('nsp_visitas', id, doc);
    // Atualiza o leito (alergia, isolamento e dispositivos acompanham o paciente),
    // exceto quando a visita é de uma data anterior à última já registrada.
    const ult = l.ultimaVisita && l.ultimaVisita.data;
    if (!ult || visitaData >= ult) {
      const novoLeito = { ...l, alergia, isolamento, disp, ultimaVisita: { data: visitaData, pctNSP: sc.pct, nc: sc.naoConformes } };
      await Store.set('nsp_leitos', bedId, novoLeito);
      LEITOS[bedId] = novoLeito;
    }
    VISITAS = VISITAS.filter(v => v.id !== id).concat([doc]);
    apsEnfileirar({ action: 'nsp_visita', registro: linhaPlanilha(doc) });
    visitaSuja = false;
    let msgNotif = '';
    if (doc.notif.itens.some(n => !n.enviada)) {
      showLoading('Enviando notificações ao NSP...');
      const rn = await enviarNotifsPendentes(doc);
      VISITAS = VISITAS.filter(v => v.id !== id).concat([doc]);
      if (rn.enviadas) msgNotif += ` · ${rn.enviadas} notificação(ões) enviada(s) ao NSP`;
      if (rn.pendentes) msgNotif += ` · ${rn.pendentes} notificação(ões) pendente(s)` + (!CFG.APPS_SCRIPT_URL || modoLocal ? ' (Apps Script não configurado)' : !navigator.onLine ? ' (sem internet: vão sozinhas quando a conexão voltar)' : ' (falha no envio; nova tentativa automática)');
    }
    toast((r === 'pendente' ? 'Salvo no aparelho – sincroniza quando a conexão voltar' : '✓ Busca ativa salva') + msgNotif, /pendente/.test(msgNotif));
    preencherDatalistEnfermeiros();
    mostrarTela('t-painel');
    renderPainel();
  } catch (e) { toast('Erro ao salvar: ' + msgErro(e), true); }
  finally { hideLoading(); btn.disabled = false; }
}

// Linha "achatada" para planilha (Apps Script) e CSV
function linhaPlanilha(v) {
  const d = v.disp || {};
  const s = (v.scores && v.scores.nsp) || {};
  const nomeSetor = SETOR[v.setor] ? SETOR[v.setor].nome : v.setor;
  const L = {
    id: v.id, data: fmtD(v.data), setor: nomeSetor, leito: v.leito, paciente: v.pac, admissao: fmtD(v.adm),
    di: diasDesde(v.adm, v.data) || '', procedencia: v.procedencia, hd: v.hd, enfermeiro_plantao: v.enfermeiro,
    alergia: v.alergia, isolamento: v.isolamento
  };
  CFG.NSP_ITENS.forEach(it => { L['nsp_' + it.id] = ({ C: 'Conforme', NC: 'Não conforme', NA: 'N/A' })[v.nsp && v.nsp[it.id]] || ''; });
  Object.assign(L, {
    nsp_conformes: nv(s.conformes), nsp_nao_conformes: nv(s.naoConformes), nsp_conformidade_pct: nv(s.pct),
    eliminacao: d.elim || '', svd_instalacao: fmtD(d.svdData), svd_dias: diasDesde(d.svdData, v.data) || '', svd_checklist: d.svdCk || '',
    cvc: d.cvc === true ? 'Sim' : d.cvc === false ? 'Não' : '', cvc_tipo: d.cvcTipo || '', cvc_instalacao: fmtD(d.cvcData), cvc_dias: diasDesde(d.cvcData, v.data) || '',
    cvc_checklist: d.cvcCk || '', cvc_curativo: fmtD(d.cvcCurativo),
    avp: d.avp === true ? 'Sim' : d.avp === false ? 'Não' : '', avp_puncao: fmtD(d.avpData), avp_dias: diasDesde(d.avpData, v.data) || '',
    o2_vm: d.o2 || '', via_aerea_instalacao: fmtD(d.vaData), via_aerea_dias: diasDesde(d.vaData, v.data) || '', filtro_data: fmtD(d.filtroData)
  });
  Object.assign(L, {
    notificacoes_qtd: ((v.notif && v.notif.itens) || []).length,
    notificacoes: ((v.notif && v.notif.itens) || []).map(n => n.categoria + (n.categoria === 'Outros' && n.outros ? ' (' + n.outros + ')' : '')).join(' | '),
    observacoes: v.obs || '',
    semana: 'Semana de ' + fmtD(semanaDe(v.data).ini), visita_parcial: v.parcial ? 'Sim' : 'Não',
    visitador: v.autorNome || v.autor, salvo_em: fmtDH(v.salvoEm)
  });
  return L;
}

// ════════════════════════════════════════════════════════════════════════════
// CENSO DO NIR (arquivo .xlsx ou planilha do Drive via Apps Script)
// ════════════════════════════════════════════════════════════════════════════
let censoLido = null, censoAcoes = [];

function abrirImportarCenso() {
  const drive = CFG.APPS_SCRIPT_URL && !modoLocal;
  document.getElementById('censo-corpo').innerHTML = `
    <p>Os leitos vagos no app são admitidos com <b>nome, data de admissão, procedência, HD e suporte de O₂</b> do censo. Idade, sexo, CNS, CPF e demais dados não são importados.</p>
    <div class="censo-opcoes">
      <label class="btn btn-pri censo-arquivo-btn">📄 Escolher arquivo do censo (.xlsx)
        <input type="file" id="censo-arquivo" accept=".xlsx,.xls,.ods" onchange="lerCensoArquivo(this.files[0])" hidden>
      </label>
      ${drive ? `<button class="btn btn-ok" onclick="lerCensoDrive()">☁ Importar direto do Drive</button>` : `<span class="hint">Importação direta do Drive: disponível depois de configurar o Apps Script.</span>`}
    </div>
    ${CENSO && CENSO.importadoEm ? `<p class="hint">Último censo importado: ${fmtDH(CENSO.importadoEm)} (${esc(CENSO.fonte || '')}).</p>` : ''}`;
  abrirModal('modal-censo');
}

function _carregarSheetJS() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = res;
    s.onerror = () => rej(new Error('Não foi possível carregar o leitor de planilhas. Verifique a internet.'));
    document.head.appendChild(s);
  });
}

async function lerCensoArquivo(file) {
  if (!file) return;
  showLoading('Lendo o censo...');
  try {
    await _carregarSheetJS();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const aba = wb.SheetNames.find(n => normTxt(n) === 'CENSO') || wb.SheetNames[0];
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, raw: true, defval: null, blankrows: true });
    await processarCenso(parseCenso(linhas, 'arquivo ' + file.name));
  } catch (e) { console.error(e); toast('Erro ao ler o censo: ' + msgErro(e), true); }
  finally { hideLoading(); }
}

async function lerCensoDrive() {
  if (!navigator.onLine) { toast('Sem internet. Use o arquivo .xlsx ou tente quando a conexão voltar.', true); return; }
  showLoading('Buscando o censo no Drive...');
  try {
    const r = await apsFetch({ action: 'nsp_censo' });
    if (!r || r.status !== 'ok') throw new Error((r && r.msg) || 'Apps Script não retornou o censo.');
    await processarCenso(parseCenso(r.linhas, 'Drive' + (r.nome ? ' – ' + r.nome : '')));
  } catch (e) { toast('Erro: ' + msgErro(e), true); }
  finally { hideLoading(); }
}

function dataDoCenso(v) {
  if (v === null || v === undefined || v === '') return '';
  let iso = '';
  if (typeof v === 'number') {
    if (v < 30000 || v > 80000) return '';
    const d = new Date(Math.round((v - 25569) * 86400000));
    iso = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  } else if (v instanceof Date) {
    iso = isoDeData(v);
  } else {
    const s = String(v).trim();
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; iso = `${y}-${pad2(m[2])}-${pad2(m[1])}`; }
    else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) iso = `${m[1]}-${m[2]}-${m[3]}`;
  }
  const ano = +iso.slice(0, 4);
  return ano >= 2000 && ano <= 2100 ? iso : '';
}

function o2DoCenso(v) {
  const s = normTxt(v);
  if (!s) return '';
  if (s.startsWith('IOT') || s.startsWith('TOT')) return 'TOT';
  if (s.startsWith('TQT')) return 'TQT';
  for (const k of ['MNR', 'CN', 'MV', 'AA']) if (s === k || s.startsWith(k + ' ') || s.startsWith(k + '/')) return k;
  return '';
}

// Rótulo da seção (coluna B do censo) + número do leito → id do leito no app,
// usando o campo "censo" de cada grupo do config.js
function bedIdDoCenso(secao, num) {
  const s = normTxt(secao);
  if (!s) return null;
  // Chave mais específica que aparece no rótulo (ex.: "SUTURA (ISO)" vence "SUTURA");
  // entre grupos com a mesma chave (várias "ENFERMARIA"), vale o que contém o leito.
  const grupos = [];
  CFG.SETORES.forEach(st => st.grupos.forEach(g => { const k = normTxt(g.censo); if (k && s.includes(k)) grupos.push({ k, g }); }));
  if (!grupos.length) return null;
  const maior = Math.max(...grupos.map(x => x.k.length));
  for (const { k, g } of grupos) {
    if (k.length !== maior) continue;
    const l = g.leitos.find(x => x.num === num);
    if (l) return l.id;
  }
  return null;
}

function parseCenso(linhas, fonte) {
  if (!Array.isArray(linhas) || !linhas.length) throw new Error('A aba do censo está vazia.');
  let h = -1;
  for (let i = 0; i < Math.min(linhas.length, 40); i++) {
    const r = (linhas[i] || []).map(normTxt);
    if (r.includes('LEITO') && r.some(c => c.startsWith('SITUACAO'))) { h = i; break; }
  }
  if (h < 0) throw new Error('Não encontrei o cabeçalho "LEITO / SITUAÇÃO" na aba CENSO.');
  const H = linhas[h].map(normTxt);
  const col = f => H.findIndex(f);
  const cLeito = col(x => x === 'LEITO'), cSit = col(x => x.startsWith('SITUACAO')), cNome = col(x => x.includes('NOME')),
        cDiag = col(x => x.startsWith('DIAGNOSTICO')), cOrig = col(x => x.startsWith('ORIGEM')),
        cO2 = col(x => x.includes('RESPIRATORIA ATUAL')), cAdm = col(x => x.startsWith('DATA ADMISS'));
  const cSec = cLeito - 1;
  const leitos = {}, naoMapeados = [];
  let secao = '';
  const txt = (r, c) => (c >= 0 && r[c] !== null && r[c] !== undefined) ? String(r[c]).trim() : '';
  for (let i = h + 1; i < linhas.length; i++) {
    const r = linhas[i] || [];
    if (r.some(c => normTxt(c).includes('TABELA DO CENSO'))) break;
    if (cSec >= 0 && txt(r, cSec)) secao = txt(r, cSec);
    const lv = txt(r, cLeito);
    const num = parseInt(lv, 10);
    if (!lv || isNaN(num)) continue;
    const bedId = bedIdDoCenso(secao, num);
    if (!bedId) { if (!normTxt(secao).startsWith('UTI')) naoMapeados.push(`${secao.trim()} ${lv}`); continue; }
    const sit = normTxt(txt(r, cSit));
    const nome = txt(r, cNome);
    const bloqueado = sit.startsWith('BLOQUEAD');
    const presente = !!nome && /[A-Za-zÀ-ú]{2}/.test(nome) &&
      !['LIVRE', 'BLOQUEAD', 'EM REGULACAO', 'ALTA', 'OBITO'].some(x => sit.startsWith(x));
    // O NIR às vezes anota o isolamento junto ao nome (ex.: "FULANA ISO-CONTATO")
    let pac = presente ? nome.toUpperCase().replace(/\s+/g, ' ') : '', isolamento = '';
    const mi = pac.match(/\s*[-–(]*\s*ISO(?:LAMENTO)?\s*[-–:]?\s*(CONTATO|RESPIRAT\S*|GOT[IÍ]CULA\S*|AEROSS\S*|VIGIL\S*)\)?\s*$/);
    if (mi) { pac = pac.slice(0, mi.index).trim(); isolamento = /^VIGIL/.test(mi[1]) ? 'Vigilância' : /^CONTATO/.test(mi[1]) ? 'Contato' : 'Respiratório'; }
    leitos[bedId] = {
      situacao: txt(r, cSit), presente, bloqueado, motivo: bloqueado ? nome.toUpperCase() : '',
      pac, isolamento,
      adm: presente ? dataDoCenso(cAdm >= 0 ? r[cAdm] : '') : '',
      procedencia: presente ? txt(r, cOrig).toUpperCase() : '',
      hd: presente ? txt(r, cDiag).toUpperCase() : '',
      o2: presente ? o2DoCenso(txt(r, cO2)) : '', o2Censo: presente ? txt(r, cO2) : ''
    };
  }
  if (!Object.keys(leitos).length) throw new Error('Nenhum leito do PS/CM foi reconhecido no censo.');
  return { fonte, importadoEm: agoraISO(), importadoPor: usuarioEmail, leitos, naoMapeados: [...new Set(naoMapeados)] };
}

function _mesmoNome(a, b) { return normTxt(a) === normTxt(b); }

async function processarCenso(c) {
  censoLido = c;
  try { await Store.set('nsp_config', 'censo', c); CENSO = c; } catch (e) { console.warn('snapshot censo:', e); }
  censoAcoes = [];
  BEDS.forEach(b => {
    const ce = c.leitos[b.id], l = leito(b.id);
    if (!ce) return;
    if (ce.presente) {
      if (!l.ocupado) censoAcoes.push({ tipo: 'admitir', bedId: b.id, ce, marcado: true, obs: l.bloqueado ? 'leito estava bloqueado no app' : '' });
      else if (!_mesmoNome(l.pac, ce.pac)) censoAcoes.push({ tipo: 'substituir', bedId: b.id, ce, atual: l.pac, marcado: false });
    } else {
      if (l.ocupado) censoAcoes.push({ tipo: 'saida', bedId: b.id, ce, atual: l.pac, marcado: false });
      if (ce.bloqueado && !l.bloqueado) censoAcoes.push({ tipo: 'bloquear', bedId: b.id, ce, marcado: !l.ocupado });
      if (!ce.bloqueado && l.bloqueado && !l.ocupado) censoAcoes.push({ tipo: 'liberar', bedId: b.id, ce, marcado: true });
    }
  });
  renderPreviaCenso();
}

function renderPreviaCenso() {
  const c = censoLido;
  const vals = Object.values(c.leitos);
  const resumo = `<div class="censo-resumo">
    <span class="rchip"><b>${vals.length}</b> leitos reconhecidos</span>
    <span class="rchip"><b>${vals.filter(x => x.presente).length}</b> com paciente</span>
    <span class="rchip"><b>${vals.filter(x => x.bloqueado).length}</b> bloqueados</span>
    <span class="rchip rchip-sutil">${esc(c.fonte)}</span></div>`;
  const grupos = [
    ['admitir', 'Admitir (vago no app, paciente no censo)'],
    ['substituir', 'Paciente diferente do app (marque para dar saída ao do app e admitir o do censo)'],
    ['saida', 'Ocupado no app, sem paciente no censo (marque para registrar saída)'],
    ['bloquear', 'Bloquear (bloqueado no censo)'],
    ['liberar', 'Liberar (bloqueado no app, não no censo)']
  ];
  let corpo = '';
  grupos.forEach(([tipo, titulo]) => {
    const itens = censoAcoes.map((a, i) => ({ a, i })).filter(x => x.a.tipo === tipo);
    if (!itens.length) return;
    corpo += `<div class="censo-grupo"><div class="censo-grupo-t">${titulo} <span>${itens.length}</span></div>` +
      itens.map(({ a, i }) => {
        const ce = a.ce, det = [];
        if (ce.adm) det.push('adm ' + fmtD(ce.adm));
        if (ce.procedencia) det.push(esc(ce.procedencia));
        if (ce.o2Censo) det.push(esc(ce.o2Censo));
        if (ce.isolamento) det.push('isolamento: ' + esc(ce.isolamento));
        let txt = '';
        if (tipo === 'admitir') txt = `<b>${esc(ce.pac)}</b> <small>${det.join(' · ')}${a.obs ? ' · ' + esc(a.obs) : ''}</small>`;
        else if (tipo === 'substituir') txt = `App: ${esc(a.atual)} → Censo: <b>${esc(ce.pac)}</b>`;
        else if (tipo === 'saida') txt = `${esc(a.atual)} <small>(censo: ${esc(ce.situacao || 'sem paciente')})</small>`;
        else if (tipo === 'bloquear') txt = `${esc(ce.motivo || 'sem motivo')}${leito(a.bedId).ocupado ? ' <small>(ocupado no app: só bloqueia se a saída também for registrada)</small>' : ''}`;
        else txt = 'livre no censo';
        return `<label class="censo-acao"><input type="checkbox" data-i="${i}"${a.marcado ? ' checked' : ''}>
          <span class="censo-leito">${esc(BED[a.bedId].longo)}</span><span class="censo-txt">${txt}</span></label>`;
      }).join('') + `</div>`;
  });
  if (!corpo) corpo = `<div class="ind-vazio">O painel já está igual ao censo. Nada a alterar.</div>`;
  const nm = c.naoMapeados.length ? `<p class="hint">Linhas do censo não reconhecidas (ignoradas): ${c.naoMapeados.map(esc).join(', ')}.</p>` : '';
  document.getElementById('censo-corpo').innerHTML = resumo + corpo + nm + `
    <div class="btn-row">
      <button class="btn btn-sec" onclick="fecharModal('modal-censo');renderPainel();">Fechar</button>
      ${censoAcoes.length ? `<button class="btn btn-ok" onclick="aplicarCenso()">Aplicar selecionados</button>` : ''}
    </div>`;
  document.querySelectorAll('#censo-corpo .censo-acao input').forEach(cb => {
    cb.addEventListener('change', () => { censoAcoes[+cb.dataset.i].marcado = cb.checked; });
  });
}

async function aplicarCenso() {
  const sel = censoAcoes.filter(a => a.marcado);
  if (!sel.length) { toast('Nenhuma alteração marcada.', true); return; }
  if (!confirm(`Aplicar ${sel.length} alteração(ões) do censo no painel?`)) return;
  showLoading('Aplicando censo...');
  let ok = 0; const falhas = [];
  // Ordem: saídas → bloqueios/liberações → admissões
  const ordem = { saida: 0, substituir: 1, bloquear: 2, liberar: 2, admitir: 3 };
  sel.sort((a, b) => ordem[a.tipo] - ordem[b.tipo]);
  for (const a of sel) {
    try {
      const atual = (await Store.get('nsp_leitos', a.bedId)) || { ocupado: false };
      LEITOS[a.bedId] = atual;
      if (a.tipo === 'saida' || a.tipo === 'substituir') {
        if (atual.ocupado) await darSaida(a.bedId, 'Atualização pelo censo' + (a.ce.situacao ? ' (' + a.ce.situacao + ')' : ''), hojeISO(), '');
      }
      if (a.tipo === 'bloquear') {
        if (leito(a.bedId).ocupado) { falhas.push(BED[a.bedId].longo + ' (ocupado)'); continue; }
        const doc = { ...docLeitoVazio(leito(a.bedId)), setor: BED[a.bedId].setorId, bloqueado: true, bloqueadoMotivo: a.ce.motivo || '', bloqueadoDesde: hojeISO(), bloqueadoPor: usuarioEmail };
        await Store.set('nsp_leitos', a.bedId, doc); LEITOS[a.bedId] = doc;
        registrarMovimento({ tipo: 'bloquear', bedId: a.bedId, setor: doc.setor, data: hojeISO(), motivo: doc.bloqueadoMotivo, fonte: 'censo' });
      }
      if (a.tipo === 'liberar') {
        const doc = { ...leito(a.bedId), setor: BED[a.bedId].setorId, bloqueado: false, bloqueadoMotivo: '', bloqueadoDesde: '', bloqueadoPor: '' };
        await Store.set('nsp_leitos', a.bedId, doc); LEITOS[a.bedId] = doc;
        registrarMovimento({ tipo: 'liberar', bedId: a.bedId, setor: doc.setor, data: hojeISO(), fonte: 'censo' });
      }
      if (a.tipo === 'admitir' || a.tipo === 'substituir') {
        if (leito(a.bedId).ocupado) { falhas.push(BED[a.bedId].longo + ' (já ocupado)'); continue; }
        const ce = a.ce;
        const doc = novoDocLeito(a.bedId, { pac: ce.pac, adm: ce.adm || hojeISO(), procedencia: ce.procedencia, hd: ce.hd, o2: ce.o2, isolamento: ce.isolamento || 'Não' }, 'censo');
        await Store.set('nsp_leitos', a.bedId, doc); LEITOS[a.bedId] = doc;
        registrarMovimento({ tipo: 'admissao', bedId: a.bedId, setor: doc.setor, pac: doc.pac, data: doc.adm, internacaoId: doc.internacaoId, fonte: 'censo' });
      }
      ok++;
    } catch (e) { console.error(e); falhas.push(BED[a.bedId].longo + ': ' + msgErro(e)); }
  }
  hideLoading();
  fecharModal('modal-censo');
  toast(`✓ ${ok} alteração(ões) aplicada(s)` + (falhas.length ? ` · ${falhas.length} não aplicada(s)` : ''), !!falhas.length);
  if (falhas.length) console.warn('Censo – não aplicadas:', falhas);
  await carregarPainel();
}

// ════════════════════════════════════════════════════════════════════════════
// INDICADORES
// ════════════════════════════════════════════════════════════════════════════
let IND = null;

function irIndicadores() {
  const sel = document.getElementById('ind-setor');
  if (!sel.options.length) sel.innerHTML = '<option value="todos">Todos</option>' + CFG.SETORES.map(s => `<option value="${s.id}">${esc(s.nome)}</option>`).join('');
  if (!gf('ind-de')) { sf('ind-de', addDias(hojeISO(), -29)); sf('ind-ate', hojeISO()); }
  mostrarTela('t-indicadores');
  renderIndicadores();
}

function periodoInd() {
  const v = gf('ind-periodo');
  if (v === 'custom') return { de: gf('ind-de'), ate: gf('ind-ate') };
  const n = +v;
  return { de: addDias(hojeISO(), n === 0 ? 0 : -(n - 1)), ate: hojeISO() };
}

// Intervalo de confiança de Wilson (95%)
function wilson(x, n, z = 1.96) {
  if (!n) return null;
  const p = x / n, z2 = z * z, den = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / den, h = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
  return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}
function fmtIC(x, n) {
  const w = wilson(x, n);
  return w ? `${(w.lo * 100).toFixed(0)}–${(w.hi * 100).toFixed(0)}%` : '–';
}
function cardInd(label, valor, sub, cls) {
  return `<div class="ind-card ${cls || ''}"><div class="ind-card-l">${label}</div><div class="ind-card-v">${valor}</div><div class="ind-card-s">${sub || ''}</div></div>`;
}
function corPct(x, n) { if (!n) return ''; const p = x / n; return p >= 0.95 ? 'verde' : p >= 0.8 ? 'laranja' : 'vermelho'; }
function barra(p) { return `<div class="ind-bar-bg"><div class="ind-bar-fill" style="width:${Math.round(p * 100)}%"></div></div>`; }

async function renderIndicadores() {
  const { de, ate } = periodoInd();
  if (!de || !ate || de > ate) { toast('Período inválido.', true); return; }
  const setor = gf('ind-setor') || 'todos';
  const cont = document.getElementById('ind-conteudo');
  showLoading('Calculando indicadores...');
  let vis = [];
  try {
    vis = await Store.range('nsp_visitas', 'data', de, ate);
  } catch (e) { hideLoading(); toast('Erro: ' + msgErro(e), true); return; }
  hideLoading();
  if (setor !== 'todos') vis = vis.filter(v => v.setor === setor);
  vis.sort((a, b) => (a.data + a.bedId).localeCompare(b.data + b.bedId));
  IND = { vis, de, ate, setor };

  if (!vis.length) { cont.innerHTML = `<div class="ind-vazio">Nenhuma busca ativa registrada entre ${fmtD(de)} e ${fmtD(ate)}.</div>`; return; }

  const n = vis.length;
  const pacientes = new Set(vis.map(v => v.internacaoId)).size;
  const dias = new Set(vis.map(v => v.data)).size;
  const semanas = {};
  vis.forEach(v => { const w = semanaDe(v.data).ini; (semanas[w] = semanas[w] || new Set()).add(v.internacaoId); });
  const nSem = Object.keys(semanas).length;
  const mediaSem = nSem ? (Object.values(semanas).reduce((t, x) => t + x.size, 0) / nSem).toFixed(1).replace('.', ',') : '–';

  // NSP global e por item
  let C = 0, NC = 0, vis100 = 0, visAval = 0;
  const porItem = {};
  CFG.NSP_ITENS.forEach(it => { porItem[it.id] = { c: 0, nc: 0, na: 0 }; });
  vis.forEach(v => {
    let c = 0, nc = 0;
    Object.entries(v.nsp || {}).forEach(([k, r]) => {
      if (!porItem[k]) return;
      if (r === 'C') { porItem[k].c++; c++; } else if (r === 'NC') { porItem[k].nc++; nc++; } else if (r === 'NA') porItem[k].na++;
    });
    C += c; NC += nc;
    if (c + nc) { visAval++; if (!nc) vis100++; }
  });

  // Dispositivos e eventos
  const dispCont = { SVD: 0, CVC: 0, AVP: 0, 'TOT/TQT': 0 }, diasDisp = { SVD: [], CVC: [], AVP: [], 'TOT/TQT': [] };
  const ck = { SVD: { s: 0, n: 0 }, CVC: { s: 0, n: 0 } };
  const eventos = {}; let comEvento = 0, notificados = 0;
  vis.forEach(v => {
    const d = v.disp || {};
    const add = (k, data) => { dispCont[k]++; const x = diasDesde(data, v.data); if (x) diasDisp[k].push(x); };
    if (d.elim === 'SVD') { add('SVD', d.svdData); if (d.svdCk) { ck.SVD.n++; if (d.svdCk === 'Sim') ck.SVD.s++; } }
    if (d.cvc) { add('CVC', d.cvcData); if (d.cvcCk) { ck.CVC.n++; if (d.cvcCk === 'Sim') ck.CVC.s++; } }
    if (d.avp) add('AVP', d.avpData);
    if (d.o2 === 'TOT' || d.o2 === 'TQT') add('TOT/TQT', d.vaData);
    const its = (v.notif && v.notif.itens) || [];
    its.forEach(nt => { comEvento++; if (nt.enviada) notificados++; eventos[nt.categoria] = (eventos[nt.categoria] || 0) + 1; });
  });
  const media = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1).replace('.', ',') : '–';

  // Por setor
  const porSetor = CFG.SETORES.map(s => {
    const vs = vis.filter(v => v.setor === s.id);
    let c = 0, nc = 0;
    vs.forEach(v => { Object.values(v.nsp || {}).forEach(r => { if (r === 'C') c++; else if (r === 'NC') nc++; }); });
    return { s, n: vs.length, c, nc };
  }).filter(x => x.n);

  const linhasNSP = CFG.NSP_ITENS.map(it => {
    const p = porItem[it.id], tot = p.c + p.nc;
    if (!tot && !p.na) return '';
    return `<tr><td>${esc(it.texto)}<div class="hint">${esc(it.grupo)}</div></td><td>${tot}</td><td>${p.c}</td>
      <td class="${corPct(p.c, tot)}"><b>${pct(p.c, tot)}</b>${tot ? barra(p.c / tot) : ''}</td><td>${fmtIC(p.c, tot)}</td></tr>`;
  }).join('');

  cont.innerHTML = `
    <p class="hint">Período ${fmtD(de)} a ${fmtD(ate)}${setor !== 'todos' ? ' · ' + esc(SETOR[setor].nome) : ''}. IC 95% pelo método de Wilson.</p>
    <div class="ind-grid">
      ${cardInd('Buscas ativas', n, `${pacientes} pacientes · ${dias} dia(s)`)}
      ${cardInd('Semanas com busca ativa', nSem, `média de ${mediaSem} pacientes visitados por semana`)}
      ${cardInd('Conformidade NSP (itens)', pct(C, C + NC), `${C}/${C + NC} · IC95% ${fmtIC(C, C + NC)}`, corPct(C, C + NC))}
      ${cardInd('Visitas 100% conformes', pct(vis100, visAval), `${vis100} de ${visAval} visitas`, corPct(vis100, visAval))}
      ${cardInd('Check-list de inserção (SVD/CVC)', pct(ck.SVD.s + ck.CVC.s, ck.SVD.n + ck.CVC.n), ck.SVD.n + ck.CVC.n ? `${ck.SVD.s + ck.CVC.s} de ${ck.SVD.n + ck.CVC.n} dispositivos com check-list` : 'nenhum SVD/CVC avaliado', corPct(ck.SVD.s + ck.CVC.s, ck.SVD.n + ck.CVC.n))}
      ${cardInd('Notificações geradas', comEvento, comEvento ? `${notificados} enviadas à planilha do NSP (${pct(notificados, comEvento)})` : 'nenhuma notificação', comEvento && notificados < comEvento ? 'laranja' : '')}
    </div>

    <div class="ind-grupo"><div class="ind-grupo-t">🛡 Segurança do paciente – conformidade por item</div>
      <div class="tab-wrap"><table class="tab-simples"><thead><tr><th>Item</th><th>Avaliados</th><th>Conformes</th><th>%</th><th>IC 95%</th></tr></thead><tbody>${linhasNSP}</tbody></table></div></div>

    <div class="ind-grupo"><div class="ind-grupo-t">🩺 Dispositivos nas buscas ativas</div>
      <div class="tab-wrap"><table class="tab-simples"><thead><tr><th>Dispositivo</th><th>Visitas com o dispositivo</th><th>% das visitas</th><th>Média de dias na visita</th><th>Com check-list de inserção</th></tr></thead><tbody>
      ${Object.keys(dispCont).map(k => `<tr><td>${k}</td><td>${dispCont[k]}</td><td>${pct(dispCont[k], n)}</td><td>${media(diasDisp[k])}</td><td${ck[k] ? ` class="${corPct(ck[k].s, ck[k].n)}"` : ''}>${ck[k] ? (ck[k].n ? `${pct(ck[k].s, ck[k].n)} (${ck[k].s}/${ck[k].n})` : '–') : ''}</td></tr>`).join('')}
      </tbody></table></div></div>

    ${Object.keys(eventos).length ? `<div class="ind-grupo"><div class="ind-grupo-t">⚠ Notificações por categoria</div><div class="ind-bar-wrap">
      ${Object.entries(eventos).sort((a, b) => b[1] - a[1]).map(([e, q]) => `<div class="ind-bar"><span class="ind-bar-l">${esc(e)}</span>${barra(q / comEvento)}<span class="ind-bar-n">${q}</span></div>`).join('')}
    </div></div>` : ''}

    ${setor === 'todos' && porSetor.length ? `<div class="ind-grupo"><div class="ind-grupo-t">🏥 Por setor</div>
      <div class="tab-wrap"><table class="tab-simples"><thead><tr><th>Setor</th><th>Buscas</th><th>Conformidade NSP</th></tr></thead><tbody>
      ${porSetor.map(x => `<tr><td>${esc(x.s.nome)}</td><td>${x.n}</td><td class="${corPct(x.c, x.c + x.nc)}">${pct(x.c, x.c + x.nc)}</td></tr>`).join('')}
      </tbody></table></div></div>` : ''}`;
}

function exportarCSV() {
  if (!IND || !IND.vis.length) { toast('Atualize os indicadores com um período que tenha buscas ativas.', true); return; }
  const linhas = IND.vis.map(linhaPlanilha);
  const cols = Object.keys(linhas[0]);
  const cel = v => { const s = String(nv(v)); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = '﻿' + [cols.join(';'), ...linhas.map(l => cols.map(c => cel(l[c])).join(';'))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `busca_ativa_${IND.de}_a_${IND.ate}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ════════════════════════════════════════════════════════════════════════════
// USUÁRIOS (admin)
// ════════════════════════════════════════════════════════════════════════════
async function abrirUsuarios() {
  if (!_isAdmin() || modoLocal) { toast('Acesso restrito ao administrador.', true); return; }
  mostrarTela('t-usuarios');
  await renderUsuarios();
}

async function renderUsuarios() {
  const wrap = document.getElementById('usuarios-lista');
  wrap.innerHTML = '<p class="hint">Carregando...</p>';
  let todos = {};
  try { todos = await Store.list('usuarios_nsp'); } catch (e) { wrap.innerHTML = `<p class="login-err">Erro: ${esc(msgErro(e))}</p>`; return; }
  const lista = Object.entries(todos).map(([email, u]) => ({ email, ...u })).sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
  if (!lista.length) { wrap.innerHTML = '<p class="hint">Nenhum usuário cadastrado.</p>'; return; }
  wrap.innerHTML = lista.map(u => {
    const fixo = _adminFixo(u.email), eu = u.email === usuarioEmail, ativo = u.ativo !== false, adm = fixo || u.role === 'admin';
    return `<div class="usr-linha${ativo ? '' : ' inativo'}">
      <div class="usr-info"><div class="usr-nome">${esc(u.nome || '(sem nome)')} ${adm ? '<span class="tag-admin">ADMIN</span>' : ''}${ativo ? '' : '<span class="tag-inativo">INATIVO</span>'}</div>
      <div class="usr-mail">${esc(u.email)}${u.funcao ? ' · ' + esc(u.funcao) : ''}</div></div>
      <div class="usr-acoes">
        <button class="btn btn-sm btn-sec" data-u="${esc(u.email)}" data-acao="ativo" ${fixo || eu ? 'disabled' : ''}>${ativo ? 'Desativar' : 'Reativar'}</button>
        <button class="btn btn-sm btn-sec" data-u="${esc(u.email)}" data-acao="admin" ${fixo || eu ? 'disabled' : ''}>${u.role === 'admin' ? 'Tirar admin' : 'Tornar admin'}</button>
        <button class="btn btn-sm btn-rem-u" data-u="${esc(u.email)}" data-acao="remover" ${fixo || eu ? 'disabled' : ''} title="Remove o acesso a este app">🗑</button>
      </div></div>`;
  }).join('');
}

async function aoClicarUsuario(ev) {
  const btn = ev.target.closest('button[data-u]');
  if (!btn || btn.disabled) return;
  const email = btn.dataset.u, acao = btn.dataset.acao;
  try {
    const u = (await Store.get('usuarios_nsp', email)) || {};
    if (acao === 'ativo') await Store.merge('usuarios_nsp', email, { ativo: u.ativo === false });
    else if (acao === 'admin') await Store.merge('usuarios_nsp', email, { role: u.role === 'admin' ? 'membro' : 'admin' });
    else if (acao === 'remover') {
      if (!confirm(`Remover o acesso de ${email} à busca ativa?\n\nA conta de login continua no Firebase (dá para reativar cadastrando de novo; para apagar de vez, use o console do Firebase → Authentication).`)) return;
      await Store.del('usuarios_nsp', email);
    }
    toast('✓ Usuário atualizado');
    renderUsuarios();
  } catch (e) { toast('Erro: ' + msgErro(e), true); }
}

async function adicionarUsuario() {
  if (!navigator.onLine) { document.getElementById('u-err').textContent = 'Cadastrar usuário precisa de internet.'; return; }
  const nome = gf('u-nome').trim().toUpperCase(), email = gf('u-email').trim().toLowerCase();
  const funcao = gf('u-funcao'), role = gf('u-role'), senha = gf('u-senha').trim();
  const errEl = document.getElementById('u-err'), btn = document.getElementById('btn-add-user');
  errEl.textContent = '';
  if (!nome || !email) { errEl.textContent = 'Preencha nome e e-mail.'; return; }
  if (!/^\S+@\S+\.\S+$/.test(email)) { errEl.textContent = 'E-mail inválido.'; return; }
  if (senha.length < 6) { errEl.textContent = 'A senha provisória precisa de ao menos 6 caracteres.'; return; }
  btn.disabled = true; btn.textContent = 'Criando...';
  try {
    // Cria a conta numa instância secundária do Firebase, para não deslogar o admin.
    let jaExistia = false;
    const sec = firebase.apps.find(a => a.name === 'cadastro') || firebase.initializeApp(CFG.FIREBASE, 'cadastro');
    try {
      await sec.auth().createUserWithEmailAndPassword(email, senha);
      await sec.auth().signOut();
    } catch (e) {
      if (e.code === 'auth/email-already-in-use') jaExistia = true; else throw e; // reativação de quem já foi cadastrado
    }
    await Store.set('usuarios_nsp', email, { nome, funcao, role, ativo: true, senhaTrocada: jaExistia, criadoEm: agoraISO(), criadoPor: usuarioEmail });
    toast(jaExistia ? '✓ Acesso reativado (o login já existia: a pessoa usa a senha que já tinha)' : '✓ Usuário criado. No 1º acesso a pessoa define a senha.');
    ['u-nome', 'u-email'].forEach(id => sf(id, ''));
    sf('u-senha', 'hospesc123');
    renderUsuarios();
  } catch (e) {
    errEl.textContent = e.code === 'auth/weak-password' ? 'Senha provisória fraca.' : msgErro(e);
  } finally { btn.disabled = false; btn.textContent = '+ Criar acesso'; }
}

function abrirFormularioNSP() {
  if (confirm('Abrir o formulário de notificação do NÚCLEO DE SEGURANÇA DO PACIENTE (fora deste sistema)?')) window.open(CFG.NSP_FORM_URL, '_blank', 'noopener');
}

// ════════════════════════════════════════════════════════════════════════════
// INICIALIZAÇÃO
// ════════════════════════════════════════════════════════════════════════════
function ligarEventos() {
  document.getElementById('painel-grid').addEventListener('click', aoClicarGrade);
  document.getElementById('painel-grid').addEventListener('keydown', ev => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList.contains('leito-card')) { ev.preventDefault(); ev.target.click(); }
  });
  document.getElementById('setor-tabs').addEventListener('click', ev => {
    const b = ev.target.closest('[data-setor]'); if (!b) return;
    setorAtivo = b.dataset.setor; renderPainel();
  });
  document.getElementById('v-nsp-itens').addEventListener('click', aoClicarResposta);
  const vn = document.getElementById('v-notifs');
  vn.addEventListener('input', aoEditarNotif);
  vn.addEventListener('change', aoEditarNotif);
  vn.addEventListener('click', ev => {
    const b = ev.target.closest('[data-rm]'); if (!b) return;
    if (confirm('Remover esta notificação?')) { NOTIFS.splice(+b.dataset.rm, 1); visitaSuja = true; renderNotifs(); }
  });
  document.getElementById('v-nsp-itens').addEventListener('click', ev => {
    const b = ev.target.closest('[data-notificar]'); if (!b) return;
    const it = CFG.NSP_ITENS.find(x => x.id === b.dataset.notificar);
    addNotif(it.notif || '', `Não conformidade identificada na busca ativa: ${it.texto}.`);
  });
  document.getElementById('t-visita').addEventListener('input', () => { visitaSuja = true; });
  document.getElementById('usuarios-lista').addEventListener('click', aoClicarUsuario);

  // Maiúsculas ao sair do campo (preserva o autocompletar do teclado no celular)
  document.addEventListener('focusout', ev => {
    const el = ev.target;
    if (el && el.classList && el.classList.contains('uc-live') && el.value) el.value = el.value.toUpperCase();
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') document.querySelectorAll('.overlay.show').forEach(o => o.classList.remove('show'));
  });
  window.addEventListener('online', aoFicarOnline);
  window.addEventListener('offline', atualizarStatusConexao);
  setInterval(() => { if (navigator.onLine) { descarregarOutbox(); reenviarNotifsPendentes(); } }, 120000);
  window.addEventListener('beforeunload', ev => { if (visitaSuja) { ev.preventDefault(); ev.returnValue = ''; } });
}

window.addEventListener('load', () => {
  construirIndices();
  document.getElementById('dl-procedencias').innerHTML = CFG.PROCEDENCIAS.map(p => `<option value="${esc(p)}">`).join('');
  document.querySelectorAll('.logo-slot').forEach(el => {
    el.innerHTML = '<img src="logo.png" alt="HOSPESC – Hospital dos Pescadores" class="logo-img" onerror="this.remove()">';
  });
  sf('p-data', dataRef);
  document.getElementById('p-data').max = hojeISO();
  ligarEventos();

  // Service worker: guarda as telas no aparelho para abrir sem internet
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker:', e));
  }

  if (new URLSearchParams(location.search).get('local') === '1') { usarModoLocal(); return; }
  if (!firebaseConfigurado()) {
    document.getElementById('cfg-titulo').textContent = '⚙️ Firebase ainda não configurado';
    document.getElementById('cfg-texto').innerHTML = 'Crie o projeto Firebase deste sistema e cole as chaves em <code>config.js</code> (passo a passo no README).';
    mostrarTela('t-config'); return;
  }
  if (!initFirebase()) { mostrarTela('t-config'); return; }
  mostrarTela('t-login');
  if (!navigator.onLine) document.getElementById('login-err').textContent = 'Sem internet. Se você já entrou neste aparelho antes, aguarde: o app abre com os dados guardados.';
  auth.onAuthStateChanged(user => { aoMudarAuth(user).catch(e => { console.error(e); hideLoading(); toast('Erro no login: ' + msgErro(e), true); }); });
});
