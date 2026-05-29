# Bitrix24 CALL_CARD CSR Intake Widget

This guide adds an embedded CSR intake tab inside the Bitrix24 Active Call Card (`CALL_CARD`) using your existing Node/TypeScript middleware container.

## 1. Create Bitrix24 Local App

In Bitrix24 Developer Console, create a local app and include at least:

- `telephony`
- `crm`
- `placement`

Keep your app credentials and admin token secure.

## 2. Deploy Middleware

No separate PHP runtime is required.

Use your existing Docker flow:

```bash
docker compose build
docker compose up -d
```

## 3. Bind the Handler to CALL_CARD

Run once after deployment:

```bash
curl -X POST https://sms.example.com/bitrix/call-card/register
```

This endpoint executes `placement.bind` with:

- `PLACEMENT=CALL_CARD`
- `HANDLER=${PUBLIC_BASE_URL}/bitrix/widgets/call-card`

## 4. Runtime Flow

When inbound call card opens:

1. Bitrix24 loads `/bitrix/widgets/call-card` in an iframe tab.
2. Middleware reads `PLACEMENT_OPTIONS` from POST.
3. It extracts:
   - `PHONE_NUMBER`
   - `CRM_ENTITY_TYPE`
   - `CRM_ENTITY_ID`
   - `CALL_ID`
4. Middleware calls:
   - `crm.deal.get` when entity type is `DEAL`
   - `crm.contact.get` when entity type is `CONTACT`
5. Form pre-populates existing title/comments.
6. On submit, JavaScript SDK calls `crm.deal.update` for the linked deal ID.

No extra window is opened; updates occur inside `CALL_CARD`.

## 5. Live Inbound Test

1. Place a real inbound call that resolves to a Deal in Bitrix24.
2. Open/accept the active call card.
3. Confirm `CSR Intake Form` tab appears automatically.
4. Confirm caller/entity metadata and preloaded fields are visible.
5. Enter notes and submit.
6. Verify Deal updates immediately in CRM (`TITLE`/`COMMENTS`).

## 6. Notes

- The widget intentionally blocks non-Deal save operations and writes only to `crm.deal.update`.
- Keep HTTPS valid; Bitrix iframe loading requires trusted SSL.
- If call context switches while open, the widget listens for `CallCard::EntityChanged` and reloads.
- Re-bind anytime with `POST /bitrix/call-card/register` after changing `PUBLIC_BASE_URL`.
