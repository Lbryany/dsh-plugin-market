// 生成器核心：纯函数，GitHub 访问通过注入的 github 对象完成，便于单测用假响应。
//
// 规则（见 docs 规格 §3.2 与 E0 结论）：
// - 只看 v<semver> 形状的 tag；tag 里 package.json 的 version 必须等于 tag 去掉 v，否则跳过并告警；
// - package.json 必须有 dsh.bundle（否则不是 dsh 插件，跳过）；
// - engines.dsh 原样照搬；缺失时按 dsh 自己的回落规则从 @deepseek-ai/dsh* 的 peer 范围推导（去重后空格相连）；
//   既无 engines.dsh 也无 dsh peer 的 tag 跳过；
// - source 固定 git：url = https://github.com/<repo>.git，commit = tag 指向的 40 位 SHA；
// - publishTimestamp = 该提交的 committer.date，单位秒（索引格式要求 Unix 秒，不是毫秒）；
// - 一个仓库一个版本都收不进时整条插件丢掉（索引格式要求 versions 非空）。
//
// 单仓多插件（plugins.json 条目的可选 dir 字段，2026-10-19 第二步）：
// 1. dir 是相对仓库根的 POSIX 目录，须匹配 ^[\w.-]+(/[\w.-]+)*$，任一段不能是 . 或 ..，
//    不能为空串、不能以 / 开头或结尾；没有 dir = 仓库根一个插件（现状）。
// 2. 有 dir 时只认 <dir 最后一段>-v<semver> 形状的 tag（如 dsh-peer-v0.1.0）；没有 dir 仍只认 v<semver>。
//    不匹配的 tag 静默忽略（单仓里别的插件的 tag 对本条目就是"别的 tag"，裸 v0.1.0 也忽略）。
// 3. 有 dir 时读 <dir>/package.json，version 与 tag 的 semver 相等；其余校验照旧。
// 4. 有 dir 时版本 source 写 { type: 'git', url, commit, path: <dir> }，插件 repository 写 { url, directory: <dir> }；
//    dsh 的 marketInstallTarget 据此拼出 git+<url>#<commit>&path:/<dir>。没有 dir 时不出现这两个键，输出与改前字节一致。
// 5. plugins.json 唯一性是 repo + dir 不重复；同一仓库允许多条（不同 dir）。onlyRepo 照旧按 repo 过滤。
// 6. icon 相对路径：有 dir 时先找 <dir>/<icon>，找不到回落仓库根并告警一句。
// 7. 报告条目带 dir，CLI 打印成 <repo>/<dir>：收录 …

const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;
const SEMVER_TAIL = '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)';
const DIR = /^[\w.-]+(\/[\w.-]+)*$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const MIME = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export const MAX_ICON_BYTES = 32 * 1024;

/**
 * @param {object} input
 * @param {Array<{ repo: string, dir?: string, title?, description?, author?: string, category?: string, labels?: string[], icon?: string }>} input.plugins
 * @param {{ title, description?, metadata: { categories, labels, sortKeys } }} input.meta
 * @param {{ tags(repo), file(repo, path, ref), commitDate(repo, sha) }} input.github
 * @param {{ semver, parseMarketIndex }} input.lib
 * @param {string} input.indexUrl
 * @param {(line: string) => void} [input.warn]
 * @param {string} [input.onlyRepo]
 * @returns {Promise<{ index: object, report: Array<{ repo, dir?, included: string[], skipped: Array<{ tag, reason }> }> }>}
 */
export async function buildIndex({ plugins, meta, github, lib, indexUrl, warn = () => {}, onlyRepo }) {
  const { semver } = lib;
  validateMeta(meta);
  const declaredCategories = new Set(Object.keys(meta.metadata.categories));
  const declaredLabels = new Set(Object.keys(meta.metadata.labels));

  const out = [];
  const report = [];
  const seen = new Set();
  for (const entry of plugins) {
    if (typeof entry?.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/u.test(entry.repo)) {
      throw new Error(`plugins.json：repo 必须是 owner/name 形状，得到 ${JSON.stringify(entry?.repo)}`);
    }
    const dir = dirOf(entry);
    const key = `${entry.repo}\0${dir ?? ''}`;
    if (seen.has(key)) {
      throw new Error(dir === undefined ? `plugins.json：仓库 ${entry.repo} 重复` : `plugins.json：仓库 ${entry.repo} 的目录 ${dir} 重复`);
    }
    seen.add(key);
    if (onlyRepo && entry.repo !== onlyRepo) continue;
    if (entry.category !== undefined && !declaredCategories.has(entry.category)) {
      throw new Error(`plugins.json：${entry.repo} 的 category "${entry.category}" 没有在 index.meta.json 声明`);
    }
    for (const label of entry.labels ?? []) {
      if (!declaredLabels.has(label)) throw new Error(`plugins.json：${entry.repo} 的 label "${label}" 没有在 index.meta.json 声明`);
    }

    const { versions, manifests, tagNames, skipped } = await collectVersions(entry.repo, dir, github, semver, warn);
    const included = versions.map((v) => v.version);
    report.push({ repo: entry.repo, ...(dir === undefined ? {} : { dir }), included, skipped });
    if (versions.length === 0) {
      warn(`${labelOf(entry.repo, dir)}：没有可收录的版本，整条插件跳过`);
      continue;
    }
    const latest = manifests.get(versions[0].version);
    const plugin = await pluginEntry(entry, dir, latest, versions, tagNames.get(versions[0].version), github, warn);
    out.push(plugin);
  }

  const index = {
    format: 1,
    title: meta.title,
    ...(meta.description === undefined ? {} : { description: meta.description }),
    metadata: meta.metadata,
    plugins: out,
  };
  // 整份文档交 dsh 自己的校验器；不过就抛 MarketIndexError
  lib.parseMarketIndex(index, indexUrl);
  return { index, report };
}

function validateMeta(meta) {
  if (!meta || typeof meta !== 'object') throw new Error('index.meta.json 必须是对象');
  if (meta.title === undefined) throw new Error('index.meta.json 缺 title');
  const md = meta.metadata;
  if (!md || typeof md !== 'object') throw new Error('index.meta.json 缺 metadata');
  for (const key of ['categories', 'labels', 'sortKeys']) {
    if (!md[key] || typeof md[key] !== 'object') throw new Error(`index.meta.json 的 metadata.${key} 必须是对象`);
  }
}

/** 校验并返回条目的 dir；没有 dir 返回 undefined。 */
function dirOf(entry) {
  if (!('dir' in entry) || entry.dir === undefined) return undefined;
  const dir = entry.dir;
  const bad = typeof dir !== 'string' || !DIR.test(dir) || dir.split('/').some((s) => s === '.' || s === '..');
  if (bad) {
    throw new Error(`plugins.json：${entry.repo} 的 dir ${JSON.stringify(dir)} 不合法（须是相对仓库根的 POSIX 目录，不能为空、不能以 / 开头或结尾、不能含 . 或 .. 段）`);
  }
  return dir;
}

function labelOf(repo, dir) {
  return dir === undefined ? repo : `${repo}/${dir}`;
}

/** 有 dir 时 tag 形状是 <dir 最后一段>-v<semver>，没有 dir 是 v<semver>。 */
function tagPattern(dir) {
  if (dir === undefined) return TAG;
  const prefix = dir.split('/').pop().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${prefix}-v${SEMVER_TAIL}$`, 'u');
}

async function collectVersions(repo, dir, github, semver, warn) {
  const tags = await github.tags(repo);
  const pattern = tagPattern(dir);
  const manifestPath = dir === undefined ? 'package.json' : `${dir}/package.json`;
  const versions = [];
  const manifests = new Map();
  const tagNames = new Map();
  const skipped = [];
  const skip = (tag, reason) => {
    skipped.push({ tag, reason });
    warn(`${repo}@${tag}：跳过，${reason}`);
  };
  for (const tag of tags) {
    const m = pattern.exec(tag?.name ?? '');
    if (!m) continue; // 不是版本 tag，静默忽略
    const version = m[1];
    if (semver.valid(version) !== version) {
      skip(tag.name, `tag 不是规范的 SemVer`);
      continue;
    }
    const sha = tag?.commit?.sha;
    if (typeof sha !== 'string' || !COMMIT.test(sha)) {
      skip(tag.name, `tag 没有 40 位提交 SHA`);
      continue;
    }
    const raw = await github.file(repo, manifestPath, tag.name);
    if (raw === undefined) {
      skip(tag.name, `没有 ${manifestPath}`);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      skip(tag.name, `${manifestPath} 不是合法 JSON（${error.message}）`);
      continue;
    }
    if (manifest?.version !== version) {
      skip(tag.name, `package.json 的 version 是 ${JSON.stringify(manifest?.version)}，与 tag 不一致`);
      continue;
    }
    if (!manifest?.dsh?.bundle || typeof manifest.dsh.bundle !== 'object') {
      skip(tag.name, `package.json 没有 dsh.bundle，不是 dsh 插件`);
      continue;
    }
    const engines = enginesOf(manifest);
    if (engines === undefined) {
      skip(tag.name, `既没有 engines.dsh 也没有 @deepseek-ai/dsh* 的 peerDependencies`);
      continue;
    }
    if (semver.validRange(engines) === null || engines.startsWith('workspace:')) {
      skip(tag.name, `engines.dsh ${JSON.stringify(engines)} 不是合法 SemVer 范围`);
      continue;
    }
    if (manifests.has(version)) {
      skip(tag.name, `版本 ${version} 重复`);
      continue;
    }
    const date = await github.commitDate(repo, sha);
    const publishTimestamp = Math.floor(Date.parse(date) / 1000);
    if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0) {
      skip(tag.name, `提交时间 ${JSON.stringify(date)} 无法解析`);
      continue;
    }
    manifests.set(version, manifest);
    tagNames.set(version, tag.name);
    versions.push({
      version,
      publishTimestamp,
      source: { type: 'git', url: `https://github.com/${repo}.git`, commit: sha, ...(dir === undefined ? {} : { path: dir }) },
      engines: { dsh: engines },
    });
  }
  versions.sort((a, b) => semver.rcompare(a.version, b.version));
  return { versions, manifests, tagNames, skipped };
}

/** engines.dsh 原样；缺失时按 dsh 的回落规则从 dsh peer 推导；都没有返回 undefined。 */
export function enginesOf(manifest) {
  const dsh = manifest?.engines?.dsh;
  if (typeof dsh === 'string' && dsh.trim() !== '') return dsh.trim();
  const peers = manifest?.peerDependencies;
  if (!peers || typeof peers !== 'object') return undefined;
  const ranges = [];
  for (const [name, range] of Object.entries(peers)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
    if (typeof range !== 'string' || range.trim() === '') continue;
    const r = range.trim();
    if (!ranges.includes(r)) ranges.push(r);
  }
  if (ranges.length === 0) return undefined;
  return ranges.join(' ');
}

async function pluginEntry(entry, dir, latest, versions, ref, github, warn) {
  const name = latest.name;
  if (typeof name !== 'string' || name.trim() === '') throw new Error(`${entry.repo}：最新 tag 的 package.json 没有 name`);
  const title = localized(entry.title) ?? localized(latest.title);
  const description = localized(entry.description) ?? localized(latest.description);
  const author = authorOf(entry.author) ?? authorOf(latest.author);
  const homepage = typeof latest.homepage === 'string' && URL.canParse(latest.homepage) ? latest.homepage : undefined;
  const keywords = Array.isArray(latest.keywords) ? latest.keywords.filter((k) => typeof k === 'string') : [];
  const icon = await iconOf(entry, dir, github, ref, warn);
  return {
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(icon === undefined ? {} : { icon }),
    ...(author === undefined ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    repository: { url: `https://github.com/${entry.repo}.git`, ...(dir === undefined ? {} : { directory: dir }) },
    metadata: {
      ...(entry.category === undefined ? {} : { category: entry.category }),
      keywords,
      labels: entry.labels ?? [],
      sortKeys: {},
    },
    versions,
  };
}

/** 字符串当 en（zh 同文）；对象要有 en。 */
function localized(value) {
  if (typeof value === 'string') return value.trim() === '' ? undefined : { en: value, zh: value };
  if (value && typeof value === 'object' && typeof value.en === 'string') return value;
  return undefined;
}

function authorOf(author) {
  if (typeof author === 'string') return author.trim() === '' ? undefined : author;
  if (author && typeof author === 'object' && typeof author.name === 'string') return author.name;
  return undefined;
}

async function iconOf(entry, dir, github, ref, warn) {
  const icon = entry.icon;
  if (typeof icon !== 'string' || icon.trim() === '') return undefined;
  if (/^https?:\/\//u.test(icon) || icon.startsWith('data:')) return icon;
  const label = labelOf(entry.repo, dir);
  const ext = icon.split('.').pop()?.toLowerCase();
  const mime = MIME[ext];
  if (!mime) {
    warn(`${label}：icon ${icon} 不是 svg / png / jpg / webp，丢弃`);
    return undefined;
  }
  // 有 dir 时 icon 相对 <dir>；找不到再回落仓库根并告警
  let bytes;
  if (dir !== undefined) {
    bytes = await github.file(entry.repo, `${dir}/${icon}`, ref);
    if (bytes === undefined) {
      bytes = await github.file(entry.repo, icon, ref);
      if (bytes !== undefined) warn(`${label}：icon ${dir}/${icon} 在 ${ref} 不存在，回落用仓库根的 ${icon}`);
    }
  } else {
    bytes = await github.file(entry.repo, icon, ref);
  }
  if (bytes === undefined) {
    warn(`${label}：icon ${icon} 在 ${ref} 不存在，丢弃`);
    return undefined;
  }
  if (bytes.length > MAX_ICON_BYTES) {
    warn(`${label}：icon ${icon} 有 ${bytes.length} 字节，超过 32 KiB，丢弃`);
    return undefined;
  }
  return `data:${mime};base64,${bytes.toString('base64')}`;
}
