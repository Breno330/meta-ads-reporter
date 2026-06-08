const express         = require('express');
const storage         = require('../services/storage');
const balanceMonitor  = require('../services/balance-monitor');
const telegram        = require('../services/telegram');
const { requireAuth } = require('../middleware/auth');
const router          = express.Router();

// Retorna config atual + logs (por usuário)
// O telegramToken é mascarado na resposta — o frontend só recebe se está configurado (bool + prefixo)
router.get('/config', requireAuth, (req, res) => {
  const config = (req.userId ? storage.getUserMonitorConfig(req.userId) : null)
              || storage.getMonitorConfig();
  const logs   = storage.getMonitorLogs().slice(0, 20);

  // Mascara o token real — envia apenas indicador de presença
  const safeConfig = config ? {
    ...config,
    telegramToken:      config.telegramToken ? '••CONFIGURED••' : '',
    telegramTokenSaved: !!(config.telegramToken)
  } : config;

  res.json({ config: safeConfig, logs });
});

// Todos os logs (para histórico completo)
router.get('/logs', requireAuth, (req, res) => {
  const logs = storage.getMonitorLogs();
  res.json(logs);
});

// Salva configuração do monitor
router.post('/config', requireAuth, (req, res) => {
  const { telegramToken, telegramChatId, thresholdBalance, checkTime, accounts, enabled,
          weeklyReportEnabled, weeklyReportDay, weeklyReportTime, hiddenAccounts,
          accountThresholds, performanceCheckEnabled, performanceCheckTime,
          cpaTargets, agencyName, agencyLogo, monthlyBudgets,
          claudeStyle, claudeExamples,
          monthlyReportEnabled, monthlyReportDay, monthlyReportTime } = req.body;

  // Preserva credenciais existentes se o campo vier vazio ou com o placeholder mascarado
  const existing = storage.getMonitorConfig() || {};
  const resolvedToken  = (telegramToken  && telegramToken.trim()  && telegramToken  !== '••CONFIGURED••')
    ? telegramToken.trim()
    : (existing.telegramToken || '');
  const resolvedChatId = (telegramChatId && telegramChatId.trim() && telegramChatId !== '••CONFIGURED••')
    ? telegramChatId.trim()
    : (existing.telegramChatId || '');

  const config = {
    telegramToken:            resolvedToken,
    telegramChatId:           resolvedChatId,
    thresholdBalance:         parseFloat(thresholdBalance) || 200,
    checkTime:                checkTime || '10:00',
    accounts:                 accounts  || [],
    enabled:                  !!enabled,
    weeklyReportEnabled:      !!weeklyReportEnabled,
    weeklyReportDay:          parseInt(weeklyReportDay ?? 0),
    weeklyReportTime:         weeklyReportTime || '18:00',
    hiddenAccounts:           hiddenAccounts   || [],
    accountThresholds:        accountThresholds || {},
    performanceCheckEnabled:  !!performanceCheckEnabled,
    performanceCheckTime:     performanceCheckTime || '09:00',
    cpaTargets:               cpaTargets || {},
    agencyName:               agencyName || '',
    agencyLogo:               agencyLogo || '',
    monthlyBudgets:           monthlyBudgets || {},
    claudeStyle:              claudeStyle || '',
    claudeExamples:           Array.isArray(claudeExamples) ? claudeExamples.filter(e => e?.trim()) : [],
    monthlyReportEnabled:     !!monthlyReportEnabled,
    monthlyReportDay:         parseInt(monthlyReportDay ?? 1),
    monthlyReportTime:        monthlyReportTime || '10:00',
    updatedAt:                Date.now()
  };

  // Salva por usuário E global (retrocompatível)
  if (req.userId) storage.saveUserMonitorConfig(req.userId, config);
  storage.saveMonitorConfig(config);

  const scheduler = req.app.get('scheduler');
  if (scheduler) {
    scheduler.reschedule(config.checkTime);
    if (config.weeklyReportEnabled) {
      scheduler.rescheduleWeeklyReport(config.weeklyReportDay, config.weeklyReportTime);
    }
    scheduler.reschedulePerformanceCheck(
      config.performanceCheckEnabled ? config.performanceCheckTime : null
    );
    scheduler.rescheduleMonthlyReport?.(
      config.monthlyReportEnabled ? config.monthlyReportDay  : null,
      config.monthlyReportEnabled ? config.monthlyReportTime : null
    );
  }

  res.json({ ok: true, config });
});

// Saldo de uma conta
router.get('/balance/:accountId', requireAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
    const info = await balanceMonitor.getBalanceInfo(req.token, req.params.accountId, days);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const API_BASE = 'https://graph.facebook.com/v20.0';
function apiFetch(url, token) {
  return globalThis.fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
}

// Debug de actions de uma conta (para identificar tipos de ação disponíveis)
router.get('/debug-actions/:accountId', requireAuth, async (req, res) => {
  const today = new Date();
  const since = new Date(); since.setDate(today.getDate() - 7);
  const toISO = d => d.toISOString().split('T')[0];
  const timeRange = encodeURIComponent(JSON.stringify({ since: toISO(since), until: toISO(today) }));
  try {
    const r    = await apiFetch(`${API_BASE}/${req.params.accountId}/insights?fields=campaign_name,actions&level=campaign&time_range=${timeRange}&limit=50`, req.token);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnóstico — retorna todos os campos brutos da conta
router.get('/debug/:accountId', requireAuth, async (req, res) => {
  const fields = ['id','name','balance','amount_spent','spend_cap','currency','account_status','funding_source_details'].join(',');
  try {
    const r    = await apiFetch(`${API_BASE}/${req.params.accountId}?fields=${fields}`, req.token);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verificação manual
router.post('/check', requireAuth, async (req, res) => {
  try {
    const result = await balanceMonitor.runCheck();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verificação manual de performance
router.post('/performance-check', requireAuth, async (req, res) => {
  try {
    const result = await balanceMonitor.runPerformanceCheck();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Envio manual do relatório semanal ou mensal
router.post('/weekly-report', requireAuth, async (req, res) => {
  try {
    const result = await balanceMonitor.runWeeklyReports();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disparo manual via botão no painel (semanal ou mensal)
router.post('/send-weekly-now', requireAuth, async (req, res) => {
  try {
    const reportType = req.body?.reportType || 'semanal';
    const result     = await balanceMonitor.runWeeklyReports(reportType);
    const sent       = Array.isArray(result.results)
      ? result.results.filter(r => r.status === 'sent').length
      : (result.skipped ? 0 : 1);
    res.json({ ok: true, sent, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Teste de notificação Telegram
router.post('/test-telegram', requireAuth, async (req, res) => {
  const config = storage.getMonitorConfig();
  if (!config?.telegramToken || !config?.telegramChatId) {
    return res.status(400).json({ error: 'Configure o token e o Chat ID antes de testar.' });
  }

  try {
    await telegram.send(
      config.telegramToken,
      config.telegramChatId,
      '✅ *Meta Ads Reporter* — Notificações configuradas com sucesso! Você receberá alertas quando o saldo estiver baixo.'
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Budget Pace ───────────────────────────────────────────────────────────────

// GET /budget-pace — retorna projeção atual (sem Telegram)
router.get('/budget-pace', requireAuth, async (req, res) => {
  try {
    const config    = storage.getMonitorConfig();
    const tokenData = storage.getToken();
    if (!tokenData || tokenData.expiresAt < Date.now()) return res.status(401).json({ error: 'Token inválido' });
    if (!config?.accounts?.length) return res.json({ results: [] });

    const today         = new Date();
    const lastDay       = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const dayOfMonth    = today.getDate();
    const daysRemaining = lastDay - dayOfMonth;
    const monthStart    = new Date(today.getFullYear(), today.getMonth(), 1);
    const sinceStr      = monthStart.toISOString().split('T')[0];
    const untilStr      = today.toISOString().split('T')[0];
    const metaApi       = require('../services/meta-api');

    const results = await Promise.all(config.accounts.map(async accountId => {
      const monthlyBudget = parseFloat(config.monthlyBudgets?.[accountId]);
      try {
        const data          = await metaApi.getInsights(tokenData.token, accountId, sinceStr, untilStr);
        const spentSoFar    = data.spend || 0;
        const avgDailySpend = dayOfMonth > 0 ? spentSoFar / dayOfMonth : 0;
        const projectedTotal = spentSoFar + (avgDailySpend * daysRemaining);
        const paceRatio     = monthlyBudget > 0 ? projectedTotal / monthlyBudget : null;
        const pctUsed       = monthlyBudget > 0 ? (spentSoFar / monthlyBudget * 100) : 0;
        return { accountId, monthlyBudget: monthlyBudget || null, spentSoFar, projectedTotal, paceRatio, pctUsed, dayOfMonth, lastDay };
      } catch (e) {
        return { accountId, error: e.message };
      }
    }));
    res.json({ results, dayOfMonth, lastDay, daysRemaining });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /budget-pace/check — executa verificação com alertas Telegram
router.post('/budget-pace/check', requireAuth, async (req, res) => {
  try {
    const result = await balanceMonitor.runBudgetPaceCheck();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Orçamento Diário ──────────────────────────────────────────────────────────

// GET /daily-budget — retorna gasto de hoje vs limite diário por conta
router.get('/daily-budget', requireAuth, async (req, res) => {
  try {
    const result = await balanceMonitor.runDailyBudgetCheck();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /daily-budget/check — disparo manual com alerta Telegram
router.post('/daily-budget/check', requireAuth, async (req, res) => {
  try {
    const result = await balanceMonitor.runDailyBudgetCheck();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Benchmark Interno ─────────────────────────────────────────────────────────

// GET /benchmark — compara métricas das últimas semanas entre contas monitoradas
router.get('/benchmark', requireAuth, async (req, res) => {
  const config    = storage.getMonitorConfig();
  const tokenData = storage.getToken();
  if (!config?.accounts?.length) return res.json({ accounts: [] });
  if (!tokenData || tokenData.expiresAt < Date.now()) return res.status(401).json({ error: 'Token inválido' });

  const metaApi = require('../services/meta-api');
  const today   = new Date();
  const since   = new Date(); since.setDate(today.getDate() - 6);
  const sinceStr = since.toISOString().split('T')[0];
  const untilStr = today.toISOString().split('T')[0];

  const accounts = await Promise.all(config.accounts.map(async accountId => {
    try {
      const [data, info] = await Promise.all([
        metaApi.getInsights(tokenData.token, accountId, sinceStr, untilStr),
        fetch(`https://graph.facebook.com/v20.0/${accountId}?fields=name`, { headers: { Authorization: `Bearer ${tokenData.token}` } }).then(r => r.json())
      ]);
      return {
        accountId,
        name:           info.name || accountId,
        spend:          data.spend,
        impressions:    data.impressions,
        reach:          data.reach,
        clicks:         data.clicks,
        ctr:            data.ctr,
        cpm:            data.cpm,
        frequency:      data.frequency,
        messages:       data.messages,
        costPerMessage: data.costPerMessage,
        followers:      data.followers
      };
    } catch (e) {
      return { accountId, error: e.message };
    }
  }));

  res.json({ accounts: accounts.filter(a => !a.error), period: { since: sinceStr, until: untilStr } });
});

// ── Regras de Alerta Customizadas ─────────────────────────────────────────────

// GET /rules
router.get('/rules', requireAuth, (req, res) => {
  res.json(storage.getAlertRules());
});

// POST /rules (cria ou substitui array completo)
router.post('/rules', requireAuth, (req, res) => {
  const { rules } = req.body;
  if (!Array.isArray(rules)) return res.status(400).json({ error: 'rules deve ser array.' });
  // Valida cada regra: { id, metric, operator, value, label }
  const valid = rules.filter(r => r.metric && r.operator && r.value !== undefined);
  storage.saveAlertRules(valid);
  res.json({ ok: true, count: valid.length });
});

// DELETE /rules/:id
router.delete('/rules/:id', requireAuth, (req, res) => {
  const rules = storage.getAlertRules().filter(r => r.id !== req.params.id);
  storage.saveAlertRules(rules);
  res.json({ ok: true });
});

// ── Multi-token ───────────────────────────────────────────────────────────────

// GET /tokens — lista todos os tokens
router.get('/tokens', requireAuth, (req, res) => {
  const tokens = storage.getTokens().map(t => ({
    id:        t.id,
    label:     t.label,
    userName:  t.userName,
    expiresAt: t.expiresAt,
    daysLeft:  Math.max(0, Math.floor((t.expiresAt - Date.now()) / (1000 * 60 * 60 * 24))),
    valid:     t.expiresAt > Date.now(),
    accounts:  t.accounts || []
  }));
  res.json(tokens);
});

// PUT /tokens/:id — atualiza label e accounts de um token
router.put('/tokens/:id', requireAuth, (req, res) => {
  const { label, accounts } = req.body;
  const tokens = storage.getTokens();
  const t      = tokens.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Token não encontrado' });
  if (label)    t.label    = label;
  if (accounts) t.accounts = accounts;
  storage.upsertToken(t);
  res.json({ ok: true });
});

// DELETE /tokens/:id — remove token (não permite remover primary)
router.delete('/tokens/:id', requireAuth, (req, res) => {
  if (req.params.id === 'primary') return res.status(400).json({ error: 'Não é possível remover o token principal.' });
  storage.removeToken(req.params.id);
  res.json({ ok: true });
});

// ── Métricas de Relatório por Conta ───────────────────────────────────────────

// GET /report-metrics — lista as métricas disponíveis + config atual
router.get('/report-metrics', requireAuth, (req, res) => {
  const { AVAILABLE_METRICS } = require('../services/report-generator');
  const config = storage.getMonitorConfig() || {};
  res.json({ available: AVAILABLE_METRICS, configured: config.reportMetrics || {} });
});

// POST /report-metrics/:accountId — salva métricas habilitadas para uma conta
// Body: { metrics: ['spend','reach','messages',...] } ou { metrics: null } para auto-detect
router.post('/report-metrics/:accountId', requireAuth, (req, res) => {
  const { accountId } = req.params;
  const { metrics } = req.body; // null = auto-detect, array = manual

  const config = storage.getMonitorConfig() || {};
  if (!config.reportMetrics) config.reportMetrics = {};

  if (metrics === null || !Array.isArray(metrics)) {
    delete config.reportMetrics[accountId]; // volta para auto-detect
  } else {
    config.reportMetrics[accountId] = metrics;
  }

  storage.saveMonitorConfig(config);
  if (req.userId) storage.saveUserMonitorConfig(req.userId, config);

  res.json({ ok: true, accountId, metrics: config.reportMetrics[accountId] || null });
});

// GET /anthropic-key — retorna se a key está configurada (nunca expõe o valor)
router.get('/anthropic-key', requireAuth, (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  res.json({ configured: !!key, preview: key ? `${key.substring(0, 10)}…` : null });
});

// POST /anthropic-key — salva a key no .env e recarrega no process.env
router.post('/anthropic-key', requireAuth, (req, res) => {
  const { key } = req.body;
  const fs   = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '../.env');

  try {
    let envContent = fs.readFileSync(envPath, 'utf8');
    const newLine  = `ANTHROPIC_API_KEY=${key || ''}`;

    if (envContent.includes('ANTHROPIC_API_KEY=')) {
      envContent = envContent.replace(/ANTHROPIC_API_KEY=.*/m, newLine);
    } else {
      envContent = envContent.trimEnd() + '\n' + newLine + '\n';
    }

    fs.writeFileSync(envPath, envContent, 'utf8');
    // Atualiza imediatamente sem reiniciar o server
    process.env.ANTHROPIC_API_KEY = key || '';

    const configured = !!key?.trim();
    res.json({ ok: true, configured, preview: configured ? `${key.substring(0, 10)}…` : null });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar .env: ' + err.message });
  }
});

module.exports = router;
