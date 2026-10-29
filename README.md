# CTF² One-Click Attachment Downloader / CTF² 一键下载题目附件

A Tampermonkey userscript for [CTF²](https://ctf2.dasctf.com) (DASCTF) practice challenges. Open a challenge, click one button, and it downloads every attachment into an organized local folder — plus auto-generates a `WP.md` writeup template and, for PWN targets that are running, an `exp.py` pre-filled with the live nc connection info.

一个用于 [CTF²](https://ctf2.dasctf.com)（DASCTF）练习题的油猴脚本。打开题目点一下按钮，即可把该题所有附件下载到按分类整理好的本地目录，并自动生成 `WP.md` 题解模板；若为 PWN 题且靶机已开启，还会生成已填好 nc 连接信息的 `exp.py`。

---

## ✨ Features / 功能

- **One-click download / 一键下载** — Grabs all attachments of the currently opened challenge.
- **Organized folders / 目录自动归类** — Files go to `<chosen dir>/<Category>/<Challenge>/<File>`.
- **No overwrite / 不覆盖旧内容** — If `<Challenge>` (or its subfolder in the `GM_download` fallback) already exists, a new folder `Challenge (1)`, `Challenge (2)`… is created instead of writing into the old one.
- **WP template / 题解模板** — Generates `WP.md` pre-filled with challenge name, source, category, difficulty and description.
- **PWN exp.py / PWN 脚本** — If the challenge is PWN and its target is running, generates `exp.py` with `HOST`/`PORT` (and `ssl=True` when needed) already filled in.
- **Uses your own session / 复用登录态** — Calls the site's own same-origin APIs with your existing JWT (`localStorage.token`). No anti-bot bypass, no scraping tricks.
- **Graceful fallbacks / 多级降级** — Directory picker → `GM_download` subfolders → flat download with filename prefix.

## 📦 Install / 安装

1. Install a userscript manager / 安装油猴类扩展：
   - [Tampermonkey](https://www.tampermonkey.net/) (Chrome / Edge / Firefox / Safari)
   - or the open-source [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) app on Safari
2. Create a new script and paste / import `ctf2-download.user.js`.
   新建脚本，粘贴或导入 `ctf2-download.user.js`。
3. Open a practice challenge on `ctf2.dasctf.com`, e.g.:
   `https://ctf2.dasctf.com/dashboard/practice/<practice-id>?challenge=<challenge-id>`
4. A floating panel appears at the bottom-right. / 右下角出现悬浮面板。

## 🚀 Usage / 使用

1. (Chrome/Edge only) Click **选择保存目录… / Choose folder…** and pick a folder once — it is remembered.
2. Open any challenge so the URL contains `challenge=<uuid>`.
3. Click **⬇ 下载当前题目附件 / Download this challenge**.
4. Options:
   - `同时生成 WP 模板（WP.md）` — generate the writeup template (default on).
   - `PWN 题自动填 exp.py（nc 连接）` — generate PWN exploit stub (default on).

Resulting layout (Chrome/Edge):

```
<chosen dir>/
└── PWN/
    └── rip/
        ├── pwn1
        ├── WP.md
        └── exp.py
```

## 🌐 Browser support / 浏览器支持

| Capability | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| Pick an arbitrary local directory | ✅ | ❌ | ❌ |
| Create sub-folders | ✅ | ✅ (`GM_download`) | ❌ |
| Authenticated API calls | ✅ | ✅ | ✅ |
| Generate `WP.md` / `exp.py` | ✅ | ✅ | ✅ |
| Batch auto-download | ✅ | ✅ | ⚠️ limited |

- **Chrome / Edge**: uses the File System Access API (`showDirectoryPicker`) to write into any folder you choose. If the challenge folder already exists, a new `Challenge (n)` folder is created instead of overwriting it.
- **Firefox**: no directory picker; downloads go to `Downloads/CTF2/<Category>/<Challenge>/` via `GM_download`. Re-downloading the same challenge uses `Challenge (n)` (tracked in `localStorage`), so older files are kept.
- **Safari**: no directory picker and no `GM_download`; files are downloaded flat with a `Category_Challenge_` filename prefix. Batch downloads may require allowing automatic downloads for the site.

---

- **Chrome / Edge**：用 File System Access API 写入你选的任意目录；若「题目名」目录已存在，会新建「题目名 (n)」目录，不覆盖之前下载的内容。
- **Firefox**：无目录选择，通过 `GM_download` 落到 `下载/CTF2/<分类>/<题目名>/`；同一题重复下载会改用「题目名 (n)」目录（按本地记录推断），旧文件保留。
- **Safari**：无目录选择、无 `GM_download`，文件平铺下载并以 `分类_题目名_` 作为文件名前缀；批量下载可能需要在站点设置里允许「自动下载」。

## 🔧 How it works / 原理

- Auth: the platform uses a JWT stored in `localStorage['token']`; every `/api/v1` request carries `Authorization: Bearer <token>`. The script reuses it (and honors `x-new-token` rotation).
- Challenge detail: `GET /api/v1/practice/{practiceId}/challenges/{challengeId}/`
- Target info (PWN): `GET /api/v1/practice/{practiceId}/challenges/{challengeId}/target/`
- Practice name (used as "source"): `GET /api/v1/practice/{practiceId}/`
- Attachment download: the file object's `download_url` (`/api/v1/practice/.../files/{id}/`), fetched as a blob with the same auth header.

## 📄 Files / 文件

- `ctf2-download.user.js` — the userscript / 脚本本体

## ⚠️ Notes / 说明

- Only works on pages you are already logged in to; it never bypasses authentication or anti-bot protections.
- The `/target/` response schema is aligned with the site's front-end source. If a PWN target isn't parsed, capture the `target` request response JSON and adjust the parser.
- Filenames are sanitized; duplicates within a challenge are overwritten by name.

## 📜 License / 许可

MIT
