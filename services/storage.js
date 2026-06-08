const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const DATA_DIR      = path.join(__dirname, '..', 'data');
const TOKEN_FILE    = path.join(DATA_DIR, 'token.json');
const INSIGHTS_DIR  = path.join(DATA_DIR, 'insights');
const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');

// ── Criptografia AES-256-GCM ──────────────────────────────────────────────────
// Chave derivada do SESSION_SECRET via SHA-256 (32 bytes) — sem dependências extras.
// Formato cifrado: { v:1, iv:<hex>, tag:<hex>, data:<hex> }

function _encKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('[storage] SESSION_SECRET não definido — impossível cifrar tokens.');
  return crypto.createHash('sha256').update(secret).digest(); // Buffer 32 bytes
}

function _encrypt(plaintext) {
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', _encKey(), iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: enc.toString('hex') });
}

function _decrypt(content) {
  const { v, iv, tag, data } = JSON.parse(content);
  if (v !== 1) throw new Error('[storage] Versão de cifração desconhecida.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', _encKey(), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return decipher.update(Buffer.from(data, 'hex')) + decipher.final('utf8');
}

// Detecta se o conteúdo já está cifrado (tem o marcador v:1)
function _isCiphered(content) {
  try { const p = JSON.parse(content); return p.v === 1 && !!p.iv && !!p.tag && !!p.data; }
  catch { return false; }
}

// Lê arquivo sensível: descriptografa se cifrado, migra para cifrado se plain text
function _readSecure(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (_isCiphered(raw)) return _decrypt(raw);
  // Migração automática: arquivo em plain text → cifra e grava imediatamente
  const ciphered = _encrypt(raw);
  writeAtomic(filePath, ciphered);
  try { fs.chmodSync(filePath, 0o600); } catch {}
  return raw; // retorna o conteúdo original desta vez; já cifrado a partir daqui
}

// Grava arquivo sensível sempre cifrado
function _writeSecure(filePath, plainJson) {
  writeAtomic(filePath, _encrypt(plainJson));
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR))      fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(INSIGHTS_DIR))  fs.mkdirSync(INSIGHTS_DIR, { recursive: true });
  if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}

// Escrita atômica: grava em arquivo .tmp NO MESMO DIRETÓRIO do destino e depois
// renomeia atomicamente. Usar os.tmpdir() causaria erro EXDEV no Windows quando
// o temp está em drive diferente do projeto.
function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

// ── Token ────────────────────────────────────────────────────────────────────

function saveToken(tokenData) {
  ensureDirs();
  _writeSecure(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
}

function getToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    return JSON.parse(_readSecure(TOKEN_FILE));
  } catch { return null; }
}

function clearToken() {
  if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
}

// ── Multi-usuário: token e config por userId ──────────────────────────────────
const USERS_DIR = path.join(DATA_DIR, 'users');

function ensureUserDir(userId) {
  const dir = path.join(USERS_DIR, String(userId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveUserToken(userId, tokenData) {
  const dir = ensureUserDir(userId);
  _writeSecure(path.join(dir, 'token.json'), JSON.stringify(tokenData, null, 2));
}

function getUserToken(userId) {
  try {
    const file = path.join(USERS_DIR, String(userId), 'token.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(_readSecure(file));
  } catch { return null; }
}

function getAllUserIds() {
  try {
    if (!fs.existsSync(USERS_DIR)) return [];
    return fs.readdirSync(USERS_DIR).filter(d =>
      fs.statSync(path.join(USERS_DIR, d)).isDirectory()
    );
  } catch { return []; }
}

function saveUserMonitorConfig(userId, config) {
  const dir = ensureUserDir(userId);
  _writeSecure(path.join(dir, 'monitor-config.json'), JSON.stringify(config, null, 2));
}

function getUserMonitorConfig(userId) {
  try {
    const file = path.join(USERS_DIR, String(userId), 'monitor-config.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(_readSecure(file));
  } catch { return null; }
}

// ── Insights ─────────────────────────────────────────────────────────────────

function insightsKey(accountId, since, until) {
  return `${accountId}_${since}_${until}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function saveInsights(accountId, since, until, data) {
  ensureDirs();
  const file = path.join(INSIGHTS_DIR, `${insightsKey(accountId, since, until)}.json`);
  writeAtomic(file, JSON.stringify({ accountId, since, until, data, savedAt: Date.now() }, null, 2));
}

function getInsights(accountId, since, until) {
  const file = path.join(INSIGHTS_DIR, `${insightsKey(accountId, since, until)}.json`);
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')).data;
  } catch { return null; }
}

function getInsightsHistory(accountId) {
  ensureDirs();
  const safeId = accountId.replace(/[^a-zA-Z0-9]/g, '_');
  return fs.readdirSync(INSIGHTS_DIR)
    .filter(f => f.startsWith(safeId))
    .map(f => {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(INSIGHTS_DIR, f), 'utf8'));
        return { since: c.since, until: c.until, savedAt: c.savedAt };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.savedAt - a.savedAt);
}

// ── Snapshots históricos de métricas ─────────────────────────────────────────

// Salva snapshot diário de métricas (para histórico de tendências)
// accountId: 'act_xxx', metrics: { spend, impressions, reach, clicks, ctr, cpm, frequency, messages, costPerMessage }
function saveMetricsSnapshot(accountId, metrics) {
  ensureDirs();
  const today  = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const safeId = accountId.replace(/[^a-zA-Z0-9]/g, '_');
  const file   = path.join(SNAPSHOTS_DIR, `${safeId}_${today}.json`);
  // Se já existe snapshot hoje, só salva se não existir ainda
  if (!fs.existsSync(file)) {
    writeAtomic(file, JSON.stringify({ accountId, date: today, metrics, savedAt: Date.now() }, null, 2));
  }
}

// Retorna snapshots dos últimos N dias para uma conta (padrão 90)
function getMetricsSnapshots(accountId, days = 90) {
  ensureDirs();
  const safeId = accountId.replace(/[^a-zA-Z0-9]/g, '_');
  const since  = new Date();
  since.setDate(since.getDate() - days);
  return fs.readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.startsWith(safeId) && f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(SNAPSHOTS_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(s => s && new Date(s.date) >= since)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Monitor de saldo ──────────────────────────────────────────────────────────

const MONITOR_FILE = path.join(DATA_DIR, 'monitor-config.json');
const MONITOR_LOG  = path.join(DATA_DIR, 'monitor-log.json');
const NOTES_FILE   = path.join(DATA_DIR, 'notes.json');
const RULES_FILE   = path.join(DATA_DIR, 'alert-rules.json');
const TOKENS_FILE  = path.join(DATA_DIR, 'tokens.json');

function saveMonitorConfig(config) {
  ensureDirs();
  _writeSecure(MONITOR_FILE, JSON.stringify(config, null, 2));
}

function getMonitorConfig() {
  try {
    if (!fs.existsSync(MONITOR_FILE)) return null;
    return JSON.parse(_readSecure(MONITOR_FILE));
  } catch { return null; }
}

function saveMonitorLog(entry) {
  ensureDirs();
  let logs = [];
  try {
    if (fs.existsSync(MONITOR_LOG)) {
      logs = JSON.parse(fs.readFileSync(MONITOR_LOG, 'utf8'));
    }
  } catch {}
  logs.unshift(entry);
  if (logs.length > 100) logs = logs.slice(0, 100); // mantém últimos 100
  writeAtomic(MONITOR_LOG, JSON.stringify(logs, null, 2));
}

function getMonitorLogs() {
  try {
    if (!fs.existsSync(MONITOR_LOG)) return [];
    return JSON.parse(fs.readFileSync(MONITOR_LOG, 'utf8'));
  } catch { return []; }
}

// ── Notas por conta ───────────────────────────────────────────────────────────

function getNotes(accountId) {
  try {
    if (!fs.existsSync(NOTES_FILE)) return [];
    const all = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    return accountId ? all.filter(n => n.accountId === accountId) : all;
  } catch { return []; }
}

function saveNote(accountId, text) {
  ensureDirs();
  const notes = getNotes(null); // todos
  const note = {
    id:        `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    accountId,
    text:      text.trim().slice(0, 500),
    createdAt: Date.now(),
    date:      new Date().toISOString().split('T')[0]
  };
  notes.unshift(note);
  writeAtomic(NOTES_FILE, JSON.stringify(notes, null, 2));
  return note;
}

function deleteNote(noteId) {
  ensureDirs();
  const notes = getNotes(null).filter(n => n.id !== noteId);
  writeAtomic(NOTES_FILE, JSON.stringify(notes, null, 2));
}

// ── Regras de alerta customizadas ─────────────────────────────────────────────

function getAlertRules() {
  try {
    if (!fs.existsSync(RULES_FILE)) return [];
    return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  } catch { return []; }
}

function saveAlertRules(rules) {
  ensureDirs();
  writeAtomic(RULES_FILE, JSON.stringify(rules, null, 2));
}

// ── Multi-token ───────────────────────────────────────────────────────────────

// Carrega todos os tokens armazenados
function getTokens() {
  try {
    if (!fs.existsSync(TOKENS_FILE)) {
      // Migração: se existe token.json, migra para tokens.json
      const single = getToken();
      if (single) {
        const tokens = [{ ...single, id: 'primary', label: single.userName || 'Principal' }];
        _writeSecure(TOKENS_FILE, JSON.stringify(tokens, null, 2));
        return tokens;
      }
      return [];
    }
    return JSON.parse(_readSecure(TOKENS_FILE));
  } catch { return []; }
}

// Salva/atualiza um token pelo id
function upsertToken(tokenObj) {
  ensureDirs();
  const tokens = getTokens();
  const idx    = tokens.findIndex(t => t.id === tokenObj.id);
  if (idx >= 0) tokens[idx] = tokenObj;
  else          tokens.push(tokenObj);
  _writeSecure(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  // Mantém token.json sincronizado com o token primary para retrocompatibilidade
  const primary = tokens.find(t => t.id === 'primary') || tokens[0];
  if (primary) _writeSecure(TOKEN_FILE, JSON.stringify({ token: primary.token, expiresAt: primary.expiresAt, userId: primary.userId, userName: primary.userName }, null, 2));
}

// Remove um token pelo id (nunca remove o primary)
function removeToken(tokenId) {
  if (tokenId === 'primary') return;
  const tokens = getTokens().filter(t => t.id !== tokenId);
  writeAtomic(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// Retorna o token correto para uma conta (busca em todos os tokens)
function getTokenForAccount(accountId) {
  const tokens = getTokens().filter(t => t.expiresAt > Date.now());
  // Tenta encontrar token específico para a conta
  const specific = tokens.find(t => t.accounts?.includes(accountId));
  if (specific) return specific.token;
  // Fallback: token primário
  const primary = tokens.find(t => t.id === 'primary') || tokens[0];
  return primary?.token || null;
}

// Associa uma lista de contas a um token
function setTokenAccounts(tokenId, accounts) {
  const tokens = getTokens();
  const t      = tokens.find(t => t.id === tokenId);
  if (t) { t.accounts = accounts; _writeSecure(TOKENS_FILE, JSON.stringify(tokens, null, 2)); }
}

module.exports = {
  saveToken, getToken, clearToken,
  saveUserToken, getUserToken, getAllUserIds,
  saveUserMonitorConfig, getUserMonitorConfig,
  saveInsights, getInsights, getInsightsHistory,
  saveMetricsSnapshot, getMetricsSnapshots,
  saveMonitorConfig, getMonitorConfig, saveMonitorLog, getMonitorLogs,
  getNotes, saveNote, deleteNote,
  getAlertRules, saveAlertRules,
  getTokens, upsertToken, removeToken, getTokenForAccount, setTokenAccounts
};
