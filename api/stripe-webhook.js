// api/stripe-webhook.js
import Stripe from 'stripe';

// Necesario para que Stripe lea bien el cuerpo
export const config = {
  api: { bodyParser: false },
};

// Creamos el cliente Stripe con tu clave secreta
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// Función para leer el "cuerpo" de la petición
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  // Si abres la URL en el navegador, te responderá con "OK"
  if (req.method !== 'POST') return res.status(200).send('OK');

  const sig = req.headers['stripe-signature'];

  try {
    const rawBody = await getRawBody(req);
    const event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('✅ Pago recibido. Session:', session.id);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
}

