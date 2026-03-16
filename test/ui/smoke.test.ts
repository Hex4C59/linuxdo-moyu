import { expect } from 'chai';
import { ActivityBar, EditorView, SideBarView, WebView } from 'vscode-extension-tester';

describe('Linux.do Moyu UI 冒烟测试', function () {
  this.timeout(120000);

  before(async () => {
    await new EditorView().closeAllEditors();
  });

  it('应能打开 Linux.do 视图并看到关键按钮', async () => {
    const activityBar = new ActivityBar();
    const linuxDoControl = await activityBar.getViewControl('Linux.do');
    expect(linuxDoControl).to.not.equal(undefined);

    const sideBar = (await linuxDoControl?.openView()) as SideBarView;
    expect(sideBar).to.not.equal(undefined);

    const content = new WebView();
    await content.switchToFrame();

    const pageSource = await content.getDriver().getPageSource();
    expect(pageSource).to.contain('Linux.do Moyu');
    expect(pageSource).to.contain('刷新');
    expect(pageSource).to.contain('浏览器登录并接管会话');

    await content.switchBack();
  });
});
