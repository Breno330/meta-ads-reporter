const express         = require('express');
const fs              = require('fs');
const path            = require('path');
const crypto          = require('crypto');
const generator       = require('../services/report-generator');
const storage         = require('../services/storage');
const { requireAuth } = require('../middleware/auth');
const router          = express.Router();

const REPORTS_DIR    = path.join(__dirname, '..', 'data', 'reports');
const REPORT_TTL_MS  = 90 * 24 * 60 * 60 * 1000; // 90 dias

function ensureReportsDir() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

// Gera token URL-safe de 32 chars
function genToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// Remove relatórios expirados (chamado ao gerar novo)
function cleanupExpired() {
  try {
    if (!fs.existsSync(REPORTS_DIR)) return;
    const now = Date.now();
    fs.readdirSync(REPORTS_DIR)
      .filter(f => f.endsWith('.json'))
      .forEach(f => {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
          if (meta.expiresAt < now) {
            fs.unlinkSync(path.join(REPORTS_DIR, f));
            const htmlFile = path.join(REPORTS_DIR, `${meta.token}.html`);
            if (fs.existsSync(htmlFile)) fs.unlinkSync(htmlFile);
          }
        } catch {}
      });
  } catch {}
}

// ── Gera o relatório HTML + cria link compartilhável ─────────────────────────
router.post('/generate', requireAuth, async (req, res) => {
  const {
    accountId, accountName,
    since, until,
    previousSince, previousUntil,
    reportType, recipientName, followers
  } = req.body;

  const current = storage.getInsights(accountId, since, until);
  if (!current) {
    return res.status(400).json({
      error: 'Dados do período atual não encontrados. Clique em "Buscar dados" primeiro.'
    });
  }

  const previous = (previousSince && previousUntil)
    ? storage.getInsights(accountId, previousSince, previousUntil)
    : null;

  // Busca dados por faixa etária (não bloqueia se falhar)
  const metaApi = require('../services/meta-api');
  let ageBreakdown = [];
  try {
    ageBreakdown = await metaApi.getAgeBreakdownInsights(req.token, accountId, since, until);
  } catch {}

  try {
    const html = generator.generate({
      accountName,
      since,
      until,
      reportType:    reportType || 'semanal',
      recipientName: recipientName || null,
      followers:     followers ? parseInt(followers) : null,
      current,
      previous,
      ageBreakdown
    });

    // Salva HTML + metadados com token único
    ensureReportsDir();
    cleanupExpired();

    const token     = genToken();
    const expiresAt = Date.now() + REPORT_TTL_MS;
    const meta      = { token, accountName, since, until, reportType, expiresAt, createdAt: Date.now() };

    fs.writeFileSync(path.join(REPORTS_DIR, `${token}.html`),  html,                    'utf8');
    fs.writeFileSync(path.join(REPORTS_DIR, `${token}.json`),  JSON.stringify(meta),    'utf8');

    // Monta URL base — prioriza APP_BASE_URL (Cloudflare Tunnel / produção)
    const appBase  = process.env.APP_BASE_URL?.trim();
    const proto    = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host     = req.headers['x-forwarded-host']  || req.headers.host;
    const baseUrl  = appBase || `${proto}://${host}`;
    const shareUrl = `${baseUrl}/r/${token}`;

    res.json({ html, shareUrl, token, expiresAt });
  } catch (err) {
    console.error('Erro ao gerar relatório:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Lista relatórios gerados ──────────────────────────────────────────────────
router.get('/links', requireAuth, (req, res) => {
  try {
    ensureReportsDir();
    const now     = Date.now();
    const reports = fs.readdirSync(REPORTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8')); }
        catch { return null; }
      })
      .filter(m => m && m.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50);

    const appBase2 = process.env.APP_BASE_URL?.trim();
    const proto    = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host     = req.headers['x-forwarded-host']  || req.headers.host;
    const baseUrl2 = appBase2 || `${proto}://${host}`;

    res.json(reports.map(m => ({
      token:          m.token,
      accountName:    m.accountName,
      since:          m.since,
      until:          m.until,
      reportType:     m.reportType,
      expiresAt:      m.expiresAt,
      createdAt:      m.createdAt,
      accessCount:    m.accessCount    || 0,
      lastAccessedAt: m.lastAccessedAt || null,
      shareUrl:       `${baseUrl2}/r/${m.token}`
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Revoga (apaga) um link ────────────────────────────────────────────────────
router.delete('/links/:token', requireAuth, (req, res) => {
  const token = req.params.token.replace(/[^a-zA-Z0-9_-]/g, '');
  try {
    const htmlFile = path.join(REPORTS_DIR, `${token}.html`);
    const metaFile = path.join(REPORTS_DIR, `${token}.json`);
    if (fs.existsSync(htmlFile)) fs.unlinkSync(htmlFile);
    if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Relatório de Orçamento (pacing mensal — todas as contas) ─────────────────
// Gera um relatório HTML consolidado: orçamento mensal vs gasto vs projeção,
// classificando cada conta em no previsto / acima / abaixo do planejado.
router.post('/budget', requireAuth, async (req, res) => {
  try {
    const config  = storage.getMonitorConfig() || {};
    const metaApi = require('../services/meta-api');

    // Lista de contas: une as monitoradas + as que têm orçamento definido.
    // Se nada estiver configurado, cai para TODAS as contas acessíveis pelo token.
    const monitored = Array.isArray(config.accounts) ? config.accounts : [];
    const budgetIds = Object.keys(config.monthlyBudgets || {});
    let candidateIds = [...new Set([...monitored, ...budgetIds])];
    if (!candidateIds.length) {
      try { candidateIds = (await metaApi.getAdAccounts(req.token)).map(a => a.id); } catch {}
    }
    if (!candidateIds.length) {
      return res.status(400).json({ error: 'Nenhuma conta encontrada para este token.' });
    }

    const MESES   = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];

    const today         = new Date();
    const lastDay       = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const dayOfMonth    = today.getDate();
    const daysRemaining = lastDay - dayOfMonth;
    const monthStart    = new Date(today.getFullYear(), today.getMonth(), 1);
    const sinceStr      = monthStart.toISOString().split('T')[0];
    const untilStr      = today.toISOString().split('T')[0];
    const monthLabel    = `${MESES[today.getMonth()]} de ${today.getFullYear()}`;

    // Busca gasto do mês + nome de cada conta (em paralelo)
    const data = await Promise.all(candidateIds.map(async accountId => {
      const monthlyBudget = parseFloat(config.monthlyBudgets?.[accountId]) || 0;
      try {
        const [insights, info] = await Promise.all([
          metaApi.getInsights(req.token, accountId, sinceStr, untilStr),
          fetch(`https://graph.facebook.com/v20.0/${accountId}?fields=name`, { headers: { Authorization: `Bearer ${req.token}` } }).then(r => r.json())
        ]);
        const spentSoFar     = insights.spend || 0;
        const avgDailySpend  = dayOfMonth > 0 ? spentSoFar / dayOfMonth : 0;
        const projectedTotal = spentSoFar + (avgDailySpend * daysRemaining);
        return {
          name:           info.name || accountId,
          monthlyBudget,
          spentSoFar,
          projectedTotal,
          paceRatio:      monthlyBudget > 0 ? projectedTotal / monthlyBudget : null,
          pctUsed:        monthlyBudget > 0 ? (spentSoFar / monthlyBudget * 100) : 0
        };
      } catch (e) {
        return { name: accountId, monthlyBudget, spentSoFar: 0, projectedTotal: 0, paceRatio: null, pctUsed: 0, error: e.message };
      }
    }));

    const accounts = data.filter(a => a.monthlyBudget > 0 && !a.error);
    const noBudget = data.filter(a => !a.monthlyBudget && !a.error).map(a => ({ name: a.name, spentSoFar: a.spentSoFar }));

    const generatedAtStr = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
    }).format(today).replace(',', ' às');

    const html = generator.generateBudgetReport({
      accounts, noBudget, monthLabel, dayOfMonth, lastDay, daysRemaining,
      agencyName: config.agencyName || '', agencyLogo: config.agencyLogo || '',
      generatedAtStr
    });

    // Salva HTML + metadados (link público válido 90 dias)
    ensureReportsDir();
    cleanupExpired();
    const token     = genToken();
    const expiresAt = Date.now() + REPORT_TTL_MS;
    const meta      = { token, accountName: 'Relatório de Orçamento', since: sinceStr, until: untilStr, reportType: 'orcamento', expiresAt, createdAt: Date.now() };
    fs.writeFileSync(path.join(REPORTS_DIR, `${token}.html`), html, 'utf8');
    fs.writeFileSync(path.join(REPORTS_DIR, `${token}.json`), JSON.stringify(meta), 'utf8');

    const appBase  = process.env.APP_BASE_URL?.trim();
    const proto    = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host     = req.headers['x-forwarded-host']  || req.headers.host;
    const baseUrl  = appBase || `${proto}://${host}`;
    const shareUrl = `${baseUrl}/r/${token}`;

    res.json({
      shareUrl, token, expiresAt,
      summary: {
        accounts: accounts.length,
        noBudget: noBudget.length,
        totalBudget:    accounts.reduce((s, a) => s + a.monthlyBudget, 0),
        totalProjected: accounts.reduce((s, a) => s + a.projectedTotal, 0)
      }
    });
  } catch (err) {
    console.error('Erro ao gerar relatório de orçamento:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
