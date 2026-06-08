# Meta Ads Reporter

> Plataforma de monitoramento, análise e relatórios para gestores de tráfego pago no Meta Ads — construída inteiramente com Claude Code.

---

## Sumário

- [O Problema](#o-problema)
- [A Solução](#a-solução)
- [Demonstração](#demonstração)
- [Funcionalidades](#funcionalidades)
- [Stack Técnica](#stack-técnica)
- [Arquitetura](#arquitetura)
- [Como Rodar](#como-rodar)
- [Processo de Desenvolvimento com Claude](#processo-de-desenvolvimento-com-claude)
- [Linha do Tempo](#linha-do-tempo)
- [Próximos Passos](#próximos-passos)

---

## O Problema

Gestores de tráfego pago que operam múltiplas contas Meta Ads enfrentam diariamente:

- **Falta de visibilidade centralizada** — cada conta exige login separado no Gerenciador de Anúncios
- **Alertas tardios** — saldo zerado, criativo saturado e queda de CTR só são percebidos horas depois
- **Relatórios manuais** — montar relatório para cada cliente consome horas por semana
- **Ausência de benchmark** — impossível comparar performance entre clientes de forma estruturada
- **Zero rastreamento de decisões** — não há registro das ações tomadas por conta

---

## A Solução

O **Meta Ads Reporter** é uma plataforma local (self-hosted) que conecta diretamente à Meta Marketing API e oferece:

- Dashboard em tempo real com agrupamento por criticidade
- Diagnóstico automático de performance com rascunho de mensagem pronto para o cliente
- Alertas proativos via Telegram (saldo, performance, budget pace)
- Benchmark comparativo entre todas as contas gerenciadas
- Relatórios HTML profissionais com identidade visual da agência
- Notas operacionais por conta com histórico

Tudo isso sem depender de ferramentas pagas de terceiros — apenas a API oficial do Meta e infraestrutura própria.

---

## Demonstração

### Visão Geral — Dashboard com triagem por criticidade
![Visão Geral](docs/screenshots/overview.png)

Contas agrupadas em **Críticas**, **Atenção** e **Saudáveis**. Chips de alerta clicáveis filtram a lista instantaneamente. Timestamp de última atualização em tempo real.

### Conta Individual — Performance + Delta
![Conta Individual](docs/screenshots/account.png)

Métricas com **comparação vs período anterior** (▲▼ com %), presets de período (7/15/30 dias, Este mês, Mês anterior), funil de conversão, breakdown por plataforma e gráfico diário de gasto × mensagens.

### Diagnóstico Automático — IA Rule-Based
![Diagnóstico](docs/screenshots/diagnosis.png)

Score 0–100 com grade (Excelente/Bom/Atenção/Crítico), destaques positivos, alertas com ação recomendada e **rascunho pronto para enviar ao cliente via WhatsApp**.

### Benchmark de Contas
![Benchmark](docs/screenshots/benchmark.png)

Tabela comparativa entre todas as contas com destaque automático de melhor (verde) e pior (vermelho) valor por coluna.

### Modal de Configurações em Abas
![Configurações](docs/screenshots/config.png)

4 abas organizadas: **Geral** (monitor + Telegram), **Alertas** (regras customizadas), **Contas** (orçamento mensal + CPA alvo), **Integrações** (whitelabel + multi-token).

---

## Funcionalidades

### V1.0 — Fundação
| Funcionalidade | Descrição |
|---|---|
| Autenticação OAuth Meta | Login seguro via Meta, token com 60 dias de validade |
| Multi-conta | Gerencie qualquer número de contas de anúncio |
| Monitor de saldo | Verificação diária automática com alerta Telegram |
| Relatórios HTML | Exportação de relatório profissional (semanal/mensal) |

### V2.0 — Análise Avançada
| Funcionalidade | Descrição |
|---|---|
| Análise por criativo | CTR, CPM e custo por mensagem em nível de anúncio |
| Breakdown por placement | Distribuição de gasto e performance por plataforma |
| Whitelabel | Logo e nome da agência nos relatórios exportados |
| Exportação CSV | Dados brutos exportáveis por período |
| Histórico de tendências | Gráfico de evolução de métricas ao longo do tempo |
| Overview aprimorado | KPIs globais + agrupamento por status de saúde financeira |

### V3.0 — Inteligência & Gestão
| Funcionalidade | Descrição |
|---|---|
| Diagnóstico IA | Score 0-100 + rascunho automático para o cliente |
| Budget Pace | Projeção de gasto fim do mês vs orçamento configurado |
| Notas por conta | Registro de ações e observações operacionais por cliente |
| Regras de alerta customizadas | Gatilhos definidos pelo usuário (ex: CTR < 1%, frequência > 4) |
| Benchmark interno | Comparativo entre contas com melhor/pior valor destacado |
| Multi-token | Múltiplos logins Meta sem necessidade de logout |

### Melhorias Críticas de UX/UI
| Melhoria | Descrição |
|---|---|
| Date picker + presets | 7/15/30 dias, Este mês, Mês anterior — com datas preenchidas automaticamente |
| Delta vs período anterior | ▲▼ com percentual de variação em cada métrica |
| Chips clicáveis | Filtram a visão geral por tipo de alerta em um clique |
| Timestamp de atualização | "Atualizado às HH:mm" em cada contexto relevante |
| Diagnóstico automático | Gerado ao abrir a conta, sem clique manual |
| Modal em abas | Configurações reorganizadas em 4 abas (de 1 scroll único) |

---

## Stack Técnica

```
Backend
├── Node.js v22
├── Express 4.18
├── node-cron (agendamento de verificações)
├── express-session (autenticação)
└── dotenv

Frontend
├── HTML/CSS/JS vanilla (zero frameworks)
├── Chart.js (gráficos)
└── Meta Marketing API v20.0 (via fetch com retry + timeout)

Infraestrutura
├── PM2 (process manager)
├── Windows Task Scheduler (auto-start no boot)
└── Telegram Bot API (notificações)

Armazenamento
└── JSON files (atomic writes, sem banco de dados)
```

---

## Arquitetura

```
metaads/
├── server.js                    # Entry point Express
├── middleware/
│   └── auth.js                  # Validação de token + getTokenForAccount()
├── routes/
│   ├── auth.js                  # OAuth Meta, callback, add-token
│   ├── insights.js              # Métricas, diagnóstico, snapshots, ads, placements
│   ├── monitor.js               # Config, budget pace, benchmark, regras, tokens
│   └── notes.js                 # CRUD notas por conta
├── services/
│   ├── meta-api.js              # Chamadas Meta API (account/campaign/ad/placement)
│   ├── storage.js               # Leitura/escrita JSON (atomic writes)
│   ├── diagnostics.js           # Engine de diagnóstico rule-based
│   ├── balance-monitor.js       # Verificação diária + budget pace + regras custom
│   └── report-generator.js      # Geração de relatório HTML whitelabel
├── public/
│   └── index.html               # SPA completa (~4000 linhas, Chart.js incluso)
└── data/
    ├── token.json               # Token principal
    ├── tokens.json              # Multi-token
    ├── monitor-config.json      # Configurações do monitor
    ├── monitor-log.json         # Histórico de alertas
    ├── notes.json               # Notas por conta
    ├── alert-rules.json         # Regras de alerta customizadas
    ├── insights/                # Cache de métricas por conta/período
    └── snapshots/               # Histórico diário para tendências
```

### Fluxo de Dados

```
Meta API → meta-api.js → storage.js → routes → index.html
                                    ↓
                          balance-monitor.js → Telegram Bot
                                    ↓
                          diagnostics.js → rascunho cliente
```

---

## Como Rodar

### Pré-requisitos
- Node.js v18+
- Conta de desenvolvedor Meta com app configurado
- Bot do Telegram (opcional, para alertas)

### Instalação

```bash
git clone https://github.com/seuusuario/meta-ads-reporter
cd meta-ads-reporter
npm install
```

### Configuração

Crie um arquivo `.env` na raiz:

```env
SESSION_SECRET=sua_chave_secreta_aqui
META_APP_ID=seu_app_id_meta
META_APP_SECRET=seu_app_secret_meta
META_REDIRECT_URI=http://localhost:3000/auth/callback
PORT=3000
```

### Iniciar

```bash
# Desenvolvimento
npm run dev

# Produção com PM2
npx pm2 start server.js --name metaads
npx pm2 save
```

Acesse: `http://localhost:3000`

---

## Processo de Desenvolvimento com Claude

Este projeto foi desenvolvido **integralmente com Claude Code**, da concepção até a auditoria de UX/UI e correção de bugs.

### Como o Claude foi usado

**1. Scaffolding inicial**
O Claude gerou a estrutura completa do projeto — Express, rotas, middleware de autenticação OAuth, integração com a Meta API — a partir de uma descrição em linguagem natural do problema.

**2. Iterações de feature**
Cada versão (V1, V2, V3) foi implementada em sessões de chat. O Claude leu os arquivos existentes, entendeu o contexto e adicionou features sem quebrar o que já existia.

**3. Debug em tempo real**
Quando o PM2 gerava `EPERM` no pipe após reinício do Windows (conflito de permissões elevadas), o Claude diagnosticou a causa raiz e propôs o workaround de matar o processo na porta 3000 para o PM2 auto-reiniciar.

**4. Auditoria de UX/UI**
Com acesso ao browser via extensão Chrome, o Claude navegou pelo sistema, capturou screenshots de todas as telas e produziu um relatório de auditoria completo com heurísticas de Nielsen, tabela de funcionalidades e roadmap priorizado — como uma consultoria profissional.

**5. Implementação das melhorias**
As 6 melhorias críticas identificadas na auditoria foram implementadas em uma única sessão, incluindo date picker com presets, delta vs período anterior, chips clicáveis e reorganização do modal em abas.

**6. Verificação ao vivo**
O Claude testou cada melhoria no browser após o deploy, identificou um bug (`display: ''` vs `display: 'block'`), corrigiu e confirmou visualmente que tudo funcionava.

### Exemplos de prompts utilizados

> *"Vamos fazer a Versão 2.0 (3-5 meses)"* → Claude planejou e implementou 6 features de análise avançada

> *"Assuma o papel de um Especialista Sênior em UX/UI... realize uma auditoria completa"* → Claude navegou pelo app, tirou screenshots e entregou relatório executivo de 8 seções

> *"Vamos fazer essas melhorias críticas"* → Claude implementou todas as melhorias identificadas na própria auditoria

---

## Linha do Tempo

```
Sessão 1  ──  Scaffolding + OAuth + Monitor de saldo + Relatórios
Sessão 2  ──  Fix PM2/Windows Task Scheduler (EPERM no named pipe)
Sessão 3  ──  V2.0: Criativos, Placements, Whitelabel, CSV, Tendências
Sessão 4  ──  V3.0: Diagnóstico IA, Budget Pace, Notas, Regras, Benchmark, Multi-token
Sessão 5  ──  Auditoria UX/UI completa (8 seções, heurísticas Nielsen)
Sessão 6  ──  6 melhorias críticas implementadas + verificação ao vivo no browser
```

---

## Métricas do Projeto

| Métrica | Valor |
|---|---|
| Linhas de código (frontend) | ~4.000 |
| Linhas de código (backend) | ~1.200 |
| Endpoints de API | 18 |
| Features implementadas | 22 |
| Bugs corrigidos em sessão | 3 |
| Tempo estimado sem Claude | 3–4 semanas |
| Tempo real com Claude | ~6 sessões |

---

## Próximos Passos

### Curto prazo
- [ ] Ordenação de colunas no Benchmark (clique no header)
- [ ] Diagnóstico movido para o topo da conta (antes dos gráficos)
- [ ] Confirmação ao excluir nota
- [ ] Tooltips explicativos nas métricas e barras de progresso
- [ ] Card inteiro clicável na Visão Geral

### Médio prazo
- [ ] Tour de onboarding no primeiro acesso (wizard 3 passos)
- [ ] Histórico de diagnósticos por conta (últimos 5 registros)
- [ ] Export do Benchmark em CSV/PDF
- [ ] Notificação Telegram proativa quando score cair para "Crítico"
- [ ] Sparklines de tendência nas linhas do Benchmark

### V4.0 — Roadmap
- [ ] Dashboard público para o cliente (link compartilhável read-only)
- [ ] Envio automático do rascunho por e-mail
- [ ] Comparativo mês a mês automatizado
- [ ] Score da conta visível na sidebar

---

## Autor

**Breno Rocha** — Gestor de Tráfego & Desenvolvedor  
Projeto desenvolvido com [Claude Code](https://claude.ai/code) · Anthropic

---

*Construído com Claude Code — da ideia ao produto em produção.*
