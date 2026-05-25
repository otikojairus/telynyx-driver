import crypto from "crypto";
import express, { Request, Response } from "express";
import { config } from "./config";
import { forwardBitrixDealRecord, saveBitrixDealRecord } from "./bitrixDealStore";
import {
  activateBitrixConnector,
  answerBitrixOpenLineChat,
  bindBitrixDealEvents,
  bindBitrixLeadEvents,
  bindBitrixConnectorEvents,
  getBitrixContactById,
  listBitrixDealCategories,
  listBitrixStatuses,
  getBitrixDealById,
  getBitrixLeadById,
  getBitrixOpenLineHistory,
  getBitrixConnectorStatus,
  normalizeSmsParticipantId,
  registerBitrixConnector,
  sendBitrixDeliveryStatus,
  sendSmsThroughTelnyx,
  sendToBitrixOpenChannel,
  updateBitrixDealStage
} from "./clients";
import { initializeDatabase } from "./database";
import {
  forwardTelnyxWebhookRecord,
  listTelnyxWebhookRecords,
  saveTelnyxWebhookRecord,
  TelnyxWebhookRecord
} from "./telnyxWebhookStore";
import { canSendEmail, sendLeadConfirmationEmail } from "./notifications";
import { writeBitrixTokens } from "./tokenStore";
import { BitrixDealEvent, BitrixInstallRequest, BitrixLeadEvent, BitrixOutboundEvent, TelnyxWebhook } from "./types";

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
const recentBitrixReplyWebhooks: Array<{
  receivedAt: string;
  status: "received" | "ignored" | "missing_fields" | "duplicate" | "sent" | "failed";
  event?: string;
  messageId?: string;
  chatId?: string;
  bitrixUserId?: string;
  phone?: string;
  text?: string;
  body: unknown;
  error?: string;
}> = [];
const recentBitrixDealEvents: Array<{
  receivedAt: string;
  event: string;
  dealId: string;
  stageId: string;
  classification: "deal_created" | "stage_changed" | "quote_approved" | "quote_declined" | "closed_won_paid";
  body: BitrixDealEvent;
}> = [];

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

function verifyInboundDealSecret(req: Request): boolean {
  if (!config.inboundDealWebhookSecret) {
    return true;
  }
  const incoming = String(req.headers["x-inbound-secret"] ?? "");
  return incoming === config.inboundDealWebhookSecret;
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

function rememberBitrixDealEvent(event: {
  receivedAt: string;
  event: string;
  dealId: string;
  stageId: string;
  classification: "deal_created" | "stage_changed" | "quote_approved" | "quote_declined" | "closed_won_paid";
  body: BitrixDealEvent;
}): void {
  recentBitrixDealEvents.unshift(event);
  if (recentBitrixDealEvents.length > 200) {
    recentBitrixDealEvents.length = 200;
  }
}

function rememberBitrixReplyWebhook(record: {
  status: "received" | "ignored" | "missing_fields" | "duplicate" | "sent" | "failed";
  event?: string;
  messageId?: string;
  chatId?: string;
  bitrixUserId?: string;
  phone?: string;
  text?: string;
  body: unknown;
  error?: string;
}): void {
  recentBitrixReplyWebhooks.unshift({
    receivedAt: new Date().toISOString(),
    ...record
  });

  if (recentBitrixReplyWebhooks.length > 50) {
    recentBitrixReplyWebhooks.length = 50;
  }
}

function classifyDealEvent(eventName: string, stageId: string): "deal_created" | "stage_changed" | "quote_approved" | "quote_declined" | "closed_won_paid" {
  const normalizedStage = stageId.toUpperCase();
  if (eventName === "ONCRMDEALADD") {
    return "deal_created";
  }

  if (
    normalizedStage === "CLOSED_WON_PAID" ||
    (normalizedStage.includes("WON") && normalizedStage.includes("PAID"))
  ) {
    return "closed_won_paid";
  }

  if (
    normalizedStage.includes("DECLIN") ||
    normalizedStage.includes("REJECT") ||
    normalizedStage.includes("LOSE")
  ) {
    return "quote_declined";
  }

  if (
    normalizedStage.includes("APPROV") ||
    normalizedStage.includes("ACCEPT") ||
    normalizedStage.includes("QUOTE_APPROVED")
  ) {
    return "quote_approved";
  }

  return "stage_changed";
}

function readLeadContactValue(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (Array.isArray(value) && value.length > 0) {
    const first = value[0] as Record<string, unknown>;
    const nested = first?.VALUE;
    return typeof nested === "string" ? nested.trim() : "";
  }

  return "";
}

function normalizePhoneForSms(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("+")) {
    return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  }

  const digits = trimmed.replace(/\D/g, "");
  if (!digits) {
    return "";
  }

  return `+${digits}`;
}

function buildLeadCustomerName(lead: Record<string, unknown>): string {
  const firstName = String(lead.NAME ?? "").trim();
  const lastName = String(lead.LAST_NAME ?? "").trim();
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (fullName) {
    return fullName;
  }

  const title = String(lead.TITLE ?? "").trim();
  return title || "Customer";
}

function buildLeadServiceType(lead: Record<string, unknown>): string {
  const dynamicFieldValue = lead[config.bitrixLeadServiceField];
  const fromConfiguredField = typeof dynamicFieldValue === "string" ? dynamicFieldValue.trim() : "";
  if (fromConfiguredField) {
    return fromConfiguredField;
  }

  const title = String(lead.TITLE ?? "").trim();
  const sourceDescription = String(lead.SOURCE_DESCRIPTION ?? "").trim();
  return title || sourceDescription || "your service request";
}

function buildLeadConfirmationMessage(name: string, serviceType: string): string {
  return `Hi ${name}, this is PRG confirming your service request for ${serviceType}. A technician will be in touch shortly.`;
}

function buildDealStatusLabel(classification: "deal_created" | "stage_changed" | "quote_approved" | "quote_declined" | "closed_won_paid"): string {
  if (classification === "deal_created") {
    return "we have received your service request";
  }
  if (classification === "quote_approved") {
    return "your quote has been approved";
  }
  if (classification === "quote_declined") {
    return "your quote was declined";
  }
  if (classification === "closed_won_paid") {
    return "your request is confirmed and paid";
  }
  return "your request status has been updated";
}

function buildDealStatusMessage(name: string, serviceType: string, classification: "deal_created" | "stage_changed" | "quote_approved" | "quote_declined" | "closed_won_paid"): string {
  const statusText = buildDealStatusLabel(classification);
  return `Hi ${name}, this is PRG. Update on your service request for ${serviceType}: ${statusText}.`;
}

function readFirstNonEmptyString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
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
    const dealEventBind = await bindBitrixDealEvents();
    const leadEventBind = await bindBitrixLeadEvents();
    const status = await getBitrixConnectorStatus();

    return res.status(200).send(`
      <html>
        <body style="font-family: sans-serif;">
          <h2>Telnyx SMS connector installed</h2>
          <p>Connector registered and activated for line ${config.bitrixLineId}.</p>
          <pre>${JSON.stringify({ register, activate, eventBind, dealEventBind, leadEventBind, status }, null, 2)}</pre>
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
    const dealEventBind = await bindBitrixDealEvents();
    const leadEventBind = await bindBitrixLeadEvents();
    const status = await getBitrixConnectorStatus();
    return res.status(200).json({ ok: true, register, activate, eventBind, dealEventBind, leadEventBind, status });
  } catch (error) {
    console.error("Failed to register Bitrix connector", error);
    return res.status(500).json({ ok: false, error: "Bitrix connector registration failed" });
  }
});

app.post("/bitrix/deals/register", async (_req: Request, res: Response) => {
  try {
    const dealEventBind = await bindBitrixDealEvents();
    return res.status(200).json({ ok: true, dealEventBind });
  } catch (error) {
    console.error("Failed to bind Bitrix deal events", error);
    return res.status(500).json({ ok: false, error: "Bitrix deal event binding failed" });
  }
});

app.post("/bitrix/leads/register", async (_req: Request, res: Response) => {
  try {
    const leadEventBind = await bindBitrixLeadEvents();
    return res.status(200).json({ ok: true, leadEventBind });
  } catch (error) {
    console.error("Failed to bind Bitrix lead events", error);
    return res.status(500).json({ ok: false, error: "Bitrix lead event binding failed" });
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

app.get("/debug/bitrix/deal-events", (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true, events: recentBitrixDealEvents });
});

app.get("/debug/bitrix/reply-webhooks", (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true, events: recentBitrixReplyWebhooks });
});

app.get("/debug/bitrix/deals/stages", async (_req: Request, res: Response) => {
  try {
    const categoriesResponse = await listBitrixDealCategories();
    const categories = (categoriesResponse.result ?? []) as Array<Record<string, unknown>>;

    const defaultStatusesResponse = await listBitrixStatuses({ ENTITY_ID: "DEAL_STAGE" });
    const defaultStages = ((defaultStatusesResponse.result ?? []) as Array<Record<string, unknown>>).map((stage) => ({
      id: String(stage.STATUS_ID ?? ""),
      name: String(stage.NAME ?? ""),
      sort: Number(stage.SORT ?? 0),
      semanticId: String((((stage.EXTRA as Record<string, unknown> | undefined) ?? {}).SEMANTICS ?? stage.SEMANTICS ?? ""))
    }));

    const pipelines = [
      {
        categoryId: 0,
        categoryName: "Default",
        entityId: "DEAL_STAGE",
        stages: defaultStages
      }
    ];

    for (const category of categories) {
      const categoryId = Number(category.ID ?? 0);
      const categoryName = String(category.NAME ?? `Pipeline ${categoryId}`);
      const entityId = `DEAL_STAGE_${categoryId}`;
      const statusesResponse = await listBitrixStatuses({ ENTITY_ID: entityId });
      const stages = ((statusesResponse.result ?? []) as Array<Record<string, unknown>>).map((stage) => ({
        id: String(stage.STATUS_ID ?? ""),
        name: String(stage.NAME ?? ""),
        sort: Number(stage.SORT ?? 0),
        semanticId: String((((stage.EXTRA as Record<string, unknown> | undefined) ?? {}).SEMANTICS ?? stage.SEMANTICS ?? ""))
      }));

      pipelines.push({
        categoryId,
        categoryName,
        entityId,
        stages
      });
    }

    return res.status(200).json({ ok: true, pipelines });
  } catch (error) {
    console.error("Failed to load Bitrix deal stages", error);
    return res.status(500).json({ ok: false, error: "Bitrix deal stages lookup failed" });
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
  console.log("Bitrix reply webhook received", {
    event: event.event,
    bodyKeys: Object.keys(req.body ?? {}),
    dataKeys:
      event.data && typeof event.data === "object"
        ? Object.keys(event.data as Record<string, unknown>)
        : []
  });

  if (event.event?.toUpperCase() !== "ONIMCONNECTORMESSAGEADD") {
    rememberBitrixReplyWebhook({
      status: "ignored",
      event: event.event,
      body: req.body
    });
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

  console.log("Parsed Bitrix reply webhook", {
    event: event.event,
    messageId,
    chatId,
    bitrixUserId,
    phone,
    hasText: Boolean(text)
  });

  if (!messageId || !phone || !text) {
    rememberBitrixReplyWebhook({
      status: "missing_fields",
      event: event.event,
      messageId,
      chatId,
      bitrixUserId,
      phone,
      text,
      body: req.body
    });
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
    rememberBitrixReplyWebhook({
      status: "duplicate",
      event: event.event,
      messageId,
      chatId,
      bitrixUserId,
      phone,
      text,
      body: req.body
    });
    return res.status(200).json({ ok: true, duplicate: true });
  }

  try {
    console.log("Sending Bitrix reply through Telnyx", {
      to: phone,
      messageId,
      text
    });

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

    rememberBitrixReplyWebhook({
      status: "sent",
      event: event.event,
      messageId,
      chatId,
      bitrixUserId,
      phone,
      text,
      body: req.body
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Failed to send outbound SMS through Telnyx", error);
    rememberBitrixReplyWebhook({
      status: "failed",
      event: event.event,
      messageId,
      chatId,
      bitrixUserId,
      phone,
      text,
      body: req.body,
      error: error instanceof Error ? error.message : "Unknown outbound SMS error"
    });
    return res.status(500).json({ ok: false, error: "Outbound failed" });
  }
});

app.post("/webhooks/bitrix/deals", async (req: Request, res: Response) => {
  if (!verifyBitrixSecret(req)) {
    return res.status(401).json({ ok: false, error: "Invalid Bitrix secret" });
  }

  const payload = req.body as BitrixDealEvent;
  const eventName = String(payload.event ?? "").toUpperCase();
  if (eventName !== "ONCRMDEALADD" && eventName !== "ONCRMDEALUPDATE") {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const fields = (payload.data?.FIELDS ?? {}) as Record<string, unknown>;
  const dealIdRaw = payload.data?.ID ?? fields.ID ?? "";
  const stageIdRaw = fields.STAGE_ID ?? "";
  const dealId = String(dealIdRaw || "");
  const stageId = String(stageIdRaw || "");

  if (!dealId) {
    return res.status(400).json({ ok: false, error: "Missing deal id" });
  }

  try {
    const classification = classifyDealEvent(eventName, stageId);
    const receivedAt = new Date().toISOString();
    const dealDetails = {
      jobId: dealId,
      clientName: "",
      phoneNumber: "",
      addressPostalCode: "",
      serviceType: "",
      urgencyLevel: ""
    };
    const eventRecord = {
      receivedAt,
      event: eventName,
      dealId,
      stageId,
      classification,
      body: payload
    };
    rememberBitrixDealEvent(eventRecord);

    const persistentRecord = {
      id: `${eventName}:${dealId}:${receivedAt}`,
      receivedAt,
      eventName,
      dealId,
      stageId,
      classification,
      jobId: dealDetails.jobId,
      clientName: dealDetails.clientName,
      phoneNumber: dealDetails.phoneNumber,
      addressPostalCode: dealDetails.addressPostalCode,
      serviceType: dealDetails.serviceType,
      urgencyLevel: dealDetails.urgencyLevel,
      rawBody: payload
    };

    await saveBitrixDealRecord(persistentRecord);
    const outboundForward = await forwardBitrixDealRecord(persistentRecord);
    if (outboundForward?.enabled) {
      await saveBitrixDealRecord({
        ...persistentRecord,
        outboundForward
      });
    }

    const smsResult: { attempted: boolean; sent: boolean; error?: string } = {
      attempted: false,
      sent: false
    };
    const emailResult: { attempted: boolean; sent: boolean; error?: string } = {
      attempted: false,
      sent: false
    };

    try {
      const dealResponse = await getBitrixDealById(dealId);
      const deal = (dealResponse.result ?? {}) as Record<string, unknown>;
      const contactIdRaw = deal.CONTACT_ID ?? fields.CONTACT_ID ?? "";
      const contactId = String(contactIdRaw || "");
      const serviceType = buildLeadServiceType(deal);
      const urgencyLevel = readFirstNonEmptyString(deal, [
        "UF_CRM_URGENCY_LEVEL",
        "UF_CRM_URGENCY",
        "UF_URGENCY_LEVEL",
        "UF_URGENCY"
      ]);
      const address = readFirstNonEmptyString(deal, [
        "UF_CRM_ADDRESS",
        "ADDRESS",
        "ADDRESS_1",
        "LOCATION"
      ]);
      const postalCode = readFirstNonEmptyString(deal, [
        "UF_CRM_POSTAL_CODE",
        "ADDRESS_POSTAL_CODE",
        "POSTAL_CODE"
      ]);

      dealDetails.serviceType = serviceType;
      dealDetails.urgencyLevel = urgencyLevel;
      dealDetails.addressPostalCode = [address, postalCode].filter(Boolean).join(" / ");

      if (contactId) {
        const contactResponse = await getBitrixContactById(contactId);
        const contact = (contactResponse.result ?? {}) as Record<string, unknown>;
        const customerName = buildLeadCustomerName(contact);
        const customerPhone = normalizePhoneForSms(readLeadContactValue(contact.PHONE));
        const customerEmail = readLeadContactValue(contact.EMAIL);
        const message = buildDealStatusMessage(customerName, serviceType, classification);

        dealDetails.clientName = customerName;
        dealDetails.phoneNumber = customerPhone;
        if (!dealDetails.addressPostalCode) {
          const contactAddress = readFirstNonEmptyString(contact, ["ADDRESS", "ADDRESS_1"]);
          const contactPostalCode = readFirstNonEmptyString(contact, ["ADDRESS_POSTAL_CODE", "POSTAL_CODE"]);
          dealDetails.addressPostalCode = [contactAddress, contactPostalCode].filter(Boolean).join(" / ");
        }

        smsResult.attempted = Boolean(customerPhone);
        emailResult.attempted = Boolean(customerEmail);

        if (customerPhone) {
          try {
            await sendSmsThroughTelnyx({ to: customerPhone, text: message });
            smsResult.sent = true;
          } catch (error) {
            smsResult.error = error instanceof Error ? error.message : "SMS send failed";
          }
        }

        if (customerEmail) {
          if (canSendEmail()) {
            try {
              await sendLeadConfirmationEmail({
                to: customerEmail,
                customerName,
                serviceType,
                message,
                subject: "PRG Service Request Status Update"
              });
              emailResult.sent = true;
            } catch (error) {
              emailResult.error = error instanceof Error ? error.message : "Email send failed";
            }
          } else {
            emailResult.error = "Email API is not configured";
          }
        }
      } else {
        smsResult.error = "Deal has no CONTACT_ID";
        emailResult.error = "Deal has no CONTACT_ID";
      }

      await saveBitrixDealRecord({
        ...persistentRecord,
        ...dealDetails,
        outboundForward
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Notification lookup failed";
      smsResult.error = reason;
      emailResult.error = reason;
    }

    console.log(
      "Bitrix deal webhook received",
      JSON.stringify(
        {
          event: eventName,
          dealId,
          stageId,
          classification
        },
        null,
        2
      )
    );

    return res.status(200).json({
      ok: true,
      tracked: true,
      dealId,
      stageId,
      classification,
      details: dealDetails,
      forwarded: Boolean(outboundForward?.enabled && outboundForward.delivered),
      sms: smsResult,
      email: emailResult
    });
  } catch (error) {
    console.error("Failed to persist/forward Bitrix deal webhook", error);
    return res.status(500).json({ ok: false, error: "Bitrix deal handling failed" });
  }
});

app.post("/webhooks/bitrix/leads", async (req: Request, res: Response) => {
  if (!verifyBitrixSecret(req)) {
    return res.status(401).json({ ok: false, error: "Invalid Bitrix secret" });
  }

  const payload = req.body as BitrixLeadEvent;
  const eventName = String(payload.event ?? "").toUpperCase();
  if (eventName !== "ONCRMLEADADD") {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const fields = (payload.data?.FIELDS ?? {}) as Record<string, unknown>;
  const leadIdRaw = payload.data?.ID ?? fields.ID ?? "";
  const leadId = String(leadIdRaw || "");
  if (!leadId) {
    return res.status(400).json({ ok: false, error: "Missing lead id" });
  }

  try {
    const leadResponse = await getBitrixLeadById(leadId);
    const lead = (leadResponse.result ?? {}) as Record<string, unknown>;

    const customerName = buildLeadCustomerName(lead);
    const serviceType = buildLeadServiceType(lead);
    const message = buildLeadConfirmationMessage(customerName, serviceType);
    const customerPhone = normalizePhoneForSms(readLeadContactValue(lead.PHONE));
    const customerEmail = readLeadContactValue(lead.EMAIL);

    const smsResult: { attempted: boolean; sent: boolean; error?: string } = {
      attempted: Boolean(customerPhone),
      sent: false
    };
    const emailResult: { attempted: boolean; sent: boolean; error?: string } = {
      attempted: Boolean(customerEmail),
      sent: false
    };

    if (customerPhone) {
      try {
        await sendSmsThroughTelnyx({ to: customerPhone, text: message });
        smsResult.sent = true;
      } catch (error) {
        smsResult.error = error instanceof Error ? error.message : "SMS send failed";
      }
    }

    if (customerEmail) {
      if (canSendEmail()) {
        try {
          await sendLeadConfirmationEmail({
            to: customerEmail,
            customerName,
            serviceType
          });
          emailResult.sent = true;
        } catch (error) {
          emailResult.error = error instanceof Error ? error.message : "Email send failed";
        }
      } else {
        emailResult.error = "SMTP is not configured";
      }
    }

    return res.status(200).json({
      ok: true,
      leadId,
      customerName,
      serviceType,
      sms: smsResult,
      email: emailResult
    });
  } catch (error) {
    console.error("Failed to process Bitrix lead webhook", error);
    return res.status(500).json({ ok: false, error: "Bitrix lead handling failed" });
  }
});

app.post("/webhooks/inbound/bitrix/deals/status", async (req: Request, res: Response) => {
  if (!verifyInboundDealSecret(req)) {
    return res.status(401).json({ ok: false, error: "Invalid inbound webhook secret" });
  }

  const body = req.body as {
    dealId?: string | number;
    stageId?: string;
    fields?: Record<string, unknown>;
  };

  const dealId = String(body.dealId ?? "").trim();
  const stageId = String(body.stageId ?? "").trim();

  if (!dealId || !stageId) {
    return res.status(400).json({ ok: false, error: "Missing dealId or stageId" });
  }

  try {
    const result = await updateBitrixDealStage({
      dealId,
      stageId,
      extraFields: body.fields
    });

    return res.status(200).json({
      ok: true,
      moved: true,
      dealId,
      stageId,
      result
    });
  } catch (error) {
    console.error("Failed to update Bitrix deal stage from inbound webhook", error);
    return res.status(500).json({ ok: false, error: "Bitrix deal stage update failed" });
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
