/**
 * BUSCA ATIVA NSP / CCIH – Hospital dos Pescadores
 * Backend Google Apps Script (Planilhas no Drive)
 *
 * O que faz:
 *  - nsp_visita    → grava/atualiza cada busca ativa na aba BUSCA_ATIVA (uma linha por paciente/dia)
 *  - nsp_movimento → registra admissões, saídas, transferências e bloqueios na aba MOVIMENTOS
 *  - nsp_censo     → lê a aba CENSO da planilha do NIR e devolve ao app (importação direta)
 *  - nsp_notificacao → grava cada notificação como UMA LINHA na planilha de respostas do
 *                      formulário "Notificação - Núcleo de Segurança do Paciente"
 *
 * IMPORTANTE: a conta que publicar este script precisa ter acesso de EDIÇÃO à
 * planilha de notificações (e às demais planilhas configuradas).
 *
 * Segurança: toda chamada traz o ID Token do Firebase do usuário logado, conferido
 * aqui no Google antes de qualquer leitura ou gravação.
 *
 * Como publicar:
 *  1. script.google.com → Novo projeto → cole este arquivo.
 *  2. Preencha CFG abaixo (IDs das planilhas: o trecho entre /d/ e /edit na URL).
 *  3. Implantar → Nova implantação → Tipo "App da Web"
 *     Executar como: Eu · Quem pode acessar: Qualquer pessoa.
 *  4. Copie a URL /exec e cole em APPS_SCRIPT_URL no config.js do app.
 *  Em Configurações do projeto (⚙️), deixe o fuso horário em America/Fortaleza.
 */

const CFG = {
  FIREBASE_API_KEY: '',      // mesma apiKey do config.js (projeto Firebase deste sistema)
  PLANILHA_DESTINO_ID: '',   // planilha onde ficam as buscas ativas (PREENCHER)
  CENSO_PLANILHA_ID: '',     // planilha do censo do NIR (PREENCHER)
  CENSO_ABA: 'CENSO',
  // Planilha de respostas do formulário de notificação do NSP
  NOTIF_PLANILHA_ID: '1XHJbj3Tm2CjHznSeBfdOAQtLQKTpeFMttV3bxEIQdR4',
  NOTIF_ABA: '',             // vazio = acha sozinha a aba que começa com "Carimbo de data/hora"
  ABA_VISITAS: 'BUSCA_ATIVA',
  ABA_MOVIMENTOS: 'MOVIMENTOS',
  EMAILS_PERMITIDOS: []      // vazio = qualquer usuário com login no Firebase deste sistema
};

function doGet() {
  return _json({ status: 'ok', app: 'busca-ativa-nsp', hora: new Date().toISOString() });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const email = _verificarToken(req.idToken);
    if (!email) return _json({ status: 'erro', msg: 'Sessão inválida. Entre novamente no app.' });

    switch (req.action) {
      case 'nsp_visita':    return _json(_upsertVisita(req.registro, email));
      case 'nsp_movimento': return _json(_registrarMovimento(req.registro, email));
      case 'nsp_censo':     return _json(_lerCenso());
      case 'nsp_notificacao': return _json(_gravarNotificacoes(req.itens || [], email));
      default:              return _json({ status: 'erro', msg: 'Ação desconhecida: ' + req.action });
    }
  } catch (err) {
    return _json({ status: 'erro', msg: String(err && err.message || err) });
  }
}

// ── Confere o ID Token do Firebase (Identity Toolkit) ─────────────────────────
function _verificarToken(idToken) {
  if (!idToken) return null;
  const cache = CacheService.getScriptCache();
  const chave = 'tk_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)).slice(0, 40);
  const emCache = cache.get(chave);
  if (emCache) return emCache;
  const resp = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + CFG.FIREBASE_API_KEY, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) return null;
  const users = JSON.parse(resp.getContentText()).users || [];
  const email = users.length ? String(users[0].email || '').toLowerCase() : '';
  if (!email) return null;
  const permitidos = CFG.EMAILS_PERMITIDOS.map(function (x) { return String(x).toLowerCase(); });
  if (permitidos.length && permitidos.indexOf(email) < 0) return null;
  cache.put(chave, email, 600);
  return email;
}

// ── Gravação: uma linha por visita (id = data_internação); atualiza se já existir ──
function _upsertVisita(reg, email) {
  if (!reg || !reg.id) return { status: 'erro', msg: 'Registro sem id.' };
  if (!CFG.PLANILHA_DESTINO_ID) return { status: 'erro', msg: 'PLANILHA_DESTINO_ID não configurado no Apps Script.' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const aba = _aba(CFG.ABA_VISITAS);
    const cab = _garantirColunas(aba, Object.keys(reg));
    const linha = cab.map(function (c) { return reg[c] !== undefined ? reg[c] : ''; });
    const achado = aba.getRange(1, 1, Math.max(aba.getLastRow(), 1), 1).createTextFinder(String(reg.id)).matchEntireCell(true).findNext();
    if (achado && achado.getRow() > 1) aba.getRange(achado.getRow(), 1, 1, cab.length).setValues([linha]);
    else aba.appendRow(linha);
    return { status: 'ok' };
  } finally { lock.releaseLock(); }
}

function _registrarMovimento(reg, email) {
  if (!reg) return { status: 'erro', msg: 'Registro vazio.' };
  if (!CFG.PLANILHA_DESTINO_ID) return { status: 'erro', msg: 'PLANILHA_DESTINO_ID não configurado no Apps Script.' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const aba = _aba(CFG.ABA_MOVIMENTOS);
    const cab = _garantirColunas(aba, Object.keys(reg));
    aba.appendRow(cab.map(function (c) { return reg[c] !== undefined ? reg[c] : ''; }));
    return { status: 'ok' };
  } finally { lock.releaseLock(); }
}

// ── Notificações: uma linha por notificação, no formato do formulário do NSP ──
// As colunas são localizadas pelo TEXTO do cabeçalho (não pela posição), então
// a gravação continua certa mesmo se o formulário ganhar/perder perguntas.
// Cada notificação tem um id; ids já gravados são ignorados (sem linha duplicada).
function _gravarNotificacoes(itens, email) {
  if (!itens.length) return { status: 'ok', gravados: [] };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.openById(CFG.NOTIF_PLANILHA_ID);
    const aba = CFG.NOTIF_ABA ? ss.getSheetByName(CFG.NOTIF_ABA) : ss.getSheets().filter(function (sh) {
      return _norm(sh.getRange(1, 1).getDisplayValue()).indexOf('CARIMBO') === 0;
    })[0];
    if (!aba) return { status: 'erro', msg: 'Aba de respostas do formulário não encontrada na planilha de notificações.' };

    const ncol = aba.getLastColumn();
    const cab = aba.getRange(1, 1, 1, ncol).getDisplayValues()[0].map(_norm);
    const col = function (prefixo) { for (var i = 0; i < cab.length; i++) if (cab[i].indexOf(prefixo) === 0) return i; return -1; };
    const C = {
      carimbo: col('CARIMBO'), categoria: col('NOTIFICACAO RELACIONADA'), outros: col('EM CASO DE RESPOSTA'),
      setor: col('SETOR OU CATEGORIA'), data: col('DATA EM QUE OCORREU'), hora: col('HORARIO'),
      descricao: col('DESCREVA O IN'), dano: col('HOUVE DANO'), danoDesc: col('SE HOUVE DANO'),
      obs: col('OUTRAS OBSERVACOES'), comPaciente: col('EVENTO COM PACIENTE'), leito: col('INFORME O LEITO')
    };
    if (C.categoria < 0 || C.descricao < 0) return { status: 'erro', msg: 'Cabeçalho da planilha de notificações diferente do esperado.' };

    const props = PropertiesService.getScriptProperties();
    const gravados = [];
    itens.forEach(function (n) {
      if (!n || !n.id) return;
      if (props.getProperty('notif_' + n.id)) { gravados.push(n.id); return; }   // já gravada antes
      const linha = new Array(ncol).fill('');
      const put = function (k, v) { if (C[k] >= 0) linha[C[k]] = v; };
      put('carimbo', new Date());
      put('categoria', n.categoria); put('outros', n.outros); put('setor', n.setor);
      put('data', _data(n.data)); put('hora', _hora(n.hora));
      put('descricao', n.descricao); put('dano', n.dano); put('danoDesc', n.danoDesc);
      put('obs', n.obs); put('comPaciente', n.comPaciente); put('leito', n.leito);
      const r = aba.getLastRow() + 1;
      aba.getRange(r, 1, 1, ncol).setValues([linha]);
      if (C.carimbo >= 0) aba.getRange(r, C.carimbo + 1).setNumberFormat('dd/MM/yyyy HH:mm:ss');
      if (C.data >= 0) aba.getRange(r, C.data + 1).setNumberFormat('dd/MM/yyyy');
      if (C.hora >= 0) aba.getRange(r, C.hora + 1).setNumberFormat('HH:mm:ss');
      props.setProperty('notif_' + n.id, new Date().toISOString() + ' ' + email);
      gravados.push(n.id);
    });
    return { status: 'ok', gravados: gravados };
  } finally { lock.releaseLock(); }
}

function _data(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : '';
}
function _hora(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] + ':00' : '';   // a planilha converte em hora
}
function _norm(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

// ── Leitura do censo do NIR (valores exibidos, como na tela) ──────────────────
function _lerCenso() {
  if (!CFG.CENSO_PLANILHA_ID) return { status: 'erro', msg: 'CENSO_PLANILHA_ID não configurado no Apps Script.' };
  const ss = SpreadsheetApp.openById(CFG.CENSO_PLANILHA_ID);
  const aba = ss.getSheetByName(CFG.CENSO_ABA) || ss.getSheets()[0];
  return { status: 'ok', nome: ss.getName(), linhas: aba.getDataRange().getDisplayValues() };
}

// ── utilitários ───────────────────────────────────────────────────────────────
function _aba(nome) {
  const ss = SpreadsheetApp.openById(CFG.PLANILHA_DESTINO_ID);
  return ss.getSheetByName(nome) || ss.insertSheet(nome);
}

// Garante que todas as chaves existam como colunas (novas colunas vão para o fim)
function _garantirColunas(aba, chaves) {
  let cab = aba.getLastRow() ? aba.getRange(1, 1, 1, Math.max(aba.getLastColumn(), 1)).getValues()[0].filter(String) : [];
  const novas = chaves.filter(function (k) { return cab.indexOf(k) < 0; });
  if (novas.length) {
    cab = cab.concat(novas);
    aba.getRange(1, 1, 1, cab.length).setValues([cab]).setFontWeight('bold');
    aba.setFrozenRows(1);
  }
  return cab;
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
