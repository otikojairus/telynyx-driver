import axios from "axios";
import { config } from "./config";

export function canSendEmail(): boolean {
  return Boolean(config.emailApiUrl);
}

export async function sendLeadConfirmationEmail(params: {
  to: string;
  customerName: string;
  serviceType: string;
  message?: string;
  subject?: string;
}): Promise<void> {
  const message =
    params.message ??
    `Hi ${params.customerName}, this is PRG confirming your service request for ${params.serviceType}. A technician will be in touch shortly.`;

  const cleanedMessage = message
    .replace(
      new RegExp(
        `^Hi\\s+${params.customerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,\\s*this is PRG\\.\\s*Update on your service request for\\s+${params.serviceType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*we have received your service request\\.\\s*`,
        "i"
      ),
      ""
    )
    .trim();

  const emailTemplate = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>ProofResponse Confirmation</title>
      </head>
      <body style="margin:0;padding:0;background-color:#f4f7fb;font-family:Arial,sans-serif;color:#14365B;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f7fb;padding:24px 12px;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 10px 30px rgba(20,54,91,0.12);">
                <tr>
                  <td style="background:#14365B;padding:26px 28px;text-align:center;">
                    <img src="https://proofresponse.com/wp-content/uploads/2026/01/ProofResponse-Logo.png" alt="ProofResponse Logo" style="max-width:220px;width:100%;height:auto;display:inline-block;" />
                  </td>
                </tr>
                <tr>
                  <td style="padding:30px 28px 20px 28px;">
                    <h1 style="margin:0 0 14px 0;font-size:24px;line-height:1.25;color:#14365B;">Service Request Confirmed</h1>
                    <p style="margin:0 0 12px 0;font-size:16px;line-height:1.6;color:#14365B;">Hi ${params.customerName},</p>
                    <p style="margin:0 0 12px 0;font-size:16px;line-height:1.6;color:#14365B;">
                      Thank you for choosing ProofResponse. We have successfully received your request for
                      <strong>${params.serviceType}</strong>, and your case is now in our active response queue.
                    </p>
                    <p style="margin:0 0 18px 0;font-size:16px;line-height:1.6;color:#14365B;">
                      ${cleanedMessage} Our team is reviewing the details and will reach out shortly with the next
                      steps, expected timeline, and any information we may need to speed up resolution.
                    </p>
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 0 0;">
                      <tr>
                        <td style="background:#FBBF24;border-radius:8px;padding:12px 18px;font-size:14px;font-weight:700;color:#14365B;">
                          Service: ${params.serviceType}
                        </td>
                      </tr>
                    </table>
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0 0;">
                      <tr>
                        <td align="center" style="background:#14365B;border-radius:8px;">
                          <a href="tel:+18447500107" style="display:inline-block;padding:13px 20px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">
                            Contact Support: +1 (844) 750-0107
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 28px 30px 28px;">
                    <div style="border-top:1px solid #e8eef5;padding-top:16px;font-size:13px;line-height:1.5;color:#6a7c93;">
                      <p style="margin:0 0 8px 0;">
                        If this is urgent, please use the support line above and mention your service type for faster routing.
                      </p>
                      <p style="margin:0;">Thank you for choosing ProofResponse. We appreciate your trust in our team.</p>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="background:#14365B;padding:14px 28px;text-align:center;font-size:12px;line-height:1.5;color:#ffffff;">
                    © ${new Date().getFullYear()} ProofResponse. All rights reserved.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;

  await axios.post(
    config.emailApiUrl,
    {
      to: params.to,
      subject: params.subject ?? config.leadNotificationEmailSubject,
      message: emailTemplate
    },
    {
      timeout: 15000,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
}
