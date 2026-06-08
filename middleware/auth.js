const storage = require('../services/storage');

/**
 * Middleware de autenticação multi-usuário:
 * 1. Verifica APP_PASSWORD (senha do app)
 * 2. Verifica sessão ativa (login via OAuth)
 * 3. Carrega token do usuário correto pelo userId da sessão
 * 4. Injeta req.userId, req.token, req.tokenData
 */
function requireAuth(req, res, next) {
  // Verificação 1: senha do app
  if (process.env.APP_PASSWORD && !req.session?.appUnlocked) {
    return res.status(401).json({ error: 'APP_LOCKED' });
  }

  // Verificação 2: sessão Meta ativa
  if (!req.session?.authenticated) {
    return res.status(401).json({ error: 'Sessão inválida. Faça login novamente.' });
  }

  const userId = req.session.userId;

  // Carrega token: primeiro tenta por userId, depois fallback global (retrocompatível)
  let tokenData = userId ? storage.getUserToken(userId) : null;
  if (!tokenData) tokenData = storage.getToken();

  if (!tokenData || tokenData.expiresAt < Date.now()) {
    return res.status(401).json({ error: 'Token Meta expirado. Faça login novamente.' });
  }

  req.userId    = userId || tokenData.userId;
  req.token     = tokenData.token;
  req.tokenData = tokenData;
  req.getTokenForAccount = (accountId) => storage.getTokenForAccount(accountId) || tokenData.token;
  next();
}

module.exports = { requireAuth };
