// api/stripe-webhook.js
import { buffer } from 'micro';
import Stripe from 'stripe';

export const config = { api: { bodyParser: false } }; // Requerido por Stripe

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Firma inválida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('✅ Pago recibido. Session:', session.id);
    // Aquí luego generaremos la tarjeta y enviaremos el email.
  }

  return res.json({ received: true });
}
