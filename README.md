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

BITRIX_CLIENT_ID=your_local_app_client_id
BITRIX_CLIENT_SECRET=your_local_app_client_secret
BITRIX_CONNECTOR_ID=telnyx_sms
BITRIX_CONNECTOR_NAME=Telnyx SMS
BITRIX_LINE_ID=2

TELNYX_API_KEY=your_telnyx_api_key
TELNYX_FROM_NUMBER=+18447500107
```

`PUBLIC_BASE_URL` must be reachable by both Bitrix and Telnyx over HTTPS.

## Run

```bash
docker compose build
docker compose up
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

## Useful Endpoints

- `GET /health`
- `POST /sms/send`
- `POST /debug/bitrix/test-message`
- `GET /debug/bitrix/latest-history`
- `POST /bitrix/connector/register`
- `GET /bitrix/connector/status`
- `POST /webhooks/telnyx`
- `POST /webhooks/bitrix`

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

## Notes

- This integration uses a Bitrix24 Local Application, not a simple inbound webhook. Bitrix rejects `imconnector.send.messages` from webhook auth with `WRONG_AUTH_TYPE`.
- Open Channel conversations appear under Bitrix Contact Center/Open Lines, not always under normal internal Chats.
- The app stores Bitrix OAuth tokens in `./data`, mounted into Docker by `docker-compose.yml`.
- In-memory idempotency and phone mapping are fine for one instance. Use Redis/Postgres before running multiple replicas or high-volume production traffic.
