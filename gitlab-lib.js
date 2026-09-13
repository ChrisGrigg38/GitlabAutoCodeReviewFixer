'use strict';

/**
 * Shared helpers for talking to the GitLab API and parsing MR URLs.
 * Used by both extract-review-comments.js (script A) and
 * post-review-summary.js (script B).
 */

function parseMrUrl(url) {
  const clean = url.trim().replace(/[?#].*$/, '');
  const m = clean.match(/^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)\/?$/);
  if (!m) {
    throw new Error(
      `Could not parse GitLab MR URL: "${url}"\n` +
      `Expected something like https://gitlab.example.com/group/project/-/merge_requests/123`
    );
  }
  const [, host, projectPath, mrIid] = m;
  return { host, projectPath, mrIid };
}

class GitLabClient {
  constructor(host, token) {
    this.base = `https://${host}/api/v4`;
    this.token = token;
  }

  async request(pathname, { params = {}, method = 'GET', body = undefined } = {}) {
    const url = new URL(this.base + pathname);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    const headers = { 'PRIVATE-TOKEN': this.token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const respBody = await res.text().catch(() => '');
      throw new Error(`GitLab API ${res.status} ${res.statusText} for ${method} ${url}\n${respBody}`);
    }
    return res;
  }

  async getJson(pathname, params = {}) {
    const res = await this.request(pathname, { params });
    return res.json();
  }

  async postJson(pathname, body, params = {}) {
    const res = await this.request(pathname, { method: 'POST', body, params });
    return res.json();
  }

  async putJson(pathname, params = {}) {
    const res = await this.request(pathname, { method: 'PUT', params });
    return res.json();
  }

  // Follows GitLab's page-based pagination until there's no next page.
  async getAllPages(pathname, params = {}) {
    let page = 1;
    const perPage = 100;
    const all = [];
    for (;;) {
      const res = await this.request(pathname, { params: { ...params, page, per_page: perPage } });
      const batch = await res.json();
      all.push(...batch);
      const nextPage = res.headers.get('x-next-page');
      if (!nextPage) break;
      page = Number(nextPage);
    }
    return all;
  }

  async getRawFile(projectId, filePath, ref) {
    const encodedPath = encodeURIComponent(filePath);
    try {
      const res = await this.request(`/projects/${projectId}/repository/files/${encodedPath}/raw`, {
        params: { ref },
      });
      return res.text();
    } catch {
      return null; // file may not exist at that ref (renamed/deleted)
    }
  }

  async getProject(projectPath) {
    return this.getJson(`/projects/${encodeURIComponent(projectPath)}`);
  }

  async getMergeRequest(projectId, mrIid) {
    return this.getJson(`/projects/${projectId}/merge_requests/${mrIid}`);
  }

  async getDiscussions(projectId, mrIid) {
    return this.getAllPages(`/projects/${projectId}/merge_requests/${mrIid}/discussions`);
  }

  async getDiscussion(projectId, mrIid, discussionId) {
    return this.getJson(`/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}`);
  }

  async addDiscussionNote(projectId, mrIid, discussionId, body) {
    return this.postJson(
      `/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}/notes`,
      { body }
    );
  }

  async resolveDiscussion(projectId, mrIid, discussionId, resolved = true) {
    return this.putJson(`/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}`, {
      resolved,
    });
  }
}

// Marker embedded (as an HTML comment, invisible when rendered) in every
// reply script B posts, so re-running it never double-posts.
const AUTO_REPLY_MARKER = '<!-- automated-review-reply:v1 -->';

module.exports = { parseMrUrl, GitLabClient, AUTO_REPLY_MARKER };
