/**
 * claude-draft.js — Geração de rascunho para cliente via Claude (Anthropic)
 * Usa o SDK oficial @anthropic-ai/sdk com fallback para rule-based se a API key
 * não estiver configurada ou ocorrer qualquer erro.
 */

const Anthropic = require('@anthropic-ai/sdk');

/**
 * Gera um rascunho de mensagem para o cliente usando Claude.
 * @param {object} diagnosis  — resultado do generateDiagnosis
 * @param {object} metrics    — métricas brutas do período atual
 * @param {object} config     — { accountName, period, cpaTarget, previous, claudeStyle, claudeExamples }
 * @returns {Promise<{draft: string, source: 'claude'|'rule-based'}>}
 */
async function generateClaudeDraft(diagnosis, metrics, config = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

  if (!apiKey) {
    return { draft: diagnosis.clientDraft, source: 'rule-based' };
  }

  const {
    accountName    = 'cliente',
    period         = {},
    cpaTarget,
    previous       = null,
    claudeStyle    = '',
    claudeExamples = [],
  } = config;

  const { since = '', until = '' } = period;

  const dateBR = s => {
    if (!s) return '';
    const [y, m, d] = s.split('-');
    return `${d}/${m}`;
  };

  const brl = v =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);

  const num = v => new Intl.NumberFormat('pt-BR').format(v || 0);

  // ── Contexto de métricas do período atual ────────────────────────────────
  const metricsLines = [
    `- Conta: ${accountName}`,
    `- Período: ${dateBR(since)} a ${dateBR(until)}`,
    `- Investimento total: ${brl(metrics.spend)}`,
    `- Mensagens recebidas: ${metrics.messages || 0}`,
    `- Custo por mensagem: ${brl(metrics.costPerMessage)}`,
    `- Alcance: ${num(metrics.reach || 0)}`,
    `- CTR: ${(metrics.ctr || 0).toFixed(2)}%`,
    `- Score de performance: ${diagnosis.score}/100 (${diagnosis.grade})`,
  ];

  if (cpaTarget) metricsLines.push(`- CPA meta definido: ${brl(cpaTarget)}`);

  // Campanhas individuais
  const rawCamps  = metrics.campaigns || [];
  const diagCamps = diagnosis.campaigns || [];
  if (rawCamps.length > 0) {
    metricsLines.push(`\nDetalhamento por campanha (semana atual):`);
    rawCamps.forEach(c => {
      const diagEntry = diagCamps.find(d => d.name === c.name);
      const issues    = diagEntry?.issues?.length
        ? ` ⚠️ ${diagEntry.issues.map(i => i.text).join('; ')}`
        : ' ✅';
      const spend     = brl(c.spend || 0);
      const msgs      = c.messages != null ? `${c.messages} mensagens` : '';
      const followers = c.followers != null ? `${num(c.followers)} seguidores` : '';
      const cpa       = c.costPerMessage != null ? `R$ ${Number(c.costPerMessage).toFixed(2)}/msg` :
                        (c.costPerFollower != null ? `R$ ${Number(c.costPerFollower).toFixed(2)}/seguidor` : '');
      const stats     = [spend, msgs, followers, cpa].filter(Boolean).join(', ');
      metricsLines.push(`  • ${c.name}: ${stats}${issues}`);
    });
  }

  // ── Bloco comparativo com semana anterior ────────────────────────────────
  let comparisonBlock = '';
  if (previous) {
    const prevLines = [];
    if (previous.messages != null && metrics.messages != null) {
      const dir = metrics.messages >= previous.messages ? 'subiram' : 'caíram';
      prevLines.push(`- Mensagens: ${previous.messages} → ${metrics.messages} (${dir})`);
    }
    if (previous.costPerMessage != null && metrics.costPerMessage != null) {
      const dir = metrics.costPerMessage <= previous.costPerMessage ? 'caiu' : 'subiu';
      prevLines.push(`- Custo/msg: ${brl(previous.costPerMessage)} → ${brl(metrics.costPerMessage)} (${dir})`);
    }
    // Comparativo por campanha (seguidores, etc.)
    const prevCamps = previous.campaigns || [];
    rawCamps.forEach(c => {
      const prev = prevCamps.find(p => p.name === c.name);
      if (!prev) return;
      if (c.followers != null && prev.followers != null) {
        const dir = c.followers >= prev.followers ? 'subiu' : 'caiu';
        prevLines.push(`- ${c.name} seguidores: ${num(prev.followers)} → ${num(c.followers)} (${dir}), custo: ${prev.costPerFollower != null ? `R$ ${Number(prev.costPerFollower).toFixed(2)}` : '?'} → ${c.costPerFollower != null ? `R$ ${Number(c.costPerFollower).toFixed(2)}` : '?'}`);
      }
    });
    if (prevLines.length > 0) {
      comparisonBlock = `\nComparação com semana anterior:\n${prevLines.join('\n')}`;
      metricsLines.push(comparisonBlock);
    }
  }

  // ── Bloco de estilo personalizado ────────────────────────────────────────
  let styleBlock = '';
  if (claudeStyle.trim()) {
    styleBlock = `\nESTILO PESSOAL DO GESTOR (siga rigorosamente):\n${claudeStyle.trim()}\n`;
  }

  // ── Bloco de exemplos (few-shot) ─────────────────────────────────────────
  let examplesBlock = '';
  const validExamples = claudeExamples.filter(e => e?.trim());
  if (validExamples.length > 0) {
    examplesBlock = `\nEXEMPLOS REAIS DE MENSAGENS DO GESTOR — imite o estilo, tom, vocabulário e estrutura:\n`;
    validExamples.forEach((ex, i) => {
      examplesBlock += `\n--- Exemplo ${i + 1} ---\n${ex.trim()}\n`;
    });
    examplesBlock += `\n--- Fim dos exemplos ---\n`;
  }

  // ── System prompt ────────────────────────────────────────────────────────
  const systemPrompt = `Você é o assistente de um gestor de tráfego pago especialista em Meta Ads. Sua única função é escrever mensagens para os clientes do gestor informando os resultados de campanha.
${styleBlock}${examplesBlock}
REGRAS ABSOLUTAS DE FORMATAÇÃO — nunca quebre:
- TEXTO PURO. Zero markdown: sem asteriscos (*), sem cerquilha (#), sem traços como separador (---), sem underlines (_)
- NÃO repita o cabeçalho de data — ele já está escrito antes do seu texto
- Máximo 4 parágrafos curtos

ESTRUTURA OBRIGATÓRIA (siga exatamente nessa ordem, sem pular seções):

PARÁGRAFO 1 — Resultados da semana: inicie com "Essa semana," e descreva os resultados de forma natural. Mencione mensagens geradas e custo por mensagem. Se houver campanha de seguidores, mencione também com o custo por seguidor.

${comparisonBlock ? `PARÁGRAFO 2 — Comparativo: inicie com "📉 Comparando com a semana anterior," e compare as métricas principais (mensagens, custo, seguidores se houver) de forma natural e direta.

LINHA FINAL: escreva exatamente "📎 Caso queiram acessar o relatório completo, segue o link:"` : `LINHA FINAL: escreva exatamente "📎 Caso queiram acessar o relatório completo, segue o link:"`}

DIRETRIZES DE CONTEÚDO:
- Português brasileiro
- NUNCA use termos técnicos (CTR, CPM, frequência, impressões) — traduza para linguagem do cliente
- NUNCA mencione o nome da conta ou empresa
- Mencione cada campanha pelo nome com resultados em linguagem simples
- NÃO invente dados. NÃO mencione score, grade ou métricas internas`;

  // ── Prefill: garante abertura com o formato correto ──────────────────────
  const prefill = `Bom dia!\n\n✅ Análise do período ${dateBR(since)} a ${dateBR(until)}.\n\n`;

  const userPrompt = `Escreva a mensagem para o cliente com base nesses dados:\n\n${metricsLines.join('\n')}`;

  try {
    const client    = new Anthropic({ apiKey });
    const maxTokens = validExamples.length > 0 ? 500 : 400;

    const message = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages: [
        { role: 'user',      content: userPrompt },
        { role: 'assistant', content: prefill },  // Claude continua a partir daqui
      ],
    });

    const completion = message.content?.[0]?.text?.trim();
    if (!completion) throw new Error('Resposta vazia do Claude');

    // Une prefill + completion (prefill já termina com \n\n, sem espaço extra)
    const draft = `${prefill}${completion}`;

    return { draft, source: 'claude' };
  } catch (err) {
    console.error('[claude-draft] Erro ao chamar API do Claude:', err.message);
    return { draft: diagnosis.clientDraft, source: 'rule-based' };
  }
}

/**
 * Gera a ANÁLISE DE OTIMIZAÇÃO MENSAL via Claude.
 * Formato: Oportunidades + Pontos de Atenção + Sugestão de mensagem ao cliente.
 *
 * @param {string} accountName
 * @param {object} mes1  — mês atual (mês anterior): { since, until, data }
 * @param {object} mes2  — 2 meses atrás: { since, until, data }
 * @param {object} mes3  — 3 meses atrás: { since, until, data }
 * @returns {Promise<string>} — texto completo da mensagem Telegram
 */
async function generateMonthlyAnalysis(accountName, mes1, mes2, mes3) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

  const dateBR = s => { if (!s) return ''; const [y,m,d] = s.split('-'); return `${d}/${m}`; };
  const brl    = v => new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' }).format(v||0);
  const fmt    = v => new Intl.NumberFormat('pt-BR').format(v||0);
  const pct    = v => `${(v||0).toFixed(2)}%`;

  function formatMonth(m) {
    if (!m?.data) return 'Sem dados';
    const d = m.data;
    const lines = [
      `Período: ${dateBR(m.since)} a ${dateBR(m.until)}`,
      `Investimento: ${brl(d.spend)} | Mensagens: ${fmt(d.messages)} | Custo/msg: ${brl(d.costPerMessage)}`,
      `CTR: ${pct(d.ctr)} | CPM: ${brl(d.cpm)} | Alcance: ${fmt(d.reach)}`,
    ];
    if (d.campaigns?.length) {
      lines.push('Campanhas:');
      d.campaigns.forEach(c => {
        lines.push(`  • ${c.name}: ${fmt(c.messages)} msgs a ${brl(c.costPerMessage)}, CTR ${pct(c.ctr)}`);
        if (c.clicks && d.messages) {
          const conv = ((c.messages / (c.clicks || 1)) * 100).toFixed(0);
          lines.push(`    Conversão clique→msg: ${conv}%`);
        }
      });
    }
    return lines.join('\n');
  }

  const dataContext = [
    `=== MÊS MAIS RECENTE (${dateBR(mes1?.since)} a ${dateBR(mes1?.until)}) ===\n${formatMonth(mes1)}`,
    `=== MÊS ANTERIOR (${dateBR(mes2?.since)} a ${dateBR(mes2?.until)}) ===\n${formatMonth(mes2)}`,
    mes3 ? `=== 2 MESES ATRÁS (${dateBR(mes3?.since)} a ${dateBR(mes3?.until)}) ===\n${formatMonth(mes3)}` : '',
  ].filter(Boolean).join('\n\n');

  const systemPrompt = `Você é um analista sênior de tráfego pago especializado em Meta Ads.
Analise os dados de performance de 3 meses e gere um relatório no formato EXATO abaixo.

REGRAS:
- Seja objetivo, factual e baseado nos dados
- Use linguagem profissional mas acessível
- Destaque variações percentuais quando relevante
- Oportunidades = o que está crescendo ou tem potencial
- Pontos de atenção = o que precisa de ação ou monitoramento
- Mínimo 2 itens em cada seção
- Sugestão ao cliente deve ser calorosa, resumir o mês e dar contexto das campanhas
- Não invente dados que não estão nos dados fornecidos
- Use exatamente o formato especificado, com [ ] nos checkboxes`;

  const userPrompt = `Conta: ${accountName}
Data do relatório: ${dateBR(mes1?.until)}/${mes1?.until?.split('-')[0] || ''}

DADOS DOS ÚLTIMOS 3 MESES:
${dataContext}

Gere o relatório no formato EXATO:

ANÁLISE DE OTIMIZAÇÃO — ${accountName}

Data: ${dateBR(mes1?.until)}/${mes1?.until?.split('-')[0] || ''} | Período: ${dateBR(mes1?.since)} a ${dateBR(mes1?.until)}



── OPORTUNIDADES IDENTIFICADAS ──

[ ] [primeira oportunidade identificada nos dados]

[ ] [segunda oportunidade identificada nos dados]



── PONTOS DE ATENÇÃO ──

[ ] [primeiro ponto de atenção com ação sugerida]

[ ] [segundo ponto de atenção com ação sugerida]



─ SUGESTÃO DE MENSAGEM AO CLIENTE ─

Olá [nome]!

Segue o resumo do mês de [mês].

✅ Análise do mês:

[resumo do mês para o cliente, 3-4 parágrafos, linguagem amigável]

Qualquer dúvida, fico à disposição!
📎 Caso queiram acessar o relatório completo, segue o link: [LINK_AQUI]`;

  if (!apiKey) {
    return buildFallbackMonthly(accountName, mes1, mes2, mes3, dateBR, brl, fmt);
  }

  try {
    const client   = new Anthropic({ apiKey });
    const message  = await client.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 1800,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    return message.content?.[0]?.text?.trim() || buildFallbackMonthly(accountName, mes1, mes2, mes3, dateBR, brl, fmt);
  } catch (err) {
    console.error('[claude-draft] Erro na análise mensal:', err.message);
    return buildFallbackMonthly(accountName, mes1, mes2, mes3, dateBR, brl, fmt);
  }
}

function buildFallbackMonthly(accountName, mes1, mes2, mes3, dateBR, brl, fmt) {
  const d1 = mes1?.data, d2 = mes2?.data;
  const msgChange = d2?.messages > 0 ? (((d1?.messages - d2.messages) / d2.messages) * 100).toFixed(0) : null;
  const costChange = d2?.costPerMessage > 0 ? (((d1?.costPerMessage - d2.costPerMessage) / d2.costPerMessage) * 100).toFixed(0) : null;

  return `ANÁLISE DE OTIMIZAÇÃO — ${accountName}

Data: ${dateBR(mes1?.until)} | Período: ${dateBR(mes1?.since)} a ${dateBR(mes1?.until)}



── OPORTUNIDADES IDENTIFICADAS ──

[ ] ${msgChange > 0 ? `As mensagens cresceram ${msgChange}% em relação ao mês anterior, passando de ${fmt(d2?.messages)} para ${fmt(d1?.messages)}.` : `A conta gerou ${fmt(d1?.messages)} mensagens no período com investimento de ${brl(d1?.spend)}.`}

[ ] ${d1?.campaigns?.length ? `A campanha ${d1.campaigns[0]?.name} foi a principal responsável pelos resultados, com ${fmt(d1.campaigns[0]?.messages)} mensagens.` : 'Acompanhe as campanhas individualmente para identificar as mais eficientes.'}



── PONTOS DE ATENÇÃO ──

[ ] ${d1?.ctr < 1 ? `O CTR médio de ${(d1.ctr||0).toFixed(2)}% está abaixo de 1%. Ação sugerida: testar variações de criativo para aumentar a taxa de cliques.` : `Manter monitoramento do CTR (${(d1?.ctr||0).toFixed(2)}%) para garantir relevância dos criativos.`}

[ ] ${costChange > 10 ? `O custo por mensagem subiu ${costChange}% (de ${brl(d2?.costPerMessage)} para ${brl(d1?.costPerMessage)}). Ação sugerida: revisar segmentação e criativos.` : `O custo por mensagem de ${brl(d1?.costPerMessage)} está dentro do esperado. Continuar monitorando.`}



─ SUGESTÃO DE MENSAGEM AO CLIENTE ─

Olá [nome]!

Segue o resumo do mês.

✅ Análise do mês:

No período de ${dateBR(mes1?.since)} a ${dateBR(mes1?.until)}, a conta gerou ${fmt(d1?.messages)} mensagens com investimento total de ${brl(d1?.spend)}, resultando em um custo médio de ${brl(d1?.costPerMessage)} por mensagem.

Qualquer dúvida, fico à disposição!
📎 Caso queiram acessar o relatório completo, segue o link: [LINK_AQUI]`;
}

module.exports = { generateClaudeDraft, generateMonthlyAnalysis };
