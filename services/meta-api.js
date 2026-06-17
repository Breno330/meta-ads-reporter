const API_VERSION = 'v20.0';
const BASE        = `https://graph.facebook.com/${API_VERSION}`;

// Helper: fetch autenticado via Authorization header (token nunca vai para a URL)
// • Timeout automático de 15 s via AbortController
// • Retry com backoff exponencial (até 3 tentativas) em erros de rede ou 5xx
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiFetch(url, token, attempt = 1) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 15_000);
  let res;
  try {
    res = await globalThis.fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal:  controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (attempt < 3) {
      await sleep(1_000 * 2 ** (attempt - 1)); // 1 s, 2 s
      return apiFetch(url, token, attempt + 1);
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.status >= 500 && attempt < 3) {
    await sleep(1_000 * 2 ** (attempt - 1));
    return apiFetch(url, token, attempt + 1);
  }
  return res;
}

// ── Contas de anúncio acessíveis pelo usuário ────────────────────────────────

async function getAdAccounts(token) {
  const fields = 'id,name,account_id,account_status,currency,business{id,name,picture{url,is_silhouette}}';
  const url    = `${BASE}/me/adaccounts?fields=${fields}&limit=200`;

  const res  = await apiFetch(url, token);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  return (data.data || []).map(a => {
    // Tenta extrair foto do Business Manager (se não for silhueta genérica)
    const pic = a.business?.picture;
    const pictureUrl = (pic && !pic.is_silhouette) ? pic.url : null;

    return {
      id:         a.id,           // act_XXXXXXXX
      accountId:  a.account_id,
      name:       a.name,
      status:     a.account_status,
      currency:   a.currency,
      business:   a.business?.name || null,
      pictureUrl, // null se não disponível
    };
  });
}

// ── Insights de uma conta num período ───────────────────────────────────────

async function getInsights(token, accountId, since, until) {
  const timeRange = JSON.stringify({ since, until });

  // Resumo consolidado da conta
  const summaryFields = [
    'impressions','reach','clicks','spend','frequency',
    'ctr','cpm','actions','date_start','date_stop'
  ].join(',');

  const summaryUrl = `${BASE}/${accountId}/insights?fields=${summaryFields}&level=account&time_range=${encodeURIComponent(timeRange)}`;
  const summaryRes = await apiFetch(summaryUrl, token);
  const summaryData = await summaryRes.json();
  if (summaryData.error) throw new Error(summaryData.error.message);

  const s = summaryData.data?.[0] || {};

  // Campanhas individuais
  const campaignFields = [
    'campaign_name','objective','impressions','reach','clicks',
    'spend','frequency','ctr','cpm','actions'
  ].join(',');

  const campUrl  = `${BASE}/${accountId}/insights?fields=${campaignFields}&level=campaign&time_range=${encodeURIComponent(timeRange)}&limit=50`;
  const campRes  = await apiFetch(campUrl, token);
  const campData = await campRes.json();

  const campaigns = (campData.data || []).map(c => {
    const messages   = extractAction(c.actions, [
      'onsite_conversion.messaging_conversation_started_7d',
      'messaging_first_reply'
    ]);
    const followers  = sumActions(c.actions, ['like', 'follow']);
    const campSpend  = parseFloat(c.spend || 0);
    return {
      name:              c.campaign_name,
      objective:         c.objective,
      impressions:       parseInt(c.impressions || 0),
      reach:             parseInt(c.reach || 0),
      clicks:            parseInt(c.clicks || 0),
      spend:             campSpend,
      frequency:         parseFloat(c.frequency || 0),
      ctr:               parseFloat(c.ctr || 0),
      cpm:               parseFloat(c.cpm || 0),
      messages,
      followers,
      costPerMessage:    messages > 0 ? campSpend / messages : null,
      costPerFollower:   followers > 0 ? campSpend / followers : null
    };
  });

  const spend     = parseFloat(s.spend || 0);
  const clicks    = parseInt(s.clicks || 0);
  const messages  = extractAction(s.actions, [
    'onsite_conversion.messaging_conversation_started_7d',
    'messaging_first_reply',
    'omni_initiated_checkout'
  ]);
  const followers = sumActions(s.actions, ['like', 'follow']);

  // Breakdown diário (para gráficos)
  const dailyUrl  = `${BASE}/${accountId}/insights?fields=spend,actions,date_start&level=account&time_range=${encodeURIComponent(timeRange)}&time_increment=1&limit=90`;
  const dailyRes  = await apiFetch(dailyUrl, token);
  const dailyData = await dailyRes.json();

  const daily = (dailyData.data || [])
    .sort((a, b) => a.date_start.localeCompare(b.date_start))
    .map(d => ({
      date:     d.date_start,
      spend:    parseFloat(d.spend || 0),
      messages: extractAction(d.actions, [
        'onsite_conversion.messaging_conversation_started_7d',
        'messaging_first_reply'
      ])
    }));

  return {
    impressions:        parseInt(s.impressions || 0),
    reach:              parseInt(s.reach || 0),
    clicks,
    spend,
    frequency:          parseFloat(s.frequency || 0),
    ctr:                parseFloat(s.ctr || 0),
    cpm:                parseFloat(s.cpm || 0),
    messages,
    followers,
    costPerMessage:     messages > 0 ? spend / messages : null,
    costPerFollower:    followers > 0 ? spend / followers : null,
    clickToMessageRate: (clicks > 0 && messages > 0) ? (messages / clicks) * 100 : null,
    campaigns,
    daily,
    period:             { since, until }
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractAction(actions, types) {
  if (!actions || !Array.isArray(actions)) return 0;
  const typeList = Array.isArray(types) ? types : [types];
  for (const type of typeList) {
    const found = actions.find(a => a.action_type === type);
    if (found) return parseInt(found.value);
  }
  return 0;
}

// Soma múltiplos tipos de ação (ex: like + follow)
function sumActions(actions, types) {
  if (!actions || !Array.isArray(actions)) return 0;
  return types.reduce((sum, type) => {
    const found = actions.find(a => a.action_type === type);
    return sum + (found ? parseInt(found.value) : 0);
  }, 0);
}

// ── Insights em nível de anúncio (ad) ────────────────────────────────────────

async function getAdLevelInsights(token, accountId, since, until) {
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  const url = `${BASE}/${accountId}/insights?fields=ad_id,ad_name,adset_name,campaign_name,impressions,reach,clicks,spend,frequency,ctr,cpm,actions&level=ad&time_range=${timeRange}&limit=100`;

  const res  = await apiFetch(url, token);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const ads = (data.data || []).map(a => {
    const spend          = parseFloat(a.spend || 0);
    const messages       = extractAction(a.actions, [
      'onsite_conversion.messaging_conversation_started_7d',
      'messaging_first_reply'
    ]);
    const followers      = sumActions(a.actions, ['like', 'follow']);
    return {
      adId:            a.ad_id,
      name:            a.ad_name,
      adsetName:       a.adset_name,
      campaignName:    a.campaign_name,
      impressions:     parseInt(a.impressions || 0),
      reach:           parseInt(a.reach || 0),
      clicks:          parseInt(a.clicks || 0),
      spend,
      frequency:       parseFloat(a.frequency || 0),
      ctr:             parseFloat(a.ctr || 0),
      cpm:             parseFloat(a.cpm || 0),
      messages,
      costPerMessage:  messages > 0 ? spend / messages : null,
      followers,
      costPerFollower: followers > 0 ? spend / followers : null
    };
  });

  // Agrupa por campanha
  const byCampaign = {};
  for (const ad of ads) {
    if (!byCampaign[ad.campaignName]) byCampaign[ad.campaignName] = [];
    byCampaign[ad.campaignName].push(ad);
  }

  return { ads, byCampaign };
}

// ── Insights por plataforma (publisher_platform) ──────────────────────────────

async function getPlacementInsights(token, accountId, since, until) {
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  const url = `${BASE}/${accountId}/insights?fields=impressions,reach,clicks,spend,ctr,cpm,actions&breakdowns=publisher_platform&time_range=${timeRange}&level=account`;

  try {
    const res  = await apiFetch(url, token);
    const data = await res.json();
    if (data.error) return [];

    const placements = (data.data || []).map(d => {
      const spend    = parseFloat(d.spend || 0);
      const messages = extractAction(d.actions, [
        'onsite_conversion.messaging_conversation_started_7d',
        'messaging_first_reply'
      ]);
      return {
        platform:       d.publisher_platform,
        impressions:    parseInt(d.impressions || 0),
        reach:          parseInt(d.reach || 0),
        clicks:         parseInt(d.clicks || 0),
        spend,
        ctr:            parseFloat(d.ctr || 0),
        cpm:            parseFloat(d.cpm || 0),
        messages,
        costPerMessage: messages > 0 ? spend / messages : null
      };
    });

    return placements.sort((a, b) => b.spend - a.spend);
  } catch {
    return [];
  }
}

// ── Análise de criativos (insights por anúncio + thumbnails) ─────────────────

async function getCreativeInsights(token, accountId, since, until) {
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));

  // 1. Insights no nível do anúncio com todas as métricas relevantes
  const fields = [
    'ad_id','ad_name','adset_name','campaign_name',
    'impressions','reach','clicks','spend','frequency','ctr','cpm','actions'
  ].join(',');

  // Filtra apenas anúncios ativos
  const activeFilter = encodeURIComponent(JSON.stringify([{ field: 'ad.effective_status', operator: 'IN', value: ['ACTIVE'] }]));

  let allRows = [];
  let nextUrl = `${BASE}/${accountId}/insights?fields=${fields}&level=ad&time_range=${timeRange}&filtering=${activeFilter}&limit=200`;

  while (nextUrl) {
    const res  = await apiFetch(nextUrl, token);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    allRows = allRows.concat(data.data || []);
    nextUrl  = data.paging?.next || null;
  }

  if (!allRows.length) return [];

  // 2. Busca thumbnails (em alta) + data de criação dos anúncios, em lotes de 50
  const adIds      = [...new Set(allRows.map(a => a.ad_id))];
  const thumbMap   = {};
  const createdMap = {};
  const chunkSize  = 50;

  for (let i = 0; i < adIds.length; i += chunkSize) {
    const chunk    = adIds.slice(i, i + chunkSize);
    const filter   = encodeURIComponent(JSON.stringify([{ field: 'id', operator: 'IN', value: chunk }]));
    // thumbnail_width/height pedem uma miniatura maior (~400px), muito mais nítida
    // que o thumbnail padrão (~64px). image_url, quando existe, é a imagem cheia.
    const adsUrl   = `${BASE}/${accountId}/ads?fields=id,name,created_time,creative.thumbnail_width(400).thumbnail_height(400){thumbnail_url,image_url,object_type,name}&filtering=${filter}&limit=50`;
    try {
      const adsRes  = await apiFetch(adsUrl, token);
      const adsData = await adsRes.json();
      (adsData.data || []).forEach(ad => {
        const cr  = ad.creative || {};
        const img = cr.image_url || cr.thumbnail_url; // prefere imagem cheia
        if (img) thumbMap[ad.id] = img;
        if (ad.created_time) createdMap[ad.id] = ad.created_time;
      });
    } catch { /* thumbnail opcional — falha silenciosa */ }
  }

  // 3. Combina insights + thumbnails e calcula métricas derivadas
  return allRows.map(a => {
    const spend      = parseFloat(a.spend || 0);
    const messages   = extractAction(a.actions, [
      'onsite_conversion.messaging_conversation_started_7d',
      'messaging_first_reply'
    ]);
    const followers  = sumActions(a.actions, ['like', 'follow']);
    const purchases  = extractAction(a.actions, ['purchase', 'omni_purchase']);
    const leads      = extractAction(a.actions, ['lead', 'onsite_conversion.lead_grouped']);
    const results    = messages || purchases || leads || 0; // melhor resultado disponível
    const clicks     = parseInt(a.clicks || 0);
    const impressions= parseInt(a.impressions || 0);

    // Dias rodando: a partir da data de criação do anúncio
    const createdAt   = createdMap[a.ad_id] || null;
    const daysRunning = createdAt
      ? Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000))
      : null;

    return {
      adId:             a.ad_id,
      name:             a.ad_name,
      adsetName:        a.adset_name,
      campaignName:     a.campaign_name,
      impressions,
      reach:            parseInt(a.reach || 0),
      clicks,
      spend,
      frequency:        parseFloat(a.frequency || 0),
      ctr:              parseFloat(a.ctr || 0),
      cpm:              parseFloat(a.cpm || 0),
      messages,
      followers,
      purchases,
      leads,
      results,
      costPerResult:    results > 0  ? spend / results  : null,
      costPerMessage:   messages > 0 ? spend / messages : null,
      costPerClick:     clicks > 0   ? spend / clicks   : null,
      hookRate:         impressions > 0 ? (clicks / impressions) * 100 : 0,
      thumbnailUrl:     thumbMap[a.ad_id] || null,
      createdTime:      createdAt,
      daysRunning
    };
  });
}

// ── Insights por faixa etária ─────────────────────────────────────────────────

async function getAgeBreakdownInsights(token, accountId, since, until) {
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  const url = `${BASE}/${accountId}/insights?fields=impressions,reach,clicks,actions&breakdowns=age&time_range=${timeRange}&level=account&limit=50`;

  const AGE_ORDER = ['13-17','18-24','25-34','35-44','45-54','55-64','65+'];

  try {
    const res  = await apiFetch(url, token);
    const data = await res.json();
    if (data.error) return [];

    return (data.data || []).map(row => {
      const linkClicks = extractAction(row.actions, ['link_click']);
      return {
        age:         row.age || 'unknown',
        impressions: parseInt(row.impressions || 0),
        reach:       parseInt(row.reach || 0),
        clicks:      parseInt(row.clicks || 0),
        linkClicks
      };
    }).sort((a, b) => {
      const ia = AGE_ORDER.indexOf(a.age);
      const ib = AGE_ORDER.indexOf(b.age);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  } catch {
    return [];
  }
}

module.exports = { getAdAccounts, getInsights, getAdLevelInsights, getPlacementInsights, getCreativeInsights, getAgeBreakdownInsights };
