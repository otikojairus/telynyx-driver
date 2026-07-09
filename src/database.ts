import { Pool, QueryResultRow } from "pg";
import { config } from "./config";

const pool = new Pool({
  connectionString: config.databaseUrl
});

export async function initializeDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS telnyx_webhooks (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_channel TEXT NOT NULL DEFAULT 'other',
      received_at TIMESTAMPTZ NOT NULL,
      phone_from TEXT NOT NULL,
      phone_to TEXT NOT NULL,
      text_body TEXT NOT NULL,
      status TEXT NOT NULL,
      raw_body JSONB NOT NULL,
      bitrix JSONB,
      outbound_forward JSONB
    )
  `);

  await pool.query(`
    ALTER TABLE telnyx_webhooks
    ADD COLUMN IF NOT EXISTS event_channel TEXT NOT NULL DEFAULT 'other'
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_telnyx_webhooks_received_at
    ON telnyx_webhooks (received_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_telnyx_webhooks_event_id
    ON telnyx_webhooks (event_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bitrix_deals (
      id TEXT PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL,
      event_name TEXT NOT NULL,
      deal_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      classification TEXT NOT NULL,
      job_id TEXT,
      client_name TEXT,
      phone_number TEXT,
      address_postal_code TEXT,
      service_type TEXT,
      urgency_level TEXT,
      deal_title TEXT,
      pipeline_id TEXT,
      pipeline_name TEXT,
      stage_name TEXT,
      raw_body JSONB NOT NULL,
      outbound_forward JSONB
    )
  `);

  await pool.query(`
    ALTER TABLE bitrix_deals ADD COLUMN IF NOT EXISTS job_id TEXT
  `);
  await pool.query(`
    ALTER TABLE bitrix_deals ADD COLUMN IF NOT EXISTS client_name TEXT
  `);
  await pool.query(`
    ALTER TABLE bitrix_deals ADD COLUMN IF NOT EXISTS phone_number TEXT
  `);
  await pool.query(`
    ALTER TABLE bitrix_deals ADD COLUMN IF NOT EXISTS address_postal_code TEXT
  `);
  await pool.query(`
    ALTER TABLE bitrix_deals ADD COLUMN IF NOT EXISTS service_type TEXT
  `);
  await pool.query(`
    ALTER TABLE bitrix_deals ADD COLUMN IF NOT EXISTS urgency_level TEXT
  `);
  await pool.query(`
    ALTER TABLE bitrix_deals ADD COLUMN IF NOT EXISTS deal_title TEXT
  `);
  await pool.query(`
    ALTER TABLE bitrix_deals ADD COLUMN IF NOT EXISTS pipeline_id TEXT
  `);
  await pool.query(`
    ALTER TABLE bitrix_deals ADD COLUMN IF NOT EXISTS pipeline_name TEXT
  `);
  await pool.query(`
    ALTER TABLE bitrix_deals ADD COLUMN IF NOT EXISTS stage_name TEXT
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_bitrix_deals_received_at
    ON bitrix_deals (received_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_bitrix_deals_deal_id
    ON bitrix_deals (deal_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS balto_call_sessions (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL,
      telnyx_event_id TEXT,
      telnyx_call_control_id TEXT,
      telnyx_call_leg_id TEXT,
      bitrix_call_id TEXT,
      bitrix_deal_id TEXT,
      agent_email TEXT,
      voip_user_id TEXT,
      phone_number TEXT,
      direction TEXT,
      voip_call_id TEXT NOT NULL,
      voip_customer_id TEXT,
      voip_campaign_name TEXT,
      start_requested_at TIMESTAMPTZ,
      stop_requested_at TIMESTAMPTZ,
      start_response JSONB,
      stop_response JSONB,
      balto_call_id TEXT,
      balto_output JSONB,
      output_hash TEXT,
      last_error TEXT,
      raw_start_event JSONB,
      raw_stop_event JSONB
    )
  `);

  await pool.query(`
    ALTER TABLE balto_call_sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  `);
  await pool.query(`
    ALTER TABLE balto_call_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  `);
  await pool.query(`
    ALTER TABLE balto_call_sessions ADD COLUMN IF NOT EXISTS balto_call_id TEXT
  `);
  await pool.query(`
    ALTER TABLE balto_call_sessions ADD COLUMN IF NOT EXISTS balto_output JSONB
  `);
  await pool.query(`
    ALTER TABLE balto_call_sessions ADD COLUMN IF NOT EXISTS output_hash TEXT
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_balto_call_sessions_voip_call_id
    ON balto_call_sessions (voip_call_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_balto_call_sessions_status
    ON balto_call_sessions (status)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS call_transcripts (
      call_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      owner_type_id INTEGER,
      owner_id BIGINT,
      crm_entity_type TEXT,
      crm_entity_id TEXT,
      direction TEXT,
      phone_number TEXT,
      audio_url TEXT,
      call_start TIMESTAMPTZ,
      call_end TIMESTAMPTZ,
      transcript_text TEXT,
      transcript_record_id TEXT,
      bitrix_activity_id TEXT,
      last_error TEXT,
      raw_transcript_response JSONB,
      raw_statistic JSONB
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_call_transcripts_owner
    ON call_transcripts (owner_type_id, owner_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_call_transcripts_updated_at
    ON call_transcripts (updated_at DESC)
  `);
}

export async function queryDatabase<T extends QueryResultRow = QueryResultRow>(
  queryText: string,
  values: unknown[] = []
): Promise<T[]> {
  const result = await pool.query<T>(queryText, values);
  return result.rows;
}

export async function executeDatabase(
  queryText: string,
  values: unknown[] = []
): Promise<void> {
  await pool.query(queryText, values);
}
