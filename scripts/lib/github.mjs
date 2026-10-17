// GitHub REST 的最小客户端：只用 fetch，不依赖 gh。
// 有 GITHUB_TOKEN 就带 Bearer，没有就匿名（匿名限额每小时 60 次，生成一次索引大约用 2 + 2×tag 数）。

const API = 'https://api.github.com';

/**
 * @param {{ token?: string, fetch?: typeof fetch, apiBase?: string }} [options]
 */
export function createGitHub(options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const apiBase = options.apiBase ?? API;
  const token = options.token;

  async function request(path, { params = {}, accept = 'application/vnd.github+json' } = {}) {
    const url = new URL(path.startsWith('http') ? path : `${apiBase}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const headers = {
      accept,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-plugin-market-index-builder',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await doFetch(url, { headers, redirect: 'follow' });
    if (!response.ok) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      const hint = remaining === '0' ? '（GitHub API 限额用尽，设置 GITHUB_TOKEN 可提高限额）' : '';
      throw new Error(`GitHub API ${response.status} ${url.pathname}${hint}`);
    }
    return response;
  }

  async function json(path, options) {
    return (await request(path, options)).json();
  }

  /** 翻页读取 /repos/<repo>/tags，返回 [{ name, commit: { sha } }]。 */
  async function tags(repo) {
    const out = [];
    let next = `${apiBase}/repos/${repo}/tags?per_page=100`;
    while (next) {
      const response = await request(next);
      out.push(...(await response.json()));
      next = nextLink(response.headers.get('link'));
    }
    return out;
  }

  /** 读仓库里某个 ref 下的文件，返回 Buffer；不存在返回 undefined。 */
  async function file(repo, path, ref) {
    const url = new URL(`${apiBase}/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`);
    url.searchParams.set('ref', ref);
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-plugin-market-index-builder',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await doFetch(url, { headers, redirect: 'follow' });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub API ${response.status} ${url.pathname}`);
    const body = await response.json();
    if (body.encoding !== 'base64' || typeof body.content !== 'string') {
      throw new Error(`GitHub contents API 对 ${repo}:${path}@${ref} 没有返回 base64 内容`);
    }
    return Buffer.from(body.content, 'base64');
  }

  /** 读某个提交的提交时间（committer.date，ISO 字符串）。 */
  async function commitDate(repo, sha) {
    const body = await json(`/repos/${repo}/commits/${sha}`);
    const date = body?.commit?.committer?.date ?? body?.commit?.author?.date;
    if (typeof date !== 'string') throw new Error(`GitHub commits API 对 ${repo}@${sha} 没有返回提交时间`);
    return date;
  }

  return { tags, file, commitDate };
}

function nextLink(header) {
  if (!header) return undefined;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (m) return m[1];
  }
  return undefined;
}
