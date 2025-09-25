// /api/stripe-webhook.js
// Node serverless function (Vercel). CommonJS.

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2022-11-15',
});

// Para Vercel: necesitamos el RAW body para verificar la firma.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // 1) Leer rawBody
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks);

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌  Error verifying Stripe signature:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // 2) Solo nos interesa checkout.session.completed
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // Cargamos la sesión con sus line_items y expandimos el producto.
      const sessionWithItems = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['line_items.data.price.product'],
      });

      const lineItems = sessionWithItems?.line_items?.data || [];

      // 3) ¿Alguna línea es gift_card?
      const giftCardItems = lineItems.filter((item) => {
        const product = item?.price?.product;
        // producto está expandido → es un objeto
        const metadata = product && typeof product === 'object' ? product.metadata : {};
        return metadata && metadata.type === 'gift_card';
      });

      if (giftCardItems.length > 0) {
        console.log(`🎁 Se han comprado ${giftCardItems.length} gift card(s)`);

        // Datos del comprador/receptor
        const buyerEmail = session.customer_details?.email || session.customer_email;
        // Si usas Custom Fields en Payment Links, vendrían en session.custom_fields
        // Si guardas info adicional en session.metadata, también puedes leerla aquí.

        // 4) Generamos un código de regalo por cada ítem.
        for (const item of giftCardItems) {
          const qty = item.quantity || 1;
          for (let i = 0; i < qty; i++) {
            const code = generateGiftCode(); // Ej: BESP-ABCD-1234
            // (Opcional) Guardar el código en tu BD/Sheet/Notion/Supabase, etc.
            console.log('Código generado:', code);

            // 5) Enviar email (sustituye esta función por tu proveedor real)
            await sendGiftCardEmail({
              to: buyerEmail,
              code,
              amount: (item.amount_total || 0) / 100, // si quieres monto por ítem
              currency: item.currency || session.currency,
            });
          }
        }
      } else {
        console.log('✅ sesión completada sin gift cards.');
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('❌  Error en el manejador del webhook:', err);
    res.status(500).send('Internal Server Error');
  }
};

// ---- utilidades ----

function generateGiftCode() {
  // Sencillo: BESP-XXXX-XXXX (puedes usar nanoid/uuid si prefieres)
  const block = () => Math.random().toString(36).toUpperCase().slice(2, 6);
  return `BESP-${block()}-${block()}`;
}

// Ejemplo: envia un email “falso”. Sustituye por tu proveedor real (Resend/SendGrid/etc)
async function sendGiftCardEmail({ to, code, amount, currency }) {
  if (!to) {
    console.log('⚠️  No email in session; skipping email send.');
    return;
  }

  // Ejemplo con console.log. Sustituye con tu implementación real:
  // - Resend: https://resend.com/docs/api-reference/emails/send
  // - SendGrid: https://docs.sendgrid.com/api-reference/mail-send/mail-send
  // - Mailchimp Transactional (Mandrill)
  console.log(`📧 Enviar email a ${to} con código: ${code} - ${amount || ''} ${currency || ''}`);
}
