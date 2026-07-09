import axios from "axios";
import { config } from "./config";

export interface WaveInvoiceItemInput {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface CreateWavePaymentLinkInput {
  items: WaveInvoiceItemInput[];
  currency: string;
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

  try {
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
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const details = error.response?.data as WaveGraphQLResponse<unknown> | undefined;
      const graphqlErrors = details?.errors ?? [];
      if (graphqlErrors.length > 0) {
        const message = graphqlErrors.map((e) => e.message || "Unknown GraphQL error").join("; ");
        throw new Error(`Wave GraphQL error: ${message}`);
      }
      throw new Error(`Wave GraphQL request failed with status ${error.response?.status ?? "unknown"}`);
    }
    throw error;
  }
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
  items: WaveInvoiceItemInput[];
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
      invoice?: { id?: string; viewUrl?: string; total?: { value?: string | number }; currency?: { code?: string } };
    };
  }>(query, {
    input: {
      businessId: params.businessId,
      customerId: params.customerId,
      status: "SAVED",
      currency: params.currency,
      items: params.items.map((item) => ({
        productId: params.productId,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice
      }))
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

  return {
    link: result.invoice.viewUrl,
    total: result.invoice.total?.value ? Number(result.invoice.total.value) : null,
    currency: result.invoice.currency?.code ?? params.currency
  };
}

export async function createWavePaymentLink(input: CreateWavePaymentLinkInput): Promise<{
  link: string;
  total: number;
  currency: string;
  providerResponse: unknown;
}> {
  if (!config.waveBusinessId) {
    throw new Error("Missing WAVE_BUSINESS_ID.");
  }
  if (!config.waveProductId) {
    throw new Error("Missing WAVE_PRODUCT_ID.");
  }
  if (!input.items.length) {
    throw new Error("At least one invoice item is required.");
  }

  const customerId = await createWaveCustomer({
    businessId: config.waveBusinessId,
    name: input.customer?.name || "Customer",
    email: input.customer?.email,
    phone: input.customer?.phone
  });

  const invoice = await createWaveInvoice({
    businessId: config.waveBusinessId,
    customerId,
    productId: config.waveProductId,
    items: input.items,
    currency: input.currency
  });

  const fallbackTotal = input.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

  return {
    link: invoice.link,
    total: invoice.total ?? fallbackTotal,
    currency: invoice.currency,
    providerResponse: {
      businessId: config.waveBusinessId,
      customerId
    }
  };
}
