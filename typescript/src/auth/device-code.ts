export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface DeviceCodeFlowConfig {
  tokenUrl: string;
  deviceCodeUrl: string;
  clientId: string;
  scopes?: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  scope?: string;
}

export class DeviceCodeFlow {
  private tokenUrl: string;
  private deviceCodeUrl: string;
  private clientId: string;
  private scopes: string[];

  constructor(config: DeviceCodeFlowConfig) {
    this.tokenUrl = config.tokenUrl;
    this.deviceCodeUrl = config.deviceCodeUrl;
    this.clientId = config.clientId;
    this.scopes = config.scopes || [];
  }

  async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      scope: this.scopes.join(' '),
    });

    const response = await fetch(this.deviceCodeUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Device code request failed: ${response.statusText}`);
    }

    return (await response.json()) as DeviceCodeResponse;
  }

  async pollForToken(
    deviceCode: string,
    interval: number = 5
  ): Promise<TokenResponse> {
    const maxWaitTime = 300; // 300 seconds = 5 minutes
    const startTime = Date.now();
    let currentInterval = interval;

    while (true) {
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > maxWaitTime) {
        throw new Error('Device code flow timed out after 300 seconds');
      }

      await new Promise((resolve) => setTimeout(resolve, currentInterval * 1000));

      const params = new URLSearchParams({
        client_id: this.clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });

      const response = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      const data = (await response.json()) as {
        access_token?: string;
        token_type?: string;
        scope?: string;
        error?: string;
      };

      if (response.ok && data.access_token) {
        return data as TokenResponse;
      }

      // Handle error codes
      if (data.error) {
        switch (data.error) {
          case 'authorization_pending':
            // Continue polling
            continue;
          case 'slow_down':
            // Increase interval by 5 seconds
            currentInterval += 5;
            continue;
          case 'expired_token':
            throw new Error('Device code has expired');
          case 'access_denied':
            throw new Error('Access was denied by the user');
          default:
            throw new Error(`Token polling failed: ${data.error}`);
        }
      }
    }
  }
}
