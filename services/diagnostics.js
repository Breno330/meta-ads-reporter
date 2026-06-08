/**
 * diagnostics.js — Diagnóstico IA rule-based para Meta Ads
 * Gera score, grade, highlights, alertas e rascunho para cliente.
 */

function generateDiagnosis(current, previous, config = {}) {
  const { cpaTarget, accountName, period } = config;

  const ctr            = current.ctr            || 0;
  const frequency      = current.frequency      || 0;
  const costPerMessage = current.costPerMessage  || 0;
  const cpm            = current.cpm             || 0;
  const messages       = current.messages        || 0;
  const clicks         = current.clicks          || 0;
  const clickToMsgRate = clicks > 0 && messages > 0 ? (messages / clicks) * 100 : 0;

  const prevMessages = previous?.messages || 0;
  const prevCpm      = previous?.cpm      || 0;

  // ── Score ──────────────────────────────────────────────────────────────────
  let score = 70;

  // CTR
  if      (ctr >= 2.5) score += 15;
  else if (ctr >= 1.5) score += 10;
  else if (ctr >= 1.0) score += 0;
  else if (ctr >= 0.5) score -= 10;
  else                 score -= 20;

  // Frequência
  if      (frequency <= 2) score += 10;
  else if (frequency <= 3) score += 0;
  else if (frequency <= 4) score -= 10;
  else if (frequency <= 6) score -= 20;
  else                     score -= 30;

  // costPerMessage vs cpaTarget
  if (cpaTarget && costPerMessage > 0) {
    const ratio = costPerMessage / cpaTarget;
    if      (ratio <= 0.8) score += 15;
    else if (ratio <= 1.0) score += 5;
    else if (ratio <= 1.3) score -= 5;
    else if (ratio <= 1.6) score -= 15;
    else                   score -= 25;
  }

  // Comparativo com período anterior
  if (previous) {
    if (prevMessages > 0) {
      const msgDelta = (messages - prevMessages) / prevMessages;
      if      (msgDelta >= 0.10)  score += 5;
      else if (msgDelta <= -0.10) score -= 5;
    }
    if (prevCpm > 0 && cpm > 0) {
      const cpmDelta = (cpm - prevCpm) / prevCpm;
      if (cpmDelta >= 0.20) score -= 5;
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // ── Grade ──────────────────────────────────────────────────────────────────
  let grade, gradeColor;
  if      (score >= 80) { grade = 'Excelente'; gradeColor = '#34d399'; }
  else if (score >= 65) { grade = 'Bom';       gradeColor = '#38bdf8'; }
  else if (score >= 45) { grade = 'Atenção';   gradeColor = '#fbbf24'; }
  else                  { grade = 'Crítico';   gradeColor = '#f87171'; }

  // ── Highlights ─────────────────────────────────────────────────────────────
  const highlights = [];

  if (ctr >= 2) {
    highlights.push({ icon: '🚀', text: `CTR de ${ctr.toFixed(2)}% acima da média — criativo performando bem`, color: '#34d399' });
  }

  if (clickToMsgRate >= 60) {
    highlights.push({ icon: '💬', text: `${clickToMsgRate.toFixed(0)}% dos cliques viram mensagens — ótima taxa de conversão`, color: '#34d399' });
  }

  if (cpaTarget && costPerMessage > 0 && costPerMessage < cpaTarget * 0.9) {
    highlights.push({ icon: '💰', text: 'Custo por mensagem abaixo da meta — bom momento para escalar', color: '#34d399' });
  }

  if (previous && prevMessages > 0) {
    const msgGrowth = ((messages - prevMessages) / prevMessages) * 100;
    if (msgGrowth > 15) {
      highlights.push({ icon: '📈', text: `Volume de mensagens cresceu ${msgGrowth.toFixed(0)}% vs período anterior`, color: '#34d399' });
    }
  }

  // ── Alerts ─────────────────────────────────────────────────────────────────
  const alerts = [];

  if (frequency > 4) {
    alerts.push({ icon: '⚠️', text: `Frequência ${frequency.toFixed(1)} — público saturando`, color: '#fbbf24', action: 'Troque o criativo ou amplie o público' });
  }

  if (ctr < 0.8) {
    alerts.push({ icon: '📉', text: `CTR de ${ctr.toFixed(2)}% muito baixo`, color: '#f87171', action: 'Revise o criativo e o call-to-action' });
  }

  if (previous && prevCpm > 0 && cpm > 0) {
    const cpmDeltaPct = ((cpm - prevCpm) / prevCpm) * 100;
    if (cpmDeltaPct > 25) {
      alerts.push({ icon: '💸', text: `CPM subiu ${cpmDeltaPct.toFixed(0)}% vs período anterior`, color: '#fbbf24', action: 'Verifique se o público está se esgotando' });
    }
  }

  if (cpaTarget && costPerMessage > 0 && costPerMessage > cpaTarget * 1.3) {
    const pctAbove = (((costPerMessage / cpaTarget) - 1) * 100).toFixed(0);
    alerts.push({ icon: '🎯', text: `Custo por mensagem ${pctAbove}% acima da meta`, color: '#f87171', action: 'Revisar otimizações — considere reiniciar o conjunto de anúncios' });
  }

  // ── Por campanha ───────────────────────────────────────────────────────────
  const campaigns = (current.campaigns || []).map(c => {
    let campScore = 70;

    const cCtr  = c.ctr  || 0;
    const cFreq = c.frequency || 0;
    const cCpm  = c.cpm  || 0;
    const cCpm$ = costPerMessage || 0;

    if      (cCtr >= 2.5) campScore += 15;
    else if (cCtr >= 1.5) campScore += 10;
    else if (cCtr >= 1.0) campScore += 0;
    else if (cCtr >= 0.5) campScore -= 10;
    else                  campScore -= 20;

    if      (cFreq <= 2) campScore += 10;
    else if (cFreq <= 3) campScore += 0;
    else if (cFreq <= 4) campScore -= 10;
    else if (cFreq <= 6) campScore -= 20;
    else                 campScore -= 30;

    campScore = Math.max(0, Math.min(100, Math.round(campScore)));

    const issues = [];
    if (cFreq > 4)  issues.push({ text: `Frequência alta (${cFreq.toFixed(1)})`, action: 'Troque o criativo ou amplie o público' });
    if (cCtr < 0.8) issues.push({ text: `CTR baixo (${cCtr.toFixed(2)}%)`, action: 'Revise o criativo' });
    if (cpaTarget && c.costPerMessage && c.costPerMessage > cpaTarget * 1.3) {
      issues.push({ text: `Custo/msg acima da meta (${c.costPerMessage.toFixed(2)})`, action: 'Revisar otimizações' });
    }

    return { name: c.name, score: campScore, issues };
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  let summary = '';
  if (grade === 'Excelente') {
    summary = `Performance excelente no período. Os criativos estão entregando bem e os custos estão controlados.`;
  } else if (grade === 'Bom') {
    summary = `Performance boa no período com métricas dentro do esperado${alerts.length > 0 ? ', porém com alguns pontos de atenção' : ''}.`;
  } else if (grade === 'Atenção') {
    summary = `Existem pontos de atenção que precisam ser monitorados para evitar queda de performance.`;
  } else {
    summary = `Performance crítica no período. Ação imediata recomendada para reverter os indicadores negativos.`;
  }

  // ── clientDraft (fallback rule-based) ────────────────────────────────────
  const brl    = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
  const fmt    = v => new Intl.NumberFormat('pt-BR').format(v || 0);
  const since  = period?.since || '';
  const until  = period?.until || '';
  const dateBR = s => { if (!s) return ''; const [y,m,d] = s.split('-'); return `${d}/${m}`; };

  const lines = [];
  lines.push(`Bom dia!`);
  lines.push('');
  lines.push(`✅ Análise do período ${dateBR(since)} a ${dateBR(until)}.`);
  lines.push('');

  // Parágrafo 1 — resultados
  let resultPara = `Essa semana,`;
  if (messages > 0 && costPerMessage > 0) {
    resultPara += ` geramos ${fmt(messages)} mensagens a ${brl(costPerMessage)} cada.`;
  } else if (messages > 0) {
    resultPara += ` recebemos ${fmt(messages)} mensagens.`;
  } else {
    resultPara += ` os resultados foram registrados no período.`;
  }
  lines.push(resultPara);
  lines.push('');

  // Parágrafo 2 — comparativo (se tiver semana anterior)
  if (previous) {
    const compParts = [];
    if (previous.messages != null && messages != null && previous.messages > 0) {
      const dir = messages >= previous.messages ? 'subiram' : 'caíram';
      compParts.push(`as mensagens ${dir} de ${fmt(previous.messages)} para ${fmt(messages)}`);
      if (previous.costPerMessage > 0 && costPerMessage > 0) {
        const dirCpm = costPerMessage <= previous.costPerMessage ? 'caindo' : 'subindo';
        compParts.push(`custo por mensagem ${dirCpm} de ${brl(previous.costPerMessage)} para ${brl(costPerMessage)}`);
      }
    }
    if (compParts.length > 0) {
      lines.push(`📉 Comparando com a semana anterior, ${compParts.join(', ')}.`);
      lines.push('');
    }
  }

  // Linha final
  lines.push(`📎 Caso queiram acessar o relatório completo, segue o link:`);

  const clientDraft = lines.join('\n');

  return { score, grade, gradeColor, summary, highlights, alerts, campaigns, clientDraft };
}

module.exports = { generateDiagnosis };
