// ═══════════════════════════════════════════════════════════════════
// MARKE DIVULG — BACKEND PRINCIPAL (Node.js + Express)
// Servidor de webhooks: WhatsApp (Evolution API) + Meta (IG/FB)
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const axios = require('axios');
const { createClient } = require('redis');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(express.json());

// ── CONFIGURAÇÕES ─────────────────────────────────────────────────
const CONFIG = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  EVOLUTION_API_URL: process.env.EVOLUTION_API_URL,   // Ex: http://localhost:8080
  EVOLUTION_API_KEY: process.env.EVOLUTION_API_KEY,
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN,
  META_PAGE_TOKEN:   process.env.META_PAGE_TOKEN,
  PORT: process.env.PORT || 3000,
};

// ── BANCO DE DADOS (PostgreSQL) ────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── CACHE DE SESSÕES (Redis) ───────────────────────────────────────
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.connect().catch(console.error);

// ── NOMES DAS ATENDENTES (rotativo por sessão) ─────────────────────
const AGENT_NAMES = [
  'Ana Lima','Júlia Ferreira','Camila Rocha','Fernanda Costa',
  'Beatriz Oliveira','Larissa Santos','Gabriela Mendes','Mariana Alves',
  'Letícia Nunes','Priscila Ramos'
];

function getAgentName(contactId) {
  // Determinístico por contato: mesmo lead sempre fala com mesma "atendente"
  const hash = contactId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return AGENT_NAMES[hash % AGENT_NAMES.length];
}

// ── SYSTEM PROMPT HUMANIZADO ───────────────────────────────────────
function buildSystemPrompt(agentName, clientConfig, leadSource) {
  return `Você é ${agentName}, consultora de atendimento da ${clientConfig.company_name}.

IDENTIDADE — REGRAS ABSOLUTAS:
- Você é uma PESSOA REAL. Jamais diga que é IA, robô, bot ou sistema automatizado.
- Se perguntarem se você é humana: "Sim, sou consultora aqui da ${clientConfig.company_name}! 😊"
- Nunca mencione Claude, Anthropic, inteligência artificial ou automação.
- Use linguagem natural. Erre ocasionalmente uma vírgula. Varie o estilo.

ORIGEM DO LEAD: ${leadSource}
${leadSource === 'nfc' ? '→ Cliente tocou nosso chaveiro NFC. Já demonstrou interesse ativo.' : ''}
${leadSource === 'instagram_ad' ? '→ Veio de anúncio no Instagram. Qualificar orçamento.' : ''}
${leadSource === 'facebook_ad' ? '→ Veio de anúncio no Facebook. Qualificar urgência.' : ''}

EMPRESA E SERVIÇOS:
${clientConfig.services_description}

OBJETIVOS (nesta ordem):
1. RECEBER: Cumprimento caloroso. Pergunte o nome se não tiver.
2. QUALIFICAR: Entenda necessidade, orçamento e prazo. Faça perguntas abertas.
3. APRESENTAR: Mostre a solução ideal para o problema dito.
4. CONVERTER: Quebre objeções. Crie urgência real (vagas, prazo, oferta).
5. AGENDAR: Marque reunião quando lead estiver aquecido.
6. ESCALAR: Negociações complexas → chame o gestor.

ESTILO:
- Respostas curtas: máximo 3-4 linhas por mensagem no WhatsApp
- Emojis com moderação (1-2 por mensagem)
- Perguntas abertas para engajar
- Tom: profissional mas próximo, como uma amiga especialista

EVENTOS (coloque APENAS no início, será removido antes de enviar):
- "LEAD_QUALIFICADO:[interesse]" — quando identificar necessidade clara
- "REUNIAO_CONFIRMADA:[data e hora]" — ao confirmar agendamento
- "NEGOCIO_FECHADO:[serviço - valor]" — ao fechar venda
- "ESCALAR_GESTOR" — para transferir ao humano

Responda em português brasileiro natural.`;
}

// ── GERENCIAMENTO DE SESSÃO ────────────────────────────────────────
async function getSession(contactId, channel) {
  const key = `session:${channel}:${contactId}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  // Nova sessão
  const agentName = getAgentName(contactId);
  const session = {
    contactId,
    channel,
    agentName,
    messages: [],
    status: 'active', // active | escalated | closed
    createdAt: new Date().toISOString(),
    leadSource: 'direct',
  };
  await redis.setEx(key, 86400, JSON.stringify(session)); // 24h TTL
  return session;
}

async function saveSession(session) {
  const key = `session:${session.channel}:${session.contactId}`;
  await redis.setEx(key, 86400, JSON.stringify(session));
}

// ── CHAMADA À CLAUDE API ───────────────────────────────────────────
async function callClaude(session, clientConfig) {
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: buildSystemPrompt(session.agentName, clientConfig, session.leadSource),
      messages: session.messages.map(m => ({ role: m.role, content: m.content })),
    },
    {
      headers: {
        'x-api-key': CONFIG.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data.content[0].text;
}

// ── PROCESSAMENTO CENTRAL DE MENSAGEM ─────────────────────────────
async function processMessage({ contactId, channel, message, clientId, leadSource }) {
  // 1. Carregar config do cliente
  const clientResult = await db.query(
    'SELECT * FROM clients WHERE id = $1', [clientId]
  );
  const clientConfig = clientResult.rows[0];
  if (!clientConfig) throw new Error(`Cliente ${clientId} não encontrado`);

  // 2. Carregar/criar sessão
  const session = await getSession(contactId, channel);
  if (leadSource && session.messages.length === 0) {
    session.leadSource = leadSource;
  }

  // 3. Adicionar mensagem do usuário
  session.messages.push({ role: 'user', content: message });

  // 4. Registrar lead no banco
  if (session.messages.length === 1) {
    await db.query(
      `INSERT INTO leads (contact_id, channel, source, client_id, agent_name, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'novo', NOW())
       ON CONFLICT (contact_id, channel) DO NOTHING`,
      [contactId, channel, session.leadSource, clientId, session.agentName]
    );
  }

  // 5. Chamar Claude
  const rawResponse = await callClaude(session, clientConfig);

  // 6. Processar eventos especiais
  let displayResponse = rawResponse;
  let event = null;

  const eventPatterns = [
    { pattern: /^LEAD_QUALIFICADO:(.+)\n?/,  type: 'qualificado',  status: 'qualificado' },
    { pattern: /^REUNIAO_CONFIRMADA:(.+)\n?/, type: 'reuniao',      status: 'reuniao_marcada' },
    { pattern: /^NEGOCIO_FECHADO:(.+)\n?/,   type: 'fechado',      status: 'convertido' },
    { pattern: /^ESCALAR_GESTOR\n?/,          type: 'escalado',     status: 'escalado' },
  ];

  for (const ep of eventPatterns) {
    const match = rawResponse.match(ep.pattern);
    if (match) {
      displayResponse = rawResponse.replace(ep.pattern, '').trim();
      event = { type: ep.type, detail: match[1] || '' };

      await db.query(
        `UPDATE leads SET status = $1, updated_at = NOW()
         WHERE contact_id = $2 AND channel = $3`,
        [ep.status, contactId, channel]
      );

      await db.query(
        `INSERT INTO lead_events (contact_id, channel, event_type, detail, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [contactId, channel, ep.type, event.detail]
      );

      break;
    }
  }

  // 7. Salvar mensagem da agente na sessão
  session.messages.push({ role: 'assistant', content: displayResponse });
  await saveSession(session);

  // 8. Salvar no banco de mensagens
  await db.query(
    `INSERT INTO messages (contact_id, channel, role, content, agent_name, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [contactId, channel, 'assistant', displayResponse, session.agentName]
  );

  return { response: displayResponse, event, agentName: session.agentName };
}

// ══════════════════════════════════════════════════
// ROTAS — WHATSAPP (Evolution API)
// ══════════════════════════════════════════════════
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    res.sendStatus(200); // Responde imediatamente (Evolution API exige)

    const body = req.body;
    if (!body?.data?.message?.conversation) return;
    if (body.data.key.fromMe) return; // Ignorar mensagens enviadas por nós

    const contactId = body.data.key.remoteJid.replace('@s.whatsapp.net', '');
    const message   = body.data.message.conversation;
    const instance  = body.instance; // Nome da instância = identificador do cliente

    // Detectar origem NFC (mensagem inicial pode conter UTM)
    const leadSource = detectLeadSource(message, body.data?.message?.extendedTextMessage?.contextInfo);

    // Buscar clientId pela instância Evolution
    const clientResult = await db.query(
      'SELECT id FROM clients WHERE evolution_instance = $1', [instance]
    );
    if (!clientResult.rows.length) return;

    const { response, agentName } = await processMessage({
      contactId,
      channel: 'whatsapp',
      message,
      clientId: clientResult.rows[0].id,
      leadSource,
    });

    // Enviar resposta via Evolution API
    await axios.post(
      `${CONFIG.EVOLUTION_API_URL}/message/sendText/${instance}`,
      { number: contactId, text: response },
      { headers: { apikey: CONFIG.EVOLUTION_API_KEY } }
    );

    console.log(`[WhatsApp] ${instance} → ${contactId} (${agentName}): ${response.substring(0, 60)}...`);

  } catch (err) {
    console.error('[WhatsApp webhook error]', err.message);
  }
});

// ══════════════════════════════════════════════════
// ROTAS — META (Instagram + Facebook)
// ══════════════════════════════════════════════════

// Verificação do webhook Meta
app.get('/webhook/meta', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === CONFIG.META_VERIFY_TOKEN) {
    console.log('[Meta] Webhook verificado com sucesso');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook/meta', async (req, res) => {
  try {
    res.sendStatus(200);
    const body = req.body;
    if (body.object !== 'page' && body.object !== 'instagram') return;

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        if (!event.message || event.message.is_echo) continue;

        const senderId   = event.sender.id;
        const message    = event.message.text;
        const pageId     = entry.id;
        const channel    = body.object === 'instagram' ? 'instagram' : 'facebook';

        if (!message) continue;

        // Detectar origem por ref (anúncio ou NFC)
        const leadSource = event.referral?.ref
          ? decodeLeadSourceFromRef(event.referral.ref)
          : channel === 'instagram' ? 'instagram_direct' : 'facebook_direct';

        const clientResult = await db.query(
          'SELECT id FROM clients WHERE meta_page_id = $1', [pageId]
        );
        if (!clientResult.rows.length) continue;

        const { response } = await processMessage({
          contactId: senderId,
          channel,
          message,
          clientId: clientResult.rows[0].id,
          leadSource,
        });

        // Enviar resposta via Meta Graph API
        await axios.post(
          `https://graph.facebook.com/v19.0/me/messages`,
          {
            recipient: { id: senderId },
            message: { text: response },
            messaging_type: 'RESPONSE',
          },
          { params: { access_token: CONFIG.META_PAGE_TOKEN } }
        );
      }
    }
  } catch (err) {
    console.error('[Meta webhook error]', err.message);
  }
});

// ══════════════════════════════════════════════════
// UTILITÁRIOS DE RASTREAMENTO
// ══════════════════════════════════════════════════
function detectLeadSource(message, contextInfo) {
  const msg = message.toLowerCase();
  if (msg.includes('nfc') || msg.includes('chaveiro') || msg.includes('cartão nfc')) return 'nfc';
  if (msg.includes('vi no instagram') || msg.includes('anúncio ig'))  return 'instagram_ad';
  if (msg.includes('vi no facebook') || msg.includes('anúncio fb'))   return 'facebook_ad';
  if (contextInfo?.externalAdReply) return 'whatsapp_ad';
  return 'whatsapp_direct';
}

function decodeLeadSourceFromRef(ref) {
  // ref é passado na URL do NFC/anúncio: ?ref=nfc_cliente123
  if (ref.startsWith('nfc_'))          return 'nfc';
  if (ref.startsWith('ig_ad_'))        return 'instagram_ad';
  if (ref.startsWith('fb_ad_'))        return 'facebook_ad';
  return 'direct';
}

// ══════════════════════════════════════════════════
// API INTERNA — Dashboard
// ══════════════════════════════════════════════════
app.get('/api/leads', async (req, res) => {
  const { client_id, status, channel, source, limit = 50 } = req.query;
  let query = `SELECT l.*, array_agg(le.event_type) as events
               FROM leads l
               LEFT JOIN lead_events le ON le.contact_id = l.contact_id AND le.channel = l.channel
               WHERE 1=1`;
  const params = [];

  if (client_id) { params.push(client_id); query += ` AND l.client_id = $${params.length}`; }
  if (status)    { params.push(status);    query += ` AND l.status = $${params.length}`; }
  if (channel)   { params.push(channel);   query += ` AND l.channel = $${params.length}`; }
  if (source)    { params.push(source);    query += ` AND l.source = $${params.length}`; }

  query += ` GROUP BY l.id ORDER BY l.created_at DESC LIMIT $${params.push(parseInt(limit))}`;

  const result = await db.query(query, params);
  res.json(result.rows);
});

app.get('/api/stats/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const stats = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'novo')            AS novos,
      COUNT(*) FILTER (WHERE status = 'qualificado')     AS qualificados,
      COUNT(*) FILTER (WHERE status = 'reuniao_marcada') AS reunioes,
      COUNT(*) FILTER (WHERE status = 'convertido')      AS convertidos,
      COUNT(*) FILTER (WHERE status = 'escalado')        AS escalados,
      COUNT(*) FILTER (WHERE source = 'nfc')             AS leads_nfc,
      COUNT(*) FILTER (WHERE source LIKE '%instagram%')  AS leads_instagram,
      COUNT(*) FILTER (WHERE source LIKE '%facebook%')   AS leads_facebook,
      COUNT(*)                                           AS total
    FROM leads WHERE client_id = $1
  `, [clientId]);
  res.json(stats.rows[0]);
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Marke Divulg Server rodando na porta ${CONFIG.PORT}`);
});
