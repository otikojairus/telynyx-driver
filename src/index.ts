import crypto from "crypto";
import axios from "axios";
import express, { Request, Response } from "express";
import { config } from "./config";
import { forwardBitrixDealRecord, saveBitrixDealRecord } from "./bitrixDealStore";
import {
  activateBitrixConnector,
  answerBitrixOpenLineChat,
  bindBitrixDealEvents,
  bindBitrixDealCardDatesWidget,
  bindBitrixDealFundingWidget,
  bindBitrixDealSmsWidget,
  bindBitrixLeadEvents,
  bindBitrixConnectorEvents,
  bindBitrixDealPaymentWidget,
  markBitrixAppInstalled,
  findBitrixUserByEmail,
  getBitrixContactById,
  listBitrixDealCategories,
  listBitrixDealFields,
  listBitrixStatuses,
  getBitrixDealById,
  getBitrixLeadById,
  getBitrixOpenLineHistory,
  getBitrixConnectorStatus,
  normalizeSmsParticipantId,
  registerBitrixConnector,
  sendBitrixInternalMessage,
  sendBitrixDeliveryStatus,
  sendSmsThroughTelnyx,
  sendToBitrixOpenChannel,
  bindBitrixCallCardWidget,
  createBitrixDeal,
  unbindBitrixCallCardWidget,
  updateBitrixDealFields,
  updateBitrixDealStage,
  getBitrixUserById
} from "./clients";
import { initializeDatabase } from "./database";
import {
  forwardTelnyxWebhookRecord,
  listTelnyxSmsRecordsByPhone,
  listTelnyxWebhookRecords,
  saveTelnyxWebhookRecord,
  TelnyxWebhookRecord
} from "./telnyxWebhookStore";
import { canSendEmail, sendLeadConfirmationEmail } from "./notifications";
import { writeBitrixTokens } from "./tokenStore";
import { BitrixDealEvent, BitrixInstallRequest, BitrixLeadEvent, BitrixOutboundEvent, TelnyxWebhook } from "./types";
import { createWavePaymentLink } from "./wave";
import { startBaltoCall, stopBaltoCall, syncBaltoCallData } from "./balto";
import {
  getBaltoCallSessionByTelnyxIds,
  listBaltoCallSessions,
  upsertBaltoCallDataRecord,
  upsertBaltoCallSession
} from "./baltoCallStore";

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
const processedQuotePresentedPaymentTriggers = new Set<string>();
const processedDealCreateNotifications = new Set<string>();
const phoneByChatId = new Map<string, string>();
const phoneByUserId = new Map<string, string>();
// Maps customer phone number → agent email, populated when the Bitrix call card widget opens.
// Used to resolve the answering agent for Balto when Telnyx call.answered fires.
const callAgentByPhone = new Map<string, { agentEmail: string; bitrixCallId: string; storedAt: number }>();
const thirdPartyReplyRouteByPhone = new Map<string, { webhookUrl: string; deliverSmsReplies: boolean }>();
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

function verifyThirdPartyWebhookSecret(req: Request): boolean {
  if (!config.thirdPartyWebhookSecret) {
    return true;
  }
  const incoming = String(req.headers["x-thirdparty-secret"] ?? "");
  return incoming === config.thirdPartyWebhookSecret;
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

function trimMap<T>(map: Map<string, T>, maxEntries = 5000): void {
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

function parsePlacementOptions(body: Record<string, unknown>): Record<string, unknown> {
  const raw = body.PLACEMENT_OPTIONS;
  if (!raw) {
    return {};
  }

  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
}

function normalizeBitrixEntityId(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return "";
  }
  const asNumber = Number(raw);
  if (!Number.isInteger(asNumber) || asNumber <= 0) {
    return "";
  }
  return String(asNumber);
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

function isTruthyCallState(state: string, matches: string[]) {
  const normalized = state.trim().toLowerCase();
  return matches.some((item) => normalized === item);
}

type TelnyxCallPayload = NonNullable<NonNullable<TelnyxWebhook["data"]>["payload"]>;

function parseCsvSet(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
}

function readStringFromRecord(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

function readTelnyxCallMetadata(payload: TelnyxCallPayload | undefined): Record<string, unknown> {
  const metadata = payload?.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
}

function readTelnyxCallState(payload: TelnyxCallPayload | undefined): string {
  if (!payload) {
    return "";
  }

  return readStringFromRecord(payload, [
    "state",
    "status",
    "call_state",
    "callState",
    "call_status",
    "callStatus"
  ]).toLowerCase();
}

function isBaltoAnsweredCallEvent(eventType: string, payload: TelnyxCallPayload | undefined): boolean {
  const normalizedEventType = eventType.trim().toLowerCase();
  const state = readTelnyxCallState(payload);

  if (["call.answered", "call.connected"].includes(normalizedEventType)) {
    return true;
  }

  if (["ringing", "initiated", "dialing", "queued", "connecting", "early"].includes(state)) {
    return false;
  }

  if (normalizedEventType === "call.bridged") {
    return ["answered", "connected", "active", "live"].includes(state);
  }

  return false;
}

function isBaltoTerminalCallEvent(eventType: string, payload: TelnyxCallPayload | undefined): boolean {
  const normalizedEventType = eventType.trim().toLowerCase();
  const state = readTelnyxCallState(payload);
  const terminalEventTypes = new Set([
    "call.hangup",
    "call.ended",
    "call.rejected",
    "call.declined",
    "call.canceled",
    "call.cancelled",
    "call.failed",
    "call.busy",
    "call.no_answer"
  ]);

  return (
    terminalEventTypes.has(normalizedEventType) ||
    /\b(hangup|ended|rejected|declined|canceled|cancelled|failed|busy|no_answer)\b/.test(normalizedEventType) ||
    ["hangup", "ended", "rejected", "declined", "canceled", "cancelled", "failed", "busy", "no_answer"].includes(state)
  );
}

function resolveBaltoAgentIdentifier(metadata: Record<string, unknown>) {
  const email = (
    readStringFromRecord(metadata, [
      "email",
      "agent_email",
      "agentEmail",
      "user_email",
      "userEmail",
      "bitrix_user_email",
      "bitrixUserEmail"
    ]) || config.baltoDefaultAgentEmail
  ).trim();

  const voipUserId = (
    readStringFromRecord(metadata, [
      "voip_user_id",
      "voipUserId",
      "agent_id",
      "agentId",
      "user_id",
      "userId",
      "bitrix_user_id",
      "bitrixUserId"
    ]) || config.baltoDefaultVoipUserId
  ).trim();

  if (config.baltoIdentifierType.toLowerCase() === "voip_user_id") {
    return { email: "", voipUserId };
  }

  return { email, voipUserId };
}

function resolveBaltoCustomerPhone(payload: TelnyxCallPayload | undefined, direction: string): string {
  const from = readTelnyxPhone(payload?.from);
  const to = readTelnyxPhone(payload?.to);
  const normalizedDirection = direction.trim().toLowerCase();

  // When direction is missing, infer it: if `to` is our business number → inbound (customer is `from`)
  if (!normalizedDirection) {
    const businessNumber = config.telnyxFromNumber.replace(/\D/g, "");
    const toDigits = to.replace(/\D/g, "");
    const isInbound = businessNumber && toDigits && toDigits.endsWith(businessNumber.replace(/\D/g, ""));
    return isInbound ? from || to : to || from;
  }

  if (normalizedDirection === "outbound") {
    return to || from;
  }
  return from || to;
}

function buildBaltoCallContext(body: TelnyxWebhook, record: TelnyxWebhookRecord) {
  const payload = body.data?.payload;
  const metadata = readTelnyxCallMetadata(payload);
  const rawDirection = readStringFromRecord(metadata, ["direction"]) || String(payload?.direction ?? "").trim();
  const phoneNumber = resolveBaltoCustomerPhone(payload, rawDirection);
  // Infer direction from phone numbers when Telnyx omits it
  const toPhone = readTelnyxPhone(payload?.to).replace(/\D/g, "");
  const bizPhone = config.telnyxFromNumber.replace(/\D/g, "");
  const direction = rawDirection || (bizPhone && toPhone && toPhone.endsWith(bizPhone) ? "inbound" : "outbound");
  const callControlId = String(payload?.call_control_id ?? "").trim();
  const callLegId = String(payload?.call_leg_id ?? "").trim();
  const voipCallId =
    readStringFromRecord(metadata, ["voip_call_id", "voipCallId", "call_id", "callId"]) ||
    callControlId ||
    callLegId ||
    record.eventId ||
    record.id;
  const bitrixCallId = readStringFromRecord(metadata, ["bitrix_call_id", "bitrixCallId", "CALL_ID"]);
  const bitrixDealId = readStringFromRecord(metadata, ["bitrix_deal_id", "bitrixDealId", "deal_id", "dealId"]);
  const voipCustomerId =
    readStringFromRecord(metadata, ["voip_customer_id", "voipCustomerId", "customer_id", "customerId"]) ||
    phoneNumber;
  const voipCampaignName =
    readStringFromRecord(metadata, [
      "voip_campaign_name",
      "voipCampaignName",
      "campaign",
      "campaign_name",
      "queue",
      "skill",
      "service_type",
      "serviceType",
      "pipeline",
      "line"
    ]) ||
    direction ||
    "telnyx_call";
  const { email: metaEmail, voipUserId } = resolveBaltoAgentIdentifier(metadata);
  // If metadata had no agent email, check the call card map populated when Bitrix opened the widget.
  const email = metaEmail || (phoneNumber ? callAgentByPhone.get(phoneNumber)?.agentEmail ?? "" : "");

  return {
    sessionId: `balto-${voipCallId}`,
    telnyxEventId: record.eventId || record.id,
    telnyxCallControlId: callControlId,
    telnyxCallLegId: callLegId,
    bitrixCallId: bitrixCallId || (phoneNumber ? callAgentByPhone.get(phoneNumber)?.bitrixCallId ?? "" : ""),
    bitrixDealId,
    agentEmail: email,
    voipUserId,
    phoneNumber,
    direction,
    voipCallId,
    voipCustomerId,
    voipCampaignName,
    metadata
  };
}

async function handleBaltoTelnyxCallEvent(body: TelnyxWebhook, record: TelnyxWebhookRecord) {
  if (!config.baltoEnabled) {
    return { enabled: false };
  }

  const eventType = String(body.data?.event_type ?? "").toLowerCase();
  const startEventTypes = parseCsvSet(config.baltoStartEventTypes);
  const stopEventTypes = parseCsvSet(config.baltoStopEventTypes);
  const shouldStart = startEventTypes.has(eventType) && isBaltoAnsweredCallEvent(eventType, body.data?.payload);
  const shouldStop = stopEventTypes.has(eventType) || isBaltoTerminalCallEvent(eventType, body.data?.payload);

  if (!shouldStart && !shouldStop) {
    return { enabled: true, action: "ignored", eventType };
  }

  const context = buildBaltoCallContext(body, record);
  const existing = await getBaltoCallSessionByTelnyxIds({
    voipCallId: context.voipCallId,
    callControlId: context.telnyxCallControlId,
    callLegId: context.telnyxCallLegId
  });
  const identifier = context.agentEmail
    ? { email: context.agentEmail }
    : context.voipUserId
      ? { voip_user_id: context.voipUserId }
      : existing?.agentEmail
        ? { email: existing.agentEmail }
        : existing?.voipUserId
          ? { voip_user_id: existing.voipUserId }
          : {};

  if (!("email" in identifier) && !("voip_user_id" in identifier)) {
    await upsertBaltoCallSession({
      id: context.sessionId,
      status: shouldStart ? "start_failed" : "stop_failed",
      telnyxEventId: context.telnyxEventId,
      telnyxCallControlId: context.telnyxCallControlId,
      telnyxCallLegId: context.telnyxCallLegId,
      bitrixCallId: context.bitrixCallId,
      bitrixDealId: context.bitrixDealId,
      phoneNumber: context.phoneNumber,
      direction: context.direction,
      voipCallId: context.voipCallId,
      voipCustomerId: context.voipCustomerId,
      voipCampaignName: context.voipCampaignName,
      lastError: "Missing Balto agent email or voip_user_id. Provide metadata or BALTO_DEFAULT_AGENT_EMAIL/BALTO_DEFAULT_VOIP_USER_ID.",
      rawStartEvent: shouldStart ? body : undefined,
      rawStopEvent: shouldStop ? body : undefined
    });
    return {
      enabled: true,
      action: shouldStart ? "start_failed" : "stop_failed",
      error: "missing_agent_identifier",
      voipCallId: context.voipCallId
    };
  }

  if (shouldStart) {
    if (existing?.startRequestedAt && existing.status !== "start_failed") {
      return { enabled: true, action: "start_duplicate", voipCallId: context.voipCallId };
    }

    try {
      const response = await startBaltoCall({
        ...identifier,
        voip_call_id: context.voipCallId,
        voip_customer_id: context.voipCustomerId,
        voip_campaign_name: context.voipCampaignName,
        direction: context.direction || undefined,
        integration: config.baltoIntegrationName,
        timestamp: body.data?.occurred_at ?? new Date().toISOString(),
        voip_metadata: {
          bitrix_call_id: context.bitrixCallId || undefined,
          bitrix_deal_id: context.bitrixDealId || undefined,
          telnyx_call_control_id: context.telnyxCallControlId || undefined,
          telnyx_call_leg_id: context.telnyxCallLegId || undefined,
          phone_number: context.phoneNumber || undefined,
          ...context.metadata
        }
      });
      await upsertBaltoCallSession({
        id: context.sessionId,
        status: "started",
        telnyxEventId: context.telnyxEventId,
        telnyxCallControlId: context.telnyxCallControlId,
        telnyxCallLegId: context.telnyxCallLegId,
        bitrixCallId: context.bitrixCallId,
        bitrixDealId: context.bitrixDealId,
        agentEmail: context.agentEmail || existing?.agentEmail,
        voipUserId: context.voipUserId || existing?.voipUserId,
        phoneNumber: context.phoneNumber,
        direction: context.direction,
        voipCallId: context.voipCallId,
        voipCustomerId: context.voipCustomerId,
        voipCampaignName: context.voipCampaignName,
        startRequestedAt: new Date().toISOString(),
        startResponse: response,
        rawStartEvent: body
      });
      return { enabled: true, action: "started", voipCallId: context.voipCallId };
    } catch (error) {
      await upsertBaltoCallSession({
        id: context.sessionId,
        status: "start_failed",
        telnyxEventId: context.telnyxEventId,
        telnyxCallControlId: context.telnyxCallControlId,
        telnyxCallLegId: context.telnyxCallLegId,
        bitrixCallId: context.bitrixCallId,
        bitrixDealId: context.bitrixDealId,
        agentEmail: context.agentEmail || existing?.agentEmail,
        voipUserId: context.voipUserId || existing?.voipUserId,
        phoneNumber: context.phoneNumber,
        direction: context.direction,
        voipCallId: context.voipCallId,
        voipCustomerId: context.voipCustomerId,
        voipCampaignName: context.voipCampaignName,
        lastError: error instanceof Error ? error.message : "Balto start failed",
        rawStartEvent: body
      });
      return { enabled: true, action: "start_failed", voipCallId: context.voipCallId };
    }
  }

  if (existing?.stopRequestedAt && existing.status !== "stop_failed") {
    return { enabled: true, action: "stop_duplicate", voipCallId: context.voipCallId };
  }

  try {
    const response = await stopBaltoCall({
      ...identifier,
      voip_call_id: context.voipCallId,
      voip_customer_id: context.voipCustomerId || existing?.voipCustomerId,
      voip_campaign_name: context.voipCampaignName || existing?.voipCampaignName,
      direction: context.direction || existing?.direction,
      integration: config.baltoIntegrationName,
      timestamp: body.data?.occurred_at ?? new Date().toISOString()
    });
    await upsertBaltoCallSession({
      id: existing?.id ?? context.sessionId,
      status: "stopped",
      telnyxEventId: context.telnyxEventId,
      telnyxCallControlId: context.telnyxCallControlId,
      telnyxCallLegId: context.telnyxCallLegId,
      bitrixCallId: context.bitrixCallId,
      bitrixDealId: context.bitrixDealId,
      agentEmail: context.agentEmail || existing?.agentEmail,
      voipUserId: context.voipUserId || existing?.voipUserId,
      phoneNumber: context.phoneNumber || existing?.phoneNumber,
      direction: context.direction || existing?.direction,
      voipCallId: context.voipCallId,
      voipCustomerId: context.voipCustomerId || existing?.voipCustomerId,
      voipCampaignName: context.voipCampaignName || existing?.voipCampaignName,
      stopRequestedAt: new Date().toISOString(),
      stopResponse: response,
      rawStopEvent: body
    });
    return { enabled: true, action: "stopped", voipCallId: context.voipCallId };
  } catch (error) {
    await upsertBaltoCallSession({
      id: existing?.id ?? context.sessionId,
      status: "stop_failed",
      telnyxEventId: context.telnyxEventId,
      telnyxCallControlId: context.telnyxCallControlId,
      telnyxCallLegId: context.telnyxCallLegId,
      bitrixCallId: context.bitrixCallId,
      bitrixDealId: context.bitrixDealId,
      agentEmail: context.agentEmail || existing?.agentEmail,
      voipUserId: context.voipUserId || existing?.voipUserId,
      phoneNumber: context.phoneNumber || existing?.phoneNumber,
      direction: context.direction || existing?.direction,
      voipCallId: context.voipCallId,
      voipCustomerId: context.voipCustomerId || existing?.voipCustomerId,
      voipCampaignName: context.voipCampaignName || existing?.voipCampaignName,
      lastError: error instanceof Error ? error.message : "Balto stop failed",
      rawStopEvent: body
    });
    return { enabled: true, action: "stop_failed", voipCallId: context.voipCallId };
  }
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

function normalizeStageId(value: string): string {
  return String(value || "").trim().toUpperCase();
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

async function forwardBitrixReplyToThirdParty(params: {
  webhookUrl: string;
  phone: string;
  text: string;
  messageId: string;
  chatId: string;
  bitrixUserId: string;
  rawEvent: unknown;
}) {
  const response = await axios.post(
    params.webhookUrl,
    {
      source: "bitrix-reply-webhook",
      receivedAt: new Date().toISOString(),
      phone: params.phone,
      text: params.text,
      messageId: params.messageId,
      chatId: params.chatId,
      bitrixUserId: params.bitrixUserId,
      event: params.rawEvent
    },
    {
      timeout: 15000,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );

  return response.status;
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

function normalizeClientPrice(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toFixed(2);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const numeric = Number(trimmed.replace(/,/g, ""));
    if (Number.isFinite(numeric)) {
      return numeric.toFixed(2);
    }
    return trimmed;
  }
  return null;
}

function normalizeMoneyAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

async function generateAndSendDealPaymentLink(params: {
  dealId: string;
  paymentType: "deposit" | "callout";
  amount?: string | number;
  amountField?: string;
  currency?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  updateBitrixDealField?: boolean;
  sendSms?: boolean;
  sendEmail?: boolean;
}) {
  const dealId = String(params.dealId).trim();
  const paymentType = params.paymentType;
  const amount = normalizeMoneyAmount(params.amount);
  const amountField = String(params.amountField ?? "").trim();
  const currency = String(params.currency ?? "USD").trim().toUpperCase();
  let customerName = String(params.customerName ?? "").trim();
  let customerEmail = String(params.customerEmail ?? "").trim();
  let customerPhone = normalizePhoneForSms(String(params.customerPhone ?? ""));
  const updateDealField = params.updateBitrixDealField !== false;
  const sendSms = params.sendSms !== false;
  const sendEmail = params.sendEmail !== false;

  const dealResponse = await getBitrixDealById(dealId);
  const deal = (dealResponse.result ?? {}) as Record<string, unknown>;
  const contactId = normalizeBitrixEntityId(deal.CONTACT_ID);

  if (!customerName || !customerPhone || !customerEmail) {
    if (contactId) {
      const contactResponse = await getBitrixContactById(contactId);
      const contact = (contactResponse.result ?? {}) as Record<string, unknown>;
      customerName = customerName || buildLeadCustomerName(contact);
      customerPhone = customerPhone || normalizePhoneForSms(readLeadContactValue(contact.PHONE));
      customerEmail = customerEmail || readLeadContactValue(contact.EMAIL);
    }
  }

  let resolvedAmount = amount;
  if (!resolvedAmount) {
    const byConfigured = config.bitrixDealClientPriceField
      ? normalizeMoneyAmount(deal[config.bitrixDealClientPriceField])
      : null;
    const byOpportunity = normalizeMoneyAmount(deal.OPPORTUNITY);
    const byNamedField = amountField ? normalizeMoneyAmount(deal[amountField]) : null;
    resolvedAmount = byNamedField ?? byConfigured ?? byOpportunity;
  }
  if (!resolvedAmount) {
    throw new Error("Missing valid amount. Provide amount or ensure deal has client price/opportunity.");
  }

  const description =
    String(params.description ?? "").trim() ||
    `${paymentType === "deposit" ? "Deposit" : "Callout fee"} for Deal ${dealId}`;
  const metadata = {
    dealId,
    paymentType,
    dealTitle: String(deal.TITLE ?? ""),
    ...(params.metadata ?? {})
  };

  const wave = await createWavePaymentLink({
    amount: resolvedAmount,
    currency,
    description,
    metadata,
    customer: {
      name: customerName || undefined,
      email: customerEmail || undefined,
      phone: customerPhone || undefined
    }
  });

  const fieldName =
    paymentType === "deposit" ? config.bitrixDealDepositLinkField : config.bitrixDealCalloutLinkField;
  let bitrixUpdate: unknown = null;
  if (updateDealField && fieldName) {
    bitrixUpdate = await updateBitrixDealFields({
      dealId,
      fields: {
        [fieldName]: wave.link
      }
    });
  }

  const smsText =
    paymentType === "deposit"
      ? `Hi ${customerName || "there"}, please pay your deposit here: ${wave.link}`
      : `Hi ${customerName || "there"}, please pay the callout fee here: ${wave.link}`;
  const dealName = String(deal.TITLE ?? "").trim() || `Deal ${dealId}`;
  const emailBody =
    `${paymentType === "deposit" ? "Deposit" : "Callout fee"} payment link for ${dealName}: ${wave.link}`;

  const smsResult: { attempted: boolean; sent: boolean; error?: string } = {
    attempted: Boolean(sendSms && customerPhone),
    sent: false
  };
  const emailResult: { attempted: boolean; sent: boolean; error?: string } = {
    attempted: Boolean(sendEmail && customerEmail),
    sent: false
  };

  if (sendSms && customerPhone) {
    try {
      await sendSmsThroughTelnyx({ to: customerPhone, text: smsText });
      smsResult.sent = true;
    } catch (error) {
      smsResult.error = error instanceof Error ? error.message : "SMS send failed";
    }
  }

  if (sendEmail && customerEmail) {
    if (canSendEmail()) {
      try {
        await sendLeadConfirmationEmail({
          to: customerEmail,
          customerName: customerName || "Customer",
          serviceType: "Payment",
          message: emailBody,
          subject: `${paymentType === "deposit" ? "Deposit" : "Callout fee"} payment link`
        });
        emailResult.sent = true;
      } catch (error) {
        emailResult.error = error instanceof Error ? error.message : "Email send failed";
      }
    } else {
      emailResult.error = "Email API is not configured";
    }
  }

  return {
    ok: true,
    dealId,
    paymentType,
    amount: resolvedAmount,
    currency,
    link: wave.link,
    customer: {
      name: customerName,
      email: customerEmail,
      phone: customerPhone
    },
    bitrixField: fieldName || null,
    bitrixUpdated: Boolean(updateDealField && fieldName),
    bitrixUpdate,
    sms: smsResult,
    email: emailResult,
    templates: {
      sms: smsText,
      emailSubject: `${paymentType === "deposit" ? "Deposit" : "Callout fee"} payment link`,
      emailBody
    }
  };
}

const BITRIX_SERVICE_CATEGORY_ENUM: Record<string, string> = {
  "72": "Emergency Plumbing Repair Services",
  "74": "Drain & Sewer Services",
  "76": "Water Heater Services",
  "78": "Plumbing Installation & Fixture Replacement & Repair",
  "80": "Air Conditioning Installation & Replacement",
  "82": "Heating System Installation",
  "84": "Water Damage Restoration",
  "86": "Insurance Claim assistance",
  "88": "Callout, Diagnostic and Assessment"
};

const BITRIX_SERVICE_TYPES_ENUM: Record<string, string> = {
  "90": "Leaking Faucet Repair",
  "92": "Running toilet repair",
  "94": "Clogged Drain",
  "96": "Minor Pipe / Drain line Repair",
  "98": "Minor Pipe Repair",
  "100": "Pipe Repair/replacement",
  "102": "Burst Pipe Repair",
  "104": "Frozen Pipe Repair",
  "106": "Shutoff valve repair / replacement",
  "108": "Water pressure issue repair",
  "110": "Overflowing toilet emergency service",
  "112": "Emergency plumbing leak repair"
};

const VENDOR_ACQUISITION_PIPELINE_MAP: Record<string, { categoryId: string; stageId: string }> = {
  "plumbing": { categoryId: "20", stageId: "C20:NEW" },
  "hvac": { categoryId: "22", stageId: "C22:NEW" },
  "roofing": { categoryId: "24", stageId: "C24:NEW" },
  "septic": { categoryId: "12", stageId: "C12:NEW" },
  "mold": { categoryId: "16", stageId: "C16:NEW" },
  "flood": { categoryId: "18", stageId: "C18:NEW" },
  "water damage": { categoryId: "18", stageId: "C18:NEW" },
  "water damage restoration": { categoryId: "18", stageId: "C18:NEW" },
};

const VENDOR_ACQUISITION_DEFAULT_PIPELINE = { categoryId: "26", stageId: "C26:NEW" };
const DEAL_MATCH_API_URL = "https://global-node.thefvg.com/api/v1/deals/match?limit=12&country=canada";
const DEAL_MATCH_BITRIX_FIELD = "UF_CRM_1780590038641";

interface DealMatchParams {
  country?: string;
  provinceState?: string;
  city?: string;
  postalCode?: string;
  issueNeed?: string;
  vertical?: string;
  dealType?: string;
}

function getVendorAcquisitionPipeline(serviceVertical: string): { categoryId: string; stageId: string } {
  const key = serviceVertical.toLowerCase().trim();
  for (const [pattern, pipeline] of Object.entries(VENDOR_ACQUISITION_PIPELINE_MAP)) {
    if (key.includes(pattern)) {
      return pipeline;
    }
  }
  return VENDOR_ACQUISITION_DEFAULT_PIPELINE;
}

async function moveDealToVendorAcquisitionPipeline(params: {
  dealId: string;
  pipeline: { categoryId: string; stageId: string };
}) {
  await updateBitrixDealFields({
    dealId: params.dealId,
    fields: { CATEGORY_ID: params.pipeline.categoryId }
  });
  await updateBitrixDealFields({
    dealId: params.dealId,
    fields: { STAGE_ID: params.pipeline.stageId }
  });
}

function formatMatchedVendors(vendors: Array<Record<string, unknown>>): string {
  return vendors
    .map((v) => {
      const rank = v.display_rank ?? "";
      const name = v.vendor_name ?? "";
      const phone = v.phone ?? "";
      const email = v.email ?? "";
      return [`#${rank} ${name}`, phone, email].filter(Boolean).join(" | ");
    })
    .join("\n");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function humanizeFundingKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatFundingPrimitive(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "Not provided";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  return String(value);
}

function formatFundingValue(value: unknown, indent = 0): string[] {
  const prefix = "  ".repeat(indent);

  if (Array.isArray(value)) {
    if (!value.length) {
      return [`${prefix}None`];
    }

    return value.flatMap((item, index) => {
      if (isPlainRecord(item) || Array.isArray(item)) {
        return [`${prefix}${index + 1}.`, ...formatFundingValue(item, indent + 1)];
      }
      return [`${prefix}${index + 1}. ${formatFundingPrimitive(item)}`];
    });
  }

  if (isPlainRecord(value)) {
    const lines: string[] = [];
    for (const [key, fieldValue] of Object.entries(value)) {
      if (isPlainRecord(fieldValue) || Array.isArray(fieldValue)) {
        lines.push(`${prefix}${humanizeFundingKey(key)}:`);
        lines.push(...formatFundingValue(fieldValue, indent + 1));
      } else {
        lines.push(`${prefix}${humanizeFundingKey(key)}: ${formatFundingPrimitive(fieldValue)}`);
      }
    }
    return lines.length ? lines : [`${prefix}None`];
  }

  return [`${prefix}${formatFundingPrimitive(value)}`];
}

function extractFundingResults(matchData: unknown): Array<Record<string, unknown>> {
  const candidates = [
    isPlainRecord(matchData) ? matchData.result : undefined,
    isPlainRecord(matchData) ? matchData.results : undefined,
    isPlainRecord(matchData) && isPlainRecord(matchData.data) ? matchData.data.result : undefined,
    isPlainRecord(matchData) && isPlainRecord(matchData.data) ? matchData.data.results : undefined
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isPlainRecord);
    }
    if (isPlainRecord(candidate)) {
      return [candidate];
    }
  }

  return [];
}

function formatFundingAmount(result: Record<string, unknown>): string {
  const currency = String(result.currency ?? "").trim();
  const min = result.valueMin;
  const max = result.valueMax;

  if ((min === null || min === undefined || min === "") && (max === null || max === undefined || max === "")) {
    return "Not specified";
  }
  if (min !== null && min !== undefined && min !== "" && max !== null && max !== undefined && max !== "") {
    return `${currency ? `${currency} ` : ""}${min} - ${max}`;
  }
  return `${currency ? `${currency} ` : ""}${min ?? max}`;
}

function formatFundingGeography(geography: unknown): string {
  if (!isPlainRecord(geography)) {
    return "Not specified";
  }

  return [
    geography.city,
    geography.region,
    geography.state,
    geography.province,
    geography.country,
    geography.postalCode
  ]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(", ") || "Not specified";
}

function formatFundingList(value: unknown): string {
  if (!Array.isArray(value)) {
    return String(value ?? "").trim() || "None";
  }
  return value.map((item) => String(item ?? "").trim()).filter(Boolean).join(", ") || "None";
}

function cleanFundingDescription(value: unknown): string {
  const text = String(value ?? "")
    .replace(/\*\*/g, "")
    .replace(/^URL:\s*/i, "")
    .trim();
  if (!text) {
    return "";
  }
  return text.length > 240 ? `${text.slice(0, 237).trim()}...` : text;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatFundingResult(result: Record<string, unknown>, index: number): string {
  const description = cleanFundingDescription(result.description);
  const lines = [
    `${index + 1}. ${formatFundingPrimitive(result.title)}`,
    `Type: ${formatFundingPrimitive(result.programTypeLabel || result.dealType)}`,
    `Focus: ${formatFundingPrimitive(result.fundingFocus)}`,
    `Amount: ${formatFundingAmount(result)}`,
    `Status: ${formatFundingPrimitive(result.status)} (${formatFundingPrimitive(result.matchStatus)}; score ${formatFundingPrimitive(result.matchScore)})`,
    `Geography: ${formatFundingGeography(result.geography)}`,
    `Deadline: ${formatFundingPrimitive(result.deadline)}`,
    `Match reason: ${formatFundingList(result.matchReason)}`,
    `Missing criteria: ${formatFundingList(result.missingCriteria)}`,
    `Next action: ${formatFundingPrimitive(result.recommendedNextAction)}`,
    `URL: ${formatFundingPrimitive(result.sourceUrl)}`
  ];

  if (description && description !== String(result.sourceUrl ?? "").trim()) {
    lines.splice(2, 0, `Summary: ${description}`);
  }

  return lines.join("\n");
}

function normalizeFundingFieldText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim() || "Not provided";
}

function formatFundingDetailsSummary(matchData: unknown): string {
  const results = extractFundingResults(matchData);
  if (!results.length) {
    return "No funding matches returned.";
  }

  return results
    .map((result, index) => {
      const lines = [
        `${index + 1}. ${normalizeFundingFieldText(result.title)}`,
        `Type: ${normalizeFundingFieldText(result.programTypeLabel || result.dealType)}`,
        `Focus: ${normalizeFundingFieldText(result.fundingFocus)}`,
        `Amount: ${formatFundingAmount(result)}`,
        `Location: ${formatFundingGeography(result.geography)}`,
        `Score: ${normalizeFundingFieldText(result.matchScore)} (${normalizeFundingFieldText(result.matchStatus)})`,
        `Action: ${normalizeFundingFieldText(result.recommendedNextAction)}`,
        `Why: ${formatFundingList(result.matchReason)}`,
        `Missing: ${formatFundingList(result.missingCriteria)}`,
        `URL: ${normalizeFundingFieldText(result.sourceUrl)}`
      ];

      return lines.join("\n");
    })
    .join("\n\n----------------------------------------\n\n");
}

function formatFundingDetails(matchData: unknown): string {
  const results = extractFundingResults(matchData);
  if (results.length) {
    return results.map(formatFundingResult).join("\n\n");
  }

  if (isPlainRecord(matchData) || Array.isArray(matchData)) {
    return formatFundingValue(matchData).join("\n");
  }

  return "No funding details returned.";
}

function compactDealMatchParams(params: DealMatchParams): DealMatchParams {
  return Object.fromEntries(
    Object.entries(params)
      .map(([key, value]) => [key, String(value ?? "").trim()])
      .filter(([, value]) => Boolean(value))
  ) as DealMatchParams;
}

function buildDealMatchQuery(params: DealMatchParams): URLSearchParams {
  const query = new URLSearchParams({
    limit: "12",
    country: "canada"
  });

  for (const key of ["country", "provinceState", "city", "postalCode", "issueNeed", "vertical", "dealType"] as const) {
    const value = String(params[key] ?? "").trim();
    if (value) {
      query.set(key, value);
    }
  }

  return query;
}

async function fetchDealMatchData(matchParamsInput: DealMatchParams): Promise<unknown> {
  const matchParams = compactDealMatchParams(matchParamsInput);
  const query = buildDealMatchQuery(matchParams);
  const requestUrl = `${DEAL_MATCH_API_URL.split("?")[0]}?${query.toString()}`;
  const response = await axios.get(requestUrl, {
    headers: config.weatherWebhookSecret
      ? { Authorization: `Bearer ${config.weatherWebhookSecret}` }
      : undefined,
    timeout: 15000
  });
  return response.data;
}

async function updateDealMatchesField(params: { dealId: string; matchParams: DealMatchParams }) {
  const matchData = await fetchDealMatchData(params.matchParams);

  await updateBitrixDealFields({
    dealId: params.dealId,
    fields: {
      [DEAL_MATCH_BITRIX_FIELD]: formatFundingDetailsSummary(matchData)
    }
  });
}

function renderFundingCard(result: Record<string, unknown>, index: number): string {
  const title = escapeHtml(result.title || `Funding Match ${index + 1}`);
  const description = cleanFundingDescription(result.description);
  const sourceUrl = String(result.sourceUrl ?? "").trim();
  const tags = Array.isArray(result.tags)
    ? result.tags.map((tag) => String(tag ?? "").trim()).filter(Boolean)
    : [];
  const matchReason = formatFundingList(result.matchReason);
  const missingCriteria = formatFundingList(result.missingCriteria);

  return `
    <article class="funding-card">
      <div class="card-top">
        <div>
          <h2>${title}</h2>
          <div class="meta">${escapeHtml(result.programTypeLabel || result.dealType)} · ${escapeHtml(result.status)}</div>
        </div>
        <div class="score">${escapeHtml(result.matchScore)}%</div>
      </div>
      ${description ? `<p class="summary">${escapeHtml(description)}</p>` : ""}
      <dl>
        <div><dt>Focus</dt><dd>${escapeHtml(formatFundingPrimitive(result.fundingFocus))}</dd></div>
        <div><dt>Amount</dt><dd>${escapeHtml(formatFundingAmount(result))}</dd></div>
        <div><dt>Geography</dt><dd>${escapeHtml(formatFundingGeography(result.geography))}</dd></div>
        <div><dt>Deadline</dt><dd>${escapeHtml(formatFundingPrimitive(result.deadline))}</dd></div>
        <div><dt>Match</dt><dd>${escapeHtml(formatFundingPrimitive(result.matchStatus))}</dd></div>
        <div><dt>Next Action</dt><dd>${escapeHtml(formatFundingPrimitive(result.recommendedNextAction))}</dd></div>
      </dl>
      <div class="note"><strong>Why:</strong> ${escapeHtml(matchReason)}</div>
      ${missingCriteria !== "None" ? `<div class="note muted"><strong>Missing:</strong> ${escapeHtml(missingCriteria)}</div>` : ""}
      ${tags.length ? `<div class="tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
      ${sourceUrl ? `<a class="link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open funding source</a>` : ""}
    </article>
  `;
}

function renderFundingMatchesHtml(params: {
  dealId: string;
  matchParams: DealMatchParams;
  results: Array<Record<string, unknown>>;
  totalMatches?: unknown;
  error?: string;
}): string {
  const matchParams = compactDealMatchParams(params.matchParams);
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Funding Matches</title>
    <style>
      body { margin: 0; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #172033; background: #f6f8fb; }
      .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
      h1 { margin: 0; font-size: 18px; line-height: 1.25; }
      .sub { margin-top: 4px; color: #667085; font-size: 13px; }
      .count { background: #e8f1ff; color: #175cd3; border: 1px solid #caddff; border-radius: 999px; padding: 5px 9px; font-size: 12px; white-space: nowrap; }
      .query { margin: 0 0 14px; color: #475467; font-size: 12px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
      .funding-card { background: white; border: 1px solid #dfe5ef; border-radius: 8px; padding: 14px; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04); }
      .card-top { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
      h2 { margin: 0; font-size: 15px; line-height: 1.3; color: #101828; }
      .meta { margin-top: 4px; color: #667085; font-size: 12px; }
      .score { min-width: 42px; text-align: center; border-radius: 6px; padding: 5px 7px; background: #ecfdf3; color: #067647; font-weight: 700; font-size: 12px; }
      .summary { margin: 10px 0; color: #344054; font-size: 13px; line-height: 1.45; }
      dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; margin: 12px 0; }
      dt { color: #667085; font-size: 11px; text-transform: uppercase; }
      dd { margin: 2px 0 0; color: #101828; font-size: 13px; overflow-wrap: anywhere; }
      .note { margin-top: 8px; color: #344054; font-size: 12px; line-height: 1.4; }
      .muted { color: #667085; }
      .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
      .tags span { background: #f2f4f7; border: 1px solid #eaecf0; color: #344054; border-radius: 999px; padding: 3px 7px; font-size: 11px; }
      .link { display: inline-flex; margin-top: 12px; color: #175cd3; font-size: 13px; text-decoration: none; font-weight: 600; }
      .empty, .error { background: white; border: 1px solid #dfe5ef; border-radius: 8px; padding: 16px; color: #475467; }
      .error { border-color: #fecdca; color: #b42318; background: #fffbfa; }
      @media (max-width: 560px) { body { padding: 12px; } .header { display: block; } .count { display: inline-block; margin-top: 8px; } dl { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <div class="header">
      <div>
        <h1>Funding Matches</h1>
        <div class="sub">Deal ${escapeHtml(params.dealId)}</div>
      </div>
      <div class="count">${escapeHtml(params.results.length)} shown${params.totalMatches !== undefined ? ` of ${escapeHtml(params.totalMatches)}` : ""}</div>
    </div>
    ${Object.keys(matchParams).length ? `<p class="query">${escapeHtml(Object.entries(matchParams).map(([key, value]) => `${humanizeFundingKey(key)}: ${value}`).join(" · "))}</p>` : ""}
    ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ""}
    ${!params.error && params.results.length ? `<div class="grid">${params.results.map(renderFundingCard).join("")}</div>` : ""}
    ${!params.error && !params.results.length ? `<div class="empty">No funding matches returned for this deal.</div>` : ""}
  </body>
</html>`;
}

function updateDealMatchesFieldNonBlocking(params: { dealId: string; matchParams: DealMatchParams; source: string }) {
  void updateDealMatchesField(params)
    .then(() => {
      console.log(`Updated deal match field for deal ${params.dealId} from ${params.source}`);
    })
    .catch((err: unknown) => {
      console.error(
        `Deal match lookup failed for deal ${params.dealId} from ${params.source}`,
        err instanceof Error ? err.message : err
      );
    });
}

function buildDealMatchParamsFromCsrIntake(params: {
  customerBasics?: {
    city?: string;
    country?: string;
    provinceState?: string;
    postalCode?: string;
    serviceAddress?: string;
  };
  serviceRequest?: {
    serviceCategory?: string[];
    serviceTypes?: string[];
    issueDescription?: string;
  };
}): DealMatchParams {
  return compactDealMatchParams({
    country: params.customerBasics?.country,
    provinceState: params.customerBasics?.provinceState,
    city: params.customerBasics?.city,
    postalCode: params.customerBasics?.postalCode,
    issueNeed: params.serviceRequest?.issueDescription || params.serviceRequest?.serviceTypes?.[0],
    vertical: params.serviceRequest?.serviceCategory?.[0]
  });
}

function buildDealMatchParamsFromBitrixDeal(params: {
  deal: Record<string, unknown>;
  serviceType: string;
  postalCode: string;
}): DealMatchParams {
  const deal = params.deal;
  const serviceCategoryStr = readAsStringArray(deal, ["UF_CRM_1780329708763"]);
  const serviceCategoryEnum = resolveEnumId(BITRIX_SERVICE_CATEGORY_ENUM, deal["UF_CRM_1780330078905"]);
  const serviceTypeResolved = resolveEnumId(BITRIX_SERVICE_TYPES_ENUM, deal["UF_CRM_1780330671084"]);

  return compactDealMatchParams({
    country: readFirstNonEmptyString(deal, ["UF_CRM_1780329497687", "ADDRESS_COUNTRY"]),
    provinceState: readFirstNonEmptyString(deal, ["UF_CRM_1780329514570", "ADDRESS_PROVINCE", "ADDRESS_REGION"]),
    city: readFirstNonEmptyString(deal, ["UF_CRM_1780329478655", "ADDRESS_CITY"]),
    postalCode: params.postalCode || readFirstNonEmptyString(deal, ["UF_CRM_POSTAL_CODE", "ADDRESS_POSTAL_CODE", "POSTAL_CODE"]),
    issueNeed: readFirstNonEmptyString(deal, ["UF_CRM_1780330710882", "COMMENTS", "DESCRIPTION"])
      || serviceTypeResolved
      || params.serviceType,
    vertical: serviceCategoryStr[0] || serviceCategoryEnum || params.serviceType
  });
}

function resolveEnumId(enumMap: Record<string, string>, raw: unknown): string {
  const id = String(raw ?? "").trim();
  return id ? (enumMap[id] ?? "") : "";
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

function readAsStringArray(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      const arr = value.map((v) => String(v ?? "").trim()).filter(Boolean);
      if (arr.length) return arr;
    }
    if (typeof value === "string" && value.trim()) {
      return value.split(/[,;|]/).map((v) => v.trim()).filter(Boolean);
    }
  }
  return [];
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
    const dealPaymentWidgetBind = await bindBitrixDealPaymentWidget();
    const dealFundingWidgetBind = await bindBitrixDealFundingWidget();
    const dealSmsWidgetBind = await bindBitrixDealSmsWidget();
    const dealCardDatesWidgetBind = await bindBitrixDealCardDatesWidget();
    const callCardWidgetBind = await bindBitrixCallCardWidget();
    const status = await getBitrixConnectorStatus();
    let appInstall: unknown;
    try {
      appInstall = await markBitrixAppInstalled();
    } catch (e) {
      appInstall = { error: e instanceof Error ? e.message : "app.install failed" };
    }

    return res.status(200).send(`
      <html>
        <head>
          <script src="//api.bitrix24.com/api/v1/"></script>
        </head>
        <body style="font-family: sans-serif;">
          <h2>Telnyx SMS connector installed</h2>
          <p>Connector registered and activated for line ${config.bitrixLineId}.</p>
          <pre>${JSON.stringify({ register, activate, eventBind, dealEventBind, leadEventBind, dealPaymentWidgetBind, dealFundingWidgetBind, dealSmsWidgetBind, dealCardDatesWidgetBind, callCardWidgetBind, status, appInstall }, null, 2)}</pre>
          <script>
            BX24.init(function() {
              BX24.installFinish();
            });
          </script>
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
    const dealPaymentWidgetBind = await bindBitrixDealPaymentWidget();
    const dealFundingWidgetBind = await bindBitrixDealFundingWidget();
    const dealSmsWidgetBind = await bindBitrixDealSmsWidget();
    const dealCardDatesWidgetBind = await bindBitrixDealCardDatesWidget();
    const callCardWidgetBind = await bindBitrixCallCardWidget();
    const status = await getBitrixConnectorStatus();
    let appInstall: unknown;
    try {
      appInstall = await markBitrixAppInstalled();
    } catch (e) {
      appInstall = { error: e instanceof Error ? e.message : "app.install failed" };
    }
    return res.status(200).json({ ok: true, register, activate, eventBind, dealEventBind, leadEventBind, dealPaymentWidgetBind, dealFundingWidgetBind, dealSmsWidgetBind, dealCardDatesWidgetBind, callCardWidgetBind, status, appInstall });
  } catch (error) {
    console.error("Failed to register Bitrix connector", error);
    return res.status(500).json({ ok: false, error: "Bitrix connector registration failed" });
  }
});

app.all("/bitrix/widgets/deal-funding", async (req: Request, res: Response) => {
  const placementOptions = parsePlacementOptions({
    PLACEMENT_OPTIONS: (req.body as Record<string, unknown>)?.PLACEMENT_OPTIONS ?? req.query.PLACEMENT_OPTIONS
  });
  const dealId = String(placementOptions.ID ?? "").trim();

  if (!dealId) {
    return res.status(200).send(renderFundingMatchesHtml({
      dealId: "Not found",
      matchParams: {},
      results: [],
      error: "Missing deal ID from Bitrix placement context."
    }));
  }

  try {
    const dealResponse = await getBitrixDealById(dealId);
    const deal = (dealResponse.result ?? {}) as Record<string, unknown>;
    const serviceType = buildLeadServiceType(deal);
    const postalCode = readFirstNonEmptyString(deal, [
      "UF_CRM_POSTAL_CODE",
      "ADDRESS_POSTAL_CODE",
      "POSTAL_CODE"
    ]);
    const matchParams = buildDealMatchParamsFromBitrixDeal({ deal, serviceType, postalCode });
    const matchData = await fetchDealMatchData(matchParams);
    const results = extractFundingResults(matchData);
    const totalMatches = isPlainRecord(matchData) && isPlainRecord(matchData.data)
      ? matchData.data.totalMatches
      : undefined;

    void updateBitrixDealFields({
      dealId,
      fields: {
        [DEAL_MATCH_BITRIX_FIELD]: formatFundingDetailsSummary(matchData)
      }
    }).catch((err: unknown) => {
      console.error("Failed to sync funding field from widget", err instanceof Error ? err.message : err);
    });

    return res.status(200).send(renderFundingMatchesHtml({
      dealId,
      matchParams,
      results,
      totalMatches
    }));
  } catch (error) {
    console.error("Failed to render funding matches widget", error);
    return res.status(200).send(renderFundingMatchesHtml({
      dealId,
      matchParams: {},
      results: [],
      error: error instanceof Error ? error.message : "Funding matches could not be loaded."
    }));
  }
});

const stageColorCache = new Map<string, string>();

async function getStageColor(stageId: string): Promise<string> {
  if (stageColorCache.has(stageId)) {
    return stageColorCache.get(stageId)!;
  }

  // stageId format: "C{categoryId}:{statusId}" for pipelines, or plain "{statusId}" for default
  const pipelineMatch = stageId.match(/^C(\d+):(.+)$/i);
  const entityId = pipelineMatch ? `DEAL_STAGE_${pipelineMatch[1]}` : "DEAL_STAGE";
  const statusId = pipelineMatch ? pipelineMatch[2] : stageId;

  try {
    const response = await listBitrixStatuses({ ENTITY_ID: entityId, STATUS_ID: statusId });
    const statuses = response.result ?? [];
    const color = String((statuses[0] as Record<string, unknown>)?.COLOR ?? "").trim();
    const resolved = color ? (color.startsWith("#") ? color : `#${color}`) : "#b0bec5";
    stageColorCache.set(stageId, resolved);
    if (stageColorCache.size > 500) {
      stageColorCache.delete(stageColorCache.keys().next().value!);
    }
    return resolved;
  } catch {
    return "#b0bec5";
  }
}

app.all("/bitrix/widgets/deal-card-dates", async (req: Request, res: Response) => {
  const placementOptions = parsePlacementOptions({
    PLACEMENT_OPTIONS: (req.body as Record<string, unknown>)?.PLACEMENT_OPTIONS ?? req.query.PLACEMENT_OPTIONS
  });
  const dealId = String(placementOptions.ID ?? "").trim();

  if (!dealId) {
    return res.status(200).send(`<div style="font-family:sans-serif;font-size:11px;color:#999;padding:2px 0;">No deal ID</div>`);
  }

  try {
    const dealResponse = await getBitrixDealById(dealId);
    const deal = (dealResponse.result ?? {}) as Record<string, unknown>;
    const stageId = String(deal.STAGE_ID ?? "").trim();

    function formatDate(value: unknown): string {
      if (!value || value === "0000-00-00T00:00:00+00:00" || value === "0001-01-01T00:00:00+00:00") {
        return "—";
      }
      const d = new Date(String(value));
      if (isNaN(d.getTime())) return "—";
      return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
    }

    const [startDate, endDate, stageColor] = await Promise.all([
      Promise.resolve(formatDate(deal.BEGINDATE)),
      Promise.resolve(formatDate(deal.CLOSEDATE)),
      stageId ? getStageColor(stageId) : Promise.resolve("#b0bec5")
    ]);

    const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 11px; color: #344054; background: transparent; }
      .accent { height: 3px; width: 100%; background: ${escapeHtml(stageColor)}; border-radius: 2px 2px 0 0; margin-bottom: 5px; }
      .row { display: flex; align-items: center; gap: 6px; line-height: 1.4; padding: 0 0 3px; }
      .label { color: #98a2b3; min-width: 32px; }
      .val { color: #101828; font-weight: 500; }
      .sep { color: #d0d5dd; margin: 0 2px; }
    </style>
  </head>
  <body>
    <div class="accent"></div>
    <div class="row">
      <span class="label">Start</span><span class="val">${escapeHtml(startDate)}</span>
      <span class="sep">·</span>
      <span class="label">End</span><span class="val">${escapeHtml(endDate)}</span>
    </div>
  </body>
</html>`;

    return res.status(200).send(html);
  } catch (error) {
    console.error("Failed to render deal card dates widget", error);
    return res.status(200).send(`<div style="font-family:sans-serif;font-size:11px;color:#b42318;padding:2px 0;">Could not load dates</div>`);
  }
});

app.all("/bitrix/widgets/deal-sms", async (req: Request, res: Response) => {
  const placementOptions = parsePlacementOptions({
    PLACEMENT_OPTIONS: (req.body as Record<string, unknown>)?.PLACEMENT_OPTIONS ?? req.query.PLACEMENT_OPTIONS
  });
  const dealId = String(placementOptions.ID ?? "").trim();

  function renderSmsHtml(params: { dealId: string; phone: string; messages: Array<{ direction: "inbound" | "outbound"; text: string; at: string }>; error?: string }): string {
    const myNumber = config.telnyxFromNumber ?? "";
    const rows = params.messages.map((m) => {
      const isMine = m.direction === "outbound";
      const time = new Date(m.at).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      return `<div class="msg ${isMine ? "out" : "in"}"><div class="bubble">${escapeHtml(m.text)}</div><div class="ts">${time}</div></div>`;
    }).join("");

    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SMS History</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      body { margin: 0; padding: 12px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px; background: #f6f8fb; color: #1a1a1a; }
      .header { margin-bottom: 10px; }
      .header h1 { font-size: 15px; margin: 0 0 2px; }
      .header .sub { color: #667085; font-size: 12px; }
      .thread { display: flex; flex-direction: column; gap: 6px; }
      .msg { display: flex; flex-direction: column; max-width: 80%; }
      .msg.out { align-self: flex-end; align-items: flex-end; }
      .msg.in { align-self: flex-start; align-items: flex-start; }
      .bubble { padding: 8px 11px; border-radius: 14px; line-height: 1.4; word-break: break-word; }
      .out .bubble { background: #0b66ff; color: #fff; border-bottom-right-radius: 4px; }
      .in .bubble { background: #fff; border: 1px solid #dfe5ef; border-bottom-left-radius: 4px; }
      .ts { font-size: 10px; color: #99a0ad; margin-top: 2px; padding: 0 4px; }
      .empty { color: #667085; font-size: 13px; padding: 8px 0; }
      .error { color: #b42318; background: #fffbfa; border: 1px solid #fecdca; border-radius: 8px; padding: 10px; }
    </style>
  </head>
  <body>
    <div class="header">
      <h1>SMS History</h1>
      <div class="sub">${params.phone ? `${escapeHtml(params.phone)} ↔ ${escapeHtml(myNumber)}` : `Deal ${escapeHtml(params.dealId)}`}</div>
    </div>
    ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ""}
    ${!params.error && params.messages.length ? `<div class="thread">${rows}</div>` : ""}
    ${!params.error && !params.messages.length ? `<div class="empty">No SMS messages found for this contact.</div>` : ""}
  </body>
</html>`;
  }

  if (!dealId) {
    return res.status(200).send(renderSmsHtml({ dealId: "unknown", phone: "", messages: [], error: "Missing deal ID from Bitrix placement context." }));
  }

  try {
    const dealResponse = await getBitrixDealById(dealId);
    const deal = (dealResponse.result ?? {}) as Record<string, unknown>;
    const contactId = normalizeBitrixEntityId(deal.CONTACT_ID);

    let phone = "";
    if (contactId) {
      const contactResponse = await getBitrixContactById(contactId);
      const contact = (contactResponse.result ?? {}) as Record<string, unknown>;
      phone = normalizePhoneForSms(readLeadContactValue(contact.PHONE));
    }

    if (!phone) {
      return res.status(200).send(renderSmsHtml({ dealId, phone: "", messages: [], error: "No phone number found on the contact linked to this deal." }));
    }

    const myNumber = config.telnyxFromNumber ?? "";
    const records = await listTelnyxSmsRecordsByPhone(phone);
    const messages = records
      .filter((r) => r.text)
      .map((r) => ({
        direction: (r.from === phone ? "inbound" : "outbound") as "inbound" | "outbound",
        text: r.text,
        at: r.receivedAt
      }));

    return res.status(200).send(renderSmsHtml({ dealId, phone, messages }));
  } catch (error) {
    console.error("Failed to render SMS history widget", error);
    return res.status(200).send(renderSmsHtml({ dealId, phone: "", messages: [], error: error instanceof Error ? error.message : "SMS history could not be loaded." }));
  }
});

app.all("/bitrix/widgets/deal-payment", async (req: Request, res: Response) => {
  const placementOptionsRaw =
    String((req.body as Record<string, unknown>)?.PLACEMENT_OPTIONS ?? req.query.PLACEMENT_OPTIONS ?? "{}");

  let dealId = "";
  try {
    const parsed = JSON.parse(placementOptionsRaw) as Record<string, unknown>;
    dealId = String(parsed.ID ?? "").trim();
  } catch {
    dealId = "";
  }

  const inboundSecret = config.inboundDealWebhookSecret;
  const html = `
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Send Payment Link</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; margin: 16px; color: #222; }
          .wrap { max-width: 480px; }
          .row { margin-bottom: 10px; }
          .btn { border: 0; border-radius: 8px; padding: 10px 14px; cursor: pointer; margin-right: 8px; }
          .deposit { background: #0b66ff; color: white; }
          .callout { background: #14532d; color: white; }
          .hint { color: #666; font-size: 12px; }
          .out { margin-top: 12px; font-size: 13px; white-space: pre-wrap; background: #f5f7fa; padding: 10px; border-radius: 8px; }
          .error { color: #b91c1c; }
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="row"><strong>Deal ID:</strong> <span id="dealId">${dealId || "Not found"}</span></div>
          <div class="row">
            <button class="btn deposit" id="sendDeposit">Send Deposit Link</button>
            <button class="btn callout" id="sendCallout">Send Callout Link</button>
          </div>
          <div class="hint">This sends payment link via SMS and email using the current Deal context.</div>
          <div class="out" id="out">Ready.</div>
        </div>
        <script>
          const dealId = ${JSON.stringify(dealId)};
          const out = document.getElementById("out");

          async function sendPayment(paymentType) {
            if (!dealId) {
              out.innerHTML = '<span class="error">Missing deal ID from placement context.</span>';
              return;
            }

            out.textContent = "Sending...";
            try {
              const response = await fetch("/webhooks/inbound/bitrix/deals/payment-links", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-inbound-secret": ${JSON.stringify(inboundSecret)}
                },
                body: JSON.stringify({
                  dealId,
                  paymentType
                })
              });

              const json = await response.json();
              if (!response.ok) {
                out.innerHTML = '<span class="error">' + (json.error || "Request failed") + '</span>';
                return;
              }

              out.textContent = JSON.stringify({
                ok: json.ok,
                paymentType: json.paymentType,
                link: json.link,
                sms: json.sms,
                email: json.email
              }, null, 2);
            } catch (error) {
              out.innerHTML = '<span class="error">' + (error?.message || "Unexpected error") + '</span>';
            }
          }

          document.getElementById("sendDeposit").addEventListener("click", () => sendPayment("deposit"));
          document.getElementById("sendCallout").addEventListener("click", () => sendPayment("callout"));
        </script>
      </body>
    </html>
  `;

  return res.status(200).send(html);
});

app.all("/bitrix/widgets/call-card", (req: Request, res: Response) => {
  const placementOptionsRaw = String(
    (req.body as Record<string, unknown>)?.PLACEMENT_OPTIONS ?? req.query.PLACEMENT_OPTIONS ?? "{}"
  );

  let phoneNumber = "";
  let callId = "";
  let userId = "";
  try {
    const opts = JSON.parse(placementOptionsRaw) as Record<string, unknown>;
    phoneNumber = String(opts.PHONE_NUMBER ?? "").trim();
    callId = String(opts.CALL_ID ?? "").trim();
    userId = String(opts.USER_ID ?? "").trim();
  } catch {
    // ignore parse errors
  }

  // When Bitrix opens the call card for an agent, look up their email and cache it by customer
  // phone number so Balto can identify the correct agent when call.answered fires from Telnyx.
  if (config.baltoEnabled && userId && phoneNumber) {
    getBitrixUserById(userId)
      .then(response => {
        const user = Array.isArray(response.result) ? response.result[0] : undefined;
        const email = String(user?.EMAIL ?? user?.email ?? "").trim();
        if (email) {
          callAgentByPhone.set(phoneNumber, { agentEmail: email, bitrixCallId: callId, storedAt: Date.now() });
          trimMap(callAgentByPhone);
        }
      })
      .catch((err: unknown) => console.warn("Failed to resolve Bitrix agent email for call card", { userId, phoneNumber, err }));
  }

  const inboundSecret = config.inboundDealWebhookSecret;

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CSR First Call Intake</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 12px 14px 20px; font-size: 13px; color: #1a1a1a; background: #fff; }
      h2 { font-size: 15px; margin: 0 0 14px; color: #111; }
      h3 { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #666; margin: 16px 0 8px; border-bottom: 1px solid #eee; padding-bottom: 4px; }
      h3:first-of-type { margin-top: 0; }
      label { display: block; font-size: 12px; color: #444; margin-bottom: 3px; }
      input[type="text"], input[type="tel"], textarea, select {
        width: 100%; border: 1px solid #ccc; border-radius: 6px; padding: 6px 8px;
        font-size: 13px; color: #111; background: #fafafa; outline: none;
        transition: border-color .15s;
      }
      input:focus, textarea:focus, select:focus { border-color: #0b66ff; background: #fff; }
      textarea { resize: vertical; min-height: 64px; }
      .row { margin-bottom: 8px; }
      .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .checks { display: flex; flex-wrap: wrap; gap: 6px; }
      .checks label { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #333; margin: 0; cursor: pointer; }
      .checks input[type="checkbox"] { width: auto; }
      .btn-submit {
        margin-top: 16px; width: 100%; padding: 10px; border: 0; border-radius: 8px;
        background: #0b66ff; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
      }
      .btn-submit:disabled { background: #93b8ff; cursor: default; }
      .out { margin-top: 10px; font-size: 12px; white-space: pre-wrap; background: #f5f7fa; padding: 10px; border-radius: 8px; display: none; }
      .out.visible { display: block; }
      .out.error { color: #b91c1c; background: #fff5f5; }
      .out.success { color: #14532d; background: #f0fdf4; }
    </style>
  </head>
  <body>
    <h2>CSR First Call Intake</h2>
    <form id="intakeForm" novalidate>

      <h3>Customer Basics</h3>
      <div class="row">
        <label>Full Name *</label>
        <input type="text" name="fullName" required placeholder="Jane Doe" />
      </div>
      <div class="grid2">
        <div class="row">
          <label>Phone Number *</label>
          <input type="tel" name="phoneNumber" required value="${phoneNumber}" placeholder="4035551234" />
        </div>
        <div class="row">
          <label>Customer Type *</label>
          <select name="customerType" required>
            <option value="Owner">Owner</option>
            <option value="Tenant">Tenant</option>
            <option value="Property Manager">Property Manager</option>
            <option value="Strata/HOA">Strata/HOA</option>
            <option value="Other">Other</option>
          </select>
        </div>
      </div>
      <div class="row">
        <label>Service Address *</label>
        <input type="text" name="serviceAddress" required placeholder="123 Main St" />
      </div>
      <div class="grid2">
        <div class="row">
          <label>City *</label>
          <input type="text" name="city" required placeholder="Calgary" />
        </div>
        <div class="row">
          <label>Province / State *</label>
          <input type="text" name="provinceState" required placeholder="Alberta" />
        </div>
      </div>
      <div class="row">
        <label>Country *</label>
        <input type="text" name="country" required value="Canada" placeholder="Canada" />
      </div>

      <h3>Service Request</h3>
      <div class="row">
        <label>Service Category *</label>
        <div class="checks" id="categoryChecks">
          ${["Plumbing","Electrical","HVAC","Appliances","Carpentry","Painting","Roofing","Flooring","Windows & Doors","General Maintenance"].map(c =>
            `<label><input type="checkbox" name="serviceCategory" value="${c}" />${c}</label>`
          ).join("")}
        </div>
      </div>
      <div class="row">
        <label>Service Types</label>
        <div class="checks">
          ${["Pipe Leak / Burst Pipe","Drain Clog","Water Heater","Toilet Issues","Faucet / Fixture","Outlet / Switch","Panel / Breaker","Light Fixture","Wiring Issues","Furnace / Boiler","Air Conditioning","Ventilation / Ducts","Thermostat","Appliance Repair","Roof Leak","General Repair","Other"].map(t =>
            `<label><input type="checkbox" name="serviceTypes" value="${t}" />${t}</label>`
          ).join("")}
        </div>
      </div>
      <div class="row">
        <label>Issue Description</label>
        <textarea name="issueDescription" placeholder="Describe the issue..."></textarea>
      </div>

      <h3>Location of Issue</h3>
      <div class="checks">
        ${["Kitchen","Bathroom (Main)","Bathroom (En-Suite)","Basement","Living Room","Dining Room","Bedroom(s)","Laundry Room","Garage","Attic","Exterior / Yard","Other"].map(l =>
          `<label><input type="checkbox" name="locationOfIssue" value="${l}" />${l}</label>`
        ).join("")}
      </div>

      <h3>Urgency</h3>
      <div class="row">
        <select name="urgency" required>
          <option value="Urgent (24-48 hrs)">Urgent (24-48 hrs)</option>
          <option value="Non-Urgent (3-5 days)">Non-Urgent (3-5 days)</option>
          <option value="Flexible">Flexible / Not Time-Sensitive</option>
        </select>
      </div>

      <button type="submit" class="btn-submit" id="submitBtn">Submit Intake</button>
    </form>
    <div class="out" id="out"></div>

    <script>
      const INBOUND_SECRET = ${JSON.stringify(inboundSecret)};
      const CALL_ID = ${JSON.stringify(callId)};
      const form = document.getElementById("intakeForm");
      const out = document.getElementById("out");
      const btn = document.getElementById("submitBtn");

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(form);

        const fullName = fd.get("fullName")?.toString().trim() ?? "";
        const phoneNumber = fd.get("phoneNumber")?.toString().trim() ?? "";
        if (!fullName || !phoneNumber) {
          out.className = "out visible error";
          out.textContent = "Full Name and Phone Number are required.";
          return;
        }

        const serviceCategory = fd.getAll("serviceCategory").map(String);
        if (!serviceCategory.length) {
          out.className = "out visible error";
          out.textContent = "Please select at least one Service Category.";
          return;
        }

        btn.disabled = true;
        btn.textContent = "Submitting...";
        out.className = "out";
        out.textContent = "";

        const payload = {
          callId: CALL_ID,
          customerBasics: {
            fullName,
            phoneNumber,
            serviceAddress: fd.get("serviceAddress")?.toString().trim() ?? "",
            city: fd.get("city")?.toString().trim() ?? "",
            country: fd.get("country")?.toString().trim() ?? "",
            provinceState: fd.get("provinceState")?.toString().trim() ?? "",
            customerType: fd.get("customerType")?.toString() ?? "Owner"
          },
          serviceRequest: {
            serviceCategory,
            serviceTypes: fd.getAll("serviceTypes").map(String),
            issueDescription: fd.get("issueDescription")?.toString().trim() ?? ""
          },
          locationOfIssue: fd.getAll("locationOfIssue").map(String),
          urgency: fd.get("urgency")?.toString() ?? "Urgent (24-48 hrs)"
        };

        try {
          const res = await fetch("/webhooks/inbound/bitrix/csr-intake", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-inbound-secret": INBOUND_SECRET
            },
            body: JSON.stringify(payload)
          });
          const json = await res.json();
          if (!res.ok) {
            out.className = "out visible error";
            out.textContent = json.error ?? "Submission failed.";
          } else {
            out.className = "out visible success";
            out.textContent = "Intake submitted successfully." + (json.dealId ? " Deal #" + json.dealId + " created." : "");
            form.reset();
            document.querySelector('input[name="phoneNumber"]').value = ${JSON.stringify(phoneNumber)};
          }
        } catch (err) {
          out.className = "out visible error";
          out.textContent = err?.message ?? "Unexpected error.";
        } finally {
          btn.disabled = false;
          btn.textContent = "Submit Intake";
        }
      });
    </script>
  </body>
</html>`;

  return res.status(200).send(html);
});

app.post("/webhooks/inbound/bitrix/csr-intake", async (req: Request, res: Response) => {
  const secret = req.headers["x-inbound-secret"];
  if (!config.inboundDealWebhookSecret || secret !== config.inboundDealWebhookSecret) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const body = req.body as {
    callId?: string;
    customerBasics?: {
      fullName?: string;
      phoneNumber?: string;
      serviceAddress?: string;
      city?: string;
      country?: string;
      provinceState?: string;
      customerType?: string;
    };
    serviceRequest?: {
      serviceCategory?: string[];
      serviceTypes?: string[];
      issueDescription?: string;
    };
    locationOfIssue?: string[];
    urgency?: string;
  };

  const { customerBasics, serviceRequest, locationOfIssue, urgency } = body;

  if (!customerBasics?.fullName || !customerBasics?.phoneNumber) {
    return res.status(400).json({ ok: false, error: "fullName and phoneNumber are required" });
  }

  const intakePayload = {
    payload: {
      customerBasics,
      serviceRequest,
      locationOfIssue,
      urgency
    }
  };

  const dealTitle = [
    customerBasics.fullName,
    serviceRequest?.serviceCategory?.join(" / ") || "Service Request"
  ].join(" - ");

  const dealComments = [
    `Phone: ${customerBasics.phoneNumber}`,
    `Address: ${[customerBasics.serviceAddress, customerBasics.city, customerBasics.provinceState, customerBasics.country].filter(Boolean).join(", ")}`,
    `Customer Type: ${customerBasics.customerType ?? ""}`,
    `Service: ${serviceRequest?.serviceCategory?.join(", ") ?? ""}${serviceRequest?.serviceTypes?.length ? " — " + serviceRequest.serviceTypes.join(", ") : ""}`,
    `Issue: ${serviceRequest?.issueDescription ?? ""}`,
    `Location: ${locationOfIssue?.join(", ") ?? ""}`,
    `Urgency: ${urgency ?? ""}`
  ].join("\n");

  const [webhookResult, dealResult] = await Promise.allSettled([
    axios.post(config.csrIntakeWebhookUrl, intakePayload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000
    }),
    createBitrixDeal({
      TITLE: dealTitle,
      COMMENTS: dealComments,
      OPENED: "Y",
      UF_CRM_1780329478655: customerBasics?.city ?? "",
      UF_CRM_1780329497687: customerBasics?.country ?? "",
      UF_CRM_1780329514570: customerBasics?.provinceState ?? "",
      UF_CRM_1780329566834: customerBasics?.customerType ?? "",
      UF_CRM_1779476638723: customerBasics?.serviceAddress ?? "",
      UF_CRM_1779476686823: urgency ?? "",
      UF_CRM_1780329708763: serviceRequest?.serviceCategory?.join(", ") ?? "",
      UF_CRM_1780330710882: serviceRequest?.issueDescription ?? "",
      UF_CRM_1780331059027: locationOfIssue?.join(", ") ?? ""
    })
  ]);

  const webhookOk = webhookResult.status === "fulfilled";
  const dealId = dealResult.status === "fulfilled"
    ? (dealResult.value as { result?: number }).result
    : undefined;

  if (!webhookOk) {
    console.error("CSR intake webhook failed", webhookResult.reason);
  }
  if (dealResult.status === "rejected") {
    console.error("Bitrix deal creation failed", dealResult.reason);
  }

  if (dealId) {
    updateDealMatchesFieldNonBlocking({
      dealId: String(dealId),
      matchParams: buildDealMatchParamsFromCsrIntake({ customerBasics, serviceRequest }),
      source: "csr-intake"
    });
  }

  if (webhookOk && dealId) {
    try {
      const intakeData = (webhookResult.value as { data?: { data?: { serviceVertical?: string; samDispatch?: { vendors?: Array<Record<string, unknown>> } } } }).data?.data;
      const vendors = intakeData?.samDispatch?.vendors ?? [];
      if (vendors.length) {
        await updateBitrixDealFields({
          dealId: String(dealId),
          fields: { UF_CRM_1780342754: formatMatchedVendors(vendors) }
        });
      } else {
        const serviceVertical = intakeData?.serviceVertical || serviceRequest?.serviceCategory?.[0] || "";
        if (serviceVertical) {
          const pipeline = getVendorAcquisitionPipeline(serviceVertical);
          await moveDealToVendorAcquisitionPipeline({
            dealId: String(dealId),
            pipeline
          });
          console.log(`No vendors found — moved deal ${dealId} to pipeline ${pipeline.categoryId} (${serviceVertical})`);
        }
      }
    } catch (err) {
      console.error("Failed to update matched vendors field", err instanceof Error ? err.message : err);
    }
  }

  return res.status(200).json({
    ok: true,
    webhookOk,
    dealId: dealId ?? null
  });
});

async function disableBitrixCallCardWidget(_req: Request, res: Response) {
  try {
    const callCardWidgetUnbind = await unbindBitrixCallCardWidget();
    return res.status(200).json({
      ok: true,
      disabled: true,
      message: "Custom CALL_CARD widget is disabled so Bitrix can use its default call popup.",
      callCardWidgetUnbind
    });
  } catch (error) {
    console.error("Failed to unbind Bitrix call card widget", error);
    return res.status(500).json({ ok: false, error: "Bitrix CALL_CARD widget unbind failed" });
  }
}

app.post("/bitrix/call-card/register", async (_req: Request, res: Response) => {
  try {
    const callCardWidgetBind = await bindBitrixCallCardWidget();
    return res.status(200).json({
      ok: true,
      enabled: true,
      message: "Custom CALL_CARD widget is enabled so the CSR Intake form appears in the call card.",
      callCardWidgetBind
    });
  } catch (error) {
    console.error("Failed to bind Bitrix call card widget", error);
    return res.status(500).json({ ok: false, error: "Bitrix CALL_CARD widget bind failed" });
  }
});
app.post("/bitrix/call-card/unregister", disableBitrixCallCardWidget);

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

app.get("/debug/balto/call-sessions", async (req: Request, res: Response) => {
  const rawLimit = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
  try {
    return res.status(200).json({ ok: true, records: await listBaltoCallSessions(limit) });
  } catch (error) {
    console.error("Failed to read Balto call sessions", error);
    return res.status(500).json({ ok: false, error: "Balto call session lookup failed" });
  }
});

app.post("/debug/balto/call-data/sync", async (req: Request, res: Response) => {
  if (!verifyThirdPartyWebhookSecret(req) || !verifyInboundDealSecret(req)) {
    return res.status(401).json({ ok: false, error: "Invalid sync secret" });
  }

  const body = req.body as { startDate?: string; endDate?: string };
  const today = new Date().toISOString().slice(0, 10);
  const startDate = String(body.startDate ?? today).trim();
  const endDate = String(body.endDate ?? startDate).trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(400).json({ ok: false, error: "startDate and endDate must use YYYY-MM-DD format" });
  }

  try {
    const records = await syncBaltoCallData({ startDate, endDate });
    for (const record of records) {
      await upsertBaltoCallDataRecord(record);
    }
    return res.status(200).json({ ok: true, startDate, endDate, synced: records.length });
  } catch (error) {
    console.error("Failed to sync Balto call data", error);
    return res.status(500).json({ ok: false, error: "Balto call data sync failed" });
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

app.get("/debug/bitrix/deals/fields", async (_req: Request, res: Response) => {
  try {
    const fieldsResponse = await listBitrixDealFields();
    const fields = (fieldsResponse.result ?? {}) as Record<string, unknown>;
    return res.status(200).json({ ok: true, count: Object.keys(fields).length, fields });
  } catch (error) {
    console.error("Failed to load Bitrix deal fields", error);
    return res.status(500).json({ ok: false, error: "Bitrix deal fields lookup failed" });
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

app.post("/webhooks/inbound/bitrix/channel/message", async (req: Request, res: Response) => {
  if (!verifyThirdPartyWebhookSecret(req)) {
    return res.status(401).json({ ok: false, error: "Invalid third-party webhook secret" });
  }

  const body = req.body as {
    customerPhone?: string;
    text?: string;
    replyWebhookUrl?: string;
    deliverSmsReplies?: boolean;
    destinationPhone?: string;
    externalMessageId?: string;
  };

  const customerPhone = normalizePhoneForSms(String(body.customerPhone ?? ""));
  const text = String(body.text ?? "").trim();
  const replyWebhookUrl = String(body.replyWebhookUrl ?? "").trim();

  if (!customerPhone || !text || !replyWebhookUrl) {
    return res.status(400).json({
      ok: false,
      error: "Missing customerPhone, text, or replyWebhookUrl"
    });
  }

  try {
    thirdPartyReplyRouteByPhone.set(customerPhone, {
      webhookUrl: replyWebhookUrl,
      deliverSmsReplies: Boolean(body.deliverSmsReplies)
    });
    trimMap(thirdPartyReplyRouteByPhone);

    const bitrixResponse = await sendToBitrixOpenChannel({
      sourcePhone: customerPhone,
      destinationPhone: String(body.destinationPhone ?? config.telnyxFromNumber),
      text,
      externalMessageId: String(body.externalMessageId ?? `thirdparty-${Date.now()}`),
      eventTimestamp: new Date().toISOString()
    });
    rememberBitrixSession(bitrixResponse);
    const answer = await answerBitrixSessionIfPossible(bitrixResponse);

    return res.status(200).json({
      ok: true,
      customerPhone,
      replyWebhookUrl,
      deliverSmsReplies: Boolean(body.deliverSmsReplies),
      bitrix: bitrixResponse,
      answer
    });
  } catch (error) {
    console.error("Failed to send third-party message into Bitrix channel", error);
    return res.status(500).json({ ok: false, error: "Third-party channel send failed" });
  }
});

app.post("/webhooks/inbound/bitrix/employee/message", async (req: Request, res: Response) => {
  if (!verifyThirdPartyWebhookSecret(req)) {
    return res.status(401).json({ ok: false, error: "Invalid third-party webhook secret" });
  }

  const body = req.body as {
    employeeEmail?: string;
    text?: string;
    customerPhone?: string;
    replyWebhookUrl?: string;
  };

  const employeeEmail = String(body.employeeEmail ?? "").trim().toLowerCase();
  const text = String(body.text ?? "").trim();

  if (!employeeEmail || !text) {
    return res.status(400).json({ ok: false, error: "Missing employeeEmail or text" });
  }

  try {
    const usersResponse = await findBitrixUserByEmail(employeeEmail);
    const users = (usersResponse.result ?? []) as Array<Record<string, unknown>>;
    const firstUser = users[0] ?? null;
    const userId = String(firstUser?.ID ?? "");
    if (!userId) {
      return res.status(404).json({ ok: false, error: "Employee not found by email" });
    }

    const customerPhone = normalizePhoneForSms(String(body.customerPhone ?? ""));
    const replyWebhookUrl = String(body.replyWebhookUrl ?? "").trim();
    if (customerPhone && replyWebhookUrl) {
      thirdPartyReplyRouteByPhone.set(customerPhone, {
        webhookUrl: replyWebhookUrl,
        deliverSmsReplies: false
      });
      trimMap(thirdPartyReplyRouteByPhone);
    }

    const bitrix = await sendBitrixInternalMessage({
      userId,
      text
    });

    return res.status(200).json({
      ok: true,
      employeeEmail,
      employeeId: userId,
      bitrix
    });
  } catch (error) {
    console.error("Failed to send third-party message to Bitrix employee inbox", error);
    return res.status(500).json({ ok: false, error: "Employee inbox send failed" });
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
    const balto = await handleBaltoTelnyxCallEvent(body, record);

    if (record.outboundForward?.enabled) {
      record.status = record.outboundForward.delivered ? "forwarded_call_event" : "call_forward_failed";
      await saveTelnyxWebhookRecord(record);
    }

    return res.status(200).json({
      ok: true,
      callEvent: true,
      forwarded: Boolean(record.outboundForward?.enabled && record.outboundForward.delivered),
      balto
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

  const thirdPartyRoute = thirdPartyReplyRouteByPhone.get(phone);
  if (thirdPartyRoute) {
    try {
      const callbackStatus = await forwardBitrixReplyToThirdParty({
        webhookUrl: thirdPartyRoute.webhookUrl,
        phone,
        text,
        messageId,
        chatId,
        bitrixUserId,
        rawEvent: req.body
      });

      if (!thirdPartyRoute.deliverSmsReplies) {
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
        return res.status(200).json({ ok: true, forwardedToThirdParty: true, callbackStatus });
      }
    } catch (error) {
      if (!thirdPartyRoute.deliverSmsReplies) {
        console.error("Failed to forward Bitrix reply to third-party webhook", error);
        return res.status(502).json({ ok: false, error: "Third-party callback failed" });
      }
    }
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
  let stageId = String(stageIdRaw || "");

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
      urgencyLevel: "",
      dealTitle: "",
      pipelineId: "",
      pipelineName: "",
      stageName: ""
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
      dealTitle: dealDetails.dealTitle,
      pipelineId: dealDetails.pipelineId,
      pipelineName: dealDetails.pipelineName,
      stageName: dealDetails.stageName,
      rawBody: payload
    };
    let outboundForward: Awaited<ReturnType<typeof forwardBitrixDealRecord>> | undefined;

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
      if (!stageId) {
        stageId = String(deal.STAGE_ID ?? "").trim();
      }
      const pipelineId = String(deal.CATEGORY_ID ?? "").trim();
      const dealTitle = String(deal.TITLE ?? "").trim();
      const contactIdRaw = deal.CONTACT_ID ?? fields.CONTACT_ID ?? "";
      const contactId = normalizeBitrixEntityId(contactIdRaw);
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
      dealDetails.dealTitle = dealTitle;
      dealDetails.pipelineId = pipelineId;
      dealDetails.addressPostalCode = [address, postalCode].filter(Boolean).join(" / ");

      try {
        if (pipelineId) {
          const categoriesResponse = await listBitrixDealCategories();
          const categories = (categoriesResponse.result ?? []) as Array<Record<string, unknown>>;
          const matchingCategory = categories.find((item) => String(item.ID ?? "") === pipelineId);
          dealDetails.pipelineName = String(matchingCategory?.NAME ?? "").trim();
        }

        const entityId = pipelineId ? `DEAL_STAGE_${pipelineId}` : "DEAL_STAGE";
        const stagesResponse = await listBitrixStatuses({ ENTITY_ID: entityId });
        const stages = (stagesResponse.result ?? []) as Array<Record<string, unknown>>;
        const matchingStage = stages.find((item) => normalizeStageId(String(item.STATUS_ID ?? "")) === normalizeStageId(stageId));
        dealDetails.stageName = String(matchingStage?.NAME ?? "").trim();
      } catch (error) {
        console.warn("Failed to enrich pipeline/stage names", error instanceof Error ? error.message : error);
      }

      let csrContact: Record<string, unknown> = {};
      if (contactId) {
        const contactResponse = await getBitrixContactById(contactId);
        const contact = (contactResponse.result ?? {}) as Record<string, unknown>;
        csrContact = contact;
        const customerName = buildLeadCustomerName(contact);
        const customerPhone = normalizePhoneForSms(readLeadContactValue(contact.PHONE));
        const customerEmail = readLeadContactValue(contact.EMAIL);
        const message = buildDealStatusMessage(customerName, serviceType, classification);
        const shouldSendNotifications =
          eventName === "ONCRMDEALADD" &&
          !isDuplicate(processedDealCreateNotifications, `deal-created:${dealId}`);

        dealDetails.clientName = customerName;
        dealDetails.phoneNumber = customerPhone;
        if (!dealDetails.addressPostalCode) {
          const contactAddress = readFirstNonEmptyString(contact, ["ADDRESS", "ADDRESS_1"]);
          const contactPostalCode = readFirstNonEmptyString(contact, ["ADDRESS_POSTAL_CODE", "POSTAL_CODE"]);
          dealDetails.addressPostalCode = [contactAddress, contactPostalCode].filter(Boolean).join(" / ");
        }

        if (shouldSendNotifications) {
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
        }
      } else if (eventName === "ONCRMDEALADD") {
        smsResult.error = "Deal has no CONTACT_ID";
        emailResult.error = "Deal has no CONTACT_ID";
      }

      const finalRecord = {
        ...persistentRecord,
        stageId,
        ...dealDetails,
      };
      await saveBitrixDealRecord(finalRecord);
      outboundForward = await forwardBitrixDealRecord(finalRecord);

      if (eventName === "ONCRMDEALADD") {
        const csrCity = String(deal["UF_CRM_1780329478655"] ?? "").trim();
        const csrCountry = String(deal["UF_CRM_1780329497687"] ?? "").trim() || "Canada";
        const csrProvince = String(deal["UF_CRM_1780329514570"] ?? "").trim();
        const csrCustomerType = String(deal["UF_CRM_1780329566834"] ?? "").trim() || "Owner";
        const csrServiceAddress = String(deal["UF_CRM_1779476638723"] ?? "").trim() || address;
        const csrUrgency = String(deal["UF_CRM_1779476686823"] ?? "").trim() || urgencyLevel || "Urgent (24-48 hrs)";
        const csrIssueDescription = String(deal["UF_CRM_1780330710882"] ?? "").trim()
          || readFirstNonEmptyString(deal, ["COMMENTS", "DESCRIPTION"]);
        const csrLocationOfIssue = readAsStringArray(deal, ["UF_CRM_1780331059027"]);

        // Service category: prefer string field, fall back to enum ID lookup, then legacy service type
        const csrServiceCategoryStr = readAsStringArray(deal, ["UF_CRM_1780329708763"]);
        const csrServiceCategoryEnum = resolveEnumId(BITRIX_SERVICE_CATEGORY_ENUM, deal["UF_CRM_1780330078905"]);
        const csrServiceCategory = csrServiceCategoryStr.length
          ? csrServiceCategoryStr
          : (csrServiceCategoryEnum ? [csrServiceCategoryEnum] : (serviceType ? [serviceType] : []));

        // Service types: enum ID lookup
        const csrServiceTypeResolved = resolveEnumId(BITRIX_SERVICE_TYPES_ENUM, deal["UF_CRM_1780330671084"]);
        const csrServiceTypes = csrServiceTypeResolved ? [csrServiceTypeResolved] : [];

        const csrIntakePayload = {
          payload: {
            customerBasics: {
              fullName: dealDetails.clientName || dealTitle,
              phoneNumber: dealDetails.phoneNumber,
              serviceAddress: csrServiceAddress,
              city: csrCity,
              country: csrCountry,
              provinceState: csrProvince,
              customerType: csrCustomerType
            },
            serviceRequest: {
              serviceCategory: csrServiceCategory,
              serviceTypes: csrServiceTypes,
              issueDescription: csrIssueDescription
            },
            locationOfIssue: csrLocationOfIssue,
            urgency: csrUrgency
          }
        };

        updateDealMatchesFieldNonBlocking({
          dealId,
          matchParams: buildDealMatchParamsFromBitrixDeal({
            deal,
            serviceType,
            postalCode
          }),
          source: "bitrix-deal-create"
        });

        axios.post(config.csrIntakeWebhookUrl, csrIntakePayload, {
          headers: { "Content-Type": "application/json" },
          timeout: 15000
        }).then(async (response) => {
          const intakeData = (response.data as { data?: { serviceVertical?: string; samDispatch?: { vendors?: Array<Record<string, unknown>> } } })?.data;
          const vendors = intakeData?.samDispatch?.vendors ?? [];
          if (vendors.length) {
            await updateBitrixDealFields({
              dealId,
              fields: { UF_CRM_1780342754: formatMatchedVendors(vendors) }
            });
          } else {
            const serviceVertical = intakeData?.serviceVertical || csrServiceCategory[0] || "";
            if (serviceVertical) {
              const pipeline = getVendorAcquisitionPipeline(serviceVertical);
              await moveDealToVendorAcquisitionPipeline({
                dealId,
                pipeline
              });
              console.log(`No vendors found — moved deal ${dealId} to pipeline ${pipeline.categoryId} (${serviceVertical})`);
            }
          }
        }).catch((err: unknown) => {
          console.error("CSR intake webhook failed on deal create", err instanceof Error ? err.message : err);
        });
      }
      if (outboundForward?.enabled) {
        await saveBitrixDealRecord({
          ...finalRecord,
          outboundForward
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Notification lookup failed";
      smsResult.error = reason;
      emailResult.error = reason;
      await saveBitrixDealRecord({
        ...persistentRecord,
        stageId,
        ...dealDetails
      });
    }

    let quotePresentedPaymentLink: {
      triggered: boolean;
      duplicate?: boolean;
      stageMatch?: boolean;
      paymentType?: string;
      result?: unknown;
      error?: string;
    } = { triggered: false };

    const quoteStageConfigured = String(config.bitrixQuotePresentedStageId ?? "").trim();
    const stageMatchesQuotePresented =
      Boolean(quoteStageConfigured) &&
      normalizeStageId(stageId) === normalizeStageId(quoteStageConfigured);

    if (eventName === "ONCRMDEALUPDATE" && stageMatchesQuotePresented) {
      const dedupeKey = `${dealId}:${normalizeStageId(stageId)}:quote-presented-payment-link`;
      if (isDuplicate(processedQuotePresentedPaymentTriggers, dedupeKey)) {
        quotePresentedPaymentLink = {
          triggered: false,
          duplicate: true,
          stageMatch: true,
          paymentType: String(config.bitrixQuotePresentedPaymentType ?? "deposit")
        };
      } else {
        try {
          const paymentType =
            String(config.bitrixQuotePresentedPaymentType ?? "deposit").toLowerCase() === "callout"
              ? "callout"
              : "deposit";
          const result = await generateAndSendDealPaymentLink({
            dealId,
            paymentType,
            metadata: {
              source: "bitrix-deal-stage-trigger",
              triggerStageId: stageId
            },
            updateBitrixDealField: true,
            sendSms: true,
            sendEmail: true
          });

          quotePresentedPaymentLink = {
            triggered: true,
            stageMatch: true,
            paymentType,
            result
          };
        } catch (error) {
          quotePresentedPaymentLink = {
            triggered: true,
            stageMatch: true,
            paymentType: String(config.bitrixQuotePresentedPaymentType ?? "deposit"),
            error: error instanceof Error ? error.message : "Payment link trigger failed"
          };
        }
      }
    }

    console.log(
      "Bitrix deal webhook received",
      JSON.stringify(
        {
          event: eventName,
          dealId,
          stageId,
          classification,
          quotePresentedPaymentLink
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
      email: emailResult,
      quotePresentedPaymentLink
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
    clientPrice?: string | number;
    fields?: Record<string, unknown>;
  };

  const dealId = String(body.dealId ?? "").trim();
  const stageId = String(body.stageId ?? "").trim();
  const normalizedClientPrice = normalizeClientPrice(body.clientPrice);
  const extraFields: Record<string, unknown> = {
    ...(body.fields ?? {})
  };
  if (normalizedClientPrice && config.bitrixDealClientPriceField) {
    extraFields[config.bitrixDealClientPriceField] = normalizedClientPrice;
  }

  if (!dealId || !stageId) {
    return res.status(400).json({ ok: false, error: "Missing dealId or stageId" });
  }

  try {
    const result = await updateBitrixDealStage({
      dealId,
      stageId,
      extraFields
    });

    return res.status(200).json({
      ok: true,
      moved: true,
      dealId,
      stageId,
      clientPrice: normalizedClientPrice,
      clientPriceField: config.bitrixDealClientPriceField,
      result
    });
  } catch (error) {
    console.error("Failed to update Bitrix deal stage from inbound webhook", error);
    return res.status(500).json({ ok: false, error: "Bitrix deal stage update failed" });
  }
});

app.post("/webhooks/inbound/bitrix/deals/quote-presented", async (req: Request, res: Response) => {
  if (!verifyInboundDealSecret(req)) {
    return res.status(401).json({ ok: false, error: "Invalid inbound webhook secret" });
  }

  const body = req.body as {
    dealId?: string | number;
    stageId?: string;
    clientPrice?: string | number;
    fields?: Record<string, unknown>;
  };

  const dealId = String(body.dealId ?? "").trim();
  const stageId = String(body.stageId ?? config.bitrixQuotePresentedStageId).trim();
  const normalizedClientPrice = normalizeClientPrice(body.clientPrice);

  if (!dealId) {
    return res.status(400).json({ ok: false, error: "Missing dealId" });
  }
  if (!stageId) {
    return res.status(400).json({ ok: false, error: "Missing stageId and BITRIX_QUOTE_PRESENTED_STAGE_ID is not set" });
  }
  if (!normalizedClientPrice) {
    return res.status(400).json({ ok: false, error: "Missing clientPrice" });
  }

  const extraFields: Record<string, unknown> = {
    ...(body.fields ?? {}),
    ...(config.bitrixDealClientPriceField
      ? { [config.bitrixDealClientPriceField]: normalizedClientPrice }
      : {})
  };

  try {
    const result = await updateBitrixDealStage({
      dealId,
      stageId,
      extraFields
    });

    return res.status(200).json({
      ok: true,
      moved: true,
      dealId,
      stageId,
      quote: {
        clientPrice: normalizedClientPrice,
        clientPriceField: config.bitrixDealClientPriceField
      },
      result
    });
  } catch (error) {
    console.error("Failed to move deal to quote-presented stage", error);
    return res.status(500).json({ ok: false, error: "Bitrix quote-presented update failed" });
  }
});

app.post("/webhooks/inbound/bitrix/deals/payment-links", async (req: Request, res: Response) => {
  if (!verifyInboundDealSecret(req)) {
    return res.status(401).json({ ok: false, error: "Invalid inbound webhook secret" });
  }

  const body = req.body as {
    dealId?: string | number;
    paymentType?: "deposit" | "callout";
    amount?: string | number;
    amountField?: string;
    currency?: string;
    customerName?: string;
    customerEmail?: string;
    customerPhone?: string;
    description?: string;
    metadata?: Record<string, unknown>;
    updateBitrixDealField?: boolean;
    sendSms?: boolean;
    sendEmail?: boolean;
  };

  const dealId = String(body.dealId ?? "").trim();
  const paymentType = String(body.paymentType ?? "").trim().toLowerCase();
  const amount = normalizeMoneyAmount(body.amount);
  const amountField = String(body.amountField ?? "").trim();
  const currency = String(body.currency ?? "USD").trim().toUpperCase();
  let customerName = String(body.customerName ?? "").trim();
  let customerEmail = String(body.customerEmail ?? "").trim();
  let customerPhone = normalizePhoneForSms(String(body.customerPhone ?? ""));
  const updateDealField = body.updateBitrixDealField !== false;
  const sendSms = body.sendSms !== false;
  const sendEmail = body.sendEmail !== false;

  if (!dealId) {
    return res.status(400).json({ ok: false, error: "Missing dealId" });
  }
  if (paymentType !== "deposit" && paymentType !== "callout") {
    return res.status(400).json({ ok: false, error: "paymentType must be deposit or callout" });
  }
  try {
    const result = await generateAndSendDealPaymentLink({
      dealId,
      paymentType: paymentType as "deposit" | "callout",
      amount: amount ?? undefined,
      amountField,
      currency,
      customerName,
      customerEmail,
      customerPhone,
      description: body.description,
      metadata: body.metadata,
      updateBitrixDealField: updateDealField,
      sendSms,
      sendEmail
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error("Failed to create Wave payment link for deal", error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Payment link creation failed"
    });
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
