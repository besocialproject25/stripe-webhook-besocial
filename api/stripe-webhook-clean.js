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
  if (!process.env.STRIPE_SECRET_KEY || !webhookSecret)
    return res.status(500).json({ error: 'Missing Stripe keys' });

  let rawBody;
  try { rawBody = await getRawBody(req); } catch { return res.status(400).send('Invalid body'); }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type !== 'checkout.session.completed')
    return res.status(200).json({ received: true, unhandled: event.type });

  const session = event.data.object;

  // Helper para leer custom fields por key/label (tolerante a acentos)
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
    // Cargar líneas para detección
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
      expand: ['data.price.product'],
    });

    // Detectar si es gift card
    const { isGiftCard } = await detectGiftCard(session, lineItems, getCustomField);
    if (!isGiftCard) return res.status(200).json({ received: true, ignored: true });

    // ====== MAPEO DE DATOS (según tus campos en Stripe) ======
    // Email del comprador (quien paga)
    const buyerEmail =
      session.customer_details?.email ||
      session.customer_email ||
      session.metadata?.buyer_email ||
      null;

    // Campos EXACTOS del checkout (etiquetas visibles)
    const recipientName =
      session.metadata?.recipient_name ||
      getCustomField(session, ['Nombre del cumpleañero']) ||
      '';

    const recipientEmail =
      session.metadata?.recipient_email ||
      getCustomField(session, ['Email del cumpleañero']) ||
      null;

    const message =
      session.metadata?.message ||
      getCustomField(session, ['Mensaje para el cumpleañero']) ||
      '';

    // Opcional: nombre del remitente si lo recogéis
    const senderName =
      session.metadata?.sender_name ||
      getCustomField(session, ['Tu nombre', 'Remitente', 'Quien envia', 'Sender']) ||
      '';

    const amount = session.amount_total; // en centavos
    const currency = session.currency;
    const formattedAmount = `${(amount / 100).toFixed(2)} ${String(currency || '').toUpperCase()}`;

    // Enviamos claves ES/EN a la vez; Mailchimp ignora las que no existan
    const mergeFieldsForBoth = {
      // nombre del destinatario
      RECEPTOR:  recipientName || '',
      RECIPIENT: recipientName || '',
      // mensaje
      MENSAJE:   message || '',
      GFTMSG:    message || '',
      // remitente
      SENDER:    senderName || '',
      // importe
      IMPORTE:   formattedAmount,
      AMOUNT:    formattedAmount,
    };

    // (debug opcional)
    console.log('Mailchimp payload', {
      buyerEmail, recipientEmail, recipientName, senderName, message, formattedAmount
    });

    // ====== MAILCHIMP ====== (no romper el webhook si falla)
    // 1) Buyer (quien paga)
    if (buyerEmail) {
      try {
        await upsertMailchimpContact({ email: buyerEmail, mergeFields: mergeFieldsForBoth });
        await addMailchimpTag({ email: buyerEmail, tagName: 'gift_buyer' });
        await addMailchimpTag({ email: buyerEmail, tagName: 'tarjeta_regalo' });
      } catch (e) {
        console.error('Mailchimp buyer failed:', e?.message || e);
      }
    }

    // 2) Recipient (quien recibe)
    if (recipientEmail) {
      try {
        await upsertMailchimpContact({ email: recipientEmail, mergeFields: mergeFieldsForBoth });
        await addMailchimpTag({ email: recipientEmail, tagName: 'gift_recipient' });
        await addMailchimpTag({ email: recipientEmail, tagName: 'tarjeta_regalo' });
      } catch (e) {
        console.error('Mailchimp recipient failed:', e?.message || e);
      }
    }

    return res.status(200).json({ received: true, giftcard: true, buyerEmail, recipientEmail });
  } catch (err) {
    console.error('handler_failed:', err);
    // Respondemos 200 para que Stripe no reintente si el fallo es nuestro
    return res.status(200).json({ received: true, soft_error: true });
  }
};

// Función limpia, sin "const inc"
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

  // 3) Custom fields típicos del Checkout
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

async function upsertMailchimpContact({ email, mergeFields }) {
  const server = process.env.MAILCHIMP_SERVER_PREFIX; // ej. 'us1'
  const listId = process.env.MAILCHIMP_AUDIENCE_ID;
  if (!server || !listId || !email) return;

  const subscriberHash = crypto.createHash('md5').update(String(email).toLowerCase()).digest('hex');
  const url = `https://${server}.api.mailchimp.com/3.0/lists/${listId}/members/${subscriberHash}`;
  const body = {
    email_address: email,
    status_if_new: 'subscribed',
    merge_fields: mergeFields,
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
