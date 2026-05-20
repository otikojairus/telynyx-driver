import fs from "fs";
import path from "path";
import { config } from "./config";

export interface BitrixAuthTokens {
  accessToken: string;
  refreshToken: string;
  clientEndpoint: string;
  serverEndpoint: string;
  domain?: string;
  memberId?: string;
  expiresAt: number;
  applicationToken?: string;
}

const tokenPath = path.join(config.dataDir, "bitrix-auth.json");

export function readBitrixTokens(): BitrixAuthTokens | null {
  if (!fs.existsSync(tokenPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(tokenPath, "utf8")) as BitrixAuthTokens;
}

export function writeBitrixTokens(tokens: BitrixAuthTokens): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
}
