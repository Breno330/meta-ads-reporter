// ── Formatadores ──────────────────────────────────────────────────────────────
function brl(v) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0); }
function num(v) { return new Intl.NumberFormat('pt-BR').format(v || 0); }
function pct(v) { return `${(v || 0).toFixed(2)}%`; }
function dateBR(s) { const [y,m,d] = s.split('-'); return `${d}/${m}/${y}`; }
function monthYear(s) {
  const months = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  const [y, m] = s.split('-');
  return `${months[parseInt(m) - 1]} de ${y}`;
}
function delta(curr, prev) {
  if (!prev || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}
function cleanCampName(name) {
  const cleaned = name.replace(/\[[^\]]*\]/g, '').replace(/^\s*[-–—]\s*/, '').replace(/\s+/g, ' ').trim();
  return cleaned || name;
}
function _campaignScore(c) {
  const f = c.frequency || 0, ctr = c.ctr || 0;
  const fs = f === 0 ? 50 : f <= 2 ? 100 : f <= 3 ? 80 : f <= 4 ? 60 : f <= 5.5 ? 40 : f <= 7 ? 20 : 0;
  const cs = ctr >= 2.5 ? 100 : ctr >= 1.5 ? 85 : ctr >= 1.0 ? 70 : ctr >= 0.5 ? 50 : 25;
  const score = Math.round(fs * 0.5 + cs * 0.5);
  if (score >= 80) return { score, label: 'Saudável', color: '#27A065' };
  if (score >= 60) return { score, label: 'Atenção',  color: '#E8A020' };
  if (score >= 40) return { score, label: 'Risco',    color: '#f97316' };
  return              { score, label: 'Crítico',  color: '#E24B4A' };
}

// ── Análise ───────────────────────────────────────────────────────────────────
function analyze(current, previous) {
  const issues = [], opportunities = [];
  if (current.ctr < 1) {
    issues.push({ metric: 'CTR', value: pct(current.ctr),
      message: `CTR de ${pct(current.ctr)} abaixo de 1%. O anúncio não está gerando cliques suficientes.`,
      action: 'Testar novo criativo ou revisar segmentação.' });
  } else if (current.ctr >= 2) {
    opportunities.push({ metric: 'CTR', value: pct(current.ctr),
      message: `CTR de ${pct(current.ctr)} acima de 2%. Bom momento para escalar o orçamento.` });
  }
  if (current.frequency > 10) {
    issues.push({ metric: 'Frequência', value: current.frequency.toFixed(1),
      message: `Frequência ${current.frequency.toFixed(1)} muito acima do limite. Risco de saturação.`,
      action: 'Trocar criativo ou ampliar o público imediatamente.' });
  } else if (current.frequency > 7) {
    issues.push({ metric: 'Frequência', value: current.frequency.toFixed(1),
      message: `Frequência ${current.frequency.toFixed(1)} se aproximando do limite crítico.`,
      action: 'Preparar novo criativo preventivamente.' });
  }
  const convRate = (current.clicks > 0 && current.messages > 0) ? (current.messages / current.clicks * 100) : null;
  if (convRate !== null && convRate < 40) {
    issues.push({ metric: 'Conversão clique→mensagem', value: pct(convRate),
      message: `${pct(convRate)} de conversão — abaixo da meta de 40%.`,
      action: 'Verificar link do WhatsApp e pré-mensagem configurada.' });
  } else if (convRate !== null && convRate >= 60) {
    opportunities.push({ metric: 'Conversão', value: pct(convRate),
      message: `${pct(convRate)} de cliques viram mensagem. Ótimo alinhamento anúncio-público.` });
  }
  if (previous && current.costPerMessage && previous.costPerMessage) {
    const d = delta(current.costPerMessage, previous.costPerMessage);
    const dVol = previous.messages > 0 ? Math.abs(delta(current.messages, previous.messages)) : 100;
    if (d > 20 && dVol < 10) {
      issues.push({ metric: 'Custo por mensagem', value: brl(current.costPerMessage),
        message: `Custo subiu ${d.toFixed(0)}% sem crescimento de volume.`,
        action: 'Monitorar. Se persistir, reiniciar conjunto ou expandir público.' });
    } else if (d !== null && d < -15) {
      opportunities.push({ metric: 'Custo por mensagem', value: brl(current.costPerMessage),
        message: `Custo caiu ${Math.abs(d).toFixed(0)}% vs período anterior. Algoritmo otimizando bem.` });
    }
  }
  return { issues, opportunities };
}

// ── Score de desempenho ───────────────────────────────────────────────────────
function calculateScore(current, previous) {
  let s = 50;
  if (previous) {
    if (current.costPerMessage && previous.costPerMessage) {
      const d = delta(current.costPerMessage, previous.costPerMessage);
      if (d < -15) s += 15; else if (d < -5) s += 8;
      else if (d > 20) s -= 15; else if (d > 10) s -= 8;
    }
    if (current.messages > 0 && previous.messages > 0) {
      const d = delta(current.messages, previous.messages);
      if (d > 15) s += 12; else if (d > 5) s += 6;
      else if (d < -15) s -= 12; else if (d < -5) s -= 6;
    }
  }
  if (current.ctr >= 2.5) s += 10; else if (current.ctr >= 1.5) s += 5;
  else if (current.ctr < 0.8) s -= 10; else if (current.ctr < 1.2) s -= 5;
  if (current.frequency > 7) s -= 12; else if (current.frequency > 5) s -= 6;
  else if (current.frequency <= 2 && current.frequency > 0) s += 5;
  if (current.messages > 0 && current.clicks > 0) {
    const conv = current.messages / current.clicks * 100;
    if (conv >= 60) s += 8; else if (conv < 20) s -= 8;
  }
  return Math.max(0, Math.min(100, Math.round(s)));
}
function scoreLabel(s) {
  if (s >= 80) return 'Excelente'; if (s >= 65) return 'Bom';
  if (s >= 45) return 'Regular';  if (s >= 25) return 'Atenção';
  return 'Crítico';
}
function scoreColor(s) {
  if (s >= 65) return '#C9A84C'; if (s >= 45) return '#E8A020'; return '#E24B4A';
}
function buildContextParagraph(current, previous) {
  const parts = [];
  if (previous) {
    if (current.costPerMessage && previous.costPerMessage) {
      const d = delta(current.costPerMessage, previous.costPerMessage);
      if (d < -5) parts.push(`custo por mensagem caiu ${Math.abs(d).toFixed(0)}% (${brl(previous.costPerMessage)} → ${brl(current.costPerMessage)})`);
      else if (d > 10) parts.push(`custo por mensagem subiu ${d.toFixed(0)}% (${brl(previous.costPerMessage)} → ${brl(current.costPerMessage)})`);
    }
    if (current.messages > 0 && previous.messages > 0) {
      const d = delta(current.messages, previous.messages);
      if (d > 5) parts.push(`conversas subiram ${d.toFixed(0)}% (${num(previous.messages)} → ${num(current.messages)})`);
      else if (d < -5) parts.push(`conversas caíram ${Math.abs(d).toFixed(0)}% (${num(previous.messages)} → ${num(current.messages)})`);
    }
    if (current.reach > 0 && previous.reach > 0) {
      const d = delta(current.reach, previous.reach);
      if (Math.abs(d) > 10) parts.push(`alcance ${d > 0 ? 'cresceu' : 'caiu'} ${Math.abs(d).toFixed(0)}%`);
    }
  }
  if (current.frequency > 5) parts.push(`frequência elevada em ${current.frequency.toFixed(1)}× — atenção à saturação`);
  if (parts.length === 0) return `Semana com ${num(current.messages || 0)} conversas e ${brl(current.spend)} investidos. Alcance de ${num(current.reach || 0)} pessoas com CTR de ${pct(current.ctr)}.`;
  return parts.join(' · ') + '.';
}

// ── Funil de conversão ────────────────────────────────────────────────────────
function buildFunnelHtml(current) {
  const reach = current.reach || 0, clicks = current.clicks || 0, messages = current.messages || 0;
  const clickPct = reach > 0 ? clicks / reach * 100 : 0;
  const msgPct   = reach > 0 ? messages / reach * 100 : 0;
  const conv     = clicks > 0 ? messages / clicks * 100 : 0;
  const convColor = conv >= 40 ? '#27A065' : '#E24B4A';
  const bar = (w, color, label, sub) => `
    <div style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
        <span style="font-size:11px;font-weight:600;color:var(--text-secondary)">${label}</span>
        <span style="font-size:12px;font-weight:700;color:var(--text-primary)">${sub}</span>
      </div>
      <div style="height:9px;background:var(--bg-secondary);border-radius:99px;overflow:hidden">
        <div style="height:100%;width:${Math.min(w,100)}%;background:${color};border-radius:99px"></div>
      </div>
    </div>`;
  return `
    ${bar(100, '#185FA5', 'Alcance', num(reach))}
    ${bar(clickPct, '#378ADD', 'Cliques no link', `${num(clicks)} · ${clickPct.toFixed(1)}% do alcance`)}
    ${bar(msgPct, convColor, 'Conversas iniciadas', `${num(messages)} · ${msgPct.toFixed(2)}% do alcance`)}
    <div style="margin-top:10px;padding:8px 12px;background:${convColor}14;border:1px solid ${convColor}30;border-radius:6px;display:flex;align-items:center;gap:8px">
      <span style="font-size:11px;color:${convColor};font-weight:700">Conv. clique→msg: ${conv.toFixed(1)}%</span>
      <span style="font-size:10px;color:var(--text-muted)">meta: 40%</span>
    </div>
    <div style="margin-top:8px;font-size:9px;color:var(--text-muted);font-style:italic">Barras mostram proporção real sobre o alcance total.</div>`;
}

// ── Gráficos ──────────────────────────────────────────────────────────────────
function buildChartsHtml(current) {
  const daily = current.daily || [];
  if (!daily.length && !current.reach) return '';
  const labels    = JSON.stringify(daily.map(d => { const [,m,dia] = d.date.split('-'); return `${dia}/${m}`; }));
  const spendData = JSON.stringify(daily.map(d => parseFloat(d.spend).toFixed(2)));
  return `
  <section style="margin-bottom:32px">
    <h2 class="section-title">📈 Desempenho Visual</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:20px">
        <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:16px">Funil de conversão</div>
        ${buildFunnelHtml(current)}
      </div>
      ${daily.length > 0 ? `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:20px">
        <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:14px">Gasto diário (R$)</div>
        <canvas id="chart-daily" height="170"></canvas>
      </div>` : ''}
    </div>
  </section>
  <script>
  (function(){
    Chart.defaults.font.family = "'DM Sans', system-ui, sans-serif";
    Chart.defaults.font.size = 11;
    ${daily.length > 0 ? `
    const isDk = !document.body.classList.contains('light-mode');
    const gc   = isDk ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
    const tc   = isDk ? '#537085' : '#7A9488';
    new Chart(document.getElementById('chart-daily'), {
      type: 'bar',
      data: {
        labels: ${labels},
        datasets: [{ data: ${spendData}, backgroundColor: '#185FA5', borderRadius: 3, borderSkipped: false }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => 'R$ ' + parseFloat(ctx.parsed.y).toLocaleString('pt-BR',{minimumFractionDigits:2}) } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: tc } },
          y: { grid: { color: gc }, ticks: { color: tc, callback: v => 'R$ ' + v.toLocaleString('pt-BR') } }
        }
      }
    });` : ''}
  })();
  <\/script>`;
}

// ── Campanhas agrupadas por objetivo ─────────────────────────────────────────
function buildCampaignSectionsHtml(campaigns) {
  if (!campaigns || !campaigns.length) return '';
  const active = campaigns.filter(c => c.impressions > 0 || c.spend > 0);
  if (!active.length) return '';

  const groups = {};
  for (const c of active) { const k = c.objective || 'Outros'; (groups[k] = groups[k] || []).push(c); }

  const isMsgObj   = o => o && /message|mensagem|whatsapp|lead|conversa/i.test(o);
  const isTrafObj  = o => o && /traffic|tráfego|link_click|click/i.test(o);

  const groupHtml = Object.entries(groups).map(([obj, camps]) => {
    const isMsg  = isMsgObj(obj);
    const isTraf = isTrafObj(obj);
    const icon = isMsg
      ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`
      : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
    const objLabel = isMsg ? 'Objetivo: engajamento / mensagens WhatsApp'
      : isTraf ? 'Objetivo: tráfego — cliques para perfil do Instagram'
      : `Objetivo: ${obj}`;

    const rows = camps.map(c => {
      const health   = _campaignScore(c);
      const conv     = c.clicks > 0 && c.messages > 0 ? (c.messages/c.clicks*100).toFixed(1)+'%' : null;
      const convCell = isTraf
        ? `<td style="padding:11px 13px;text-align:right;color:var(--text-muted);font-size:11px">—<div style="font-size:9px;margin-top:1px">não aplicável</div></td>`
        : `<td style="padding:11px 13px;text-align:right;font-size:12px;font-weight:600;color:${conv && parseFloat(conv)>=40?'var(--text-success)':'var(--text-danger)'}">${conv||'—'}</td>`;
      const msgColor = isTraf ? 'var(--text-muted)' : 'var(--text-info)';
      return `
      <tr style="border-top:1px solid var(--border-subtle)">
        <td style="padding:11px 13px">
          <div style="font-size:12px;font-weight:500;color:var(--text-primary);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${c.name}">${c.name}</div>
          <span style="display:inline-flex;align-items:center;gap:3px;margin-top:3px;padding:1px 6px;border-radius:3px;background:${health.color}18;border:1px solid ${health.color}28">
            <span style="width:4px;height:4px;border-radius:50%;background:${health.color};display:inline-block"></span>
            <span style="font-size:8px;font-weight:700;color:${health.color};letter-spacing:.07em">${health.label.toUpperCase()}</span>
          </span>
        </td>
        <td style="padding:11px 13px;text-align:right;color:var(--text-secondary);font-size:12px">${num(c.reach)}</td>
        <td style="padding:11px 13px;text-align:right;color:var(--text-secondary);font-size:12px">${pct(c.ctr)}</td>
        <td style="padding:11px 13px;text-align:right;color:var(--text-secondary);font-size:12px">${(c.frequency||0).toFixed(1)}</td>
        <td style="padding:11px 13px;text-align:right;color:${msgColor};font-size:12px;font-weight:600">${num(c.messages)}</td>
        ${convCell}
        <td style="padding:11px 13px;text-align:right;color:var(--text-secondary);font-size:12px">${brl(c.spend)}</td>
      </tr>`;
    }).join('');

    return `
    <div style="margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:7px;padding:7px 13px;background:var(--bg-secondary);border-radius:6px 6px 0 0;border:1px solid var(--border);border-bottom:none;color:var(--text-secondary)">
        ${icon}<span style="font-size:10.5px;font-weight:600;letter-spacing:.03em">${objLabel}</span>
      </div>
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:0 0 8px 8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-family:'DM Sans',sans-serif">
          <thead><tr style="background:var(--bg-tertiary)">
            ${['Campanha','Alcance','CTR','Freq.','Msg','Conv.','Invest.'].map((h,i) =>
              `<th style="padding:9px 13px;font-size:9.5px;color:var(--text-muted);font-weight:600;letter-spacing:.07em;text-transform:uppercase;text-align:${i===0?'left':'right'}">${h}</th>`
            ).join('')}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');

  return `
  <section style="margin-bottom:32px">
    <h2 class="section-title">📋 Campanhas</h2>
    ${groupHtml}
  </section>`;
}

// ── Faixa etária com insight ──────────────────────────────────────────────────
function buildAgeChartsHtml(ageBreakdown) {
  if (!ageBreakdown || !ageBreakdown.length) {
    return `<div style="color:var(--text-muted);font-size:13px;font-style:italic;padding:20px 0">Dados por faixa etária não disponíveis para este período.</div>`;
  }
  const topImpr = [...ageBreakdown].sort((a,b) => b.impressions - a.impressions)[0];
  const topConv = [...ageBreakdown].sort((a,b) => {
    const rA = a.impressions > 0 ? (a.linkClicks||a.clicks||0)/a.impressions : 0;
    const rB = b.impressions > 0 ? (b.linkClicks||b.clicks||0)/b.impressions : 0;
    return rB - rA;
  })[0];
  const insight = topImpr
    ? `A faixa <strong>${topImpr.age}</strong> concentra o maior volume de impressões (${num(topImpr.impressions)}).${topConv && topConv.age !== topImpr.age ? ` A <strong>${topConv.age}</strong> tem a maior proporção clique/impressão — potencial para segmentação específica.` : ''}`
    : 'Dados insuficientes para gerar insight automático.';

  const ages     = JSON.stringify(ageBreakdown.map(r => r.age));
  const imprData = JSON.stringify(ageBreakdown.map(r => r.impressions));
  const reachD   = JSON.stringify(ageBreakdown.map(r => r.reach));
  const clickD   = JSON.stringify(ageBreakdown.map(r => r.linkClicks||r.clicks));

  return `
  <div style="margin-bottom:14px;padding:13px 16px;background:var(--bg-info);border:1px solid rgba(24,95,165,0.25);border-radius:8px;font-size:12px;color:var(--text-info);line-height:1.65">
    <span style="display:block;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;opacity:.7;margin-bottom:3px">💡 Insight automático</span>
    ${insight}
  </div>
  <div style="display:grid;grid-template-columns:1fr;gap:12px">
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:18px">
      <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px">Impressões e Alcance por Faixa Etária</div>
      <canvas id="chart-age-impr-reach" height="90"></canvas>
    </div>
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:18px">
      <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px">Cliques no Link por Faixa Etária</div>
      <canvas id="chart-age-clicks" height="80"></canvas>
    </div>
  </div>
  <script>
  (function(){
    Chart.defaults.font.family = "'DM Sans', system-ui, sans-serif";
    Chart.defaults.font.size = 11;
    const dk = !document.body.classList.contains('light-mode');
    const gc = dk ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
    const tc = dk ? '#537085' : '#7A9488';
    new Chart(document.getElementById('chart-age-impr-reach'), {
      type: 'bar',
      data: { labels: ${ages}, datasets: [
        { label:'Impressões', data:${imprData}, backgroundColor:'#185FA560', borderColor:'#185FA5', borderWidth:1.5, borderRadius:3 },
        { label:'Alcance',    data:${reachD},   backgroundColor:'#27A06550', borderColor:'#27A065', borderWidth:1.5, borderRadius:3 }
      ]},
      options: { responsive:true, plugins:{legend:{labels:{color:tc,boxWidth:12,padding:14}}}, scales:{x:{grid:{display:false},ticks:{color:tc}},y:{grid:{color:gc},ticks:{color:tc}}} }
    });
    new Chart(document.getElementById('chart-age-clicks'), {
      type: 'bar',
      data: { labels:${ages}, datasets:[{data:${clickD},backgroundColor:'#378ADD50',borderColor:'#378ADD',borderWidth:1.5,borderRadius:3}]},
      options: { responsive:true, plugins:{legend:{display:false}}, scales:{x:{grid:{display:false},ticks:{color:tc}},y:{grid:{color:gc},ticks:{color:tc}}} }
    });
  })();
  <\/script>`;
}

// ── Lista de todas as métricas disponíveis ────────────────────────────────────
// Usada pelo gerador e pela UI de configuração
const AVAILABLE_METRICS = [
  { key: 'spend',           label: 'Valor Investido',                    alwaysShow: true  },
  { key: 'reach',           label: 'Alcance Total',                      alwaysShow: true  },
  { key: 'avgDailySpend',   label: 'Valor Investido Médio Diário',       alwaysShow: false },
  { key: 'followers',       label: 'Novos Seguidores',                   alwaysShow: false },
  { key: 'costPerFollower', label: 'Custo por Seguidor',                 alwaysShow: false },
  { key: 'messages',        label: 'Conversas Iniciadas por Mensagem',   alwaysShow: true  },
  { key: 'costPerMessage',  label: 'Custo por Conversas Iniciadas',      alwaysShow: true  },
  { key: 'impressions',     label: 'Impressões Totais',                  alwaysShow: false },
  { key: 'frequency',       label: 'Frequência',                         alwaysShow: false },
];

// ── Relatório principal ───────────────────────────────────────────────────────
function generate(opts) {
  // enabledMetrics: array de keys (ex: ['spend','reach','messages']). Se null → auto-detect.
  const { accountName, since, until, reportType, current, previous, agencyName, agencyLogo, ageBreakdown = [], enabledMetrics = null, instagramFollowers = null } = opts;

  // Período
  const periodLabel = reportType === 'mensal' ? `Mês de ${monthYear(since)}` : `Semana de ${dateBR(since)} a ${dateBR(until)}`;
  const prevLabel   = previous ? (reportType === 'mensal' ? `Mês de ${monthYear(previous.period?.since || '')}` : `Semana anterior`) : null;
  const _mo = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  const periodBoxDate = (() => {
    if (reportType === 'mensal') { const [y,m] = since.split('-'); return `${_mo[parseInt(m)-1]} ${y}`; }
    const [,sm,sd] = since.split('-'), [uy,um,ud] = until.split('-');
    const mA = _mo[parseInt(um)-1];
    return sm === um ? `${parseInt(sd)} — ${parseInt(ud)} ${mA} ${uy}` : `${parseInt(sd)} ${_mo[parseInt(sm)-1]} — ${parseInt(ud)} ${mA} ${uy}`;
  })();

  // Score
  const score    = calculateScore(current, previous);
  const scoreLbl = scoreLabel(score);
  const scoreClr = scoreColor(score);
  const ctx      = buildContextParagraph(current, previous);
  const { issues, opportunities } = analyze(current, previous);

  // Subseções
  const chartsHtml    = buildChartsHtml(current);
  const campsHtml     = buildCampaignSectionsHtml(current.campaigns);
  const ageHtml       = buildAgeChartsHtml(ageBreakdown);
  const logoHtml      = agencyLogo ? `<img src="${agencyLogo}" alt="${agencyName}" style="height:28px;object-fit:contain;margin-bottom:6px;display:block">` : '';

  // ── Cálculos derivados ───────────────────────────────────────────────────────
  // Dias no período do relatório
  const _reportDays = Math.max(1, Math.ceil((new Date(until) - new Date(since)) / (1000*60*60*24)) + 1);
  const avgDailySpend = current.spend / _reportDays;
  const prevAvgDailySpend = previous ? previous.spend / _reportDays : null;

  // Seguidores: tenta nível de conta, senão soma campanhas
  const totalFollowers = (current.followers || 0) > 0
    ? current.followers
    : (current.campaigns || []).reduce((s, c) => s + (c.followers || 0), 0);
  const prevFollowers = previous
    ? ((previous.followers || 0) > 0 ? previous.followers : (previous.campaigns || []).reduce((s,c) => s+(c.followers||0),0))
    : null;
  const costPerFollowerVal = totalFollowers > 0 ? current.spend / totalFollowers : 0;
  const prevCostPerFollower = (prevFollowers && previous) ? previous.spend / prevFollowers : null;

  // Métricas completas com key para filtragem
  const allMetricDefs = [
    { key:'spend',           label:'Valor Investido',                  val:brl(current.spend),
      d:null, neutral:true, mono:true },
    { key:'reach',           label:'Alcance Total',                    val:num(current.reach),
      d:previous?delta(current.reach,previous.reach):null, higher:true },
    { key:'avgDailySpend',   label:'Valor Investido Médio Diário',     val:brl(avgDailySpend),
      d:prevAvgDailySpend?delta(avgDailySpend,prevAvgDailySpend):null, higher:false, mono:true, sub:`${_reportDays} dias` },
    { key:'followers',       label:'Novos Seguidores',                 val:totalFollowers > 0 ? num(totalFollowers) : null,
      d:(prevFollowers&&totalFollowers>0)?delta(totalFollowers,prevFollowers):null, higher:true },
    { key:'costPerFollower', label:'Custo por Seguidor',               val:costPerFollowerVal > 0 ? brl(costPerFollowerVal) : null,
      d:(prevCostPerFollower&&costPerFollowerVal>0)?delta(costPerFollowerVal,prevCostPerFollower):null, higher:false, mono:true },
    { key:'messages',        label:'Conversas Iniciadas por Mensagem', val:num(current.messages),
      d:previous?delta(current.messages,previous.messages):null, higher:true },
    { key:'costPerMessage',  label:'Custo por Conversas Iniciadas',    val:current.costPerMessage > 0 ? brl(current.costPerMessage) : null,
      d:previous?.costPerMessage?delta(current.costPerMessage,previous.costPerMessage):null, higher:false, mono:true },
    { key:'impressions',     label:'Impressões Totais',                val:num(current.impressions),
      d:previous?delta(current.impressions,previous.impressions):null, higher:true },
    { key:'frequency',       label:'Frequência',                       val:(current.frequency||0).toFixed(1),
      d:previous?delta(current.frequency,previous.frequency):null, higher:false },
  ];

  // Filtragem de métricas:
  // 1. Se enabledMetrics fornecido → usa exatamente essa lista
  // 2. Se null → auto-detect: exibe apenas métricas com dados reais (val != null)
  const metricDefs = allMetricDefs.filter(m => {
    if (enabledMetrics !== null) return enabledMetrics.includes(m.key);
    return m.val !== null; // auto-detect: oculta métricas sem dado
  });

  const metricCards = metricDefs.map(m => {
    let badge = '';
    if (m.d !== null && m.d !== undefined && !m.neutral) {
      const neutral   = Math.abs(m.d) < 2;
      const positive  = neutral ? null : (m.higher ? m.d >= 0 : m.d <= 0);
      const [bg, clr] = neutral ? ['var(--bg-secondary)','var(--text-muted)']
        : positive ? ['var(--bg-success)','var(--text-success)'] : ['var(--bg-danger)','var(--text-danger)'];
      badge = `<span style="display:inline-block;margin-top:7px;padding:2px 8px;border-radius:4px;background:${bg};color:${clr};font-size:10px;font-weight:700">${m.d>=0?'+':''}${m.d.toFixed(0)}% vs. ant.</span>`;
    }
    return `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:18px 20px">
      <div style="font-size:9.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px">${m.label}</div>
      <div style="font-size:${m.mono?'21px':'23px'};font-weight:700;color:var(--text-primary);line-height:1;${m.mono?"font-variant-numeric:tabular-nums":''}">${m.val ?? '—'}</div>
      ${m.sub ? `<div style="font-size:9px;color:var(--text-muted);margin-top:4px">${m.sub}</div>` : ''}
      ${badge}
    </div>`;
  }).join('');

  // Score block
  const scoreHtml = `
  <section style="margin-bottom:24px">
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:22px 26px">
      <div style="display:flex;align-items:flex-start;gap:22px">
        <div style="flex-shrink:0;text-align:center;min-width:66px">
          <div style="font-size:40px;font-weight:700;color:${scoreClr};line-height:1;font-family:'DM Sans',sans-serif">${score}</div>
          <div style="font-size:9.5px;font-weight:700;color:${scoreClr};letter-spacing:.08em;text-transform:uppercase;margin-top:4px">${scoreLbl}</div>
        </div>
        <div style="width:1px;background:var(--border);align-self:stretch;flex-shrink:0"></div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:7px">Desempenho geral — ${scoreLbl}</div>
          <div style="font-size:12px;color:var(--text-secondary);line-height:1.65;margin-bottom:13px">${ctx}</div>
          <div style="height:5px;background:var(--bg-secondary);border-radius:99px;overflow:hidden">
            <div style="height:100%;width:${score}%;background:linear-gradient(90deg,#E24B4A 0%,${scoreClr} 100%);border-radius:99px"></div>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:4px">
            <span style="font-size:9px;color:var(--text-muted)">0 — Crítico</span>
            <span style="font-size:9px;color:var(--text-muted)">100 — Excelente</span>
          </div>
        </div>
      </div>
    </div>
  </section>`;

  // Alertas
  const allAlerts = [...issues.map(i=>({...i,kind:'issue'})),...opportunities.map(o=>({...o,kind:'opp'}))];
  const alertsHtml = allAlerts.length === 0 ? '' : `
  <section style="margin-bottom:24px">
    <h2 class="section-title">⚡ Alertas e Oportunidades</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      ${allAlerts.map(a => {
        const isOpp = a.kind === 'opp';
        const accent = isOpp ? '#27A065' : '#E8A020';
        const bg     = isOpp ? 'var(--bg-success)' : 'var(--bg-warning)';
        return `
        <div style="background:${bg};border:1px solid ${accent}28;border-left:3px solid ${accent};border-radius:0 8px 8px 0;padding:13px 15px">
          <span style="display:inline-block;padding:1px 8px;border-radius:99px;background:${accent}20;color:${accent};font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:7px">${isOpp?'Oportunidade':'Atenção'}</span>
          <div style="font-size:12.5px;font-weight:600;color:var(--text-primary);margin-bottom:5px">${a.metric}</div>
          <div style="font-size:11.5px;color:var(--text-secondary);line-height:1.55;margin-bottom:${a.action?'7px':'0'}">${a.message}</div>
          ${a.action ? `<div style="font-size:11px;color:${accent};font-weight:600">→ ${a.action}</div>` : ''}
        </div>`;
      }).join('')}
    </div>
  </section>`;

  // Bloco de seguidores do Instagram — só quando houve campanha de seguidores
  // no período (totalFollowers > 0) e o IG foi resolvido pelo chamador.
  const igFollowersHtml = (instagramFollowers && instagramFollowers.followers != null && totalFollowers > 0)
    ? `
  <section style="margin-bottom:28px">
    <div style="display:flex;align-items:center;gap:16px;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:20px 24px">
      <div style="width:48px;height:48px;border-radius:13px;background:linear-gradient(135deg,#feda75,#d62976 45%,#962fbf 75%,#4f5bd5);display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect width="20" height="20" x="2" y="2" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="#fff" stroke="none"/></svg>
      </div>
      <div style="flex:1">
        <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.1em">Seguidores no Instagram${instagramFollowers.username ? ' · @' + instagramFollowers.username : ''}</div>
        <div style="font-size:30px;font-weight:700;color:var(--text-primary);line-height:1.1">${num(instagramFollowers.followers)}</div>
        <div style="font-size:12px;color:#27A065;font-weight:600;margin-top:3px">+${num(totalFollowers)} novos seguidores no período via campanha</div>
      </div>
    </div>
  </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relatório ${reportType === 'mensal' ? 'Mensal' : 'Semanal'} — ${accountName}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;700&family=DM+Serif+Display&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
  :root {
    --gold:#C9A84C; --gold-l:#E8C96A;
    --gold-bg:rgba(201,168,76,0.12); --gold-br:rgba(201,168,76,0.28);
    --bg-page:#0D1B2A; --bg-card:#132132; --bg-secondary:#1C2E40; --bg-tertiary:#0F1D2C;
    --bg-success:rgba(39,160,101,0.12); --bg-danger:rgba(226,75,74,0.12);
    --bg-warning:rgba(232,160,32,0.12); --bg-info:rgba(24,95,165,0.12);
    --text-primary:#E9E8E6; --text-secondary:#8EA8BE; --text-muted:#537085;
    --text-success:#27A065; --text-danger:#E24B4A; --text-warning:#E8A020; --text-info:#378ADD;
    --border:rgba(255,255,255,0.08); --border-subtle:rgba(255,255,255,0.04);
  }
  body.light-mode {
    --bg-page:#F1F5F9; --bg-card:#FFFFFF; --bg-secondary:#EDF1F7; --bg-tertiary:#F8FAFC;
    --bg-success:rgba(39,160,101,0.08); --bg-danger:rgba(226,75,74,0.08);
    --bg-warning:rgba(232,160,32,0.08); --bg-info:rgba(24,95,165,0.08);
    --text-primary:#1A2332; --text-secondary:#4A6070; --text-muted:#7A9488;
    --border:rgba(0,0,0,0.09); --border-subtle:rgba(0,0,0,0.04);
  }
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'DM Sans','Segoe UI',system-ui,sans-serif;background:var(--bg-page);color:var(--text-primary);min-height:100vh;transition:background .25s,color .25s}
  h1,.serif{font-family:'DM Serif Display',Georgia,serif}
  .section-title{font-size:10px;font-weight:700;color:var(--gold);text-transform:uppercase;letter-spacing:.14em;margin:0 0 14px;padding-bottom:10px;border-bottom:1px solid var(--border)}
  /* Header */
  .rpt-hdr{background:linear-gradient(135deg,#0D2235 0%,#103828 55%,#1A4A2E 100%);position:relative}
  .hdr-accent{height:3px;background:linear-gradient(90deg,#C9A84C 0%,#E8C96A 50%,#C9A84C 100%)}
  .hdr-inner{max-width:940px;margin:0 auto;padding:26px 40px 20px;display:grid;grid-template-columns:auto 1px 1fr auto;align-items:center;gap:0 24px}
  .hdr-brand{display:flex;align-items:center;gap:11px;min-width:150px}
  .brand-nm{display:block;font-family:'DM Sans',sans-serif;font-size:17px;font-weight:700;color:#fff;letter-spacing:-.2px}
  .brand-sb{display:block;font-size:8px;color:rgba(201,168,76,.65);letter-spacing:.14em;text-transform:uppercase;margin-top:2px}
  .hdr-div{width:1px;height:58px;background:rgba(255,255,255,.12);align-self:center}
  .report-badge{display:inline-flex;flex-direction:column;border:1px solid var(--gold-br);background:var(--gold-bg);border-radius:4px;padding:3px 9px;margin-bottom:9px}
  .report-badge span{font-size:8px;font-weight:700;color:var(--gold);letter-spacing:.16em;text-transform:uppercase;line-height:1.4}
  .rpt-title{font-family:'DM Serif Display',Georgia,serif;font-size:22px;font-weight:400;color:#fff;margin:0 0 9px;line-height:1.2}
  .rpt-period-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .rpt-period-txt{font-size:11px;color:rgba(201,168,76,.7)}
  .vs-badge{font-size:8px;font-weight:700;color:var(--gold);letter-spacing:.1em;text-transform:uppercase;background:var(--gold-bg);border:1px solid var(--gold-br);border-radius:3px;padding:2px 7px}
  .hdr-period-box{border:1px solid var(--gold-br);border-radius:8px;padding:13px 17px;min-width:158px;text-align:right;background:rgba(0,0,0,.18)}
  .pb-label{display:block;font-size:8px;font-weight:700;color:rgba(201,168,76,.5);letter-spacing:.16em;text-transform:uppercase;margin-bottom:5px}
  .pb-date{display:block;font-size:17px;font-weight:700;color:#fff;line-height:1.2}
  .pb-cmp{display:block;font-size:9px;color:rgba(201,168,76,.5);margin-top:5px;line-height:1.4}
  .hdr-bc{background:rgba(0,0,0,.22);border-top:1px solid rgba(255,255,255,.05)}
  .hdr-bc-in{max-width:940px;margin:0 auto;padding:8px 40px;display:flex;align-items:center;justify-content:space-between}
  .bc-path{font-size:10px;color:rgba(201,168,76,.4);display:flex;align-items:center;gap:4px}
  .bc-sep{color:rgba(255,255,255,.12)}
  .bc-last{color:rgba(201,168,76,.6)}
  .pub-badge{font-size:9.5px;color:#27A065;font-weight:700;letter-spacing:.08em;display:flex;align-items:center;gap:5px}
  .pub-dot{width:6px;height:6px;border-radius:50%;background:#27A065;display:inline-block}
  /* Buttons */
  .report-pdf-btn{position:fixed;bottom:24px;right:180px;z-index:999;display:flex;align-items:center;gap:7px;padding:10px 18px;border-radius:999px;border:1px solid var(--gold);background:var(--gold);color:#1C2B1E;font-family:'DM Sans',sans-serif;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 4px 20px rgba(201,168,76,.35);transition:all .2s}
  .report-pdf-btn:hover{background:#b8943e;border-color:#b8943e}
  .report-theme-btn{position:fixed;bottom:24px;right:24px;z-index:999;display:flex;align-items:center;gap:7px;padding:10px 16px;border-radius:999px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-muted);font-family:'DM Sans',sans-serif;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.4);transition:all .2s}
  .report-theme-btn:hover{border-color:var(--gold);color:var(--gold)}
  @media print{
    .report-pdf-btn,.report-theme-btn{display:none!important}
    *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
    @page{size:A4;margin:12mm 14mm}
    section{page-break-inside:avoid}
  }
  @media(max-width:680px){
    .hdr-inner{grid-template-columns:1fr;gap:14px}
    .hdr-div{display:none}
    .hdr-period-box{text-align:left}
    .report-pdf-btn{bottom:72px;right:16px}
    .report-theme-btn{bottom:16px;right:16px}
  }
</style>
<script>(function(){const t=localStorage.getItem('mf-report-theme')||'dark';if(t==='light')document.body.classList.add('light-mode');})();<\/script>
</head>
<body>

<!-- 1. CABEÇALHO -->
<div class="rpt-hdr">
  <img src="/Logo/Screenshot_3-removebg-preview.png" alt="" aria-hidden="true" style="position:absolute;right:-10px;top:50%;transform:translateY(-50%) rotate(10deg);height:160px;width:auto;object-fit:contain;filter:brightness(0) invert(1);opacity:0.04;pointer-events:none;z-index:0">
  <div class="hdr-accent"></div>
  <div class="hdr-inner">
    <div class="hdr-brand">
      ${logoHtml}
      <img src="/Logo/Screenshot_3-removebg-preview.png" alt="Multiform Crystal" style="height:44px;width:auto;object-fit:contain;filter:brightness(0) invert(1);opacity:0.92;flex-shrink:0">
      <div>
        <span class="brand-nm">${agencyName||'Multiform'}</span>
        <span class="brand-sb">Meta Ads Reporter</span>
      </div>
    </div>
    <div class="hdr-div"></div>
    <div>
      <div class="report-badge"><span>Relatório</span><span>${reportType==='mensal'?'Mensal':'Semanal'}</span></div>
      <h1 class="rpt-title">${accountName}</h1>
      <div class="rpt-period-line">
        <span class="rpt-period-txt">${periodLabel}</span>
        ${prevLabel ? `<span class="vs-badge">VS. ${prevLabel}</span>` : ''}
      </div>
    </div>
    <div class="hdr-period-box">
      <span class="pb-label">Período</span>
      <span class="pb-date">${periodBoxDate}</span>
      ${prevLabel ? `<span class="pb-cmp">↕ comparando com<br>${reportType==='mensal'?'mês':'semana'} anterior</span>` : ''}
    </div>
  </div>
  <div class="hdr-bc">
    <div class="hdr-bc-in">
      <div class="bc-path">
        <span>${agencyName||'Multiform'}</span><span class="bc-sep">›</span>
        <span>Relatórios</span><span class="bc-sep">›</span>
        <span class="bc-last">${accountName}</span>
      </div>
      <div class="pub-badge"><span class="pub-dot"></span>PUBLICADO</div>
    </div>
  </div>
</div>

<div style="max-width:940px;margin:0 auto;padding:28px 24px">

  <!-- 2. SCORE -->
  ${scoreHtml}

  <!-- 4. MÉTRICAS -->
  <section style="margin-bottom:28px">
    <h2 class="section-title">📊 Métricas do Período</h2>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:11px">
      ${metricCards}
    </div>
  </section>
  <!-- Nota: grid repeat(3,1fr) com 9 cards = 3 linhas × 3 colunas -->

  <!-- 4b. SEGUIDORES INSTAGRAM (condicional) -->
  ${igFollowersHtml}

  <!-- 5. VISUAL -->
  ${chartsHtml}

  <!-- 6. CAMPANHAS -->
  ${campsHtml}

  <!-- 7. FAIXA ETÁRIA -->
  <section style="margin-bottom:28px">
    <h2 class="section-title">👥 Dashboard por Faixa Etária</h2>
    ${ageHtml}
  </section>

  <!-- 8. RODAPÉ -->
  <div style="text-align:center;font-size:10px;color:var(--text-muted);padding-top:18px;border-top:1px solid var(--border)">
    Gerado em ${new Date().toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'})}
    &nbsp;·&nbsp; ${agencyName||'Multiform'} — Meta Ads Reporter
  </div>

</div>

<button class="report-pdf-btn" onclick="downloadPDF()">
  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
  Baixar PDF
</button>
<button class="report-theme-btn" id="report-theme-btn" onclick="toggleReportTheme()">
  <span id="report-theme-icon">🌙</span>
  <span id="report-theme-label">Modo claro</span>
</button>

<script>
function downloadPDF(){
  const w=document.body.classList.contains('light-mode');
  if(!w)applyReportTheme('light');
  setTimeout(()=>{window.print();if(!w)setTimeout(()=>applyReportTheme('dark'),500);},120);
}
function applyReportTheme(mode){
  const l=mode==='light';
  document.body.classList.toggle('light-mode',l);
  const i=document.getElementById('report-theme-icon'),lb=document.getElementById('report-theme-label');
  if(i)i.textContent=l?'☀️':'🌙';
  if(lb)lb.textContent=l?'Modo escuro':'Modo claro';
  localStorage.setItem('mf-report-theme',mode);
}
function toggleReportTheme(){applyReportTheme((localStorage.getItem('mf-report-theme')||'dark')==='dark'?'light':'dark');}
(function(){applyReportTheme(localStorage.getItem('mf-report-theme')||'dark');})();
<\/script>
</body>
</html>`;
}

// ── Relatório de Orçamento (pacing mensal — visão da agência) ─────────────────
// Mostra, por conta, o orçamento mensal vs gasto até agora e a projeção de
// fechamento do mês, classificando cada conta em: no previsto / acima / abaixo.
function generateBudgetReport(opts) {
  const {
    accounts = [],        // contas COM orçamento: {name, monthlyBudget, spentSoFar, projectedTotal, paceRatio, pctUsed}
    noBudget = [],        // contas SEM orçamento configurado: {name, spentSoFar}
    monthLabel = '',      // ex: "junho de 2026"
    dayOfMonth = 0, lastDay = 0, daysRemaining = 0,
    agencyName = '', agencyLogo = '',
    generatedAtStr = ''
  } = opts;

  // Classificação de status (banda de ±10% em torno do orçamento projetado)
  function statusOf(pace) {
    if (pace == null)   return { label: 'Sem dados',         color: '#537085', bg: 'var(--bg-secondary)' };
    if (pace > 1.10)    return { label: 'Acima do planejado', color: '#E24B4A', bg: 'var(--bg-danger)'  };
    if (pace < 0.90)    return { label: 'Abaixo do planejado',color: '#378ADD', bg: 'var(--bg-info)'    };
    return                     { label: 'No previsto',        color: '#27A065', bg: 'var(--bg-success)' };
  }

  // Totais consolidados da agência
  const totalBudget    = accounts.reduce((s, a) => s + (a.monthlyBudget || 0), 0);
  const totalSpent     = accounts.reduce((s, a) => s + (a.spentSoFar || 0), 0);
  const totalProjected = accounts.reduce((s, a) => s + (a.projectedTotal || 0), 0);
  const overallPace    = totalBudget > 0 ? totalProjected / totalBudget : null;
  const overallPctUsed = totalBudget > 0 ? (totalSpent / totalBudget * 100) : 0;
  const overall        = statusOf(overallPace);
  const diffProjected  = totalProjected - totalBudget; // + = estouro, - = sobra

  // Ordena: piores (maior pace) primeiro, pra chamar atenção do dono
  const ordered = [...accounts].sort((a, b) => (b.paceRatio || 0) - (a.paceRatio || 0));

  const logoHtml = agencyLogo
    ? `<img src="${agencyLogo}" alt="${agencyName}" style="height:28px;object-fit:contain;margin-bottom:6px;display:block">` : '';

  // Linhas da tabela por conta
  const rows = ordered.map(a => {
    const st       = statusOf(a.paceRatio);
    const pacePct  = a.paceRatio != null ? Math.round(a.paceRatio * 100) : null;
    const barPct   = Math.min(100, Math.round((a.pctUsed || 0)));
    const barColor = st.color;
    return `
    <tr>
      <td style="padding:13px 14px;border-bottom:1px solid var(--border)">
        <div style="font-size:13px;font-weight:600;color:var(--text-primary)">${a.name}</div>
        <div style="margin-top:7px;height:5px;background:var(--bg-secondary);border-radius:3px;overflow:hidden;max-width:170px">
          <div style="height:100%;width:${barPct}%;background:${barColor};border-radius:3px"></div>
        </div>
        <div style="font-size:9.5px;color:var(--text-muted);margin-top:3px">${(a.pctUsed||0).toFixed(0)}% do orçamento gasto</div>
      </td>
      <td style="padding:13px 14px;border-bottom:1px solid var(--border);text-align:right;font-variant-numeric:tabular-nums;color:var(--text-secondary)">${brl(a.monthlyBudget)}</td>
      <td style="padding:13px 14px;border-bottom:1px solid var(--border);text-align:right;font-variant-numeric:tabular-nums;color:var(--text-primary);font-weight:600">${brl(a.spentSoFar)}</td>
      <td style="padding:13px 14px;border-bottom:1px solid var(--border);text-align:right;font-variant-numeric:tabular-nums;color:var(--text-primary)">${brl(a.projectedTotal)}<div style="font-size:9.5px;color:${st.color};font-weight:700;margin-top:2px">${pacePct != null ? pacePct + '% do orç.' : ''}</div></td>
      <td style="padding:13px 14px;border-bottom:1px solid var(--border);text-align:center">
        <span style="display:inline-block;padding:3px 10px;border-radius:99px;background:${st.bg};color:${st.color};font-size:10px;font-weight:700;white-space:nowrap">${st.label}</span>
      </td>
    </tr>`;
  }).join('');

  const noBudgetHtml = noBudget.length ? `
  <section style="max-width:940px;margin:0 auto;padding:0 40px 30px">
    <div style="background:var(--bg-warning);border:1px solid #E8A02028;border-left:3px solid #E8A020;border-radius:0 8px 8px 0;padding:13px 16px">
      <div style="font-size:11px;font-weight:700;color:#E8A020;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">⚠ ${noBudget.length} conta${noBudget.length>1?'s':''} sem orçamento definido</div>
      <div style="font-size:11.5px;color:var(--text-secondary);line-height:1.6">
        Estas contas não entram no cálculo acima porque não têm orçamento mensal configurado:
        <strong style="color:var(--text-primary)">${noBudget.map(n => n.name).join(', ')}</strong>.
        Configure o orçamento delas em Configurações → Contas para incluí-las no monitoramento.
      </div>
    </div>
  </section>` : '';

  // Cards-resumo da agência
  const kpiCard = (label, value, sub, accent) => `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:18px 20px">
      <div style="font-size:9.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px">${label}</div>
      <div style="font-size:22px;font-weight:700;color:${accent||'var(--text-primary)'};line-height:1;font-variant-numeric:tabular-nums">${value}</div>
      ${sub ? `<div style="font-size:10px;color:var(--text-muted);margin-top:6px">${sub}</div>` : ''}
    </div>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relatório de Orçamento — ${agencyName || 'Agência'}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;700&family=DM+Serif+Display&display=swap" rel="stylesheet">
<style>
  :root {
    --gold:#C9A84C; --gold-l:#E8C96A; --gold-bg:rgba(201,168,76,0.12); --gold-br:rgba(201,168,76,0.28);
    --bg-page:#0D1B2A; --bg-card:#132132; --bg-secondary:#1C2E40; --bg-tertiary:#0F1D2C;
    --bg-success:rgba(39,160,101,0.12); --bg-danger:rgba(226,75,74,0.12);
    --bg-warning:rgba(232,160,32,0.12); --bg-info:rgba(24,95,165,0.12);
    --text-primary:#E9E8E6; --text-secondary:#8EA8BE; --text-muted:#537085;
    --border:rgba(255,255,255,0.08);
  }
  body.light-mode {
    --bg-page:#F1F5F9; --bg-card:#FFFFFF; --bg-secondary:#EDF1F7; --bg-tertiary:#F8FAFC;
    --bg-success:rgba(39,160,101,0.08); --bg-danger:rgba(226,75,74,0.08);
    --bg-warning:rgba(232,160,32,0.08); --bg-info:rgba(24,95,165,0.08);
    --text-primary:#1A2332; --text-secondary:#4A6070; --text-muted:#7A9488;
    --border:rgba(0,0,0,0.09);
  }
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'DM Sans','Segoe UI',system-ui,sans-serif;background:var(--bg-page);color:var(--text-primary);min-height:100vh;transition:background .25s,color .25s}
  .rpt-hdr{background:linear-gradient(135deg,#0D2235 0%,#103828 55%,#1A4A2E 100%);position:relative}
  .hdr-accent{height:3px;background:linear-gradient(90deg,#C9A84C 0%,#E8C96A 50%,#C9A84C 100%)}
  .hdr-inner{max-width:940px;margin:0 auto;padding:26px 40px 22px;display:grid;grid-template-columns:auto 1px 1fr auto;align-items:center;gap:0 24px}
  .hdr-brand{display:flex;align-items:center;gap:11px;min-width:150px}
  .brand-nm{display:block;font-size:17px;font-weight:700;color:#fff;letter-spacing:-.2px}
  .brand-sb{display:block;font-size:8px;color:rgba(201,168,76,.65);letter-spacing:.14em;text-transform:uppercase;margin-top:2px}
  .hdr-div{width:1px;height:58px;background:rgba(255,255,255,.12);align-self:center}
  .report-badge{display:inline-flex;flex-direction:column;border:1px solid var(--gold-br);background:var(--gold-bg);border-radius:4px;padding:3px 9px;margin-bottom:9px}
  .report-badge span{font-size:8px;font-weight:700;color:var(--gold);letter-spacing:.16em;text-transform:uppercase;line-height:1.4}
  .rpt-title{font-family:'DM Serif Display',Georgia,serif;font-size:22px;color:#fff;margin:0 0 9px;line-height:1.2}
  .rpt-period-txt{font-size:11px;color:rgba(201,168,76,.7)}
  .hdr-period-box{border:1px solid var(--gold-br);border-radius:8px;padding:13px 17px;min-width:158px;text-align:right;background:rgba(0,0,0,.18)}
  .pb-label{display:block;font-size:8px;font-weight:700;color:rgba(201,168,76,.5);letter-spacing:.16em;text-transform:uppercase;margin-bottom:5px}
  .pb-date{display:block;font-size:17px;font-weight:700;color:#fff;line-height:1.2}
  .pb-cmp{display:block;font-size:9px;color:rgba(201,168,76,.5);margin-top:5px;line-height:1.4}
  main{max-width:940px;margin:0 auto;padding:28px 40px}
  .section-title{font-size:10px;font-weight:700;color:var(--gold);text-transform:uppercase;letter-spacing:.14em;margin:0 0 14px;padding-bottom:10px;border-bottom:1px solid var(--border)}
  table{width:100%;border-collapse:collapse;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
  thead th{font-size:9.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;padding:12px 14px;background:var(--bg-tertiary);border-bottom:1px solid var(--border)}
  .report-theme-btn{position:fixed;bottom:24px;right:24px;z-index:999;display:flex;align-items:center;gap:7px;padding:10px 16px;border-radius:999px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-muted);font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.4)}
  .report-pdf-btn{position:fixed;bottom:24px;right:170px;z-index:999;display:flex;align-items:center;gap:7px;padding:10px 18px;border-radius:999px;border:1px solid var(--gold);background:var(--gold);color:#1C2B1E;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 4px 20px rgba(201,168,76,.35)}
  @media print{.report-pdf-btn,.report-theme-btn{display:none!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}@page{size:A4;margin:12mm 14mm}section,table{page-break-inside:avoid}}
  @media(max-width:680px){.hdr-inner{grid-template-columns:1fr;gap:14px}.hdr-div{display:none}.hdr-period-box{text-align:left}main{padding:20px}thead th:nth-child(2),td:nth-child(2){display:none}}
</style>
<script>(function(){var t=localStorage.getItem('mf-report-theme')||'dark';if(t==='light')document.body.classList.add('light-mode');})();<\/script>
</head>
<body>

<div class="rpt-hdr">
  <div class="hdr-accent"></div>
  <div class="hdr-inner">
    <div class="hdr-brand">
      ${logoHtml}
      <div>
        <span class="brand-nm">${agencyName || 'Multiform'}</span>
        <span class="brand-sb">Relatório de Orçamento</span>
      </div>
    </div>
    <div class="hdr-div"></div>
    <div>
      <div class="report-badge"><span>Controle de</span><span>Orçamento</span></div>
      <h1 class="rpt-title">Acompanhamento de Gastos</h1>
      <div class="rpt-period-txt">Mês de ${monthLabel} · dia ${dayOfMonth} de ${lastDay} · faltam ${daysRemaining} dia${daysRemaining!==1?'s':''}</div>
    </div>
    <div class="hdr-period-box">
      <span class="pb-label">Status geral</span>
      <span class="pb-date" style="color:${overall.color}">${overall.label}</span>
      <span class="pb-cmp">${overallPace != null ? Math.round(overallPace*100) + '% do orçamento projetado' : 'sem orçamento definido'}</span>
    </div>
  </div>
</div>

<main>
  <!-- Resumo consolidado da agência -->
  <section style="margin-bottom:28px">
    <div class="section-title">Resumo da Agência — ${monthLabel}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">
      ${kpiCard('Orçamento total', brl(totalBudget), `${accounts.length} conta${accounts.length!==1?'s':''} com orçamento`)}
      ${kpiCard('Gasto até agora', brl(totalSpent), `${overallPctUsed.toFixed(0)}% do orçamento`)}
      ${kpiCard('Projeção fim do mês', brl(totalProjected), overallPace != null ? `${Math.round(overallPace*100)}% do orçamento` : '—', overall.color)}
      ${kpiCard(diffProjected >= 0 ? 'Estouro projetado' : 'Sobra projetada', brl(Math.abs(diffProjected)), diffProjected >= 0 ? 'acima do planejado' : 'abaixo do planejado', diffProjected > 0 ? '#E24B4A' : '#27A065')}
    </div>
    <div style="margin-top:14px;background:${overall.bg};border:1px solid ${overall.color}28;border-left:3px solid ${overall.color};border-radius:0 8px 8px 0;padding:14px 16px">
      <div style="font-size:13px;font-weight:700;color:${overall.color};margin-bottom:4px">${overall.label}</div>
      <div style="font-size:12px;color:var(--text-secondary);line-height:1.6">
        ${overallPace == null
          ? 'Nenhuma conta tem orçamento mensal configurado. Configure os orçamentos para acompanhar o ritmo de gasto.'
          : diffProjected > 0
            ? `No ritmo atual, a projeção de fechamento é de <strong style="color:var(--text-primary)">${brl(totalProjected)}</strong>, ou seja <strong style="color:${overall.color}">${brl(diffProjected)} acima</strong> do orçamento total de ${brl(totalBudget)}.`
            : `No ritmo atual, a projeção de fechamento é de <strong style="color:var(--text-primary)">${brl(totalProjected)}</strong>, dentro do orçamento total de ${brl(totalBudget)} (sobra projetada de ${brl(Math.abs(diffProjected))}).`}
      </div>
    </div>
  </section>

  <!-- Detalhamento por conta -->
  <section style="margin-bottom:24px">
    <div class="section-title">Detalhamento por Conta</div>
    <table>
      <thead>
        <tr>
          <th style="text-align:left">Conta</th>
          <th style="text-align:right">Orçamento</th>
          <th style="text-align:right">Gasto até agora</th>
          <th style="text-align:right">Projeção fim do mês</th>
          <th style="text-align:center">Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="5" style="padding:24px;text-align:center;color:var(--text-muted);font-size:12px">Nenhuma conta com orçamento configurado.</td></tr>`}
      </tbody>
    </table>
  </section>
</main>

${noBudgetHtml}

<footer style="max-width:940px;margin:0 auto;padding:8px 40px 40px;color:var(--text-muted);font-size:10px;border-top:1px solid var(--border)">
  <div style="padding-top:14px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
    <span>Gerado em ${generatedAtStr}</span>
    <span>${agencyName || 'Multiform'} · Meta Ads Reporter</span>
  </div>
</footer>

<button class="report-pdf-btn" onclick="window.print()">📄 Salvar PDF</button>
<button class="report-theme-btn" onclick="(function(){var d=document.body.classList.toggle('light-mode');localStorage.setItem('mf-report-theme',d?'light':'dark');})()">🌓 Tema</button>

</body>
</html>`;
}

module.exports = { generate, buildChartsHtml, AVAILABLE_METRICS, generateBudgetReport };
