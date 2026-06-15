const storage  = require('./storage');
const telegram = require('./telegram');

const API_VERSION = 'v20.0';
const BASE        = `https://graph.facebook.com/${API_VERSION}`;

// Helper: fetch autenticado via Authorization header
// • Timeout automático de 15 s via AbortController
// • Retry com backoff exponencial (até 3 tentativas) em erros de rede ou 5xx
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiFetch(url, token, attempt = 1) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 15_000);
  let res;
  try {
    res = await globalThis.fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal:  controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (attempt < 3) {
      await sleep(1_000 * 2 ** (attempt - 1)); // 1 s, 2 s
      return apiFetch(url, token, attempt + 1);
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.status >= 500 && attempt < 3) {
    await sleep(1_000 * 2 ** (attempt - 1));
    return apiFetch(url, token, attempt + 1);
  }
  return res;
}

// ── Busca saldo e calcula dias restantes ─────────────────────────────────────

async function getBalanceInfo(token, accountId, days = 7) {
  // Busca spend diário para 2× o período (atual + anterior para comparação)
  function toISODate(d) { return d.toISOString().split('T')[0]; }
  const today = new Date();

  // Para "mês atual" (days = 0 no frontend → recalculado como daysInMonth no cliente,
  // mas aqui tratamos como: período = do dia 1 do mês até hoje, comparação = mesmo N de dias antes)
  // days chega já calculado como nDias do mês corrente quando vier do botão "Mês atual"
  // Porém o "since" precisa começar no dia 1 do mês, não `days` dias atrás.
  // Detectamos isso: se days === diasNoMêsAtual, usamos início do mês como âncora.
  const diasNoMes     = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const diaHoje       = today.getDate(); // 1-based
  const isMesAtual    = (days === diasNoMes); // heurística: se days == total de dias do mês

  let sinceD, periodLen;
  if (isMesAtual) {
    // Período atual: dia 1 até hoje (diaHoje dias)
    // Período anterior: mesmo número de dias antes do dia 1
    periodLen = diaHoje; // dias já corridos no mês
    sinceD    = new Date(today.getFullYear(), today.getMonth(), 1 - periodLen); // início do período anterior
  } else {
    periodLen = days;
    sinceD    = new Date(); sinceD.setDate(today.getDate() - (days * 2 - 1));
  }

  const totalFetchDays = isMesAtual ? periodLen * 2 : days * 2;

  // Saldo e gasto diário são independentes → dispara as duas chamadas em paralelo.
  // (antes eram sequenciais, dobrando a latência por conta na visão geral)
  const [balanceRes, insightRes] = await Promise.all([
    apiFetch(`${BASE}/${accountId}?fields=balance,currency,name,funding_source_details,account_status,disable_reason`, token),
    apiFetch(
      `${BASE}/${accountId}/insights?fields=spend` +
      `&time_range=${encodeURIComponent(JSON.stringify({ since: toISODate(sinceD), until: toISODate(today) }))}` +
      `&time_increment=1&level=account&limit=200`,
      token
    )
  ]);
  const [balanceData, insightData] = await Promise.all([balanceRes.json(), insightRes.json()]);

  if (balanceData.error) throw new Error(balanceData.error.message);

  // funding_source_details.display_string contém o valor exato exibido no painel do Meta
  // Ex: "Saldo disponível (R$126,02 BRL)" — já está em reais (não centavos)
  const displayString = balanceData.funding_source_details?.display_string || '';
  const match = displayString.match(/R\$([\d.]+,\d{2})/);
  let balance;
  if (match) {
    // Converte formato BR (1.234,56) para float
    balance = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
  } else {
    // Fallback: campo balance da API (em centavos)
    balance = parseFloat(balanceData.balance || 0) / 100;
  }
  const name = balanceData.name || accountId;

  // Segue paginação se houver (para períodos muito longos)
  let allRows = [...(insightData.data || [])];
  let nextUrl = insightData.paging?.next;
  while (nextUrl) {
    const pageRes  = await apiFetch(nextUrl, token);
    const pageData = await pageRes.json();
    allRows = allRows.concat(pageData.data || []);
    nextUrl = pageData.paging?.next || null;
  }

  // Monta mapa date → spend (API omite dias com gasto zero)
  const spendMap = {};
  allRows.forEach(d => { spendMap[d.date_start] = parseFloat(d.spend || 0); });

  // Gera arrays para 2× o período
  const allDates = [], allSpends = [];
  for (let i = totalFetchDays - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const ds = toISODate(d);
    allDates.push(ds);
    allSpends.push(spendMap[ds] || 0);
  }

  // Período atual (últimos periodLen dias) vs período anterior
  const periodSpends  = allSpends.slice(periodLen);
  const prevSpends    = allSpends.slice(0, periodLen);
  const periodDates   = allDates.slice(periodLen);

  const weekSpend     = periodSpends.reduce((s, v) => s + v, 0);
  const prevWeekSpend = prevSpends.reduce((s, v) => s + v, 0);
  const weekChange    = prevWeekSpend > 0 ? ((weekSpend - prevWeekSpend) / prevWeekSpend * 100) : null;

  // Sparkline: gasto diário do período selecionado
  const spendHistory = periodSpends;
  const spendDates   = periodDates;

  // Tipo de pagamento
  const fundingType = balanceData.funding_source_details?.type;
  const paymentMethodMap = {
    1:  'Cartão de crédito',
    2:  'Conta bancária',
    3:  'Facebook Payments',
    7:  'PayPal',
    8:  'Débito direto',
    10: 'Pagamento mobile',
    13: 'Cartão pré-pago',
    15: 'Crédito estendido',
    16: 'Fatura',
    17: 'Pré-pago',
    20: 'Saldo pré-pago',
  };
  const paymentMethod = paymentMethodMap[fundingType] || (fundingType ? `Tipo ${fundingType}` : 'Não identificado');

  // Dias restantes no mês atual (incluindo hoje)
  const lastDay        = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const daysRemaining  = lastDay - today.getDate() + 1;
  const dailyBudget    = daysRemaining > 0 ? balance / daysRemaining : 0;

  // ── Detecção de problema de cobrança (pós-pago / cartão) ─────────────────
  const accountStatus = balanceData.account_status;
  const disableReason = balanceData.disable_reason;

  // account_status: 1=Ativo, 2=Desabilitado, 3=Unsettled, 9=Grace Period
  // disable_reason: 3=RISK_PAYMENT (problema de cobrança)
  const isPostPaid = [1, 2, 15, 16].includes(fundingType); // cartão, crédito, fatura
  const billingProblemStatus = [3, 9].includes(accountStatus); // Unsettled ou Grace Period
  const billingDisabled = accountStatus === 2 && disableReason === 3; // Desabilitado por pagamento

  let billingIssue = null;
  if (billingProblemStatus || billingDisabled) {
    const statusLabels = { 2: 'Conta desabilitada', 3: 'Pagamento pendente', 9: 'Período de carência' };
    billingIssue = {
      status:     accountStatus,
      reason:     disableReason,
      isPostPaid,
      label:      statusLabels[accountStatus] || `Status ${accountStatus}`,
      message:    billingDisabled
        ? 'Conta desabilitada por problema de cobrança no cartão'
        : accountStatus === 3
          ? 'Pagamento pendente — campanhas podem parar em breve'
          : 'Conta em período de carência — risco de interrupção'
    };
  }

  return { accountId, name, balance, dailyBudget, daysRemaining, paymentMethod, fundingType, accountStatus, billingIssue, weekSpend, prevWeekSpend, weekChange, spendHistory, spendDates };
}

// ── Verifica campanhas paradas ───────────────────────────────────────────────

async function checkStoppedCampaigns(token, accountId, accountName) {
  function toISODate(d) { return d.toISOString().split('T')[0]; }

  const today  = new Date();
  const since  = new Date(); since.setDate(today.getDate() - 6); // últimos 7 dias

  const url = `${BASE}/${accountId}/insights?fields=campaign_name,campaign_id,spend` +
    `&time_range=${encodeURIComponent(JSON.stringify({ since: toISODate(since), until: toISODate(today) }))}` +
    `&level=campaign&time_increment=1`;

  const res  = await apiFetch(url, token);
  const data = await res.json();
  if (data.error) return [];

  // Agrupa por campanha: { [campaign_id]: { name, spendByDate: { date: spend } } }
  const campaigns = {};
  for (const row of (data.data || [])) {
    if (!campaigns[row.campaign_id]) {
      campaigns[row.campaign_id] = { name: row.campaign_name, spendByDate: {} };
    }
    campaigns[row.campaign_id].spendByDate[row.date_start] = parseFloat(row.spend || 0);
  }

  // Identifica campanhas paradas: tinha gasto nos dias 3-7 atrás, mas zero nos últimos 2 dias
  const stopped = [];
  const d1 = toISODate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)); // ontem
  const d2 = toISODate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2)); // anteontem

  for (const [id, camp] of Object.entries(campaigns)) {
    const recentSpend = (camp.spendByDate[d1] || 0) + (camp.spendByDate[d2] || 0);
    const olderSpend  = Object.entries(camp.spendByDate)
      .filter(([d]) => d < d2)
      .reduce((s, [, v]) => s + v, 0);

    if (recentSpend === 0 && olderSpend > 0) {
      stopped.push({ campaignId: id, campaignName: camp.name, accountName, accountId });
    }
  }

  return stopped;
}

// ── Executa a verificação de todas as contas monitoradas ─────────────────────

async function runCheck() {
  // Multi-usuário: roda para cada usuário registrado
  const userIds = storage.getAllUserIds();
  if (userIds.length > 1) {
    const results = [];
    for (const uid of userIds) {
      const r = await runCheckForUser(uid);
      results.push({ userId: uid, ...r });
    }
    return { multiUser: true, results };
  }

  // Fallback single-user (retrocompatível)
  return runCheckForUser(null);
}

async function runCheckForUser(userId) {
  const config    = (userId ? storage.getUserMonitorConfig(userId) : null) || storage.getMonitorConfig();
  const tokenData = (userId ? storage.getUserToken(userId) : null)         || storage.getToken();

  if (!config?.enabled)              return { skipped: true, reason: 'Monitor desativado' };
  if (!tokenData || tokenData.expiresAt < Date.now()) return { skipped: true, reason: 'Token inválido' };
  if (!config.accounts?.length)      return { skipped: true, reason: 'Nenhuma conta configurada' };

  // ── Alerta de token expirando ──────────────────────────────────────────────
  const daysLeft = Math.floor((tokenData.expiresAt - Date.now()) / (1000 * 60 * 60 * 24));
  if ([7, 3, 1].includes(daysLeft) && config.telegramToken && config.telegramChatId) {
    // Evita enviar mais de uma vez no mesmo dia
    const alreadySentToday = storage.getMonitorLogs().some(l =>
      l.type === 'token_expiry_warning' &&
      l.daysLeft === daysLeft &&
      Date.now() - l.sentAt < 23 * 60 * 60 * 1000
    );
    if (!alreadySentToday) {
      const emoji = daysLeft === 1 ? '🚨' : '⚠️';
      await telegram.send(
        config.telegramToken,
        config.telegramChatId,
        `${emoji} *Token Meta Ads expirando em ${daysLeft} dia${daysLeft > 1 ? 's' : ''}!*\n\nAcesse o Meta Ads Reporter e faça login novamente para renovar o token antes que as verificações parem de funcionar.`
      );
      storage.saveMonitorLog({ type: 'token_expiry_warning', daysLeft, sentAt: Date.now() });
    }
  }

  const results        = [];
  const alerts         = [];
  const stoppedCamps   = [];
  const billingAlerts  = [];

  const globalThreshold = parseFloat(config.thresholdBalance) || 200;

  for (const accountId of config.accounts) {
    try {
      const info = await getBalanceInfo(tokenData.token, accountId);
      results.push({ ...info, status: 'ok' });

      // Usa limite por conta se definido, senão usa o limite global
      const threshold = parseFloat(config.accountThresholds?.[accountId]) || globalThreshold;
      if (info.balance <= threshold) {
        alerts.push({ ...info, threshold });
      }

      // Verifica problema de cobrança (cartão recusado / conta suspensa)
      if (info.billingIssue) {
        billingAlerts.push({ ...info });
      }

      // Verifica campanhas paradas
      const stopped = await checkStoppedCampaigns(tokenData.token, accountId, info.name);
      stoppedCamps.push(...stopped);
    } catch (err) {
      results.push({ accountId, status: 'error', error: err.message });
    }
  }

  // Alerta de saldo baixo — cooldown de 6h para não spammar em checks frequentes
  if (alerts.length > 0 && config.telegramToken && config.telegramChatId) {
    const recentAlertLog = storage.getMonitorLogs().find(l =>
      l.type === 'alert' &&
      Date.now() - l.sentAt < 6 * 60 * 60 * 1000
    );
    if (!recentAlertLog) {
      try {
        await telegram.send(config.telegramToken, config.telegramChatId, buildAlertMessage(alerts));
        storage.saveMonitorLog({ type: 'alert', accounts: alerts.map(a => a.name), sentAt: Date.now() });
      } catch (err) {
        storage.saveMonitorLog({ type: 'error', error: err.message, sentAt: Date.now() });
      }
    }
  }

  // Alerta de problema de cobrança — PRIORIDADE MÁXIMA
  if (billingAlerts.length > 0 && config.telegramToken && config.telegramChatId) {
    // Deduplicação: não reenvia o mesmo alerta de cobrança nas últimas 6 horas
    const recentBillingLog = storage.getMonitorLogs().find(l =>
      l.type === 'billing_alert' &&
      Date.now() - l.sentAt < 6 * 60 * 60 * 1000
    );
    if (!recentBillingLog) {
      try {
        await telegram.send(config.telegramToken, config.telegramChatId, buildBillingAlertMessage(billingAlerts));
        storage.saveMonitorLog({ type: 'billing_alert', accounts: billingAlerts.map(a => a.name), sentAt: Date.now() });
      } catch (err) {
        storage.saveMonitorLog({ type: 'error', error: err.message, sentAt: Date.now() });
      }
    }
  }

  // Alerta de campanhas paradas
  if (stoppedCamps.length > 0 && config.telegramToken && config.telegramChatId) {
    try {
      await telegram.send(config.telegramToken, config.telegramChatId, buildCampaignStopMessage(stoppedCamps));
      storage.saveMonitorLog({ type: 'campaigns_stopped', campaigns: stoppedCamps.map(c => c.campaignName), sentAt: Date.now() });
    } catch (err) {
      storage.saveMonitorLog({ type: 'error', error: err.message, sentAt: Date.now() });
    }
  }

  storage.saveMonitorLog({ type: 'check', results, checkedAt: Date.now() });

  return { results, alerts, stoppedCamps, billingAlerts };
}

// ── Monta a mensagem de alerta ────────────────────────────────────────────────

function buildAlertMessage(alerts) {
  const brl = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

  const accountLines = alerts.map(a =>
    `• *${telegram.mdSafe(a.name)}* — Saldo atual: ${brl(a.balance)} _(limite: ${brl(a.threshold)})_`
  ).join('\n');

  // Verifica se todos os limites são iguais para montar frase genérica ou por conta
  const uniqueThresholds = [...new Set(alerts.map(a => a.threshold))];
  const thresholdPhrase = uniqueThresholds.length === 1
    ? `abaixo de ${brl(uniqueThresholds[0])}`
    : `abaixo do limite configurado`;

  return [
    `⚠️ *Aviso de saldo baixo no Meta Ads*`,
    ``,
    accountLines,
    ``,
    `Identificamos que o saldo da${alerts.length > 1 ? 's' : ''} conta${alerts.length > 1 ? 's' : ''} está ${thresholdPhrase}. Para evitar a interrupção das campanhas e manter seus anúncios ativos, é necessário realizar uma recarga o quanto antes.`,
    ``,
    `Nos informe o valor que gostaria de realizar a recarga que enviamos o código para pagamento.`
  ].join('\n');
}

// ── Monta a mensagem de campanhas paradas ─────────────────────────────────────

function buildCampaignStopMessage(stopped) {
  const lines = stopped.map(c =>
    `• *${telegram.mdSafe(c.campaignName)}*\n  Conta: ${telegram.mdSafe(c.accountName)}`
  ).join('\n');

  return [
    `🛑 *Campanha(s) parada(s) detectada(s)*`,
    ``,
    lines,
    ``,
    `Essas campanhas tiveram gasto nos últimos dias mas estão sem gastar há 2 dias. Verifique se foram pausadas intencionalmente.`
  ].join('\n');
}

// ── Monta a mensagem de alerta de cobrança ────────────────────────────────────

function buildBillingAlertMessage(billingAlerts) {
  const lines = billingAlerts.map(a => {
    const paymentInfo = a.paymentMethod ? ` _(${a.paymentMethod})_` : '';
    return `• *${telegram.mdSafe(a.name)}*${paymentInfo}\n  ⚠️ ${a.billingIssue.message}`;
  }).join('\n\n');

  const count   = billingAlerts.length;
  const plural  = count > 1;
  const contaStr = plural ? `${count} contas` : 'uma conta';

  return [
    `🚨 *ALERTA DE COBRANÇA — Meta Ads*`,
    ``,
    lines,
    ``,
    `Identificamos problema de cobrança em ${contaStr}. As campanhas podem estar pausadas ou prestes a parar.`,
    ``,
    `Ação necessária: verifique o cartão de crédito cadastrado na conta do Meta e regularize o pagamento para retomar os anúncios.`
  ].join('\n');
}

// ── Helpers de link de relatório ─────────────────────────────────────────────

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const REPORTS_DIR   = path.join(__dirname, '..', 'data', 'reports');
const REPORT_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 dias

function ensureReportsDir() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function genToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Salva HTML do relatório e retorna a URL compartilhável.
 * Usa APP_BASE_URL se configurado; caso contrário retorna null
 * (o chamador vai enviar o arquivo HTML como fallback).
 */
function saveReportLink(html, meta) {
  ensureReportsDir();
  const token     = genToken();
  const expiresAt = Date.now() + REPORT_TTL_MS;
  const fullMeta  = { token, expiresAt, createdAt: Date.now(), ...meta };
  fs.writeFileSync(path.join(REPORTS_DIR, `${token}.html`), html, 'utf8');
  fs.writeFileSync(path.join(REPORTS_DIR, `${token}.json`), JSON.stringify(fullMeta), 'utf8');

  const baseUrl = (process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
  if (!baseUrl) return null; // sem URL pública configurada
  return `${baseUrl}/r/${token}`;
}

// ── Relatório semanal automático ──────────────────────────────────────────────

async function runWeeklyReports(reportType) {
  // Multi-usuário: roda para cada usuário
  const userIds = storage.getAllUserIds();
  if (userIds.length > 1) {
    const results = [];
    for (const uid of userIds) {
      const r = await runWeeklyReportsForUser(uid, reportType);
      results.push({ userId: uid, ...r });
    }
    return { multiUser: true, results };
  }
  return runWeeklyReportsForUser(null, reportType);
}

async function runWeeklyReportsForUser(userId, reportType) {
  const isMensal  = (reportType === 'mensal');
  const config    = (userId ? storage.getUserMonitorConfig(userId) : null) || storage.getMonitorConfig();
  const tokenData = (userId ? storage.getUserToken(userId) : null)         || storage.getToken();

  // Valida habilitação conforme tipo
  if (isMensal) {
    if (!config?.monthlyReportEnabled) return { skipped: true, reason: 'Relatório mensal desativado' };
  } else {
    if (!config?.weeklyReportEnabled)  return { skipped: true, reason: 'Relatório semanal desativado' };
  }
  if (!tokenData || tokenData.expiresAt < Date.now()) return { skipped: true, reason: 'Token inválido' };
  if (!config.accounts?.length)        return { skipped: true, reason: 'Nenhuma conta configurada' };
  if (!config.telegramToken || !config.telegramChatId) return { skipped: true, reason: 'Telegram não configurado' };

  function toISODate(d) { return d.toISOString().split('T')[0]; }
  function dateBR(s)    { const [y,m,d] = s.split('-'); return `${d}/${m}`; }

  const today = new Date();
  let sinceStr, untilStr, prevSinceStr, prevUntilStr;

  if (isMensal) {
    // Mês anterior completo: do dia 1 ao último dia do mês passado
    const firstPrev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const lastPrev  = new Date(today.getFullYear(), today.getMonth(), 0); // último dia do mês anterior
    sinceStr = toISODate(firstPrev);
    untilStr = toISODate(lastPrev);

    // Mês retrasado (comparação)
    const firstPrevPrev = new Date(today.getFullYear(), today.getMonth() - 2, 1);
    const lastPrevPrev  = new Date(today.getFullYear(), today.getMonth() - 1, 0);
    prevSinceStr = toISODate(firstPrevPrev);
    prevUntilStr = toISODate(lastPrevPrev);
  } else {
    // Semanal: últimos 7 dias completos (até ontem)
    const until = new Date(); until.setDate(today.getDate() - 1);
    const since = new Date(until); since.setDate(until.getDate() - 6);
    sinceStr = toISODate(since);
    untilStr = toISODate(until);

    const prevUntil = new Date(since); prevUntil.setDate(since.getDate() - 1);
    const prevSince = new Date(prevUntil); prevSince.setDate(prevUntil.getDate() - 6);
    prevSinceStr = toISODate(prevSince);
    prevUntilStr = toISODate(prevUntil);
  }

  const metaApi         = require('./meta-api');
  const reportGenerator = require('./report-generator');
  const { generateMonthlyAnalysis } = require('./claude-draft');
  const results         = [];

  // Para o relatório mensal, calcula também o 3º mês (2 meses atrás)
  let mes3SinceStr, mes3UntilStr;
  if (isMensal) {
    const first3 = new Date(today.getFullYear(), today.getMonth() - 3, 1);
    const last3  = new Date(today.getFullYear(), today.getMonth() - 2, 0);
    mes3SinceStr = toISODate(first3);
    mes3UntilStr = toISODate(last3);
  }

  for (const accountId of config.accounts) {
    try {
      // Busca nome da conta
      const infoRes  = await apiFetch(`${BASE}/${accountId}?fields=name`, tokenData.token);
      const infoData = await infoRes.json();
      const accountName = infoData.name || accountId;

      // Busca insights: mensal usa 3 meses, semanal usa 2 períodos
      const fetches = [
        metaApi.getInsights(tokenData.token, accountId, sinceStr, untilStr),
        metaApi.getInsights(tokenData.token, accountId, prevSinceStr, prevUntilStr),
      ];
      if (isMensal && mes3SinceStr) {
        fetches.push(metaApi.getInsights(tokenData.token, accountId, mes3SinceStr, mes3UntilStr));
      }
      const [data, prev, prev2] = await Promise.all(fetches);

      // Métricas configuradas por conta (null = auto-detect)
      const enabledMetrics = config.reportMetrics?.[accountId] || null;

      // Gera HTML do relatório
      const html = reportGenerator.generate({
        accountName, since: sinceStr, until: untilStr,
        reportType: isMensal ? 'mensal' : 'semanal',
        current: data, previous: prev,
        agencyName: config.agencyName || '', agencyLogo: config.agencyLogo || '',
        enabledMetrics
      });

      // Formatos
      const brl  = v  => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
      const fmt  = v  => new Intl.NumberFormat('pt-BR').format(v || 0);
      const pct  = v  => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
      const delta = (cur, prv) => prv > 0 ? ((cur - prv) / prv * 100) : null;

      // ── Seção de campanhas ────────────────────────────────────────────────
      const camps = (data.campaigns || []).sort((a, b) => b.spend - a.spend);

      const campLines = camps.map(c => {
        const lines = [`\n*${telegram.mdSafe(c.name)}*`];
        lines.push(`Cliques: ${fmt(c.clicks)}`);
        lines.push(`CTR: ${(c.ctr || 0).toFixed(2)}%`);
        lines.push(`CPM: ${brl(c.cpm)}`);
        if (c.messages > 0) {
          lines.push(`Mensagens: ${fmt(c.messages)}`);
          lines.push(`Custo por mensagem: ${brl(c.costPerMessage)}`);
        }
        if (c.followers > 0) {
          lines.push(`Seguidores: ${fmt(c.followers)}`);
          lines.push(`Custo por seguidor: ${brl(c.costPerFollower)}`);
        }
        return lines.join('\n');
      }).join('\n');

      // ── Análise comparativa automática ───────────────────────────────────
      const analysisLines = [];
      for (const c of camps) {
        const prevC = (prev.campaigns || []).find(p => p.name === c.name);
        if (!prevC) continue;

        const parts = [];

        // Mensagens
        if (c.messages > 0 && prevC.messages > 0) {
          const d = delta(c.messages, prevC.messages);
          const dir = d >= 0 ? 'subiram' : 'caíram';
          parts.push(`as mensagens ${dir} de ${fmt(prevC.messages)} para ${fmt(c.messages)} (${pct(d)})`);
          if (c.costPerMessage && prevC.costPerMessage) {
            const dc = delta(c.costPerMessage, prevC.costPerMessage);
            const dirC = dc >= 0 ? 'subindo' : 'caindo';
            parts.push(`custo por mensagem ${dirC} de ${brl(prevC.costPerMessage)} para ${brl(c.costPerMessage)}`);
          }
        }

        // Seguidores
        if (c.followers > 0 && prevC.followers > 0) {
          const d = delta(c.followers, prevC.followers);
          const dir = d >= 0 ? 'subiram' : 'caíram';
          parts.push(`os seguidores ${dir} de ${fmt(prevC.followers)} para ${fmt(c.followers)} (${pct(d)})`);
        }

        // CPM
        if (c.cpm > 0 && prevC.cpm > 0) {
          const d = delta(c.cpm, prevC.cpm);
          if (Math.abs(d) > 10) {
            const dir = d >= 0 ? 'subiu' : 'caiu';
            parts.push(`CPM ${dir} de ${brl(prevC.cpm)} para ${brl(c.cpm)} (${pct(d)})`);
          }
        }

        if (parts.length > 0) {
          analysisLines.push(`Na campanha *${telegram.mdSafe(c.name)}*, ${parts.join(', ')}.`);
        }
      }

      // ── Sugestão de mensagem ao cliente ──────────────────────────────────
      const clientLines = [];
      for (const c of camps) {
        if (c.messages > 0)  clientLines.push(`Na campanha *${telegram.mdSafe(c.name)}* foram ${fmt(c.messages)} mensagens a ${brl(c.costPerMessage)} cada.`);
        if (c.followers > 0) clientLines.push(`No *${telegram.mdSafe(c.name)}* conquistamos ${fmt(c.followers)} novos seguidores a ${brl(c.costPerFollower)} cada.`);
      }

      // ── Monta e envia mensagem ────────────────────────────────────────────

      // Gera link compartilhável (válido 90 dias)
      const shareUrl = saveReportLink(html, {
        accountName, since: sinceStr, until: untilStr,
        reportType: isMensal ? 'mensal' : 'semanal'
      });

      let msg;

      if (isMensal) {
        // ── Relatório mensal: ANÁLISE DE OTIMIZAÇÃO gerada por Claude ─────────
        console.log(`[Relatório Mensal] Gerando análise Claude para ${accountName}...`);
        const rawAnalysis = await generateMonthlyAnalysis(
          accountName,
          { since: sinceStr,     until: untilStr,     data },
          { since: prevSinceStr, until: prevUntilStr,  data: prev },
          prev2 ? { since: mes3SinceStr, until: mes3UntilStr, data: prev2 } : null
        );
        msg = shareUrl
          ? rawAnalysis.replace('[LINK_AQUI]', shareUrl)
          : rawAnalysis.replace('\n📎 Caso queiram acessar o relatório completo, segue o link: [LINK_AQUI]', '');
      } else {
        // ── Relatório semanal: formato original ───────────────────────────────
        const tipoLabel = 'SEMANAL';
        msg = [
          `📊 *RELATÓRIO ${tipoLabel} — ${telegram.mdSafe(accountName.toUpperCase())}*`,
          ``,
          `Período: ${dateBR(sinceStr)} a ${dateBR(untilStr)} | Plataforma: Meta Ads`,
          ``,
          `── MÉTRICAS DO PERÍODO ──`,
          ``,
          `Alcance: ${fmt(data.reach)}`,
          `Impressões: ${fmt(data.impressions)}`,
          `Valor investido: ${brl(data.spend)}`,
          campLines,
          ``,
          `─ ANÁLISE DO PERÍODO ─`,
          ``,
          analysisLines.length > 0 ? analysisLines.join('\n\n') : '_Sem período anterior disponível para comparação._',
          ``,
          `─ SUGESTÃO DE MENSAGEM AO CLIENTE ─`,
          ``,
          `Bom dia!`,
          ``,
          `✅ Análise do período ${dateBR(sinceStr)} a ${dateBR(untilStr)}.`,
          ``,
          clientLines.join('\n'),
          ``,
          `📎 Caso queiram acessar o relatório completo, segue o link: ${shareUrl || '[LINK_AQUI]'}`
        ].join('\n');
      }

      if (shareUrl || isMensal) {
        await telegram.send(config.telegramToken, config.telegramChatId, msg);
      } else {
        // Sem URL pública → envia mensagem + HTML anexo
        await telegram.send(config.telegramToken, config.telegramChatId, msg);
        const slug     = accountName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
        const filename = `relatorio-${slug}-${sinceStr}.html`;
        await telegram.sendDocument(config.telegramToken, config.telegramChatId, filename, html, `📎 Relatório completo — ${accountName}`);
      }

      storage.saveMonitorLog({ type: 'weekly_report', account: accountName, sentAt: Date.now() });
      results.push({ accountId, accountName, status: 'sent' });
    } catch (err) {
      storage.saveMonitorLog({ type: 'error', error: `Relatório ${accountId}: ${err.message}`, sentAt: Date.now() });
      results.push({ accountId, status: 'error', error: err.message });
    }
  }

  return { results };
}

// ── Verificação automática de performance ─────────────────────────────────────
// Compara os últimos 7 dias com os 7 dias anteriores e detecta:
//   • Frequência acima de 3.5 (risco de fadiga criativa)
//   • CTR caindo > 25% (criativo perdendo relevância)
//   • CPM subindo > 35% (aumento de custo de entrega)
//   • Custo por mensagem subindo > 30%

async function runPerformanceCheck() {
  const config    = storage.getMonitorConfig();
  const tokenData = storage.getToken();

  if (!config?.performanceCheckEnabled)                       return { skipped: true, reason: 'Verificação de performance desativada' };
  if (!tokenData || tokenData.expiresAt < Date.now())         return { skipped: true, reason: 'Token inválido' };
  if (!config.accounts?.length)                               return { skipped: true, reason: 'Nenhuma conta configurada' };
  if (!config.telegramToken || !config.telegramChatId)        return { skipped: true, reason: 'Telegram não configurado' };

  function toISODate(d) { return d.toISOString().split('T')[0]; }

  const metaApi = require('./meta-api');
  const brl     = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);

  // Período atual: últimos 7 dias completos (até ontem)
  const until = new Date(); until.setDate(until.getDate() - 1);
  const since = new Date(until); since.setDate(until.getDate() - 6);

  // Período anterior: 7 dias antes do atual
  const prevUntil = new Date(since); prevUntil.setDate(prevUntil.getDate() - 1);
  const prevSince = new Date(prevUntil); prevSince.setDate(prevUntil.getDate() - 6);

  const accountAlerts = [];

  for (const accountId of config.accounts) {
    try {
      // Busca nome da conta
      const infoRes  = await apiFetch(`${BASE}/${accountId}?fields=name`, tokenData.token);
      const infoData = await infoRes.json();
      const name     = infoData.name || accountId;

      const [current, previous] = await Promise.all([
        metaApi.getInsights(tokenData.token, accountId, toISODate(since), toISODate(until)),
        metaApi.getInsights(tokenData.token, accountId, toISODate(prevSince), toISODate(prevUntil))
      ]);

      const issues = [];

      // 1. Frequência alta (fadiga criativa)
      if (current.frequency >= 3.5) {
        issues.push(`⚠️ Frequência: *${current.frequency.toFixed(1)}* — acima de 3.5 (risco de fadiga criativa)`);
      }

      // 2. CTR caindo
      if (previous.ctr > 0 && current.ctr > 0) {
        const delta = ((current.ctr - previous.ctr) / previous.ctr) * 100;
        if (delta < -25) {
          issues.push(`📉 CTR caiu *${Math.abs(delta).toFixed(0)}%* — de ${previous.ctr.toFixed(2)}% para ${current.ctr.toFixed(2)}%`);
        }
      }

      // 3. CPM subindo
      if (previous.cpm > 0 && current.cpm > 0) {
        const delta = ((current.cpm - previous.cpm) / previous.cpm) * 100;
        if (delta > 35) {
          issues.push(`💰 CPM subiu *${delta.toFixed(0)}%* — de ${brl(previous.cpm)} para ${brl(current.cpm)}`);
        }
      }

      // 4. Custo por mensagem subindo
      if (previous.costPerMessage > 0 && current.costPerMessage > 0) {
        const delta = ((current.costPerMessage - previous.costPerMessage) / previous.costPerMessage) * 100;
        if (delta > 30) {
          issues.push(`💬 Custo/mensagem subiu *${delta.toFixed(0)}%* — de ${brl(previous.costPerMessage)} para ${brl(current.costPerMessage)}`);
        }
      }

      // 5. Verifica campanhas individualmente (CPA alvo se configurado)
      const cpaTarget = parseFloat(config.cpaTargets?.[accountId]) || null;
      const campIssues = [];
      for (const c of (current.campaigns || [])) {
        if (!c.impressions && !c.spend) continue;

        // Frequência alta na campanha
        if (c.frequency >= 3.5) {
          campIssues.push(`  • *${c.name}* — frequência ${c.frequency.toFixed(1)}`);
        }

        // CPA acima do alvo
        if (cpaTarget && c.costPerMessage && c.costPerMessage > cpaTarget * 1.3) {
          campIssues.push(`  • *${c.name}* — custo/msg ${brl(c.costPerMessage)} (alvo: ${brl(cpaTarget)})`);
        }
      }
      if (campIssues.length > 0) {
        issues.push(`🎯 Campanhas com alerta:\n${campIssues.join('\n')}`);
      }

      if (issues.length > 0) {
        accountAlerts.push({ name, issues });
      }
    } catch (err) {
      console.error(`[PerformanceCheck] Erro na conta ${accountId}:`, err.message);
    }
  }

  // Avalia regras customizadas (antes do envio do alerta)
  const customRules = storage.getAlertRules();
  if (customRules.length > 0) {
    for (const accountId of config.accounts) {
      try {
        const current   = await metaApi.getInsights(tokenData.token, accountId, toISODate(since), toISODate(until));
        const infoRes2  = await apiFetch(`${BASE}/${accountId}?fields=name`, tokenData.token);
        const infoData2 = await infoRes2.json();
        const name2     = infoData2.name || accountId;
        const ruleIssues = [];
        for (const rule of customRules) {
          const metricValues = {
            ctr:            current.ctr,
            cpm:            current.cpm,
            frequency:      current.frequency,
            costPerMessage: current.costPerMessage,
            spend:          current.spend,
            messages:       current.messages
          };
          const val = metricValues[rule.metric];
          if (val === null || val === undefined) continue;
          let triggered = false;
          if (rule.operator === '>'  && val >  rule.value) triggered = true;
          if (rule.operator === '>=' && val >= rule.value) triggered = true;
          if (rule.operator === '<'  && val <  rule.value) triggered = true;
          if (rule.operator === '<=' && val <= rule.value) triggered = true;
          if (triggered) {
            ruleIssues.push(`📌 Regra: ${rule.label || rule.metric + ' ' + rule.operator + ' ' + rule.value} (valor atual: ${val.toFixed ? val.toFixed(2) : val})`);
          }
        }
        if (ruleIssues.length > 0) {
          const existing = accountAlerts.find(a => a.name === name2);
          if (existing) {
            existing.issues.push(...ruleIssues);
          } else {
            accountAlerts.push({ name: name2, issues: ruleIssues });
          }
        }
      } catch {}
    }
  }

  // Envia alerta se houver problemas
  if (accountAlerts.length > 0) {
    const lines = accountAlerts.map(a =>
      `\n📌 *${a.name}*\n${a.issues.join('\n')}`
    ).join('\n');

    const msg = [
      `📊 *Alerta de Performance — Meta Ads*`,
      `Período: últimos 7 dias vs semana anterior`,
      lines,
      ``,
      `Acesse o Meta Ads Reporter para detalhes e ações recomendadas.`
    ].join('\n');

    try {
      await telegram.send(config.telegramToken, config.telegramChatId, msg);
      storage.saveMonitorLog({
        type:    'performance_check',
        alerts:  accountAlerts.map(a => a.name),
        sentAt:  Date.now()
      });
    } catch (err) {
      storage.saveMonitorLog({ type: 'error', error: err.message, sentAt: Date.now() });
    }
  } else {
    storage.saveMonitorLog({
      type:    'performance_check',
      alerts:  [],
      sentAt:  Date.now()
    });
  }

  return { alerts: accountAlerts };
}

// ── Verificação de ritmo de orçamento mensal ──────────────────────────────────

async function runBudgetPaceCheck() {
  const config    = storage.getMonitorConfig();
  const tokenData = storage.getToken();

  if (!config?.accounts?.length)                       return { skipped: true, reason: 'Nenhuma conta' };
  if (!tokenData || tokenData.expiresAt < Date.now())  return { skipped: true, reason: 'Token inválido' };
  if (!config.monthlyBudgets || !Object.keys(config.monthlyBudgets).length) return { skipped: true, reason: 'Sem orçamentos configurados' };

  const brl = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
  const today         = new Date();
  const lastDay       = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const dayOfMonth    = today.getDate();
  const daysRemaining = lastDay - dayOfMonth;

  // Início do mês atual
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const sinceStr   = monthStart.toISOString().split('T')[0];
  const untilStr   = today.toISOString().split('T')[0];

  const alerts  = [];
  const results = [];
  const metaApi = require('./meta-api');

  for (const accountId of config.accounts) {
    const monthlyBudget = parseFloat(config.monthlyBudgets?.[accountId]);
    if (!monthlyBudget) continue;

    try {
      // Busca gasto do mês atual
      const data          = await metaApi.getInsights(tokenData.token, accountId, sinceStr, untilStr);
      const spentSoFar    = data.spend || 0;
      const avgDailySpend = dayOfMonth > 0 ? spentSoFar / dayOfMonth : 0;
      const projectedTotal = spentSoFar + (avgDailySpend * daysRemaining);
      const paceRatio     = monthlyBudget > 0 ? projectedTotal / monthlyBudget : null;
      const pctUsed       = monthlyBudget > 0 ? (spentSoFar / monthlyBudget * 100) : 0;

      const infoRes  = await apiFetch(`${BASE}/${accountId}?fields=name`, tokenData.token);
      const infoData = await infoRes.json();
      const name     = infoData.name || accountId;

      results.push({ accountId, name, monthlyBudget, spentSoFar, projectedTotal, paceRatio, pctUsed });

      // Alerta se projetado > 115% do orçamento
      if (paceRatio !== null && paceRatio > 1.15) {
        alerts.push({ name, monthlyBudget, spentSoFar, projectedTotal, paceRatio, type: 'overspend' });
      }
      // Alerta se projetado < 60% do orçamento (subentrega)
      if (paceRatio !== null && paceRatio < 0.60) {
        alerts.push({ name, monthlyBudget, spentSoFar, projectedTotal, paceRatio, type: 'underspend' });
      }
    } catch (err) {
      console.error(`[BudgetPace] Erro na conta ${accountId}:`, err.message);
    }
  }

  if (alerts.length > 0 && config.telegramToken && config.telegramChatId) {
    const lines = alerts.map(a => {
      const pctStr = `${(a.paceRatio * 100).toFixed(0)}%`;
      const icon   = a.type === 'overspend' ? '🔴' : '🟡';
      const msg    = a.type === 'overspend'
        ? `Projeção: ${brl(a.projectedTotal)} (${pctStr} do orçamento de ${brl(a.monthlyBudget)})`
        : `Subentregando: apenas ${pctStr} do orçamento projetado`;
      return `${icon} *${a.name}*\n  ${msg}\n  Gasto até agora: ${brl(a.spentSoFar)}`;
    }).join('\n\n');

    const msg = [`📅 *Alerta de Orçamento Mensal*`, ``, lines, ``, `Acesse o Meta Ads Reporter para ajustar os orçamentos.`].join('\n');
    try {
      await telegram.send(config.telegramToken, config.telegramChatId, msg);
    } catch {}
    storage.saveMonitorLog({ type: 'budget_pace', alerts: alerts.map(a => a.name), sentAt: Date.now() });
  }

  return { results, alerts };
}

// ── Verificação de orçamento diário ──────────────────────────────────────────
// Calcula o limite diário = orçamento mensal ÷ dias do mês.
// Se o gasto de HOJE ultrapassar esse limite → alerta no Telegram.
// Cooldown de 4 horas por conta para não spammar em checks frequentes.

async function runDailyBudgetCheck() {
  const config    = storage.getMonitorConfig();
  const tokenData = storage.getToken();

  if (!config?.accounts?.length)
    return { skipped: true, reason: 'Nenhuma conta' };
  if (!tokenData || tokenData.expiresAt < Date.now())
    return { skipped: true, reason: 'Token inválido' };
  if (!config.monthlyBudgets || !Object.keys(config.monthlyBudgets).length)
    return { skipped: true, reason: 'Sem orçamentos configurados' };

  const brl     = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
  const today   = new Date();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const todayStr    = today.toISOString().split('T')[0];
  const metaApi     = require('./meta-api');

  const alerts  = [];
  const results = [];

  for (const accountId of config.accounts) {
    const monthlyBudget = parseFloat(config.monthlyBudgets?.[accountId]);
    if (!monthlyBudget) continue;

    const dailyBudget = monthlyBudget / daysInMonth;

    try {
      // Gasto apenas de hoje
      const data       = await metaApi.getInsights(tokenData.token, accountId, todayStr, todayStr);
      const todaySpend = data.spend || 0;
      const pct        = dailyBudget > 0 ? (todaySpend / dailyBudget * 100) : 0;

      const infoRes  = await apiFetch(`${BASE}/${accountId}?fields=name`, tokenData.token);
      const infoData = await infoRes.json();
      const name     = infoData.name || accountId;

      const status = pct >= 100 ? 'exceeded' : pct >= 85 ? 'warning' : 'ok';
      results.push({ accountId, name, monthlyBudget, dailyBudget, todaySpend, pct, status });

      if (pct >= 100) {
        alerts.push({ name, monthlyBudget, dailyBudget, todaySpend, pct });
      }
    } catch (err) {
      console.error(`[DailyBudget] Erro na conta ${accountId}:`, err.message);
    }
  }

  // Alerta Telegram — cooldown de 4 h por grupo de alertas
  if (alerts.length > 0 && config.telegramToken && config.telegramChatId) {
    const recentLog = storage.getMonitorLogs().find(l =>
      l.type === 'daily_budget_alert' &&
      Date.now() - l.sentAt < 4 * 60 * 60 * 1000
    );

    if (!recentLog) {
      const lines = alerts.map(a => {
        const over = (a.pct - 100).toFixed(0);
        return `🔴 *${a.name}*\n  Gasto hoje: ${brl(a.todaySpend)} | Limite: ${brl(a.dailyBudget)} _(+${over}% acima)_`;
      }).join('\n\n');

      const msg = [
        `📅 *Alerta de Orçamento Diário — Meta Ads*`,
        ``,
        lines,
        ``,
        `O gasto de hoje ultrapassou o limite planejado. Para não comprometer o orçamento mensal, avalie pausar ou reduzir o investimento nas campanhas afetadas.`
      ].join('\n');

      try {
        await telegram.send(config.telegramToken, config.telegramChatId, msg);
        storage.saveMonitorLog({ type: 'daily_budget_alert', accounts: alerts.map(a => a.name), sentAt: Date.now() });
      } catch (err) {
        storage.saveMonitorLog({ type: 'error', error: err.message, sentAt: Date.now() });
      }
    }
  }

  return { results, alerts };
}

module.exports = { runCheck, getBalanceInfo, runWeeklyReports, runPerformanceCheck, runBudgetPaceCheck, runDailyBudgetCheck };
