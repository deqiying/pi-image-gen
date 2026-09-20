# 发布流程

`release.sh` 和 `release.ps1` 用于在 Linux/macOS 与 Windows 上准备本地发布。两个脚本都执行相同的步骤：

1. 校验输入版本号是否为 semver；
2. 拒绝版本降级、重复版本和已存在的 tag；
3. 要求工作树干净；
4. 同步 `package.json`、`package-lock.json` 和 `manifest.json` 的版本号；
5. 创建发布提交；
6. 创建本地 `v<version>` tag；
7. 输出一行合并后的手动推送命令，不自动 push。

## Linux / macOS

```bash
bash scripts/release.sh 0.1.1
```

## Windows

需要 PowerShell 7+：

```powershell
pwsh -File scripts/release.ps1 0.1.1
```

脚本成功后会输出类似：

```text
手动推送命令：git push origin main && git push origin v0.1.1
```

复制并执行该命令即可同时推送当前分支和发布 tag。脚本不会自动推送，避免未经确认触发远端 CI 或正式发布流程。

如果脚本在改写版本文件后失败，需要先检查工作树，再根据实际情况恢复版本文件后重试：

```bash
git restore package.json package-lock.json manifest.json
```

## GitHub Actions 发布

正式 Marketplace 插件 ID 为 `deqiying.pi-image-gen`。此前使用 `local.pi-image-gen` 安装的开发版与 Marketplace 版属于两个不同插件，宿主不会在两个 ID 之间自动迁移设置、授权或安装状态；发布前应卸载旧开发版，再安装 Marketplace 版本。

将本地 release 脚本输出的一行命令执行后：

```bash
git push origin main && git push origin v0.1.1
```

推送 `v*` tag 会触发 `.github/workflows/release.yml`：

1. 校验 tag 指向的提交属于 `main`，并确认三个版本文件与 tag 一致；
2. 在 `ubuntu-latest` 和 `windows-latest` 上运行 `npm ci`、`npm run check`；
3. 从固定版本的 PI-Desktop 源码构建 `@pi-desktop/plugin-devkit`，调用其 `check` 和 `publish` 协议；
4. `publish` 使用当前 tag 的 `refs/tags/<tag>` 作为可复现来源，生成 `deqiying.pi-image-gen-<version>.piplug` 和对应的 `.submission.json`；
5. 将 Ubuntu 构建生成的 `.piplug` 与 `.submission.json` 一起上传到 GitHub Release。

GitHub Actions 不直接调用插件中心提交 API。官方发布接口要求已登录的浏览器会话、CSRF 和 Origin 校验，且不支持 Personal Access Token；Release 创建后，需要登录 PI-Desktop Marketplace 发布者控制台，提交 Release 中的 `.submission.json`。插件中心会重新解析 tag、commit 和 Release 资产并执行审核。

workflow 不执行 `npm publish`，也不需要 npm 发布 token。`PI_DESKTOP_REF` 用于锁定构建所依据的 PI-Desktop devkit 版本；升级 PI-Desktop 时应同步调整该值并重新验证 workflow。

## npm 发布

npm 包名为 `@deqiying/pi-image-gen`（scoped 公开包），与 Marketplace `.piplug` 是两条独立通道，共用 `package.json`、`package-lock.json` 和 `manifest.json` 的同一个版本号。首个版本走本地手动发布，workflow 不引入 npm token，也不执行 `npm publish`。

发布前：

```bash
npm ci
npm run check
npm publish --dry-run           # 核对 tarball 内容
npm view @deqiying/pi-image-gen version   # 确认注册表上的版本与本地一致
```

发布：

```bash
npm login
npm publish                     # scoped 包的公开访问由 package.json 的 publishConfig.access 声明
```

tarball 只包含 `src/` 下的非测试源码、`main.cjs`、`manifest.json`、`package.json`、`README.md` 与 `LICENSE`；`.github/`、`scripts/`、`docs/`、`tsconfig.json` 和 `src/**/*.test.ts` 由 `.npmignore` 排除。

安装验证：

```bash
pi install npm:@deqiying/pi-image-gen
pi list
```

后续版本与 Marketplace 一起走 `scripts/release.sh`，在同一个 `v<version>` tag 上执行一次 `npm publish`，两条通道的版本号保持一致。改为 CI 发布时，再补一个使用 npm granular automation token 的 job。
