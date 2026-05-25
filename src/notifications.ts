import nodemailer from "nodemailer";
import { config } from "./config";

let cachedTransporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (cachedTransporter) {
    return cachedTransporter;
  }

  cachedTransporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth:
      config.smtpUser && config.smtpPass
        ? {
            user: config.smtpUser,
            pass: config.smtpPass
          }
        : undefined
  });

  return cachedTransporter;
}

export function canSendEmail(): boolean {
  return Boolean(config.smtpHost && config.smtpFrom);
}

export async function sendLeadConfirmationEmail(params: {
  to: string;
  customerName: string;
  serviceType: string;
}): Promise<void> {
  const transporter = getTransporter();
  const message = `Hi ${params.customerName}, this is PRG confirming your service request for ${params.serviceType}. A technician will be in touch shortly.`;

  await transporter.sendMail({
    from: config.smtpFrom,
    to: params.to,
    subject: config.leadNotificationEmailSubject,
    text: message
  });
}
