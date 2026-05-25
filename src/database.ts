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
      raw_body JSONB NOT NULL,
      outbound_forward JSONB
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_bitrix_deals_received_at
    ON bitrix_deals (received_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_bitrix_deals_deal_id
    ON bitrix_deals (deal_id)
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
