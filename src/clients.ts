import axios from "axios";
import { config } from "./config";
import { readBitrixTokens, writeBitrixTokens } from "./tokenStore";
import { BitrixSendMessageResponse } from "./types";

const telnyxClient = axios.create({
  baseURL: "https://api.telnyx.com/v2",
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${config.telnyxApiKey}`,
    "Content-Type": "application/json"
  }
});

function describeAxiosError(error: unknown) {
  if (!axios.isAxiosError(error)) {
    return error;
  }

  return {
    message: error.message,
    status: error.response?.status,
    data: error.response?.data
  };
}

export function normalizeSmsParticipantId(phone: string): string {
  const normalized = phone.replace(/\D/g, "");
  return `sms_${normalized || "unknown"}`;
}

async function refreshBitrixTokens() {
  const tokens = readBitrixTokens();
  if (!tokens) {
    throw new Error("Bitrix app is not installed yet. Visit /bitrix/install from Bitrix first.");
  }
  if (!config.bitrixClientId || !config.bitrixClientSecret) {
    throw new Error("BITRIX_CLIENT_ID and BITRIX_CLIENT_SECRET are required to refresh app auth.");
  }

  const response = await axios.get("https://oauth.bitrix.info/oauth/token/", {
    params: {
      grant_type: "refresh_token",
      client_id: config.bitrixClientId,
      client_secret: config.bitrixClientSecret,
      refresh_token: tokens.refreshToken
    },
    timeout: 15000
  });

  const refreshed = response.data;
  const nextTokens = {
    ...tokens,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token,
    clientEndpoint: refreshed.client_endpoint ?? tokens.clientEndpoint,
    serverEndpoint: refreshed.server_endpoint ?? tokens.serverEndpoint,
    domain: refreshed.domain ?? tokens.domain,
    memberId: refreshed.member_id ?? tokens.memberId,
    expiresAt: Date.now() + Number(refreshed.expires_in ?? 3600) * 1000
  };

  writeBitrixTokens(nextTokens);
  return nextTokens;
}

async function getBitrixTokens() {
  const tokens = readBitrixTokens();
  if (!tokens) {
    throw new Error("Bitrix app is not installed yet. No app auth tokens found.");
  }

  if (tokens.expiresAt - Date.now() < 120000) {
    return refreshBitrixTokens();
  }

  return tokens;
}

export async function callBitrixMethod<T = unknown>(method: string, payload: Record<string, unknown>) {
  const tokens = await getBitrixTokens();
  const url = new URL(method, tokens.clientEndpoint).toString();

  try {
    const response = await axios.post<T & { error?: string; error_description?: string }>(
      url,
      {
        ...payload,
        auth: tokens.accessToken
      },
      {
        timeout: 15000,
        validateStatus: () => true,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      }
    );

    if (response.data.error) {
      throw new Error(
        `Bitrix error: ${response.data.error} ${response.data.error_description ?? ""}`
      );
    }
    if (response.status >= 400) {
      throw new Error(`Bitrix HTTP ${response.status}: ${JSON.stringify(response.data)}`);
    }

    return response.data;
  } catch (error) {
    console.error(`Bitrix ${method} request failed`, describeAxiosError(error));
    throw error;
  }
}

function getBitrixErrorCode(error: unknown): string {
  if (error instanceof Error) {
    const match = error.message.match(/Bitrix error:\s+([A-Z0-9_]+)/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "";
}

export async function unregisterBitrixConnector() {
  return callBitrixMethod("imconnector.unregister", {
    CONNECTOR: config.bitrixConnectorId
  });
}

export async function registerBitrixConnector() {
  const transparentSvg =
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http://www.w3.org/2000/svg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20fill%3D%22white%22%20d%3D%22M2%203h12v7H6l-4%203V3z%22/%3E%3C/svg%3E";

  const payload = {
    ID: config.bitrixConnectorId,
    NAME: config.bitrixConnectorName,
    ICON: {
      DATA_IMAGE: transparentSvg,
      COLOR: "#00a3ff",
      SIZE: "90%",
      POSITION: "center"
    },
    ICON_DISABLED: {
      DATA_IMAGE: transparentSvg,
      COLOR: "#99adb3",
      SIZE: "90%",
      POSITION: "center"
    },
    PLACEMENT_HANDLER: `${config.publicBaseUrl}/bitrix/connector/settings`,
    DEL_EXTERNAL_MESSAGES: true,
    EDIT_INTERNAL_MESSAGES: true,
    DEL_INTERNAL_MESSAGES: true,
    NEED_SYSTEM_MESSAGES: true,
    NEED_SIGNATURE: false,
    CHAT_GROUP: false,
    COMMENT: "Telnyx SMS connector"
  };

  try {
    return await callBitrixMethod("imconnector.register", payload);
  } catch (error) {
    const bitrixCode = getBitrixErrorCode(error);
    if (bitrixCode !== "APPLICATION_REGISTRATION_ERROR") {
      throw error;
    }

    console.warn(
      "Bitrix connector registration returned APPLICATION_REGISTRATION_ERROR, retrying after unregister."
    );

    try {
      await unregisterBitrixConnector();
    } catch (unregisterError) {
      console.warn("Bitrix connector unregister failed during retry", describeAxiosError(unregisterError));
    }

    return callBitrixMethod("imconnector.register", payload);
  }
}

export async function activateBitrixConnector() {
  return callBitrixMethod("imconnector.activate", {
    CONNECTOR: config.bitrixConnectorId,
    LINE: config.bitrixLineId,
    ACTIVE: "1"
  });
}

export async function getBitrixConnectorStatus() {
  return callBitrixMethod("imconnector.status", {
    CONNECTOR: config.bitrixConnectorId,
    LINE: config.bitrixLineId
  });
}

export async function answerBitrixOpenLineChat(chatId: string | number) {
  return callBitrixMethod("imopenlines.operator.answer", {
    CHAT_ID: Number(chatId)
  });
}

export async function getBitrixOpenLineHistory(params: {
  sessionId?: string | number;
  chatId?: string | number;
}) {
  const payload: Record<string, unknown> = {};

  if (params.sessionId) {
    payload.SESSION_ID = Number(params.sessionId);
  } else if (params.chatId) {
    payload.CHAT_ID = Number(params.chatId);
  }

  return callBitrixMethod("imopenlines.session.history.get", payload);
}

export async function bindBitrixConnectorEvents() {
  const handler = `${config.publicBaseUrl}/webhooks/bitrix`;

  await callBitrixMethod("event.unbind", {
    event: "OnImConnectorMessageAdd",
    handler
  });

  return callBitrixMethod("event.bind", {
    event: "OnImConnectorMessageAdd",
    handler
  });
}

export async function bindBitrixDealEvents() {
  const handler = `${config.publicBaseUrl}/webhooks/bitrix/deals`;
  const events = ["OnCrmDealAdd", "OnCrmDealUpdate"];

  for (const event of events) {
    await callBitrixMethod("event.unbind", { event, handler });
    await callBitrixMethod("event.bind", { event, handler });
  }

  return { ok: true, events, handler };
}

export async function bindBitrixLeadEvents() {
  const handler = `${config.publicBaseUrl}/webhooks/bitrix/leads`;
  const events = ["OnCrmLeadAdd"];

  for (const event of events) {
    await callBitrixMethod("event.unbind", { event, handler });
    await callBitrixMethod("event.bind", { event, handler });
  }

  return { ok: true, events, handler };
}

export async function bindBitrixTelephonyEvents() {
  const handler = `${config.publicBaseUrl}/webhooks/bitrix/telephony`;
  const events = ["OnVoximplantCallStart", "OnVoximplantCallEnd"];

  for (const event of events) {
    await callBitrixMethod("event.unbind", { event, handler });
    await callBitrixMethod("event.bind", { event, handler });
  }

  return { ok: true, events, handler };
}

type BitrixCallStatisticRecord = {
  CALL_ID?: string;
  CALL_RECORD_URL?: string | null;
  RECORD_FILE_ID?: number | string | null;
  CRM_ACTIVITY_ID?: string | number | null;
  CRM_ENTITY_TYPE?: string | null;
  CRM_ENTITY_ID?: string | number | null;
  PORTAL_USER_ID?: string | number | null;
  CALL_START_DATE?: string;
  PHONE_NUMBER?: string;
  CALL_TYPE?: string | number;
  CALL_DURATION?: string | number;
};

async function fetchBitrixCallStatistic(callId: string) {
  const response = await callBitrixMethod<{ result?: BitrixCallStatisticRecord[] }>(
    "voximplant.statistic.get",
    {
      FILTER: {
        CALL_ID: callId
      },
      SORT: "ID",
      ORDER: "DESC"
    }
  );

  return response.result?.[0] ?? null;
}

function mapCrmEntityTypeToOwnerTypeId(entityType?: string | null): number | null {
  switch (String(entityType ?? "").toUpperCase()) {
    case "LEAD":
      return 1;
    case "DEAL":
      return 2;
    case "CONTACT":
      return 3;
    case "COMPANY":
      return 4;
    default:
      return null;
  }
}

function mapVoximplantCallTypeToDirection(callType?: string | number | null): "inbound" | "outbound" | undefined {
  const value = String(callType ?? "");
  if (value === "1" || value === "4") {
    return "outbound";
  }
  if (value === "2" || value === "3") {
    return "inbound";
  }
  return undefined;
}

async function resolveCallContactName(entityType?: string | null, entityId?: string | number | null): Promise<string> {
  if (String(entityType ?? "").toUpperCase() !== "CONTACT" || !entityId) {
    return "";
  }

  try {
    const response = await getBitrixContactById(String(entityId));
    const contact = response.result as Record<string, unknown> | undefined;
    if (!contact) {
      return "";
    }
    return [contact.NAME, contact.LAST_NAME].filter(Boolean).join(" ").trim();
  } catch (error) {
    console.warn("Failed to resolve call contact name", describeAxiosError(error));
    return "";
  }
}

async function resolveCallAgentName(userId?: string | number | null): Promise<string> {
  if (!userId) {
    return "";
  }

  try {
    const response = await getBitrixUserById(String(userId));
    const user = response.result?.[0];
    if (!user) {
      return "";
    }
    return [user.NAME, user.LAST_NAME].filter(Boolean).join(" ").trim();
  } catch (error) {
    console.warn("Failed to resolve call agent name", describeAxiosError(error));
    return "";
  }
}

type CallTranscriptApiResponse = {
  status?: string;
  reason?: string;
  details?: string;
  transcript_record_id?: string;
  local_id?: string;
  ghl_call_id?: string;
  transcription_text?: string;
  process_steps?: Array<{ step?: string; start_time?: string; end_time?: string; duration_ms?: number }>;
  total_processing_time_ms?: number;
};

export async function fetchCallTranscript(params: {
  callId: string;
  audioUrl: string;
  contactId?: string;
  fullName?: string;
  phone?: string;
  callStart?: string;
  callEnd?: string;
  direction?: "inbound" | "outbound";
  agentName?: string;
}): Promise<CallTranscriptApiResponse> {
  const response = await fetch(config.callTranscriptApiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contact_id: params.contactId ?? "",
      full_name: params.fullName ?? "",
      phone: params.phone ?? "",
      customData: {
        ghl_call_id: params.callId,
        audio_url: params.audioUrl,
        call_start: params.callStart ?? "",
        call_end: params.callEnd ?? "",
        direction: params.direction ?? "",
        agent_name: params.agentName ?? ""
      }
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Call transcript API HTTP ${response.status}: ${JSON.stringify(body)}`);
  }

  return body as CallTranscriptApiResponse;
}

export async function processVoximplantCallTranscript(params: { callId: string; eventName?: string }) {
  if (!config.callTranscriptApiUrl) {
    return { enabled: false, delivered: false };
  }

  console.log(`[call-transcript] processing call ${params.callId}`);

  const statistic = await fetchBitrixCallStatistic(params.callId);
  if (!statistic) {
    console.warn(`[call-transcript] call ${params.callId}: statistic not found`);
    return {
      enabled: true,
      delivered: false,
      error: "call statistic not found",
      attemptedAt: new Date().toISOString()
    };
  }

  const audioUrl = String(statistic.CALL_RECORD_URL ?? "").trim();
  if (!audioUrl) {
    console.warn(`[call-transcript] call ${params.callId}: recording url missing`);
    return {
      enabled: true,
      delivered: false,
      error: "recording url missing",
      attemptedAt: new Date().toISOString(),
      statistic
    };
  }

  const durationSeconds = Number(statistic.CALL_DURATION ?? 0) || 0;
  const callStart = String(statistic.CALL_START_DATE ?? "").trim();
  const callStartMs = callStart ? new Date(callStart).getTime() : NaN;
  const callEnd = Number.isFinite(callStartMs) ? new Date(callStartMs + durationSeconds * 1000).toISOString() : "";
  const direction = mapVoximplantCallTypeToDirection(statistic.CALL_TYPE);

  const [contactName, agentName] = await Promise.all([
    resolveCallContactName(statistic.CRM_ENTITY_TYPE, statistic.CRM_ENTITY_ID),
    resolveCallAgentName(statistic.PORTAL_USER_ID)
  ]);

  try {
    const transcript = await fetchCallTranscript({
      callId: params.callId,
      audioUrl,
      contactId: String(statistic.CRM_ENTITY_TYPE ?? "").toUpperCase() === "CONTACT" ? String(statistic.CRM_ENTITY_ID ?? "") : "",
      fullName: contactName,
      phone: String(statistic.PHONE_NUMBER ?? ""),
      callStart,
      callEnd,
      direction,
      agentName
    });

    const transcriptText = String(transcript.transcription_text ?? "").trim();
    const ownerTypeId = mapCrmEntityTypeToOwnerTypeId(statistic.CRM_ENTITY_TYPE);

    let activity: unknown = null;
    if (transcriptText && ownerTypeId && statistic.CRM_ENTITY_ID) {
      activity = await createCallTranscriptActivity({
        ownerTypeId,
        ownerId: Number(statistic.CRM_ENTITY_ID),
        subject: `${direction === "outbound" ? "Outbound" : "Inbound"} call transcript`,
        transcript: transcriptText,
        startTime: callStart || undefined
      });
      console.log(
        `[call-transcript] call ${params.callId}: activity created`,
        JSON.stringify(activity)
      );
    } else {
      console.warn(
        `[call-transcript] call ${params.callId}: no activity created`,
        JSON.stringify({
          hasTranscriptText: Boolean(transcriptText),
          ownerTypeId,
          crmEntityType: statistic.CRM_ENTITY_TYPE,
          crmEntityId: statistic.CRM_ENTITY_ID,
          transcriptStatus: transcript.status,
          transcriptReason: transcript.reason
        })
      );
    }

    return {
      enabled: true,
      delivered: Boolean(transcriptText),
      attemptedAt: new Date().toISOString(),
      statistic,
      transcript,
      activity
    };
  } catch (error) {
    console.error(
      `[call-transcript] call ${params.callId}: failed`,
      describeAxiosError(error)
    );
    return {
      enabled: true,
      delivered: false,
      error: error instanceof Error ? error.message : "Unknown call transcript error",
      attemptedAt: new Date().toISOString(),
      statistic
    };
  }
}

export async function bindBitrixDealPaymentWidget() {
  const handler = `${config.publicBaseUrl}/bitrix/widgets/deal-payment`;
  const legacyPlacements = ["CRM_DEAL_DETAIL_ACTIVITY", "CRM_DEAL_DETAIL_TAB", "CRM_DEAL_DETAIL_TOOLBAR"];
  const placement = "CRM_DEAL_DETAIL_TAB";
  const results: Array<{ placement: string; unbind?: unknown; bind?: unknown; error?: string }> = [];

  for (const legacyPlacement of legacyPlacements) {
    const unbind = await callBitrixMethod("placement.unbind", {
      PLACEMENT: legacyPlacement,
      HANDLER: handler
    }).catch((error) => ({
      error: error instanceof Error ? error.message : "Placement unbind failed"
    }));
    results.push({ placement: legacyPlacement, unbind });
  }

  try {
    const bind = await callBitrixMethod("placement.bind", {
      PLACEMENT: placement,
      HANDLER: handler,
      TITLE: "Send Payment Link"
    });

    results.push({ placement, bind });
  } catch (error) {
    results.push({
      placement,
      error: error instanceof Error ? error.message : "Placement bind failed"
    });
  }

  return {
    ok: results.some((item) => Boolean(item.bind)),
    handler,
    results
  };
}

export async function bindBitrixDealCardDatesWidget() {
  const handler = `${config.publicBaseUrl}/bitrix/widgets/deal-card-dates`;
  const placement = "CRM_DEAL_CARD";

  await callBitrixMethod("placement.unbind", {
    PLACEMENT: placement,
    HANDLER: handler
  }).catch(() => null);

  try {
    const bind = await callBitrixMethod("placement.bind", {
      PLACEMENT: placement,
      HANDLER: handler,
      TITLE: "Dates"
    });

    return {
      ok: true,
      placement,
      handler,
      bind
    };
  } catch (error) {
    return {
      ok: false,
      placement,
      handler,
      optional: true,
      error: error instanceof Error ? error.message : "Placement bind failed"
    };
  }
}

export async function bindBitrixDealSmsWidget() {
  const handler = `${config.publicBaseUrl}/bitrix/widgets/deal-sms`;
  const legacyPlacements = ["CRM_DEAL_DETAIL_ACTIVITY", "CRM_DEAL_DETAIL_TAB", "CRM_DEAL_DETAIL_TOOLBAR"];
  const placement = "CRM_DEAL_DETAIL_TAB";
  const results: Array<{ placement: string; unbind?: unknown; bind?: unknown; error?: string }> = [];

  for (const legacyPlacement of legacyPlacements) {
    const unbind = await callBitrixMethod("placement.unbind", {
      PLACEMENT: legacyPlacement,
      HANDLER: handler
    }).catch((error) => ({
      error: error instanceof Error ? error.message : "Placement unbind failed"
    }));
    results.push({ placement: legacyPlacement, unbind });
  }

  try {
    const bind = await callBitrixMethod("placement.bind", {
      PLACEMENT: placement,
      HANDLER: handler,
      TITLE: "SMS"
    });

    results.push({ placement, bind });
  } catch (error) {
    results.push({
      placement,
      error: error instanceof Error ? error.message : "Placement bind failed"
    });
  }

  return {
    ok: results.some((item) => Boolean(item.bind)),
    handler,
    results
  };
}

export async function bindBitrixDealComposeSmsWidget() {
  const handler = `${config.publicBaseUrl}/bitrix/widgets/deal-compose-sms`;
  const placement = "CRM_DEAL_DETAIL_TAB";

  const unbind = await callBitrixMethod("placement.unbind", {
    PLACEMENT: placement,
    HANDLER: handler
  }).catch((error) => ({
    error: error instanceof Error ? error.message : "Placement unbind failed"
  }));

  try {
    const bind = await callBitrixMethod("placement.bind", {
      PLACEMENT: placement,
      HANDLER: handler,
      TITLE: "Compose SMS"
    });

    return {
      ok: true,
      placement,
      handler,
      unbind,
      bind
    };
  } catch (error) {
    return {
      ok: false,
      placement,
      handler,
      unbind,
      error: error instanceof Error ? error.message : "Placement bind failed"
    };
  }
}

export async function bindBitrixDealFundingWidget() {
  const handler = `${config.publicBaseUrl}/bitrix/widgets/deal-funding`;
  const placement = "CRM_DEAL_DETAIL_TAB";

  await callBitrixMethod("placement.unbind", {
    PLACEMENT: placement,
    HANDLER: handler
  }).catch(() => null);

  const bind = await callBitrixMethod("placement.bind", {
    PLACEMENT: placement,
    HANDLER: handler,
    TITLE: "Funding Matches"
  });

  return {
    ok: true,
    placement,
    handler,
    bind
  };
}

export async function bindBitrixDealVendorsWidget() {
  const handler = `${config.publicBaseUrl}/bitrix/widgets/deal-vendors`;
  const placement = "CRM_DEAL_DETAIL_TAB";

  await callBitrixMethod("placement.unbind", {
    PLACEMENT: placement,
    HANDLER: handler
  }).catch(() => null);

  const bind = await callBitrixMethod("placement.bind", {
    PLACEMENT: placement,
    HANDLER: handler,
    TITLE: "Vendors Available"
  });

  return {
    ok: true,
    placement,
    handler,
    bind
  };
}

export async function bindBitrixAvailableVendorsWidget() {
  const handler = `${config.publicBaseUrl}/bitrix/widgets/available-vendors`;
  const placement = "CRM_DEAL_DETAIL_TAB";

  await callBitrixMethod("placement.unbind", {
    PLACEMENT: placement,
    HANDLER: handler
  }).catch(() => null);

  const bind = await callBitrixMethod("placement.bind", {
    PLACEMENT: placement,
    HANDLER: handler,
    TITLE: "Available Vendors"
  });

  return {
    ok: true,
    placement,
    handler,
    bind
  };
}

export async function unbindBitrixCallCardWidget() {
  const handler = `${config.publicBaseUrl}/bitrix/widgets/call-card`;
  const placement = "CALL_CARD";

  const unbind = await callBitrixMethod("placement.unbind", {
    PLACEMENT: placement,
    HANDLER: handler
  });

  return {
    ok: true,
    placement,
    handler,
    unbind
  };
}

export async function bindBitrixCallCardWidget() {
  const handler = `${config.publicBaseUrl}/bitrix/widgets/call-card`;
  const placement = "CALL_CARD";

  await callBitrixMethod("placement.unbind", {
    PLACEMENT: placement,
    HANDLER: handler
  }).catch(() => null);

  try {
    const bind = await callBitrixMethod("placement.bind", {
      PLACEMENT: placement,
      HANDLER: handler,
      TITLE: "CSR Intake"
    });

    return {
      ok: true,
      placement,
      handler,
      bind
    };
  } catch (error) {
    return {
      ok: false,
      placement,
      handler,
      optional: true,
      error: error instanceof Error ? error.message : "Placement bind failed"
    };
  }
}

const CALL_TRANSCRIPT_PROVIDER_TYPE_ID = "TELYNX_CALL_TRANSCRIPT";
const CRM_OWNER_TYPE_DEAL = 2;
const CRM_ACTIVITY_TYPE_PROVIDER = 6;

export async function registerCallTranscriptActivityType() {
  try {
    const result = await callBitrixMethod("crm.activity.type.add", {
      fields: {
        TYPE_ID: CALL_TRANSCRIPT_PROVIDER_TYPE_ID,
        NAME: "Call Transcript"
      }
    });
    return { ok: true, typeId: CALL_TRANSCRIPT_PROVIDER_TYPE_ID, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/exist/i.test(message)) {
      return { ok: true, typeId: CALL_TRANSCRIPT_PROVIDER_TYPE_ID, alreadyRegistered: true };
    }
    return {
      ok: false,
      typeId: CALL_TRANSCRIPT_PROVIDER_TYPE_ID,
      error: error instanceof Error ? error.message : "Activity type registration failed"
    };
  }
}

export async function createCallTranscriptActivity(params: {
  ownerTypeId?: number;
  ownerId: number;
  subject: string;
  transcript: string;
  startTime?: string;
  responsibleId?: number;
}) {
  return callBitrixMethod<{ result?: number }>("crm.activity.add", {
    fields: {
      OWNER_TYPE_ID: params.ownerTypeId ?? CRM_OWNER_TYPE_DEAL,
      OWNER_ID: params.ownerId,
      TYPE_ID: CRM_ACTIVITY_TYPE_PROVIDER,
      PROVIDER_ID: "REST_APP",
      PROVIDER_TYPE_ID: CALL_TRANSCRIPT_PROVIDER_TYPE_ID,
      SUBJECT: params.subject,
      DESCRIPTION: params.transcript,
      DESCRIPTION_TYPE: 1,
      COMPLETED: "Y",
      DIRECTION: 2,
      RESPONSIBLE_ID: params.responsibleId ?? 1,
      START_TIME: params.startTime ?? new Date().toISOString(),
      COMMUNICATIONS: []
    }
  });
}

export async function createBitrixDeal(fields: Record<string, unknown>) {
  return callBitrixMethod<{ result?: number }>("crm.deal.add", { fields });
}

export async function markBitrixAppInstalled() {
  return callBitrixMethod("app.install", {});
}

export async function getBitrixAppInfo() {
  return callBitrixMethod<{ result?: Record<string, unknown> }>("app.info", {});
}

export async function getBitrixLeadById(leadId: string) {
  return callBitrixMethod<{ result?: Record<string, unknown> }>("crm.lead.get", {
    id: leadId
  });
}

export async function getBitrixDealById(dealId: string) {
  return callBitrixMethod<{ result?: Record<string, unknown> }>("crm.deal.get", {
    id: dealId
  });
}

export async function getBitrixContactById(contactId: string) {
  return callBitrixMethod<{ result?: Record<string, unknown> }>("crm.contact.get", {
    id: contactId
  });
}

export async function listBitrixContacts(params: {
  filter?: Record<string, unknown>;
  select?: string[];
  start?: number;
}) {
  return callBitrixMethod<{ result?: Array<Record<string, unknown>>; next?: number }>("crm.contact.list", {
    filter: params.filter ?? {},
    select: params.select ?? ["ID"],
    start: params.start ?? 0
  });
}

export async function createBitrixContact(fields: Record<string, unknown>) {
  return callBitrixMethod<{ result?: number }>("crm.contact.add", { fields });
}

export async function updateBitrixContact(params: {
  contactId: string;
  fields: Record<string, unknown>;
}) {
  return callBitrixMethod("crm.contact.update", {
    id: params.contactId,
    fields: params.fields
  });
}

export async function findBitrixDuplicatesByCommunication(params: {
  entityType: "CONTACT" | "LEAD" | "COMPANY";
  type: "PHONE" | "EMAIL";
  values: string[];
}) {
  return callBitrixMethod<{ result?: Record<string, Array<string | number>> }>("crm.duplicate.findbycomm", {
    entity_type: params.entityType,
    type: params.type,
    values: params.values
  });
}

export async function updateBitrixDealStage(params: {
  dealId: string;
  stageId: string;
  extraFields?: Record<string, unknown>;
}) {
  return callBitrixMethod("crm.deal.update", {
    id: params.dealId,
    fields: {
      STAGE_ID: params.stageId,
      ...(params.extraFields ?? {})
    }
  });
}

export async function updateBitrixDealFields(params: {
  dealId: string;
  fields: Record<string, unknown>;
}) {
  return callBitrixMethod("crm.deal.update", {
    id: params.dealId,
    fields: params.fields
  });
}

export async function listBitrixDealCategories() {
  return callBitrixMethod<{ result?: Array<Record<string, unknown>> }>("crm.dealcategory.list", {});
}

export async function listBitrixDealFields() {
  return callBitrixMethod<{ result?: Record<string, unknown> }>("crm.deal.fields", {});
}

export async function listBitrixStatuses(filter: Record<string, unknown>) {
  return callBitrixMethod<{ result?: Array<Record<string, unknown>> }>("crm.status.list", {
    filter
  });
}

export async function getBitrixUserById(userId: string) {
  return callBitrixMethod<{ result?: Array<Record<string, unknown>> }>("user.get", { ID: userId });
}

export async function findBitrixUserByEmail(email: string) {
  return callBitrixMethod<{ result?: Array<Record<string, unknown>> }>("user.get", {
    FILTER: {
      EMAIL: email
    }
  });
}

export async function sendBitrixInternalMessage(params: {
  userId: string;
  text: string;
}) {
  return callBitrixMethod("im.message.add", {
    DIALOG_ID: String(params.userId),
    MESSAGE: params.text
  });
}

export async function sendBitrixDeliveryStatus(params: {
  imChatId: number;
  imMessageId: number;
  externalMessageId: string;
  chatId: string;
}) {
  return callBitrixMethod("imconnector.send.status.delivery", {
    CONNECTOR: config.bitrixConnectorId,
    LINE: config.bitrixLineId,
    MESSAGES: [
      {
        im: {
          chat_id: params.imChatId,
          message_id: params.imMessageId
        },
        message: {
          id: [params.externalMessageId],
          date: Math.floor(Date.now() / 1000)
        },
        chat: {
          id: params.chatId
        }
      }
    ]
  });
}

export async function sendToBitrixOpenChannel(params: {
  sourcePhone: string;
  destinationPhone: string;
  text: string;
  externalMessageId: string;
  eventTimestamp?: string;
  customerName?: string;
  customerEmail?: string;
  dealId?: string;
}) {
  const externalId = normalizeSmsParticipantId(params.sourcePhone);
  const displayName = String(params.customerName ?? "").trim() || params.sourcePhone;
  const body = {
    CONNECTOR: config.bitrixConnectorId,
    LINE: config.bitrixLineId,
    MESSAGES: [
      {
        user: {
          id: externalId,
          name: displayName,
          phone: params.sourcePhone,
          email: params.customerEmail,
          url: "",
          picture: ""
        },
        message: {
          id: params.externalMessageId,
          date: params.eventTimestamp ?? new Date().toISOString(),
          text: params.text
        },
        chat: {
          id: externalId,
          name: `SMS ${displayName}`
        },
        extra: {
          from: params.sourcePhone,
          to: params.destinationPhone,
          dealId: params.dealId
        }
      }
    ]
  };

  console.log("Sending inbound SMS to Bitrix", {
    connector: body.CONNECTOR,
    line: body.LINE,
    chatId: body.MESSAGES[0].chat.id,
    messageId: body.MESSAGES[0].message.id
  });

  const response = await callBitrixMethod<BitrixSendMessageResponse>(
    "imconnector.send.messages",
    body
  );

  console.log("Bitrix imconnector.send.messages response", JSON.stringify(response, null, 2));
  return response;
}

export async function sendSmsThroughTelnyx(params: {
  to: string;
  text: string;
  from?: string;
}) {
  const body = {
    from: String(params.from ?? config.telnyxFromNumber),
    to: params.to,
    text: params.text
  };

  const response = await telnyxClient.post("/messages", body);
  return response.data;
}
