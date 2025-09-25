// api/stripe-webhook.js
import Stripe from "stripe";

export const config = { api: { bodyParser: false } };

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("OK");

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("❌ Falta STRIPE_WEBHOOK_SECRET en el runtime");
    return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_dummy");
  const sig = req.headers["stripe-signature"];
  const buf = await buffer(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, secret);
  } catch (err) {
    console.error("❌ Firma inválida:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      console.log("✅ Checkout completado:", event.data.object.id);
    }
    return res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Error manejando evento:", err);
    return res.status(500).send("server error");
  }
}

