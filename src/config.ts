import dotenv from "dotenv";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
  databaseUrl: process.env.DATABASE_URL ?? "postgresql://telnyx:telnyx@postgres:5432/telnyx",
  bitrixClientId: process.env.BITRIX_CLIENT_ID ?? "",
  bitrixClientSecret: process.env.BITRIX_CLIENT_SECRET ?? "",
  bitrixConnectorId: requireEnv("BITRIX_CONNECTOR_ID"),
  bitrixConnectorName: process.env.BITRIX_CONNECTOR_NAME ?? "Telnyx SMS",
  bitrixLineId: requireEnv("BITRIX_LINE_ID"),
  bitrixOutboundSecret: process.env.BITRIX_OUTBOUND_SECRET ?? "",
  thirdPartyWebhookSecret: process.env.THIRD_PARTY_WEBHOOK_SECRET ?? "",
  inboundDealWebhookSecret: process.env.INBOUND_DEAL_WEBHOOK_SECRET ?? "",
  bitrixLeadServiceField: process.env.BITRIX_LEAD_SERVICE_FIELD ?? "UF_CRM_SERVICE_TYPE",
  bitrixDealClientPriceField: process.env.BITRIX_DEAL_CLIENT_PRICE_FIELD ?? "",
  bitrixDealDepositLinkField: process.env.BITRIX_DEAL_DEPOSIT_LINK_FIELD ?? "",
  bitrixDealCalloutLinkField: process.env.BITRIX_DEAL_CALLOUT_LINK_FIELD ?? "",
  bitrixQuotePresentedStageId: process.env.BITRIX_QUOTE_PRESENTED_STAGE_ID ?? "",
  bitrixDealForwardWebhookUrl: process.env.BITRIX_DEAL_FORWARD_WEBHOOK_URL ?? "",
  dataDir: process.env.DATA_DIR ?? "data",
  telnyxApiKey: requireEnv("TELNYX_API_KEY"),
  telnyxFromNumber: requireEnv("TELNYX_FROM_NUMBER"),
  telnyxSignatureSecret: process.env.TELNYX_SIGNATURE_SECRET ?? "",
  telnyxForwardWebhookUrl: process.env.TELNYX_FORWARD_WEBHOOK_URL ?? "",
  telnyxCallForwardWebhookUrl: process.env.TELNYX_CALL_FORWARD_WEBHOOK_URL ?? "",
  telnyxWebhookStoreLimit: Number(process.env.TELNYX_WEBHOOK_STORE_LIMIT ?? 1000),
  emailApiUrl: process.env.EMAIL_API_URL ?? "https://pipeproof.com/wp-json/email-api/v1/send",
  leadNotificationEmailSubject: process.env.LEAD_NOTIFICATION_EMAIL_SUBJECT ?? "PRG Service Request Confirmation",
  waveApiUrl: process.env.WAVE_API_URL ?? "https://gql.waveapps.com/graphql/public",
  waveApiKey: process.env.WAVE_API_KEY ?? "",
  waveBusinessId: process.env.WAVE_BUSINESS_ID ?? "",
  waveProductId: process.env.WAVE_PRODUCT_ID ?? "",
  waveWebhookSecret: process.env.WAVE_WEBHOOK_SECRET ?? ""
};
