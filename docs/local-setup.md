# Local Setup

This guide sets up the Telnyx SMS to Bitrix24 Open Channel bridge on your local machine, using Docker Compose and a public tunnel.

## What You Are Building

The local flow is:

```text
Phone SMS -> Telnyx -> public tunnel -> local Docker app -> Bitrix Open Channel
Bitrix reply -> public tunnel -> local Docker app -> Telnyx -> phone SMS
```

Bitrix must reach your local app through a public HTTPS URL. `localhost` will not work inside Bitrix or Telnyx.

## Prerequisites

- Docker Desktop installed and running.
- A Telnyx number that can send and receive SMS.
- A Telnyx API key.
- A Bitrix24 account with access to Developer resources and Open Channels.
- A public tunnel such as ngrok or Cloudflare Tunnel.

## 1. Start a Public Tunnel

Expose local port `3000`:

```bash
ngrok http 3000
```

Use the HTTPS forwarding URL as your public base URL, for example:

```text
https://abc123.ngrok-free.app
```

## 2. Configure `.env`

Create your env file:

```bash
cp .env.example .env
```

Fill it like this:

```env
PORT=3000
PUBLIC_BASE_URL=https://abc123.ngrok-free.app
DATA_DIR=data
DATABASE_URL=postgresql://telnyx:telnyx@postgres:5432/telnyx

POSTGRES_DB=telnyx
POSTGRES_USER=telnyx
POSTGRES_PASSWORD=telnyx
POSTGRES_PORT=5432

PGADMIN_DEFAULT_EMAIL=admin@example.com
PGADMIN_DEFAULT_PASSWORD=admin123
PGADMIN_PORT=5050

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

Leave `BITRIX_CLIENT_ID` and `BITRIX_CLIENT_SECRET` blank until the Bitrix local application is saved and shows them.

## 3. Create the Bitrix Local Application

In Bitrix24:

1. Go to `Developer resources`.
2. Open `Other`.
3. Choose `Local Application`.
4. Select `Server`.
5. Set `Your handler path` to:

```text
https://abc123.ngrok-free.app/bitrix/connector/settings
```

6. Set `Initial installation path` to:

```text
https://abc123.ngrok-free.app/bitrix/install
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

Bitrix will show the app client ID and client secret. Put those values into `.env`:

```env
BITRIX_CLIENT_ID=...
BITRIX_CLIENT_SECRET=...
```

## 4. Start the Middleware

Build and start:

```bash
docker compose build
docker compose up
```

Keep this terminal open so you can see logs.

Optional database UI:

```text
http://localhost:5050
```

pgAdmin login uses `PGADMIN_DEFAULT_EMAIL` and `PGADMIN_DEFAULT_PASSWORD`.
When adding the Postgres server inside pgAdmin, use host `postgres`, port `5432`, and the `POSTGRES_*` credentials from `.env`.

## 5. Trigger Bitrix Installation

Return to the Bitrix Local Application screen and click `Save` again.

You should see:

```text
POST /bitrix/install 200
```

The install callback stores Bitrix OAuth tokens in:

```text
./data/bitrix-auth.json
```

The app also registers and activates the connector for your Open Channel line.

## 6. Verify the Connector

Run:

```bash
curl http://localhost:3000/bitrix/connector/status
```

Expected result includes:

```json
{
  "CONFIGURED": true,
  "STATUS": true
}
```

If needed, re-register and bind events:

```bash
curl -X POST http://localhost:3000/bitrix/connector/register
```

## 7. Configure Telnyx

In your Telnyx Messaging Profile, set the webhook URL to:

```text
https://abc123.ngrok-free.app/webhooks/telnyx
```

Make sure your SMS number is assigned to that Messaging Profile.

If you want each inbound Telnyx webhook copied to another system after it is stored in Postgres, set:

```env
TELNYX_FORWARD_WEBHOOK_URL=https://your-app.example.com/webhooks/telnyx
```

## 8. Test Inbound SMS

Send an SMS from your phone to your Telnyx number:

```text
+18447500107
```

Expected logs:

```text
POST /webhooks/telnyx 200
Sending inbound SMS to Bitrix
Bitrix imconnector.send.messages response
```

In Bitrix, check:

```text
Contact Center -> Open Channel / Open Lines
```

The conversation may be named after the phone number, for example:

```text
+254722753364 - Open Channel
```

## 9. Test Bitrix Reply

Reply inside the Bitrix Open Channel conversation.

Expected logs:

```text
POST /webhooks/bitrix 200
```

Your phone should receive the SMS reply.

## Useful Debug Commands

Send a manual SMS through Telnyx:

```bash
curl -X POST http://localhost:3000/sms/send \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+254722753364",
    "text": "Hello from local middleware"
  }'
```

Send a message directly into Bitrix:

```bash
curl -X POST http://localhost:3000/debug/bitrix/test-message \
  -H "Content-Type: application/json" \
  -d '{
    "from": "+254700000000",
    "text": "Testing Bitrix Open Channel"
  }'
```

Read the latest Bitrix Open Line session history:

```bash
curl http://localhost:3000/debug/bitrix/latest-history
```

Read stored Telnyx webhook rows:

```bash
curl http://localhost:3000/debug/telnyx/webhooks
```

Watch logs:

```bash
docker compose logs -f
```

## Common Issues

- `WRONG_AUTH_TYPE`: you are using a Bitrix inbound webhook. This integration requires a Bitrix Local Application.
- `No Bitrix session seen yet`: the container has not processed an inbound SMS since it started.
- You receive a Bitrix auto-reply but cannot find the chat: search Contact Center/Open Lines by the sender phone number.
- Bitrix shows the conversation but not under normal Chats: Open Channel conversations live under Contact Center/Open Lines.
- Replies do not reach the phone: run `curl -X POST http://localhost:3000/bitrix/connector/register` to re-bind the Bitrix event.
