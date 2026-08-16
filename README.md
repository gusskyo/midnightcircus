# Midnight Circus — Jogos da Tenda

Site interativo para sessões de RPG. O mestre cria uma sala, os jogadores entram pelo mesmo link e todos acompanham os jogos. Cada atração aceita 1 ou 2 participantes; os demais assistem às ações e resultados. Tickets ficam registrados por jogador e o mestre pode alterá-los a qualquer momento.

## Jogos incluídos
1. Roleta Rubra — sorte, 1 jogador
2. Copos do Arlequim — sorte, 1 jogador
3. Corda do Acrobata — risco e decisão, 1 jogador
4. Oráculo dos Números — raciocínio, 1 jogador
5. Dardos do Diabo — sorte e escolha, 1 jogador
6. Duelo das Cartas — estratégia, 2 jogadores
7. Leilão de Ossos — estratégia, 2 jogadores
8. Espelhos Gêmeos — lógica cooperativa, 2 jogadores

## Instalação no Supabase
1. Crie um projeto no Supabase.
2. Abra **SQL Editor** e execute TODO o arquivo `supabase-setup.sql`.
3. Copie o **Project URL** e a **Publishable Key**.
4. Abra `config.js` e substitua os dois valores de exemplo.

Nunca coloque `service_role`, Secret Key ou senha do banco no GitHub. A Publishable Key é a chave correta para o frontend.

## Publicação no GitHub Pages
1. Crie um repositório público.
2. Envie `index.html`, `styles.css`, `app.js` e `config.js` para a raiz do repositório. Os outros arquivos podem ficar lá também.
3. Vá em **Settings → Pages**.
4. Em **Build and deployment**, escolha **Deploy from a branch**.
5. Branch `main`, pasta `/ (root)` e salve.
6. Aguarde o GitHub publicar e abra o link Pages.

## Como usar
- O mestre clica em **Criar Sessão** e envia o código para os jogadores.
- Os jogadores entram com nome + código.
- No painel do mestre, clique em **Escolher Jogo**, escolha a atração e os participantes.
- Quem não foi selecionado assiste ao jogo; botões de ação aparecem apenas para participantes.
- O mestre pode entregar ou remover tickets pelo painel lateral.
- Quando uma atração termina, o mestre pode iniciar outra.

## Observação sobre “tempo real”
O frontend consulta o estado compartilhado aproximadamente a cada 1,2 segundo. Para uma mesa de RPG isso produz acompanhamento praticamente imediato, inclusive para espectadores e mestre, sem exigir configuração adicional do Realtime no Supabase.
