#!/usr/bin/env bash
# 准备一次发布：同步 package.json、package-lock.json、manifest.json 的版本号，提交并打本地 tag（不推送）。
# 用法：bash scripts/release.sh 0.1.1
set -euo pipefail

usage='用法: bash scripts/release.sh <semver>   例: bash scripts/release.sh 0.1.1'

if [[ $# -ne 1 ]]; then
  printf '%s\n' "${usage}" >&2
  exit 1
fi

version="$1"
if [[ ! "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  printf '版本号不是合法 semver：%s\n%s\n' "${version}" "${usage}" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "${script_dir}/.."

tag_name="v${version}"
version_files=(package.json package-lock.json manifest.json)

current_version="$(node -p "require('./package.json').version")"
if [[ "${version}" == "${current_version}" ]]; then
  printf 'package.json 版本已是 %s，未做修改。\n' "${current_version}" >&2
  exit 1
fi

current_core="${current_version%%[-+]*}"
new_core="${version%%[-+]*}"
IFS=. read -r cur_major cur_minor cur_patch <<<"${current_core}"
IFS=. read -r new_major new_minor new_patch <<<"${new_core}"
if ((new_major < cur_major)) \
  || ((new_major == cur_major && new_minor < cur_minor)) \
  || ((new_major == cur_major && new_minor == cur_minor && new_patch < cur_patch)); then
  printf '新版本 %s 低于当前版本 %s，拒绝降级。\n' "${version}" "${current_version}" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  printf '工作树不干净，请先提交或 stash 后再准备发布：\n%s\n' "$(git status --porcelain)" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/${tag_name}" >/dev/null 2>&1; then
  printf 'tag %s 已存在。\n' "${tag_name}" >&2
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"

# npm version 同步 package.json 和 package-lock.json。
npm version "${version}" --no-git-tag-version >/dev/null

# manifest.json 与 npm 包使用同一个发布版本。
node --input-type=module -e '
import fs from "node:fs";
const version = process.argv[1];
const path = "manifest.json";
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
manifest.version = version;
fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
' "${version}"

git add -- "${version_files[@]}"
if git diff --cached --quiet -- "${version_files[@]}"; then
  printf '版本文件没有产生可提交的改动，已中止。\n' >&2
  exit 1
fi

message_file="$(mktemp)"
trap 'rm -f -- "${message_file}"' EXIT
printf 'chore(release): 发布 %s\n' "${version}" >"${message_file}"
git commit -F "${message_file}"

git tag "${tag_name}"

printf '已在 %s 上准备发布 %s：已提交并创建本地 tag %s（未推送）。\n' "${branch}" "${version}" "${tag_name}"
printf '手动推送命令：git push origin %s && git push origin %s\n' "${branch}" "${tag_name}"
