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

describe('Linux.do Moyu 命令交互测试', function () {
  this.timeout(120000);

  it('清除连接后应回到匿名场景', async () => {
    await setScenario('cookieConnected');
    const workbench = new Workbench();
    await workbench.executeCommand('linuxdo.clearConnection');

    const webview = await openLinuxDoWebview();
    const source = await webview.getDriver().getPageSource();

    expect(source).to.contain('匿名浏览');
    expect(source).to.not.contain('Hex4C59');

    await webview.switchBack();
  });

  it('刷新命令不应破坏测试场景状态', async () => {
    await setScenario('cookieRateLimited');
    const workbench = new Workbench();
    await workbench.executeCommand('linuxdo.refresh');

    const webview = await openLinuxDoWebview();
    const source = await webview.getDriver().getPageSource();

    expect(source).to.contain('Session Cookie');
    expect(source).to.not.contain('加载中');

    await webview.switchBack();
  });

  it('点击分类后应更新分类主题流', async () => {
    await setScenario('cookieConnected');
    const webview = await openLinuxDoWebview();

    const categoryButton = await webview.findWebElement({ xpath: '//*[@data-category-slug="dev-debug"]' });
    await categoryButton.click();

    const source = await webview.getDriver().getPageSource();
    expect(source).to.contain('测试分类主题：开发调试');
    expect(source).to.contain('开发调试');

    await webview.switchBack();
  });
});
