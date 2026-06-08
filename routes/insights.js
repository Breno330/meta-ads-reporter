const express         = require('express');
const metaApi         = require('../services/meta-api');
const storage         = require('../services/storage');
const { requireAuth } = require('../middleware/auth');
const router          = express.Router();

// Busca métricas de uma conta num período
router.get('/', requireAuth, async (req, res) => {
  const { accountId, since, until } = req.query;

  if (!accountId || !since || !until) {
    return res.status(400).json({ error: 'accountId, since e until são obrigatórios.' });
  }

  try {
    const insights = await metaApi.getInsights(req.token, accountId, since, until);
    storage.saveInsights(accountId, since, until, insights);
    // Auto-salva snapshot de tendência histórica
    try {
      storage.saveMetricsSnapshot(accountId, {
        spend:          insights.spend,
        impressions:    insights.impressions,
        reach:          insights.reach,
        clicks:         insights.clicks,
        ctr:            insights.ctr,
        cpm:            insights.cpm,
        frequency:      insights.frequency,
        messages:       insights.messages,
        costPerMessage: insights.costPerMessage
      });
    } catch (_) {}
    res.json(insights);
  } catch (err) {
    console.error('Erro ao buscar insights:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Histórico de períodos já buscados para uma conta
router.get('/history', requireAuth, (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ error: 'accountId obrigatório.' });
  res.json(storage.getInsightsHistory(accountId));
});

// Insights em nível de anúncio (ad)
router.get('/ads', requireAuth, async (req, res) => {
  const { accountId, since, until } = req.query;
  if (!accountId || !since || !until) return res.status(400).json({ error: 'accountId, since e until são obrigatórios.' });
  try {
    const ads = await metaApi.getAdLevelInsights(req.token, accountId, since, until);
    res.json(ads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Insights por plataforma (placement)
router.get('/placements', requireAuth, async (req, res) => {
  const { accountId, since, until } = req.query;
  if (!accountId || !since || !until) return res.status(400).json({ error: 'accountId, since e until são obrigatórios.' });
  try {
    const placements = await metaApi.getPlacementInsights(req.token, accountId, since, until);
    res.json(placements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Snapshots históricos de métricas
router.get('/snapshots', requireAuth, (req, res) => {
  const { accountId, days } = req.query;
  if (!accountId) return res.status(400).json({ error: 'accountId obrigatório.' });
  res.json(storage.getMetricsSnapshots(accountId, parseInt(days) || 90));
});

// Análise de criativos (insights por anúncio + thumbnails)
router.get('/creatives', requireAuth, async (req, res) => {
  const { accountId, since, until } = req.query;
  if (!accountId || !since || !until) {
    return res.status(400).json({ error: 'accountId, since e until são obrigatórios.' });
  }
  try {
    const token     = req.getTokenForAccount ? req.getTokenForAccount(accountId) : req.token;
    const creatives = await metaApi.getCreativeInsights(token, accountId, since, until);
    res.json({ creatives });
  } catch (err) {
    console.error('Erro ao buscar criativos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Diagnóstico IA (rule-based + Claude draft)
router.post('/diagnose', requireAuth, async (req, res) => {
  const { accountId, accountName, since, until, previousSince, previousUntil, cpaTarget } = req.body;
  if (!accountId || !since || !until) return res.status(400).json({ error: 'Parâmetros obrigatórios.' });
  const current = storage.getInsights(accountId, since, until);
  if (!current) return res.status(404).json({ error: 'Dados não encontrados. Busque os dados primeiro.' });
  const previous = previousSince && previousUntil ? storage.getInsights(accountId, previousSince, previousUntil) : null;

  const diagnostics = require('../services/diagnostics');
  const parsedCpaTarget = parseFloat(cpaTarget) || null;
  const result = diagnostics.generateDiagnosis(current, previous, {
    cpaTarget: parsedCpaTarget,
    accountName,
    period: { since, until }
  });

  // Busca estilo personalizado salvo pelo usuário
  const monitorConfig = storage.getMonitorConfig() || {};

  // Enriquece o rascunho com Claude (com fallback automático para rule-based)
  const { generateClaudeDraft } = require('../services/claude-draft');
  const { draft, source } = await generateClaudeDraft(result, current, {
    accountName,
    claudeStyle:    monitorConfig.claudeStyle    || '',
    claudeExamples: monitorConfig.claudeExamples || [],
    period: { since, until },
    cpaTarget: parsedCpaTarget,
    previous   // dados da semana anterior para comparativo
  });
  result.clientDraft = draft;
  result.draftSource = source; // 'claude' | 'rule-based'

  res.json(result);
});

module.exports = router;
