# Telnyx <-> Bitrix24 Open Channel Middleware

Node + TypeScript middleware that connects Telnyx SMS to Bitrix24 Open Channels.

It supports the full loop:

```text
Customer SMS -> Telnyx -> Middleware -> Bitrix Open Channel
Bitrix agent reply -> Middleware -> Telnyx -> Customer SMS
```

## Setup Guides

- Local setup with Docker Compose and a public tunnel: [docs/local-setup.md](docs/local-setup.md)
- DigitalOcean Droplet setup with Docker Compose, Nginx, and HTTPS: [docs/digitalocean-droplet.md](docs/digitalocean-droplet.md)

## Requirements

- Telnyx SMS-capable number and API key.
- Bitrix24 Open Channel/Open Line.
- Bitrix24 Local Application with these permissions:

```text
basic
im
imopenlines
imconnector
```

## Environment

Create:

```bash
cp .env.example .env
```

Important values:

```env
PORT=3000
PUBLIC_BASE_URL=https://your-public-middleware-url
DATA_DIR=data
DATABASE_URL=postgresql://telnyx:telnyx@postgres:5432/telnyx

POSTGRES_DB=telnyx
POSTGRES_USER=telnyx
POSTGRES_PASSWORD=telnyx
POSTGRES_PORT=5432

PGADMIN_DEFAULT_EMAIL=admin@example.com
PGADMIN_DEFAULT_PASSWORD=admin123
PGADMIN_PORT=5050

BITRIX_CLIENT_ID=your_local_app_client_id
BITRIX_CLIENT_SECRET=your_local_app_client_secret
BITRIX_CONNECTOR_ID=telnyx_sms
BITRIX_CONNECTOR_NAME=Telnyx SMS
BITRIX_LINE_ID=2
BITRIX_DEAL_FORWARD_WEBHOOK_URL=
BITRIX_LEAD_SERVICE_FIELD=UF_CRM_SERVICE_TYPE

TELNYX_API_KEY=your_telnyx_api_key
TELNYX_FROM_NUMBER=+18447500107
TELNYX_FORWARD_WEBHOOK_URL=
TELNYX_CALL_FORWARD_WEBHOOK_URL=
TELNYX_WEBHOOK_STORE_LIMIT=1000

EMAIL_API_URL=https://pipeproof.com/wp-json/email-api/v1/send
LEAD_NOTIFICATION_EMAIL_SUBJECT=PRG Service Request Confirmation
```

`PUBLIC_BASE_URL` must be reachable by both Bitrix and Telnyx over HTTPS.

## Run

```bash
docker compose build
docker compose up
```

This now starts:

- Middleware on `http://localhost:3000`
- Postgres on `localhost:${POSTGRES_PORT}`
- pgAdmin on `http://localhost:${PGADMIN_PORT}`

Use these pgAdmin connection settings:

```text
Host: postgres
Port: 5432
Database: ${POSTGRES_DB}
Username: ${POSTGRES_USER}
Password: ${POSTGRES_PASSWORD}
```

## Bitrix App URLs

Use these in the Bitrix24 Local Application screen:

```text
Handler path:
${PUBLIC_BASE_URL}/bitrix/connector/settings

Initial installation path:
${PUBLIC_BASE_URL}/bitrix/install
```

After the app saves/installs successfully, the middleware stores Bitrix OAuth tokens in:

```text
./data/bitrix-auth.json
```

Treat that file as sensitive.

## Telnyx Webhook

Set the Telnyx Messaging Profile webhook URL to:

```text
${PUBLIC_BASE_URL}/webhooks/telnyx
```

If you also want inbound Telnyx SMS webhooks stored in Postgres and mirrored to your own system, set:

```text
TELNYX_FORWARD_WEBHOOK_URL=https://your-app.example.com/webhooks/telnyx
```

If you also want Telnyx call events stored and mirrored to a separate system, set:

```text
TELNYX_CALL_FORWARD_WEBHOOK_URL=https://your-app.example.com/webhooks/telnyx-calls
```

The middleware stores webhook records in the `telnyx_webhooks` Postgres table.

## Useful Endpoints

- `GET /health`
- `POST /sms/send`
- `POST /debug/bitrix/test-message`
- `GET /debug/bitrix/latest-history`
- `GET /debug/telnyx/webhooks`
- `POST /bitrix/connector/register`
- `POST /bitrix/leads/register`
- `GET /bitrix/connector/status`
- `POST /webhooks/telnyx`
- `POST /webhooks/bitrix`
- `POST /webhooks/bitrix/leads`

## External-Facing APIs (For Other Systems)

Base URL: `https://<your-domain>` (local: `http://localhost:3000`)

### Send SMS API

- `POST /sms/send`
- Purpose: Send outbound SMS through Telnyx.
- Body:

```json
{
  "to": "+2547XXXXXXXX",
  "text": "Hello"
}
```

### Data Ingestion APIs (Inbound)

- `POST /webhooks/telnyx`
- Purpose: Receive inbound Telnyx webhooks (SMS and call events).
- Security: If `TELNYX_SIGNATURE_SECRET` is set, requests must include `telnyx-signature-ed25519` and `telnyx-timestamp`.

- `POST /webhooks/bitrix`
- Purpose: Receive Bitrix Open Channel reply events and forward them as SMS via Telnyx.
- Security: If `BITRIX_OUTBOUND_SECRET` is set, include header `x-bitrix-secret`.

- `POST /webhooks/bitrix/deals`
- Purpose: Receive Bitrix deal events (`ONCRMDEALADD`, `ONCRMDEALUPDATE`).
- Security: If `BITRIX_OUTBOUND_SECRET` is set, include header `x-bitrix-secret`.
- Persistence: Events are stored in Postgres table `bitrix_deals`.
- Notifications: Sends SMS and email status updates to the linked deal contact (when `CONTACT_ID` and contact phone/email exist).

- `POST /webhooks/bitrix/leads`
- Purpose: Receive Bitrix lead-add events (`ONCRMLEADADD`), then send confirmation SMS and email to the lead contact.
- Security: If `BITRIX_OUTBOUND_SECRET` is set, include header `x-bitrix-secret`.

### Data Output APIs (Read/Export)

- `GET /debug/telnyx/webhooks`
- Purpose: Return stored Telnyx webhook records from Postgres.
- Query: `limit` (optional), example: `/debug/telnyx/webhooks?limit=100`

- `GET /debug/bitrix/deal-events`
- Purpose: Return recent in-memory Bitrix deal webhook events.

- `GET /debug/bitrix/reply-webhooks`
- Purpose: Return recent in-memory Bitrix reply webhook events.

- `GET /debug/bitrix/latest-history`
- Purpose: Return latest Bitrix Open Line history for the last observed session.

### Push Output To Another System (Optional)

- `TELNYX_FORWARD_WEBHOOK_URL`: Forwards stored inbound Telnyx SMS webhooks to your endpoint.
- `TELNYX_CALL_FORWARD_WEBHOOK_URL`: Forwards stored Telnyx call webhooks to your endpoint.
- `BITRIX_DEAL_FORWARD_WEBHOOK_URL`: Forwards stored Bitrix deal webhook events to your endpoint.
- `EMAIL_API_URL`: endpoint used to send lead confirmation emails (default: Pipeproof API).

## Debug Commands

Check Bitrix connector status:

```bash
curl http://localhost:3000/bitrix/connector/status
```

Re-register connector and re-bind reply events:

```bash
curl -X POST http://localhost:3000/bitrix/connector/register
```

Send a manual SMS:

```bash
curl -X POST http://localhost:3000/sms/send \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+254722753364",
    "text": "Hello from the middleware"
  }'
```

Send a test message directly into Bitrix:

```bash
curl -X POST http://localhost:3000/debug/bitrix/test-message \
  -H "Content-Type: application/json" \
  -d '{
    "from": "+254700000000",
    "text": "Testing Bitrix Open Channel"
  }'
```

Read latest Bitrix Open Line history:

```bash
curl http://localhost:3000/debug/bitrix/latest-history
```

Read stored Telnyx webhooks:

```bash
curl http://localhost:3000/debug/telnyx/webhooks
```

## Notes

- This integration uses a Bitrix24 Local Application, not a simple inbound webhook. Bitrix rejects `imconnector.send.messages` from webhook auth with `WRONG_AUTH_TYPE`.
- Open Channel conversations appear under Bitrix Contact Center/Open Lines, not always under normal internal Chats.
- The app stores Bitrix OAuth tokens in `./data`, mounted into Docker by `docker-compose.yml`.
- Telnyx webhook records are now stored in Postgres, while Bitrix OAuth tokens remain in `./data/bitrix-auth.json`.
- In-memory idempotency and phone mapping are still fine for one instance. Use Redis/shared state before running multiple replicas.



## IF SMS IS NOT RECHABLE

docker compose exec middleware printenv PUBLIC_BASE_URL
curl -X POST http://localhost:3000/bitrix/connector/register
