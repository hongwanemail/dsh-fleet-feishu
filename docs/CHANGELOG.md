# 更新日志（CHANGELOG）

## v1.3.0（首个公开发布版候选，办公机 实跑验证中）
- **会话目录自愈（重大）**：headless `--session-id` 强制目录一致（REG-03 实抓），桥从 "recorded in" 错误自学路径、重试一次并持久化——升级不断历史（REG-04 实测 8 秒续上旧会话）；新增 `headless_workspace`/`headless_profile` 显式配置（默认零行为变更）
- **协议对称性实网达成**：真实 bot 流量双向互派闭环实测（REV-01/01B，办公机⇄QingLvServer，2026-11-14 22:16 日志铁证）——路条受理、bot 身份回执、mention 视角归一，双向全通
- **深度2 实网放行**（REV-02"深度二收妥"）+ **异构版本混跑验证**：v1.1.1 的 user 身份回执被 v1.2 收据机制正确捕获——匹配只认 reply_to+前缀，与身份无关
- 协议学补充：飞书原始 API `sender_type=app` ↔ 事件流归一化 `bot`（REV-01 交叉复核，已入 PRINCIPLES §6）
- 收据登记门槛 `shouldTrackReceipt`：群公告/无目标消息不再产生空收据（生产当场验证：战报消息零登记）；协议测试累计 33 项
- macOS node 解析三级阶梯：PATH → homebrew/usr-local/volta/nvm 显式候选 → Electron 兜底（spawn 补 `ELECTRON_RUN_AS_NODE=1`；起因：macOS GUI 进程 PATH 不含 Homebrew）
- POSIX 孤儿 worker 清理（`ps -ax`）+ lark/dsh 入口多平台探测
- **headless 工作目录三级确定性链**：`headless_workspace` 配置 > `DSH_WORKSPACE` > 家目录。起因两连：① macOS GUI 宿主继承 cwd 可能是 `/`；② REG-01 客户实网取证发现环境变量在传递链里可整体丢失（`cd` 继承只是 Windows 侥幸），故增加显式配置项——**老部署升级 v1.3+ 须把原工作目录写进 `headless_workspace`，否则会话桶搬家**
- SECURITY.md 安全政策 + GitHub issue 模板 + 异地 clone 可移植性实测（零依赖成立）；边界测试补至 33 项
- 全历史密钥扫描通过（发布预检项提前完成）
- 文档：USAGE / PRINCIPLES / DESIGN-SPEC / PUBLISHING / CHANGELOG，README，LICENSE(MIT 草案)

## v1.2.0（2026-11-14，双 Windows 机实跑）
- **回执身份归位**：回执/拦截 bot 应用身份优先，user 兜底；`send_identity`/`reply_identity`/`receipt_window_min` 可配
- **回执注回**：fleet_send 定向派活自动登记收据（消息→发起会话），对端**终态**结果经宿主 `sessionController` 注入发起会话——"派完不用盯群"。双样本实测（RCPT-02/03，含过程/终态区分）；交付时机=宿主回合边界（实测坐实）
- `/resume` 断点续作：超时终止且无结果的任务可同会话续跑
- **修复 v1.1 真 bug**：回执实际格式 `[设备名] [bot-reply]…`（署名在前），前缀闸 `startsWith` 空转——统一 `isBotReply` 容忍识别 + 回归测试锁死

## v1.1.1（2026-11-14）
- 黑窗修复：直驱 `bin/lark-cli.exe` 本体（run.js 启动器 fork worker 自带新控制台），run.js 仅作老安装回退

## v1.1.0（2026-11-14）
- **路条硬闸**：`[任务ID|发起人|派发深度N]` 协议工程化——bot 无路条拒收并回格式说明、深度>上限一律拒绝（不进模型）、同任务 ID 回环静默丢弃（tasks.json 台账 500 条）
- 群内指令 `/new /reset /status /roster`（仅 user、无路条时）
- 固定会话 `session_id`；群成员名册（roster.json + `fleet_roster` 工具 + 定时刷新 + 别名模糊 @）
- headless dotenv key 注入（`headless_env_file`；dsh headless 独立进程读不到桌面端 credentials）
- **发送通道修复**：lark-cli `@文件` 白名单在宿主 cwd 必挂 → 正文统一 `--text -` 走 stdin（v1.0 隐藏炸弹，实收第一条任务才暴露）
- 真机验收 T1/T2/T3 全过；30 项路由闸单测建立

## v1.0.0（2026-11-14）
- 进程内桥首发：收任务→`dsh headless` 执行→线程回执，路由三闸（顶层/前缀/mention）、直调 node 绕 cmd 竖线坑、consume 断线退避重启、孤儿 worker 清理、`[设备名]` 署名、fleet_status/fleet_send
- 零宿主内置包依赖原则确立（link 安装解析限制实测）

## 史前（M0-M2，python bridge.py 时代，2026-11-04 至 11-14）
- 笔记本 launchd + 办公机/客户计划任务三机打通：user 身份派活、reply 继承 mentions 自循环事故→顶层闸、GBK/BOM/HERMES_HOME/竖线 255 等 7 大 Windows 坑沉淀——全部移植进本插件
