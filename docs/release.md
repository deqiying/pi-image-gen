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
