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
  bitrixClientId: process.env.BITRIX_CLIENT_ID ?? "",
  bitrixClientSecret: process.env.BITRIX_CLIENT_SECRET ?? "",
  bitrixConnectorId: requireEnv("BITRIX_CONNECTOR_ID"),
  bitrixConnectorName: process.env.BITRIX_CONNECTOR_NAME ?? "Telnyx SMS",
  bitrixLineId: requireEnv("BITRIX_LINE_ID"),
  bitrixOutboundSecret: process.env.BITRIX_OUTBOUND_SECRET ?? "",
  dataDir: process.env.DATA_DIR ?? "data",
  telnyxApiKey: requireEnv("TELNYX_API_KEY"),
  telnyxFromNumber: requireEnv("TELNYX_FROM_NUMBER"),
  telnyxSignatureSecret: process.env.TELNYX_SIGNATURE_SECRET ?? ""
};
