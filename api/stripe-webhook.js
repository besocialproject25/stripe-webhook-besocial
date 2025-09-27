// /api/stripe-webhook.js  (Vercel Serverless Function - Node.js)
const Stripe = require('stripe');
const getRawBody = require('raw-body');
const crypto = require('crypto'); // para el hash MD5 del email

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2022-11-15',
});

module.exports = async (req, res) => {
  // Salud /diagnóstico rápido
  if (req.method === 'GET') {
    return res.status(200).send('OK /api/stripe-webhook');
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, GET');
    return res.status(405).send('Method Not Allowed');
  }

  // 1) Verificar que tenemos los secrets
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('❌ Falta STRIPE_SECRET_KEY en variables de entorno Vercel');
    return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY' });
  }
  if (!webhookSecret) {
    console.error('❌ Falta STRIPE_WEBHOOK_SECRET en variables de entorno Vercel');
    return res.status(500).json({ error: 'Missing STRIPE_WEBHOOK_SECRET' });
  }

  // 2) Leer raw body (requisito Stripe)
  let event;
  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error('❌ No se pudo leer raw body:', err);
    return res.status(400).send('Invalid body');
  }

  // 3) Verificar firma de Stripe
  const sig = req.headers['stripe-signature'];
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('❌ Firma inválida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('✅ Evento recibido:', event.type);

  // 4) Procesar evento
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // ---- Helper: obtiene el valor de un custom_field por posibles keys/labels
    function getCustomField(session, options = []) {
      const fields = session.custom_fields || [];
      const norm = (s) =>
        (s || '')
          .toString()
          .toLowerCase()
          .normalize('NFD')
          .replace(/\p{Diacritic}/gu, '');

      for (const f of fields) {
        const key = norm(f.key);
        const label = norm(f.label?.custom);
        if (options.some((opt) => norm(opt) === key)) {
          return f.text?.value || '';
        }
        if (options.some((opt) => label && label.includes(norm(opt)))) {
          return f.text?.value || '';
        }
      }
      return '';
    }

    try {
      // Line items del checkout (intentamos traer product expandido)
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
        expand: ['data.price.product'],
      });

      // --- DETECCIÓN DE GIFT CARD ---
      const { isGiftCard, giftItem } = await detectGiftCard(session, l
