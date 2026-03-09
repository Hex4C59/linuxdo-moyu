# Linux.do Moyu

一个面向 VS Code 的 `Linux.do` / `Discourse` 论坛扩展原型，目标是在编辑器里完成“摸鱼浏览 + 快速回复 + 查看通知”的核心流程。

## 项目定位

这个项目不是要 100% 重写 Linux.do 原站，而是优先把高频链路做顺：

- 看最新帖子
- 进分类刷帖
- 打开主题详情与楼层
- 查看通知
- 快速回复
- 遇到复杂能力时一键回退到原站

对真实站点来说，这往往比“完全重做一个论坛客户端”更现实。

## 当前能力

- 最新帖子流（`/latest.json`）
- 分类列表与分类主题流
- 主题详情与楼层阅读
- 通过 Linux DO Connect 在系统浏览器中完成 OAuth / OIDC 登录并自动回到 VS Code
- 登录后查看通知（支持 `Linux DO Connect`、`User API Key` 或会话 Cookie）
- 登录后回复主题 / 指定楼层（Cookie 模式下会尝试自动获取 CSRF token）
- 一键跳转原站处理暂未覆盖的高级能力

## 当前状态说明

目前已经接入 Linux DO Connect 的登录流程，具体包括：

- 系统浏览器拉起授权页
- VS Code 扩展回调接收授权码
- 使用 `authorization_code + PKCE` 换取 token
- 拉取用户信息并保存到 VS Code Secret Storage

但仍有一个待验证点：

> Linux DO Connect 返回的 access token，是否可以直接访问 Linux.do 的论坛 JSON API。

这意味着：

- “登录并识别当前用户”这条链路已经具备实现基础
- “通知 / 回复 / 更完整的论坛能力”是否能直接使用 Connect token，还需要按 Linux.do 的实际网关策略验证

如果论坛接口暂不接受 Connect token，项目仍然可以退回：

- `User API Key`
- `Session Cookie`

两种方式继续完成论坛能力接入。

## 技术路线

为什么项目采用“原生浏览 + 原站回退”的混合路线？

1. Linux.do 基于 Discourse，很多公开数据确实可以通过 JSON API 获取。
2. 但登录、通知、回复等能力往往受站点授权模型和网关策略影响。
3. 某些复杂交互（富文本编辑、投票、插件页、管理页）更适合直接回退到原站。

所以当前版本更关注“高频可用”，而不是“全量重造”。

## 运行环境

- Node.js：推荐 `24`
- VS Code：`^1.95.0`
- 包管理器：`npm`
- 语言：TypeScript

## 快速开始

安装依赖：

```bash
npm install
```

编译：

```bash
npm run compile
```

调试扩展：

1. 用 VS Code 打开本仓库。
2. 按 `F5` 启动 `Extension Development Host`。
3. 在侧边栏打开 `Linux.do`。

## 连接论坛

当前支持三种连接方式。

### 1. Linux DO Connect（推荐）

适合正式接入 Linux DO Connect 的 OAuth2 / OIDC 流程。

流程如下：

1. 在扩展里点击“使用 Linux DO Connect 登录”。
2. 扩展会提示一个“回调地址”。
3. 到 `connect.linux.do` 的“应用接入”页面创建应用，并把这个回调地址填到“回调地址”（当前实现使用本地 HTTP 回环地址）。
4. 保存应用后拿到：
   - `Client ID`
   - `Client Secret`
5. 将两者填回扩展。
6. 扩展会打开系统默认浏览器完成授权，并自动跳回 VS Code。

#### Linux DO Connect 应用接入表单建议

如果你准备把这个插件发布到 GitHub，可以在 Linux DO Connect 页面这样填写：

- 应用名：`linuxdo-moyu`
- 应用主页：本仓库的 GitHub 地址
- 应用描述：`一个用于 VS Code 中浏览 Linux.do 的插件`
- 回调地址：以扩展弹出的值为准，形如 `http://127.0.0.1:14565/did-authenticate`
- 应用图标：可留空，后续再补
- 最低等级：先按你自己的测试需求选择

> 对插件来说，“应用主页”不一定是单独网站，也可以是 GitHub 仓库主页。

### 2. Session Cookie（手动）

适合已经在浏览器里登录 Linux.do，临时把会话复用到扩展中。

需要填写：

- 整段 Cookie（建议至少包含 `_t` / 会话相关字段）

### 3. User API Key（手动粘贴）

适合你已经拿到 Discourse `User API Key` 的情况。

需要填写：

- `User API Key`
- `Client ID`（可留空，扩展会自动生成）
- `Username`（可选，但建议填写）

> 所有连接信息都会保存到 VS Code Secret Storage，而不是写入仓库。

## 验证清单

- 点击“使用 Linux DO Connect 登录”后，会打开系统默认浏览器的授权页。
- 完成授权并跳回 VS Code 后，扩展能自动识别当前用户。
- 若 Linux.do 论坛接口接受 Connect access token，扩展能显示未读通知并允许回复。
- 若论坛接口尚不接受 Connect access token，可先退回 `User API Key` 或 `Session Cookie` 模式继续验证其余能力。
- 清除连接后，会话信息被移除，界面恢复匿名状态。

## 项目结构

```text
src/
  auth/
    browserAuthService.ts   # 当前承载 Linux DO Connect OIDC 登录流程
  connectionStore.ts        # 连接配置与 Secret Storage
  discourseClient.ts        # 论坛 API 请求封装
  discourseTypes.ts         # 类型定义与能力模型
  extension.ts              # VS Code 扩展入口与 Webview UI
media/
  icon.svg
.vscode/
  launch.json
  tasks.json
```

## 开发命令

```bash
npm install
npm run compile
```

如果你正在调试扩展，通常工作流是：

1. 修改 `src/**/*.ts`
2. 执行 `npm run compile`
3. 在扩展开发宿主窗口中刷新 / 重启调试

## 安全说明

- 不要把 `Client Secret`、Cookie、User API Key 提交到仓库。
- 不要把本地调试产生的敏感配置写进源码。
- 如需公开演示，建议使用测试账号或最小权限应用。

## 后续计划

- 自动探测 Linux DO Connect access token 是否可直接调用论坛接口
- 如果需要，补充 token 刷新逻辑
- 搜索、点赞、收藏、书签、已读状态同步
- 新建主题 / 编辑回复
- 更完整的通知与私信支持
- 更贴近原站的富文本体验
