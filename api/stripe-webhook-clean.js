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

  // Helper para leer custom fields
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

  // Detectar si es gift card
  const { isGiftCard } = await detectGiftCard(session, await stripe.checkout.sessions.listLineItems(session.id, { expand: ['data.price.product'] }), getCustomField);

  if (!isGiftCard) return res.status(200).json({ received: true, ignored: true });

  // Aquí añadirías tu lógica Mailchimp
  console.log('🎁 Gift Card detectada correctamente');
  return res.status(200).json({ received: true, giftcard: true });
};

// Función limpia, sin const inc
async function detectGiftCard(session, lineItems, getCustomField) {
  let isGiftCard = false;
  const metaKeys = ['gift_card', 'gift-card', 'giftcard', 'tarjeta_regalo'];
  const nameKeywords = ['gift card','tarjeta regalo','bono regalo'];

  function isTrue(v) {
    const s = String(v ?? '').toLowerCase().trim();
    return s === 'true' || s === '1' || v === true;
  }

  for (const item of lineItems.data) {
    let product = item.price && item.price.product;
    if (typeof product === 'string') product = await stripe.products.retrieve(product);
    const md = { ...item.price.metadata, ...product.metadata };
    for (const k of metaKeys) if (isTrue(md[k])) isGiftCard = true;
  }

  for (const item of lineItems.data) {
    const desc = (item.description || '').toLowerCase();
    const pname = (item.price.product.name || '').toLowerCase();
    for (const kw of nameKeywords) if (desc.includes(kw) || pname.includes(kw)) isGiftCard = true;
  }

  const hasFields =
    getCustomField(session, ['Email del cumpleañero']) ||
    getCustomField(session, ['Nombre del cumpleañero']);
  if (hasFields) isGiftCard = true;

  return { isGiftCard };
}

module.exports.config = { api: { bodyParser: false } };
