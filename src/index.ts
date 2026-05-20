import crypto from "crypto";
import express, { Request, Response } from "express";
import { config } from "./config";
import {
  activateBitrixConnector,
  answerBitrixOpenLineChat,
  bindBitrixConnectorEvents,
  getBitrixOpenLineHistory,
  getBitrixConnectorStatus,
  normalizeSmsParticipantId,
  registerBitrixConnector,
  sendBitrixDeliveryStatus,
  sendSmsThroughTelnyx,
  sendToBitrixOpenChannel
} from "./clients";
import { initializeDatabase } from "./database";
import {
  forwardTelnyxWebhookRecord,
  listTelnyxWebhookRecords,
  saveTelnyxWebhookRecord,
  TelnyxWebhookRecord
} from "./telnyxWebhookStore";
import { writeBitrixTokens } from "./tokenStore";
import { BitrixInstallRequest, BitrixOutboundEvent, TelnyxWebhook } from "./types";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});

const processedTelnyxEvents = new Set<string>();
const processedBitrixMessageIds = new Set<string>();
const phoneByChatId = new Map<string, string>();
const phoneByUserId = new Map<string, string>();
let lastBitrixSession: { sessionId?: string | number; chatId?: string | number } = {};

function isDuplicate(set: Set<string>, key: string): boolean {
  if (set.has(key)) {
    return true;
  }
  set.add(key);
  if (set.size > 5000) {
    const first = set.values().next().value;
    if (first) {
      set.delete(first);
    }
  }
  return false;
}

function verifyBitrixSecret(req: Request): boolean {
  if (!config.bitrixOutboundSecret) {
    return true;
  }
  const incoming = String(req.headers["x-bitrix-secret"] ?? "");
  return incoming === config.bitrixOutboundSecret;
}

function verifyTelnyxSignature(req: Request): boolean {
  if (!config.telnyxSignatureSecret) {
    return true;
  }

  const signature = String(req.headers["telnyx-signature-ed25519"] ?? "");
  const timestamp = String(req.headers["telnyx-timestamp"] ?? "");
  if (!signature || !timestamp) {
    return false;
  }

  try {
    const payloadString = JSON.stringify(req.body);
    const message = timestamp + payloadString;
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(config.telnyxSignatureSecret, "base64"),
      format: "der",
      type: "spki"
    });

    return crypto.verify(
      undefined,
      Buffer.from(message),
      publicKey,
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

function trimMap(map: Map<string, string>, maxEntries = 5000): void {
  if (map.size <= maxEntries) {
    return;
  }

  const first = map.keys().next().value;
  if (first) {
    map.delete(first);
  }
}

function buildChatId(phone: string): string {
  return normalizeSmsParticipantId(phone);
}

function phoneFromChatId(chatId: string): string {
  for (const [knownChatId, phone] of phoneByChatId.entries()) {
    if (knownChatId === chatId) {
      return phone;
    }
  }

  return "";
}

function parsePhoneFromParticipantId(value: string): string {
  if (!value) {
    return "";
  }

  const directDigits = value.match(/^sms_(\d{8,15})$/i);
  if (directDigits?.[1]) {
    return `+${directDigits[1]}`;
  }

  const anyDigits = value.replace(/\D/g, "");
  if (anyDigits.length >= 8) {
    return `+${anyDigits}`;
  }

  return "";
}

function cleanBitrixMessageText(text: string): string {
  const cleaned = text
    .replace(/\[br\]/gi, "\n")
    .replace(/\[\/?b\]/gi, "")
    .trim();

  return cleaned.replace(/^[^\n:]{1,80}:\s*\n/, "").trim();
}

function readTelnyxPhone(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return readTelnyxPhone(value[0]);
  }

  if (value && typeof value === "object") {
    const candidate = (value as Record<string, unknown>).phone_number;
    return typeof candidate === "string" ? candidate : "";
  }

  return "";
}

function getTelnyxEventChannel(eventType: string): TelnyxWebhookRecord["eventChannel"] {
  if (eventType === "message.received" || eventType.startsWith("message.")) {
    return "sms";
  }

  if (eventType.startsWith("call.")) {
    return "call";
  }

  return "other";
}

function createTelnyxWebhookRecord(body: TelnyxWebhook | Record<string, unknown>): TelnyxWebhookRecord {
  const eventType =
    body && typeof body === "object" && "data" in body
      ? ((body as TelnyxWebhook).data?.event_type ?? "")
      : "";
  const eventId =
    body && typeof body === "object" && "data" in body
      ? ((body as TelnyxWebhook).data?.id ?? "")
      : "";
  const payload =
    body && typeof body === "object" && "data" in body
      ? (body as TelnyxWebhook).data?.payload
      : undefined;

  return {
    id: eventId || `telnyx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    eventId,
    eventType,
    eventChannel: getTelnyxEventChannel(eventType),
    receivedAt: new Date().toISOString(),
    from: readTelnyxPhone(payload?.from),
    to: readTelnyxPhone(payload?.to),
    text: payload?.text ?? "",
    status: "ignored",
    rawBody: body
  };
}

async function persistTelnyxWebhookRecord(record: TelnyxWebhookRecord): Promise<void> {
  record.outboundForward = await forwardTelnyxWebhookRecord(record);
  await saveTelnyxWebhookRecord(record);

  const outboundForward = record.outboundForward;
  if (outboundForward && outboundForward.enabled && !outboundForward.delivered) {
    console.error("Failed to forward stored Telnyx webhook to outbound webhook", outboundForward);
  }
}

function rememberBitrixSession(response: Awaited<ReturnType<typeof sendToBitrixOpenChannel>>) {
  const session = response.result?.DATA?.RESULT?.[0]?.session;
  if (!session?.ID && !session?.CHAT_ID) {
    return;
  }

  lastBitrixSession = {
    sessionId: session.ID,
    chatId: session.CHAT_ID
  };
}

async function answerBitrixSessionIfPossible(
  response: Awaited<ReturnType<typeof sendToBitrixOpenChannel>>
) {
  const chatId = response.result?.DATA?.RESULT?.[0]?.session?.CHAT_ID;
  if (!chatId) {
    return null;
  }

  try {
    return await answerBitrixOpenLineChat(chatId);
  } catch (error) {
    console.error("Failed to take Bitrix Open Line dialog", error);
    return null;
  }
}

function readBodyValue(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value ? value : undefined;
}

function readNestedAuthValue(body: Record<string, unknown>, key: string): string | undefined {
  const auth = body.auth;
  if (auth && typeof auth === "object" && !Array.isArray(auth)) {
    const value = (auth as Record<string, unknown>)[key];
    return typeof value === "string" && value ? value : undefined;
  }

  return readBodyValue(body, `auth[${key}]`);
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

function storeBitrixInstallAuth(body: BitrixInstallRequest) {
  const rawBody = body as Record<string, unknown>;
  const accessToken =
    readNestedAuthValue(rawBody, "access_token") ??
    readNestedAuthValue(rawBody, "AUTH_ID") ??
    body.AUTH_ID;
  const refreshToken =
    readNestedAuthValue(rawBody, "refresh_token") ??
    readNestedAuthValue(rawBody, "REFRESH_ID") ??
    body.REFRESH_ID;
  const clientEndpoint =
    readNestedAuthValue(rawBody, "client_endpoint") ??
    readNestedAuthValue(rawBody, "CLIENT_ENDPOINT") ??
    body.CLIENT_ENDPOINT;
  const serverEndpoint =
    readNestedAuthValue(rawBody, "server_endpoint") ??
    readNestedAuthValue(rawBody, "SERVER_ENDPOINT") ??
    body.SERVER_ENDPOINT ??
    "https://oauth.bitrix.info/rest/";
  const expiresIn =
    Number(readNestedAuthValue(rawBody, "expires_in") ?? body.expires_in ?? body.expires ?? 3600);

  if (!accessToken || !refreshToken || !clientEndpoint) {
    console.error("Bitrix install callback missing auth fields", {
      bodyKeys: Object.keys(rawBody),
      authKeys:
        rawBody.auth && typeof rawBody.auth === "object" && !Array.isArray(rawBody.auth)
          ? Object.keys(rawBody.auth as Record<string, unknown>)
          : []
    });
    throw new Error("Missing Bitrix OAuth fields in install callback.");
  }

  writeBitrixTokens({
    accessToken,
    refreshToken,
    clientEndpoint,
    serverEndpoint,
    domain: readNestedAuthValue(rawBody, "domain") ?? body.DOMAIN,
    memberId: readNestedAuthValue(rawBody, "member_id") ?? body.member_id,
    expiresAt: Date.now() + expiresIn * 1000,
    applicationToken: readNestedAuthValue(rawBody, "application_token") ?? body.APPLICATION_TOKEN
  });
}

app.all("/bitrix/install", async (req: Request, res: Response) => {
  try {
    storeBitrixInstallAuth(req.body as BitrixInstallRequest);
    const register = await registerBitrixConnector();
    const activate = await activateBitrixConnector();
    const eventBind = await bindBitrixConnectorEvents();
    const status = await getBitrixConnectorStatus();

    return res.status(200).send(`
      <html>
        <body style="font-family: sans-serif;">
          <h2>Telnyx SMS connector installed</h2>
          <p>Connector registered and activated for line ${config.bitrixLineId}.</p>
          <pre>${JSON.stringify({ register, activate, eventBind, status }, null, 2)}</pre>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Bitrix install failed", error);
    return res.status(500).send("Bitrix install failed. Check middleware logs.");
  }
});

app.get("/bitrix/connector/settings", (_req, res) => {
  res.status(200).send(`
    <html>
      <body style="font-family: sans-serif;">
        <h2>Telnyx SMS</h2>
        <p>This connector is handled by the Telnyx middleware.</p>
      </body>
    </html>
  `);
});

app.post("/bitrix/connector/register", async (_req: Request, res: Response) => {
  try {
    const register = await registerBitrixConnector();
    const activate = await activateBitrixConnector();
    const eventBind = await bindBitrixConnectorEvents();
    const status = await getBitrixConnectorStatus();
    return res.status(200).json({ ok: true, register, activate, eventBind, status });
  } catch (error) {
    console.error("Failed to register Bitrix connector", error);
    return res.status(500).json({ ok: false, error: "Bitrix connector registration failed" });
  }
});

app.get("/bitrix/connector/status", async (_req: Request, res: Response) => {
  try {
    const status = await getBitrixConnectorStatus();
    return res.status(200).json({ ok: true, status });
  } catch (error) {
    console.error("Failed to read Bitrix connector status", error);
    return res.status(500).json({ ok: false, error: "Bitrix connector status failed" });
  }
});

app.get("/debug/bitrix/latest-history", async (_req: Request, res: Response) => {
  if (!lastBitrixSession.sessionId && !lastBitrixSession.chatId) {
    return res.status(404).json({ ok: false, error: "No Bitrix session seen yet" });
  }

  try {
    const history = await getBitrixOpenLineHistory(lastBitrixSession);
    return res.status(200).json({ ok: true, session: lastBitrixSession, history });
  } catch (error) {
    console.error("Failed to read latest Bitrix history", error);
    return res.status(500).json({ ok: false, error: "Bitrix history failed" });
  }
});

app.get("/debug/telnyx/webhooks", async (req: Request, res: Response) => {
  const rawLimit = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
  try {
    return res.status(200).json({ ok: true, records: await listTelnyxWebhookRecords(limit) });
  } catch (error) {
    console.error("Failed to read stored Telnyx webhooks", error);
    return res.status(500).json({ ok: false, error: "Telnyx webhook history failed" });
  }
});

app.post("/sms/send", async (req: Request, res: Response) => {
  const { to, text } = req.body as { to?: string; text?: string };

  if (!to || !text) {
    return res.status(400).json({ ok: false, error: "Missing to or text" });
  }

  try {
    const telnyxResponse = await sendSmsThroughTelnyx({ to, text });
    return res.status(200).json({ ok: true, telnyx: telnyxResponse });
  } catch (error) {
    console.error("Failed to send manual SMS through Telnyx", error);
    return res.status(500).json({ ok: false, error: "SMS send failed" });
  }
});

app.post("/debug/bitrix/test-message", async (req: Request, res: Response) => {
  const {
    from = "+15550001111",
    to = config.telnyxFromNumber,
    text = "Test SMS into Bitrix"
  } = req.body as { from?: string; to?: string; text?: string };

  try {
    const bitrixResponse = await sendToBitrixOpenChannel({
      sourcePhone: from,
      destinationPhone: to,
      text,
      externalMessageId: `debug-${Date.now()}`,
      eventTimestamp: new Date().toISOString()
    });
    rememberBitrixSession(bitrixResponse);
    const answer = await answerBitrixSessionIfPossible(bitrixResponse);

    return res.status(200).json({ ok: true, bitrix: bitrixResponse, answer });
  } catch (error) {
    console.error("Failed to send debug Bitrix message", error);
    return res.status(500).json({ ok: false, error: "Debug Bitrix send failed" });
  }
});

app.post("/webhooks/telnyx", async (req: Request, res: Response) => {
  const body = req.body as TelnyxWebhook;
  const record = createTelnyxWebhookRecord(body);

  if (!verifyTelnyxSignature(req)) {
    record.status = "invalid_signature";
    await persistTelnyxWebhookRecord(record);
    return res.status(401).json({ ok: false, error: "Invalid Telnyx signature" });
  }

  const eventType = body.data?.event_type;
  if (!eventType) {
    record.status = "invalid_payload";
    await persistTelnyxWebhookRecord(record);
    return res.status(400).json({ ok: false, error: "Missing event type" });
  }

  if (record.eventChannel === "call") {
    record.status = "stored_call_event";
    await persistTelnyxWebhookRecord(record);

    if (record.outboundForward?.enabled) {
      record.status = record.outboundForward.delivered ? "forwarded_call_event" : "call_forward_failed";
      await saveTelnyxWebhookRecord(record);
    }

    return res.status(200).json({
      ok: true,
      callEvent: true,
      forwarded: Boolean(record.outboundForward?.enabled && record.outboundForward.delivered)
    });
  }

  if (eventType !== "message.received") {
    record.status = "ignored";
    await persistTelnyxWebhookRecord(record);
    return res.status(200).json({ ok: true, ignored: true });
  }

  const eventId = body.data?.id ?? "";
  if (!eventId) {
    record.status = "invalid_payload";
    await persistTelnyxWebhookRecord(record);
    return res.status(400).json({ ok: false, error: "Missing event id" });
  }
  if (isDuplicate(processedTelnyxEvents, eventId)) {
    record.status = "duplicate";
    await persistTelnyxWebhookRecord(record);
    return res.status(200).json({ ok: true, duplicate: true });
  }

  const payload = body.data?.payload;
  const messageId = payload?.id ?? eventId;
  const text = payload?.text ?? "";
  const from = readTelnyxPhone(payload?.from);
  const to = readTelnyxPhone(payload?.to) || config.telnyxFromNumber;

  if (!from || !text) {
    record.status = "invalid_payload";
    await persistTelnyxWebhookRecord(record);
    return res.status(400).json({ ok: false, error: "Missing from or text" });
  }

  try {
    const chatId = buildChatId(from);
    phoneByChatId.set(chatId, from);
    phoneByUserId.set(chatId, from);
    trimMap(phoneByChatId);
    trimMap(phoneByUserId);

    const bitrixResponse = await sendToBitrixOpenChannel({
      sourcePhone: from,
      destinationPhone: to,
      text,
      externalMessageId: messageId,
      eventTimestamp: payload?.received_at
    });
    rememberBitrixSession(bitrixResponse);
    await answerBitrixSessionIfPossible(bitrixResponse);

    record.status = "forwarded_to_bitrix";
    record.bitrix = { ok: true };
    await persistTelnyxWebhookRecord(record);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Failed to forward Telnyx inbound message", error);
    record.status = "bitrix_failed";
    record.bitrix = {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown Bitrix forwarding error"
    };
    await persistTelnyxWebhookRecord(record);
    return res.status(500).json({ ok: false, error: "Forwarding failed" });
  }
});

app.post("/webhooks/bitrix", async (req: Request, res: Response) => {
  if (!verifyBitrixSecret(req)) {
    return res.status(401).json({ ok: false, error: "Invalid Bitrix secret" });
  }

  const event = req.body as BitrixOutboundEvent;

  if (event.event?.toUpperCase() !== "ONIMCONNECTORMESSAGEADD") {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const messages = event.data?.MESSAGES ?? (event.data as Record<string, unknown> | undefined)?.messages;
  const message =
    Array.isArray(messages) && messages.length > 0
      ? (messages[0] as Record<string, unknown>)
      : undefined;
  const messageData = (message?.message as Record<string, unknown> | undefined) ??
    ((message as Record<string, unknown> | undefined)?.MESSAGE as Record<string, unknown> | undefined);
  const chatData = (message?.chat as Record<string, unknown> | undefined) ??
    ((message as Record<string, unknown> | undefined)?.CHAT as Record<string, unknown> | undefined);
  const userData = (message?.user as Record<string, unknown> | undefined) ??
    ((message as Record<string, unknown> | undefined)?.USER as Record<string, unknown> | undefined);
  const senderData = (message?.sender as Record<string, unknown> | undefined) ??
    ((message as Record<string, unknown> | undefined)?.SENDER as Record<string, unknown> | undefined);
  const extraData = (message?.extra as Record<string, unknown> | undefined) ??
    ((message as Record<string, unknown> | undefined)?.EXTRA as Record<string, unknown> | undefined);
  const imData = (message?.im as Record<string, unknown> | undefined) ??
    ((message as Record<string, unknown> | undefined)?.IM as Record<string, unknown> | undefined);

  const text = cleanBitrixMessageText(String(messageData?.text ?? messageData?.TEXT ?? ""));
  const messageId = String(messageData?.id ?? messageData?.ID ?? imData?.message_id ?? imData?.MESSAGE_ID ?? "");
  const chatId = String(chatData?.id ?? chatData?.ID ?? "");
  const bitrixUserId = String(userData?.id ?? userData?.ID ?? senderData?.id ?? senderData?.ID ?? "");
  const extraFrom = String(extraData?.from ?? extraData?.FROM ?? "");
  const phone =
    phoneByChatId.get(chatId) ??
    phoneByUserId.get(bitrixUserId) ??
    (extraFrom || undefined) ??
    (parsePhoneFromParticipantId(chatId) || undefined) ??
    (parsePhoneFromParticipantId(bitrixUserId) || undefined) ??
    phoneFromChatId(chatId);

  if (!messageId || !phone || !text) {
    console.warn("Bitrix webhook missing message fields", {
      hasMessageId: Boolean(messageId),
      hasPhone: Boolean(phone),
      hasText: Boolean(text),
      event: event.event,
      chatId,
      bitrixUserId,
      bodyKeys: Object.keys(req.body ?? {})
    });
    return res.status(400).json({ ok: false, error: "Missing message fields" });
  }

  if (isDuplicate(processedBitrixMessageIds, messageId)) {
    return res.status(200).json({ ok: true, duplicate: true });
  }

  try {
    const telnyxResponse = await sendSmsThroughTelnyx({
      to: phone,
      text
    });

    const telnyxMessageId =
      typeof telnyxResponse?.data?.id === "string"
        ? telnyxResponse.data.id
        : `bitrix-${messageId}`;

    const imChatIdRaw = imData?.chat_id ?? imData?.CHAT_ID;
    const imMessageIdRaw = imData?.message_id ?? imData?.MESSAGE_ID;
    if (imChatIdRaw && imMessageIdRaw && chatId) {
      await sendBitrixDeliveryStatus({
        imChatId: Number(imChatIdRaw),
        imMessageId: Number(imMessageIdRaw),
        externalMessageId: telnyxMessageId,
        chatId
      });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Failed to send outbound SMS through Telnyx", error);
    return res.status(500).json({ ok: false, error: "Outbound failed" });
  }
});

async function startServer() {
  await initializeDatabase();

  app.listen(config.port, () => {
    console.log(`Telnyx-Bitrix middleware listening on port ${config.port}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start middleware", error);
  process.exit(1);
});
