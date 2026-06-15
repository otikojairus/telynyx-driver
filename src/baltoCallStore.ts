import { executeDatabase, queryDatabase } from "./database";
import { BaltoCallDataRecord } from "./balto";

export interface BaltoCallSessionRecord {
  id: string;
  status: "started" | "start_failed" | "stopped" | "stop_failed" | "synced";
  telnyxEventId?: string;
  telnyxCallControlId?: string;
  telnyxCallLegId?: string;
  bitrixCallId?: string;
  bitrixDealId?: string;
  agentEmail?: string;
  voipUserId?: string;
  phoneNumber?: string;
  direction?: string;
  voipCallId: string;
  voipCustomerId?: string;
  voipCampaignName?: string;
  startRequestedAt?: string;
  stopRequestedAt?: string;
  startResponse?: unknown;
  stopResponse?: unknown;
  baltoCallId?: string;
  baltoOutput?: unknown;
  outputHash?: string;
  lastError?: string;
  rawStartEvent?: unknown;
  rawStopEvent?: unknown;
}

interface BaltoCallSessionRow {
  id: string;
  status: BaltoCallSessionRecord["status"];
  telnyx_event_id: string | null;
  telnyx_call_control_id: string | null;
  telnyx_call_leg_id: string | null;
  bitrix_call_id: string | null;
  bitrix_deal_id: string | null;
  agent_email: string | null;
  voip_user_id: string | null;
  phone_number: string | null;
  direction: string | null;
  voip_call_id: string;
  voip_customer_id: string | null;
  voip_campaign_name: string | null;
  start_requested_at: string | Date | null;
  stop_requested_at: string | Date | null;
  start_response: unknown;
  stop_response: unknown;
  balto_call_id: string | null;
  balto_output: unknown;
  output_hash: string | null;
  last_error: string | null;
  raw_start_event: unknown;
  raw_stop_event: unknown;
}

function optionalIso(value: string | Date | null): string | undefined {
  if (!value) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: BaltoCallSessionRow): BaltoCallSessionRecord {
  return {
    id: row.id,
    status: row.status,
    telnyxEventId: row.telnyx_event_id ?? undefined,
    telnyxCallControlId: row.telnyx_call_control_id ?? undefined,
    telnyxCallLegId: row.telnyx_call_leg_id ?? undefined,
    bitrixCallId: row.bitrix_call_id ?? undefined,
    bitrixDealId: row.bitrix_deal_id ?? undefined,
    agentEmail: row.agent_email ?? undefined,
    voipUserId: row.voip_user_id ?? undefined,
    phoneNumber: row.phone_number ?? undefined,
    direction: row.direction ?? undefined,
    voipCallId: row.voip_call_id,
    voipCustomerId: row.voip_customer_id ?? undefined,
    voipCampaignName: row.voip_campaign_name ?? undefined,
    startRequestedAt: optionalIso(row.start_requested_at),
    stopRequestedAt: optionalIso(row.stop_requested_at),
    startResponse: row.start_response ?? undefined,
    stopResponse: row.stop_response ?? undefined,
    baltoCallId: row.balto_call_id ?? undefined,
    baltoOutput: row.balto_output ?? undefined,
    outputHash: row.output_hash ?? undefined,
    lastError: row.last_error ?? undefined,
    rawStartEvent: row.raw_start_event ?? undefined,
    rawStopEvent: row.raw_stop_event ?? undefined
  };
}

export async function upsertBaltoCallSession(record: BaltoCallSessionRecord): Promise<void> {
  await executeDatabase(
    `
      INSERT INTO balto_call_sessions (
        id,
        updated_at,
        status,
        telnyx_event_id,
        telnyx_call_control_id,
        telnyx_call_leg_id,
        bitrix_call_id,
        bitrix_deal_id,
        agent_email,
        voip_user_id,
        phone_number,
        direction,
        voip_call_id,
        voip_customer_id,
        voip_campaign_name,
        start_requested_at,
        stop_requested_at,
        start_response,
        stop_response,
        balto_call_id,
        balto_output,
        output_hash,
        last_error,
        raw_start_event,
        raw_stop_event
      ) VALUES (
        $1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15::timestamptz, $16::timestamptz,
        $17::jsonb, $18::jsonb, $19, $20::jsonb, $21, $22,
        $23::jsonb, $24::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        updated_at = now(),
        status = EXCLUDED.status,
        telnyx_event_id = COALESCE(EXCLUDED.telnyx_event_id, balto_call_sessions.telnyx_event_id),
        telnyx_call_control_id = COALESCE(EXCLUDED.telnyx_call_control_id, balto_call_sessions.telnyx_call_control_id),
        telnyx_call_leg_id = COALESCE(EXCLUDED.telnyx_call_leg_id, balto_call_sessions.telnyx_call_leg_id),
        bitrix_call_id = COALESCE(EXCLUDED.bitrix_call_id, balto_call_sessions.bitrix_call_id),
        bitrix_deal_id = COALESCE(EXCLUDED.bitrix_deal_id, balto_call_sessions.bitrix_deal_id),
        agent_email = COALESCE(EXCLUDED.agent_email, balto_call_sessions.agent_email),
        voip_user_id = COALESCE(EXCLUDED.voip_user_id, balto_call_sessions.voip_user_id),
        phone_number = COALESCE(EXCLUDED.phone_number, balto_call_sessions.phone_number),
        direction = COALESCE(EXCLUDED.direction, balto_call_sessions.direction),
        voip_customer_id = COALESCE(EXCLUDED.voip_customer_id, balto_call_sessions.voip_customer_id),
        voip_campaign_name = COALESCE(EXCLUDED.voip_campaign_name, balto_call_sessions.voip_campaign_name),
        start_requested_at = COALESCE(EXCLUDED.start_requested_at, balto_call_sessions.start_requested_at),
        stop_requested_at = COALESCE(EXCLUDED.stop_requested_at, balto_call_sessions.stop_requested_at),
        start_response = COALESCE(EXCLUDED.start_response, balto_call_sessions.start_response),
        stop_response = COALESCE(EXCLUDED.stop_response, balto_call_sessions.stop_response),
        balto_call_id = COALESCE(EXCLUDED.balto_call_id, balto_call_sessions.balto_call_id),
        balto_output = COALESCE(EXCLUDED.balto_output, balto_call_sessions.balto_output),
        output_hash = COALESCE(EXCLUDED.output_hash, balto_call_sessions.output_hash),
        last_error = EXCLUDED.last_error,
        raw_start_event = COALESCE(EXCLUDED.raw_start_event, balto_call_sessions.raw_start_event),
        raw_stop_event = COALESCE(EXCLUDED.raw_stop_event, balto_call_sessions.raw_stop_event)
    `,
    [
      record.id,
      record.status,
      record.telnyxEventId ?? null,
      record.telnyxCallControlId ?? null,
      record.telnyxCallLegId ?? null,
      record.bitrixCallId ?? null,
      record.bitrixDealId ?? null,
      record.agentEmail ?? null,
      record.voipUserId ?? null,
      record.phoneNumber ?? null,
      record.direction ?? null,
      record.voipCallId,
      record.voipCustomerId ?? null,
      record.voipCampaignName ?? null,
      record.startRequestedAt ?? null,
      record.stopRequestedAt ?? null,
      record.startResponse === undefined ? null : JSON.stringify(record.startResponse),
      record.stopResponse === undefined ? null : JSON.stringify(record.stopResponse),
      record.baltoCallId ?? null,
      record.baltoOutput === undefined ? null : JSON.stringify(record.baltoOutput),
      record.outputHash ?? null,
      record.lastError ?? null,
      record.rawStartEvent === undefined ? null : JSON.stringify(record.rawStartEvent),
      record.rawStopEvent === undefined ? null : JSON.stringify(record.rawStopEvent)
    ]
  );
}

export async function getBaltoCallSessionByVoipCallId(
  voipCallId: string
): Promise<BaltoCallSessionRecord | null> {
  const rows = await queryDatabase<BaltoCallSessionRow>(
    `
      SELECT *
      FROM balto_call_sessions
      WHERE voip_call_id = $1
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [voipCallId]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getBaltoCallSessionByTelnyxIds(params: {
  voipCallId?: string;
  callControlId?: string;
  callLegId?: string;
}): Promise<BaltoCallSessionRecord | null> {
  const ids = [
    String(params.voipCallId ?? "").trim(),
    String(params.callControlId ?? "").trim(),
    String(params.callLegId ?? "").trim()
  ].filter(Boolean);

  if (!ids.length) {
    return null;
  }

  const rows = await queryDatabase<BaltoCallSessionRow>(
    `
      SELECT *
      FROM balto_call_sessions
      WHERE voip_call_id = ANY($1::text[])
        OR telnyx_call_control_id = ANY($1::text[])
        OR telnyx_call_leg_id = ANY($1::text[])
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [ids]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function listBaltoCallSessions(limit = 50): Promise<BaltoCallSessionRecord[]> {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
  const rows = await queryDatabase<BaltoCallSessionRow>(
    `
      SELECT *
      FROM balto_call_sessions
      ORDER BY updated_at DESC
      LIMIT $1
    `,
    [safeLimit]
  );
  return rows.map(mapRow);
}

export async function upsertBaltoCallDataRecord(record: BaltoCallDataRecord): Promise<void> {
  const voipCallId = String(record.voip_call_id ?? "").trim();
  if (!voipCallId) {
    return;
  }

  const existing = await getBaltoCallSessionByVoipCallId(voipCallId);
  const id = existing?.id ?? `balto-call-data-${voipCallId}`;
  await upsertBaltoCallSession({
    id,
    status: "synced",
    voipCallId,
    voipUserId: String(record.voip_user_id ?? existing?.voipUserId ?? "").trim() || undefined,
    voipCustomerId: String(record.voip_customer_id ?? existing?.voipCustomerId ?? "").trim() || undefined,
    voipCampaignName: String(record.voip_campaign_name ?? existing?.voipCampaignName ?? "").trim() || undefined,
    direction: String(record.direction ?? existing?.direction ?? "").trim() || undefined,
    baltoCallId: String(record.call_id ?? existing?.baltoCallId ?? "").trim() || undefined,
    agentEmail: existing?.agentEmail,
    phoneNumber: existing?.phoneNumber,
    baltoOutput: record,
    outputHash: String(record.hash ?? "").trim() || undefined
  });
}
