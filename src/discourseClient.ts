import * as crypto from 'node:crypto';

import * as vscode from 'vscode';

const CSRF_CANDIDATE_PATHS = ['/session/csrf.json', '/csrf.json', '/session/csrf'];

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
}

export class DiscourseClient {
  private readonly userAgent = 'linuxdo-moyu-vscode-extension/0.1.0';

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
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': this.userAgent,
    };

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
    }

    if (this.config.authMode === 'cookie' && this.config.cookie) {
      headers.Cookie = this.config.cookie;
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }

    if (this.config.authMode === 'userApiKey' && this.config.userApiKey) {
      headers['User-Api-Key'] = this.config.userApiKey;
      headers['User-Api-Client-Id'] = this.config.userApiClientId || DiscourseClient.generateClientId();
    }

    if (this.config.authMode === 'oidc' && this.config.oidcAccessToken) {
      headers.Authorization = `Bearer ${this.config.oidcAccessToken}`;
    }

    const timeoutMs = this.getTimeoutMs();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
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

      return JSON.parse(responseText) as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`请求超时（${timeoutMs}ms）`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
    const snippet = responseText.replace(/\s+/g, ' ').trim().slice(0, 240);
    return `请求失败（HTTP ${status}）${snippet ? `：${snippet}` : ''}`;
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
