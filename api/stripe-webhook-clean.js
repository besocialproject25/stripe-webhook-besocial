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

    const recipientEmail =
      (session.metadata && session.metadata.recipient_email) ||
      getCustomField(session, ['Email del cumpleañero']) || null;

    const message =
      (session.metadata && session.metadata.message) ||
      getCustomField(session, ['Mensaje para el cumpleañero']) || '';

    // Remitente (opcional): CF/metadata -> nombre comprador -> prefijo email -> Stripe Customer
    let senderName =
      (session.metadata && session.metadata.sender_name) ||
      getCustomField(session, ['Tu nombre', 'Remitente', 'Quien envia', 'Sender']) ||
      (session.customer_details && session.customer_details.name) ||
      '';

    if (!senderName) {
      const buyerMail =
        (session.customer_details && session.customer_details.email) ||
        session.customer_email ||
        (session.metadata && session.metadata.buyer_email) ||
        null;
      if (buyerMail) senderName = String(buyerMail).split('@')[0];
    }
    if (!senderName && session.customer && typeof session.customer === 'string') {
      try {
        const cust = await stripe.customers.retrieve(session.customer);
        senderName = cust.name || (cust.email ? String(cust.email).split('@')[0] : '') || '';
      } catch (e) {}
    }

    const amount = session.amount_total; // centavos
    const currency = session.currency;
    const formattedAmount = `${(amount / 100).toFixed(2)} ${String(currency || '').toUpperCase()}`;

    // ===== Solo actualizamos el CONTACTO DEL COMPRADOR =====
    if (!buyerEmail) {
      console.warn('No buyerEmail; cannot upsert Mailchimp contact.');
      return res.status(200).json({ received: true, giftcard: true, buyerEmail: null, recipientEmail });
    }

    // Descubrir MERGE TAGS real
