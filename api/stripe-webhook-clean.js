// /api/stripe-webhook-clean.js
const Stripe = require('stripe');
const getRawBody = require('raw-body');
const crypto = require('crypto');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).send('OK /api/stripe-webhook-clean');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, GET');
    return res.status(405).send('Method Not Allowed');
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!process.env.STRIPE_SECRET_KEY || !webhookSecret) {
    return res.status(500).json({ error: 'Missing Stripe keys' });
  }

  // Leer raw body (requisito de Stripe)
  let rawBody;
  try { rawBody = await getRawBody(req); }
  catch { return res.status(400).send('Invalid body'); }

  // Verificar firma
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, unhandled: event.type });
  }

  const session = event.data.object;

  // Helper: leer custom_fields del Checkout por key/label (tolerante a acentos)
  function getCustomField(sess, options) {
    const fields = Array.isArray(sess.custom_fields) ? sess.custom_fields : [];
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    for (const f of fields) {
      const key = norm(f.key);
      const label = norm(f.label?.custom);
      for (const opt of options) {
        const nopt = norm(opt);
        if (nopt === key || (label && label.includes(nopt))) return f.text?.value || '';
      }
    }
    return '';
  }

  try {
    // Cargar líneas (para detección)
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
      expand: ['data.price.product'],
    });

    // Detectar si es gift card
    const { isGiftCard } = await detectGiftCard(session, lineItems, getCustomField);
    if (!isGiftCard) return res.status(200).json({ received: true, ignored: true });

    // ===== Mapear datos desde Stripe =====
    const buyerEmail =
      (session.customer_details && session.customer_details.email) ||
      session.customer_email ||
      (session.metadata && session.metadata.buyer_email) ||
      null;

    const recipientName =
      (session.metadata && session.metadata.recipient_name) ||
      getCustomField(session, ['Nombre del cumpleañero']) || '';

    const message =
      (session.metadata && session.metadata.message) ||
      getCustomField(session, ['Mensaje para el cumpleañero']) || '';

    const amount = session.amount_total; // centavos
    const currency = session.currency;
    const formattedAmount = `${(amount / 100).toFixed(2)} ${String(currency || '').toUpperCase()}`;

    if (!buyerEmail) {
      console.warn('No buyerEmail; cannot upsert Mailchimp contact.');
      return res.status(200).json({ received: true, giftcard: true, buyerEmail: null });
    }

    // ===== Enviar SOLO estos merge tags si existen en tu Audience =====
    const existing = await getMailchimpMergeTags(); // Set en mayúsculas
    const desired = {
      RECIPIENT: recipientName, // nombre destinatario
      GFTMSG:    message,       // mensaje
      AMOUNT:    formattedAmount // p.ej. "25.00 EUR"
    };
    const mergeFields = {};
    for (const [k, v] of Object.entries(desired)) {
      if (existing.has(k)) mergeFields[k] = v || '';
    }

    console.log('Mailchimp payload →', {
      buyerEmail, recipientName, message, formattedAmount, mergeFields
    });

    // Upsert del comprador + etiquetas
    try {
      await upsertMailchimpContact({ email: buyerEmail, mergeFields });
      await addMailchimpTag({ email: buyerEmail, tagName: 'gift_buyer' });
      await addMailchimpTag({ email: buyerEmail, tagName: 'tarjeta_regalo' });
    } catch (e) {
      console.error('Mailchimp buyer failed:', e?.message || e);
    }

    return res.status(200).json({ received: true, giftcard: true, buyerEmail });
  } catch (err) {
    console.error('handler_failed:', err);
    return res.status(200).json({ received: true, soft_error: true });
  }
};

// --------- Detección de Gift Card ----------
async function detectGiftCard(session, lineItems, getCustomField) {
  let isGiftCard = false;
  const metaKeys = ['gift_card', 'gift-card', 'giftcard', 'tarjeta_regalo'];
  const nameKeywords = ['gift card', 'tarjeta regalo', 'bono regalo'];

  function isTrue(v) {
    const s = String(v ?? '').toLowerCase().trim();
    return s === 'true' || s === '1' || v === true;
  }

  // 1) Metadata en price/product
  for (const item of lineItems.data) {
    let product = item.price && item.price.product;
    if (typeof product === 'string') product = await stripe.products.retrieve(product);
    const md = { ...(item.price?.metadata || {}), ...(product?.metadata || {}) };
    for (const k of metaKeys) {
      if (isTrue(md[k])) { isGiftCard = true; break; }
    }
    if (isGiftCard) break;
  }

  // 2) Nombre/descr (por si no hay metadata)
  if (!isGiftCard) {
    for (const item of lineItems.data) {
      const desc = String(item.description || '').toLowerCase();
      let product = item.price && item.price.product;
      if (typeof product === 'string') product = await stripe.products.retrieve(product);
      const pname = String(product?.name || '').toLowerCase();
      for (const kw of nameKeywords) {
        if (desc.includes(kw) || pname.includes(kw)) { isGiftCard = true; break; }
      }
      if (isGiftCard) break;
    }
  }

  // 3) Custom fields del Checkout (mantenemos para detección)
  if (!isGiftCard) {
    const hasRecipientEmail = !!getCustomField(session, ['Email del cumpleañero']);
    const hasRecipientName  = !!getCustomField(session, ['Nombre del cumpleañero']);
    const hasMessage        = !!getCustomField(session, ['Mensaje para el cumpleañero']);
    if (hasRecipientEmail || hasRecipientName || hasMessage) isGiftCard = true;
  }

  return { isGiftCard };
}

// ========== Helpers Mailchimp ==========
function mailchimpHeaders() {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  if (!apiKey) throw new Error('Missing MAILCHIMP_API_KEY');
  const auth = Buffer.from(`anystring:${apiKey}`).toString('base64');
  return { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` };
}

// Devuelve un Set con los MERGE TAGS disponibles en la Audience
async function getMailchimpMergeTags() {
  const server = process.env.MAILCHIMP_SERVER_PREFIX; // ej. 'us1'
  const listId = process.env.MAILCHIMP_AUDIENCE_ID;
  const tags = new Set();
  if (!server || !listId) return tags;

  const url = `https://${server}.api.mailchimp.com/3.0/lists/${listId}/merge-fields?count=100`;
  try {
    const resp = await fetch(url, { headers: mailchimpHeaders() });
    const json = await resp.json().catch(() => ({}));
    if (json && Array.isArray(json.merge_fields)) {
      for (const f of json.merge_fields) {
        if (f && typeof f.tag === 'string') tags.add(String(f.tag).toUpperCase());
      }
    }
  } catch (e) {
    console.error('getMailchimpMergeTags failed:', e?.message || e);
  }
  return tags;
}

async function upsertMailchimpContact({ email, mergeFields }) {
  const server = process.env.MAILCHIMP_SERVER_PREFIX; // ej. 'us1'
  const listId = process.env.MAILCHIMP_AUDIENCE_ID;
  if (!server || !listId || !email) return;

  const subscriberHash = crypto.createHash('md5').update(String(email).toLowerCase()).digest('hex');
  const url = `https://${server}.api.mailchimp.com/3.0/lists/${listId}/members/${subscriberHash}`;
  const body = {
    email_address: email,
    status_if_new: 'subscribed',
    merge_fields: mergeFields || {},
  };

  const resp = await fetch(url, { method: 'PUT', headers: mailchimpHeaders(), body: JSON.stringify(body) });
  if (!resp.ok) {
    const txt = await resp.text();
    console.error('Mailchimp upsert error:', resp.status, txt);
  }
}

async function addMailchimpTag({ email, tagName = 'tarjeta_regalo' }) {
  const server = process.env.MAILCHIMP_SERVER_PREFIX;
  const listId = process.env.MAILCHIMP_AUDIENCE_ID;
  if (!server || !listId || !email) return;

  const subscriberHash = crypto.createHash('md5').update(String(email).toLowerCase()).digest('hex');
  const url = `https://${server}.api.mailchimp.com/3.0/lists/${listId}/members/${subscriberHash}/tags`;
  const body = { tags: [{ name: tagName, status: 'active' }] };

  const resp = await fetch(url, { method: 'POST', headers: mailchimpHeaders(), body: JSON.stringify(body) });
  if (!resp.ok) {
    const txt = await resp.text();
    console.error('Mailchimp tags error:', resp.status, txt);
  }
}

// Vercel: Stripe necesita raw body
module.exports.config = { api: { bodyParser: false } };
