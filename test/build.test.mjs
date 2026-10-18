import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, enginesOf } from '../scripts/lib/build.mjs';
import { loadMarketIndexLib } from '../scripts/lib/market-index.mjs';

const INDEX_URL = 'https://example.test/market/index.json';
const SHA = (n) => n.toString(16).padStart(40, '0');

const META = {
  title: { en: 'Test market', zh: '测试市场' },
  metadata: {
    categories: { provider: { title: { en: 'Providers' } } },
    labels: { web: { title: { en: 'Web' } } },
    sortKeys: {},
  },
};

/**
 * 假 GitHub：repos = { 'o/r': { tags: [{ name, sha, manifest, files? }], dates: { sha: iso } } }
 * manifest 对应仓库根的 package.json；其他路径（含 <dir>/package.json）从 files 按路径取，对象会被 JSON 序列化。
 */
function fakeGitHub(repos) {
  return {
    async tags(repo) {
      return (repos[repo]?.tags ?? []).map((t) => ({ name: t.name, commit: { sha: t.sha } }));
    },
    async file(repo, path, ref) {
      const tag = repos[repo]?.tags.find((t) => t.name === ref);
      if (!tag) return undefined;
      if (path === 'package.json') return tag.manifest === undefined ? undefined : Buffer.from(JSON.stringify(tag.manifest));
      const file = tag.files?.[path];
      if (file === undefined) return undefined;
      return typeof file === 'string' || Buffer.isBuffer(file) ? Buffer.from(file) : Buffer.from(JSON.stringify(file));
    },
    async commitDate(repo, sha) {
      return repos[repo]?.dates?.[sha] ?? '2026-01-02T03:04:05Z';
    },
  };
}

const manifest = (version, extra = {}) => ({
  name: '@acme/dsh-thing',
  version,
  description: 'A thing',
  keywords: ['dsh-plugin'],
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  engines: { dsh: '>=0.2.1-rc.2 <0.3.0-0' },
  ...extra,
});

const lib = await loadMarketIndexLib();

async function build(repos, plugins = [{ repo: 'acme/thing', category: 'provider', labels: ['web'] }], meta = META) {
  const warnings = [];
  const result = await buildIndex({ plugins, meta, github: fakeGitHub(repos), lib, indexUrl: INDEX_URL, warn: (l) => warnings.push(l) });
  return { ...result, warnings };
}

test('正常收录：版本降序、source 带 40 位 commit、publishTimestamp 为秒', async () => {
  const { index, report } = await build({
    'acme/thing': {
      tags: [
        { name: 'v0.1.0', sha: SHA(1), manifest: manifest('0.1.0') },
        { name: 'v0.2.0', sha: SHA(2), manifest: manifest('0.2.0') },
        { name: 'not-a-version', sha: SHA(3), manifest: manifest('9.9.9') },
      ],
      dates: { [SHA(2)]: '2026-08-17T11:26:40Z' },
    },
  });
  assert.equal(index.format, 1);
  assert.equal(index.plugins.length, 1);
  const p = index.plugins[0];
  assert.equal(p.name, '@acme/dsh-thing');
  assert.deepEqual(p.versions.map((v) => v.version), ['0.2.0', '0.1.0']);
  assert.deepEqual(p.versions[0].source, { type: 'git', url: 'https://github.com/acme/thing.git', commit: SHA(2) });
  assert.equal(p.versions[0].publishTimestamp, Math.floor(Date.parse('2026-08-17T11:26:40Z') / 1000));
  assert.deepEqual(p.versions[0].engines, { dsh: '>=0.2.1-rc.2 <0.3.0-0' });
  assert.deepEqual(p.repository, { url: 'https://github.com/acme/thing.git' });
  assert.deepEqual(p.metadata, { category: 'provider', keywords: ['dsh-plugin'], labels: ['web'], sortKeys: {} });
  assert.deepEqual(p.description, { en: 'A thing', zh: 'A thing' });
  assert.deepEqual(report[0].included, ['0.2.0', '0.1.0']);
  assert.equal(lib.marketInstallTarget(p.name, p.versions[0]).spec, `git+https://github.com/acme/thing.git#${SHA(2)}`);
});

test('tag 版本不等于 package.json 版本被跳过并告警', async () => {
  const { index, report, warnings } = await build({
    'acme/thing': {
      tags: [
        { name: 'v0.1.0', sha: SHA(1), manifest: manifest('0.1.0') },
        { name: 'v0.1.1', sha: SHA(2), manifest: manifest('0.1.0') },
      ],
    },
  });
  assert.deepEqual(index.plugins[0].versions.map((v) => v.version), ['0.1.0']);
  assert.equal(report[0].skipped.length, 1);
  assert.match(report[0].skipped[0].reason, /与 tag 不一致/u);
  assert.ok(warnings.some((w) => w.includes('acme/thing@v0.1.1')));
});

test('没有 dsh.bundle 的 tag 被跳过', async () => {
  const { index, report } = await build({
    'acme/thing': {
      tags: [
        { name: 'v0.1.0', sha: SHA(1), manifest: manifest('0.1.0') },
        { name: 'v0.1.1', sha: SHA(2), manifest: manifest('0.1.1', { dsh: undefined }) },
      ],
    },
  });
  assert.deepEqual(index.plugins[0].versions.map((v) => v.version), ['0.1.0']);
  assert.match(report[0].skipped[0].reason, /dsh\.bundle/u);
});

test('缺 engines.dsh 时按 dsh peer 推导；都没有则跳过', async () => {
  assert.equal(
    enginesOf({ peerDependencies: { '@deepseek-ai/dsh-llm': '0.2.0-rc.2', '@deepseek-ai/dsh-tools': '0.2.0-rc.2', react: '18.3.1' } }),
    '0.2.0-rc.2',
  );
  assert.equal(
    enginesOf({ peerDependencies: { '@deepseek-ai/dsh-agent': '^0.1.6-alpha.2', '@deepseek-ai/dsh-session': '>=0.1.6' } }),
    '^0.1.6-alpha.2 >=0.1.6',
  );
  assert.equal(enginesOf({ peerDependencies: { react: '18.3.1' } }), undefined);
  const { index, report } = await build({
    'acme/thing': {
      tags: [
        { name: 'v0.1.0', sha: SHA(1), manifest: manifest('0.1.0', { engines: undefined, peerDependencies: { '@deepseek-ai/dsh-agent': '0.2.0-rc.2' } }) },
        { name: 'v0.1.1', sha: SHA(2), manifest: manifest('0.1.1', { engines: undefined }) },
      ],
    },
  });
  assert.deepEqual(index.plugins[0].versions.map((v) => [v.version, v.engines.dsh]), [['0.1.0', '0.2.0-rc.2']]);
  assert.match(report[0].skipped[0].reason, /既没有 engines\.dsh/u);
});

test('icon：相对路径转 data URL，超过 32 KiB 丢弃并告警，URL 原样', async () => {
  const small = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const repos = {
    'acme/thing': { tags: [{ name: 'v0.1.0', sha: SHA(1), manifest: manifest('0.1.0'), files: { 'icon.svg': small, 'big.png': Buffer.alloc(32 * 1024 + 1, 1) } }] },
  };
  const a = await build(repos, [{ repo: 'acme/thing', icon: 'icon.svg' }]);
  assert.equal(a.index.plugins[0].icon, `data:image/svg+xml;base64,${Buffer.from(small).toString('base64')}`);
  const b = await build(repos, [{ repo: 'acme/thing', icon: 'big.png' }]);
  assert.equal(b.index.plugins[0].icon, undefined);
  assert.ok(b.warnings.some((w) => w.includes('超过 32 KiB')));
  const c = await build(repos, [{ repo: 'acme/thing', icon: 'https://cdn.example/icon.png' }]);
  assert.equal(c.index.plugins[0].icon, 'https://cdn.example/icon.png');
});

test('category / label 未在 index.meta.json 声明时报错', async () => {
  const repos = { 'acme/thing': { tags: [{ name: 'v0.1.0', sha: SHA(1), manifest: manifest('0.1.0') }] } };
  await assert.rejects(build(repos, [{ repo: 'acme/thing', category: 'nope' }]), /category "nope" 没有在 index\.meta\.json 声明/u);
  await assert.rejects(build(repos, [{ repo: 'acme/thing', labels: ['nope'] }]), /label "nope" 没有在 index\.meta\.json 声明/u);
});

test('一个版本都收不进的仓库整条丢掉，索引仍通过校验', async () => {
  const { index, warnings } = await build({
    'acme/thing': { tags: [{ name: 'v0.1.0', sha: SHA(1), manifest: manifest('0.9.9') }] },
  });
  assert.deepEqual(index.plugins, []);
  assert.ok(warnings.some((w) => w.includes('整条插件跳过')));
});

test('plugins.json 的 title / description 覆盖 package.json；--repo 只跑一个仓库', async () => {
  const repos = {
    'acme/thing': { tags: [{ name: 'v0.1.0', sha: SHA(1), manifest: manifest('0.1.0') }] },
    'acme/other': { tags: [{ name: 'v1.0.0', sha: SHA(2), manifest: manifest('1.0.0', { name: '@acme/dsh-other' }) }] },
  };
  const plugins = [
    { repo: 'acme/thing', title: { en: 'Thing', zh: '东西' }, description: { en: 'D', zh: '描述' }, author: 'Acme' },
    { repo: 'acme/other' },
  ];
  const all = await buildIndex({ plugins, meta: META, github: fakeGitHub(repos), lib, indexUrl: INDEX_URL });
  assert.deepEqual(all.index.plugins.map((p) => p.name), ['@acme/dsh-thing', '@acme/dsh-other']);
  assert.deepEqual(all.index.plugins[0].title, { en: 'Thing', zh: '东西' });
  assert.deepEqual(all.index.plugins[0].description, { en: 'D', zh: '描述' });
  assert.equal(all.index.plugins[0].author, 'Acme');
  const one = await buildIndex({ plugins, meta: META, github: fakeGitHub(repos), lib, indexUrl: INDEX_URL, onlyRepo: 'acme/other' });
  assert.deepEqual(one.index.plugins.map((p) => p.name), ['@acme/dsh-other']);
});

// ---- 单仓多插件（plugins.json 的 dir 字段）----

const MONO = 'acme/mono';
const peer = (version, extra = {}) => manifest(version, { name: '@acme/dsh-peer', ...extra });
const other = (version, extra = {}) => manifest(version, { name: '@acme/dsh-other', ...extra });

test('T1 有 dir：只认 <dir>-v* tag，读 <dir>/package.json，source.path 与 repository.directory 正确', async () => {
  const repos = {
    [MONO]: {
      tags: [
        { name: 'dsh-peer-v0.1.0', sha: SHA(1), files: { 'packages/dsh-peer/package.json': peer('0.1.0') } },
        { name: 'dsh-peer-v0.2.0', sha: SHA(2), files: { 'packages/dsh-peer/package.json': peer('0.2.0') } },
        // 裸 v tag 与别的目录名的 tag 都静默忽略，即使里面也有 <dir>/package.json
        { name: 'v0.1.0', sha: SHA(3), manifest: peer('0.1.0'), files: { 'packages/dsh-peer/package.json': peer('0.1.0') } },
        { name: 'dsh-peerx-v0.3.0', sha: SHA(4), files: { 'packages/dsh-peer/package.json': peer('0.3.0') } },
        // tag 与 <dir>/package.json 版本不一致仍跳过并告警
        { name: 'dsh-peer-v0.2.1', sha: SHA(5), files: { 'packages/dsh-peer/package.json': peer('0.2.0') } },
        // 只有根 package.json、子目录里没有的 tag 跳过
        { name: 'dsh-peer-v0.2.2', sha: SHA(6), manifest: peer('0.2.2') },
      ],
    },
  };
  const { index, report, warnings } = await build(repos, [{ repo: MONO, dir: 'packages/dsh-peer' }]);
  const p = index.plugins[0];
  assert.equal(p.name, '@acme/dsh-peer');
  assert.deepEqual(p.versions.map((v) => v.version), ['0.2.0', '0.1.0']);
  assert.deepEqual(p.versions[0].source, { type: 'git', url: 'https://github.com/acme/mono.git', commit: SHA(2), path: 'packages/dsh-peer' });
  assert.deepEqual(p.repository, { url: 'https://github.com/acme/mono.git', directory: 'packages/dsh-peer' });
  assert.equal(
    lib.marketInstallTarget(p.name, p.versions[0]).spec,
    `git+https://github.com/acme/mono.git#${SHA(2)}&path:/packages/dsh-peer`,
  );
  assert.equal(report[0].dir, 'packages/dsh-peer');
  assert.deepEqual(report[0].skipped.map((s) => s.tag), ['dsh-peer-v0.2.1', 'dsh-peer-v0.2.2']);
  assert.match(report[0].skipped[0].reason, /与 tag 不一致/u);
  assert.match(report[0].skipped[1].reason, /没有 packages\/dsh-peer\/package\.json/u);
  assert.ok(!warnings.some((w) => w.includes('@v0.1.0') || w.includes('dsh-peerx')));
});

test('T1b 有 dir 的 icon 先找 <dir>/<icon>，找不到回落仓库根并告警', async () => {
  const inDir = '<svg id="dir"/>';
  const atRoot = '<svg id="root"/>';
  const repos = {
    [MONO]: {
      tags: [{ name: 'dsh-peer-v0.1.0', sha: SHA(1), files: { 'dsh-peer/package.json': peer('0.1.0'), 'dsh-peer/icon.svg': inDir, 'icon.svg': atRoot, 'root.svg': atRoot } }],
    },
  };
  const a = await build(repos, [{ repo: MONO, dir: 'dsh-peer', icon: 'icon.svg' }]);
  assert.equal(a.index.plugins[0].icon, `data:image/svg+xml;base64,${Buffer.from(inDir).toString('base64')}`);
  assert.deepEqual(a.warnings, []);
  const b = await build(repos, [{ repo: MONO, dir: 'dsh-peer', icon: 'root.svg' }]);
  assert.equal(b.index.plugins[0].icon, `data:image/svg+xml;base64,${Buffer.from(atRoot).toString('base64')}`);
  assert.ok(b.warnings.some((w) => w.includes('回落')));
});

test('T2 同一仓库两条不同 dir 各收各的 tag；dir 相同或都无 dir 报错', async () => {
  const repos = {
    [MONO]: {
      tags: [
        { name: 'dsh-peer-v0.1.0', sha: SHA(1), files: { 'dsh-peer/package.json': peer('0.1.0') } },
        { name: 'dsh-other-v1.0.0', sha: SHA(2), files: { 'dsh-other/package.json': other('1.0.0') } },
        { name: 'dsh-other-v1.1.0', sha: SHA(3), files: { 'dsh-other/package.json': other('1.1.0') } },
      ],
    },
  };
  const { index, report } = await build(repos, [{ repo: MONO, dir: 'dsh-peer' }, { repo: MONO, dir: 'dsh-other' }]);
  assert.deepEqual(index.plugins.map((p) => [p.name, p.versions.map((v) => v.version)]), [
    ['@acme/dsh-peer', ['0.1.0']],
    ['@acme/dsh-other', ['1.1.0', '1.0.0']],
  ]);
  assert.deepEqual(index.plugins[1].versions[0].source.path, 'dsh-other');
  assert.deepEqual(report.map((r) => [r.dir, r.skipped.length]), [['dsh-peer', 0], ['dsh-other', 0]]);
  // onlyRepo 按 repo 过滤，同仓两条都保留
  const only = await buildIndex({ plugins: [{ repo: MONO, dir: 'dsh-peer' }, { repo: MONO, dir: 'dsh-other' }], meta: META, github: fakeGitHub(repos), lib, indexUrl: INDEX_URL, onlyRepo: MONO });
  assert.equal(only.index.plugins.length, 2);
  await assert.rejects(build(repos, [{ repo: MONO, dir: 'dsh-peer' }, { repo: MONO, dir: 'dsh-peer' }]), /acme\/mono 的目录 dsh-peer 重复/u);
  await assert.rejects(build(repos, [{ repo: MONO }, { repo: MONO }]), /仓库 acme\/mono 重复/u);
  // 同仓一条无 dir、一条有 dir 允许
  await build(repos, [{ repo: MONO }, { repo: MONO, dir: 'dsh-peer' }]);
});

test('T3 非法 dir 报错，信息带 repo 与 dir', async () => {
  const repos = { [MONO]: { tags: [] } };
  for (const dir of ['..', 'a/../b', '.', '/abs', 'trail/', '', 'a//b', 'a\\b', 3]) {
    await assert.rejects(build(repos, [{ repo: MONO, dir }]), (error) => {
      assert.ok(error.message.includes('acme/mono'), error.message);
      assert.ok(error.message.includes(JSON.stringify(dir)), error.message);
      return true;
    }, `dir ${JSON.stringify(dir)} 应报错`);
  }
});

test('T4 没有 dir 的条目输出与改前一致：source 无 path、repository 无 directory、键序不变', async () => {
  const { index, report } = await build({
    'acme/thing': {
      tags: [
        { name: 'v0.1.0', sha: SHA(1), manifest: manifest('0.1.0') },
        // 无 dir 时 <名>-v* 形状的 tag 不认
        { name: 'thing-v0.2.0', sha: SHA(2), manifest: manifest('0.2.0') },
      ],
    },
  });
  const p = index.plugins[0];
  assert.deepEqual(p.versions.map((v) => v.version), ['0.1.0']);
  const source = p.versions[0].source;
  assert.equal('path' in source, false);
  assert.equal('directory' in p.repository, false);
  assert.equal('dir' in report[0], false);
  assert.equal(JSON.stringify(source), `{"type":"git","url":"https://github.com/acme/thing.git","commit":"${SHA(1)}"}`);
  assert.equal(JSON.stringify(p.repository), '{"url":"https://github.com/acme/thing.git"}');
  assert.deepEqual(Object.keys(p), ['name', 'description', 'repository', 'metadata', 'versions']);
  assert.deepEqual(Object.keys(p.versions[0]), ['version', 'publishTimestamp', 'source', 'engines']);
});

test('T5 混合有 / 无 dir 的整份索引通过 parseMarketIndex', async () => {
  const repos = {
    'acme/thing': { tags: [{ name: 'v0.1.0', sha: SHA(1), manifest: manifest('0.1.0') }] },
    [MONO]: {
      tags: [
        { name: 'dsh-peer-v0.1.0', sha: SHA(2), files: { 'plugins/dsh-peer/package.json': peer('0.1.0') } },
        { name: 'dsh-other-v1.0.0', sha: SHA(3), files: { 'dsh-other/package.json': other('1.0.0') } },
      ],
    },
  };
  const { index } = await build(repos, [
    { repo: 'acme/thing', category: 'provider', labels: ['web'] },
    { repo: MONO, dir: 'plugins/dsh-peer' },
    { repo: MONO, dir: 'dsh-other' },
  ]);
  assert.equal(index.plugins.length, 3);
  const parsed = lib.parseMarketIndex(JSON.parse(JSON.stringify(index)), INDEX_URL);
  assert.equal(parsed.plugins.length, 3);
});
