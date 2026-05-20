export interface TelnyxWebhook {
  data?: {
    event_type?: string;
    id?: string;
    occurred_at?: string;
    payload?: {
      id?: string;
      text?: string;
      direction?: string;
      received_at?: string;
      sent_at?: string;
      from?: {
        phone_number?: string;
      };
      to?: Array<{
        phone_number?: string;
      }>;
    };
  };
}

export interface BitrixSendMessageResponse {
  result?: {
    SUCCESS?: boolean;
    DATA?: {
      RESULT?: Array<{
        session?: {
          ID?: string | number;
          CHAT_ID?: string | number;
        };
        chat?: {
          id?: string;
          name?: string;
        };
      }>;
    };
  };
  error?: string;
  error_description?: string;
}

export interface BitrixInstallRequest {
  auth?: {
    access_token?: string;
    refresh_token?: string;
    client_endpoint?: string;
    server_endpoint?: string;
    domain?: string;
    member_id?: string;
    expires_in?: number;
    application_token?: string;
  };
  AUTH_ID?: string;
  REFRESH_ID?: string;
  CLIENT_ENDPOINT?: string;
  SERVER_ENDPOINT?: string;
  DOMAIN?: string;
  member_id?: string;
  expires?: string;
  expires_in?: string;
  APPLICATION_TOKEN?: string;
}

export interface BitrixOutboundEvent {
  event?: string;
  data?: {
    CONNECTOR?: string;
    LINE?: string;
    MESSAGES?: Array<{
      message?: {
        id?: string;
        text?: string;
      };
      chat?: {
        id?: string;
        name?: string;
      };
      user?: {
        id?: string;
      };
      im?: {
        chat_id?: string | number;
        message_id?: string | number;
      };
      sender?: {
        id?: string;
      };
      recipient?: {
        id?: string;
      };
      extra?: Record<string, string>;
    }>;
  };
}
