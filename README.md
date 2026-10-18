# dsh-plugin-market · Lbryany 的 dsh 插件市场索引

索引 URL：**`https://lbryany.github.io/dsh-plugin-market/index.json`**

在 dsh web 里加这个索引源只要三步：

1. 打开左侧「发现」页；
2. 点「索引源」，粘贴上面的 URL，确定；
3. 回到发现页，卡片上点「安装」。安装结果按当前 dsh 版本的兼容性判定：`engines.dsh` 不覆盖当前运行时的版本会标「不兼容」，装不了。

索引是 [dsh 插件市场 format 1](https://www.npmjs.com/package/@deepseek-ai/dsh-plugin-market-index) 的 JSON，由 GitHub Actions 每天从收录仓库的 tag 自动生成并部署到 GitHub Pages；push `main` 或手动触发也会重新生成。

## 收录的插件

| 仓库 | 包名 | 说明 |
|---|---|---|
| [Lbryany/dsh-codebuddy](https://github.com/Lbryany/dsh-codebuddy) | `@lbryany/dsh-codebuddy` | CodeBuddy OAuth、动态模型目录、推理强度控制（Web 界面） |
| [Lbryany/dsh-herdr](https://github.com/Lbryany/dsh-herdr) | `@lbryany/dsh-herdr` | 会话生命周期状态同步到 Herdr（无界面） |

## 收录要求

一个插件仓库要能被索引收录，需要满足：

- **公开的 GitHub 仓库**。索引里的来源是 `git+https://github.com/<owner>/<repo>.git#<commit>`，私有仓库别人装不了。
- **`lib/` 等构建产物提交在仓库里**。从 git 安装不会跑构建（也不会跑 `prepare`），所以 tag 指向的提交必须自带可运行的产物；打 tag 之前先 `npm run check`。
- `package.json` 有 **`dsh.bundle`**（指向 `cordis.patch.yml`），这是 dsh 插件的标志；没有的 tag 会被跳过。
- `package.json` 有 **`engines.dsh`**，写成覆盖目标 dsh 版本的 SemVer 范围，例如 `>=0.2.1-rc.2 <0.3.0-0`（dsh 判定范围时带先行版，`<0.3.0` 会把 0.3.0-rc.x 也放进来，所以上界写 `<0.3.0-0`）。没有 `engines.dsh` 时，生成器按 dsh 自己的回落规则，把 `@deepseek-ai/dsh*` 的 `peerDependencies` 范围合成一个范围写进索引；两者都没有的 tag 跳过。
- **tag 名是 `v<版本>`**，并且该 tag 下 `package.json` 的 `version` 与之相等；不相等的 tag 会被跳过并在生成日志里告警。
- 可选：`plugins.json` 里给 `title` / `description`（中英文）、`author`、`icon`（仓库内 svg / png / jpg / webp 相对路径，解码后不超过 32 KiB，或一个 https URL）。

### 单仓多插件

一个仓库里可以放多个插件（每个插件一个子目录，例如 `Lbryany/dsh-plugins`），`plugins.json` 里每个插件一条，用可选字段 **`dir`** 指明子目录：

- `dir` 是相对仓库根的 POSIX 目录，如 `dsh-peer` 或 `packages/dsh-peer`；不能为空，不能以 `/` 开头或结尾，不能含 `.` / `..` 段。没有 `dir` 就是仓库根一个插件。
- **tag 名是 `<目录名>-v<版本>`**，目录名取 `dir` 的最后一段，例如 `dsh-peer-v0.1.0`。其他 tag（包括裸的 `v0.1.0` 和别的插件的 tag）对这一条静默忽略。
- 读的是 **`<dir>/package.json`**，`version` 要与 tag 里的版本相等；`dsh.bundle`、`engines.dsh` 等要求与上面相同。
- 索引里的版本来源会带上子目录（`source.path`，安装 spec 形如 `git+https://github.com/<owner>/<repo>.git#<commit>&path:/<dir>`），插件的 `repository.directory` 也是 `dir`。
- **构建产物入库同样适用于子目录**：`<dir>/lib/` 等必须提交在仓库里，从 git 安装不会跑构建。
- `icon` 相对路径先按 `<dir>/<icon>` 找，找不到回落仓库根（生成日志里会告警）。
- 同一仓库可以有多条，但 `repo` + `dir` 不能重复。

## 往索引里加一个插件

在 `plugins.json` 追加一条，`category` 与 `labels` 必须是 `index.meta.json` 里声明过的 id：

```json
{
  "repo": "Lbryany/dsh-example",
  "title": { "zh": "示例插件", "en": "Example plugin" },
  "description": { "zh": "一句话说明。", "en": "One line." },
  "author": "Lbryany",
  "category": "workflow",
  "labels": ["web"],
  "icon": "icon.svg"
}
```

单仓多插件的子目录插件多一个 `dir`，tag 打成 `dsh-peer-v0.1.0` 这样：

```json
{
  "repo": "Lbryany/dsh-plugins",
  "dir": "dsh-peer",
  "title": { "zh": "跨进程通信", "en": "Peer messaging" },
  "category": "workflow",
  "labels": ["headless"],
  "author": "Lbryany"
}
```

然后本地生成一次看看日志里有没有跳过与告警，提交后 Actions 会自动发布。

## 本地生成与校验

```sh
npm ci                                   # 装 @deepseek-ai/dsh-plugin-market-index（dsh 自己的索引校验器）与 semver
npm test                                 # 生成器单测（假的 GitHub 响应）
node scripts/build-index.mjs             # 生成 dist/index.json；GITHUB_TOKEN 可选，用来提高 API 限额
node scripts/build-index.mjs --repo Lbryany/dsh-herdr --dry-run   # 只跑一个仓库，打印不落盘
node scripts/check-index.mjs https://lbryany.github.io/dsh-plugin-market/index.json   # 线上自检：200、JSON、无重定向、校验通过
```

生成器只用 GitHub REST（`/repos/<r>/tags`、`/contents/package.json?ref=<tag>`（有 `dir` 时是 `/contents/<dir>/package.json`）、`/commits/<sha>`），不依赖 `gh`。没装依赖时校验器会回落到本机全局安装的 dsh（`npm root -g` 下）或 `DSH_INSTALL_DIR` 指向的目录。

## 目录

```
plugins.json              收录清单
index.meta.json           索引头：标题、分类、标签
scripts/build-index.mjs   生成器 CLI
scripts/check-index.mjs   线上自检
scripts/lib/              生成器核心（build.mjs）、GitHub 客户端（github.mjs）、校验器加载（market-index.mjs）
test/                     单测（node --test）
.github/workflows/pages.yml  生成 + 部署 Pages + 自检
```
