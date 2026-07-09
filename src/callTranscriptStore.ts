import { executeDatabase, queryDatabase } from "./database";

export interface CallTranscriptRecord {
  callId: string;
  status:
    | "activity_created"
    | "no_transcript"
    | "transcript_no_owner"
    | "statistic_not_found"
    | "recording_missing"
    | "error";
  attempts: number;
  ownerTypeId?: number | null;
  ownerId?: number | null;
  crmEntityType?: string | null;
  crmEntityId?: string | null;
  direction?: string | null;
  phoneNumber?: string | null;
  audioUrl?: string | null;
  callStart?: string | null;
  callEnd?: string | null;
  transcriptText?: string | null;
  transcriptRecordId?: string | null;
  bitrixActivityId?: string | null;
  lastError?: string | null;
  rawTranscriptResponse?: unknown;
  rawStatistic?: unknown;
}

interface CallTranscriptRow {
  call_id: string;
  created_at: string | Date;
  updated_at: string | Date;
  status: CallTranscriptRecord["status"];
  attempts: number;
  owner_type_id: number | null;
  owner_id: string | number | null;
  crm_entity_type: string | null;
  crm_entity_id: string | null;
  direction: string | null;
  phone_number: string | null;
  audio_url: string | null;
  call_start: string | Date | null;
  call_end: string | Date | null;
  transcript_text: string | null;
  transcript_record_id: string | null;
  bitrix_activity_id: string | null;
  last_error: string | null;
  raw_transcript_response: unknown;
  raw_statistic: unknown;
}

function toIsoOrNull(value: string | Date | null): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRowToRecord(row: CallTranscriptRow): CallTranscriptRecord & { createdAt: string; updatedAt: string } {
  return {
    callId: row.call_id,
    createdAt: toIsoOrNull(row.created_at) ?? "",
    updatedAt: toIsoOrNull(row.updated_at) ?? "",
    status: row.status,
    attempts: row.attempts,
    ownerTypeId: row.owner_type_id,
    ownerId: row.owner_id !== null ? Number(row.owner_id) : null,
    crmEntityType: row.crm_entity_type,
    crmEntityId: row.crm_entity_id,
    direction: row.direction,
    phoneNumber: row.phone_number,
    audioUrl: row.audio_url,
    callStart: toIsoOrNull(row.call_start),
    callEnd: toIsoOrNull(row.call_end),
    transcriptText: row.transcript_text,
    transcriptRecordId: row.transcript_record_id,
    bitrixActivityId: row.bitrix_activity_id,
    lastError: row.last_error,
    rawTranscriptResponse: row.raw_transcript_response,
    rawStatistic: row.raw_statistic
  };
}

export async function saveCallTranscriptRecord(record: CallTranscriptRecord): Promise<void> {
  await executeDatabase(
    `
      INSERT INTO call_transcripts (
        call_id,
        status,
        attempts,
        owner_type_id,
        owner_id,
        crm_entity_type,
        crm_entity_id,
        direction,
        phone_number,
        audio_url,
        call_start,
        call_end,
        transcript_text,
        transcript_record_id,
        bitrix_activity_id,
        last_error,
        raw_transcript_response,
        raw_statistic,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11::timestamptz, $12::timestamptz, $13, $14, $15, $16, $17::jsonb, $18::jsonb, now()
      )
      ON CONFLICT (call_id) DO UPDATE SET
        status = EXCLUDED.status,
        attempts = EXCLUDED.attempts,
        owner_type_id = EXCLUDED.owner_type_id,
        owner_id = EXCLUDED.owner_id,
        crm_entity_type = EXCLUDED.crm_entity_type,
        crm_entity_id = EXCLUDED.crm_entity_id,
        direction = EXCLUDED.direction,
        phone_number = EXCLUDED.phone_number,
        audio_url = EXCLUDED.audio_url,
        call_start = EXCLUDED.call_start,
        call_end = EXCLUDED.call_end,
        transcript_text = EXCLUDED.transcript_text,
        transcript_record_id = EXCLUDED.transcript_record_id,
        bitrix_activity_id = EXCLUDED.bitrix_activity_id,
        last_error = EXCLUDED.last_error,
        raw_transcript_response = EXCLUDED.raw_transcript_response,
        raw_statistic = EXCLUDED.raw_statistic,
        updated_at = now()
    `,
    [
      record.callId,
      record.status,
      record.attempts,
      record.ownerTypeId ?? null,
      record.ownerId ?? null,
      record.crmEntityType ?? null,
      record.crmEntityId ?? null,
      record.direction ?? null,
      record.phoneNumber ?? null,
      record.audioUrl ?? null,
      record.callStart ?? null,
      record.callEnd ?? null,
      record.transcriptText ?? null,
      record.transcriptRecordId ?? null,
      record.bitrixActivityId ?? null,
      record.lastError ?? null,
      JSON.stringify(record.rawTranscriptResponse ?? null),
      JSON.stringify(record.rawStatistic ?? null)
    ]
  );
}

export async function listRecentCallTranscriptRecords(limit = 50) {
  const rows = await queryDatabase<CallTranscriptRow>(
    `SELECT * FROM call_transcripts ORDER BY updated_at DESC LIMIT $1`,
    [limit]
  );
  return rows.map(mapRowToRecord);
}

export async function listCallTranscriptRecordsByOwner(ownerTypeId: number, ownerId: number) {
  const rows = await queryDatabase<CallTranscriptRow>(
    `
      SELECT * FROM call_transcripts
      WHERE owner_type_id = $1 AND owner_id = $2 AND transcript_text IS NOT NULL
      ORDER BY call_start DESC NULLS LAST, updated_at DESC
    `,
    [ownerTypeId, ownerId]
  );
  return rows.map(mapRowToRecord);
}
