import { test, expect } from "./fixture";

const USER = { phone: "13800000000", pass: "admin123" };

async function login(page) {
  await page.goto("/");
  await page.waitForSelector("#login-phone", { timeout: 10000 });
  await page.fill("#login-phone", USER.phone);
  await page.fill("#login-password", USER.pass);
  await page.click("#login-btn");
  await page.waitForSelector(".topbar", { timeout: 15000 });
}

async function sendChat(page, agent, message: string) {
  await page.fill("#chat-input", message);
  await page.click("#chat-send");
  await page.waitForTimeout(500);
  await agent.aiWaitFor("聊天区域出现了 AI 的最新回复（不是正在思考）", { timeout: 90000 });
  await page.waitForTimeout(300);
}

test("完整业务流程：对话驱动 → 管理后台验证", async ({ page, agentForPage }) => {
  await login(page);

  // ── 进入 AI 对话 ──
  await page.click('a[href="#chat"]');
  await page.waitForSelector("#chat-input", { timeout: 10000 });
  const agent = await agentForPage(page);

  // 选择公司上下文
  await page.selectOption("#chat-company-select", { index: 1 });
  await page.waitForTimeout(500);

  // ── 1. 录入财务 ──
  console.log("▶ 步骤1: 录入收入");
  await sendChat(page, agent, "帮我录入一笔收入，金额8000元，分类是技术服务费，备注是小程序开发服务");
  let reply = await agent.aiString("AI最新回复的核心内容（前40字）");
  console.log("  AI:", reply);

  console.log("▶ 步骤2: 录入支出");
  await sendChat(page, agent, "再录入一笔支出，金额1500元，分类是服务器费用，备注是3月份阿里云服务器");
  reply = await agent.aiString("AI最新回复的核心内容（前40字）");
  console.log("  AI:", reply);

  // ── 2. 添加客户 ──
  console.log("▶ 步骤3: 添加客户");
  await sendChat(page, agent, "帮我添加一个客户，名字叫王磊，电话15900001111，邮箱wanglei@test.com，公司是鹏程科技，商机金额50000元");
  reply = await agent.aiString("AI最新回复的核心内容（前40字）");
  console.log("  AI:", reply);

  // ── 3. 添加员工 ──
  console.log("▶ 步骤4: 添加员工");
  await sendChat(page, agent, "帮我添加一个员工，姓名李婷，职位UI设计师，月薪12000元");
  reply = await agent.aiString("AI最新回复的核心内容（前40字）");
  console.log("  AI:", reply);

  // ── 4. 创建项目 ──
  console.log("▶ 步骤5: 创建项目");
  await sendChat(page, agent, "帮我创建一个项目，名称是APP改版2.0，描述是移动端APP全面改版升级，预算30000元");
  reply = await agent.aiString("AI最新回复的核心内容（前40字）");
  console.log("  AI:", reply);

  // ── 5. 创建合同 ──
  console.log("▶ 步骤6: 创建合同");
  await sendChat(page, agent, "帮我创建一份合同，标题是技术开发合同，对方公司是鹏程科技，金额50000元");
  reply = await agent.aiString("AI最新回复的核心内容（前40字）");
  console.log("  AI:", reply);

  // ── 6. 创建发票 ──
  console.log("▶ 步骤7: 创建发票");
  await sendChat(page, agent, "帮我创建一张发票，客户是鹏程科技，金额50000元，税率6%");
  reply = await agent.aiString("AI最新回复的核心内容（前40字）");
  console.log("  AI:", reply);

  // ══════════ 切到管理后台验证 ══════════

  console.log("\n══ 切换到管理后台验证数据 ══");
  await page.click('a[href="#dashboard"]');
  await page.waitForSelector(".sidebar", { timeout: 10000 });
  await page.waitForTimeout(1000);

  // ── 验证公司详情 → 概览 ──
  await page.click('a[href="#companies"]');
  await page.waitForTimeout(1000);

  console.log("▶ 验证: 进入公司详情");
  await agent.aiAct("点击第一个公司名称进入详情");
  await agent.aiWaitFor("看到公司详情页面", { timeout: 10000 });
  await agent.aiAssert("概览 tab 显示了总收入、总支出、净利润的数据卡片");

  // 用 page.evaluate 切换 tab，避免 Midscene 点击 tab 失败
  const tabs = [
    { key: "finance", label: "财务", assert: "交易记录中包含技术服务费或服务器费用" },
    { key: "contacts", label: "客户", assert: "客户列表中有王磊或鹏程科技" },
    { key: "team", label: "团队", assert: "团队列表中有李婷或UI设计师" },
    { key: "projects", label: "项目", assert: "项目列表中有APP改版" },
    { key: "contracts", label: "合同", assert: "合同列表中有技术开发合同或鹏程科技" },
    { key: "staff", label: "AI员工", assert: "看到 AI 员工相关内容" },
    { key: "timeline", label: "时间线", assert: "看到时间线记录" },
  ];

  for (const tab of tabs) {
    console.log(`▶ 验证: ${tab.label} tab`);
    await page.evaluate((k) => (window as any).switchDetailTab(k), tab.key);
    await page.waitForTimeout(800);
    await agent.aiAssert(tab.assert);
    console.log(`  ✅ ${tab.label} 验证通过`);
  }

  console.log("\n✅ 公司详情各 tab 全部验证通过");

  // ── 返回管理后台验证其他页面 ──

  // OPB 画布
  console.log("▶ 验证: OPB 画布");
  await page.click('a[href="#canvas"]');
  await page.waitForTimeout(800);
  await page.selectOption("select", { index: 1 }).catch(() => {});
  await page.waitForTimeout(1000);
  await agent.aiAssert("看到 OPB 画布页面内容");

  // 商业罗盘
  console.log("▶ 验证: 商业罗盘");
  await page.click('a[href="#compass"]');
  await page.waitForTimeout(800);
  await page.selectOption("select", { index: 1 }).catch(() => {});
  await page.waitForTimeout(1000);
  await agent.aiAssert("看到商业罗盘或 5P 画像页面内容");

  // 财务总览
  console.log("▶ 验证: 财务总览");
  await page.click('a[href="#finance"]');
  await page.waitForTimeout(800);
  await agent.aiAssert("显示了总收入、总支出、净利润等数据");

  console.log("\n✅ OPB画布/商业罗盘/财务总览 验证通过");

  // ── Skills 管理 ──
  console.log("▶ 验证: 创建 Skill");
  await page.click('a[href="#skills"]');
  await page.waitForTimeout(1000);

  await page.evaluate(() => (window as any).showSkillCreateModal());
  await page.waitForSelector("#sk-name", { timeout: 5000 });

  await page.fill("#sk-name", "商业分析专家");
  await page.fill("#sk-desc", "深度分析公司商业模式和竞争策略");
  await page.fill("#sk-prompt", "你是一位商业分析专家，精通OPB画布和商业模式分析。当用户讨论商业策略时，请从客户层、价值层、运营层、战略层四个维度给出专业建议。");

  await page.evaluate(() => (window as any).saveSkill(null));
  await page.waitForTimeout(2000);
  await agent.aiAssert('Skills 列表中出现"商业分析专家"');

  console.log("\n✅ Skill 创建验证通过");

  // ── 回到对话用 Skill 干活 ──
  console.log("▶ 步骤8: 在对话中使用 Skill");
  await page.click('a[href="#chat"]');
  await page.waitForSelector("#chat-input", { timeout: 10000 });
  await page.waitForTimeout(500);

  await page.selectOption("#chat-company-select", { index: 1 });
  await page.waitForTimeout(300);

  await sendChat(page, agent, "请帮我用商业分析专家的视角，分析一下公司目前的经营数据和商业模式，给出改进建议");
  reply = await agent.aiString("AI回复中是否涉及商业分析、经营建议等内容（简要说明）");
  console.log("  AI（Skill验证）:", reply);

  console.log("\n🎉 全部业务流程测试完成！");
});
