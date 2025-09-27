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
        if (options.some((opt) => label.includes(norm(opt)))) {
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
      const { isGiftCard, giftItem } = await detectGiftCard(session, lineItems, getCustomField);
      if (!isGiftCard) {
        console.log('ℹ️ Checkout completado pero NO es tarjeta regalo. Ignoramos.', {
          sessionMetadata: session.metadata,
          customFields: session.custom_fields
        });
        return res.status(200).json({ received: true, ignored: true });
      }
      // --- FIN DETECCIÓN ---

      // Aquí ya es gift card. Preparamos datos para Mailchimp:
      const customerEmail =
        session.customer_details?.email ||
        session.customer_email ||
        session.metadata?.recipient_email;

      const amount = session.amount_total; // centavos
      const currency = session.currency;
      const senderName = session.metadata?.sender_name || '';
      const recipientName = session.metadata?.recipient_name || '';
      const message = session.metadata?.message || '';

      // Campos personalizados para Mailchimp (coinciden con tus MERGE TAGS)
      const mergeFields = {
        RECIPIENT: recipientName || '',
        GFTMSG: message || '',
        SENDER: senderName || '',
        AMOUNT: `${(amount / 100).toFixed(2)} ${String(currency || '').toUpperCase()}`,
      };

      // 1️⃣ Crear o actualizar el contacto en Mailchimp (REST)
      await upsertMailchimpContact({
        email: customerEmail,
        mergeFields,
      });

      // 2️⃣ Añadir etiqueta para disparar automatización (REST)
      await addMailchimpTag({
        email: customerEmail,
        tagName: 'tarjeta_regalo',
      });

      console.log('🎁 Gift card detectada. Datos para email/payload:', {
        customerEmail,
        amount,
        currency,
        senderName,
        recipientName,
        message,
        giftItemName: giftItem?.item?.description,
      });

      return res.status(200).json({ received: true, giftcard: true });
    } catch (err) {
      console.error('❌ Error manejando checkout.session.completed:', err);
      return res.status(500).json({ error: 'handler_failed' });
    }
  }

  // Otros eventos: no nos interesan
  console.log('🔎 Evento no manejado:', event.type);
  return res.status(200).json({ received: true, unhandled: event.type });
};

// ========= Función de detección de Gift Card =========
async function detectGiftCard(session, lineItems, getCustomField) {
  let isGiftCard = false;
  let giftItem = null;

  const giftKeys = ['gift_card', 'gift-card', 'giftcard'];
  const isTrue = (v) => {
    const s = String(v ?? '').toLowerCase().trim();
    return s === 'true' || s === '1' || v === true;
  };

  // 1) Reglas por metadata en price/product
  for (const item of lineItems.data) {
    let product = item.price && item.price.product;
    if (product && typeof product === 'string') {
      product = await stripe.products.retrieve(product);
    }
    const priceMd = (item.price && item.price.metadata) || {};
    const prodMd = (product && product.metadata) || {};
    if (giftKeys.some(k => isTrue(priceMd[k])) || giftKeys.some(k => isTrue(prodMd[k]))) {
      console.log('🎯 Gift flag por metadata:', {
        priceMetadata: priceMd,
        productMetadata: prodMd
      });
      isGiftCard = true;
      giftItem = { item, product };
      break;
    }
  }

  // 2) Reglas por metadata en la sesión
  if (!isGiftCard) {
    const meta = session.metadata || {};
    if (giftKeys.some(k => isTrue(meta[k]))) {
      console.log('🎯 Gift flag por session.metadata:', meta);
      isGiftCard = true;
    }
  }

  // 3) Reglas por presencia de custom fields típicos
  if (!isGiftCard) {
    const hasRecipientEmail = !!getCustomField(session, [
      'email del cumpleañero', 'email cumpleanero', 'email del cumpleanero', 'email'
    ]);
    const hasRecipientName = !!getCustomField(session, [
      'nombre del cumpleañero', 'nombre de la persona', 'nombre cumpleanero', 'nombre'
    ]);
    const hasMessage = !!getCustomField(session, [
      'mensaje', 'mensaje para el cumpleañero', 'mensaje para el cumpleanero'
    ]);
    if (hasRecipientEmail || hasRecipientName || hasMessage) {
      console.log('🎯 Gift flag por custom_fields:',
