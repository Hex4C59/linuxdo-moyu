import * as crypto from 'node:crypto';

import * as vscode from 'vscode';

const CSRF_CANDIDATE_PATHS = ['/session/csrf.json', '/csrf.json', '/session/csrf'];
const BROWSER_LIKE_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

import {
  CategoriesResponse,
  CategorySummary,
  ConnectionConfig,
  LatestTopicsResponse,
  NotificationItem,
  NotificationsResponse,
  SessionCurrentResponse,
  TopicDetails,
  TopicReplyPayload,
  TopicSummary,
  getConnectionCapabilities,
} from './discourseTypes';

interface RequestOptions {
  method?: 'GET' | 'POST';
  jsonBody?: unknown;
  formBody?: Record<string, string>;
  extraHeaders?: Record<string, string>;
  useOidcBearerToken?: boolean;
}

export class DiscourseClient {
  public constructor(private readonly config: ConnectionConfig) {}

  public static generateClientId(): string {
    return crypto.randomUUID();
  }

  public getBaseUrl(): string {
    return this.normalizeBaseUrl(this.config.baseUrl);
  }

  public getTopicUrl(topicId: number, postNumber?: number, slug = 'topic'): string {
    const safeSlug = slug.trim() || 'topic';
    const base = `${this.getBaseUrl()}/t/${safeSlug}/${topicId}`;
    return postNumber ? `${base}/${postNumber}` : base;
  }

  public isConfigured(): boolean {
    if (this.config.authMode === 'cookie') {
      return Boolean(this.config.cookie?.trim());
    }

    if (this.config.authMode === 'userApiKey') {
      return Boolean(this.config.userApiKey?.trim());
    }

    if (this.config.authMode === 'oidc') {
      return Boolean(this.config.oidcAccessToken?.trim());
    }

    return false;
  }

  public getCapabilities() {
    return getConnectionCapabilities(this.config);
  }

  public async probeOidcForumAccess(): Promise<SessionCurrentResponse | undefined> {
    if (this.config.authMode !== 'oidc' || !this.config.oidcAccessToken?.trim()) {
      return undefined;
    }

    try {
      return await this.requestJson<SessionCurrentResponse>('/session/current.json', {
        useOidcBearerToken: true,
      });
    } catch {
      return undefined;
    }
  }

  public async getSessionCurrent(): Promise<SessionCurrentResponse> {
    return await this.requestJson<SessionCurrentResponse>('/session/current.json');
  }

  public async getLatestTopics(): Promise<TopicSummary[]> {
    const data = await this.requestJson<LatestTopicsResponse>('/latest.json');
    return data.topic_list?.topics ?? [];
  }

  public async getCategories(): Promise<CategorySummary[]> {
    const data = await this.requestJson<CategoriesResponse>('/categories.json');
    return data.category_list?.categories ?? [];
  }

  public async getCategoryTopics(slug: string, categoryId?: number): Promise<TopicSummary[]> {
    const candidatePaths = [
      categoryId ? `/c/${slug}/${categoryId}/l/latest.json` : undefined,
      categoryId ? `/c/${slug}/${categoryId}.json` : undefined,
      `/c/${slug}/l/latest.json`,
      `/c/${slug}.json`,
    ].filter((value): value is string => Boolean(value));

    for (const path of candidatePaths) {
      try {
        const data = await this.requestJson<LatestTopicsResponse>(path);
        const topics = data.topic_list?.topics ?? [];
        if (topics.length > 0 || path.endsWith('.json')) {
          return topics;
        }
      } catch {
        // try next candidate path
      }
    }

    return [];
  }

  public async getTopic(topicId: number): Promise<TopicDetails> {
    return await this.requestJson<TopicDetails>(`/t/${topicId}.json`);
  }

  public async getNotifications(): Promise<NotificationItem[]> {
    const data = await this.requestJson<NotificationsResponse>('/notifications.json');
    return data.notifications ?? [];
  }

  public async createReply(payload: TopicReplyPayload): Promise<void> {
    const formBody: Record<string, string> = {
      topic_id: String(payload.topicId),
      raw: payload.raw,
    };

    if (payload.replyToPostNumber !== undefined) {
      formBody.reply_to_post_number = String(payload.replyToPostNumber);
    }

    let csrfToken: string | undefined;
    if (this.config.authMode === 'cookie') {
      csrfToken = await this.tryGetCsrfToken();
    }

    await this.requestJson('/posts.json', {
      method: 'POST',
      formBody,
      extraHeaders: csrfToken ? { 'X-CSRF-Token': csrfToken } : undefined,
    });
  }

  public describeAuthMode(): string {
    if (this.config.authMode === 'cookie') {
      return 'Session Cookie';
    }

    if (this.config.authMode === 'userApiKey') {
      return 'User API Key';
    }

    if (this.config.authMode === 'oidc') {
      return 'Linux DO Connect';
    }

    return '匿名浏览';
  }

  private async requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const baseUrl = this.getBaseUrl();
    const url = new URL(path, baseUrl);
    const headers = this.createBaseHeaders(baseUrl);

    if (options.jsonBody !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (options.extraHeaders) {
      Object.assign(headers, options.extraHeaders);
    }

    let body: string | undefined;

    if (options.jsonBody !== undefined) {
      body = JSON.stringify(options.jsonBody);
    }

    if (options.formBody !== undefined) {
      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(options.formBody)) {
        formData.set(key, value);
      }
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      body = formData.toString();
      headers.Origin = baseUrl;
      headers.Referer = `${baseUrl}/`;
    }

    if (this.config.authMode === 'cookie' && this.config.cookie) {
      headers.Cookie = this.config.cookie;
      if (options.method === 'POST' || options.formBody !== undefined || options.jsonBody !== undefined) {
        headers['X-Requested-With'] = 'XMLHttpRequest';
      }
    }

    if (this.config.authMode === 'userApiKey' && this.config.userApiKey) {
      headers['User-Api-Key'] = this.config.userApiKey;
      headers['User-Api-Client-Id'] = this.config.userApiClientId || DiscourseClient.generateClientId();
    }

    if (this.shouldAttachOidcBearerToken(options)) {
      headers.Authorization = `Bearer ${this.config.oidcAccessToken}`;
    }

    const timeoutMs = this.getTimeoutMs();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchWithRetry(url, {
        method: options.method ?? 'GET',
        headers,
        body,
        signal: controller.signal,
      });

      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(this.buildHttpError(response.status, responseText));
      }

      if (!responseText.trim()) {
        return {} as T;
      }

      if (this.looksLikeHtml(responseText)) {
        throw new Error(this.buildUnexpectedHtmlError(responseText));
      }

      try {
        return JSON.parse(responseText) as T;
      } catch {
        throw new Error('接口返回的不是合法 JSON，可能被站点网关或登录页拦截了。');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`请求超时（${timeoutMs}ms）`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private createBaseHeaders(baseUrl: string): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      Referer: `${baseUrl}/`,
      'User-Agent': BROWSER_LIKE_USER_AGENT,
    };
  }

  private async fetchWithRetry(url: URL, init: RequestInit): Promise<Response> {
    const response = await fetch(url, init);
    if (response.status !== 429) {
      return response;
    }

    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
    const retryDelayMs = Number.isFinite(retryAfterSeconds)
      ? Math.min(Math.max(retryAfterSeconds, 1), 5) * 1000
      : 1500;

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return await fetch(url, init);
  }

  private shouldAttachOidcBearerToken(options: RequestOptions): boolean {
    return Boolean(
      this.config.authMode === 'oidc'
      && this.config.oidcAccessToken
      && (this.config.oidcForumApiEnabled || options.useOidcBearerToken),
    );
  }

  private async tryGetCsrfToken(): Promise<string | undefined> {
    for (const path of CSRF_CANDIDATE_PATHS) {
      try {
        const data = await this.requestJson<{ csrf?: string; csrf_token?: string }>(path);
        const token = data.csrf ?? data.csrf_token;
        if (token) {
          return token;
        }
      } catch {
        // try next endpoint
      }
    }

    return undefined;
  }

  private buildHttpError(status: number, responseText: string): string {
    if (status === 403 && this.isCloudflareChallenge(responseText)) {
      return this.buildCloudflareBlockedMessage();
    }

    if (status === 429) {
      return '请求过于频繁（HTTP 429）。插件已自动做过一次重试；请稍等几秒后再刷新，或先在浏览器里多停留一会儿再重试。';
    }

    const snippet = this.normalizeSnippet(responseText).slice(0, 240);
    return `请求失败（HTTP ${status}）${snippet ? `：${snippet}` : ''}`;
  }

  private buildUnexpectedHtmlError(responseText: string): string {
    if (this.isCloudflareChallenge(responseText)) {
      return this.buildCloudflareBlockedMessage();
    }

    const snippet = this.normalizeSnippet(responseText).slice(0, 180);
    return `接口返回了 HTML 页面，而不是 JSON 数据${snippet ? `：${snippet}` : '。'}`;
  }

  private buildCloudflareBlockedMessage(): string {
    if (this.config.authMode === 'none') {
      return 'Linux.do 当前拦截了匿名论坛请求（Cloudflare 403）。请先点击“使用 Linux DO Connect 登录”，或手动配置 Session Cookie / User API Key。';
    }

    if (this.config.authMode === 'oidc' && this.config.oidcAccessToken?.trim() && !this.config.oidcForumApiEnabled) {
      return 'Linux.do 当前拦截了匿名论坛请求（Cloudflare 403）。扩展暂时还没确认 Linux DO Connect 令牌可直接访问论坛 API。请先重新登录后再刷新；如果仍失败，建议改用 Session Cookie。';
    }

    return `Linux.do 当前拦截了 ${this.describeAuthMode()} 请求（Cloudflare 403）。请稍后重试，或改用其它连接方式。`;
  }

  private isCloudflareChallenge(responseText: string): boolean {
    const normalized = responseText.toLowerCase();
    return normalized.includes('just a moment')
      || normalized.includes('cloudflare')
      || normalized.includes('/cdn-cgi/challenge-platform')
      || normalized.includes('cf-browser-verification');
  }

  private looksLikeHtml(responseText: string): boolean {
    const normalized = responseText.trim().toLowerCase();
    return normalized.startsWith('<!doctype html')
      || normalized.startsWith('<html')
      || normalized.includes('<title>')
      || normalized.includes('<body');
  }

  private normalizeSnippet(responseText: string): string {
    return responseText.replace(/\s+/g, ' ').trim();
  }

  private normalizeBaseUrl(value: string): string {
    return value.replace(/\/$/, '');
  }

  private getTimeoutMs(): number {
    const config = vscode.workspace.getConfiguration('linuxdo');
    const timeout = config.get<number>('requestTimeoutMs', 15000);
    return Math.max(3000, timeout);
  }
}
