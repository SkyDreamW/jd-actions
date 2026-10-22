# 京东签到 (GitHub Actions)

零本地资源占用：不用装青龙面板，不用 NAS 常驻进程。脚本由 GitHub 免费提供的 Actions 云端按计划自动执行，跑完自动推送结果。

## 特点

- **本地零占用** — 不需要 Docker、不需要常驻面板
- **多账号** — 支持 `JD_COOKIE` / `JD_COOKIE2` / `JD_COOKIE3`（想加更多可自行在 `jd_sign.js` 和 workflow 里扩展）
- **多通道推送** — Server酱（微信）、Bark（iOS）
- **自动定时** — 每天北京时间 7:15 执行（错峰避开凌晨高峰），也可手动触发
- **脚本随上游更新** — 每次运行都从 `shufflewzc/faker2` 拉最新脚本，京东改接口时不用自己修

## 脚本来源

签到脚本不再自己维护，改为每天运行时克隆 [`shufflewzc/faker2`](https://github.com/shufflewzc/faker2) 并执行其中的日常脚本：

| 任务 | 脚本文件 |
|---|---|
| 天天领豆 | `jd_signbeanact_.js` |
| 打卡领豆 | `jd_daka_bean.js` |
| 升级赚京豆 | `jd_bean_home.js` |
| 种豆得豆 | `jd_plantBean.js` |
| 互动游戏赚豆 | `jd_hdyxzd.js` |
| 资产统计 | `jd_bean_change.js` |

> 早期版本用的是 NobyDa 的 `JD_DailyBonus.js`，那份脚本最后更新于 2021-09，京东接口早已下线，实测 28 项任务全部失败，已弃用。想增删任务，改 `jd_sign.js` 顶部的 `TASKS` 数组即可。

## 快速开始

### 1. 把仓库推到 GitHub

用你的 GitHub 账号新建一个仓库（Public/Private 都可以），把本目录内容推上去：

```bash
cd jd-actions
git init
git add .
git commit -m "init: jd sign"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

### 2. 配置 Secrets

到仓库 `Settings` → `Secrets and variables` → `Actions` → `New repository secret`，逐个添加：

| 变量名 | 必填 | 说明 |
|---|---|---|
| `JD_COOKIE` | ✅ | 京东账号 Cookie（注意是 `pt_key=xxx;pt_pin=yyy;` 格式） |
| `JD_COOKIE2` | 选填 | 第二个账号 |
| `JD_COOKIE3` | 选填 | 第三个账号 |
| `PUSH_KEY` | 选填 | Server酱 SendKey（微信推送） |
| `BARK_KEY` | 选填 | Bark 推送 key（iOS） |

> `PUSH_KEY`、`BARK_KEY` 至少要配一个，否则跑完没有通知，只能去 Actions 页面看日志。

### 3. 获取京东 Cookie

1. 用 Chrome 打开 https://bean.m.jd.com/ 并登录
2. F12 打开开发者工具 → `Network`（网络）面板
3. 刷新页面，随便点一个请求，找到 `Cookie` 请求头
4. 复制其中的 `pt_key=...;pt_pin=...;` 这一段（一般包含 `pt_key` 和 `pt_pin` 两个字段）

> Cookie 有效期约 **1 个月**，过期后签到会显示「Cookie 失效」，届时重新抓取并更新 Secrets 即可。

### 4. 配置推送

**Server酱（微信）：**
- 登录 https://sct.ftqq.com/ ，授权 GitHub，微信扫码绑定
- 找到「SendKey」，复制填入 `PUSH_KEY`

**Bark（iOS）：**
- App Store 安装 Bark，授权后拿到一个 URL，最后的 key 部分填入 `BARK_KEY`

### 5. 测试

进入仓库 `Actions` 页面 → 左侧选中 `JD Sign` → 点 `Run workflow` 手动触发一次。等 1-2 分钟看执行日志和推送结果。

## 说明

- 定时触发有几分钟延迟属正常；GitHub 免费额度每月 2000 分钟，签到每天跑几分钟，完全够用。
- 想改执行时间：编辑 `.github/workflows/jd.yml` 里的 `cron`，注意是 **UTC 时间**（北京时间 = UTC + 8 小时）。
- 领取的京豆数量不稳定，且部分接口限量，属于正常现象。
- **单任务失败不影响其他任务**：`jd_sign.js` 会逐个执行并汇总，只有全部失败才让 workflow 变红。每次运行的完整日志在 Actions 页面的 `sign-result` artifact 里。
- 推送是**汇总成一条**（子脚本自带的推送已屏蔽），标题形如 `京东日常 2026.10.22 (6/6)`；如果检测到 Cookie 失效，标题会多一个 `Cookie可能失效` 提示。
- **风险提示**：脚本通过逆向京东接口领京豆，有违反《京东用户协议》的可能，存在账号被风控的风险，请自行评估后使用。

## 默认执行时间参考

| 北京时间 | 对应 cron (UTC) |
|---|---|
| 每天 07:15 | `15 23 * * *` |

## 依赖

- Node.js 22（GitHub Actions 环境自动安装）
- faker2 脚本所需的 npm 包：`got@11`（必须 11.x，12+ 是纯 ESM）、`tough-cookie@4`、`https-proxy-agent`、`crypto-js`、`big-integer`、`axios`、`jsdom`、`dotenv`、`tunnel`、`global-agent`、`moment`
- 版本固定在 workflow 的「安装脚本依赖」步骤里，保证可复现
