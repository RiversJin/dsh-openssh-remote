# Publish Guide — dsh-openssh-remote

Current product: a **remote-work assistant** for DeepSeek Harness (multi-machine
SSH, remote workspace picker, 21 `rw_*` tools, conflict-aware SFTP sync, port
forwarding, optional sidebar editor). This is **not** the early “print SSH
tunnel commands” plugin.

## 1. Version and changelog

Bump `package.json` `version`, add a section to `CHANGELOG.md`, keep
`README.md` (Chinese, the repository front page) and `README.en.md` (English)
in sync (tool list, config table, Desktop notes). `README.zh.md` is a redirect
stub kept only for old external links — do not put content in it.

## 2. Checks

```bash
for f in lib/*.js; do node --check "$f"; done
node check.mjs
npm test
```

Optional: `scripts/boot-smoke.sh` if a desktop harness is installed.

## 3. Publish to npm

```bash
npm publish    # Granular Access Token with Bypass-2FA (npm 2026 policy)
```

GitHub: tag `vX.Y.Z` and use the CHANGELOG section as the release notes — do not
retype it. Extract it mechanically so the Release and the CHANGELOG cannot drift:

```bash
node scripts/extract-release-notes.mjs 0.8.36 > /tmp/notes.md
gh release create v0.8.36 --title "0.8.36 — <short title>" --notes-file /tmp/notes.md
```

Then confirm all three places agree:

```bash
node scripts/check-releases.mjs      # tag <-> GitHub Release <-> npm tarball
```

**Do not treat a tarball 404 (or `npm view` failing) right after publishing as a
failure.** The registry packument can list the new version and move `latest`
while the CDN still 404s the tarball, which makes `npm install <pkg>@<ver>` report
`ETARGET: No matching version found`. Wait for the artifact, then verify for real:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/dsh-openssh-remote/-/dsh-openssh-remote-<ver>.tgz
npm install dsh-openssh-remote@<ver>   # in a scratch dir: the authoritative check
```

## 4. Topics / discovery

Repo **About → Topics**:

```
dsh-plugin  deepseek-harness  remote  ssh  tunnel  plugin
```

README must reference `docs/cover.png` with a **relative** path so GitHub Topics
can show a card image.

## 5. Install blurb (awesome lists)

```markdown
## dsh-openssh-remote

Remote-work assistant for DeepSeek Harness: connect to SSH machines, pick a
remote workspace, and let the agent operate there (list/read/edit/exec/sync)
without exposing the harness on `0.0.0.0`.

- **Repo**: https://github.com/RiversJin/dsh-openssh-remote
- **npm**: https://www.npmjs.com/package/dsh-openssh-remote
- **Install**: `dsh plugin add dsh-openssh-remote`
```
