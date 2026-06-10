import axios from "axios";
import { config } from "./config";

export interface BaltoStartStopPayload {
  token: string;
  email?: string;
  voip_user_id?: string;
  voip_call_id?: string;
  voip_customer_id?: string;
  voip_campaign_name?: string;
  direction?: string;
  integration?: string;
  timestamp?: string;
  voip_metadata?: Record<string, unknown>;
}

export interface BaltoCallDataRecord {
  organization_id?: number;
  call_id?: number | string;
  voip_call_id?: string;
  voip_customer_id?: string;
  voip_campaign_name?: string;
  voip_user_id?: string;
  metadata?: Record<string, unknown>;
  disposition?: string;
  agent?: string;
  username?: string;
  start_time?: string;
  end_time?: string;
  start_time_utc?: string;
  end_time_utc?: string;
  direction?: string;
  playbook?: string;
  win?: boolean;
  summary?: Record<string, unknown>;
  edited_summary?: Record<string, unknown>;
  qa_scores?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  transcript?: Array<Record<string, unknown>>;
  hash?: string;
  [key: string]: unknown;
}

interface BaltoCallDataLink {
  date?: string;
  url?: string;
}

function assertBaltoStartStopConfigured() {
  if (!config.baltoAutoStartToken) {
    throw new Error("BALTO_AUTO_START_TOKEN is required when Balto start/stop is enabled.");
  }
}

function assertBaltoDataConfigured() {
  if (!config.baltoDataAccessKey || !config.baltoOrgId) {
    throw new Error("BALTO_DATA_ACCESS_KEY and BALTO_ORG_ID are required to sync Balto call data.");
  }
}

function chooseIdentifierEndpoint(action: "start" | "stop", payload: BaltoStartStopPayload) {
  if (payload.email) {
    return `/${action}/by_email`;
  }
  if (payload.voip_user_id) {
    return `/${action}/by_voip_user_id`;
  }
  throw new Error("Balto start/stop requires email or voip_user_id.");
}

const baltoDesktopClient = axios.create({
  baseURL: "https://desktop.baltocloud.com",
  timeout: 5000,
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json"
  }
});

export async function startBaltoCall(payload: Omit<BaltoStartStopPayload, "token">) {
  assertBaltoStartStopConfigured();
  const body: BaltoStartStopPayload = {
    ...payload,
    token: config.baltoAutoStartToken
  };
  const endpoint = chooseIdentifierEndpoint("start", body);
  const response = await baltoDesktopClient.post(endpoint, body);
  return response.data;
}

export async function stopBaltoCall(payload: Omit<BaltoStartStopPayload, "token">) {
  assertBaltoStartStopConfigured();
  const body: BaltoStartStopPayload = {
    ...payload,
    token: config.baltoAutoStartToken
  };
  const endpoint = chooseIdentifierEndpoint("stop", body);
  const response = await baltoDesktopClient.post(endpoint, body);
  return response.data;
}

export async function listBaltoCallDataLinks(params: {
  startDate: string;
  endDate: string;
}): Promise<BaltoCallDataLink[]> {
  assertBaltoDataConfigured();
  const response = await axios.get<{ links?: BaltoCallDataLink[] }>(
    "https://reporting.baltocloud.com/api/calls_data_dump",
    {
      timeout: 15000,
      params: {
        start_date: params.startDate,
        end_date: params.endDate
      },
      headers: {
        auth: config.baltoDataAccessKey,
        organizationid: config.baltoOrgId,
        Accept: "application/json"
      }
    }
  );

  return response.data.links ?? [];
}

export async function downloadBaltoCallData(url: string): Promise<BaltoCallDataRecord[]> {
  const response = await axios.get<string>(url, {
    timeout: 30000,
    responseType: "text"
  });

  const raw = typeof response.data === "string" ? response.data : String(response.data ?? "");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BaltoCallDataRecord);
}

export async function syncBaltoCallData(params: {
  startDate: string;
  endDate: string;
}): Promise<BaltoCallDataRecord[]> {
  const links = await listBaltoCallDataLinks(params);
  const records: BaltoCallDataRecord[] = [];

  for (const link of links) {
    if (!link.url) {
      continue;
    }
    records.push(...await downloadBaltoCallData(link.url));
  }

  return records;
}
