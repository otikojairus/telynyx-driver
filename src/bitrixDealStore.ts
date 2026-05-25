import axios from "axios";
import { config } from "./config";
import { executeDatabase } from "./database";
import { BitrixDealEvent } from "./types";

export interface BitrixDealRecord {
  id: string;
  receivedAt: string;
  eventName: string;
  dealId: string;
  stageId: string;
  classification: "deal_created" | "stage_changed" | "quote_approved" | "quote_declined" | "closed_won_paid";
  rawBody: BitrixDealEvent;
  outboundForward?: {
    enabled: boolean;
    delivered: boolean;
    url?: string;
    statusCode?: number;
    error?: string;
    attemptedAt?: string;
  };
}

export async function saveBitrixDealRecord(record: BitrixDealRecord): Promise<void> {
  await executeDatabase(
    `
      INSERT INTO bitrix_deals (
        id,
        received_at,
        event_name,
        deal_id,
        stage_id,
        classification,
        raw_body,
        outbound_forward
      ) VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        received_at = EXCLUDED.received_at,
        event_name = EXCLUDED.event_name,
        deal_id = EXCLUDED.deal_id,
        stage_id = EXCLUDED.stage_id,
        classification = EXCLUDED.classification,
        raw_body = EXCLUDED.raw_body,
        outbound_forward = EXCLUDED.outbound_forward
    `,
    [
      record.id,
      record.receivedAt,
      record.eventName,
      record.dealId,
      record.stageId,
      record.classification,
      JSON.stringify(record.rawBody),
      JSON.stringify(record.outboundForward ?? null)
    ]
  );
}

export async function forwardBitrixDealRecord(
  record: BitrixDealRecord
): Promise<BitrixDealRecord["outboundForward"]> {
  if (!config.bitrixDealForwardWebhookUrl) {
    return {
      enabled: false,
      delivered: false
    };
  }

  try {
    const response = await axios.post(
      config.bitrixDealForwardWebhookUrl,
      {
        source: "bitrix-deal-webhook",
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
      url: config.bitrixDealForwardWebhookUrl,
      statusCode: response.status,
      attemptedAt: new Date().toISOString()
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return {
        enabled: true,
        delivered: false,
        url: config.bitrixDealForwardWebhookUrl,
        statusCode: error.response?.status,
        error: error.message,
        attemptedAt: new Date().toISOString()
      };
    }

    return {
      enabled: true,
      delivered: false,
      url: config.bitrixDealForwardWebhookUrl,
      error: error instanceof Error ? error.message : "Unknown forwarding error",
      attemptedAt: new Date().toISOString()
    };
  }
}
