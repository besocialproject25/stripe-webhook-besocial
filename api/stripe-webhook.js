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

    // Helper: obtiene el valor de un custom_field por posibles keys o por el texto del label.
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

        // ¿Coincide por key exacta?
        if (options.some((opt) => norm(opt) === key)) {
          return f.text?.value || '';
        }
        // ¿Coincide por label (contiene)?
        if (options.some((opt) => label.includes(norm(opt)))) {
          return f.text?.value || '';
        }
      }
      return '';
    }

    try {
      // Line items del checkout
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
        expand: ['data.price.product'], // intentamos expandir producto directo
      });

      // ========= DETECCIÓN DE GIFT CARD =========
      let isGiftCard = false;
      let giftItem = null;

      // helpers para detectar "true"
      const isTrue = (v) => {
        const s = String(v ?? '').toLowerCase().trim();
        return s === 'true' || s === '1' || v === true;
      };
      const giftKeys = ['gift_card', 'gift-card', 'giftcard'];

      // 1) Reglas por metadata en price/product
      for (const item of lineItems.data) {
        // item.price.product puede venir expandido (objeto) o como ID string
        let product = item.price && item.price.product;

        if (product && typeof product === 'string') {
          // No se expandió, la obtenemos
          product = await stripe.products.retrieve(product);
        }

        const priceMd = (item.price && item.price.metadata) || {};
        const prodMd = (product && product.metadata) || {};

        // ¿Alguna key típica en price.metadata o product.metadata marcada a true?
        const priceFlag = giftKeys.some((k) => isTrue(priceMd[k]));
        const prodFlag = giftKeys.some((k) => isTrue(prodMd[k]));

        if (priceFlag || prodFlag) {
          console.log('🎯 Gift flag por metadata:', {
            priceMetadata: priceMd,
            productMetadata: prodMd,
            matched: priceFlag ? 'price.metadata' : 'product.metadata',
          });
          isGiftCard = true;
          giftItem = { item, product };
          break;
        }
      }

      // 2) Reglas por metadata en la session (por si el Payment Link lleva meta)
      if (!isGiftCard) {
        const sessionMeta = session.metadata || {};
        const sessionFlag = giftKeys.some((k) => isTrue(sessionMeta[k]));
        if (sessionFlag) {
          console.log('🎯 Gift flag por session.metadata:', sessionMeta);
          isGiftCard = true;
        }
      }

      // 3) Reglas por presencia de custom fields (si están los campos típicos de la tarjeta)
      if (!isGiftCard) {
        const hasRecipientEmail = !!getCustomField(session, [
          'email del cumpleañero',
          'email cumpleanero',
          'email del cumpleanero',
          'email',
        ]);
        const hasRecipientName = !!getCustomField(session, [
          'nombre del cumpleañero',
          'nombre de la persona',
          'nombre cumpleanero',
          'nombre',
        ]);
        const hasMessage = !!getCustomField(session, [
          'mensaje',
          'mensaje para el cumpleañero',
          'mensaje para el cumpleanero',
        ]);

        if (hasRecipientEmail || hasRecipientName || hasMessage) {
          console.log('🎯 Gift flag por custom_fields:', {
            hasRecipientEmail,
            hasRecipientName,
            hasMessage,
            custom_fields: session.custom_fields,
          });
          isGiftCard = true;
        }
      }

      if (!isGiftCard) {
        console.log('ℹ️ Checkout completado pero NO es tarjeta regalo. Ignoramos.', {
          sessionMetadata: session.metadata,
          customFields: session.custom_fields,
        });
        return res.status(200).json({ received: true, ignored: true });
      }
      // ========= FIN DETECCIÓN =========

      // Aquí ya es gift card. Preparamos datos mínimos para Mailchimp:
      const customerEmail =
        session.customer_details?.email ||
        session.customer_email ||
        session.metadata?.recipient_email;

      const amount = session.amount_total; // centavos
      const currency = session.currency;
      const senderName = session.metadata?.sender_name || '';
      const recipientName = session.metadata?.recipient_name || '';
      const message = session.metadata?.message || '';

      // Campos personalizados para Mailchimp
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

      // TODO: aquí envía el email / genera el PDF / guarda en DB / etc.

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

// ========= Funciones auxiliares por REST =========

// Construye cabecera Authorization (Basic) para Mailchimp
function mailchimpHeaders() {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  if (!apiKey) throw new Error('Missing MAILCHIMP_API_KEY');
  const auth = Buffer.from(`anystring:${apiKey}`).toString('base64');
  return {
    'Content-Type': 'application/json',
    Authorization: `Basic ${auth}`,
  };
}

// Crea/actualiza un contacto con merge fields (REST)
async function upsertMailchimpContact({ email, mergeFields }) {
  const server = process.env.MAILCHIMP_SERVER_PREFIX; // ej. 'us1'
  const listId = process.env.MAILCHIMP_AUDIENCE_ID;

  if (!server || !listId || !email) {
    console.warn('⚠️ Faltan datos para Mailchimp (server/listId/email).');
    return;
  }

  const subscriberHash = crypto
    .createHash('md5')
    .update(String(email).toLowerCase())
    .digest('hex');

  const url = `https://${server}.api.mailchimp.com/3.0/lists/${listId}/members/${subscriberHash}`;

  const body = {
    email_address: email,
    status_if_new: 'subscribed', // suscríbelo si es nuevo
    merge_fields: mergeFields,
  };

  const resp = await fetch(url, {
    method: 'PUT',
    headers: mailchimpHeaders(),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error('❌ Mailchimp upsert error:', resp.status, txt);
    throw new Error('Mailchimp upsert failed');
  }

  console.log('✅ Mailchimp upsert OK', email);
}

// Añade una etiqueta 'tarjeta_regalo' al contacto (REST)
async function addMailchimpTag({ email, tagName = 'tarjeta_regalo' }) {
  const server = process.env.MAILCHIMP_SERVER_PREFIX;
  const listId = process.env.MAILCHIMP_AUDIENCE_ID;

  if (!server || !listId || !email) return;

  const subscriberHash = crypto
    .createHash('md5')
    .update(String(email).toLowerCase())
    .digest('hex');

  const url = `https://${server}.api.mailchimp.com/3.0/lists/${listId}/members/${subscriberHash}/tags`;

  const body = {
    tags: [{ name: tagName, status: 'active' }],
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: mailchimpHeaders(),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error('❌ Mailchimp tags error:', resp.status, txt);
  } else {
    console.log('✅ Mailchimp tags OK', tagName);
  }
}

// (Opcional) Hace PUT del contacto + añade etiquetas con REST en dos pasos
async function upsertMailchimpMember({ email, firstName = '', lastName = '', tags = [] }) {
  const server = process.env.MAILCHIMP_SERVER_PREFIX;
  const listId = process.env.MAILCHIMP_AUDIENCE_ID;

  if (!server || !listId || !email) return;

  const memberHash = crypto
    .createHash('md5')
    .update(String(email).toLowerCase())
    .digest('hex');

  // 1️⃣ Crear o actualizar el contacto
  const putUrl = `https://${server}.api.mailchimp.com/3.0/lists/${listId}/members/${memberHash}`;
  const putRes = await fetch(putUrl, {
    method: 'PUT',
    headers: mailchimpHeaders(),
    body: JSON.stringify({
      email_address: email,
      status_if_new: 'subscribed',
      merge_fields: { FNAME: firstName, LNAME: lastName },
    }),
  });

  const putJson = await putRes.json().catch(() => ({}));
  console.log('📬 Mailchimp upsert:', putRes.status, putJson.title || putJson.status);

  // 2️⃣ Añadir etiquetas
  if (tags.length) {
    const tagsUrl = `https://${server}.api.mailchimp.com/3.0/lists/${listId}/members/${memberHash}/tags`;
    const tagOps = tags.map((t) => ({ name: t, status: 'active' }));
    const tagRes = await fetch(tagsUrl, {
      method: 'POST',
      headers: mailchimpHeaders(),
      body: JSON.stringify({ tags: tagOps }),
    });
    const tagJson = await tagRes.json().catch(() => ({}));
    console.log('🏷️ Mailchimp tags:', tagRes.status, tagJson);
  }
}
