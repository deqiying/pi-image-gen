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

将本地 release 脚本输出的一行命令执行后：

```bash
git push origin main && git push origin v0.1.1
```

推送 `v*` tag 会触发 `.github/workflows/release.yml`：

1. 校验 tag 指向的提交属于 `main`，并确认三个版本文件与 tag 一致；
2. 在 `ubuntu-latest` 和 `windows-latest` 上运行 `npm ci`、`npm run check`；
3. 从固定版本的 PI-Desktop 源码构建 `@pi-desktop/plugin-devkit`，调用其 `check` 和 `pack` 接口协议；
4. 将生成的 `.piplug` 包作为 GitHub Release 资产上传。

当前 workflow 只发布 PI-Desktop 插件包，不执行 `npm publish`，也不需要 npm 发布 token。`PI_DESKTOP_REF` 用于锁定构建所依据的 PI-Desktop devkit 版本；升级 PI-Desktop 时只需同步调整该值并验证 workflow。
