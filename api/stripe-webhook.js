// /api/stripe-webhook.js  (Vercel Serverless Function - Node.js)
const Stripe = require('stripe');
const getRawBody = require('raw-body');

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

    try {
      // Line items del checkout
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
        expand: ['data.price.product'], // intentamos expandir producto directo
      });

      // ¿Alguna línea es una gift card (según metadata del product)?
      let isGiftCard = false;
      let giftItem = null;

      for (const item of lineItems.data) {
        // item.price.product puede venir expandido (objeto) o como ID string
        let product = item.price && item.price.product;

        if (product && typeof product === 'string') {
          // No se expandió, la obtenemos
          product = await stripe.products.retrieve(product);
        }

        const md = product && product.metadata ? product.metadata : {};

        // Marca que definas en tu producto de Stripe: gift_card:true, gift-card:true, etc
        const markedAsGift =
          md.gift_card === 'true' ||
          md['gift-card'] === 'true' ||
          md.giftcard === 'true';

        if (markedAsGift) {
          isGiftCard = true;
          giftItem = { item, product };
          break;
        }
      }

      if (!isGiftCard) {
        console.log('ℹ️ Checkout completado pero NO es tarjeta regalo. Ignoramos.');
        return res.status(200).json({ received: true, ignored: true });
      }

      // Aquí ya es gift card. Preparamos datos mínimos:
      const customerEmail =
        session.customer_details?.email || session.customer_email || session.metadata?.recipient_email;
      const amount = session.amount_total; // centavos
      const currency = session.currency;
      const senderName = session.metadata?.sender_name || '';
      const recipientName = session.metadata?.recipient_name || '';
      const message = session.metadata?.message || '';

      console.log('🎁 Gift card detectada. Datos para email/payload:', {
        customerEmail,
        amount,
        currency,
        senderName,
        recipientName,
        message,
        giftItemName: giftItem?.item?.description,
      });

      // TODO: aquí envía el email / genera el PDF / guarda en DB / etc.
      // Ejemplo: await sendGiftCardEmail({ customerEmail, amount, ... });

      return res.status(200).json({ received: true, giftcard: true });
    } catch (err) {
      console.error('❌ Error manejando checkout.session.completed:', err);
      return res.status(500).json({ error: 'handler_failed' });
    }
  }

  // Otros eventos: no nos interesan, pero devolvemos 200 para que Stripe no reintente
  console.log('🔎 Evento no manejado:', event.type);
  return res.status(200).json({ received: true, unhandled: event.type });
};
const crypto = require('crypto');

async function upsertMailchimpMember({ email, firstName = '', lastName = '', tags = [] }) {
  const server = process.env.MAILCHIMP_SERVER_PREFIX;
  const listId = process.env.MAILCHIMP_AUDIENCE_ID;
  const apiKey = process.env.MAILCHIMP_API_KEY;

  const memberHash = crypto
    .createHash('md5')
    .update(email.toLowerCase())
    .digest('hex');

  // 1️⃣ Crear o actualizar el contacto
  const putUrl = `https://${server}.api.mailchimp.com/3.0/lists/${listId}/members/${memberHash}`;
  const putRes = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      Authorization: `apikey ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email_address: email,
      status_if_new: 'subscribed',
      merge_fields: { FNAME: firstName, LNAME: lastName },
    }),
  });

  const putJson = await putRes.json();
  console.log('📬 Mailchimp upsert:', putRes.status, putJson.title || putJson.status);

  // 2️⃣ Añadir etiquetas
  if (tags.length) {
    const tagsUrl = `https://${server}.api.mailchimp.com/3.0/lists/${listId}/members/${memberHash}/tags`;
    const tagOps = tags.map((t) => ({ name: t, status: 'active' }));
    const tagRes = await fetch(tagsUrl, {
      method: 'POST',
      headers: {
        Authorization: `apikey ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tags: tagOps }),
    });
    const tagJson = await tagRes.json().catch(() => ({}));
    console.log('🏷️ Mailchimp tags:', tagRes.status, tagJson);
  }
}
