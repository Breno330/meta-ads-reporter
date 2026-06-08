// ── Score de saúde de campanha ────────────────────────────────────────────────
// Retorna um score de 0 a 100 com base em:
//   • Frequência (40%) — detecta fadiga criativa
//   • CTR        (35%) — qualidade do criativo e da segmentação
//   • CPA        (25%) — custo por resultado vs meta configurada (opcional)
// Se nenhum CPA alvo configurado, pesos ficam: frequência 50%, CTR 50%.

function campaignScore(campaign, cpaTarget = null) {
  const f   = campaign.frequency        || 0;
  const ctr = campaign.ctr              || 0;
  const cpa = campaign.costPerMessage   || null;

  // ── Frequência ─────────────────────────────────────────────────────────────
  let freqScore;
  if      (f === 0)  freqScore = 50;  // sem dados — neutro
  else if (f <= 2.0) freqScore = 100;
  else if (f <= 3.0) freqScore = 80;
  else if (f <= 4.0) freqScore = 60;
  else if (f <= 5.5) freqScore = 40;
  else if (f <= 7.0) freqScore = 20;
  else               freqScore = 0;

  // ── CTR ────────────────────────────────────────────────────────────────────
  let ctrScore;
  if      (ctr >= 2.5) ctrScore = 100;
  else if (ctr >= 1.5) ctrScore = 85;
  else if (ctr >= 1.0) ctrScore = 70;
  else if (ctr >= 0.5) ctrScore = 50;
  else                 ctrScore = 25;

  // ── CPA vs alvo ────────────────────────────────────────────────────────────
  const hasCpa = cpaTarget > 0 && cpa !== null && cpa > 0;
  let cpaScore = 75; // neutro quando sem dados
  if (hasCpa) {
    const ratio = cpa / cpaTarget;
    if      (ratio <= 0.8)  cpaScore = 100;
    else if (ratio <= 1.0)  cpaScore = 85;
    else if (ratio <= 1.3)  cpaScore = 60;
    else if (ratio <= 1.6)  cpaScore = 40;
    else                    cpaScore = 15;
  }

  // ── Ponderação ─────────────────────────────────────────────────────────────
  const [wFreq, wCtr, wCpa] = hasCpa ? [0.40, 0.35, 0.25] : [0.50, 0.50, 0];
  const score = Math.round(freqScore * wFreq + ctrScore * wCtr + cpaScore * wCpa);

  // ── Classificação ──────────────────────────────────────────────────────────
  let label, color, emoji;
  if      (score >= 80) { label = 'Saudável'; color = '#34d399'; emoji = '🟢'; }
  else if (score >= 60) { label = 'Atenção';  color = '#fbbf24'; emoji = '🟡'; }
  else if (score >= 40) { label = 'Risco';    color = '#f97316'; emoji = '🟠'; }
  else                  { label = 'Crítico';  color = '#f87171'; emoji = '🔴'; }

  // ── Motivos principais (para exibir no tooltip) ────────────────────────────
  const reasons = [];
  if (f > 4.0)   reasons.push(`Frequência alta (${f.toFixed(1)})`);
  if (ctr < 1.0) reasons.push(`CTR baixo (${ctr.toFixed(2)}%)`);
  if (hasCpa && cpa / cpaTarget > 1.3) {
    const brl = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
    reasons.push(`CPA acima do alvo (${brl(cpa)} vs ${brl(cpaTarget)})`);
  }

  return {
    score,
    label,
    color,
    emoji,
    reasons,
    breakdown: { freqScore, ctrScore, cpaScore }
  };
}

module.exports = { campaignScore };
