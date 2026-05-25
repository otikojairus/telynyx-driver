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
  jobId?: string;
  clientName?: string;
  phoneNumber?: string;
  addressPostalCode?: string;
  serviceType?: string;
  urgencyLevel?: string;
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
        job_id,
        client_name,
        phone_number,
        address_postal_code,
        service_type,
        urgency_level,
        raw_body,
        outbound_forward
      ) VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        received_at = EXCLUDED.received_at,
        event_name = EXCLUDED.event_name,
        deal_id = EXCLUDED.deal_id,
        stage_id = EXCLUDED.stage_id,
        classification = EXCLUDED.classification,
        job_id = EXCLUDED.job_id,
        client_name = EXCLUDED.client_name,
        phone_number = EXCLUDED.phone_number,
        address_postal_code = EXCLUDED.address_postal_code,
        service_type = EXCLUDED.service_type,
        urgency_level = EXCLUDED.urgency_level,
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
      record.jobId ?? null,
      record.clientName ?? null,
      record.phoneNumber ?? null,
      record.addressPostalCode ?? null,
      record.serviceType ?? null,
      record.urgencyLevel ?? null,
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
