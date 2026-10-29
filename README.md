# Busca Ativa NSP / CCIH – Hospital dos Pescadores

App web para a visita diária do NSP e da CCIH no Pronto Socorro e na Clínica Médica. Usa a mesma arquitetura do sistema da UTI: GitHub Pages, Firebase (login e Firestore) e Apps Script (Drive).

O fluxo de uso é: **painel de leitos → abre o leito → admite o paciente (pode vir preenchido pelo censo) → check-list NSP + CCIH**.

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html` | Telas do app |
| `styles.css` | Visual (mesma base do sistema da UTI) |
| `config.js` | **Tudo o que se ajusta**: Firebase, URL do Apps Script, admins, leitos, itens dos check-lists, parâmetros da amostra |
| `app.js` | Lógica |
| `logo.png` | Logo HOSPESC |
| `firestore.rules` | Trecho de regras a acrescentar no Firestore |
| `apps-script/Code.gs` | Backend no Google (planilhas no Drive) |

## Publicar (passo a passo)

1. **GitHub**: crie um repositório (ex.: `nvhospesc/buscaativa`) e envie todos os arquivos, menos a pasta `apps-script`. Depois, em *Settings → Pages*, escolha *Deploy from branch → main / root*. O app fica em `https://nvhospesc.github.io/buscaativa/`.
2. **Firebase** (projeto `evolucaouti`, o mesmo da UTI):
   - *Firestore → Regras*: cole o conteúdo de `firestore.rules` **dentro** do bloco `match /databases/{database}/documents` que já existe e publique. Não apague as regras da UTI.
   - *Authentication → Configurações → Domínios autorizados*: confirme que `nvhospesc.github.io` está na lista.
3. **Primeiro acesso**: entre com um e-mail da lista `ADMIN_EMAILS` (config.js). O perfil de admin é criado sozinho. Depois cadastre a equipe em **👥 Usuários**. Quem já tem login da UTI entra com a mesma senha.
4. **Apps Script** (quando definir as planilhas de destino): siga o cabeçalho de `apps-script/Code.gs`, depois cole a URL `/exec` em `APPS_SCRIPT_URL` no `config.js`. A partir daí:
   - cada busca ativa salva vira uma linha na aba `BUSCA_ATIVA` (atualizada se a visita for editada);
   - admissões, saídas, transferências e bloqueios vão para a aba `MOVIMENTOS`;
   - aparece o botão **☁ Importar direto do Drive** no censo.

## Dados no Firestore

| Coleção | Conteúdo |
|---|---|
| `usuarios_nsp` | Perfis (nome, função, admin, ativo) |
| `nsp_leitos` | Um documento por leito: paciente atual, admissão, procedência, HD, alergia, isolamento, dispositivos |
| `nsp_visitas` | Uma busca ativa por paciente por dia (`data_internação`) |
| `nsp_amostras` | Amostra sorteada de cada dia |
| `nsp_movimentos` | Histórico de admissões, saídas, transferências e bloqueios |
| `nsp_config/censo` | Último censo importado (só nome, admissão, procedência, HD e O₂) |

Idade, sexo, data de nascimento, CNS, CPF e evolução clínica **não são guardados**.

## Amostragem

O botão **🎲 Sortear amostra do dia** calcula:

`n = N·Z²·p·q / [e²·(N−1) + Z²·p·q]`, com 95% de confiança (Z = 1,96), p = 0,5 e margem de ±10%.

N é o número de leitos ativos (não bloqueados), considerando o hospital sempre lotado. A fração n/N é aplicada aos ocupados de cada setor, e o sorteio é aleatório dentro do setor. Com 45 leitos ativos, n = 31 (≈69%).

Para mudar a margem de erro (ex.: ±5%), edite `AMOSTRA.margemErro` no `config.js`.

## Modo local (treinamento)

Abra `index.html?local=1`: os dados ficam só no navegador do aparelho, sem login e sem nuvem. Serve para treinar a equipe.
