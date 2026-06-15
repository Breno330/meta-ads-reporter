const express = require('express');
const storage = require('../services/storage');
const router  = express.Router();

// ── Rate limit para /unlock — máx 5 tentativas por IP a cada 15 min ──────────
const _unlockAttempts = new Map();
const UNLOCK_WINDOW   = 15 * 60 * 1000; // 15 min
const UNLOCK_MAX      = 5;

function unlockRateLimit(ip) {
  const now   = Date.now();
  const entry = _unlockAttempts.get(ip) || { count: 0, since: now };
  if (now - entry.since > UNLOCK_WINDOW) { entry.count = 0; entry.since = now; }
  entry.count++;
  _unlockAttempts.set(ip, entry);
  if (entry.count > UNLOCK_MAX) {
    const wait = Math.ceil((UNLOCK_WINDOW - (now - entry.since)) / 60000);
    return { blocked: true, wait };
  }
  return { blocked: false, remaining: UNLOCK_MAX - entry.count + 1 };
}

// Limpeza periódica
setInterval(() => {
  const cutoff = Date.now() - UNLOCK_WINDOW;
  for (const [ip, e] of _unlockAttempts) {
    if (e.since < cutoff) _unlockAttempts.delete(ip);
  }
}, 5 * 60 * 1000);

const APP_ID       = process.env.META_APP_ID;
const APP_SECRET   = process.env.META_APP_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';
const SCOPES       = 'public_profile,ads_read,business_management,pages_read_engagement';
const API_VERSION  = 'v20.0';

// Inicia o fluxo OAuth
router.get('/login', (req, res) => {
  if (!APP_ID) {
    return res.send('<h2>Configure o arquivo .env com META_APP_ID e META_APP_SECRET antes de fazer login.</h2>');
  }
  const url = `https://www.facebook.com/${API_VERSION}/dialog/oauth?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${SCOPES}&response_type=code`;
  res.redirect(url);
});

// Inicia OAuth para adicionar um token adicional (label vem via query param)
router.get('/add-token', (req, res) => {
  if (!req.session?.authenticated) return res.redirect('/');
  if (!APP_ID) return res.send('Configure META_APP_ID no .env');
  const label = req.query.label || 'Token adicional';
  req.session.addingTokenLabel = label;
  const url = `https://www.facebook.com/${API_VERSION}/dialog/oauth?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${SCOPES}&response_type=code&state=add_token`;
  res.redirect(url);
});

// Callback OAuth — troca o código pelo token
router.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect('/?error=auth_failed');
  }

  try {
    // Token de curta duração
    const tokenRes = await fetch(
      `https://graph.facebook.com/${API_VERSION}/oauth/access_token?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&client_secret=${APP_SECRET}&code=${code}`
    );
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error('Erro ao obter token:', tokenData);
      return res.redirect('/?error=token_failed');
    }

    // Troca por token de longa duração (~60 dias)
    const longRes = await fetch(
      `https://graph.facebook.com/${API_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${tokenData.access_token}`
    );
    const longData = await longRes.json();

    const token     = longData.access_token || tokenData.access_token;
    const expiresIn = longData.expires_in || 5184000; // 60 dias padrão
    const expiresAt = Date.now() + expiresIn * 1000;

    // Dados do usuário
    const userRes  = await fetch(`https://graph.facebook.com/${API_VERSION}/me?fields=id,name`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const userData = await userRes.json();

    // Verifica se é adição de token adicional
    if (req.query.state === 'add_token') {
      const label = req.session.addingTokenLabel || 'Token adicional';
      const newToken = {
        id:       `token-${Date.now()}`,
        label,
        token,
        expiresAt,
        userId:   userData.id,
        userName: userData.name,
        accounts: []
      };
      storage.upsertToken(newToken);
      delete req.session.addingTokenLabel;
      res.redirect('/?added_token=1');
      return;
    }

    const tokenPayload = { token, expiresAt, userId: userData.id, userName: userData.name };

    // Salva por userId (multi-usuário) E global (retrocompatível)
    storage.saveUserToken(userData.id, tokenPayload);
    storage.saveToken(tokenPayload);

    req.session.authenticated = true;
    req.session.userName      = userData.name;
    req.session.userId        = userData.id;

    res.redirect('/');
  } catch (err) {
    console.error('Erro no callback OAuth:', err);
    res.redirect('/?error=auth_failed');
  }
});

// Logout
router.get('/logout', (req, res) => {
  req.session.destroy();
  storage.clearToken();
  res.redirect('/');
});

// Status da autenticação
router.get('/status', (req, res) => {
  const userId  = req.session?.userId;

  // Carrega token do usuário da sessão; fallback para token global (retrocompatível)
  let tokenData = userId ? storage.getUserToken(userId) : null;
  if (!tokenData) tokenData = storage.getToken();

  const tokenValid   = tokenData && tokenData.expiresAt > Date.now();
  const sessionValid = !!req.session?.authenticated;

  // Restaura sessão automaticamente APENAS se o userId da sessão bate com o token
  // Impede que um novo usuário herde automaticamente a sessão de outro
  const sessionUserId = req.session?.userId;
  if (tokenValid && !sessionValid && req.session?.appUnlocked && sessionUserId && sessionUserId === tokenData.userId) {
    req.session.authenticated = true;
    req.session.userName      = tokenData.userName;
    req.session.userId        = tokenData.userId;
  }

  // Garante que userId esteja sempre na sessão quando autenticado
  if (tokenValid && sessionValid && tokenData.userId && !req.session.userId) {
    req.session.userId = tokenData.userId;
  }

  res.json({
    authenticated: !!(tokenValid && req.session?.authenticated),
    appUnlocked:   !!req.session?.appUnlocked,
    userName:      tokenData?.userName || null,
    expiresAt:     tokenData?.expiresAt || null,
    daysRemaining: tokenValid
      ? Math.floor((tokenData.expiresAt - Date.now()) / (1000 * 60 * 60 * 24))
      : 0
  });
});

// Desbloqueio por senha do app (APP_PASSWORD no .env)
router.post('/unlock', (req, res) => {
  const appPassword = process.env.APP_PASSWORD;

  // Se APP_PASSWORD não está definida, acesso liberado (uso local sem senha)
  if (!appPassword) {
    req.session.appUnlocked = true;
    return res.json({ ok: true });
  }

  // Rate limit por IP
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const rl = unlockRateLimit(ip);
  if (rl.blocked) {
    return res.status(429).json({ error: `Muitas tentativas incorretas. Aguarde ${rl.wait} minuto(s).` });
  }

  const { password } = req.body;
  if (!password || password !== appPassword) {
    const hint = rl.remaining > 1
      ? `Senha incorreta. ${rl.remaining - 1} tentativa(s) restante(s).`
      : 'Senha incorreta. Última tentativa — IP será bloqueado por 15 minutos.';
    return res.status(401).json({ error: hint });
  }

  // Login bem-sucedido: limpar histórico de tentativas
  _unlockAttempts.delete(ip);
  req.session.appUnlocked = true;
  res.json({ ok: true });
});

module.exports = router;
