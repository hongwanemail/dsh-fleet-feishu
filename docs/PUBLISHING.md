# 发布检查清单（PUBLISHING）—— 等宏万 GitHub 地址/包名到位后按序执行

> 状态：全部条目为"待用户输入项"或"到位后一键执行项"。在此之前仓库保持现状自用。

## A. 决策输入（等宏万）

| # | 项 | 当前默认提案 | 影响 |
|---|---|---|---|
| A1 | **开源包名**（npm 与 GitHub repo 同名） | `fleet-feishu`（备选 `dsh-fleet-feishu`、`xiaojingyu-fleet`） | ⚠️ 改名=全设备 profile 配置行 `- id:` / `name:` 同步迁移 + 已装设备重装；定了别改 |
| A2 | GitHub 仓库地址 | 待定（建议 org 下独立 repo，根目录即 dsh-plugin 内容） | README 链接、repository 字段 |
| A3 | LICENSE | MIT 草案已放，版权人=杨宏万 | 点头即生效 |
| A4 | npm 发布账号/是否发 npm | 发 npm 则 `dsh plugin add <包名>` 一步装；只发 GitHub 则 clone+add 目录两步 | 影响 README 快速开始的"30 秒"承诺 |

## B. 到位后执行序（我/笔记本 主 agent 做，每台 ≤2 分钟）

1. 建 GitHub repo（README 直接复用 dsh-plugin/README.md；LICENSE 去"DRAFT"字样）
2. package.json 发布字段：`repository.url`、`homepage`、`bugs` 填实际地址 + **删除 `"private": true`** 后方可 `npm publish`；keywords/author/engines/description 已就位
3. git 历史脱敏终审：`git log -p | grep -iE "sk-[a-z0-9-]{20,}|secret|app_secret"` 零命中（本地已多轮扫描干净，公开发布前再终审一次全历史）
4. 各设备迁移：`dsh plugin --profile <p> remove @local/fleet-feishu` → `add <新包名/新地址>` → profile 补丁行 id/name 改名 → fleet_status 验收
5. tag `v1.3.0`（首个公开发布版；代码即当前 办公机 实跑版本，含会话目录自愈）；Release 正文、B站简介、置顶评论**直接粘贴 docs/RELEASE-v1.3.0.md**（成品文案，仅 GitHub 链接一处待填）
6. Release 页挂：三说明书 PDF 可选、演示 GIF（用群内 RCPT/XDISK 真实录像段）

## C. B站视频素材清单（宏万出镜，我供弹药）

- 演示脚本可全程用真实群记录：入职报到 → `/status` → 路条派活 → 黑窗消失对比 → **结果自己出现在 DSH 窗口**（RCPT-03"注回成功"那一刻是高潮镜头）
- 设备矩阵镜头：笔记本 + 家里 PC + 云服务器服务器同群互 @
- 深度超限被秒拒、同任务重发无反应（证明"工程防失控"，不是提示词祈祷）

## D. 发布后运维

- issues 模板（附 fleet_status 输出脱敏要求）
- 版本号纪律：协议变更（路条/回执文法）必须 minor；坑修复 patch
- 全舰队 `send_identity: bot` 切换（笔记本 升齐后统一改配置，属行为变更，发 1.3.0）
