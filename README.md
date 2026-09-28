# garcias-home · servidor da casa

O Raspberry Pi 4 (10.255.200.100) virou o servidor local da casa. Ele continua ligado à TV mostrando a
[Blizzard](https://github.com/helioinmidia/blizzard) e hospeda as outras aplicações de uso doméstico:
rotina, manutenções e o que vier.

Este repositório tem o **proxy de entrada** ([Caddy](https://caddyserver.com/)): ele atende a porta 80 e
separa as aplicações pelo nome.

| Endereço | Aplicação | Onde roda |
| --- | --- | --- |
| `http://view.blizzard.net/` | Blizzard, a central de monitoramento | repositório `blizzard`, nginx em `127.0.0.1:8080` |
| `http://casa.blizzard.net/` | Portal da casa, com a lista das aplicações | `casa/index.html` |
| `http://casa.blizzard.net/rotina/` | Rotina da Ana Liz (link permanente do iPad) | `casa/rotina/` |
| `http://casa.blizzard.net/manutencao/` | Manutenção da casa (cronograma a criar) | `casa/manutencao/` |

O IP do Pi (`http://10.255.200.100/`), ou qualquer outro nome, abre o mesmo portal.

## Estrutura

```
Caddyfile            nomes e rotas do proxy de entrada
docker-compose.yml   o Caddy (porta 80) e a API da rotina (127.0.0.1:8081)
install.sh           tira a Blizzard da porta 80 e sobe o Caddy e a API da rotina
casa/                o portal, servido em casa.blizzard.net
  index.html         página inicial com a lista das aplicações
  casa.css           estilo comum às páginas do portal
  rotina/            Rotina da Ana Liz (aplicação: index.html, app.js, rotina.css)
    rotina.json      horários e atividades de cada dia da semana
    cartaz.html      o cartaz original, para imprimir
  manutencao/        Manutenção da casa
api/rotina.py        API da rotina: o que foi feito e os comentários, por dia
dados/               gravado pelas APIs no Pi (fora do git)
```

Uma aplicação estática é uma subpasta de `casa/`: basta criar `casa/<nome>/index.html` e pôr o link no
portal. Mudanças nos arquivos valem na hora, sem reiniciar nada.

## Instalação

A Blizzard precisa estar atualizada, porque o instalador tira ela da porta 80:

```bash
cd ~/blizzard && git pull
git clone https://github.com/helioinmidia/garcias-home.git ~/garcias-home
cd ~/garcias-home && ./install.sh
sudo reboot
```

O `install.sh`:

1. grava `BLIZZARD_WEB_LISTEN=127.0.0.1:8080` no `.env` da Blizzard;
2. recria o container `blizzard-web` nessa porta;
3. sobe o Caddy na porta 80.

O reboot serve para o quiosque da TV reabrir a Blizzard já na porta nova.

### Atualizar

```bash
cd ~/garcias-home && git pull && ./install.sh
```

Pode rodar quantas vezes quiser. Ele sobe o que faltar (a API da rotina, por exemplo) e reinicia o Caddy.
O reinício é necessário porque o `Caddyfile` é montado como arquivo e o `git pull` o substitui. Não
precisa reiniciar o Pi de novo.

## DNS

Cada nome precisa apontar para `10.255.200.100` no DNS da rede, que é o do gateway `10.255.200.254`.
No UniFi, o caminho é *Settings → Routing → DNS* (ou *Policy Table → DNS Records*, conforme a versão):
crie um registro **A** por aplicação. Se o gateway aceitar curinga, um único `*.blizzard.net` cobre
todas as aplicações futuras.

Antes do DNS, dá para testar no próprio Pi:

```bash
curl -sI -H 'Host: casa.blizzard.net' http://127.0.0.1/ | head -1
```

## Rotina no iPad

O link permanente da rotina é **`http://casa.blizzard.net/rotina/`**.

1. Abra o link no Safari do iPad.
2. Toque em *Compartilhar → Adicionar à Tela de Início*. O ícone "Rotina" abre a página em tela cheia,
   sem a barra do Safari.
3. Para a tela não apagar, vá em *Ajustes → Tela e Brilho → Bloqueio Automático → Nunca*, com o iPad no
   carregador. Para travar o iPad só na rotina, use o *Acesso Guiado*, em *Ajustes → Acessibilidade*.

A página confere o servidor a cada 5 minutos. Quando algum arquivo dela muda (depois de um
`git pull` no Pi), ela se recarrega sozinha e ninguém precisa mexer no iPad.

## Rotina: como funciona

- **Cabeçalho:** dia da semana, data, relógio, a atividade de agora e a próxima, a contagem de
  atividades feitas e a barra de progresso.
- **Cada atividade** tem um botão de feito (toque de novo para desmarcar) e um botão de comentário.
  O comentário é salvo sozinho enquanto a pessoa escreve.
- **Tudo fica gravado no Pi**, nunca no navegador. Um arquivo por dia em `dados/rotina/AAAA-MM-DD.json`,
  gravado pela API `api/rotina.py`, publicada em `casa.blizzard.net/rotina/api/`. iPad, celulares e
  laptop veem o mesmo estado; uma marcação feita num aparelho aparece nos outros em até 10 segundos.
- **Faixa da semana:** logo abaixo do cabeçalho, um botão por dia (segunda a domingo) com a barra de
  progresso daquele dia; o dia completo fica verde. Toque num dia para vê-lo. É o resumo para a
  revisão de domingo.
- **Outros dias:** a faixa e as setas ‹ › mostram os dias anteriores (histórico) e os próximos. Sem
  ninguém mexendo, a tela volta sozinha para hoje depois de 3 minutos, e troca de dia à meia-noite.
- **Mudar horários ou atividades:** edite `casa/rotina/rotina.json`.
  - `diasDaSemana` vai de 0 (domingo) a 6 (sábado).
  - `horaPorDia` e `descricaoPorDia` trocam a hora ou o texto em dias específicos.
  - `quem` são as pessoas que devem estar e `podem` as que podem estar.
  - Mantenha o `id` de uma atividade ao editá-la: é por ele que as marcações antigas são encontradas.

Para conferir a API no Pi: `curl -s -H 'Host: casa.blizzard.net' http://127.0.0.1/rotina/api/saude`.
As rotas estão no cabeçalho de `api/rotina.py` (`/dia/<data>`, `/dias?de=&ate=`, `PUT /dia/<data>/tarefa/<id>`).

## Publicar uma aplicação com servidor próprio

Cada aplicação vive no próprio repositório, com o próprio `docker compose`, e escuta **só em
`127.0.0.1`**, numa porta livre (8082, 8083…). Assim ela não aparece na rede sem passar pelo proxy.

1. Suba a aplicação, por exemplo em `127.0.0.1:8082`.
2. Acrescente um bloco ao `Caddyfile`:
   ```caddy
   http://manutencao.blizzard.net {
   	reverse_proxy 127.0.0.1:8082
   }
   ```
   Para ela ficar dentro do portal (`casa.blizzard.net/<nome>/`), use `handle_path /<nome>/*` com o
   `reverse_proxy` dentro do bloco `casa.blizzard.net`, desde que a aplicação funcione num subcaminho.
3. Recarregue o Caddy sem derrubar nada:
   ```bash
   sudo docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
   ```
4. Crie o nome no DNS, se for um nome novo, e acrescente o item em `casa/index.html`.

### Portas em uso no Pi

| Porta | Quem usa | Visível na rede |
| --- | --- | --- |
| 80 | Caddy (este repositório) | sim |
| 8080 | nginx da Blizzard | não (127.0.0.1) |
| 8081 | API da rotina (este repositório) | não (127.0.0.1) |
| 8787 | API de configuração da Blizzard | não (127.0.0.1) |
| 8099 | ponte do Home Assistant da Blizzard | não (127.0.0.1) |
| 1984 | go2rtc, API e painel | sim |
| 8554 | go2rtc, RTSP | sim |
| 8555 | go2rtc, WebRTC (TCP e UDP) | sim, necessária para o vídeo |

## Recursos do Pi 4

O Chromium da TV decodificando vídeo é o que mais pesa no Pi. As aplicações da casa devem ser leves:
páginas estáticas, ou serviços pequenos em Python ou Node com SQLite.

Evite bancos pesados (Postgres, Mongo) e tudo que transcodifique vídeo. Para acompanhar o consumo:

```bash
sudo docker stats --no-stream
```
