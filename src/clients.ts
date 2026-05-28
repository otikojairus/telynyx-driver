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
}) {
  const externalId = normalizeSmsParticipantId(params.sourcePhone);
  const body = {
    CONNECTOR: config.bitrixConnectorId,
    LINE: config.bitrixLineId,
    MESSAGES: [
      {
        user: {
          id: externalId,
          name: params.sourcePhone,
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
          name: `SMS ${params.sourcePhone}`
        },
        extra: {
          from: params.sourcePhone,
          to: params.destinationPhone
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
}) {
  const body = {
    from: config.telnyxFromNumber,
    to: params.to,
    text: params.text
  };

  const response = await telnyxClient.post("/messages", body);
  return response.data;
}
