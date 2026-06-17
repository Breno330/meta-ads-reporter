# Deploy — Meta Ads Reporter (Render + domínio próprio)

Guia para publicar o sistema de forma confiável (dados persistentes, alertas
rodando 24/7 e link seguro para compartilhar).

## Por que o plano free não serve
No plano **free** do Render:
- O serviço **dorme após ~15 min** de inatividade → os agendamentos (`node-cron`:
  monitor de saldo, relatório semanal, performance) **não disparam** enquanto dorme.
- O disco é **efêmero** → tudo gravado em `data/` (orçamentos, tokens, sessões,
  relatórios) é **apagado** a cada sleep/deploy.
- Disco persistente é recurso **pago** (Starter+), então o `disk:` declarado
  aqui **só funciona no Starter**.

## Custos (preços do Render — confirmar no painel)
| Item | Custo |
|---|---|
| Plano Starter | ~US$ 7/mês (cobrança proporcional ao mudar) |
| Disco persistente 1 GB | ~US$ 0,25/mês |
| **Total** | **~US$ 7,25/mês** |
| Domínio `multiform.com.br` | R$ 0 se já for da agência; ~R$ 40/ano se registrar |

Precisa de cartão de crédito cadastrado no Render.

## ⚠️ Atenção: serviço gerenciado pelo painel vs. blueprint
O serviço no ar chama-se **`meta-ads-reporter-hml`**, mas este `render.yaml`
define `name: meta-ads-reporter`. O nome do blueprint (`meta-ads-reporter.onrender.com`)
responde 404 → indício de que o serviço `-hml` foi **criado manualmente pelo painel**,
e não por este blueprint.

Consequência: para o serviço `-hml`, o que vale é a **configuração no painel**
(este `render.yaml` serve de referência/documentação). Faça os ajustes de plano
e disco **pelo painel** do serviço `-hml`.

## Passo a passo

### 1. Plano + disco (painel do Render, serviço `-hml`)
1. **Settings → Instance Type → Starter**.
2. **Settings → Disks → Add Disk**:
   - Name: `data`
   - Mount Path: `/opt/render/project/src/data`
   - Size: `1 GB`
3. O Render redeploia. O disco começa **vazio** (o dado efêmero anterior já se perdia mesmo).

> O `mountPath` precisa ser exatamente `/opt/render/project/src/data`, que é a pasta
> `data/` usada pelo app (`path.join(__dirname, 'data')`).

### 2. Domínio próprio (subdomínio recomendado)
Usar `painel.multiform.com.br` (não mexe no site principal):
1. Render → serviço → **Settings → Custom Domains → Add** → `painel.multiform.com.br`.
2. O Render mostra um destino CNAME. No DNS do `multiform.com.br`, crie:
   - Tipo `CNAME`, Host `painel`, Valor = (destino que o Render mostrou).
3. Aguarde o Render verificar e emitir o SSL (automático, alguns minutos).

### 3. Variáveis de ambiente (painel do Render → Environment)
```
APP_BASE_URL = https://painel.multiform.com.br
REDIRECT_URI = https://painel.multiform.com.br/auth/callback
```
Manter: `META_APP_ID`, `META_APP_SECRET`, `SESSION_SECRET`, `APP_PASSWORD`, `NODE_ENV=production`.

### 4. App da Meta (developers.facebook.com)
Seu app → **Login do Facebook → Configurações → URIs de redirecionamento OAuth válidos**:
```
https://painel.multiform.com.br/auth/callback
```

### 5. Validar
1. Abrir `https://painel.multiform.com.br` (sem aviso "Site perigoso").
2. Login com Meta (escopo `public_profile` já traz o nome).
3. Configurações → **Orçamento Mensal por Conta** → preencher → salvar.
4. Voltar e recarregar a tela: os orçamentos **persistem**.
5. Visão Geral → **Relatório de orçamento** → o link sai com o domínio próprio.

## Notas
- Tudo é controlado por variáveis de ambiente; **não há nada hardcoded** que
  precise mudar no código ao trocar de domínio.
- O `REDIRECT_URI` em `routes/auth.js` tem apenas um *default* de localhost;
  com a env definida no Render, o default nunca é usado.
- Sessões persistem em `data/sessions/` (já no `.gitignore` via `data/`), então
  com o disco persistente os logins sobrevivem a restart/deploy.
