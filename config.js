// ════════════════════════════════════════════════════════════════════════════
// BUSCA ATIVA NSP / CCIH – Hospital dos Pescadores
// Arquivo de CONFIGURAÇÃO. Tudo o que pode mudar sem mexer na lógica está aqui:
// projeto Firebase, URL do Apps Script, administradores, leitos, itens dos
// check-lists e parâmetros da amostragem.
// ════════════════════════════════════════════════════════════════════════════

(function () {
  const pad = n => String(n).padStart(2, '0');

  // Gera uma faixa de leitos: L('cm', 19, 24) → cm19..cm24
  function L(prefixo, de, ate, rotulo) {
    const out = [];
    for (let n = de; n <= ate; n++) {
      out.push({ id: prefixo + (prefixo === 'cm' ? pad(n) : n), num: n, curto: rotulo ? rotulo(n) : 'LEITO ' + pad(n) });
    }
    return out;
  }

  window.NSP_CONFIG = {

    // ── FIREBASE ─────────────────────────────────────────────────────────────
    // Mesmo projeto do sistema da UTI (mesmos logins). Os dados deste app ficam
    // em coleções próprias: usuarios_nsp, nsp_leitos, nsp_visitas,
    // nsp_movimentos, nsp_amostras e nsp_config.
    // Para usar um projeto separado, troque os valores abaixo.
    FIREBASE: {
      apiKey: "AIzaSyB00a198BLBKXyvfCXmbZgbY9lAPsp_G6c",
      authDomain: "evolucaouti.firebaseapp.com",
      projectId: "evolucaouti",
      storageBucket: "evolucaouti.firebasestorage.app",
      messagingSenderId: "168481656346",
      appId: "1:168481656346:web:4af8e67600eeabb4fdcba3"
    },

    // ── APPS SCRIPT (Google Drive / Planilhas) ───────────────────────────────
    // Deixe vazio até publicar o Code.gs. Com a URL preenchida, cada visita
    // salva é enviada para a planilha de destino, e o botão "Importar do Drive"
    // passa a ler o censo direto da planilha do NIR.
    APPS_SCRIPT_URL: '',

    // ── ACESSO ───────────────────────────────────────────────────────────────
    // Administradores fixos (gerenciam usuários, bloqueiam/liberam leitos).
    // Outros admins podem ser promovidos pela tela "Usuários".
    // Mantenha esta lista igual à função nspAdminsFixos() do firestore.rules.
    ADMIN_EMAILS: ['tercio@hospesc.com.br'],

    // Formulário de notificação do NSP (o mesmo usado no sistema da UTI)
    NSP_FORM_URL: 'https://docs.google.com/forms/d/e/1FAIpQLSfpuEkVu7xLfbX8aUYa1rG-Oo77w3ae9DDBFvSRxvAomWAYgQ/viewform',

    // ── AMOSTRAGEM ───────────────────────────────────────────────────────────
    // n = N·Z²·p·q / [e²·(N−1) + Z²·p·q], com N = leitos ativos (não bloqueados),
    // como se o hospital estivesse sempre lotado. A fração n/N é aplicada aos
    // leitos ocupados de cada setor (amostra estratificada, sorteio aleatório).
    AMOSTRA: { z: 1.96, confianca: '95%', margemErro: 0.10, p: 0.5 },

    // ── SETORES E LEITOS (espelho do censo do NIR, sem a UTI) ────────────────
    // "censo" = rótulo da coluna B do censo usado na importação.
    SETORES: [
      { id: 'ps', nome: 'Pronto Socorro', sigla: 'PS', grupos: [
        { nome: 'Sala Vermelha',               censo: 'SALA VERMELHA', leitos: L('ps_sv', 1, 3) },
        { nome: 'Sala Amarela',                censo: 'SALA AMARELA',  leitos: L('ps_sa', 4, 8) },
        { nome: 'Isolamento',                  censo: 'ISOLAMENTO',    leitos: L('ps_iso', 9, 10) },
        { nome: 'Sutura (Iso)',                censo: 'SUTURA (ISO)',  leitos: L('ps_sutiso', 1, 1) },
        { nome: 'Sala de Estabilização (ECG)', censo: 'ESTABILIZACAO', leitos: L('ps_ecg', 1, 2) },
        { nome: 'Sutura',                      censo: 'SUTURA',        leitos: L('ps_sut', 1, 1) },
        { nome: 'Poltronas',                   censo: 'POLTRONA',      leitos: L('ps_pol', 1, 4, n => 'POLTRONA ' + pad(n)) },
        { nome: 'Cadeiras',                    censo: 'CADEIRA',       leitos: L('ps_cad', 1, 5, n => 'CADEIRA ' + pad(n)) }
      ]},
      { id: 'cmt', nome: 'Clínica Médica Térreo', sigla: 'CM Térreo', grupos: [
        { nome: 'Enfermaria 01', censo: 'ENFERMARIA', leitos: L('cm', 1, 2) },
        { nome: 'Enfermaria 02', censo: 'ENFERMARIA', leitos: L('cm', 3, 4) },
        { nome: 'Enfermaria 03', censo: 'ENFERMARIA', leitos: L('cm', 5, 6) },
        { nome: 'Enfermaria 04', censo: 'ENFERMARIA', leitos: L('cm', 7, 8) },
        { nome: 'Enfermaria 05', censo: 'ENFERMARIA', leitos: L('cm', 9, 10) },
        { nome: 'Enfermaria 06', censo: 'ENFERMARIA', leitos: L('cm', 11, 12) }
      ]},
      { id: 'psi', nome: 'Saúde Mental', sigla: 'Saúde Mental', grupos: [
        { nome: 'Enfermaria 07 – Psico Feminina',  censo: 'ENFERMARIA', leitos: L('cm', 13, 15) },
        { nome: 'Enfermaria 08 – Psico Masculina', censo: 'ENFERMARIA', leitos: L('cm', 16, 18) }
      ]},
      { id: 'cm1', nome: 'Clínica Médica 1º Andar', sigla: 'CM 1º Andar', grupos: [
        { nome: 'Enfermaria 09', censo: 'ENFERMARIA', leitos: L('cm', 19, 24) },
        { nome: 'Enfermaria 10', censo: 'ENFERMARIA', leitos: L('cm', 25, 30) },
        { nome: 'Enfermaria 11', censo: 'ENFERMARIA', leitos: L('cm', 31, 34) }
      ]}
    ],

    // Procedências (lista "UNIDADE DE ORIGEM" da aba REGRAS do censo)
    PROCEDENCIAS: ['PS - HOSPESC', 'UPA - PAJUÇARA', 'UPA - POTENGI', 'UPA - SATÉLITE', 'UPA - ESPERANÇA',
      'HMN', 'HUOL', 'UND MÃE LUIZA', 'JOÃO MACHADO', 'SANTA CATARINA', 'GISELDA', 'CLÍNICA VITA',
      'HOSP. NATAL OESTE', 'HOSP SEVERINO LOPES', 'OUTROS'],

    // ── CHECK-LIST NSP (segurança do paciente) ───────────────────────────────
    // tipo 'cnc'    → Conforme / Não conforme
    // tipo 'cnc_na' → Conforme / Não conforme / Não se aplica
    // se: condição de exibição (alergia = Sim, isolamento ≠ Não)
    NSP_ITENS: [
      { id: 'placa',            grupo: 'Identificação do paciente', texto: 'Placa de identificação do leito', tipo: 'cnc' },
      { id: 'pulseira',         grupo: 'Identificação do paciente', texto: 'Pulseira de identificação', tipo: 'cnc' },
      { id: 'pulseira_alergia', grupo: 'Identificação do paciente', texto: 'Pulseira vermelha de alergia', tipo: 'cnc', se: 'alergia' },
      { id: 'isol_sinal',       grupo: 'Precauções / isolamento',   texto: 'Sinalização de precaução/isolamento no leito', tipo: 'cnc', se: 'isolamento' },
      { id: 'queda_sinal',      grupo: 'Prevenção de quedas',       texto: 'Risco de queda avaliado e sinalizado conforme protocolo', tipo: 'cnc_na' },
      { id: 'grades',           grupo: 'Prevenção de quedas',       texto: 'Grades elevadas / leito na posição mais baixa', tipo: 'cnc_na' },
      { id: 'lpp',              grupo: 'Prevenção de LPP',          texto: 'Medidas de prevenção de LPP (mudança de decúbito, superfície de suporte)', tipo: 'cnc_na' },
      { id: 'infusao_rotulo',   grupo: 'Medicação segura',          texto: 'Soluções/medicamentos em infusão com rótulo de identificação', tipo: 'cnc_na' },
      { id: 'alcool_gel',       grupo: 'Higiene das mãos',          texto: 'Preparação alcoólica disponível no ponto de assistência', tipo: 'cnc' }
    ],

    // ── CHECK-LIST CCIH (bundles) — mesmos itens do sistema da UTI ───────────
    // disp: dispositivo que ativa o bundle (cvc | avp | svd | via_aerea)
    // criterio 'sim' → SIM é aderente | 'nao' → NÃO é aderente | 'info' → só registro
    // na: true → aceita "N/A" (não entra no cálculo)
    BUNDLES: [
      { id: 'cvc', disp: 'cvc', icone: '🩸', titulo: 'Prevenção de IPCS – Cateter Central (CVC / CDL / PICC)', itens: [
        { id: 'cvc_curativo_tipo',  texto: 'Qual curativo utilizado?', opcoes: ['GAZE', 'FILME'], criterio: 'info' },
        { id: 'cvc_curativo_data',  texto: 'Curativo com data da realização?', criterio: 'sim' },
        { id: 'cvc_curativo_troca', texto: 'Curativo precisa ser trocado?', criterio: 'info' },
        { id: 'cvc_sem_sangue',     texto: 'Dispositivos (dânula, polifix, conector) sem resíduo de sangue?', criterio: 'sim' },
        { id: 'cvc_equipo_data',    texto: 'Equipos e dispositivos com data da instalação?', criterio: 'sim' },
        { id: 'cvc_equipo_troca',   texto: 'Equipos e dispositivos precisam ser trocados?', criterio: 'info' },
        { id: 'cvc_alcool',         texto: 'Realizada orientação sobre desinfecção das conexões com álcool 70% antes de equipos ou seringas?', criterio: 'sim' }
      ]},
      { id: 'avp', disp: 'avp', icone: '💉', titulo: 'Prevenção de IPCS – Acesso Venoso Periférico (AVP)', itens: [
        { id: 'avp_curativo_limpo', texto: 'Curativo limpo e seco?', criterio: 'sim' },
        { id: 'avp_dor_edema',      texto: 'Paciente refere dor, ou apresenta edema, hiperemia?', criterio: 'nao' },
        { id: 'avp_data_puncao',    texto: 'Acesso com data em que foi realizada a punção?', criterio: 'sim' },
        { id: 'avp_sem_sangue',     texto: 'Dispositivos (dânula, polifix, conector) sem resíduo de sangue?', criterio: 'sim' },
        { id: 'avp_equipo_data',    texto: 'Equipos com data da instalação?', criterio: 'sim' },
        { id: 'avp_equipo_troca',   texto: 'Equipos precisam ser trocados?', criterio: 'info' }
      ]},
      { id: 'svd', disp: 'svd', icone: '🚽', titulo: 'Prevenção de ITU-AC – Sonda Vesical de Demora (SVD)', itens: [
        { id: 'svd_data',         texto: 'Possui identificação da data da instalação?', criterio: 'sim' },
        { id: 'svd_fixacao',      texto: 'Sonda fixada corretamente no paciente?', criterio: 'sim' },
        { id: 'svd_higiene',      texto: 'Realizada higiene do meato urinário?', criterio: 'sim' },
        { id: 'svd_dobras',       texto: 'Apresenta dobras no sistema?', criterio: 'nao' },
        { id: 'svd_bolsa_nivel',  texto: 'Bolsa coletora abaixo do nível da bexiga e sem contato com o chão?', criterio: 'sim' },
        { id: 'svd_bolsa_volume', texto: 'Bolsa coletora com volume até 2/3 da capacidade?', criterio: 'sim' }
      ]},
      { id: 'pav', disp: 'via_aerea', icone: '💨', titulo: 'Prevenção de PAV – Via Aérea Artificial (TOT / TQT)', itens: [
        { id: 'pav_higiene_oral', texto: 'Realizada HIGIENE ORAL?', criterio: 'sim' },
        { id: 'pav_cabeceira',    texto: 'Cabeceira elevada (30–45°)?', criterio: 'sim' },
        { id: 'pav_fixacao',      texto: 'TOT ou TQT com fixação adequada?', criterio: 'sim' },
        { id: 'pav_sne',          texto: 'Sonda nasoenteral com fixação adequada?', criterio: 'sim', na: true },
        { id: 'pav_aspiracao',    texto: 'Sistema de aspiração fechado dentro do prazo de validade?', criterio: 'sim', na: true },
        { id: 'pav_latex',        texto: 'Realizada troca do látex e vacuômetro conforme rotina?', criterio: 'sim', na: true }
      ]}
    ],

    // Eventos da coluna NOTIFICAÇÕES
    EVENTOS_NOTIFICACAO: ['Lesão por pressão', 'Queda', 'Flebite', 'Perda/saída acidental de dispositivo',
      'Erro de medicação', 'Broncoaspiração', 'Evasão', 'Falha de identificação', 'Outro']
  };
})();
