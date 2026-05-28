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
BITRIX_OUTBOUND_SECRET=
THIRD_PARTY_WEBHOOK_SECRET=
INBOUND_DEAL_WEBHOOK_SECRET=
BITRIX_DEAL_FORWARD_WEBHOOK_URL=
BITRIX_LEAD_SERVICE_FIELD=UF_CRM_SERVICE_TYPE
BITRIX_DEAL_CLIENT_PRICE_FIELD=UF_CRM_CLIENT_PRICE
BITRIX_QUOTE_PRESENTED_STAGE_ID=

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

## API Reference

Base URL: `https://<your-domain>` (local: `http://localhost:3000`)

### `GET /health`

- Purpose: Health check.
- Auth: None.
- Request body: None.
- Response:

```json
{ "ok": true }
```

### `POST /sms/send`

- Purpose: Send outbound SMS via Telnyx.
- Auth: None.
- Request body:

```json
{
  "to": "+2547XXXXXXXX",
  "text": "Hello from middleware"
}
```

- Response: `{ ok, telnyx }` on success.

### `POST /webhooks/telnyx`

- Purpose: Receive inbound Telnyx webhooks (SMS/call events).
- Auth:
  - If `TELNYX_SIGNATURE_SECRET` is set, requires headers:
    - `telnyx-signature-ed25519`
    - `telnyx-timestamp`
- Request body: Native Telnyx webhook payload.
- Response: `{ ok: true }`, or `{ ignored: true }`, `{ duplicate: true }`, etc.

### `POST /webhooks/bitrix`

- Purpose: Receive Bitrix Open Channel reply webhook and send SMS via Telnyx.
- Auth:
  - If `BITRIX_OUTBOUND_SECRET` is set, requires header `x-bitrix-secret`.
- Request body: Bitrix `OnImConnectorMessageAdd` webhook payload.
- Response: `{ ok: true }`, or `{ duplicate: true }`, `{ ignored: true }`.

### `POST /webhooks/bitrix/deals`

- Purpose: Receive Bitrix deal events, store to DB, optionally forward externally, and send deal status notifications.
- Auth:
  - If `BITRIX_OUTBOUND_SECRET` is set, requires header `x-bitrix-secret`.
- Request body: Bitrix `OnCrmDealAdd` / `OnCrmDealUpdate` webhook payload.
- Response (shape):

```json
{
  "ok": true,
  "tracked": true,
  "dealId": "12345",
  "stageId": "C1:NEW",
  "classification": "stage_changed",
  "details": {
    "jobId": "12345",
    "clientName": "Jane Doe",
    "phoneNumber": "+2547XXXXXXXX",
    "addressPostalCode": "Westlands / 00100",
    "serviceType": "Plumbing",
    "urgencyLevel": "High"
  },
  "forwarded": false,
  "sms": { "attempted": true, "sent": true },
  "email": { "attempted": true, "sent": false, "error": "..." }
}
```

### `POST /webhooks/bitrix/leads`

- Purpose: Receive lead-add events and send confirmation SMS + email.
- Auth:
  - If `BITRIX_OUTBOUND_SECRET` is set, requires header `x-bitrix-secret`.
- Request body: Bitrix `OnCrmLeadAdd` webhook payload.
- Response: `{ ok, leadId, customerName, serviceType, sms, email }`.

### `POST /webhooks/inbound/bitrix/deals/status`

- Purpose: Inbound API for external systems to move Bitrix deal stage (`crm.deal.update`).
- Auth:
  - If `INBOUND_DEAL_WEBHOOK_SECRET` is set, requires header `x-inbound-secret`.
- Request body:

```json
{
  "dealId": "12345",
  "stageId": "C1:NEW",
  "clientPrice": 12500,
  "fields": {
    "COMMENTS": "Moved by external system"
  }
}
```

- Notes:
  - If `clientPrice` is provided, it is written to the custom field in `BITRIX_DEAL_CLIENT_PRICE_FIELD` (default: `UF_CRM_CLIENT_PRICE`).
- Response: `{ ok, moved, dealId, stageId, clientPrice, clientPriceField, result }`.

### `POST /webhooks/inbound/bitrix/deals/quote-presented`

- Purpose: Move a deal to the Quote Presented stage and store the final client-facing price (post-markup).
- Auth:
  - If `INBOUND_DEAL_WEBHOOK_SECRET` is set, requires header `x-inbound-secret`.
- Request body:

```json
{
  "dealId": "12345",
  "clientPrice": 14500,
  "stageId": "C1:QUOTE_PRESENTED",
  "fields": {
    "COMMENTS": "Quote shared with customer"
  }
}
```

- Notes:
  - `stageId` is optional if `BITRIX_QUOTE_PRESENTED_STAGE_ID` is set.
  - `clientPrice` is required and is persisted to `BITRIX_DEAL_CLIENT_PRICE_FIELD`.
- Response: `{ ok, moved, dealId, stageId, quote: { clientPrice, clientPriceField }, result }`.

### `POST /webhooks/inbound/bitrix/channel/message`

- Purpose: Allow a third-party app to write a message into Bitrix Open Channel and register a callback URL for replies.
- Auth:
  - If `THIRD_PARTY_WEBHOOK_SECRET` is set, requires header `x-thirdparty-secret`.
- Request body:

```json
{
  "customerPhone": "+254700000000",
  "text": "Hello, please confirm appointment",
  "replyWebhookUrl": "https://thirdparty.example.com/bitrix-replies",
  "deliverSmsReplies": false,
  "destinationPhone": "+18447500107",
  "externalMessageId": "ext-123"
}
```

- Notes:
  - `customerPhone`, `text`, and `replyWebhookUrl` are required.
  - If `deliverSmsReplies` is `false`, Bitrix replies are sent to `replyWebhookUrl` only.
  - If `deliverSmsReplies` is `true`, replies are sent to both callback URL and SMS (Telnyx flow).
- Response: `{ ok, customerPhone, replyWebhookUrl, deliverSmsReplies, bitrix, answer }`.

### `POST /webhooks/inbound/bitrix/employee/message`

- Purpose: Send a third-party message directly to a Bitrix employee inbox by employee email (no SMS/Telnyx send).
- Auth:
  - If `THIRD_PARTY_WEBHOOK_SECRET` is set, requires header `x-thirdparty-secret`.
- Request body:

```json
{
  "employeeEmail": "agent@company.com",
  "text": "New message from external app",
  "customerPhone": "+254700000000",
  "replyWebhookUrl": "https://thirdparty.example.com/bitrix-replies"
}
```

- Notes:
  - `employeeEmail` and `text` are required.
  - `customerPhone` + `replyWebhookUrl` are optional and used only to map future Bitrix replies to your callback route.
- Response: `{ ok, employeeEmail, employeeId, bitrix }`.

### `POST /bitrix/connector/register`

- Purpose: Re-register connector and rebind Bitrix connector/deal/lead webhook events.
- Auth: None.
- Request body: None.
- Response: `{ ok, register, activate, eventBind, dealEventBind, leadEventBind, status }`.

### `POST /bitrix/leads/register`

- Purpose: Rebind `OnCrmLeadAdd` webhook only.
- Auth: None.
- Request body: None.
- Response: `{ ok, leadEventBind }`.

### `GET /bitrix/connector/status`

- Purpose: Read Bitrix connector status.
- Auth: None.
- Request body: None.
- Response: `{ ok, status }`.

### `GET /debug/telnyx/webhooks`

- Purpose: Read stored Telnyx webhook history from Postgres.
- Auth: None.
- Query params:
  - `limit` (optional, default `50`)
- Response: `{ ok, records }`.

### `GET /debug/bitrix/deal-events`

- Purpose: Read recent in-memory deal webhook events.
- Auth: None.
- Request body: None.
- Response: `{ ok, events }`.

### `GET /debug/bitrix/reply-webhooks`

- Purpose: Read recent in-memory Bitrix reply webhook traces.
- Auth: None.
- Request body: None.
- Response: `{ ok, events }`.

### `GET /debug/bitrix/latest-history`

- Purpose: Read latest Bitrix Open Line session history seen by middleware.
- Auth: None.
- Request body: None.
- Response: `{ ok, session, history }` (or `404` if no session yet).

### `GET /debug/bitrix/deals/stages`

- Purpose: Return all deal pipelines and their stage IDs.
- Auth: None.
- Request body: None.
- Response (shape):

```json
{
  "ok": true,
  "pipelines": [
    {
      "categoryId": 0,
      "categoryName": "Default",
      "entityId": "DEAL_STAGE",
      "stages": [
        { "id": "NEW", "name": "New", "sort": 10, "semanticId": "P" }
      ]
    }
  ]
}
```

### `POST /debug/bitrix/test-message`

- Purpose: Inject a test inbound SMS into Bitrix Open Channel flow.
- Auth: None.
- Request body (all optional):

```json
{
  "from": "+254700000000",
  "to": "+18447500107",
  "text": "Testing Bitrix Open Channel"
}
```

- Response: `{ ok, bitrix, answer }`.

### Push Output To Another System (Optional)

- `TELNYX_FORWARD_WEBHOOK_URL`: Forwards stored inbound Telnyx SMS webhooks to your endpoint.
- `TELNYX_CALL_FORWARD_WEBHOOK_URL`: Forwards stored Telnyx call webhooks to your endpoint.
- `BITRIX_DEAL_FORWARD_WEBHOOK_URL`: Forwards stored Bitrix deal webhook events to your endpoint.
- `BITRIX_DEAL_CLIENT_PRICE_FIELD`: Bitrix deal field code where final client-facing price is stored.
- `BITRIX_QUOTE_PRESENTED_STAGE_ID`: Default stage ID used by `/webhooks/inbound/bitrix/deals/quote-presented`.
- `EMAIL_API_URL`: endpoint used to send lead confirmation emails (default: Pipeproof API).

## Bitrix UI Setup (CSR View)

To display Client Price prominently in `Quote Presented to Client`:

1. Create a custom Deal field in Bitrix and set its code to match `BITRIX_DEAL_CLIENT_PRICE_FIELD` (example: `UF_CRM_CLIENT_PRICE`).
2. Open CRM Deal pipeline settings and edit the `Quote Presented to Client` stage card layout.
3. Add the Client Price field to the top section of the stage form and mark it visible for CSR users.

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

Read all deal pipeline stage IDs:

```bash
curl http://localhost:3000/debug/bitrix/deals/stages
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
