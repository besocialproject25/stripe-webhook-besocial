// api/stripe-webhook.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }
  // De momento solo confirmamos recepción.
  return res.status(200).json({ received: true });
}
