# Busca Ativa NSP / CCIH – Hospital dos Pescadores

App web para a visita diária do NSP e da CCIH no Pronto Socorro e na Clínica Médica. É um sistema **independente**, com projeto Firebase, logins e banco de dados próprios. Roda no GitHub Pages e grava no Drive pelo Apps Script.

O fluxo de uso é: **painel de leitos → abre o leito → admite o paciente (pode vir preenchido pelo censo) → check-list NSP + CCIH**.

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html` | Telas do app |
| `styles.css` | Visual |
| `config.js` | **Tudo o que se ajusta**: chaves do Firebase, URL do Apps Script, admins, leitos, itens dos check-lists, parâmetros da amostra |
| `app.js` | Lógica |
| `logo.png` | Logo HOSPESC |
| `firestore.rules` | Regras de segurança do banco |
| `apps-script/Code.gs` | Backend no Google (planilhas no Drive) |

## 1. Criar o projeto Firebase (uma vez)

1. Entre em **console.firebase.google.com** com a conta Gmail do NSP e clique em **Criar projeto** (ex.: `buscaativa-hospesc`). O Google Analytics não é necessário.
2. Em **Authentication → Começar**, ative **E-mail/senha**.
3. Ainda em **Authentication → Usuários → Adicionar usuário**, crie o primeiro administrador com o e-mail que está em `ADMIN_EMAILS` no `config.js` (hoje, `tercio@hospesc.com.br`) e uma senha.
4. Em **Firestore Database → Criar banco de dados**, escolha o modo de produção e a região `southamerica-east1` (São Paulo).
5. Em **Firestore → Regras**, apague o que estiver lá, cole o arquivo `firestore.rules` inteiro e clique em **Publicar**.
6. Em **Configurações do projeto (⚙️) → Seus apps → `</>` (Web)**, registre o app e copie os valores de `firebaseConfig` para o bloco `FIREBASE` do `config.js`.

Se mudar a lista de administradores, mude nos dois lugares: `ADMIN_EMAILS` no `config.js` e `adminsFixos()` no `firestore.rules`.

## 2. Publicar no GitHub Pages

1. Crie um repositório (ex.: `nvhospesc/buscaativa`) e envie todos os arquivos, menos a pasta `apps-script`.
2. Em **Settings → Pages**, escolha **Deploy from branch → main / root**. O app fica em `https://nvhospesc.github.io/buscaativa/`.
3. No Firebase, em **Authentication → Configurações → Domínios autorizados**, adicione `nvhospesc.github.io`.

## 3. Primeiro acesso e equipe

Entre com o administrador criado no passo 1.3; o perfil dele é criado sozinho. Depois cadastre a equipe em **👥 Usuários**: a pessoa recebe uma senha provisória (padrão `hospesc123`) e cria a própria senha no primeiro acesso.

## 4. Apps Script (quando definir as planilhas de destino)

Siga o cabeçalho de `apps-script/Code.gs`: cole a `apiKey` do Firebase e os IDs das planilhas, depois publique como **App da Web**. Cole a URL `/exec` em `APPS_SCRIPT_URL` no `config.js`. A partir daí:

- cada busca ativa salva vira uma linha na aba `BUSCA_ATIVA` (atualizada se a visita for editada);
- admissões, saídas, transferências e bloqueios vão para a aba `MOVIMENTOS`;
- aparece o botão **☁ Importar direto do Drive** no censo.

## Dados (coleção única `busca_ativa_nsp`)

| Prefixo do documento | Conteúdo |
|---|---|
| `usuario__<e-mail>` | Perfil (nome, função, admin, ativo) |
| `leito__<leito>` | Paciente atual: nome, admissão, procedência, HD, alergia, isolamento, dispositivos |
| `visita__<data>_<internação>` | Uma busca ativa por paciente por dia |
| `amostra__<data>` | Amostra sorteada do dia |
| `mov__<data>_<id>` | Histórico de admissões, saídas, transferências e bloqueios (não pode ser apagado) |
| `config__censo` | Último censo importado (só nome, admissão, procedência, HD, O₂ e isolamento) |

Idade, sexo, data de nascimento, CNS, CPF e evolução clínica **não são guardados**.

## Amostragem

O botão **🎲 Sortear amostra do dia** calcula:

`n = N·Z²·p·q / [e²·(N−1) + Z²·p·q]`, com 95% de confiança (Z = 1,96), p = 0,5 e margem de ±10%.

N é o número de leitos ativos (não bloqueados), considerando o hospital sempre lotado. A fração n/N é aplicada aos ocupados de cada setor, e o sorteio é aleatório dentro do setor. Com 45 leitos ativos, n = 31 (≈69%).

Para mudar a margem de erro (ex.: ±5%), edite `AMOSTRA.margemErro` no `config.js`.

## Modo local (treinamento)

Abra `index.html?local=1`: os dados ficam só no navegador do aparelho, sem login e sem nuvem. Serve para treinar a equipe.
