// /api/stripe-webhook-v2.js  (Vercel Serverless Function - Node.js)
const Stripe = require('stripe');
const getRawBody = require('raw-body');
const crypto = require('crypto');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).send('OK /api/stripe-webhook-v2');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, GET');
    return res.status(405).send('Method Not Allowed');
  }

  // Secrets
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('Missing STRIPE_SECRET_KEY');
    return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY' });
  }
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('Missing STRIPE_WEBHOOK_SECRET');
    return res.status(500).json({ error: 'Missing STRIPE_WEBHOOK_SECRET' });
  }

  // Raw body
  let rawBody;
  try { rawBody = await getRawBody(req); }
  catch { return res.status(400).send('Invalid body'); }

  // Verify signature
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Signature verify failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle events
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // helper para leer custom_fields
    function getCustomField(sess, options = []) {
      const fields = sess.custom_fields || [];
      const norm = (s) => (s || '').toString().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
      for (const f of fields) {
        const key = norm(f.key);
        const label = norm(f.label?.custom);
        if (options.some((opt) => norm(opt) === key)) return f.text?.value || '';
        if (label && options.some((opt) => label.includes(norm(opt)))) return f.text?.value || '';
      }
      return '';
    }

    try {
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { expand: ['data.price.product'] });
      const { isGiftCard, giftItem } = await detectGiftCard(session, lineItems, getCustomField);

      if (!isGiftCard) {
        // ignoramos sesiones que no son tarjeta regalo
        return res.status(200).json({ received: true, ignored: true });
      }

      // Datos para Mailchimp
      const customerEmail =
        session.customer_details?.email ||
        session.customer_email ||
        session.metadata?.recipient_email;

      const amount   = session.amount_total; // en centavos
      const currency = session.currency;
      const senderName    = session.metadata?.sender_name || '';
      const recipientName = session.metadata?.recipient_name || '';
      const message       = session.metadata?.message || '';

      const mergeFields = {
        RECIPIENT: recipientName || '',
        GFTMSG:    message || '',
        SENDER:    senderName || '',
        AMOUNT:    `${(amount / 100).toFixed(2)} ${String(currency || '').toUpperCase()}`,
      };

      // Mailchimp (no romper webhook si falla)
      try { await upsertMailchimpContact({ email: customerEmail, mergeFields }); }
      catch (e) { console.error('Mailchimp upsert failed:', e?.message || e); }

      try { await addMailchimpTag({ email: customerEmail, tagName: 'tarjeta_regalo' }); }
      catch (e) { console.error('Mailchimp tag failed:', e?.message || e); }

      return res.status(200).json({ received: true, giftcard: true, item: giftItem?.item?.description || null });
    } catch (err) {
      console.error('handler_failed:', err);
      return res.status(200).json({ received: true, soft_error: true }); // evitar reintentos de Stripe
    }
  }

  return res.status(200).json({ received: true, unhandled: event.type });
};

// --------- Detección robusta de Gift Card ----------
async function detectGiftCard(session, lineItems, getCustomField) {
  let isGiftCard = false;
  let giftItem = null;

  const metaKeys = ['gift_card', 'gift-card', 'giftcard', 'is_gift_card', 'tarjeta_regalo'];
  const nameKeywords = [
    'gift card','gift-card','giftcard',
    'tarjeta regalo','tarjeta-regalo','bono regalo',
    'donación regalo','donacion regalo','donacion-regalo'
  ];

  const isTrue = (v) => {
    const s = String(v ?? '').toLowerCase().trim();
    return s === 'true' || s === '1' || v === true;
  };
  const includesKeyword = (txt = '') => nameKeywords.some(k => String(txt).toLowerCase().includes(k));

  // 1) Metadata en price/product
  for (const item of lineItems.data) {
    let product = item.price && item.price.product;
    if (product && typeof product === 'string') product = await stripe.products.retrieve(product);
    const priceMd = (item.price && item.price.metadata) || {};
    const prodMd  = (product && product.metadata) || {};
    if (metaKeys.some(k => isTrue(priceMd[k])) || metaKeys.some(k => isTrue(prodMd[k]))) {
      isGiftCard = true; giftItem = { item, product }; break;
    }
  }

  // 2) Metadata en la sesión
  if (!isGiftCard) {
    const meta = session.metadata || {};
    if (metaKeys.some(k => isTrue(meta[k]))) isGiftCard = true;
  }

  // 3) Nombre/descr (por si no hay metadata)
  if (!isGiftCard) {
    for (const item of lineItems.data) {
      const desc = item.description || item?.price?.nickname || '';
      let product = item.price && item.price.product;
      if (product && typeof product === 'string') product = await stripe.products.retrieve(product);
      const pname = product?.name || '';
      if (includesKeyword(desc) || includesKeyword(pname)) {
        isGiftCard = true; giftItem = { item, product }; break;
      }
    }
  }

  // 4) Custom fields típicos
  if (!isGiftCard) {
    const hasRecipientEmail = !!getCustomField(session, [
      'email del cumpleañero','email cumpleanero','email del cumpleanero','email'
    ]);
    const hasRecipientName  = !!getCustomField(session, [
      'nombre del cumpleañero','nombre de la persona','nombre cumpleanero','nombre'
    ]);
    const hasMessage        = !!getCustomField(session, [
      'mensaje','mensaje para el cumpleañero','mensaje para el cumpleanero'
    ]);
    if (hasRecipientEmail || hasRecipientName || hasMessage) isGiftCard = true;
  }

  return { isGiftCard, giftItem };
}

// --------- Mailchimp helpers ----------
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
  const resp = await fetch(url, {
    method: 'PUT',
    headers: mailchimpHeaders(),
    body: JSON.stringify({ email_address: email, status_if_new: 'subscribed', merge_fields: mergeFields }),
  });
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
  const resp = await fetch(url, {
    method: 'POST',
    headers: mailchimpHeaders(),
    body: JSON.stringify({ tags: [{ name: tagName, status: 'active' }] }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    console.error('Mailchimp tags error:', resp.status, txt);
  }
}

// Vercel: Stripe necesita raw body
module.exports.config = { api: { bodyParser: false } };
