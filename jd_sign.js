// jd_sign.js - 京东日常任务编排器
//
// 【2026-10 变更说明】
// 旧实现：下载 NobyDa 的 JD_DailyBonus.js -> 注入 Cookie -> 执行。
// 问题：那份脚本最后一次提交是 2021-09-09，五年未更新，京东对应接口早已下线，
//       实测 28 项任务全部失败（大量 "需要手动执行" / "the current API does not exist"）。
// 现方案：改为执行 shufflewzc/faker2 里的日常脚本（仓库持续维护，脚本内部版本号 2026xxxx）。
//       仓库克隆与依赖安装由 .github/workflows/jd.yml 负责，本文件只做三件事：
//       顺序执行 -> 汇总输出 -> 推送一条消息。
//
// 子脚本自带的 sendNotify 推送会被屏蔽（PUSH_KEY 置空），避免一天收到七八条消息；
// 最终只由本脚本推送一条汇总。

const fs = require('fs')
const path = require('path')
const https = require('https')
const { execFile } = require('child_process')

// ---------------- 配置 ----------------
const JD_COOKIE = (process.env.JD_COOKIE || '').trim()
const PUSH_KEY = (process.env.PUSH_KEY || '').trim()
const BARK_KEY = (process.env.BARK_KEY || '').trim()

// faker2 脚本库所在目录（workflow 里 clone 到仓库根目录下的 faker2/）
const SCRIPT_DIR = process.env.JD_SCRIPT_DIR || path.join(__dirname, 'faker2')

const TASK_TIMEOUT = 5 * 60 * 1000 // 单个脚本最长 5 分钟
const RESULT_PATH = './result.txt'
const ERROR_PATH = './error.txt'

// 任务清单：按执行顺序排列。name 只用于展示，file 是 faker2 里的文件名。
const TASKS = [
  { name: '天天领豆', file: 'jd_signbeanact_.js' },
  { name: '打卡领豆', file: 'jd_daka_bean.js' },
  { name: '升级赚京豆', file: 'jd_bean_home.js' },
  { name: '种豆得豆', file: 'jd_plantBean.js' },
  { name: '互动游戏赚豆', file: 'jd_hdyxzd.js' },
  { name: '资产统计', file: 'jd_bean_change.js' },
]

// ---------------- 工具函数 ----------------
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

// 从脚本输出里挑出「有信息量」的行，避免把几千行日志塞进推送。
// 这些脚本的日志噪声很大（横幅、开始/结束、通知标题、原始 JSON），必须过滤掉。
const KEEP = /(成功|失败|获得|已领|领取|签到|京豆|钢镚|金贴|总计|资产|比昨日|收益|错误|异常|失效|无效|不足|已领取)/
const NOISE =
  /(开始发送通知|通知标题|系统通知|开始【|开始!|结束!|脚本执行时间|账号Cookie|^[=~*_-]{3,}|>{3,}|Tips[:：]|青龙|t\.me|版本[:：]|当前版本|injected env|^"\{|^\{\\n|Cookie 长度|签到用时)/
function pickHighlights(text, max = 12) {
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && s.length <= 160 && !NOISE.test(s))
  // 去掉连续重复行（资产统计这类脚本会重复打印同一句）
  const dedup = lines.filter((l, i) => i === 0 || l !== lines[i - 1])
  const hits = dedup.filter((l) => KEEP.test(l))
  if (hits.length) return hits.slice(0, max)
  const tail = dedup.slice(-2)
  return tail.length ? tail : ['（本次没有可提取的关键信息）']
}

// 有些脚本在 Cookie 失效时仍然 exit 0，只打印「CK已失效」，需要单独识别出来
const COOKIE_DEAD = /(CK已失效|cookie已失效|Cookie已失效|账号无效|请重新登录|登录已失效)/i
function looksLikeCookieDead(text) {
  return COOKIE_DEAD.test(stripAnsi(text))
}

function dateStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000) // 固定按北京时间
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}.${mm}.${dd}`
}

// 逐个执行脚本。注意：子进程的 PUSH_KEY / BARK_KEY 被清空，
// 这样脚本内部的 sendNotify 不会推送，推送统一由本文件在最后做一次。
function runTask(task) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let out = ''
    let settled = false
    const finish = (code, errMsg) => {
      if (settled) return
      settled = true
      resolve({
        name: task.name,
        file: task.file,
        code,
        errMsg,
        out,
        seconds: ((Date.now() - startedAt) / 1000).toFixed(1),
      })
    }

    const child = execFile(
      'node',
      [task.file],
      {
        cwd: SCRIPT_DIR,
        timeout: TASK_TIMEOUT,
        maxBuffer: 32 * 1024 * 1024,
        env: Object.assign({}, process.env, { JD_COOKIE, PUSH_KEY: '', BARK_KEY: '' }),
      },
      () => {},
    )

    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', (e) => finish(-1, e.message))
    child.on('close', (code) => finish(code, code === 0 ? '' : `退出码 ${code}`))
  })
}

// ---------------- 推送 ----------------
function pushServerChan(title, desp) {
  return new Promise((resolve) => {
    const url = `https://sctapi.ftqq.com/${PUSH_KEY}.send`
    const data = `title=${encodeURIComponent(title)}&desp=${encodeURIComponent(desp)}`
    const req = https.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => {
          try {
            const json = JSON.parse(body)
            if (json.code === 0) console.log('[Server酱] 推送成功')
            else console.log('[Server酱] 推送失败:', json.message || body)
          } catch {
            console.log('[Server酱] 推送响应:', body)
          }
          resolve()
        })
      },
    )
    req.on('error', (e) => {
      console.log('[Server酱] 推送异常:', e.message)
      resolve()
    })
    req.write(data)
    req.end()
  })
}

function pushBark(title, body) {
  return new Promise((resolve) => {
    const url = `https://api.day.app/${BARK_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`
    const req = https.get(url, (res) => {
      let data = ''
      res.on('data', (d) => (data += d))
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (json.code === 200) console.log('[Bark] 推送成功')
          else console.log('[Bark] 推送失败:', json.message || data)
        } catch {
          console.log('[Bark] 推送响应:', data)
        }
        resolve()
      })
    })
    req.on('error', (e) => {
      console.log('[Bark] 推送异常:', e.message)
      resolve()
    })
  })
}

async function pushNotification(title, body) {
  const tasks = []
  if (PUSH_KEY) tasks.push(pushServerChan(title, body))
  if (BARK_KEY) tasks.push(pushBark(title, body))
  if (tasks.length === 0) {
    console.log('未配置推送渠道（PUSH_KEY / BARK_KEY），跳过推送。')
    return
  }
  await Promise.all(tasks)
}

// ---------------- 主流程 ----------------
async function main() {
  if (!JD_COOKIE) {
    console.log('未配置 JD_COOKIE，请在 GitHub Secrets 中添加。')
    process.exit(1)
  }
  if (!fs.existsSync(SCRIPT_DIR)) {
    const msg = `找不到脚本目录 ${SCRIPT_DIR}，请确认 workflow 里的 clone 步骤是否执行成功。`
    console.log(msg)
    fs.writeFileSync(ERROR_PATH, msg, 'utf8')
    await pushNotification('京东日常 失败 ' + dateStr(), msg)
    process.exit(1)
  }

  const results = []
  for (const task of TASKS) {
    console.log(`>>> 执行 ${task.name} (${task.file}) ...`)
    const r = await runTask(task)
    const ok = r.code === 0
    console.log(`<<< ${task.name} ${ok ? '完成' : '失败'} 用时 ${r.seconds}s`)
    results.push(r)
    // 保留完整日志，方便在 artifact 里排查
    fs.appendFileSync(
      RESULT_PATH,
      `\n===== ${task.name} (${task.file}) ${ok ? 'OK' : 'FAIL'} ${r.seconds}s =====\n${stripAnsi(r.out)}\n`,
      'utf8',
    )
  }

  const okCount = results.filter((r) => r.code === 0).length
  const total = results.length
  const deadCookie = results.some((r) => looksLikeCookieDead(r.out))
  console.log(`完成: ${okCount}/${total} 个脚本正常退出${deadCookie ? '（检测到 Cookie 可能已失效）' : ''}`)

  // 汇总推送内容
  const lines = [`**${okCount}/${total} 个任务正常退出**`]
  if (deadCookie) lines.push('', '⚠️ **检测到 Cookie 可能已失效，建议重新抓取 pt_key 更新 Secret**')
  lines.push('')
  for (const r of results) {
    const ok = r.code === 0
    const flag = !ok ? '❌' : looksLikeCookieDead(r.out) ? '⚠️' : '✅'
    lines.push(`${flag} **${r.name}** ${r.seconds}s${r.errMsg ? ` — ${r.errMsg}` : ''}`)
    for (const h of pickHighlights(r.out, ok ? 6 : 4)) lines.push(`  - ${h}`)
    lines.push('')
  }
  const desp = lines.join('\n').trim()
  fs.appendFileSync(RESULT_PATH, `\n\n===== 汇总 =====\n${desp}\n`, 'utf8')

  const title = `京东日常 ${dateStr()} (${okCount}/${total})${deadCookie ? ' Cookie可能失效' : ''}`
  console.log('推送汇总...')
  await pushNotification(title, desp)
  console.log('DONE. result_size=' + Buffer.byteLength(desp))

  // 全部失败才算整体失败，部分失败仍然 exit 0，避免 artifact 上传被跳过
  if (okCount === 0) {
    fs.writeFileSync(ERROR_PATH, '所有脚本均失败，请查看 result.txt', 'utf8')
    process.exit(1)
  }
}

main().catch(async (err) => {
  console.log('任务失败:', err && err.message)
  fs.writeFileSync(ERROR_PATH, String((err && err.stack) || err), 'utf8')
  await pushNotification('京东日常 失败 ' + dateStr(), String(err && err.message))
  process.exit(1)
})
