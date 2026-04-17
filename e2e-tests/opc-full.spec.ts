import { test, expect } from "./fixture";

const EXISTING_USER = {
  phone: "13800000000",
  password: "admin123",
};

const NEW_USER = {
  name: "测试用户" + Date.now().toString().slice(-4),
  phone: "138" + Math.floor(10000000 + Math.random() * 90000000).toString(),
  password: "test123456",
};

async function login(page: any, agent: any, user = EXISTING_USER) {
  await page.goto("/");
  await agent.aiAct(`在手机号输入框输入"${user.phone}"`);
  await agent.aiAct(`在密码输入框输入"${user.password}"`);
  await agent.aiAct("点击登录按钮");
  await agent.aiWaitFor("顶部导航栏出现了用户名或进入了系统", {
    timeout: 15000,
  });
}

test.describe("星环OPC 全流程测试", () => {
  // ─── 1. 登录注册 ───────────────────────────────────────────────────

  test("01 - 登录页面正确渲染", async ({ page, agentForPage }) => {
    await page.goto("/");
    const agent = await agentForPage(page);

    await agent.aiAssert("页面左侧有 星环OPC 品牌标识和平台介绍");
    await agent.aiAssert('右侧有登录表单，包含"手机号"和"密码"输入框');
    await agent.aiAssert('有"登录"和"注册"两个标签页切换按钮');
  });

  test("02 - 注册新用户", async ({ page, agentForPage }) => {
    await page.goto("/");
    const agent = await agentForPage(page);

    await agent.aiAct("点击注册标签");
    await agent.aiAssert("出现了姓名输入框");

    await agent.aiAct(`在姓名输入框输入"${NEW_USER.name}"`);
    await agent.aiAct(`在手机号输入框输入"${NEW_USER.phone}"`);
    await agent.aiAct(`在密码输入框输入"${NEW_USER.password}"`);
    await agent.aiAct(`在确认密码输入框输入"${NEW_USER.password}"`);
    await agent.aiAct("点击创建账号按钮");

    await agent.aiWaitFor("页面跳转到了聊天界面或管理后台，顶部出现了导航栏", {
      timeout: 15000,
    });
    await agent.aiAssert('顶部有"AI 对话"和"管理后台"两个导航按钮');
    console.log("注册成功:", NEW_USER.name, NEW_USER.phone);
  });

  test("03 - 登录已有用户", async ({ page, agentForPage }) => {
    await page.goto("/");
    const agent = await agentForPage(page);
    await login(page, agent, EXISTING_USER);

    await agent.aiAssert('顶部有"AI 对话"和"管理后台"两个导航按钮');
    const userName = await agent.aiString("顶部右上角显示的用户名是什么");
    console.log("登录用户:", userName);
  });

  // ─── 2. 管理后台 ──────────────────────────────────────────────────

  test("04 - 仪表盘页面", async ({ page, agentForPage }) => {
    const agent = await agentForPage(page);
    await login(page, agent);

    await agent.aiAct('点击"管理后台"导航按钮');
    await agent.aiWaitFor("看到仪表盘页面", { timeout: 10000 });
    await agent.aiAssert("看到仪表盘标题");
    await agent.aiAssert("看到统计卡片，包含公司总数或收入支出等数据");
  });

  test("05 - 侧边栏菜单完整性", async ({ page, agentForPage }) => {
    const agent = await agentForPage(page);
    await login(page, agent);
    await agent.aiAct('点击"管理后台"导航按钮');
    await agent.aiWaitFor("看到仪表盘页面", { timeout: 10000 });

    const menuItems = await agent.aiQuery(
      "string[], 列出左侧边栏所有可见的菜单项文字"
    );
    console.log("侧边栏菜单:", menuItems);

    await agent.aiAssert("左侧边栏包含仪表盘菜单项");
    await agent.aiAssert("左侧边栏包含公司管理菜单项");
    await agent.aiAssert("左侧边栏包含 Skills 菜单项");
    await agent.aiAssert("左侧边栏包含系统设置菜单项");
  });

  // ─── 3. 各模块页面 ────────────────────────────────────────────────

  test("06 - 公司管理页面", async ({ page, agentForPage }) => {
    const agent = await agentForPage(page);
    await login(page, agent);
    await agent.aiAct('点击"管理后台"导航按钮');
    await agent.aiWaitFor("看到仪表盘", { timeout: 10000 });

    await agent.aiAct("点击左侧菜单中的公司管理");
    await agent.aiWaitFor("看到公司管理页面", { timeout: 10000 });
    await agent.aiAssert('页面上有"新建公司"按钮或公司列表');
  });

  test("07 - Skills 管理页面", async ({ page, agentForPage }) => {
    const agent = await agentForPage(page);
    await login(page, agent);
    await agent.aiAct('点击"管理后台"导航按钮');
    await agent.aiWaitFor("看到仪表盘", { timeout: 10000 });

    await agent.aiAct("点击左侧菜单中的 Skills");
    await agent.aiWaitFor("看到 Skills 管理页面", { timeout: 10000 });
    await agent.aiAssert('页面标题包含"Skills"');

    const skillCount = await agent.aiNumber("页面上显示了多少个 Skill 卡片");
    console.log("Skills 数量:", skillCount);
    expect(skillCount).toBeGreaterThanOrEqual(8);
  });

  test("08 - 系统设置页面", async ({ page, agentForPage }) => {
    const agent = await agentForPage(page);
    await login(page, agent);
    await agent.aiAct('点击"管理后台"导航按钮');
    await agent.aiWaitFor("看到仪表盘", { timeout: 10000 });

    await agent.aiAct("点击左侧菜单中的系统设置");
    await agent.aiWaitFor("看到系统设置页面", { timeout: 10000 });
    await agent.aiAssert("页面上有 AI 模型配置相关内容");
  });

  // ─── 4. AI 对话 ──────────────────────────────────────────────────

  test("09 - AI 对话界面", async ({ page, agentForPage }) => {
    const agent = await agentForPage(page);
    await login(page, agent);

    await agent.aiAct('点击"AI 对话"导航按钮');
    await agent.aiWaitFor("看到 AI 对话界面", { timeout: 10000 });
    await agent.aiAssert("左侧有对话列表区域");
    await agent.aiAssert("底部有消息输入框");
  });

  // ─── 5. 主题切换 ─────────────────────────────────────────────────

  test("10 - 深色/浅色主题切换", async ({ page, agentForPage }) => {
    const agent = await agentForPage(page);
    await login(page, agent);

    const initialTheme = await agent.aiString(
      "当前页面整体背景色是深色还是浅色？只回答深色或浅色"
    );
    console.log("初始主题:", initialTheme);

    await agent.aiAct("点击顶部导航栏的主题切换按钮（太阳或月亮图标）");
    await page.waitForTimeout(800);

    const newTheme = await agent.aiString(
      "当前页面整体背景色是深色还是浅色？只回答深色或浅色"
    );
    console.log("切换后主题:", newTheme);
    expect(newTheme).not.toBe(initialTheme);
  });
});
