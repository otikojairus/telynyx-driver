import axios from "axios";
import { config } from "./config";

export interface CreateWavePaymentLinkInput {
  amount: number;
  currency: string;
  description: string;
  metadata: Record<string, unknown>;
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
  };
}

function extractPaymentLink(responseData: unknown): string {
  if (!responseData || typeof responseData !== "object") {
    return "";
  }

  const data = responseData as Record<string, unknown>;
  const direct =
    data.url ?? data.checkout_url ?? data.payment_url ?? data.hosted_url ?? data.link ?? "";

  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const nested = data.data;
  if (nested && typeof nested === "object") {
    const nestedRecord = nested as Record<string, unknown>;
    const nestedDirect =
      nestedRecord.url ??
      nestedRecord.checkout_url ??
      nestedRecord.payment_url ??
      nestedRecord.hosted_url ??
      nestedRecord.link ??
      "";
    if (typeof nestedDirect === "string" && nestedDirect.trim()) {
      return nestedDirect.trim();
    }
  }

  return "";
}

export async function createWavePaymentLink(input: CreateWavePaymentLinkInput): Promise<{
  link: string;
  providerResponse: unknown;
}> {
  if (!config.waveApiUrl || !config.waveApiKey) {
    throw new Error("Wave is not configured. Set WAVE_API_URL and WAVE_API_KEY.");
  }

  const url = new URL(config.waveCreateLinkPath, config.waveApiUrl).toString();
  const payload = {
    amount: input.amount,
    currency: input.currency,
    description: input.description,
    metadata: input.metadata,
    customer: input.customer
  };

  const response = await axios.post(url, payload, {
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${config.waveApiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    }
  });

  const link = extractPaymentLink(response.data);
  if (!link) {
    throw new Error("Wave link creation succeeded but no payment URL was found in response.");
  }

  return {
    link,
    providerResponse: response.data
  };
}
