require('dotenv').config();

// ── Handlers globais de erro ──────────────────────────────────────────────────
// Evitam que promessas rejeitadas ou exceções inesperadas derrubem o processo
// sem deixar rastro, o que silenciaria alertas e relatórios agendados.
process.on('unhandledRejection', (reason) => {
  console.error('[ERRO] Promise rejeitada não tratada:', reason);
  // Tenta notificar via Telegram se o monitor estiver configurado
  try {
    const storage  = require('./services/storage');
    const telegram = require('./services/telegram');
    const config   = storage.getMonitorConfig();
    if (config?.telegramToken && config?.telegramChatId) {
      const msg = `⚠️ *Meta Ads Reporter — Erro interno*\n\`${String(reason).slice(0, 300)}\``;
      telegram.send(config.telegramToken, config.telegramChatId, msg).catch(() => {});
    }
  } catch {}
});

process.on('uncaughtException', (err) => {
  console.error('[ERRO CRÍTICO] Exceção não capturada:', err);
  // Encerra o processo após logar — PM2 reinicia automaticamente
  process.exit(1);
});

// ── Variáveis de ambiente obrigatórias ────────────────────────────────────────
const REQUIRED_ENV = ['META_APP_ID', 'META_APP_SECRET', 'SESSION_SECRET'];
const missingEnv   = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error(`\n❌ Variáveis obrigatórias não definidas: ${missingEnv.join(', ')}`);
  console.error('   Configure o arquivo .env antes de iniciar.\n');
  process.exit(1);
}

const express        = require('express');
const session        = require('express-session');
const FileStore      = require('session-file-store')(session);
const path           = require('path');
const fs             = require('fs');
const cron           = require('node-cron');
const storage        = require('./services/storage');
const balanceMonitor = require('./services/balance-monitor');

const authRoutes    = require('./routes/auth');
const clientsRoutes = require('./routes/clients');
const insightsRoutes = require('./routes/insights');
const reportsRoutes = require('./routes/reports');
const monitorRoutes = require('./routes/monitor');
const notesRoutes   = require('./routes/notes');

const app  = express();
const PORT = process.env.PORT || 3000;

// Render, Heroku e outros PaaS ficam atrás de um proxy reverso.
// Sem isso, cookies secure não são enviados e as sessões não persistem.
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Security Headers ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  // Relatórios públicos têm HTML inline completo — CSP aplicado separadamente na rota /r/
  if (!req.path.startsWith('/r/')) {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://connect.facebook.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https://graph.facebook.com https://www.facebook.com https://cdn.jsdelivr.net",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'"
    ].join('; '));
  }
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Acesso externo via túnel habilitado — APP_PASSWORD protege o sistema.
// secure:true em produção (HTTPS); false em localhost
// httpOnly: JS do browser não consegue ler o cookie (proteção XSS)
// sameSite: bloqueia envio cross-site (proteção CSRF)
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24h

// Sessões persistidas em disco (data/sessions/) — sobrevivem a restart/deploy.
// Sem isso, o express-session usa MemoryStore e todo reinício desloga os usuários.
app.use(session({
  store: new FileStore({
    path:    path.join(__dirname, 'data', 'sessions'),
    ttl:     SESSION_MAX_AGE / 1000, // segundos
    retries: 1,
    reapInterval: 60 * 60,           // limpa sessões expiradas a cada 1h
    logFn:   () => {}                // silencia logs verbosos do store
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure:   isProduction,
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   SESSION_MAX_AGE
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/auth',         authRoutes);
app.use('/api/clients',  clientsRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/reports',  reportsRoutes);
app.use('/api/monitor',  monitorRoutes);
app.use('/api/notes',    notesRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Relatórios compartilhados (link público, sem autenticação) ────────────────
const REPORTS_DIR = path.join(__dirname, 'data', 'reports');

// Rate-limit simples em memória para relatórios públicos (sem dependências)
// Máx. 30 requisições por IP a cada 10 minutos
const _reportRateMap = new Map();
function _reportRateLimit(ip) {
  const now    = Date.now();
  const window = 10 * 60 * 1000; // 10 min
  const limit  = 30;
  const entry  = _reportRateMap.get(ip) || { count: 0, since: now };
  if (now - entry.since > window) { entry.count = 0; entry.since = now; }
  entry.count++;
  _reportRateMap.set(ip, entry);
  return entry.count > limit;
}
// Limpa IPs antigos a cada hora
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [ip, e] of _reportRateMap) { if (e.since < cutoff) _reportRateMap.delete(ip); }
}, 60 * 60 * 1000);

app.get('/r/:token', (req, res) => {
  // Sanitiza token: apenas chars base64url
  const token = (req.params.token || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!token) return res.status(400).send('Link inválido.');

  // Rate limit por IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (_reportRateLimit(ip)) {
    return res.status(429).send('Muitas requisições. Aguarde alguns minutos.');
  }

  const metaFile = path.join(REPORTS_DIR, `${token}.json`);
  const htmlFile = path.join(REPORTS_DIR, `${token}.html`);

  if (!fs.existsSync(metaFile) || !fs.existsSync(htmlFile)) {
    return res.status(404).send(`
      <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
      <title>Relatório não encontrado</title>
      <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0b1a12;color:#e2e8f0}
      .box{text-align:center;padding:40px}.h{font-size:48px;margin-bottom:8px}.t{font-size:20px;font-weight:600;margin-bottom:8px}.s{font-size:14px;color:#64748b}</style>
      </head><body><div class="box">
        <div class="h">🔍</div>
        <div class="t">Relatório não encontrado</div>
        <div class="s">Este link pode ter expirado ou sido revogado.</div>
      </div></body></html>`);
  }

  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));

    if (meta.expiresAt < Date.now()) {
      return res.status(410).send(`
        <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
        <title>Link expirado</title>
        <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0b1a12;color:#e2e8f0}
        .box{text-align:center;padding:40px}.h{font-size:48px;margin-bottom:8px}.t{font-size:20px;font-weight:600;margin-bottom:8px}.s{font-size:14px;color:#64748b}</style>
        </head><body><div class="box">
          <div class="h">⏰</div>
          <div class="t">Link expirado</div>
          <div class="s">Este relatório expirou. Solicite um novo link.</div>
        </div></body></html>`);
    }

    // ── Registra acesso no meta do relatório ──────────────────────────────────
    try {
      const ua      = (req.headers['user-agent'] || '').slice(0, 150);
      const ipMask  = ip.replace(/(\d+\.\d+)\.\d+\.\d+/, '$1.x.x'); // mascara últimos octetos
      const entry   = { ts: Date.now(), ip: ipMask, ua };
      meta.accessCount    = (meta.accessCount || 0) + 1;
      meta.lastAccessedAt = entry.ts;
      meta.accessLog      = [entry, ...(meta.accessLog || [])].slice(0, 20); // máx 20 entradas
      fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8');
    } catch { /* log falhou — não bloqueia o acesso */ }

  } catch {}

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.sendFile(htmlFile);
});

// ── Agendador do monitor de saldo ─────────────────────────────────────────────

let cronJob = null;

function startScheduler(checkTime) {
  if (cronJob) { cronJob.stop(); cronJob = null; }

  const [hour, minute] = (checkTime || '08:00').split(':');
  const expression     = `${minute} ${hour} * * *`;

  if (!cron.validate(expression)) {
    console.warn(`Expressão cron inválida: ${expression}`);
    return;
  }

  let checkRunning = false;
  cronJob = cron.schedule(expression, async () => {
    if (checkRunning) {
      console.warn('[Monitor] Verificação anterior ainda em andamento — execução ignorada.');
      return;
    }
    checkRunning = true;
    console.log(`[Monitor] Verificando saldo — ${new Date().toLocaleString('pt-BR')}`);
    try {
      const result = await balanceMonitor.runCheck();
      if (result.alerts?.length) {
        console.log(`[Monitor] ${result.alerts.length} alerta(s) enviado(s).`);
      } else if (!result.skipped) {
        console.log(`[Monitor] Verificação concluída. Nenhum alerta.`);
      }
    } catch (err) {
      console.error('[Monitor] Erro na verificação:', err.message);
    } finally {
      checkRunning = false;
    }
  }, { timezone: 'America/Sao_Paulo' });

  console.log(`[Monitor] Agendado para ${checkTime} (Brasília)`);
}

// ── Agendador do relatório semanal ────────────────────────────────────────────

let weeklyReportCron = null;

function startWeeklyReportScheduler(day, time) {
  if (weeklyReportCron) { weeklyReportCron.stop(); weeklyReportCron = null; }
  const [hour, minute] = (time || '18:00').split(':');
  const expression = `${minute} ${hour} * * ${day ?? 0}`;
  if (!cron.validate(expression)) return;
  let weeklyRunning = false;
  weeklyReportCron = cron.schedule(expression, async () => {
    if (weeklyRunning) {
      console.warn('[Relatório Semanal] Execução anterior ainda em andamento — ignorada.');
      return;
    }
    weeklyRunning = true;
    console.log(`[Relatório Semanal] Gerando e enviando — ${new Date().toLocaleString('pt-BR')}`);
    try {
      const result = await balanceMonitor.runWeeklyReports();
      console.log(`[Relatório Semanal] Concluído:`, result);
    } catch (err) {
      console.error('[Relatório Semanal] Erro:', err.message);
    } finally {
      weeklyRunning = false;
    }
  }, { timezone: 'America/Sao_Paulo' });
  console.log(`[Relatório Semanal] Agendado — dia ${day}, ${time} (Brasília)`);
}

// ── Agendador de verificação de performance ───────────────────────────────────

let performanceCheckCron = null;

function startPerformanceCheckScheduler(time) {
  if (performanceCheckCron) { performanceCheckCron.stop(); performanceCheckCron = null; }
  if (!time) return; // null = desativar

  const [hour, minute] = time.split(':');
  const expression     = `${minute} ${hour} * * *`;

  if (!cron.validate(expression)) {
    console.warn(`[Performance] Expressão cron inválida: ${expression}`);
    return;
  }

  let perfRunning = false;
  performanceCheckCron = cron.schedule(expression, async () => {
    if (perfRunning) {
      console.warn('[Performance] Verificação anterior ainda em andamento — ignorada.');
      return;
    }
    perfRunning = true;
    console.log(`[Performance] Verificando performance — ${new Date().toLocaleString('pt-BR')}`);
    try {
      const result = await balanceMonitor.runPerformanceCheck();
      if (result.alerts?.length) {
        console.log(`[Performance] ${result.alerts.length} conta(s) com alerta.`);
      } else if (!result.skipped) {
        console.log(`[Performance] Nenhum alerta de performance.`);
      }
    } catch (err) {
      console.error('[Performance] Erro:', err.message);
    } finally {
      perfRunning = false;
    }
  }, { timezone: 'America/Sao_Paulo' });

  console.log(`[Performance] Agendado para ${time} (Brasília)`);
}

// ── Verificador frequente de alertas críticos (a cada 2 horas) ───────────────
// Reutiliza o runCheck() existente — cooldown de 6h dentro do próprio serviço
// evita spam. Garante que uma conta crítica seja notificada em no máximo 2h.

let urgentCheckCron = null;

function startUrgentCheckScheduler() {
  if (urgentCheckCron) { urgentCheckCron.stop(); urgentCheckCron = null; }
  urgentCheckCron = cron.schedule('0 */2 * * *', async () => {
    console.log(`[Urgente] Verificação de saldo crítico — ${new Date().toLocaleString('pt-BR')}`);
    try {
      const result = await balanceMonitor.runCheck();
      if (result.alerts?.length) {
        console.log(`[Urgente] ${result.alerts.length} alerta(s) de saldo enviado(s).`);
      } else if (!result.skipped) {
        console.log('[Urgente] Nenhum alerta crítico encontrado.');
      }
    } catch (e) {
      console.error('[Urgente] Erro:', e.message);
    }

    // ── Verificação de orçamento diário (junto com o check urgente) ───────────
    try {
      const dr = await balanceMonitor.runDailyBudgetCheck();
      if (dr.alerts?.length) {
        console.log(`[Urgente] ${dr.alerts.length} alerta(s) de orçamento diário enviado(s).`);
      } else if (!dr.skipped) {
        console.log('[Urgente] Orçamento diário: dentro do limite em todas as contas.');
      }
    } catch (e) {
      console.error('[Urgente] Erro no orçamento diário:', e.message);
    }
  }, { timezone: 'America/Sao_Paulo' });
  console.log('[Urgente] Verificador crítico ativo — roda a cada 2h (Brasília)');
}

// ── Agendador do relatório mensal ────────────────────────────────────────────
// Roda no dia X de cada mês às HH:MM — envia relatório do mês anterior.

let monthlyReportCron = null;

function startMonthlyReportScheduler(day, time) {
  if (monthlyReportCron) { monthlyReportCron.stop(); monthlyReportCron = null; }
  if (!day || !time) return;
  const [hour, minute] = (time || '10:00').split(':');
  const expression = `${minute} ${hour} ${day} * *`; // ex: "0 10 1 * *"
  if (!cron.validate(expression)) {
    console.warn(`[Relatório Mensal] Expressão cron inválida: ${expression}`);
    return;
  }
  let monthlyRunning = false;
  monthlyReportCron = cron.schedule(expression, async () => {
    if (monthlyRunning) { console.warn('[Relatório Mensal] Execução anterior em andamento — ignorada.'); return; }
    monthlyRunning = true;
    console.log(`[Relatório Mensal] Gerando relatório do mês anterior — ${new Date().toLocaleString('pt-BR')}`);
    try {
      const result = await balanceMonitor.runWeeklyReports('mensal');
      console.log(`[Relatório Mensal] Concluído:`, result);
    } catch (err) {
      console.error('[Relatório Mensal] Erro:', err.message);
    } finally {
      monthlyRunning = false;
    }
  }, { timezone: 'America/Sao_Paulo' });
  console.log(`[Relatório Mensal] Agendado — dia ${day} de cada mês às ${time} (Brasília)`);
}

// Expõe função de reagendamento para as rotas
app.set('scheduler', {
  reschedule:                    (time)      => startScheduler(time),
  rescheduleWeeklyReport:        (day, time) => startWeeklyReportScheduler(day, time),
  reschedulePerformanceCheck:    (time)      => startPerformanceCheckScheduler(time),
  rescheduleMonthlyReport:       (day, time) => startMonthlyReportScheduler(day, time)
});

// Inicia o cron com a config salva (se existir)
const savedConfig = storage.getMonitorConfig();
if (savedConfig?.enabled && savedConfig?.checkTime) {
  startScheduler(savedConfig.checkTime);
}
if (savedConfig?.weeklyReportEnabled) {
  startWeeklyReportScheduler(savedConfig.weeklyReportDay ?? 0, savedConfig.weeklyReportTime || '10:00');
}
if (savedConfig?.monthlyReportEnabled) {
  startMonthlyReportScheduler(savedConfig.monthlyReportDay ?? 1, savedConfig.monthlyReportTime || '10:00');
}
if (savedConfig?.performanceCheckEnabled && savedConfig?.performanceCheckTime) {
  startPerformanceCheckScheduler(savedConfig.performanceCheckTime);
}
// Verificador urgente sempre ativo (independente do monitor principal)
if (savedConfig?.enabled) {
  startUrgentCheckScheduler();
}

app.listen(PORT, () => {
  console.log(`\n✅ Meta Ads Reporter rodando em http://localhost:${PORT}\n`);
});
