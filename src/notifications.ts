import axios from "axios";
import { config } from "./config";

export function canSendEmail(): boolean {
  return Boolean(config.emailApiUrl);
}

export async function sendLeadConfirmationEmail(params: {
  to: string;
  customerName: string;
  serviceType: string;
}): Promise<void> {
  const message = `Hi ${params.customerName}, this is PRG confirming your service request for ${params.serviceType}. A technician will be in touch shortly.`;

  await axios.post(
    config.emailApiUrl,
    {
      to: params.to,
      subject: config.leadNotificationEmailSubject,
      message: `<p>${message}</p>`
    },
    {
      timeout: 15000,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
}
