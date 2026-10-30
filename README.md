# Busca Ativa NSP / CCIH – Hospital dos Pescadores

App web para a visita diária do NSP e da CCIH no Pronto Socorro e na Clínica Médica. É um sistema **independente**, com projeto Firebase, logins e banco de dados próprios. Roda no GitHub Pages e grava no Drive pelo Apps Script.

O fluxo de uso é: **painel de leitos → abre o leito → admite o paciente (pode vir preenchido pelo censo) → check-list NSP + CCIH**.

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html` | Telas do app |
| `styles.css` | Visual |
| `config.js` | **Tudo o que se ajusta**: chaves do Firebase, URL do Apps Script, admins, leitos, itens dos check-lists, visitas por semana |
| `app.js` | Lógica |
| `logo.png`, `icon-*.png` | Logo e ícones do app |
| `sw.js`, `manifest.json` | Funcionamento offline e instalação como aplicativo |
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
- **cada notificação registrada na visita vira uma linha na planilha de respostas do formulário "Notificação – Núcleo de Segurança do Paciente"** (ID já preenchido no `Code.gs`). As colunas são encontradas pelo nome do cabeçalho; a coluna Status fica em branco para o NSP tratar como hoje. Uma notificação nunca é gravada duas vezes. Se o envio falhar (sem internet), ela fica marcada ⏳ e é reenviada ao abrir o painel.

A conta Google que publicar o Apps Script precisa ter **acesso de edição** à planilha de notificações.

## Dados (coleção única `busca_ativa_nsp`)

| Prefixo do documento | Conteúdo |
|---|---|
| `usuario__<e-mail>` | Perfil (nome, função, admin, ativo) |
| `leito__<leito>` | Paciente atual: nome, admissão, procedência, HD, alergia, isolamento, dispositivos |
| `visita__<data>_<internação>` | Uma busca ativa por paciente por dia |
| `mov__<data>_<id>` | Histórico de admissões, saídas, transferências e bloqueios (não pode ser apagado) |
| `config__censo` | Último censo importado (só nome, admissão, procedência, HD, O₂ e isolamento) |

Idade, sexo, data de nascimento, CNS, CPF e evolução clínica **não são guardados**.

## Ciclo semanal de visitas

Todos os pacientes internados recebem **uma busca ativa por semana** (segunda a domingo), divididos em 3 visitas da equipe (`VISITAS_POR_SEMANA` no `config.js`).

- O painel mostra a semana atual: quantos pacientes já foram visitados, quantos faltam e a meta aproximada por visita (total de internados ÷ 3).
- Quando a busca ativa de um paciente é salva, o leito fica marcado **✓ Visitado** e sai da lista; ficam disponíveis só os pendentes. Para ver todos, marque "Mostrar também os já visitados nesta semana".
- Abrir um paciente já visitado na semana abre a mesma visita, para consulta ou correção, sem criar outra.
- Paciente que muda de leito continua contando como visitado. Paciente admitido no meio da semana entra como pendente.

## Uso sem internet (offline)

O app funciona sem internet depois do **primeiro acesso online** no aparelho (é nesse acesso que ele guarda as telas, o login e os dados).

- **Telas:** o `sw.js` (service worker) guarda os arquivos do app e as bibliotecas no aparelho. No celular, use "Adicionar à tela inicial" para abrir como aplicativo.
- **Login:** a pessoa continua logada no aparelho até tocar em "Sair". Sem internet não é possível sair nem entrar com outro usuário.
- **Dados:** leitos e visitas da semana ficam no cache do aparelho. Tudo o que for salvo offline (admissões, visitas, saídas, notificações) fica guardado e é **enviado sozinho quando a conexão voltar**, inclusive se o app for fechado e aberto de novo depois.
- **Planilhas (Apps Script):** os envios ficam numa fila no aparelho e são repetidos ao reconectar, ao abrir o painel e a cada 2 minutos. As notificações só são marcadas como enviadas depois que a planilha confirma.
- **Indicação na tela:** uma faixa amarela avisa quando está sem internet, e a linha de status no rodapé do painel mostra se há dados aguardando envio.
- **Precisa de internet:** primeiro acesso, cadastrar usuário, importar o censo direto do Drive e sair do sistema.

Ao publicar uma versão nova do app, troque `VERSAO` no `sw.js` para os aparelhos baixarem a atualização.

## Leveza (celulares antigos)

- Sem fontes baixadas da internet (usa a fonte do próprio celular), sem animações nem efeitos de desfoque.
- Imagens comprimidas; o app inteiro (sem o Firebase) tem cerca de 50 KB compactado.
- O Firebase é baixado uma vez e fica guardado no aparelho; o leitor de planilhas (~900 KB) só é baixado se alguém importar o censo por arquivo.
- Código compatível com navegadores antigos (sem sintaxe recente de JavaScript). Para funcionar offline, o celular precisa de Android com Chrome atualizável ou iPhone com iOS 11.3 ou mais novo.

## Modo local (treinamento)

Abra `index.html?local=1`: os dados ficam só no navegador do aparelho, sem login e sem nuvem. Serve para treinar a equipe.
