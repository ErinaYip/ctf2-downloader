// ==UserScript==
// @name         CTF² 一键下载题目附件
// @namespace    https://ctf2.dasctf.com/
// @version      1.5.0
// @description  在 CTF²(ctf2.dasctf.com) 练习页打开题目后，一键下载该题所有附件。Chrome/Edge 可选本地目录（File System Access API）；Firefox 退回默认下载目录的子文件夹。使用页面自带登录态，无需绕过反爬。
// @author       you
// @match        https://ctf2.dasctf.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      ctf2.dasctf.com
// @connect      dasctf.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const API = '/api/v1';
  const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
  const HAS_FS = typeof window.showDirectoryPicker === 'function';
  const HAS_GM_DOWNLOAD = typeof GM_download === 'function';

  /* ---------------- 鉴权：平台用 JWT，存在 localStorage['token'] ---------------- */
  function getToken() {
    try { return localStorage.getItem('token') || ''; } catch (e) { return ''; }
  }
  function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    const t = getToken();
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }
  function maybeRotateToken(headersLike) {
    // 后端可能通过响应头 x-new-token 轮换 token
    let nt = null;
    if (headersLike && typeof headersLike.get === 'function') nt = headersLike.get('x-new-token');
    else if (headersLike) nt = headersLike['x-new-token'] || headersLike['X-New-Token'];
    if (nt) { try { localStorage.setItem('token', nt); } catch (e) {} }
  }

  /* ---------------- IndexedDB：持久化目录句柄 ---------------- */
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('ctf2-downloader', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(k) {
    const db = await idb();
    return new Promise((res, rej) => {
      const g = db.transaction('kv', 'readonly').objectStore('kv').get(k);
      g.onsuccess = () => res(g.result);
      g.onerror = () => rej(g.error);
    });
  }
  async function idbSet(k, v) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, k);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  /* ---------------- 目录选择与权限（仅支持的浏览器） ---------------- */
  let dirHandle = null;

  async function restoreDir() {
    if (!HAS_FS) return;
    try { const h = await idbGet('dir'); if (h) dirHandle = h; } catch (e) {}
    updateDirLabel();
  }

  async function ensurePermission(handle, interactive) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (!interactive) return false;
    return (await handle.requestPermission(opts)) === 'granted';
  }

  async function pickDir() {
    if (!HAS_FS) { alert('当前浏览器不支持选择本地目录，将使用默认下载目录（可在其中建子文件夹）。'); return null; }
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await idbSet('dir', dirHandle);
      updateDirLabel();
      return dirHandle;
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      console.error(e); alert('选择目录失败：' + e); return null;
    }
  }

  /* ---------------- 从当前 URL 解析 id ---------------- */
  function getIds() {
    const m = location.pathname.match(/\/dashboard\/practice\/([0-9a-fA-F-]{36})/);
    const pid = m ? m[1] : null;
    const cid = new URLSearchParams(location.search).get('challenge');
    return { pid, cid: cid && UUID_RE.test(cid) ? cid : null };
  }

  /* ---------------- 拉取题目详情 & 附件 ---------------- */
  async function getChallengeDetail(pid, cid) {
    if (!getToken()) throw new Error('未找到登录 token，请先登录 CTF² 再试。');
    const resp = await fetch(`${API}/practice/${pid}/challenges/${cid}/`, {
      credentials: 'include',
      headers: authHeaders({ 'X-Skip-Global-Error-Message': 'true' }),
    });
    maybeRotateToken(resp.headers);
    if (resp.status === 401) throw new Error('登录状态失效（401），请刷新页面或重新登录。');
    if (!resp.ok) throw new Error(`获取题目详情失败 HTTP ${resp.status}`);
    let j = await resp.json();
    // 拆掉 {success, data} 包装
    if (j && typeof j === 'object' && 'success' in j) {
      if (!j.success) throw new Error('接口返回失败：' + (j.message ? JSON.stringify(j.message) : ''));
      return j.data;
    }
    return j;
  }

  // 取练习场名称（作为"来源"），失败返回空串
  async function getPracticeName(pid) {
    try {
      const r = await fetch(`${API}/practice/${pid}/`, {
        credentials: 'include',
        headers: authHeaders({ 'X-Skip-Global-Error-Message': 'true' }),
      });
      maybeRotateToken(r.headers);
      if (!r.ok) return '';
      let j = await r.json();
      if (j && typeof j === 'object' && 'success' in j) j = j.success ? j.data : null;
      if (!j) return '';
      return j.name || j.title || (j.practice && (j.practice.name || j.practice.title)) || '';
    } catch (e) { return ''; }
  }

  // 生成 WP 模板（Markdown）
  function buildWpTemplate(opts) {
    const { title, category, difficulty, source, description, attachments } = opts;
    const desc = (description || '').toString().trim() || '_（题目无描述）_';
    const atts = (attachments && attachments.length)
      ? attachments.map((n) => '- `' + n + '`').join('\n')
      : '_（无附件）_';
    return [
      '# ' + title,
      '',
      '- **题目**：' + title,
      '- **来源**：' + (source || '（未知）'),
      '- **方向**：' + (category || '-'),
      '- **难度**：' + (difficulty || '-'),
      '- **日期**：' + new Date().toISOString().slice(0, 10),
      '',
      '## 题目描述',
      '',
      desc,
      '',
      '## 附件',
      '',
      atts,
      '',
      '## 解题思路',
      '',
      '> 简要说明切入点和关键发现。',
      '',
      '## 解题步骤',
      '',
      '1. ',
      '',
      '## EXP / Payload',
      '',
      '```python\n# exp here\n```',
      '',
      '## FLAG',
      '',
      '```\nflag{}\n```',
      '',
      '## 总结与踩坑',
      '',
      '',
    ].join('\n');
  }

  /* ---------------- PWN 靶机信息 ---------------- */
  function isPwnCategory(cat) {
    return /pwn|pwning|binary/i.test(String(cat || ''));
  }

  async function getTarget(pid, cid) {
    if (!getToken()) return null;
    try {
      const r = await fetch(`${API}/practice/${pid}/challenges/${cid}/target/`, {
        credentials: 'include',
        headers: authHeaders({ 'X-Skip-Global-Error-Message': 'true' }),
      });
      maybeRotateToken(r.headers);
      if (!r.ok) return null;
      let j = await r.json();
      if (j && typeof j === 'object' && 'success' in j) j = j.success ? j.data : null;
      return j || null;
    } catch (e) { return null; }
  }

  // 把 target 拍平成若干个可观连接项
  function flattenTargets(t) {
    if (!t || typeof t !== 'object') return [];
    const out = [];
    const push = (obj) => {
      if (!obj) return;
      if (Array.isArray(obj.access_urls) && obj.access_urls.length) {
        obj.access_urls.forEach((a) => out.push({
          url: a.url, type: a.type || obj.access_type, nc_ssl: a.nc_ssl != null ? a.nc_ssl : obj.nc_ssl,
          ssh_host: a.ssh_host || obj.ssh_host, ssh_port: a.ssh_port || obj.ssh_port,
          ssh_username: a.ssh_username || obj.ssh_username, ssh_password: a.ssh_password || obj.ssh_password,
          status: obj.status,
        }));
      } else if (obj.access_url) {
        out.push({
          url: obj.access_url, type: obj.access_type, nc_ssl: obj.nc_ssl,
          ssh_host: obj.ssh_host, ssh_port: obj.ssh_port,
          ssh_username: obj.ssh_username, ssh_password: obj.ssh_password,
          status: obj.status,
        });
      }
    };
    push(t);
    (t.target_machine_records || []).forEach(push);
    return out;
  }

  function parseHostPort(url) {
    if (!url) return null;
    let s = String(url).trim();
    if (/^https?:\/\//i.test(s)) {
      try { const u = new URL(s); return { host: u.hostname, port: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80) }; }
      catch (e) { return null; }
    }
    s = s.replace(/^nc\s+/i, '').trim();
    if (/\s/.test(s)) { const p = s.split(/\s+/); return { host: p[0], port: parseInt(p[1], 10) || null }; }
    const m = s.match(/^(.+):(\d+)$/);
    if (m) return { host: m[1], port: parseInt(m[2], 10) };
    return null;
  }

  // 从靶机信息中挑出一个 nc/tcp 连接
  function pickNcTarget(t) {
    const eps = flattenTargets(t);
    const running = (e) => !e.status || String(e.status).toLowerCase() === 'running';
    const isNc = (e) => {
      const ty = String(e.type || '').toLowerCase();
      if (ty === 'http' || ty === 'web' || ty === 'ftp' || ty === 'rdp' || ty === 'vm') return false;
      if (ty === 'nc' || ty === 'tcp' || ty === 'tcp-plain' || ty === 'ssh') return true;
      return !/^https?:\/\//i.test(String(e.url || ''));
    };
    const cand = eps.filter((e) => e.url && running(e));
    return cand.find(isNc) || cand[0] || null;
  }

  function buildExpPy(opts) {
    const { title, category, host, port, ssl, ssh, attachments } = opts;
    const bin = (attachments && attachments[0]) || '';
    const header = [
      '#!/usr/bin/env python3',
      '# -*- coding: utf-8 -*-',
      '# 题目：' + title + '  (' + (category || 'PWN') + ')',
      '# 靶机：' + host + ':' + port + (ssl ? '  (SSL)' : ''),
    ];
    if (ssh && ssh.host) {
      header.push('# SSH ：' + ssh.user + '@' + ssh.host + ':' + ssh.port + (ssh.pass ? '  密码:' + ssh.pass : ''));
    }
    const body = [
      '',
      'from pwn import *',
      '',
      "context.log_level = 'debug'",
      "context.arch = 'amd64'",
      '',
      "HOST = '" + host + "'",
      'PORT = ' + port,
      '',
      ssl ? 'io = remote(HOST, PORT, ssl=True)' : 'io = remote(HOST, PORT)',
      bin ? "# elf = ELF('./" + bin + "')" : '# elf = ELF(\'./attachment\')',
      '',
      '# ---------------- exploit ----------------',
      '',
      '',
      '',
      'io.interactive()',
      '',
    ];
    return header.concat(body).join('\n');
  }

  function extractFiles(data) {
    const cand = [];
    const direct = [
      data && data.files,
      data && data.challenge && data.challenge.files,
      data && data.material && data.material.files,
      data && data.data && data.data.files,
    ];
    for (const arr of direct) if (Array.isArray(arr)) cand.push(...arr);

    if (cand.length === 0) {
      const seen = new Set();
      (function walk(o) {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if ((o.file_name || o.original_name) && (o.download_url || o.url || o.file_id || o.id)) {
          if (!seen.has(o)) { seen.add(o); cand.push(o); }
        }
        for (const k in o) if (o[k] && typeof o[k] === 'object') walk(o[k]);
      })(data);
    }
    const seen = new Set();
    return cand.filter((f) => {
      const key = f.file_id || f.id || f.download_url || f.url || Math.random();
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }

  function fileUrl(f, pid, cid) {
    let u = f.download_url || f.url || (f.file && (f.file.download_url || f.file.url));
    if (u) {
      if (/^https?:\/\//i.test(u)) return u;
      if (u.startsWith(API)) return u;
      if (u.startsWith('/api/')) return u;
      if (u.startsWith('/')) return API + u;
      return API + '/' + u.replace(/^\/+/, '');
    }
    const fid = f.file_id || f.id;
    if (fid) return `${API}/practice/${pid}/challenges/${cid}/files/${fid}/`;
    return null;
  }

  function fileName(f, idx) {
    return sanitize(f.file_name || f.original_name || f.name || `attachment_${idx + 1}`);
  }
  function sanitize(name) {
    return String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+$/, '_').slice(0, 200) || 'file';
  }

  /* ---------------- 下载 ---------------- */
  async function fetchBlob(url) {
    const sameOrigin = url.startsWith('/') || url.startsWith(location.origin);
    if (sameOrigin) {
      const isApi = url.startsWith(API) || url.startsWith('/api/');
      const r = await fetch(url, { credentials: 'include', headers: isApi ? authHeaders() : {} });
      maybeRotateToken(r.headers);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.blob();
    }
    return await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'blob',
        onload: (res) => (res.status >= 200 && res.status < 300) ? resolve(res.response) : reject(new Error(`HTTP ${res.status}`)),
        onerror: reject,
      });
    });
  }

  // Firefox/无 FS：用 GM_download 落到默认下载目录下的相对子路径
  function gmDownload(url, relPath) {
    return new Promise((resolve, reject) => {
      const isApi = url.startsWith(API) || url.startsWith('/api/');
      GM_download({
        url: url.startsWith('/') ? location.origin + url : url,
        name: relPath,
        saveAs: false,
        headers: isApi ? authHeaders() : undefined,
        onload: resolve,
        onerror: (e) => reject(new Error('GM_download 失败: ' + (e && e.error))),
        ontimeout: () => reject(new Error('GM_download 超时')),
      });
    });
  }

  function normCategory(detail) {
    let c = detail.category ||
      (detail.challenge && detail.challenge.category) ||
      (detail.data && detail.data.category) || 'other';
    if (c && typeof c === 'object') c = c.name || c.key || c.slug || c.value || 'other';
    c = String(c || 'other').trim();
    return c ? c.toUpperCase() : 'OTHER';
  }

  // 逐级创建子目录，返回最深层句柄
  async function getNestedDir(root, segs) {
    let d = root;
    for (const s of segs) d = await d.getDirectoryHandle(sanitize(s), { create: true });
    return d;
  }

  async function writeToDir(dirHandle_, name, blob) {
    const fh = await dirHandle_.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }

  function anchorDownload(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* ---------------- 主流程 ---------------- */
  let busy = false;
  let wpEnabled = true;
  let pwnExpEnabled = true;

  async function runDownload() {
    if (busy) return;
    const { pid, cid } = getIds();
    if (!pid) return setStatus('未在练习详情页，请先打开一个 practice。', 'warn');
    if (!cid) return setStatus('请先在题目列表中打开一道题（URL 需含 challenge=xx）。', 'warn');

    // 目录准备（仅支持的浏览器）
    if (HAS_FS && !dirHandle) {
      const h = await pickDir();
      if (!h) setStatus('未选择目录，将使用默认下载目录（建子文件夹）。', 'warn');
    }
    if (dirHandle) {
      const ok = await ensurePermission(dirHandle, true);
      if (!ok) { setStatus('目录写入权限被拒绝，改用默认下载目录。', 'warn'); dirHandle = null; }
    }

    busy = true;
    setStatus('正在获取题目信息…', 'info');
    try {
      const detail = await getChallengeDetail(pid, cid);
      const title = detail.name || detail.title || (detail.data && (detail.data.name || detail.data.title)) ||
        (detail.challenge && (detail.challenge.name || detail.challenge.title)) || 'challenge';
      const category = normCategory(detail);
      const difficulty = detail.difficulty || (detail.challenge && detail.challenge.difficulty) || '';
      const description = detail.description || detail.content ||
        (detail.challenge && (detail.challenge.description || detail.challenge.content)) || '';
      const files = extractFiles(detail);
      const attachmentNames = files.map((f, i) => fileName(f, i));
      if (!files.length && !wpEnabled) { setStatus('该题目没有附件。', 'warn'); busy = false; return; }

      // 目录层级：选定目录 / 题目方向(分类) / 题目名 / 附件名
      let targetDir = dirHandle;
      if (dirHandle) {
        try { targetDir = await getNestedDir(dirHandle, [category, title]); } catch (e) { targetDir = dirHandle; }
      }
      // Firefox 的 GM_download 相对子路径：CTF2/分类/题目名/
      const relPrefix = `CTF2/${sanitize(category)}/${sanitize(title)}/`;

      let ok = 0, fail = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const name = fileName(f, i);
        const url = fileUrl(f, pid, cid);
        setStatus(`(${i + 1}/${files.length}) 下载 ${name} …`, 'info');
        if (!url) { fail++; console.warn('无下载地址', f); continue; }
        try {
          if (targetDir) {
            const blob = await fetchBlob(url);
            await writeToDir(targetDir, name, blob);
          } else if (HAS_GM_DOWNLOAD) {
            await gmDownload(url, relPrefix + name);
          } else {
            const blob = await fetchBlob(url);
            anchorDownload(blob, name);
          }
          ok++;
        } catch (e) {
          fail++; console.error('下载失败', name, url, e);
        }
      }

      // 自动生成 WP 模板
      let wpDone = false;
      if (wpEnabled) {
        setStatus('生成 WP 模板…', 'info');
        try {
          const source = await getPracticeName(pid);
          const md = buildWpTemplate({ title, category, difficulty, source, description, attachments: attachmentNames });
          const wpName = 'WP.md';
          if (targetDir) {
            await writeToDir(targetDir, wpName, new Blob([md], { type: 'text/markdown;charset=utf-8' }));
            wpDone = true;
          } else if (HAS_GM_DOWNLOAD) {
            await gmDownload('data:text/markdown;charset=utf-8,' + encodeURIComponent(md), relPrefix + wpName);
            wpDone = true;
          } else {
            anchorDownload(new Blob([md], { type: 'text/markdown;charset=utf-8' }), wpName);
            wpDone = true;
          }
        } catch (e) {
          console.error('生成 WP 模板失败', e);
        }
      }

      // PWN 题 + 靶机已开启：自动生成 exp.py（写入 nc 信息）
      let expDone = false;
      if (pwnExpEnabled && isPwnCategory(category)) {
        setStatus('检查靶机信息…', 'info');
        try {
          const t = await getTarget(pid, cid);
          const chosen = pickNcTarget(t);
          if (chosen) {
            const hp = parseHostPort(chosen.url);
            if (hp && hp.host && hp.port) {
              const ssl = !!(chosen.nc_ssl) || /\.tcp-/.test(String(chosen.url));
              const ssh = (chosen.ssh_host && chosen.ssh_port)
                ? { host: chosen.ssh_host, port: chosen.ssh_port, user: chosen.ssh_username || 'root', pass: chosen.ssh_password || '' }
                : null;
              const py = buildExpPy({ title, category, host: hp.host, port: hp.port, ssl, ssh, attachments: attachmentNames });
              const expName = 'exp.py';
              if (targetDir) {
                await writeToDir(targetDir, expName, new Blob([py], { type: 'text/x-python;charset=utf-8' }));
                expDone = true;
              } else if (HAS_GM_DOWNLOAD) {
                await gmDownload('data:text/x-python;charset=utf-8,' + encodeURIComponent(py), relPrefix + expName);
                expDone = true;
              } else {
                anchorDownload(new Blob([py], { type: 'text/x-python;charset=utf-8' }), expName);
                expDone = true;
              }
            }
          }
        } catch (e) {
          console.error('生成 exp.py 失败', e);
        }
      }

      let where;
      if (dirHandle) where = `「${dirHandle.name}/${category}/${sanitize(title)}」`;
      else if (HAS_GM_DOWNLOAD) where = `默认下载目录下「${relPrefix}」`;
      else where = '默认下载目录';
      setStatus(`完成：成功 ${ok} 个${fail ? `，失败 ${fail} 个` : ''}${wpDone ? '，已生成 WP.md' : ''}${expDone ? '，已生成 exp.py（含靶机 nc）' : ''} → ${where}`, fail ? 'warn' : 'ok');
    } catch (e) {
      console.error(e);
      setStatus('出错：' + (e.message || e), 'err');
    } finally {
      busy = false;
    }
  }

  /* ---------------- 悬浮 UI ---------------- */
  let statusEl, dirLabelEl;

  function setStatus(msg, tone) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = tone === 'err' ? '#ff6b6b' : tone === 'warn' ? '#ffb84d' : tone === 'ok' ? '#4ade80' : '#cfe3ff';
  }
  function updateDirLabel() {
    if (!dirLabelEl) return;
    if (dirHandle) dirLabelEl.textContent = `目录：${dirHandle.name}`;
    else if (HAS_FS) dirLabelEl.textContent = '目录：默认下载目录';
    else dirLabelEl.textContent = '目录：默认下载目录（将建 CTF2/题目名 子文件夹）';
  }

  function buildUI() {
    const box = document.createElement('div');
    box.id = 'ctf2-dl-panel';
    box.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
      'background:rgba(20,24,34,.94)', 'color:#dbe7ff', 'border:1px solid #2a3b57',
      'border-radius:12px', 'padding:12px 14px', 'font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif',
      'box-shadow:0 8px 28px rgba(0,0,0,.45)', 'width:262px', 'user-select:none',
    ].join(';');

    box.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <strong style="font-size:13px;">CTF² 附件下载</strong>
        <span id="ctf2-dl-close" style="cursor:pointer;color:#8899b5;padding:0 4px;">✕</span>
      </div>
      <div id="ctf2-dl-dir" style="color:#9db2d6;margin-bottom:8px;font-size:12px;">目录：—</div>
      <button id="ctf2-dl-pick" style="width:100%;margin-bottom:8px;padding:7px;border-radius:8px;border:1px solid #33507a;background:#1b2740;color:#dbe7ff;cursor:pointer;">选择保存目录…</button>
      <button id="ctf2-dl-run" style="width:100%;padding:9px;border-radius:8px;border:none;background:linear-gradient(90deg,#2563eb,#3b82f6);color:#fff;font-weight:600;cursor:pointer;">⬇ 下载当前题目附件</button>
      <label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px;color:#9db2d6;cursor:pointer;">
        <input type="checkbox" id="ctf2-dl-wp" checked /> 同时生成 WP 模板（WP.md）
      </label>
      <label style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;color:#9db2d6;cursor:pointer;">
        <input type="checkbox" id="ctf2-dl-exp" checked /> PWN 题自动填 exp.py（nc 连接）
      </label>
      <div id="ctf2-dl-status" style="margin-top:8px;font-size:12px;min-height:16px;color:#cfe3ff;"></div>
      <div style="margin-top:6px;font-size:11px;color:#6f83a3;"></div>
    `;
    document.body.appendChild(box);

    statusEl = box.querySelector('#ctf2-dl-status');
    dirLabelEl = box.querySelector('#ctf2-dl-dir');

    const pickBtn = box.querySelector('#ctf2-dl-pick');
    if (!HAS_FS) {
      // Firefox 等不支持选择目录：隐藏按钮并给出说明
      pickBtn.style.display = 'none';
      box.querySelector('div[style*="font-size:11px"]').textContent =
        '当前浏览器不支持选目录，将保存到默认下载目录的 CTF2/题目名/ 下。';
    }

    pickBtn.addEventListener('click', () => { pickDir(); });
    box.querySelector('#ctf2-dl-run').addEventListener('click', runDownload);
    const wpChk = box.querySelector('#ctf2-dl-wp');
    if (wpChk) { wpChk.checked = wpEnabled; wpChk.addEventListener('change', () => { wpEnabled = wpChk.checked; }); }
    const expChk = box.querySelector('#ctf2-dl-exp');
    if (expChk) { expChk.checked = pwnExpEnabled; expChk.addEventListener('change', () => { pwnExpEnabled = expChk.checked; }); }
    box.querySelector('#ctf2-dl-close').addEventListener('click', () => box.remove());
    updateDirLabel();
  }

  /* ---------------- 启动 ---------------- */
  async function init() {
    await restoreDir();
    buildUI();
    window.addEventListener('popstate', updateDirLabel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
