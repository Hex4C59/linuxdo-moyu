import * as crypto from 'node:crypto';
import * as http from 'node:http';

import * as vscode from 'vscode';

import { ConnectionStore } from '../connectionStore';
import { ConnectionConfig } from '../discourseTypes';

const LINUX_DO_BASE_URL = 'https://linux.do';
const OIDC_ISSUER = 'https://connect.linux.do/';
const OIDC_AUTHORIZATION_ENDPOINT = `${OIDC_ISSUER}oauth2/authorize`;
const OIDC_TOKEN_ENDPOINT = `${OIDC_ISSUER}oauth2/token`;
const OIDC_USERINFO_ENDPOINT = `${OIDC_ISSUER}api/user`;
const OIDC_CALLBACK_HOST = '127.0.0.1';
const OIDC_CALLBACK_PORT = 14565;
const OIDC_CALLBACK_PATH = '/did-authenticate';
const OIDC_SCOPES = ['openid', 'profile', 'email'];
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingLogin {
  cancel: (error: Error) => void;
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

export class OidcAuthService {
  private pendingLogin?: PendingLogin;

  public constructor(private readonly connectionStore: ConnectionStore) {}

  public async startLogin(): Promise<void> {
    const current = await this.connectionStore.load();
    const baseUrl = this.normalizeBaseUrl(current.baseUrl || LINUX_DO_BASE_URL);

    if (baseUrl !== LINUX_DO_BASE_URL) {
      throw new Error('当前 Linux DO Connect 登录只支持 https://linux.do。');
    }

    if (this.pendingLogin) {
      throw new Error('已有一个 Linux DO Connect 登录流程正在进行，请先完成当前授权。');
    }

    const redirectUri = this.getRedirectUri();
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

    const callbackPromise = this.createCallbackPromise(redirectUri);
    const authorizeLink = authorizeUrl.toString();

    await vscode.env.clipboard.writeText(authorizeLink);
    const manualLink = await vscode.window.showInputBox({
      title: 'Linux DO Connect 授权链接',
      prompt: '请复制这个链接到系统浏览器打开，完成授权后再回到 VS Code。',
      value: authorizeLink,
      ignoreFocusOut: true,
      valueSelection: [0, authorizeLink.length],
    });

    if (manualLink === undefined) {
      this.cancelPendingLogin(new Error('已取消 Linux DO Connect 授权。'));
      throw new Error('已取消 Linux DO Connect 授权。');
    }

    const opened = await vscode.env.openExternal(vscode.Uri.parse(authorizeLink));
    if (!opened) {
      void vscode.window.showInformationMessage('系统没有自动打开浏览器，请手动将刚才输入框中的授权链接粘贴到浏览器地址栏。');
    }

    const callbackParams = await this.waitForCallbackParams(callbackPromise, redirectUri);
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
      oidcForumApiEnabled: false,
    };

    await this.connectionStore.save(nextConnection);

    void vscode.window.showInformationMessage(
      username
        ? `已通过 Linux DO Connect 登录：@${username}`
        : '已通过 Linux DO Connect 登录。',
    );
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

  private getRedirectUri(): string {
    return `http://${OIDC_CALLBACK_HOST}:${OIDC_CALLBACK_PORT}${OIDC_CALLBACK_PATH}`;
  }

  private async createCallbackPromise(redirectUri: string): Promise<URLSearchParams> {
    let resolveResult!: (value: URLSearchParams) => void;
    let rejectResult!: (error: Error) => void;

    const resultPromise = new Promise<URLSearchParams>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    return await new Promise<URLSearchParams>((resolveReady, rejectReady) => {
      let settled = false;
      let listenerReady = false;

      const server = http.createServer((request, response) => {
        const requestUrl = new URL(request.url || '/', redirectUri);

        if (requestUrl.pathname !== OIDC_CALLBACK_PATH) {
          response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end(this.renderCallbackPage('未识别的回调路径。请返回 VS Code 后重新发起登录。'));
          return;
        }

        const hasError = Boolean(requestUrl.searchParams.get('error'));
        response.writeHead(hasError ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(
          this.renderCallbackPage(
            hasError
              ? 'Linux DO Connect 授权失败，请返回 VS Code 查看错误提示。'
              : 'Linux DO Connect 授权成功，你可以关闭这个页面并回到 VS Code。',
          ),
        );

        finishSuccess(requestUrl.searchParams);
      });

      const timeout = setTimeout(() => {
        finishError(new Error('等待 Linux DO Connect 登录回调超时，请重新授权。'));
      }, LOGIN_TIMEOUT_MS);

      const cleanup = (): void => {
        clearTimeout(timeout);
        if (this.pendingLogin?.cancel === cancelPendingLogin) {
          this.pendingLogin = undefined;
        }
        server.close();
      };

      const finishSuccess = (params: URLSearchParams): void => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        resolveResult(params);
      };

      const finishError = (error: Error): void => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        if (listenerReady) {
          rejectResult(error);
        } else {
          rejectReady(error);
        }
      };

      const cancelPendingLogin = (error: Error): void => {
        finishError(error);
      };

      this.pendingLogin = {
        cancel: cancelPendingLogin,
      };

      server.once('error', (error: NodeJS.ErrnoException) => {
        finishError(this.buildLoopbackServerError(error));
      });

      server.listen(OIDC_CALLBACK_PORT, OIDC_CALLBACK_HOST, () => {
        listenerReady = true;
        resolveReady(resultPromise);
      });
    });
  }

  private cancelPendingLogin(error: Error): void {
    this.pendingLogin?.cancel(error);
  }

  private async waitForCallbackParams(
    callbackPromise: Promise<URLSearchParams>,
    redirectUri: string,
  ): Promise<URLSearchParams> {
    try {
      return await callbackPromise;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('登录回调超时')) {
        throw error;
      }

      const manualUrl = await vscode.window.showInputBox({
        title: '手动粘贴浏览器回调地址',
        prompt: '如果浏览器已跳转但扩展未自动接收，请把浏览器地址栏中的完整回调 URL 粘贴到这里。',
        placeHolder: redirectUri,
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value.trim()) {
            return '请输入浏览器地址栏中的完整回调 URL';
          }

          try {
            const url = new URL(value.trim());
            if (url.origin !== new URL(redirectUri).origin || url.pathname !== OIDC_CALLBACK_PATH) {
              return '这不是当前 Linux DO Connect 登录使用的回调地址';
            }
          } catch {
            return '请输入合法的 URL';
          }

          return undefined;
        },
      });

      if (!manualUrl) {
        throw error;
      }

      return new URL(manualUrl.trim()).searchParams;
    }
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

  private pickUsername(userInfo: UserInfoResponse): string | undefined {
    return userInfo.username || userInfo.login || userInfo.name || userInfo.email;
  }

  private createCodeVerifier(): string {
    return crypto.randomBytes(48).toString('base64url');
  }

  private createCodeChallenge(codeVerifier: string): string {
    return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  }

  private renderCallbackPage(message: string): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Linux DO Connect 登录</title>
    <style>
      :root {
        color-scheme: light dark;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: #111827;
        color: #f9fafb;
      }
      main {
        width: min(520px, calc(100vw - 32px));
        padding: 24px;
        border-radius: 16px;
        background: rgba(17, 24, 39, 0.88);
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 22px;
      }
      p {
        margin: 0;
        line-height: 1.7;
        color: rgba(249, 250, 251, 0.86);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Linux DO Connect</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
  }

  private buildHttpError(prefix: string, status: number, responseText: string): string {
    const snippet = responseText.replace(/\s+/g, ' ').trim().slice(0, 240);
    return `${prefix}（HTTP ${status}）${snippet ? `：${snippet}` : ''}`;
  }

  private buildLoopbackServerError(error: NodeJS.ErrnoException): Error {
    if (error.code === 'EADDRINUSE') {
      return new Error(
        `本地登录回调端口 ${OIDC_CALLBACK_PORT} 已被占用。请先释放该端口，或告诉我我来把扩展改成另一个固定端口。`,
      );
    }

    return new Error(`启动本地登录回调服务失败：${error.message}`);
  }

  private normalizeBaseUrl(value: string): string {
    return value.replace(/\/$/, '');
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
