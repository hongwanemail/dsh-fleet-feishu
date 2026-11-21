# -*- coding: utf-8 -*-
"""生成 DSH 插件市场索引（format 1），严格按 @deepseek-ai/dsh-plugin-market-index 校验器的规则。

顶层结构（读校验器源码 parseMarketIndex 得到）：
    { format: 1, title: {en, zh-cn}, description: {en, zh-cn}, metadata: {...}, plugins: [...] }

plugin 结构（parse plugin()）：
    { name, title?, description?, icon?, author?, homepage?, repository?: {url, directory?},
      metadata: {...}, versions: [...] }

version 结构（parse marketVersion()）：
    { version(精确SemVer), publishTimestamp(Unix秒整数), source: {type:"git",url(https),commit(40位hex),path?},
      engines: {dsh: SemVerRange} }

language 对象：必须有 `en`；其余 key 小写（zh-cn）。
repository.directory：相对目录，不能是 "." 或含 . / ..（仓库根即包目录时直接省略）。
icon：相对路径按索引 URL 解析；解析后必须 https 或与索引同源。
"""
import io, json, os, subprocess, sys, datetime

REPO = r"D:\hongwans\dsh-fleet-feishu"
VAL = "C:/Users/hongw/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js"
OUT = "D:/hongwans/dsh-fleet-feishu/market-index.json"
INDEX_URL = "https://raw.githubusercontent.com/hongwanemail/dsh-fleet-feishu/master/market-index.json"

def run(cmd, cwd=None):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip()

commit = run(["git", "rev-parse", "HEAD"], REPO)
assert len(commit) == 40 and all(c in "0123456789abcdef" for c in commit), "commit \u4e0d\u662f 40 \u4f4d\u5c0f\u5199 hex"
pkg = json.load(io.open(os.path.join(REPO, "package.json"), encoding="utf-8"))
version = pkg["version"]
ts = int(run(["git", "show", "-s", "--format=%ct", commit], REPO))

index = {
    "format": 1,
    "title": {"en": "Hongwan Plugin Market", "zh-cn": "\u6768\u5b8f\u4e07\u7684\u63d2\u4ef6\u5e02\u573a"},
    "description": {
        "en": "Self-hosted DeepSeek Harness plugin market index.",
        "zh-cn": "DeepSeek Harness \u63d2\u4ef6\u5e02\u573a\u7d22\u5f15\uff08\u81ea\u5efa\uff09\u3002",
    },
    "metadata": {
        "title": {"en": "Hongwan Plugin Market", "zh-cn": "\u6768\u5b8f\u4e07\u7684\u63d2\u4ef6\u5e02\u573a"},
        "description": {
            "en": "Self-hosted DeepSeek Harness plugin market index.",
            "zh-cn": "DeepSeek Harness \u63d2\u4ef6\u5e02\u573a\u7d22\u5f15\uff08\u81ea\u5efa\uff09\u3002",
        },
    },
    "plugins": [
        {
            "name": "dsh-fleet-feishu",
            "title": {
                "en": "Fleet Feishu - multi-device agent orchestration",
                "zh-cn": "\u98de\u4e66\u98de\u6d3e \u00b7 \u591a\u8bbe\u5907 agent \u8c03\u5ea6",
            },
            "description": {
                "en": "Turn DSH into a teammate in your Feishu group: @ to dispatch, task-pass between agents, "
                      "receipts injected back into your session, ask/reply presence and memo board, group roster.",
                "zh-cn": "\u628a DeepSeek Harness \u53d8\u6210\u98de\u4e66\u7fa4\u91cc\u7684\u961f\u53cb\uff1a\u7fa4\u91cc @ \u5c31\u6d3e\u6d3b\u3001"
                         "\u673a\u5668\u4eba\u4e4b\u95f4\u5e26\u8def\u6761\u4e92\u76f8\u6d3e\u6d3b\u3001\u7ed3\u679c\u81ea\u52a8\u6ce8\u56de\u4f1a\u8bdd\u3001"
                         "\u95ee-\u7b54\u786e\u8ba4\u5728\u7ebf\u4e0e\u7559\u8a00\u677f\u3001\u7fa4\u540d\u518c\u4e0e @ \u6a21\u7cca\u5339\u914d\u3002",
            },
            "icon": "icon.svg",
            "author": "\u6768\u5b8f\u4e07 (yanghongwan)",
            "homepage": "https://github.com/hongwanemail/dsh-fleet-feishu#readme",
            "repository": {"url": "https://github.com/hongwanemail/dsh-fleet-feishu"},
            "metadata": {
                "title": {"en": "Fleet Feishu", "zh-cn": "\u98de\u4e66\u98de\u6d3e"},
                "description": {
                    "en": "Feishu group orchestration for DeepSeek Harness.",
                    "zh-cn": "DeepSeek Harness \u7684\u98de\u4e66\u7fa4\u7ec4\u534f\u8c03\u5ea6\u63d2\u4ef6\u3002",
                },
            },
            "versions": [
                {
                    "version": version,
                    "publishTimestamp": ts,
                    "source": {
                        "type": "git",
                        "url": "https://github.com/hongwanemail/dsh-fleet-feishu",
                        "commit": commit,
                    },
                    "engines": {"dsh": pkg["engines"]["dsh"]},
                }
            ],
        }
    ],
}

io.open(OUT, "w", encoding="utf-8", newline="\n").write(json.dumps(index, ensure_ascii=False, indent=2) + "\n")
print("  \u2705 \u5df2\u751f\u6210 market-index.json")
print("     version=%s  commit=%s  ts=%s" % (version, commit[:12], datetime.datetime.fromtimestamp(ts).isoformat()))

js = """import { parseMarketIndex, marketInstallTarget } from "file:///%s";
import { readFileSync } from "node:fs";
const doc = JSON.parse(readFileSync("%s", "utf8"));
try {
  const v = parseMarketIndex(doc, "%s");
  console.log("  \u2705 \u5b98\u65b9\u6821\u9a8c\u5668\u9a8c\u8bc1\u901a\u8fc7");
  const ver = v.plugins[0].versions[0];
  console.log("     title        = " + JSON.stringify(v.title));
  console.log("     plugins      = " + v.plugins.length);
  console.log("     version      = " + ver.version);
  console.log("     source.type  = " + ver.source.type);
  console.log("     commit       = " + ver.source.commit);
  console.log("     engines.dsh  = " + ver.engines.dsh);
  console.log("     icon         = " + (v.plugins[0].icon || "(none)"));
  console.log("     installSpec  = " + marketInstallTarget(v.plugins[0].name, ver.version).spec);
} catch (e) {
  console.log("  \u274c \u6821\u9a8c\u5931\u8d25: " + (e && e.message ? e.message : String(e)));
  if (e && e.path) console.log("     path=" + e.path);
  process.exit(1);
}
""" % (VAL, OUT, INDEX_URL)
tmp = os.path.join(os.environ["TEMP"], "vi3.mjs")
io.open(tmp, "w", encoding="utf-8", newline="\n").write(js)
r = subprocess.run(["node", tmp], capture_output=True, text=True, encoding="utf-8", errors="replace")
print(r.stdout.strip())
if r.stderr.strip():
    for ln in r.stderr.strip().split("\n")[:6]:
        print("     ! " + ln)
sys.exit(r.returncode)
