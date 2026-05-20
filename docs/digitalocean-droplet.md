# DigitalOcean Droplet Setup

This guide deploys the Telnyx SMS to Bitrix24 Open Channel middleware on an Ubuntu DigitalOcean Droplet using Docker Compose and Nginx with HTTPS.

## What You Are Building

The production flow is:

```text
Phone SMS -> Telnyx -> https://sms.example.com/webhooks/telnyx -> Docker app -> Bitrix
Bitrix reply -> https://sms.example.com/webhooks/bitrix -> Docker app -> Telnyx -> phone SMS
```

Use a real domain or subdomain for the middleware. Bitrix and Telnyx both need a public HTTPS URL.

## 1. Create the Droplet

Create an Ubuntu LTS Droplet on DigitalOcean.

Recommended minimum:

```text
1 vCPU
1 GB RAM
Ubuntu 22.04 or 24.04 LTS
```

Point a DNS record at the Droplet IP:

```text
sms.example.com -> DROPLET_PUBLIC_IP
```

## 2. SSH Into the Droplet

```bash
ssh root@DROPLET_PUBLIC_IP
```

Update packages:

```bash
apt update
apt upgrade -y
```

## 3. Install Docker and Compose

Install Docker:

```bash
apt install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Verify:

```bash
docker --version
docker compose version
```

## 4. Install Nginx and Certbot

```bash
apt install -y nginx certbot python3-certbot-nginx
```

Allow HTTP and HTTPS through the firewall:

```bash
ufw allow OpenSSH
ufw allow "Nginx Full"
ufw --force enable
```

## 5. Upload or Clone the App

Create an app directory:

```bash
mkdir -p /opt/telnyx-bitrix
cd /opt/telnyx-bitrix
```

Clone your repository or upload the project files into this directory.

If using Git:

```bash
git clone YOUR_REPO_URL .
```

## 6. Configure `.env`

Create the env file:

```bash
cp .env.example .env
nano .env
```

Use your real domain:

```env
PORT=3000
PUBLIC_BASE_URL=https://sms.example.com
DATA_DIR=data

BITRIX_CLIENT_ID=
BITRIX_CLIENT_SECRET=
BITRIX_CONNECTOR_ID=telnyx_sms
BITRIX_CONNECTOR_NAME=Telnyx SMS
BITRIX_LINE_ID=2
BITRIX_OUTBOUND_SECRET=

TELNYX_API_KEY=your_telnyx_api_key
TELNYX_FROM_NUMBER=+18447500107
TELNYX_SIGNATURE_SECRET=
```

Leave the Bitrix client fields blank until the Bitrix Local Application is created.

## 7. Start the App

```bash
docker compose build
docker compose up -d
```

Check logs:

```bash
docker compose logs -f
```

The app listens internally on port `3000`.

## 8. Configure Nginx Reverse Proxy

Create an Nginx site:

```bash
nano /etc/nginx/sites-available/telnyx-bitrix
```

Paste:

```nginx
server {
    listen 80;
    server_name sms.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable it:

```bash
ln -s /etc/nginx/sites-available/telnyx-bitrix /etc/nginx/sites-enabled/telnyx-bitrix
nginx -t
systemctl reload nginx
```

## 9. Enable HTTPS

```bash
certbot --nginx -d sms.example.com
```

Test:

```bash
curl https://sms.example.com/health
```

Expected:

```json
{"ok":true}
```

## 10. Create the Bitrix Local Application

In Bitrix24:

1. Go to `Developer resources`.
2. Open `Other`.
3. Choose `Local Application`.
4. Select `Server`.
5. Set `Your handler path` to:

```text
https://sms.example.com/bitrix/connector/settings
```

6. Set `Initial installation path` to:

```text
https://sms.example.com/bitrix/install
```

7. Check `Script only (no user interface)`.
8. Add permissions:

```text
basic
im
imopenlines
imconnector
```

9. Click `Save`.

Copy the Bitrix app client ID and client secret into `/opt/telnyx-bitrix/.env`:

```env
BITRIX_CLIENT_ID=...
BITRIX_CLIENT_SECRET=...
```

Restart:

```bash
docker compose up -d --build
```

Return to the Bitrix app screen and click `Save` again so Bitrix calls `/bitrix/install`.

Expected logs:

```text
POST /bitrix/install 200
```

## 11. Verify Bitrix Connector

```bash
curl https://sms.example.com/bitrix/connector/status
```

Expected response includes:

```json
{
  "CONFIGURED": true,
  "STATUS": true
}
```

If needed:

```bash
curl -X POST https://sms.example.com/bitrix/connector/register
```

## 12. Configure Telnyx

In the Telnyx Messaging Profile assigned to `+18447500107`, set webhook URL:

```text
https://sms.example.com/webhooks/telnyx
```

Save the Messaging Profile.

## 13. End-to-End Test

Send an SMS from your phone to:

```text
+18447500107
```

Watch logs:

```bash
docker compose logs -f
```

Expected:

```text
POST /webhooks/telnyx 200
Sending inbound SMS to Bitrix
Bitrix imconnector.send.messages response
```

In Bitrix, open:

```text
Contact Center -> Open Channel / Open Lines
```

Reply in Bitrix. Your phone should receive the SMS.

## 14. Operational Commands

Restart:

```bash
docker compose restart
```

Rebuild after code changes:

```bash
docker compose up -d --build
```

View logs:

```bash
docker compose logs -f
```

Check container status:

```bash
docker compose ps
```

Back up Bitrix tokens:

```bash
tar -czf bitrix-data-backup.tgz data
```

The file `data/bitrix-auth.json` contains Bitrix OAuth tokens. Treat it as sensitive.

## Troubleshooting

- `curl /health` fails: check Nginx config, Docker status, and firewall rules.
- Bitrix install fails: confirm `PUBLIC_BASE_URL` matches the HTTPS domain and the app is reachable from the internet.
- `WRONG_AUTH_TYPE`: the app is still using an inbound webhook instead of Local Application OAuth.
- Telnyx does not hit the app: confirm the Messaging Profile webhook URL and that the number is assigned to that profile.
- Messages appear in Bitrix history but not in normal chats: open Contact Center/Open Lines and search by phone number.
- Replies do not reach the phone: run `curl -X POST https://sms.example.com/bitrix/connector/register` to re-bind Bitrix events.

## Production Notes

- Keep `.env` and `data/bitrix-auth.json` private.
- Use regular Droplet snapshots or back up the `data` directory.
- Consider moving in-memory idempotency and chat mapping to Redis/Postgres if you expect high volume or multiple app replicas.
- Do not run multiple replicas of this app without shared storage for dedupe and phone mapping.
