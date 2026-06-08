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

module.exports = router;
