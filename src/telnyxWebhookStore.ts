import axios from "axios";
import { config } from "./config";
import { executeDatabase, queryDatabase } from "./database";
import { TelnyxWebhook } from "./types";

export interface TelnyxWebhookRecord {
  id: string;
  eventId: string;
  eventType: string;
  eventChannel: "sms" | "call" | "other";
  receivedAt: string;
  from: string;
  to: string;
  text: string;
  status:
    | "invalid_signature"
    | "ignored"
    | "invalid_payload"
    | "duplicate"
    | "forwarded_to_bitrix"
    | "bitrix_failed"
    | "stored_call_event"
    | "forwarded_call_event"
    | "call_forward_failed";
  rawBody: TelnyxWebhook | Record<string, unknown>;
  bitrix?: {
    ok: boolean;
    error?: string;
  };
  outboundForward?: {
    enabled: boolean;
    delivered: boolean;
    url?: string;
    statusCode?: number;
    error?: string;
    attemptedAt?: string;
  };
}

interface TelnyxWebhookRow {
  id: string;
  event_id: string;
  event_type: string;
  event_channel: TelnyxWebhookRecord["eventChannel"];
  received_at: string | Date;
  phone_from: string;
  phone_to: string;
  text_body: string;
  status: TelnyxWebhookRecord["status"];
  raw_body: TelnyxWebhook | Record<string, unknown>;
  bitrix: TelnyxWebhookRecord["bitrix"] | null;
  outbound_forward: TelnyxWebhookRecord["outboundForward"] | null;
}

function mapRowToRecord(row: TelnyxWebhookRow): TelnyxWebhookRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    eventChannel: row.event_channel,
    receivedAt:
      row.received_at instanceof Date ? row.received_at.toISOString() : new Date(row.received_at).toISOString(),
    from: row.phone_from,
    to: row.phone_to,
    text: row.text_body,
    status: row.status,
    rawBody: row.raw_body,
    bitrix: row.bitrix ?? undefined,
    outboundForward: row.outbound_forward ?? undefined
  };
}

export async function saveTelnyxWebhookRecord(record: TelnyxWebhookRecord): Promise<void> {
  await executeDatabase(
    `
      INSERT INTO telnyx_webhooks (
        id,
        event_id,
        event_type,
        event_channel,
        received_at,
        phone_from,
        phone_to,
        text_body,
        status,
        raw_body,
        bitrix,
        outbound_forward
      ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        event_id = EXCLUDED.event_id,
        event_type = EXCLUDED.event_type,
        event_channel = EXCLUDED.event_channel,
        received_at = EXCLUDED.received_at,
        phone_from = EXCLUDED.phone_from,
        phone_to = EXCLUDED.phone_to,
        text_body = EXCLUDED.text_body,
        status = EXCLUDED.status,
        raw_body = EXCLUDED.raw_body,
        bitrix = EXCLUDED.bitrix,
        outbound_forward = EXCLUDED.outbound_forward
    `,
    [
      record.id,
      record.eventId,
      record.eventType,
      record.eventChannel,
      record.receivedAt,
      record.from,
      record.to,
      record.text,
      record.status,
      JSON.stringify(record.rawBody),
      JSON.stringify(record.bitrix ?? null),
      JSON.stringify(record.outboundForward ?? null)
    ]
  );

  await executeDatabase(
    `
      DELETE FROM telnyx_webhooks
      WHERE id IN (
        SELECT id
        FROM telnyx_webhooks
        ORDER BY received_at DESC
        OFFSET $1
      )
    `,
    [config.telnyxWebhookStoreLimit]
  );
}

export async function listTelnyxWebhookRecords(limit = 50): Promise<TelnyxWebhookRecord[]> {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
  const rows = await queryDatabase<TelnyxWebhookRow>(
    `
      SELECT
        id,
        event_id,
        event_type,
        event_channel,
        received_at,
        phone_from,
        phone_to,
        text_body,
        status,
        raw_body,
        bitrix,
        outbound_forward
      FROM telnyx_webhooks
      ORDER BY received_at DESC
      LIMIT $1
    `,
    [safeLimit]
  );

  return rows.map(mapRowToRecord);
}

export async function forwardTelnyxWebhookRecord(
  record: TelnyxWebhookRecord
): Promise<TelnyxWebhookRecord["outboundForward"]> {
  const targetUrl =
    record.eventChannel === "call" ? config.telnyxCallForwardWebhookUrl : config.telnyxForwardWebhookUrl;

  if (!targetUrl) {
    return {
      enabled: false,
      delivered: false
    };
  }

  try {
    const response = await axios.post(
      targetUrl,
      {
        source: "telnyx-webhook",
        record
      },
      {
        timeout: 15000,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    return {
      enabled: true,
      delivered: true,
      url: targetUrl,
      statusCode: response.status,
      attemptedAt: new Date().toISOString()
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return {
        enabled: true,
        delivered: false,
        url: targetUrl,
        statusCode: error.response?.status,
        error: error.message,
        attemptedAt: new Date().toISOString()
      };
    }

      return {
        enabled: true,
        delivered: false,
        url: targetUrl,
        error: error instanceof Error ? error.message : "Unknown forwarding error",
        attemptedAt: new Date().toISOString()
      };
  }
}
