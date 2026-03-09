import * as crypto from 'node:crypto';

import * as vscode from 'vscode';

import { ConnectionStore } from '../connectionStore';
import { ConnectionConfig } from '../discourseTypes';

const LINUX_DO_BASE_URL = 'https://linux.do';
const OIDC_ISSUER = 'https://connect.linux.do/';
const OIDC_AUTHORIZATION_ENDPOINT = `${OIDC_ISSUER}oauth2/authorize`;
const OIDC_TOKEN_ENDPOINT = `${OIDC_ISSUER}oauth2/token`;
const OIDC_USERINFO_ENDPOINT = `${OIDC_ISSUER}api/user`;
const OIDC_CALLBACK_PATH = '/did-authenticate';
const OIDC_SCOPES = ['openid', 'profile', 'email'];
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingLogin {
  state: string;
  redirectUri: string;
  codeVerifier: string;
  resolve: (uri: vscode.Uri) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  expires_in?: number;
}

interface UserInfoResponse {
  sub?: string;
  username?: string;
  login?: string;
  name?: string;
  email?: string;
  avatar_url?: string;
  active?: boolean;
  trust_level?: number;
  silenced?: boolean;
}

export class OidcAuthService implements vscode.UriHandler {
  private pendingLogin?: PendingLogin;

  public constructor(
    private readonly connectionStore: ConnectionStore,
    private readonly extensionId: string,
  ) {}

  public async startLogin(): Promise<void> {
    const current = await this.connectionStore.load();
    const baseUrl = this.normalizeBaseUrl(current.baseUrl || LINUX_DO_BASE_URL);

    if (baseUrl !== LINUX_DO_BASE_URL) {
      throw new Error('当前 Linux DO Connect 登录只支持 https://linux.do。');
    }

    if (this.pendingLogin) {
      throw new Error('已有一个 Linux DO Connect 登录流程正在进行，请先完成当前授权。');
    }

    const redirectUri = await this.getRedirectUri();
    const credentials = await this.ensureClientCredentials(current, redirectUri);
    const state = crypto.randomUUID();
    const codeVerifier = this.createCodeVerifier();
    const codeChallenge = this.createCodeChallenge(codeVerifier);
    const authorizeUrl = new URL(OIDC_AUTHORIZATION_ENDPOINT);

    authorizeUrl.searchParams.set('client_id', credentials.clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', OIDC_SCOPES.join(' '));
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const callbackPromise = this.waitForCallback({ state, redirectUri, codeVerifier });
    const opened = await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl.toString()));

    if (!opened) {
      this.clearPendingLogin();
      throw new Error('无法打开系统浏览器，请检查系统默认浏览器配置。');
    }

    void vscode.window.showInformationMessage(
      '已在系统浏览器中打开 Linux DO Connect 授权页。完成授权后会自动回到 VS Code。',
    );

    try {
      const callbackUri = await callbackPromise;
      const callbackParams = new URLSearchParams(callbackUri.query);
      const callbackState = callbackParams.get('state');
      const code = callbackParams.get('code');
      const error = callbackParams.get('error');
      const errorDescription = callbackParams.get('error_description');

      if (error) {
        throw new Error(errorDescription || `授权失败：${error}`);
      }

      if (callbackState !== state) {
        throw new Error('登录回调 state 校验失败，请重新发起 Linux DO Connect 授权。');
      }

      if (!code) {
        throw new Error('登录回调中缺少授权码，请检查 Linux DO Connect 应用的回调地址配置。');
      }

      const token = await this.exchangeCodeForToken({
        code,
        codeVerifier,
        redirectUri,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
      });
      const userInfo = await this.fetchUserInfo(token.access_token);
      const username = this.pickUsername(userInfo);
      const nextConnection: ConnectionConfig = {
        baseUrl,
        authMode: 'oidc',
        username,
        email: userInfo.email,
        oidcClientId: credentials.clientId,
        oidcClientSecret: credentials.clientSecret,
        oidcAccessToken: token.access_token,
        oidcRefreshToken: token.refresh_token,
        oidcIdToken: token.id_token,
        oidcTokenType: token.token_type,
        oidcScope: token.scope || OIDC_SCOPES.join(' '),
        oidcExpiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
      };

      await this.connectionStore.save(nextConnection);

      void vscode.window.showInformationMessage(
        username
          ? `已通过 Linux DO Connect 登录：@${username}`
          : '已通过 Linux DO Connect 登录。',
      );
    } finally {
      this.clearPendingLogin();
    }
  }

  public handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
    if (!this.pendingLogin || uri.path !== OIDC_CALLBACK_PATH) {
      return undefined;
    }

    this.pendingLogin.resolve(uri);
    return undefined;
  }

  private async ensureClientCredentials(
    current: ConnectionConfig,
    redirectUri: string,
  ): Promise<{ clientId: string; clientSecret: string }> {
    let clientId = current.oidcClientId?.trim();
    let clientSecret = current.oidcClientSecret?.trim();

    if (clientId && clientSecret) {
      return { clientId, clientSecret };
    }

    const copyCallbackAction = '复制回调地址';
    const continueAction = '继续配置';
    const selection = await vscode.window.showInformationMessage(
      `请先在 Linux DO Connect 应用中将回调地址配置为：${redirectUri}`,
      { modal: true },
      copyCallbackAction,
      continueAction,
    );

    if (selection === copyCallbackAction) {
      await vscode.env.clipboard.writeText(redirectUri);
    }

    clientId = (await vscode.window.showInputBox({
      title: 'Linux DO Connect Client ID',
      prompt: '填入你在 Linux DO Connect 应用接入页中拿到的 Client ID。',
      value: current.oidcClientId,
      ignoreFocusOut: true,
    }))?.trim();

    if (!clientId) {
      throw new Error('未填写 Client ID，已取消 Linux DO Connect 登录。');
    }

    clientSecret = (await vscode.window.showInputBox({
      title: 'Linux DO Connect Client Secret',
      prompt: '填入 Linux DO Connect 应用的 Client Secret。',
      value: current.oidcClientSecret,
      password: true,
      ignoreFocusOut: true,
    }))?.trim();

    if (!clientSecret) {
      throw new Error('未填写 Client Secret，已取消 Linux DO Connect 登录。');
    }

    return { clientId, clientSecret };
  }

  private async getRedirectUri(): Promise<string> {
    const callbackTarget = vscode.Uri.parse(`${vscode.env.uriScheme}://${this.extensionId}${OIDC_CALLBACK_PATH}`);
    const externalUri = await vscode.env.asExternalUri(callbackTarget);
    return externalUri.toString(true);
  }

  private waitForCallback({
    state,
    redirectUri,
    codeVerifier,
  }: {
    state: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<vscode.Uri> {
    return awaitable((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('等待 Linux DO Connect 登录回调超时，请重新授权。'));
      }, LOGIN_TIMEOUT_MS);

      this.pendingLogin = {
        state,
        redirectUri,
        codeVerifier,
        resolve: (uri) => {
          clearTimeout(timeout);
          resolve(uri);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
      };
    });
  }

  private async exchangeCodeForToken({
    code,
    codeVerifier,
    redirectUri,
    clientId,
    clientSecret,
  }: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<TokenResponse> {
    const form = new URLSearchParams();
    form.set('grant_type', 'authorization_code');
    form.set('code', code);
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
    form.set('redirect_uri', redirectUri);
    form.set('code_verifier', codeVerifier);

    const response = await fetch(OIDC_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(this.buildHttpError('换取 Linux DO Connect token 失败', response.status, responseText));
    }

    return JSON.parse(responseText) as TokenResponse;
  }

  private async fetchUserInfo(accessToken: string): Promise<UserInfoResponse> {
    const response = await fetch(OIDC_USERINFO_ENDPOINT, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(this.buildHttpError('获取 Linux DO Connect 用户信息失败', response.status, responseText));
    }

    return JSON.parse(responseText) as UserInfoResponse;
  }

  private clearPendingLogin(): void {
    if (!this.pendingLogin) {
      return;
    }

    clearTimeout(this.pendingLogin.timeout);
    this.pendingLogin = undefined;
  }

  private pickUsername(userInfo: UserInfoResponse): string | undefined {
    return userInfo.username || userInfo.login || userInfo.name || userInfo.email;
  }

  private createCodeVerifier(): string {
    return crypto.randomBytes(48).toString('base64url');
  }

  private createCodeChallenge(codeVerifier: string): string {
    return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  }

  private buildHttpError(prefix: string, status: number, responseText: string): string {
    const snippet = responseText.replace(/\s+/g, ' ').trim().slice(0, 240);
    return `${prefix}（HTTP ${status}）${snippet ? `：${snippet}` : ''}`;
  }

  private normalizeBaseUrl(value: string): string {
    return value.replace(/\/$/, '');
  }
}

function awaitable<T>(
  executor: (
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void,
  ) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    executor(resolve, reject);
  });
}
