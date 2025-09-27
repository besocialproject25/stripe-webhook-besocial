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
    // Cargar líneas (para detección)
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
      expand: ['data.price.product'],
    });

    // Detectar si es
