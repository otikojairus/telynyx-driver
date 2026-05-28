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

interface WaveGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

async function callWaveGraphQL<T>(
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  if (!config.waveApiKey) {
    throw new Error("Wave is not configured. Set WAVE_API_KEY.");
  }

  const response = await axios.post<WaveGraphQLResponse<T>>(
    config.waveApiUrl,
    { query, variables },
    {
      timeout: 20000,
      headers: {
        Authorization: `Bearer ${config.waveApiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    }
  );

  if (response.data.errors?.length) {
    const message = response.data.errors.map((e) => e.message || "Unknown GraphQL error").join("; ");
    throw new Error(`Wave GraphQL error: ${message}`);
  }

  if (!response.data.data) {
    throw new Error("Wave GraphQL returned empty data.");
  }

  return response.data.data;
}

async function createWaveCustomer(params: {
  businessId: string;
  name: string;
  email?: string;
  phone?: string;
}) {
  const query = `
    mutation($input: CustomerCreateInput!) {
      customerCreate(input: $input) {
        didSucceed
        inputErrors { message code path }
        customer { id name email mobile }
      }
    }
  `;

  const data = await callWaveGraphQL<{
    customerCreate?: {
      didSucceed?: boolean;
      inputErrors?: Array<{ message?: string }>;
      customer?: { id?: string };
    };
  }>(query, {
    input: {
      businessId: params.businessId,
      name: params.name,
      email: params.email || undefined,
      mobile: params.phone || undefined
    }
  });

  const result = data.customerCreate;
  if (!result?.didSucceed || !result.customer?.id) {
    const reason = (result?.inputErrors ?? [])
      .map((e) => e.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(`Wave customerCreate failed${reason ? `: ${reason}` : ""}`);
  }

  return result.customer.id;
}

async function createWaveInvoice(params: {
  businessId: string;
  customerId: string;
  productId: string;
  amount: number;
  description: string;
  currency: string;
}) {
  const query = `
    mutation($input: InvoiceCreateInput!) {
      invoiceCreate(input: $input) {
        didSucceed
        inputErrors { message code path }
        invoice {
          id
          viewUrl
          status
          total { value }
          currency { code }
        }
      }
    }
  `;

  const data = await callWaveGraphQL<{
    invoiceCreate?: {
      didSucceed?: boolean;
      inputErrors?: Array<{ message?: string }>;
      invoice?: { id?: string; viewUrl?: string };
    };
  }>(query, {
    input: {
      businessId: params.businessId,
      customerId: params.customerId,
      status: "SAVED",
      currency: params.currency,
      items: [
        {
          productId: params.productId,
          description: params.description,
          quantity: 1,
          price: params.amount
        }
      ]
    }
  });

  const result = data.invoiceCreate;
  if (!result?.didSucceed || !result.invoice?.viewUrl) {
    const reason = (result?.inputErrors ?? [])
      .map((e) => e.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(`Wave invoiceCreate failed${reason ? `: ${reason}` : ""}`);
  }

  return result.invoice.viewUrl;
}

export async function createWavePaymentLink(input: CreateWavePaymentLinkInput): Promise<{
  link: string;
  providerResponse: unknown;
}> {
  if (!config.waveBusinessId) {
    throw new Error("Missing WAVE_BUSINESS_ID.");
  }
  if (!config.waveProductId) {
    throw new Error("Missing WAVE_PRODUCT_ID.");
  }

  const customerId = await createWaveCustomer({
    businessId: config.waveBusinessId,
    name: input.customer?.name || "Customer",
    email: input.customer?.email,
    phone: input.customer?.phone
  });

  const link = await createWaveInvoice({
    businessId: config.waveBusinessId,
    customerId,
    productId: config.waveProductId,
    amount: input.amount,
    description: input.description,
    currency: input.currency
  });

  return {
    link,
    providerResponse: {
      businessId: config.waveBusinessId,
      customerId
    }
  };
}
