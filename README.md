# FrameDeck

FrameDeck 是一个无需上传媒体文件的本地优先 PWA 工作台。它直接通过浏览器的 File System Access API 读取用户授权的目录，支持媒体播放、文件整理、截图、A/B 剪辑、G 键快速 MP4 片段、导出队列与结构化诊断日志。

## 本地运行

不要直接使用 `file://` 打开页面。请在本仓库根目录启动静态服务器：

```bash
python3 -m http.server 8877 --bind 127.0.0.1
```

然后访问：

```text
http://127.0.0.1:8877/
```

首次完整加载后，应用外壳和 FFmpeg WebAssembly 会被缓存，可离线再次打开。媒体文件始终保留在本机，只有用户明确授权的目录可被读取或写入。

## GitHub Pages

`.github/workflows/deploy-pages.yml` 会把本仓库根目录发布到 GitHub Pages。推送到 `main` 后会自动部署，默认地址为：

```text
https://xiaobig.github.io/framedeck-pwa/
```

GitHub Pages 提供 HTTPS，满足 Service Worker、PWA 安装和 File System Access API 的安全上下文要求。推荐使用最新的 Chromium 内核桌面浏览器；Safari 和 Firefox 对目录读写 API 的支持仍有限。

## 快捷键

| 快捷键 | 操作 |
| --- | --- |
| `F3` | 媒体专注模式 |
| `F` | 进入或退出浏览器全屏 |
| `F4` | 复制到目标目录 |
| `Space` | 复制当前文件并预览下一项 |
| `[` / `]` | 设置 A/B 剪辑点 |
| `L` | 切换 A/B 循环 |
| `T` | 展开任务列表 |
| `F5` | 导出 A/B 片段 |
| `G` | 保存当前位置前 2 秒、后 3 秒的 MP4 |
| `↑` / `↓` | 上一个 / 下一个 |
| `←` / `→` | 在当前进度前 / 后随机跳转 |

## 手工验收边界

浏览器会主动阻止自动化授予本地目录读写权限。发布前应使用真实媒体目录手工验证一次：选择目录、重命名、截图、复制、A/B 导出、G 键快速片段，以及重新打开已授权目录。
