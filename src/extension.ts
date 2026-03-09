import * as vscode from 'vscode';

import { OidcAuthService } from './auth/browserAuthService';
import { ConnectionStore } from './connectionStore';
import { DiscourseClient } from './discourseClient';
import {
  AppState,
  ConnectionConfig,
  EMPTY_CONNECTION_CAPABILITIES,
  TopicDetails,
} from './discourseTypes';

const VIEW_ID = 'linuxdo.mainView';
const EXTENSION_ID = 'lucifercoo.linuxdo-moyu';

export function activate(context: vscode.ExtensionContext): void {
  let currentView: LinuxDoWebviewProvider | undefined;

  const connectionStore = new ConnectionStore(context, () => {
    void currentView?.refresh();
  });
  const oidcAuthService = new OidcAuthService(connectionStore, EXTENSION_ID);

  currentView = new LinuxDoWebviewProvider(context.extensionUri, connectionStore);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, currentView, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
    vscode.commands.registerCommand('linuxdo.refresh', async () => {
      await currentView?.refresh(true);
    }),
    vscode.commands.registerCommand('linuxdo.configureConnection', async () => {
      await configureConnection(connectionStore);
      await currentView?.refresh(true);
    }),
    vscode.window.registerUriHandler(oidcAuthService),
    vscode.commands.registerCommand('linuxdo.loginWithBrowser', async () => {
      try {
        await oidcAuthService.startLogin();
      } catch (error) {
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : '发起 Linux DO Connect 登录失败。',
        );
      }
    }),
    vscode.commands.registerCommand('linuxdo.clearConnection', async () => {
      const confirmed = await vscode.window.showWarningMessage(
        '确定要清除 Linux.do 连接信息吗？',
        { modal: true },
        '清除',
      );

      if (confirmed === '清除') {
        await connectionStore.clear();
        await currentView?.refresh(true);
      }
    }),
  );
}

export function deactivate(): void {
  // noop
}

class LinuxDoWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private state: AppState = this.createInitialState();

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connectionStore: ConnectionStore,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.renderWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      await this.handleMessage(message);
    });

    void this.refresh();
  }

  public async refresh(showToast = false): Promise<void> {
    this.state = {
      ...this.state,
      loading: true,
      error: undefined,
    };
    this.postState();

    try {
      const connection = await this.connectionStore.load();
      const client = new DiscourseClient(connection);

      const latestTopicsPromise = client.getLatestTopics();
      const categoriesPromise = client.getCategories();

      const capabilities = client.getCapabilities();
      const sessionPromise = client.isConfigured() && capabilities.canReadSession
        ? client.getSessionCurrent().catch(() => undefined)
        : Promise.resolve(undefined);

      const notificationsPromise = client.isConfigured() && capabilities.canReadNotifications
        ? client.getNotifications().catch(() => [])
        : Promise.resolve([]);

      const [latestTopics, categories, session, notifications] = await Promise.all([
        latestTopicsPromise,
        categoriesPromise,
        sessionPromise,
        notificationsPromise,
      ]);

      const selectedCategorySlug = this.state.selectedCategorySlug;
      const selectedCategoryId = this.state.selectedCategoryId;
      const categoryTopics = selectedCategorySlug
        ? await client.getCategoryTopics(selectedCategorySlug, selectedCategoryId).catch(() => [])
        : [];

      let activeTopic = this.state.activeTopic;
      if (activeTopic?.id) {
        activeTopic = await client.getTopic(activeTopic.id).catch(() => undefined);
      }

      this.state = {
        connection: {
          baseUrl: client.getBaseUrl(),
          authMode: connection.authMode,
          configured: client.isConfigured(),
          username: connection.username ?? session?.current_user?.username,
          capabilities,
        },
        session,
        latestTopics,
        categories,
        selectedCategorySlug,
        selectedCategoryId,
        selectedCategoryName: this.state.selectedCategoryName,
        categoryTopics,
        activeTopic,
        notifications,
        loading: false,
      };

      this.postState();

      if (showToast) {
        void vscode.window.showInformationMessage('Linux.do 已刷新。');
      }
    } catch (error) {
      this.state = {
        ...this.state,
        loading: false,
        error: error instanceof Error ? error.message : '刷新失败',
      };
      this.postState();
    }
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.postState();
        return;
      case 'refresh':
        await this.refresh();
        return;
      case 'configureConnection':
        await vscode.commands.executeCommand('linuxdo.configureConnection');
        return;
      case 'loginWithBrowser':
        await vscode.commands.executeCommand('linuxdo.loginWithBrowser');
        return;
      case 'clearConnection':
        await vscode.commands.executeCommand('linuxdo.clearConnection');
        return;
      case 'openTopic':
        await this.openTopic(message.topicId);
        return;
      case 'openInBrowser':
        await vscode.env.openExternal(vscode.Uri.parse(message.url));
        return;
      case 'selectCategory':
        await this.selectCategory(message.slug, message.name, message.categoryId);
        return;
      case 'replyTopic':
        await this.replyTopic(message.topicId, message.raw, message.replyToPostNumber);
        return;
      default:
        return;
    }
  }

  private async openTopic(topicId: number): Promise<void> {
    const connection = await this.connectionStore.load();
    const client = new DiscourseClient(connection);
    this.state = {
      ...this.state,
      loading: true,
      error: undefined,
    };
    this.postState();

    try {
      const topic = await client.getTopic(topicId);
      this.state = {
        ...this.state,
        activeTopic: topic,
        loading: false,
      };
      this.postState();
    } catch (error) {
      this.state = {
        ...this.state,
        loading: false,
        error: error instanceof Error ? error.message : '打开主题失败',
      };
      this.postState();
    }
  }

  private async selectCategory(slug: string, name: string, categoryId?: number): Promise<void> {
    const connection = await this.connectionStore.load();
    const client = new DiscourseClient(connection);
    this.state = {
      ...this.state,
      loading: true,
      selectedCategorySlug: slug,
      selectedCategoryId: categoryId,
      selectedCategoryName: name,
      error: undefined,
    };
    this.postState();

    try {
      const topics = await client.getCategoryTopics(slug, categoryId);
      this.state = {
        ...this.state,
        categoryTopics: topics,
        loading: false,
      };
      this.postState();
    } catch (error) {
      this.state = {
        ...this.state,
        categoryTopics: [],
        loading: false,
        error: error instanceof Error ? error.message : '加载分类失败',
      };
      this.postState();
    }
  }

  private async replyTopic(topicId: number, raw: string, replyToPostNumber?: number): Promise<void> {
    if (!raw.trim()) {
      void vscode.window.showWarningMessage('回复内容不能为空。');
      return;
    }

    const connection = await this.connectionStore.load();
    const client = new DiscourseClient(connection);

    if (!client.isConfigured()) {
      void vscode.window.showWarningMessage('请先配置连接后再回复。');
      return;
    }

    if (!client.getCapabilities().canReply) {
      void vscode.window.showWarningMessage('当前连接没有回复权限，请改用浏览器授权登录或 Cookie 连接。');
      return;
    }

    this.state = {
      ...this.state,
      loading: true,
      error: undefined,
    };
    this.postState();

    try {
      await client.createReply({
        topicId,
        raw,
        replyToPostNumber,
      });
      await this.refresh();
      void vscode.window.showInformationMessage('回复已发送。');
    } catch (error) {
      this.state = {
        ...this.state,
        loading: false,
        error: error instanceof Error ? error.message : '发送回复失败',
      };
      this.postState();
    }
  }

  private postState(): void {
    this.view?.webview.postMessage({
      type: 'state',
      payload: this.state,
    } satisfies StateEnvelope);
  }

  private createInitialState(): AppState {
    return {
      connection: {
        baseUrl: 'https://linux.do',
        authMode: 'none',
        configured: false,
        capabilities: EMPTY_CONNECTION_CAPABILITIES,
      },
      selectedCategoryId: undefined,
      latestTopics: [],
      categories: [],
      categoryTopics: [],
      notifications: [],
      loading: true,
    };
  }

  private renderWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const cspSource = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Linux.do</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-sideBar-background);
      --panel: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
      --panel-border: var(--vscode-panel-border);
      --text: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --primary: var(--vscode-textLink-foreground);
      --primary-strong: var(--vscode-textLink-activeForeground);
      --danger: #ef4444;
      --badge: color-mix(in srgb, var(--vscode-badge-background) 85%, #0ea5e9);
      --badge-text: var(--vscode-badge-foreground);
      --shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
    }

    * {
      box-sizing: border-box;
    }

    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--vscode-font-family);
      height: 100%;
    }

    body {
      padding: 16px;
    }

    .app {
      display: grid;
      gap: 16px;
    }

    .hero {
      background: linear-gradient(135deg, rgba(56, 189, 248, 0.18), rgba(14, 165, 233, 0.08));
      border: 1px solid rgba(56, 189, 248, 0.28);
      border-radius: 18px;
      padding: 18px;
      box-shadow: var(--shadow);
    }

    .hero h1 {
      margin: 0 0 8px;
      font-size: 20px;
    }

    .hero p {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }

    button, textarea {
      font: inherit;
    }

    button {
      border: 1px solid transparent;
      border-radius: 10px;
      padding: 8px 12px;
      cursor: pointer;
      transition: 160ms ease;
    }

    button.primary {
      background: var(--primary);
      color: white;
    }

    button.secondary {
      background: color-mix(in srgb, var(--vscode-button-secondaryBackground) 86%, transparent);
      color: var(--vscode-button-secondaryForeground);
      border-color: color-mix(in srgb, var(--panel-border) 80%, transparent);
    }

    button.ghost {
      background: transparent;
      color: var(--primary);
      border-color: color-mix(in srgb, var(--primary) 28%, transparent);
    }

    button.danger {
      background: transparent;
      color: var(--danger);
      border-color: color-mix(in srgb, var(--danger) 32%, transparent);
    }

    button:hover {
      transform: translateY(-1px);
      filter: brightness(1.05);
    }

    .status-card,
    .section,
    .topic-card,
    .post-card {
      background: var(--panel);
      border: 1px solid color-mix(in srgb, var(--panel-border) 78%, transparent);
      border-radius: 16px;
      box-shadow: var(--shadow);
    }

    .status-card,
    .section {
      padding: 14px;
    }

    .status-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 10px;
    }

    .metric {
      padding: 12px;
      border-radius: 12px;
      background: color-mix(in srgb, var(--panel) 75%, transparent);
      border: 1px solid color-mix(in srgb, var(--panel-border) 75%, transparent);
    }

    .metric .label {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 6px;
    }

    .metric .value {
      font-size: 14px;
      font-weight: 600;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 12px;
    }

    .section-title {
      margin: 0;
      font-size: 16px;
    }

    .section-subtitle {
      color: var(--muted);
      font-size: 12px;
    }

    .topic-list,
    .post-list,
    .category-list,
    .notifications-list {
      display: grid;
      gap: 12px;
    }

    .topic-card,
    .post-card {
      padding: 14px;
    }

    .topic-card h3,
    .post-card h3 {
      margin: 0 0 8px;
      font-size: 15px;
      line-height: 1.45;
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 8px;
    }

    .tag-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
    }

    .tag,
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 12px;
      background: color-mix(in srgb, var(--primary) 15%, transparent);
      color: var(--primary-strong);
      border: 1px solid color-mix(in srgb, var(--primary) 24%, transparent);
    }

    .badge {
      background: var(--badge);
      color: var(--badge-text);
      border: none;
    }

    .category-button {
      width: 100%;
      text-align: left;
      background: color-mix(in srgb, var(--panel) 72%, transparent);
      color: var(--text);
      border: 1px solid color-mix(in srgb, var(--panel-border) 75%, transparent);
      border-radius: 14px;
      padding: 12px;
    }

    .category-button.active {
      border-color: color-mix(in srgb, var(--primary) 55%, transparent);
      background: color-mix(in srgb, var(--primary) 14%, transparent);
    }

    .category-name {
      font-weight: 600;
      margin-bottom: 6px;
    }

    .category-desc {
      font-size: 12px;
      color: var(--muted);
    }

    .topic-content {
      margin-top: 14px;
      display: grid;
      gap: 14px;
    }

    .post-body {
      line-height: 1.65;
      overflow-wrap: anywhere;
    }

    .post-body img {
      max-width: 100%;
      border-radius: 10px;
    }

    .reply-box {
      display: grid;
      gap: 10px;
      margin-top: 14px;
    }

    textarea {
      width: 100%;
      min-height: 120px;
      resize: vertical;
      border-radius: 12px;
      border: 1px solid color-mix(in srgb, var(--panel-border) 78%, transparent);
      background: color-mix(in srgb, var(--vscode-input-background) 90%, transparent);
      color: var(--vscode-input-foreground);
      padding: 12px;
    }

    .empty,
    .error,
    .loading {
      padding: 12px 14px;
      border-radius: 12px;
      font-size: 13px;
    }

    .empty {
      color: var(--muted);
      background: color-mix(in srgb, var(--panel) 76%, transparent);
      border: 1px dashed color-mix(in srgb, var(--panel-border) 70%, transparent);
    }

    .error {
      color: #fecaca;
      background: rgba(127, 29, 29, 0.32);
      border: 1px solid rgba(239, 68, 68, 0.45);
    }

    .loading {
      color: var(--muted);
      background: color-mix(in srgb, var(--panel) 76%, transparent);
      border: 1px solid color-mix(in srgb, var(--panel-border) 70%, transparent);
    }

    a.inline-link {
      color: var(--primary);
      text-decoration: none;
    }

    .footer-tip {
      font-size: 12px;
      color: var(--muted);
      line-height: 1.55;
    }
  </style>
</head>
<body>
  <div id="app" class="app"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = {
      connection: {
        baseUrl: 'https://linux.do',
        authMode: 'none',
        configured: false,
        capabilities: {
          canReadSession: false,
          canReadNotifications: false,
          canReply: false,
        },
      },
      latestTopics: [],
      categories: [],
      categoryTopics: [],
      notifications: [],
      loading: true,
    };

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message?.type === 'state') {
        Object.assign(state, message.payload);
        render();
      }
    });

    function render() {
      const app = document.getElementById('app');
      const activeTopic = state.activeTopic;
      const activeTopicId = activeTopic?.id;
      const notificationHtml = state.notifications.length
        ? state.notifications.map((item) => {
            const targetUrl = item.topic_id ? buildTopicUrl(item.topic_id, item.post_number, item.slug) : state.connection.baseUrl;
            const title = escapeHtml(item.fancy_title || item.data?.topic_title || '通知');
            const detail = escapeHtml(item.data?.message || item.data?.display_username || '');
            return 
              '<div class="topic-card">' +
                '<div class="meta">' +
                  '<span>' + escapeHtml(formatDate(item.created_at)) + '</span>' +
                  (item.read ? '<span>已读</span>' : '<span class="badge">未读</span>') +
                '</div>' +
                '<h3>' + title + '</h3>' +
                (detail ? '<div class="section-subtitle">' + detail + '</div>' : '') +
                '<div class="toolbar">' +
                  '<button class="ghost" data-open-url="' + encodeAttr(targetUrl) + '">打开原帖</button>' +
                  (item.topic_id ? '<button class="secondary" data-open-topic="' + item.topic_id + '">在插件中查看</button>' : '') +
                '</div>' +
              '</div>';
          }).join('')
        : '<div class="empty">还没有通知，或者当前连接方式没有权限读取通知。</div>';

      const latestTopicsHtml = state.latestTopics.length
        ? state.latestTopics.map(renderTopicCard).join('')
        : '<div class="empty">暂无主题数据。若匿名请求失败，可以先配置连接。</div>';

      const categoryHtml = state.categories.length
        ? state.categories.map((category) => {
            const active = state.selectedCategorySlug === category.slug ? 'active' : '';
            return 
              '<button class="category-button ' + active + '" data-category-slug="' + encodeAttr(category.slug) + '" data-category-name="' + encodeAttr(category.name) + '" data-category-id="' + category.id + '">' +
                '<div class="category-name">' + escapeHtml(category.name) + '</div>' +
                '<div class="category-desc">' + escapeHtml(category.description_text || '') + '</div>' +
                '<div class="meta">' +
                  (category.topic_count ? '<span>主题 ' + category.topic_count + '</span>' : '') +
                  (category.post_count ? '<span>帖子 ' + category.post_count + '</span>' : '') +
                '</div>' +
              '</button>';
          }).join('')
        : '<div class="empty">分类加载中或当前站点禁止匿名读取。</div>';

      const categoryTopicsHtml = state.selectedCategorySlug
        ? (state.categoryTopics.length
            ? state.categoryTopics.map(renderTopicCard).join('')
            : '<div class="empty">该分类暂时没有读取到主题。</div>')
        : '<div class="empty">点一个分类，我帮你把分类主题流拉出来。</div>';

      const topicDetailHtml = activeTopic
        ? renderTopicDetail(activeTopic)
        : '<div class="empty">先从主题列表里点开一个帖子，我们再继续往下读楼和回复。你觉得应该先看最新帖，还是先按分类刷？</div>';

      app.innerHTML = 
        '<section class="hero">' +
          '<h1>Linux.do Moyu</h1>' +
          '<p>先把高频摸鱼链路做顺：看最新、进分类、读帖子、查通知、随手回一条。剩下的高级能力，我们再逐步补齐。</p>' +
          '<div class="toolbar">' +
            '<button class="primary" data-action="refresh">刷新</button>' +
            '<button class="secondary" data-action="loginWithBrowser">使用 Linux DO Connect 登录</button>' +
            '<button class="secondary" data-action="configureConnection">手动配置连接</button>' +
            '<button class="danger" data-action="clearConnection">清除连接</button>' +
            '<button class="ghost" data-open-url="' + encodeAttr(state.connection.baseUrl) + '">打开原站</button>' +
          '</div>' +
        '</section>' +

        '<section class="status-card">' +
          '<div class="section-header">' +
            '<div>' +
              '<h2 class="section-title">连接状态</h2>' +
              '<div class="section-subtitle">你想想看：哪些能力必须登录？哪些能力其实匿名就能逛？</div>' +
            '</div>' +
            (state.loading ? '<span class="badge">加载中</span>' : '') +
          '</div>' +
          (state.error ? '<div class="error">' + escapeHtml(state.error) + '</div>' : '') +
          '<div class="status-grid">' +
            '<div class="metric"><div class="label">站点</div><div class="value">' + escapeHtml(state.connection.baseUrl) + '</div></div>' +
            '<div class="metric"><div class="label">连接方式</div><div class="value">' + escapeHtml(describeAuthMode(state.connection.authMode)) + '</div></div>' +
            '<div class="metric"><div class="label">当前用户</div><div class="value">' + escapeHtml(state.session?.current_user?.username || state.connection.username || '匿名') + '</div></div>' +
            '<div class="metric"><div class="label">未读通知</div><div class="value">' + escapeHtml(String(state.session?.unread_notifications ?? state.notifications.filter((item) => !item.read).length)) + '</div></div>' +
            '<div class="metric"><div class="label">回复权限</div><div class="value">' + escapeHtml(state.connection.capabilities.canReply ? '可回复' : '只读') + '</div></div>' +
          '</div>' +
        '</section>' +

        '<section class="section">' +
          '<div class="section-header">' +
            '<div>' +
              '<h2 class="section-title">通知</h2>' +
              '<div class="section-subtitle">回复、提及、系统提醒都会先汇总在这里。</div>' +
            '</div>' +
            '<span class="badge">' + state.notifications.length + '</span>' +
          '</div>' +
          '<div class="notifications-list">' + notificationHtml + '</div>' +
        '</section>' +

        '<section class="section">' +
          '<div class="section-header">' +
            '<div>' +
              '<h2 class="section-title">最新主题</h2>' +
              '<div class="section-subtitle">对应 Discourse 的 /latest.json。</div>' +
            '</div>' +
            '<span class="badge">' + state.latestTopics.length + '</span>' +
          '</div>' +
          '<div class="topic-list">' + latestTopicsHtml + '</div>' +
        '</section>' +

        '<section class="section">' +
          '<div class="section-header">' +
            '<div>' +
              '<h2 class="section-title">分类</h2>' +
              '<div class="section-subtitle">当你想定向摸鱼时，分类比 latest 更高效。</div>' +
            '</div>' +
            '<span class="badge">' + state.categories.length + '</span>' +
          '</div>' +
          '<div class="category-list">' + categoryHtml + '</div>' +
        '</section>' +

        '<section class="section">' +
          '<div class="section-header">' +
            '<div>' +
              '<h2 class="section-title">' + escapeHtml(state.selectedCategoryName || '分类主题流') + '</h2>' +
              '<div class="section-subtitle">你也可以把这里扩展成“收藏分类”或“常逛版块”。</div>' +
            '</div>' +
            '<span class="badge">' + state.categoryTopics.length + '</span>' +
          '</div>' +
          '<div class="topic-list">' + categoryTopicsHtml + '</div>' +
        '</section>' +

        '<section class="section">' +
          '<div class="section-header">' +
            '<div>' +
              '<h2 class="section-title">帖子详情</h2>' +
              '<div class="section-subtitle">当前主题 ID：' + escapeHtml(activeTopicId ? String(activeTopicId) : '未选择') + '</div>' +
            '</div>' +
            (activeTopicId ? '<button class="ghost" data-open-url="' + encodeAttr(buildTopicUrl(activeTopicId, undefined, activeTopic?.slug)) + '">浏览器打开</button>' : '') +
          '</div>' +
          '<div class="topic-content">' + topicDetailHtml + '</div>' +
        '</section>' +

        '<div class="footer-tip">提示：Discourse 的不少高级能力仍然值得保留“打开原站”兜底，比如复杂编辑器、投票、某些插件页与管理页。要做到“尽可能全功能”，更现实的路径往往不是 100% 重写，而是 80% 原生化 + 20% 原站回退。</div>';

      bindEvents();
    }

    function renderTopicCard(topic) {
      return 
        '<article class="topic-card">' +
          '<div class="meta">' +
            '<span>#' + topic.id + '</span>' +
            (topic.posts_count ? '<span>帖子 ' + topic.posts_count + '</span>' : '') +
            (topic.views ? '<span>浏览 ' + topic.views + '</span>' : '') +
            (topic.last_posted_at ? '<span>活跃于 ' + escapeHtml(formatDate(topic.last_posted_at)) + '</span>' : '') +
          '</div>' +
          '<h3>' + escapeHtml(topic.title) + '</h3>' +
          (topic.excerpt ? '<div class="section-subtitle">' + escapeHtml(stripHtml(topic.excerpt)) + '</div>' : '') +
          '<div class="tag-row">' +
            (Array.isArray(topic.tags) ? topic.tags.map((tag) => '<span class="tag">' + escapeHtml(tag) + '</span>').join('') : '') +
          '</div>' +
          '<div class="toolbar">' +
            '<button class="primary" data-open-topic="' + topic.id + '">在插件中查看</button>' +
            '<button class="ghost" data-open-url="' + encodeAttr(buildTopicUrl(topic.id, undefined, topic.slug)) + '">浏览器打开</button>' +
          '</div>' +
        '</article>';
    }

    function renderTopicDetail(topic) {
      const posts = topic.post_stream?.posts || [];
      const replyBox = state.connection.capabilities.canReply
        ? 
          '<div class="reply-box">' +
            '<textarea id="reply-input" placeholder="写点什么？支持 Markdown。"></textarea>' +
            '<div class="toolbar">' +
              '<button class="primary" data-submit-reply="' + topic.id + '">回复主题</button>' +
            '</div>' +
          '</div>'
        : '<div class="empty">当前还没有可回复的登录会话。你可以点击上面的“使用 Linux DO Connect 登录”，或手动配置其它连接方式。</div>';

      const postsHtml = posts.length
        ? posts.map((post) => 
            '<article class="post-card">' +
              '<div class="meta">' +
                '<span>#' + post.post_number + '</span>' +
                '<span>@' + escapeHtml(post.username) + '</span>' +
                (post.created_at ? '<span>' + escapeHtml(formatDate(post.created_at)) + '</span>' : '') +
                (post.reply_to_post_number ? '<span>回复 #' + post.reply_to_post_number + '</span>' : '') +
              '</div>' +
              '<h3>' + escapeHtml(post.name || post.username) + '</h3>' +
              '<div class="post-body">' + (post.cooked || '<div class="empty">该楼层暂无渲染内容。</div>') + '</div>' +
              '<div class="toolbar">' +
                '<button class="ghost" data-open-url="' + encodeAttr(buildTopicUrl(topic.id, post.post_number, topic.slug)) + '">打开该楼层</button>' +
                (state.connection.capabilities.canReply ? '<button class="secondary" data-reply-to="' + post.post_number + '" data-topic-id="' + topic.id + '">回复这层</button>' : '') +
              '</div>' +
            '</article>'
          ).join('')
        : '<div class="empty">当前主题没有加载到楼层内容。</div>';

      return 
        '<article class="topic-card">' +
          '<h3>' + escapeHtml(topic.fancy_title || topic.title) + '</h3>' +
          '<div class="meta">' +
            (topic.views ? '<span>浏览 ' + topic.views + '</span>' : '') +
            (topic.posts_count ? '<span>帖子 ' + topic.posts_count + '</span>' : '') +
            (topic.created_at ? '<span>创建于 ' + escapeHtml(formatDate(topic.created_at)) + '</span>' : '') +
          '</div>' +
        '</article>' +
        postsHtml +
        replyBox;
    }

    function bindEvents() {
      document.querySelectorAll('[data-action="refresh"]').forEach((element) => {
        element.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
      });

      document.querySelectorAll('[data-action="configureConnection"]').forEach((element) => {
        element.addEventListener('click', () => vscode.postMessage({ type: 'configureConnection' }));
      });

      document.querySelectorAll('[data-action="loginWithBrowser"]').forEach((element) => {
        element.addEventListener('click', () => vscode.postMessage({ type: 'loginWithBrowser' }));
      });

      document.querySelectorAll('[data-action="clearConnection"]').forEach((element) => {
        element.addEventListener('click', () => vscode.postMessage({ type: 'clearConnection' }));
      });

      document.querySelectorAll('[data-open-topic]').forEach((element) => {
        element.addEventListener('click', () => {
          const topicId = Number(element.getAttribute('data-open-topic'));
          if (!Number.isNaN(topicId)) {
            vscode.postMessage({ type: 'openTopic', topicId });
          }
        });
      });

      document.querySelectorAll('[data-open-url]').forEach((element) => {
        element.addEventListener('click', () => {
          const url = element.getAttribute('data-open-url');
          if (url) {
            vscode.postMessage({ type: 'openInBrowser', url });
          }
        });
      });

      document.querySelectorAll('[data-category-slug]').forEach((element) => {
        element.addEventListener('click', () => {
          const slug = element.getAttribute('data-category-slug');
          const name = element.getAttribute('data-category-name') || slug;
          const categoryId = Number(element.getAttribute('data-category-id'));
          if (slug) {
            vscode.postMessage({
              type: 'selectCategory',
              slug,
              name,
              categoryId: Number.isNaN(categoryId) ? undefined : categoryId,
            });
          }
        });
      });

      document.querySelectorAll('[data-submit-reply]').forEach((element) => {
        element.addEventListener('click', () => {
          const topicId = Number(element.getAttribute('data-submit-reply'));
          const textarea = document.getElementById('reply-input');
          const raw = textarea && 'value' in textarea ? textarea.value : '';
          if (!Number.isNaN(topicId)) {
            vscode.postMessage({ type: 'replyTopic', topicId, raw });
          }
        });
      });

      document.querySelectorAll('[data-reply-to]').forEach((element) => {
        element.addEventListener('click', () => {
          const topicId = Number(element.getAttribute('data-topic-id'));
          const replyToPostNumber = Number(element.getAttribute('data-reply-to'));
          const textarea = document.getElementById('reply-input');
          const raw = textarea && 'value' in textarea ? textarea.value : '';
          if (!raw.trim()) {
            const target = document.getElementById('reply-input');
            target?.focus();
            return;
          }
          if (!Number.isNaN(topicId) && !Number.isNaN(replyToPostNumber)) {
            vscode.postMessage({ type: 'replyTopic', topicId, raw, replyToPostNumber });
          }
        });
      });
    }

    function buildTopicUrl(topicId, postNumber, slug) {
      const safeSlug = (slug || 'topic').trim() || 'topic';
      return state.connection.baseUrl.replace(/\/$/, '') + '/t/' + safeSlug + '/' + topicId + (postNumber ? '/' + postNumber : '');
    }

    function describeAuthMode(authMode) {
      if (authMode === 'cookie') return 'Session Cookie';
      if (authMode === 'userApiKey') return 'User API Key';
      if (authMode === 'oidc') return 'Linux DO Connect';
      return '匿名浏览';
    }

    function formatDate(value) {
      if (!value) return '时间未知';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    function stripHtml(value) {
      return value.replace(/<[^>]*>/g, ' ');
    }

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function encodeAttr(value) {
      return escapeHtml(value).split(String.fromCharCode(96)).join('&#96;');
    }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

async function configureConnection(connectionStore: ConnectionStore): Promise<void> {
  const current = await connectionStore.load();

  const baseUrl = await vscode.window.showInputBox({
    title: 'Linux.do / Discourse 站点地址',
    prompt: '默认使用 https://linux.do，也可以换成其它 Discourse 站点。',
    value: current.baseUrl,
    ignoreFocusOut: true,
    validateInput: (value) => {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
          return '站点地址必须以 http:// 或 https:// 开头';
        }
        return undefined;
      } catch {
        return '请输入合法 URL';
      }
    },
  });

  if (!baseUrl) {
    return;
  }

  const authModePick = await vscode.window.showQuickPick(
    [
      { label: '匿名浏览', value: 'none', detail: '只看公开内容，最省事。' },
      { label: 'Linux DO Connect（推荐）', value: 'oidc', detail: '使用系统浏览器完成 OAuth / OIDC 登录并自动回到 VS Code。' },
      { label: 'User API Key（手动粘贴）', value: 'userApiKey', detail: '更正规，适合已有 key 时手动配置。' },
      { label: 'Session Cookie', value: 'cookie', detail: '复用浏览器登录，适合先跑通 MVP。' },
    ],
    {
      title: '选择连接方式',
      placeHolder: '你更想先解决“能用”，还是“更规范的授权”？',
      ignoreFocusOut: true,
    },
  );

  if (!authModePick) {
    return;
  }

  if (authModePick.value === 'oidc') {
    await connectionStore.save({
      baseUrl,
      authMode: 'none',
      oidcClientId: current.oidcClientId,
      oidcClientSecret: current.oidcClientSecret,
    });
    await vscode.commands.executeCommand('linuxdo.loginWithBrowser');
    return;
  }

  const nextConfig: ConnectionConfig = {
    baseUrl,
    authMode: authModePick.value as ConnectionConfig['authMode'],
  };

  if (nextConfig.authMode === 'userApiKey') {
    const userApiKey = await vscode.window.showInputBox({
      title: 'User API Key',
      prompt: '填入 Discourse User API Key。',
      password: true,
      ignoreFocusOut: true,
      value: current.userApiKey,
    });

    if (!userApiKey) {
      return;
    }

    const userApiClientId = await vscode.window.showInputBox({
      title: 'User API Client ID',
      prompt: '可留空自动生成；若你已有固定 client_id，也可以填入。',
      value: current.userApiClientId || DiscourseClient.generateClientId(),
      ignoreFocusOut: true,
    });

    const username = await vscode.window.showInputBox({
      title: 'Username（可选）',
      prompt: '建议填写，便于界面展示当前连接身份。',
      value: current.username,
      ignoreFocusOut: true,
    });

    nextConfig.username = username;
    nextConfig.userApiKey = userApiKey;
    nextConfig.userApiClientId = userApiClientId || DiscourseClient.generateClientId();
    nextConfig.username = username;
  }

  if (nextConfig.authMode === 'cookie') {
    const cookie = await vscode.window.showInputBox({
      title: 'Session Cookie',
      prompt: '从浏览器复制完整 Cookie 字符串。',
      password: true,
      ignoreFocusOut: true,
      value: current.cookie,
    });

    if (!cookie) {
      return;
    }

    const username = await vscode.window.showInputBox({
      title: 'Username（可选）',
      prompt: '若你知道当前登录用户名，可以填上。',
      value: current.username,
      ignoreFocusOut: true,
    });

    nextConfig.cookie = cookie;
    nextConfig.username = username;
  }

  await connectionStore.save(nextConfig);
  void vscode.window.showInformationMessage('Linux.do 连接已保存。');
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let index = 0; index < 32; index += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'configureConnection' }
  | { type: 'loginWithBrowser' }
  | { type: 'clearConnection' }
  | { type: 'openTopic'; topicId: number }
  | { type: 'openInBrowser'; url: string }
  | { type: 'selectCategory'; slug: string; name: string; categoryId?: number }
  | { type: 'replyTopic'; topicId: number; raw: string; replyToPostNumber?: number };

type StateEnvelope = {
  type: 'state';
  payload: AppState;
};
