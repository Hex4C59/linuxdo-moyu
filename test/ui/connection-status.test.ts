import { expect } from 'chai';
import { ActivityBar, EditorView, SideBarView, WebView, Workbench } from 'vscode-extension-tester';

async function openLinuxDoWebview(): Promise<WebView> {
  await new EditorView().closeAllEditors();

  const activityBar = new ActivityBar();
  const linuxDoControl = await activityBar.getViewControl('Linux.do');
  expect(linuxDoControl).to.not.equal(undefined);

  const sideBar = (await linuxDoControl?.openView()) as SideBarView;
  expect(sideBar).to.not.equal(undefined);

  const webview = new WebView();
  await webview.switchToFrame();
  return webview;
}

async function setScenario(scenario: string): Promise<void> {
  const workbench = new Workbench();
  await workbench.executeCommand(`linuxdo.__test.setScenario ${scenario}`);
}

describe('Linux.do Moyu 连接状态卡片测试', function () {
  this.timeout(120000);

  it('应显示匿名场景状态', async () => {
    await setScenario('anonymous');
    const webview = await openLinuxDoWebview();
    const source = await webview.getDriver().getPageSource();

    expect(source).to.contain('连接状态');
    expect(source).to.contain('匿名浏览');
    expect(source).to.contain('测试主题：AI 接管 VS Code 插件调试流程');

    await webview.switchBack();
  });

  it('应显示 Cookie 已连接场景状态', async () => {
    await setScenario('cookieConnected');
    const webview = await openLinuxDoWebview();
    const source = await webview.getDriver().getPageSource();

    expect(source).to.contain('Session Cookie');
    expect(source).to.contain('Hex4C59');
    expect(source).to.contain('可回复');
    expect(source).to.contain('测试通知：有人回复了你');

    await webview.switchBack();
  });

  it('应显示 429 限流错误场景', async () => {
    await setScenario('cookieRateLimited');
    const webview = await openLinuxDoWebview();
    const source = await webview.getDriver().getPageSource();

    expect(source).to.contain('请求过于频繁（HTTP 429）');
    expect(source).to.contain('Session Cookie');

    await webview.switchBack();
  });

  it('应显示可回复帖子详情场景', async () => {
    await setScenario('replyReady');
    const webview = await openLinuxDoWebview();
    const source = await webview.getDriver().getPageSource();

    expect(source).to.contain('帖子详情');
    expect(source).to.contain('回复主题');
    expect(source).to.contain('这是一条用于自动化测试的帖子内容');

    await webview.switchBack();
  });
});
