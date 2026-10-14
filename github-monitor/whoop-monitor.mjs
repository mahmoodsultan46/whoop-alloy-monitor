import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STATE_PATH = ".monitor-state/whoop-alloy.json";

const env = {
  productName: process.env.PRODUCT_NAME || "WHOOP 5.0 Meridian Band Alloy",
  productUrl:
    process.env.PRODUCT_URL ||
    "https://shop.whoop.com/us/en/products/5-meridian-bands/?sku=810114366714",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
  discordMention: process.env.DISCORD_MENTION || "",
  alertRepeatMinutes: numberFromEnv("ALERT_REPEAT_MINUTES", 60),
  errorAlertRepeatMinutes: numberFromEnv("ERROR_ALERT_REPEAT_MINUTES", 360)
};

if (!env.discordWebhookUrl) {
  throw new Error("Missing DISCORD_WEBHOOK_URL secret.");
}

const startedAt = new Date();
const state = await readState();

try {
  const check = await fetchProductText(env.productUrl);
  const parsed = parseAvailability(check.text);

  const nextState = {
    ...state,
    productName: env.productName,
    productUrl: env.productUrl,
    status: parsed.status,
    available: parsed.available,
    unavailable: parsed.unavailable,
    evidence: parsed.evidence,
    lastHttpStatus: check.status,
    lastError: null
  };

  const shouldAlert = shouldSendAvailabilityAlert(parsed, state, startedAt, env);
  if (shouldAlert) {
    await sendDiscordAvailabilityAlert(env, parsed, check.sourceUrl);
    nextState.lastAvailabilityAlertAt = startedAt.toISOString();
  }

  await writeStateIfChanged(state, nextState);

  console.log(
    JSON.stringify(
      {
        ok: true,
        alerted: shouldAlert,
        status: parsed.status,
        available: parsed.available,
        evidence: parsed.evidence
      },
      null,
      2
    )
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const shouldAlert = shouldSendErrorAlert(state, startedAt, env);
  const nextState = {
    ...state,
    productName: env.productName,
    productUrl: env.productUrl,
    lastError: message
  };

  if (shouldAlert) {
    await sendDiscordErrorAlert(env, message);
    nextState.lastErrorAlertAt = startedAt.toISOString();
  }

  await writeStateIfChanged(state, nextState);
  throw error;
}

async function fetchProductText(productUrl) {
  const sourceUrl = `https://r.jina.ai/${productUrl}`;
  const response = await fetch(sourceUrl, {
    headers: {
      accept: "text/plain",
      "user-agent": "whoop-alloy-github-monitor/1.0"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Fetch failed with HTTP ${response.status}`);
  }

  return {
    sourceUrl,
    status: response.status,
    text
  };
}

function parseAvailability(rawText) {
  const text = String(rawText ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  const productSignals = [
    "meridian band",
    "color 5.0 alloy",
    "pdp_meridian_alloy",
    "810114366714"
  ];

  const availableSignals = ["add to cart", "buy it now"];
  const unavailableSignals = [
    "out of stock",
    "notify me when available",
    "sold out",
    "currently unavailable"
  ];

  const matchingProductSignals = productSignals.filter((signal) => text.includes(signal));
  const matchingAvailableSignals = availableSignals.filter((signal) => text.includes(signal));
  const matchingUnavailableSignals = unavailableSignals.filter((signal) => text.includes(signal));

  const productMatched = matchingProductSignals.length >= 2;
  const unavailable = matchingUnavailableSignals.length > 0;
  const available = productMatched && matchingAvailableSignals.length > 0 && !unavailable;

  let status = "unknown";
  if (productMatched && unavailable) status = "unavailable";
  if (available) status = "available";

  return {
    status,
    available,
    unavailable,
    productMatched,
    evidence: {
      productSignals: matchingProductSignals,
      availableSignals: matchingAvailableSignals,
      unavailableSignals: matchingUnavailableSignals
    }
  };
}

function shouldSendAvailabilityAlert(parsed, state, now, options) {
  if (!parsed.available) return false;
  if (!state?.available) return true;
  return minutesSince(state.lastAvailabilityAlertAt, now) >= options.alertRepeatMinutes;
}

function shouldSendErrorAlert(state, now, options) {
  return minutesSince(state?.lastErrorAlertAt, now) >= options.errorAlertRepeatMinutes;
}

async function sendDiscordAvailabilityAlert(options, parsed, sourceUrl) {
  const mention = options.discordMention ? `${options.discordMention} ` : "";
  const payload = {
    content: `${mention}${options.productName} may be available now: ${options.productUrl}`,
    allowed_mentions: options.discordMention ? { parse: ["users", "roles"] } : { parse: [] },
    embeds: [
      {
        title: "WHOOP Alloy availability alert",
        url: options.productUrl,
        description: `${options.productName} matched buy signals on the product page.`,
        color: 0x2ecc71,
        fields: [
          {
            name: "Status",
            value: parsed.status,
            inline: true
          },
          {
            name: "Buy signals",
            value: parsed.evidence.availableSignals.join(", ") || "none",
            inline: true
          },
          {
            name: "Checked through",
            value: sourceUrl,
            inline: false
          }
        ],
        timestamp: new Date().toISOString()
      }
    ]
  };

  await postDiscord(options.discordWebhookUrl, payload);
}

async function sendDiscordErrorAlert(options, message) {
  const payload = {
    content: `${options.productName} monitor needs attention.`,
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: "Monitor check failed",
        description: message.slice(0, 4000),
        color: 0xe67e22,
        timestamp: new Date().toISOString()
      }
    ]
  };

  await postDiscord(options.discordWebhookUrl, payload);
}

async function postDiscord(webhookUrl, payload) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord webhook failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function writeStateIfChanged(previousState, nextState) {
  if (JSON.stringify(previousState) === JSON.stringify(nextState)) return;
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(nextState, null, 2)}\n`);
}

function minutesSince(isoDate, now) {
  if (!isoDate) return Number.POSITIVE_INFINITY;
  const then = new Date(isoDate);
  if (Number.isNaN(then.getTime())) return Number.POSITIVE_INFINITY;
  return (now.getTime() - then.getTime()) / 60000;
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}
