# 配置向导设计（开源首次装机体验，v1.3 实现目标）

> 宏万要求：「每个电脑上安装插件，输入机器人的信息、群的信息，即可完成初始化——不能太复杂，这是开源给所有人用的插件。」

## 设计原则

人只做"必须人来做"的事（飞书后台建应用），其余全部机器自动。目标：装好 DSH + lark-cli 的
设备上，从打开插件设置页到群里报到 **≤3 分钟、≤5 次点击**。

## 三步向导（插件设置页形态，npm 包模式下 Config schema 驱动）

### 第 1 步：连应用（人需要的 3 分钟在这里）
- 输入 `App ID` + `App Secret`（存 credentials 服务，不落 cordis.yml/聊天记录）
- 旁边是给人类的图文清单（打开即见）：
  1. 去 open.feishu.cn 建企业自建应用（链接带 app_id 参数直达）
  2. 权限勾选清单（一键复制 scope 申请链接，v1.1 实测过的全集）：
     `im:message` `im:message:send_as_bot` `im:message.group_at_msg`（事件）
     `im:chat:readonly` `im:chat.members:read`（名册）
     事件订阅方式=**长连接**，添加 `im.message.receive_v1`，**发布版本**
  3. 把机器人加入目标群
- 点「测试连接」：校验 app 凭证 + bot 能否列群（顺便拿到 bot 自己的 open_id——`application info` 或群成员 self-match，去掉人肉填 ou_ 的坑）

### 第 2 步：选群（全自动）
- 列出本 bot 已加入的全部群（+chat-list --as bot），下拉选择
- 只有一个群 → 自动选中

### 第 3 步：定身份 + 探测（全自动，均可改）
- `device_name`：默认 `os.hostname()` 清洗后
- 自动探测并展示：lark-cli 入口（多平台路径 v1.2 已实现）/ dsh 入口 / headless 模型路由
  （读 profiles/headless 或列出可用 provider 让用户选一个默认模型，缺 key 时明确提示去哪拿）
- 点「完成」→ 写 Config + credentials → 插件自动重启 → 桥上线 → **自动在群里报到**：
  `[设备名] 报到，v1.x，模型=<route>，路条深度≤N`

## 技术前提（为什么 npm 包模式才能做）

- link 安装解析不到宿主内置包 → Config schema 缺失（v1.0 注释的坑）→ 设置页是裸 JSON。
- 正式 npm 包 + peerDependencies 后：Config 用 schema 声明 → 设置页表单 + 校验 + 本向导 UI。
- 向导 UI 本身 = Client 半一个 `settings.section` 页（槽位 live 实查存在）。

## 报错体验（开源插件的一半质量在报错）

| 失败点 | 引导 |
|---|---|
| scope 没申请/没发布版本 | 直接给带参数 scope-apply 链接 + "记得发布新版本" |
| user 身份没授权 | `lark-cli auth login` 命令原样可复制；说明：回执/名册兜底需要 |
| 机器人不在群里 | 提示拉群，附群名 |
| 双桥并存 | 启动时探测到 run.js worker/bridge.py 进程 → 状态页红字警告（v1.1.1 已顺手清理孤儿，但共存要喊出来） |

## 与 M4 一键安装的关系

向导覆盖"装了 lark-cli 的设备"。M4 完整一键 = `install 脚本（OS 识别 + node + lark-cli + dsh）
→ 打开 DSH 插件页 → 本向导`。开源发布顺序：v1.3 先向导，M4 脚本随后（脚本部分各平台差异大，
单独测试矩阵）。
