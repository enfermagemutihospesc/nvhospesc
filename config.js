// ════════════════════════════════════════════════════════════════════════════
// BUSCA ATIVA NSP / CCIH – Hospital dos Pescadores
// Arquivo de CONFIGURAÇÃO. Tudo o que pode mudar sem mexer na lógica está aqui:
// projeto Firebase, URL do Apps Script, administradores, leitos, itens dos
// check-lists e ciclo semanal de visitas.
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
    // Projeto PRÓPRIO e independente (logins e banco só deste sistema).
    // Crie em console.firebase.google.com → Configurações do projeto →
    // Seus apps → App da Web, e cole aqui os valores (passo a passo no README).
    FIREBASE: {
      apiKey: "COLE_AQUI",
      authDomain: "SEU-PROJETO.firebaseapp.com",
      projectId: "SEU-PROJETO",
      storageBucket: "SEU-PROJETO.firebasestorage.app",
      messagingSenderId: "COLE_AQUI",
      appId: "COLE_AQUI"
    },

    // Coleção do sistema no Firestore. Se mudar o nome aqui, mude também no firestore.rules.
    COLECAO: 'busca_ativa_nsp',

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

    // Formulário de notificação do NSP (Google Forms)
    NSP_FORM_URL: 'https://docs.google.com/forms/d/e/1FAIpQLSfpuEkVu7xLfbX8aUYa1rG-Oo77w3ae9DDBFvSRxvAomWAYgQ/viewform',

    // ── CICLO DE VISITAS ─────────────────────────────────────────────────────
    // Todos os pacientes internados recebem UMA busca ativa por semana
    // (segunda a domingo), divididos entre os dias de visita da equipe.
    // Depois de visitado na semana, o leito sai da lista de pendentes.
    VISITAS_POR_SEMANA: 3,

    // ── SETORES E LEITOS (espelho do censo do NIR; PS e Clínica Médica) ────────────────
    // "censo"      = rótulo da coluna B do censo usado na importação.
    // "notif"      = como o leito é escrito na planilha de notificações do NSP
    //                (o app completa com o número: "PS S.V L" + "02" → "PS S.V L02").
    // "notifSetor" = opção do campo "Setor ou categoria envolvidos na falha".
    SETORES: [
      { id: 'ps', nome: 'Pronto Socorro', sigla: 'PS', notifSetor: 'PS', grupos: [
        { nome: 'Sala Vermelha',               censo: 'SALA VERMELHA', notif: 'PS S.V L',          leitos: L('ps_sv', 1, 3) },
        { nome: 'Sala Amarela',                censo: 'SALA AMARELA',  notif: 'PS S.A L',          leitos: L('ps_sa', 4, 8) },
        { nome: 'Isolamento',                  censo: 'ISOLAMENTO',    notif: 'PS ISOLAMENTO L',   leitos: L('ps_iso', 9, 10) },
        { nome: 'Sutura (Iso)',                censo: 'SUTURA (ISO)',  notif: 'PS SUTURA ISO ',    leitos: L('ps_sutiso', 1, 1) },
        { nome: 'Sala de Estabilização (ECG)', censo: 'ESTABILIZACAO', notif: 'PS ESTABILIZAÇÃO ', leitos: L('ps_ecg', 1, 2) },
        { nome: 'Sutura',                      censo: 'SUTURA',        notif: 'PS SUTURA ',        leitos: L('ps_sut', 1, 1) },
        { nome: 'Poltronas',                   censo: 'POLTRONA',      notif: 'PS POLTRONA ',      leitos: L('ps_pol', 1, 4, n => 'POLTRONA ' + pad(n)) },
        { nome: 'Cadeiras',                    censo: 'CADEIRA',       notif: 'PS CADEIRA ',       leitos: L('ps_cad', 1, 5, n => 'CADEIRA ' + pad(n)) }
      ]},
      { id: 'cmt', nome: 'Clínica Médica Térreo', sigla: 'CM Térreo', notifSetor: 'Clínica médica térreo', grupos: [
        { nome: 'Enfermaria 01', censo: 'ENFERMARIA', notif: 'CM TÉRREO ENF01 L', leitos: L('cm', 1, 2) },
        { nome: 'Enfermaria 02', censo: 'ENFERMARIA', notif: 'CM TÉRREO ENF02 L', leitos: L('cm', 3, 4) },
        { nome: 'Enfermaria 03', censo: 'ENFERMARIA', notif: 'CM TÉRREO ENF03 L', leitos: L('cm', 5, 6) },
        { nome: 'Enfermaria 04', censo: 'ENFERMARIA', notif: 'CM TÉRREO ENF04 L', leitos: L('cm', 7, 8) },
        { nome: 'Enfermaria 05', censo: 'ENFERMARIA', notif: 'CM TÉRREO ENF05 L', leitos: L('cm', 9, 10) },
        { nome: 'Enfermaria 06', censo: 'ENFERMARIA', notif: 'CM TÉRREO ENF06 L', leitos: L('cm', 11, 12) }
      ]},
      { id: 'psi', nome: 'Saúde Mental', sigla: 'Saúde Mental', notifSetor: 'Clínica médica térreo', grupos: [
        { nome: 'Enfermaria 07 – Psico Feminina',  censo: 'ENFERMARIA', notif: 'CM TÉRREO ENF07 L', leitos: L('cm', 13, 15) },
        { nome: 'Enfermaria 08 – Psico Masculina', censo: 'ENFERMARIA', notif: 'CM TÉRREO ENF08 L', leitos: L('cm', 16, 18) }
      ]},
      { id: 'cm1', nome: 'Clínica Médica 1º Andar', sigla: 'CM 1º Andar', notifSetor: 'Clínica médica 1° andar', grupos: [
        { nome: 'Enfermaria 09', censo: 'ENFERMARIA', notif: 'CM 1º ANDAR ENF09 L', leitos: L('cm', 19, 24) },
        { nome: 'Enfermaria 10', censo: 'ENFERMARIA', notif: 'CM 1º ANDAR ENF10 L', leitos: L('cm', 25, 30) },
        { nome: 'Enfermaria 11', censo: 'ENFERMARIA', notif: 'CM 1º ANDAR ENF11 L', leitos: L('cm', 31, 34) }
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
    // notif: categoria sugerida quando o item for marcado "Não conforme" e notificado
    NSP_ITENS: [
      { id: 'placa',            grupo: 'Identificação do paciente', texto: 'Placa de identificação do leito', tipo: 'cnc', notif: 'Identificação de paciente' },
      { id: 'pulseira',         grupo: 'Identificação do paciente', texto: 'Pulseira de identificação', tipo: 'cnc', notif: 'Identificação de paciente' },
      { id: 'pulseira_alergia', grupo: 'Identificação do paciente', texto: 'Pulseira vermelha de alergia', tipo: 'cnc', notif: 'Identificação de paciente', se: 'alergia' },
      { id: 'isol_sinal',       grupo: 'Precauções / isolamento',   texto: 'Sinalização de precaução/isolamento no leito', tipo: 'cnc', notif: 'Falha de processo', se: 'isolamento' },
      { id: 'queda_sinal',      grupo: 'Prevenção de quedas',       texto: 'Risco de queda avaliado e sinalizado conforme protocolo', tipo: 'cnc_na', notif: 'Falha de processo' },
      { id: 'grades',           grupo: 'Prevenção de quedas',       texto: 'Grades elevadas / leito na posição mais baixa', tipo: 'cnc_na', notif: 'Falha de processo' },
      { id: 'lpp',              grupo: 'Prevenção de LPP',          texto: 'Medidas de prevenção de LPP (mudança de decúbito, superfície de suporte)', tipo: 'cnc_na', notif: 'Falha de processo' },
      { id: 'infusao_rotulo',   grupo: 'Medicação segura',          texto: 'Soluções/medicamentos em infusão com rótulo de identificação', tipo: 'cnc_na', notif: 'Falha na cadeia medicamentosa' },
      { id: 'alcool_gel',       grupo: 'Higiene das mãos',          texto: 'Preparação alcoólica disponível no ponto de assistência', tipo: 'cnc', notif: 'Falta de material ou medicamento' }
    ],

    // ── NOTIFICAÇÕES (mesmas opções do formulário do NSP) ────────────────────
    // Cada notificação registrada na busca ativa vira UMA LINHA na planilha de
    // respostas do formulário "Notificação - Núcleo de Segurança do Paciente"
    // (enviada pelo Apps Script; ID da planilha no Code.gs).
    NOTIF_CATEGORIAS: ['Identificação de paciente', 'Falha de processo', 'Falha na cadeia medicamentosa',
      'Falta de material ou medicamento', 'Lesão por pressão', 'Queda', 'Flebite', 'Falha de comunicação',
      'Falha de artigo médico hospitalar', 'Falha na administração de hemocomponente',
      'Infecção relacionada à assistência ao paciente', 'Outros']
  };
})();
