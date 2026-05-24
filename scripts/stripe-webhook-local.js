const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const dotenv = require("dotenv");

const rootDir = path.resolve(__dirname, "..");
const envFileName = process.env.ENV_FILE || ".env.local";
const envPath = path.resolve(rootDir, envFileName);
const webhookPath = "/baseurl/api/v1/stripe/webhook";

const fail = (message) => {
  console.error(`Stripe webhook local: ${message}`);
  process.exit(1);
};

if (!fs.existsSync(envPath)) {
  fail(`fichier ${envFileName} introuvable.`);
}

const envContent = fs.readFileSync(envPath, "utf8");
const parsedEnv = dotenv.parse(envContent);
const env = { ...parsedEnv, ...process.env };
const stripeApiKey = env.STRIPE_API_KEY || env.STRIPE_SECRET_KEY;
const port = env.PORT || "5005";
const forwardTo =
  env.STRIPE_WEBHOOK_FORWARD_TO ||
  `host.docker.internal:${port}${webhookPath}`;

if (!stripeApiKey) {
  fail(`STRIPE_SECRET_KEY est manquant dans ${envFileName}.`);
}

const dockerBaseArgs = [
  "run",
  "--rm",
  "-e",
  `STRIPE_API_KEY=${stripeApiKey}`,
  "stripe/stripe-cli",
];

const extractWebhookSecret = (output) => {
  const match = output.match(/whsec_[A-Za-z0-9_]+/);
  return match ? match[0] : null;
};

const upsertEnvValue = (content, key, value) => {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${escapedKey}=.*$`, "m");

  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }

  const suffix = content.endsWith("\n") ? "" : newline;
  return `${content}${suffix}${line}${newline}`;
};

console.log(`Stripe webhook local: endpoint ${forwardTo}`);
console.log(`Stripe webhook local: synchronisation de STRIPE_WEBHOOK_SECRET...`);

const secretResult = spawnSync(
  "docker",
  [...dockerBaseArgs, "listen", "--forward-to", forwardTo, "--print-secret"],
  { cwd: rootDir, encoding: "utf8" },
);

if (secretResult.error) {
  fail(`Docker est introuvable ou indisponible: ${secretResult.error.message}`);
}

if (secretResult.status !== 0) {
  const output = `${secretResult.stdout || ""}${secretResult.stderr || ""}`.trim();
  fail(output || "impossible de récupérer le secret webhook Stripe.");
}

const webhookSecret = extractWebhookSecret(
  `${secretResult.stdout || ""}${secretResult.stderr || ""}`,
);

if (!webhookSecret) {
  fail("la Stripe CLI n'a pas renvoyé de secret whsec.");
}

const nextEnvContent = upsertEnvValue(
  envContent,
  "STRIPE_WEBHOOK_SECRET",
  webhookSecret,
);

if (nextEnvContent !== envContent) {
  fs.writeFileSync(envPath, nextEnvContent, "utf8");
  console.log(
    `Stripe webhook local: ${envFileName} mis à jour avec STRIPE_WEBHOOK_SECRET.`,
  );
  console.log(
    "Stripe webhook local: redémarre le backend s'il était déjà lancé.",
  );
} else {
  console.log(`Stripe webhook local: STRIPE_WEBHOOK_SECRET déjà à jour.`);
}

console.log("Stripe webhook local: écoute des événements Stripe...");

const listener = spawn(
  "docker",
  [...dockerBaseArgs, "listen", "--forward-to", forwardTo],
  { cwd: rootDir, stdio: "inherit" },
);

listener.on("error", (error) => {
  fail(`impossible de lancer Docker: ${error.message}`);
});

listener.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code || 0);
});
