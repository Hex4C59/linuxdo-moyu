import * as vscode from 'vscode';

import { ConnectionConfig } from './discourseTypes';

const SECRET_KEY = 'linuxdo.connection';
const DEFAULT_BASE_URL = 'https://linux.do';

export class ConnectionStore {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onDidChange: () => void,
  ) {}

  public async load(): Promise<ConnectionConfig> {
    const raw = await this.context.secrets.get(SECRET_KEY);
    if (!raw) {
      return {
        baseUrl: DEFAULT_BASE_URL,
        authMode: 'none',
      };
    }

    try {
      const parsed = JSON.parse(raw) as ConnectionConfig;
      return {
        baseUrl: parsed.baseUrl || DEFAULT_BASE_URL,
        authMode: parsed.authMode || 'none',
        userApiKey: parsed.userApiKey,
        userApiClientId: parsed.userApiClientId,
        username: parsed.username,
        email: parsed.email,
        cookie: parsed.cookie,
        oidcClientId: parsed.oidcClientId,
        oidcClientSecret: parsed.oidcClientSecret,
        oidcAccessToken: parsed.oidcAccessToken,
        oidcRefreshToken: parsed.oidcRefreshToken,
        oidcIdToken: parsed.oidcIdToken,
        oidcTokenType: parsed.oidcTokenType,
        oidcScope: parsed.oidcScope,
        oidcExpiresAt: parsed.oidcExpiresAt,
      };
    } catch {
      return {
        baseUrl: DEFAULT_BASE_URL,
        authMode: 'none',
      };
    }
  }

  public async save(config: ConnectionConfig): Promise<void> {
    await this.context.secrets.store(SECRET_KEY, JSON.stringify(config));
    this.onDidChange();
  }

  public async clear(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
    this.onDidChange();
  }
}
