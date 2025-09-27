// /api/stripe-webhook2.js  (Vercel Serverless Function - Node.js)
const Stripe = require('stripe');
const getRawBody = require('raw-body');
const crypto = require('crypto');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).send('OK /api/stripe-webhook2');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, GET');
    return res.status(405).send('Method Not Allowed');
  }

  // Secrets
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY' });
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).json({ error: 'Missing STRIPE_WEBHOOK_SECRET' });

  // Raw body
  let rawBody;
  try { rawBody = await getRawBody(req); } catch { return res.status(400).send('Invalid body'); }

  // Verify signature
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // helper para leer custom_fields por key/label (tolerante a acentos y may/min)
    function getCustomField(sess, options = []) {
      const fields = sess.custom_fields || [];
      const norm = (s) =>
        (s || '').toString().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
      for (const f of fields) {
        const key = norm(f.key);
        const label = norm(f.label?.custom);
        if (options.some((opt) => norm(opt) === key)) return f.text?.value || '';
        if (label && options.some((opt) => label.includes(norm(opt)))) return f.text?.value || '';
      }
      return '';
    }

    try {
      // Line items
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { expand: ['data.price.product'] });

      // Detección de gift card
function includesKeyword(txt = '') {
  const nameKeywords = [
    'gift card','gift-card','giftcard',
    'tarjeta regalo','tarjeta-regalo','bono regalo',
    'donación regalo','donacion regalo','donacion-regalo'
  ];
  const t = String(txt).toLowerCase();
  for (const k of nameKeywords) {
    if (t.includes(k)) return true;
  }
  return false;
}


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

      const amount   = session.amount_total; // en centavos
      const currency = session.currency;

      // Merge fields: asegúrate de tener estos MERGE TAGS en Mailchimp
      const mergeFieldsRecipient = {
        RECIPIENT: recipientName || '',
        GFTMSG:    message || '',
        SENDER:    senderName || '',
        AMOUNT:    `${(amount / 100).toFixed(2)} ${String(currency || '').toUpperCase()}`,
      };

      const mergeFieldsBuyer = {
        SENDER: senderName || '',
        AMOUNT: `${(amount / 100).toFixed(2)} ${String(currency || '').toUpperCase()}`,
      };

      // ====== MAILCHIMP (no romper el webhook si falla) ======
      // 1) Buyer (quien paga)
      if (buyerEmail) {
        try {
          await upsertMailchimpContact({ email: buyerEmail, mergeFields: mergeFieldsBuyer });
          await addMailchimpTag({ email: buyerEmail, tagName: 'gift_buyer' });
          await addMailchimpTag({ email: buyerEmail, tagName: 'tarjeta_regalo' });
        } catch (e) {
          console.error('Mailchimp buyer failed:', e?.message || e);
        }
      }

      // 2) Recipient (quien recibe)
      if (recipientEmail) {
        try {
          await upsertMailchimpContact({ email: recipientEmail, mergeFields: mergeFieldsRecipient });
          await addMailchimpTag({ email: recipientEmail, tagName: 'gift_recipient' });
          await addMailchimpTag({ email: recipientEmail, tagName: 'tarjeta_regalo' });
        } catch (e) {
          console.error('Mailchimp recipient failed:', e?.message || e);
        }
      }

      return res.status(200).json({
        received: true,
        giftcard: true,
        buyerEmail,
        recipientEmail,
      });
    } catch (err) {
      console.error('handler_failed:', err);
      // Respondemos 200 para que Stripe no reintente si el fallo es nuestro
      return res.status(200).json({ received: true, soft_error: true });
    }
  }

  return res.status(200).json({ received: true, unhandled: event.type });
};

// --------- Detección robusta de Gift Card ----------
async function detectGiftCard(session, lineItems, getCustomField) {
  let isGiftCard = false;

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

function includesKeyword(txt = '') {
  const t = String(txt).toLowerCase();
  for (const k of nameKeywords) {
    if (t.includes(k)) return true;
  }
  return false;
}
  };

  // 1) Metadata en price/product
  for (const item of lineItems.data) {
    let product = item.price && item.price.product;
    if (product && typeof product === 'string') product = await stripe.products.retrieve(product);
    const priceMd = (item.price && item.price.metadata) || {};
    const prodMd  = (product && product.metadata) || {};
    if (metaKeys.some((k) => isTrue(priceMd[k])) || metaKeys.some((k) => isTrue(prodMd[k]))) {
      isGiftCard = true;
      break;
    }
  }

  // 2) Metadata en la sesión
  if (!isGiftCard) {
    const meta = session.metadata || {};
    if (metaKeys.some((k) => isTrue(meta[k]))) {
      isGiftCard = true;
    }
  }

  // 3) Nombre/descr (por si no hay metadata)
  if (!isGiftCard) {
    for (const item of lineItems.data) {
      const desc = item.description || item?.price?.nickname || '';
      let product = item.price && item.price.product;
      if (product && typeof product === 'string') product = await stripe.products.retrieve(product);
      const pname = product?.name || '';
      if (includesKeyword(desc) || includesKeyword(pname)) {
        isGiftCard = true;
        break;
      }
    }
  }

  // 4) Custom fields típicos (si los has añadido en Checkout)
  if (!isGiftCard) {
    const hasRecipientEmail = !!getCustomField(session, ['Email del cumpleañero']);
    const hasRecipientName  = !!getCustomField(session, ['Nombre del cumpleañero']);
    const hasMessage        = !!getCustomField(session, ['Mensaje para el cumpleañero']);
    if (hasRecipientEmail || hasRecipientName || hasMessage) {
      isGiftCard = true;
    }
  }

  return { isGiftCard };
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
