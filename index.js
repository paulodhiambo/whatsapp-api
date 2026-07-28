require("dotenv").config();
const crypto  = require("crypto");
const express = require("express");
const { webhookHandler } = require("./services/webhook");

const app = express();
app.disable("x-powered-by");

// Capture raw body so signature verification can HMAC the exact bytes Meta signed.
app.use(express.json({
    limit: "128kb",
    verify: (req, _res, buf) => { req.rawBody = buf; },
}));

const PORT         = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN?.trim();
const APP_SECRET   = process.env.APP_SECRET?.trim();

if (!VERIFY_TOKEN) {
    console.warn("⚠️  VERIFY_TOKEN is not set. Webhook verification is disabled.");
}
if (!APP_SECRET) {
    console.warn("⚠️  APP_SECRET is not set. Request signature verification is disabled.");
}

console.log(`[BOOT] App started. node=${process.version}`);

// Verify X-Hub-Signature-256 that Meta attaches to every webhook POST.
// Rejects any request whose body was not signed with the app secret.
function verifyWhatsAppSignature(req, res, next) {
    if (!APP_SECRET) return next(); // warn-only when secret is absent

    const signature = req.headers["x-hub-signature-256"];
    if (!signature) {
        return res.status(401).send("Missing signature");
    }

    const expected = "sha256=" + crypto
        .createHmac("sha256", APP_SECRET)
        .update(req.rawBody)
        .digest("hex");

    // timingSafeEqual requires same-length Buffers
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    const valid  = sigBuf.length === expBuf.length &&
                   crypto.timingSafeEqual(sigBuf, expBuf);

    if (!valid) {
        console.warn("⚠️  Invalid webhook signature — request rejected");
        return res.status(401).send("Invalid signature");
    }
    next();
}

app.get("/", (_req, res) => {
    return res.status(200).send("WhatsApp Webhook Middleware is running");
});

app.get(["/favicon.ico", "/favicon.png"], (_req, res) => {
    return res.status(204).end();
});

app.get("/webhook", (req, res) => {
    const mode      = req.query["hub.mode"] || req.query["hub_mode"];
    const token     = req.query["hub.verify_token"] || req.query["hub_verify_token"];
    const challenge = req.query["hub.challenge"] || req.query["hub_challenge"];

    console.log(`[WEBHOOK_VERIFY] Incoming token: ${JSON.stringify(token)} (length: ${token?.length}), Server VERIFY_TOKEN: ${JSON.stringify(VERIFY_TOKEN)} (length: ${VERIFY_TOKEN?.length})`);

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    return res.status(403).send("Verification failed");
});

app.post("/webhook", verifyWhatsAppSignature, webhookHandler);

app.listen(PORT, () => {
    console.log(`Middleware running on port ${PORT}`);
});

module.exports = app;
