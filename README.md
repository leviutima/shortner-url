# shortner-url

Encurtador de URL construído como projeto de estudo de backend e system design. O objetivo não é entregar um produto, é passar por cada decisão de arquitetura com o raciocínio registrado: por que cada escolha foi feita, o que ela custa e quando ela deixa de servir.

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Fastify + TypeScript (strict) |
| Banco | PostgreSQL |
| Cache | Redis |
| Testes | Vitest |
| Front | Vite + React (pasta `ui/`) |

Fastify foi escolhido no lugar de Express e Nest por três motivos: schema declarativo no request e na response, que transforma validação e serialização em contrato explícito; encapsulamento por plugin com hooks de ciclo de vida, que torna visível onde entra auth, rate limit e log; e contrato explícito em schema, que reduz ambiguidade para ferramentas de geração de código.

## Estrutura

```
api/
  src/
    lib/            funções puras, sem dependência de framework
      base62.ts     conversão numérica para o código curto
      url-validator.ts
    plugins/        transversais (banco, cache, erro)
      error-handler.ts
    repositories/   acesso a dados, só SQL
    services/       regra de negócio
    routes/
      health/
      links/
      redirect/
    app.ts
  specs/            requisitos numerados (REQ-001 em diante)
  test/
```

### Regra de dependência

Rota não sabe SQL. Service não sabe HTTP. Repository não sabe regra de negócio. `lib/` não sabe nada.

- **Rota** recebe a requisição, valida o schema, chama o service e devolve o status.
- **Service** decide: valida a URL, gera o código, chama o repository, decide se usa cache.
- **Repository** executa a query e devolve dado.
- **lib** é função pura, testável sem subir servidor.

Consequência prática dessa regra: `validateUrl` **retorna** `{ ok: false, error }` em vez de lançar exceção HTTP. Ele está em `lib/` e não pode conhecer status code. Quem converte o resultado em `AppError` é o service, que é a camada que conhece o contexto da aplicação.

## Decisões de design

O documento completo está em `DESIGN.md`. O resumo das decisões que moldam o código:

### Estimativa

| Métrica | Valor |
|---|---|
| Links criados por dia | 100.000 |
| Links por ano | 36.500.000 |
| Razão leitura/escrita | 100:1 |
| Leituras por dia | 10.000.000 |
| QPS médio de leitura | ~116 |
| QPS de pico | ~347 |
| Tabela de links | ~9 GB/ano |
| Tabela de cliques (bruta) | ~730 GB/ano |

A razão de 100:1 é o número que define o resto: leitura é a operação dominante, então o caminho de leitura é o que recebe otimização, e a escrita pode ser mais cara.

### Base62 com 7 caracteres

Base62 são os 62 símbolos alfanuméricos: 10 dígitos, 26 minúsculas e 26 maiúsculas. É o maior alfabeto que atravessa uma URL sem escape. Base64 seria maior, mas inclui `+` e `/`, que já têm significado em URL e exigiriam `%2B` e `%2F`, alongando o código em vez de encurtá-lo.

Duas decisões independentes:

- **A base define o comprimento.** Mais símbolos por posição, menos posições para o mesmo intervalo de valores.
- **O número de posições define a colisão.** `62^7 = 3,5 trilhões`, então mesmo depois de 10 anos o espaço fica 0,01% ocupado.

Com 5 caracteres o espaço já estaria 40% ocupado no ano 10, e cada geração aleatória colidiria com frequência, gastando consulta extra ao banco. Com 7, a colisão é rara o bastante para quase nunca exigir segunda tentativa. O custo são 2 caracteres a mais na URL.

### Geração do código: base62 sobre id sequencial

**Escolhido:** converter o id autoincrement do Postgres para base62.

**Ganho:** nunca colide, não precisa consultar o banco antes de gravar, uma operação a menos por criação.

**Perda:** o código é previsível e enumerável. Alguém pode contar de 1 em diante e varrer todos os links do serviço, expondo destinos que dependiam de ninguém adivinhar a URL. Além disso, comparar dois códigos criados em datas diferentes revela o volume de criação no período.

**Mitigação:** o id inicia em 916.132.832 (`62^5`), para nenhum código nascer com menos de 6 caracteres.

**Revisitar quando:** o serviço passar a hospedar link com expectativa de privacidade. Aí a enumeração vira risco real e a decisão muda para geração aleatória com checagem de colisão.

### Retenção em camadas para cliques

A tabela de cliques cresce 80 vezes mais rápido que a de links. Guardar uma linha por clique dá 730 GB por ano, e nenhum requisito precisa desse detalhe indefinidamente.

| Camada | Formato | Retenção | Serve para |
|---|---|---|---|
| Quente | uma linha por clique | 30 dias | investigar caso específico, detectar fraude |
| Fria | agregado por link e por dia | indefinida | as métricas do REQ-023 |

Job noturno agrega o dia anterior e derruba a partição de 31 dias atrás. A tabela é particionada por dia justamente por isso: `DELETE` de 2 GB é caro e trava a tabela, derrubar uma partição é instantâneo.

Custo final: 60 GB fixos na camada quente mais 9 GB por ano na fria.

### 302 e não 301

O 301 é cacheado pelo navegador, e a partir do segundo clique a requisição nem chega ao servidor. Isso zera a contagem de cliques, que é feature do produto.

## Segurança

O princípio que atravessa o projeto: **validar na entrada, não na saída.** Se o dado sujo nunca entra, nenhuma feature futura consegue usá-lo. Validar na saída depende de todo consumidor lembrar de tratar, e basta um esquecer.

### Esquema restrito a http e https

O construtor `URL` aceita qualquer esquema sem reclamar, incluindo `javascript:`, `data:` e `file:`. Um `javascript:` gravado no banco e renderizado num `href` na tela de estatística executa código no domínio do próprio serviço, com acesso aos cookies dos usuários.

### Bloqueio de destino interno (SSRF)

Hoje o servidor não busca a URL de destino, apenas devolve `Location`. Mas preview de link, verificação de disponibilidade e checagem de phishing são features previsíveis, e todas fazem o servidor buscar a URL escolhida por um terceiro.

O servidor está dentro da rede, atrás do firewall, e alcança o que ninguém de fora alcança: o Postgres em `localhost:5432`, o Redis em `127.0.0.1:6379`, o endpoint de metadados da nuvem em `169.254.169.254`, que devolve credenciais da máquina.

A validação existe agora porque quem adicionar o preview depois não vai lembrar de voltar e validar a entrada, e o dado sujo já vai estar gravado.

### Erro sem vazamento

Todo erro responde no formato `{ error: { code, message } }`. Erro esperado é lançado como `AppError`, que carrega código e status. Qualquer outra exceção vira `INTERNAL_ERROR` com status 500, e o erro completo vai para o log do servidor.

O motivo: mensagem de driver de banco costuma conter nome de tabela, estrutura interna e às vezes fragmento da string de conexão. Isso não pode chegar ao cliente.

### Dado pessoal em clique

O registro de clique guarda o hash do IP com salt, nunca o IP completo.

## Requisitos

Os requisitos ficam em `specs/links.md`, numerados como `REQ-001` em diante, no formato:

```markdown
## REQ-004 — URL malformada é rejeitada

**When** a URL enviada não pode ser parseada como URL absoluta,
**the system shall** rejeitar com `400` e código de erro `INVALID_URL`.
```

Cada requisito descreve comportamento observável de fora: status HTTP, código de erro nomeado, efeito persistido. Nenhum menciona biblioteca, nome de função ou estrutura de pasta.

## Ordem de construção

A sequência segue a dependência: o que não depende de nada vem primeiro.

1. `lib/base62.ts`
2. `lib/url-validator.ts`
3. `plugins/error-handler.ts`
4. `plugins/db.ts` e migration
5. `repositories/link.repository.ts`
6. `services/link.service.ts`
7. `routes/links/` (POST /links)
8. `routes/redirect/` (GET /:code)

Cache, contagem de cliques, rate limit e idempotência entram depois.

## Como rodar

```bash
cd api
npm install
npm run dev
```

Checagem de tipos:

```bash
npx tsc --noEmit
```

Testes:

```bash
npm test
```

## Dívidas conhecidas

- **ESM versus CJS.** O Fastify compilado por `tsc` sai em CommonJS e parte do ferramental do ecossistema é ESM only. A decisão de migrar o projeto inteiro para ESM ou isolar as ferramentas em arquivos `.mts` fica para o dia do Docker.
- **Faixa completa de IP privado.** A validação de SSRF cobre hoje `localhost`, `127.0.0.1` e `::1`. Falta a faixa completa (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`) e a resolução de DNS, já que um domínio público pode apontar para IP interno.
- **Rebind de DNS.** Validar o hostname na criação não impede que o domínio passe a apontar para IP interno depois. A validação real precisa acontecer também no momento da requisição.
