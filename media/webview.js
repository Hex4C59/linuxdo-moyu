try {
  const vscode = acquireVsCodeApi();
  const bootSentinel = document.getElementById('boot-sentinel');
  if (bootSentinel) {
    bootSentinel.textContent = 'Linux.do Webview 脚本已启动，正在等待数据...';
  }

  vscode.postMessage({ type: 'webviewBoot' });

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

  window.addEventListener('error', (event) => {
    showFatalError(event.error || event.message || '未知脚本错误');
  });

  window.addEventListener('unhandledrejection', (event) => {
    showFatalError(event.reason || '未处理的异步异常');
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type === 'state') {
      Object.assign(state, message.payload);
      render();
    }
  });

  render();

  function showFatalError(error) {
    const app = document.getElementById('app');
    const message = error && error.message ? error.message : String(error || '未知错误');
    if (!app) {
      return;
    }

    app.innerHTML = ''
      + '<section class="status-card">'
      + '<div class="section-header">'
      + '<div>'
      + '<h2 class="section-title">Webview 脚本错误</h2>'
      + '<div class="section-subtitle">前端渲染失败，错误信息如下。</div>'
      + '</div>'
      + '</div>'
      + '<div class="error">' + escapeHtml(message) + '</div>'
      + '</section>';

    vscode.postMessage({ type: 'webviewError', message });
  }

  function render() {
    const app = document.getElementById('app');
    if (!app) {
      return;
    }

    const activeTopic = state.activeTopic;
    const activeTopicId = activeTopic?.id;
    const notificationHtml = state.notifications.length
      ? state.notifications.map((item) => {
          const targetUrl = item.topic_id
            ? buildTopicUrl(item.topic_id, item.post_number, item.slug)
            : state.connection.baseUrl;
          const title = escapeHtml(item.fancy_title || item.data?.topic_title || '通知');
          const detail = escapeHtml(item.data?.message || item.data?.display_username || '');

          return '<div class="topic-card">'
            + '<div class="meta">'
            + '<span>' + escapeHtml(formatDate(item.created_at)) + '</span>'
            + (item.read ? '<span>已读</span>' : '<span class="badge">未读</span>')
            + '</div>'
            + '<h3>' + title + '</h3>'
            + (detail ? '<div class="section-subtitle">' + detail + '</div>' : '')
            + '<div class="toolbar">'
            + '<button class="ghost" data-open-url="' + encodeAttr(targetUrl) + '">打开原帖</button>'
            + (item.topic_id
              ? '<button class="secondary" data-open-topic="' + item.topic_id + '">在插件中查看</button>'
              : '')
            + '</div>'
            + '</div>';
        }).join('')
      : '<div class="empty">还没有通知，或者当前连接方式没有权限读取通知。</div>';

    const latestTopicsHtml = state.latestTopics.length
      ? state.latestTopics.map(renderTopicCard).join('')
      : '<div class="empty">暂无主题数据。若匿名请求失败，可以先配置连接。</div>';

    const categoryHtml = state.categories.length
      ? state.categories.map((category) => {
          const active = state.selectedCategorySlug === category.slug ? 'active' : '';
          return '<button class="category-button ' + active + '" data-category-slug="' + encodeAttr(category.slug) + '" data-category-name="' + encodeAttr(category.name) + '" data-category-id="' + category.id + '">'
            + '<div class="category-name">' + escapeHtml(category.name) + '</div>'
            + '<div class="category-desc">' + escapeHtml(category.description_text || '') + '</div>'
            + '<div class="meta">'
            + (category.topic_count ? '<span>主题 ' + category.topic_count + '</span>' : '')
            + (category.post_count ? '<span>帖子 ' + category.post_count + '</span>' : '')
            + '</div>'
            + '</button>';
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

    app.innerHTML = ''
      + '<section class="hero">'
      + '<h1>Linux.do Moyu</h1>'
      + '<p>先把高频摸鱼链路做顺：看最新、进分类、读帖子、查通知、随手回一条。剩下的高级能力，我们再逐步补齐。</p>'
      + '<div class="toolbar">'
      + '<button class="primary" data-action="refresh">刷新</button>'
      + '<button class="secondary" data-action="browserLoginAndImportSession">浏览器登录并接管会话</button>'
      + '<button class="secondary" data-action="loginWithBrowser">使用 Linux DO Connect 登录</button>'
      + '<button class="secondary" data-action="loginWithCookie">使用 Linux.do Cookie 登录</button>'
      + '<button class="secondary" data-action="configureConnection">手动配置连接</button>'
      + '<button class="danger" data-action="clearConnection">清除连接</button>'
      + '<button class="ghost" data-open-url="' + encodeAttr(state.connection.baseUrl) + '">打开原站</button>'
      + '</div>'
      + '</section>'
      + '<section class="status-card">'
      + '<div class="section-header">'
      + '<div>'
      + '<h2 class="section-title">连接状态</h2>'
      + '<div class="section-subtitle">你想想看：哪些能力必须登录？哪些能力其实匿名就能逛？</div>'
      + '</div>'
      + (state.loading ? '<span class="badge">加载中</span>' : '')
      + '</div>'
      + (state.error ? '<div class="error">' + escapeHtml(state.error) + '</div>' : '')
      + '<div class="status-grid">'
      + '<div class="metric"><div class="label">站点</div><div class="value">' + escapeHtml(state.connection.baseUrl) + '</div></div>'
      + '<div class="metric"><div class="label">连接方式</div><div class="value">' + escapeHtml(describeAuthMode(state.connection.authMode)) + '</div></div>'
      + '<div class="metric"><div class="label">当前用户</div><div class="value">' + escapeHtml(state.session?.current_user?.username || state.connection.username || '匿名') + '</div></div>'
      + '<div class="metric"><div class="label">未读通知</div><div class="value">' + escapeHtml(String(state.session?.unread_notifications ?? state.notifications.filter((item) => !item.read).length)) + '</div></div>'
      + '<div class="metric"><div class="label">回复权限</div><div class="value">' + escapeHtml(state.connection.capabilities.canReply ? '可回复' : '只读') + '</div></div>'
      + '</div>'
      + '</section>'
      + '<section class="section">'
      + '<div class="section-header">'
      + '<div>'
      + '<h2 class="section-title">通知</h2>'
      + '<div class="section-subtitle">回复、提及、系统提醒都会先汇总在这里。</div>'
      + '</div>'
      + '<span class="badge">' + state.notifications.length + '</span>'
      + '</div>'
      + '<div class="notifications-list">' + notificationHtml + '</div>'
      + '</section>'
      + '<section class="section">'
      + '<div class="section-header">'
      + '<div>'
      + '<h2 class="section-title">最新主题</h2>'
      + '<div class="section-subtitle">对应 Discourse 的 /latest.json。</div>'
      + '</div>'
      + '<span class="badge">' + state.latestTopics.length + '</span>'
      + '</div>'
      + '<div class="topic-list">' + latestTopicsHtml + '</div>'
      + '</section>'
      + '<section class="section">'
      + '<div class="section-header">'
      + '<div>'
      + '<h2 class="section-title">分类</h2>'
      + '<div class="section-subtitle">当你想定向摸鱼时，分类比 latest 更高效。</div>'
      + '</div>'
      + '<span class="badge">' + state.categories.length + '</span>'
      + '</div>'
      + '<div class="category-list">' + categoryHtml + '</div>'
      + '</section>'
      + '<section class="section">'
      + '<div class="section-header">'
      + '<div>'
      + '<h2 class="section-title">' + escapeHtml(state.selectedCategoryName || '分类主题流') + '</h2>'
      + '<div class="section-subtitle">你也可以把这里扩展成“收藏分类”或“常逛版块”。</div>'
      + '</div>'
      + '<span class="badge">' + state.categoryTopics.length + '</span>'
      + '</div>'
      + '<div class="topic-list">' + categoryTopicsHtml + '</div>'
      + '</section>'
      + '<section class="section">'
      + '<div class="section-header">'
      + '<div>'
      + '<h2 class="section-title">帖子详情</h2>'
      + '<div class="section-subtitle">当前主题 ID：' + escapeHtml(activeTopicId ? String(activeTopicId) : '未选择') + '</div>'
      + '</div>'
      + (activeTopicId
        ? '<button class="ghost" data-open-url="' + encodeAttr(buildTopicUrl(activeTopicId, undefined, activeTopic?.slug)) + '">浏览器打开</button>'
        : '')
      + '</div>'
      + '<div class="topic-content">' + topicDetailHtml + '</div>'
      + '</section>'
      + '<div class="footer-tip">提示：Discourse 的不少高级能力仍然值得保留“打开原站”兜底，比如复杂编辑器、投票、某些插件页与管理页。要做到“尽可能全功能”，更现实的路径往往不是 100% 重写，而是 80% 原生化 + 20% 原站回退。</div>';

    bindEvents();
  }

  function renderTopicCard(topic) {
    return '<article class="topic-card">'
      + '<div class="meta">'
      + '<span>#' + topic.id + '</span>'
      + (topic.posts_count ? '<span>帖子 ' + topic.posts_count + '</span>' : '')
      + (topic.views ? '<span>浏览 ' + topic.views + '</span>' : '')
      + (topic.last_posted_at ? '<span>活跃于 ' + escapeHtml(formatDate(topic.last_posted_at)) + '</span>' : '')
      + '</div>'
      + '<h3>' + escapeHtml(topic.title) + '</h3>'
      + (topic.excerpt ? '<div class="section-subtitle">' + escapeHtml(stripHtml(topic.excerpt)) + '</div>' : '')
      + '<div class="tag-row">'
      + (Array.isArray(topic.tags)
        ? topic.tags.map((tag) => '<span class="tag">' + escapeHtml(tag) + '</span>').join('')
        : '')
      + '</div>'
      + '<div class="toolbar">'
      + '<button class="primary" data-open-topic="' + topic.id + '">在插件中查看</button>'
      + '<button class="ghost" data-open-url="' + encodeAttr(buildTopicUrl(topic.id, undefined, topic.slug)) + '">浏览器打开</button>'
      + '</div>'
      + '</article>';
  }

  function renderTopicDetail(topic) {
    const posts = topic.post_stream?.posts || [];
    const replyBox = state.connection.capabilities.canReply
      ? '<div class="reply-box">'
        + '<textarea id="reply-input" placeholder="写点什么？支持 Markdown。"></textarea>'
        + '<div class="toolbar">'
        + '<button class="primary" data-submit-reply="' + topic.id + '">回复主题</button>'
        + '</div>'
        + '</div>'
      : '<div class="empty">当前还没有可回复的登录会话。你可以点击上面的“使用 Linux DO Connect 登录”，或手动配置其它连接方式。</div>';

    const postsHtml = posts.length
      ? posts.map((post) => '<article class="post-card">'
          + '<div class="meta">'
          + '<span>#' + post.post_number + '</span>'
          + '<span>@' + escapeHtml(post.username) + '</span>'
          + (post.created_at ? '<span>' + escapeHtml(formatDate(post.created_at)) + '</span>' : '')
          + (post.reply_to_post_number ? '<span>回复 #' + post.reply_to_post_number + '</span>' : '')
          + '</div>'
          + '<h3>' + escapeHtml(post.name || post.username) + '</h3>'
          + '<div class="post-body">' + (post.cooked || '<div class="empty">该楼层暂无渲染内容。</div>') + '</div>'
          + '<div class="toolbar">'
          + '<button class="ghost" data-open-url="' + encodeAttr(buildTopicUrl(topic.id, post.post_number, topic.slug)) + '">打开该楼层</button>'
          + (state.connection.capabilities.canReply
            ? '<button class="secondary" data-reply-to="' + post.post_number + '" data-topic-id="' + topic.id + '">回复这层</button>'
            : '')
          + '</div>'
          + '</article>').join('')
      : '<div class="empty">当前主题没有加载到楼层内容。</div>';

    return '<article class="topic-card">'
      + '<h3>' + escapeHtml(topic.fancy_title || topic.title) + '</h3>'
      + '<div class="meta">'
      + (topic.views ? '<span>浏览 ' + topic.views + '</span>' : '')
      + (topic.posts_count ? '<span>帖子 ' + topic.posts_count + '</span>' : '')
      + (topic.created_at ? '<span>创建于 ' + escapeHtml(formatDate(topic.created_at)) + '</span>' : '')
      + '</div>'
      + '</article>'
      + postsHtml
      + replyBox;
  }

  function bindEvents() {
    document.querySelectorAll('[data-action="refresh"]').forEach((element) => {
      element.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    });

    document.querySelectorAll('[data-action="configureConnection"]').forEach((element) => {
      element.addEventListener('click', () => vscode.postMessage({ type: 'configureConnection' }));
    });

    document.querySelectorAll('[data-action="browserLoginAndImportSession"]').forEach((element) => {
      element.addEventListener('click', () => vscode.postMessage({ type: 'browserLoginAndImportSession' }));
    });

    document.querySelectorAll('[data-action="loginWithBrowser"]').forEach((element) => {
      element.addEventListener('click', () => vscode.postMessage({ type: 'loginWithBrowser' }));
    });

    document.querySelectorAll('[data-action="loginWithCookie"]').forEach((element) => {
      element.addEventListener('click', () => vscode.postMessage({ type: 'loginWithCookie' }));
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
    if (authMode === 'cookie') {
      return 'Session Cookie';
    }
    if (authMode === 'userApiKey') {
      return 'User API Key';
    }
    if (authMode === 'oidc') {
      return 'Linux DO Connect';
    }
    return '匿名浏览';
  }

  function formatDate(value) {
    if (!value) {
      return '时间未知';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
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
} catch (error) {
  const app = document.getElementById('app');
  if (app) {
    const message = error && error.message ? error.message : String(error || '未知错误');
    app.innerHTML = '<section class="status-card"><div class="section-header"><div><h2 class="section-title">Webview 初始化错误</h2><div class="section-subtitle">脚本在启动阶段就失败了。</div></div></div><div class="error">' + String(message)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;') + '</div></section>';
  }
}
