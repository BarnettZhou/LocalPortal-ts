# LocalPortal

局域网语音输入中转工具 — 手机语音输入实时同步到电脑剪贴板。

## 使用

```bash
npm install
npm run build
npm start
```

启动后终端显示二维码和配对码，手机扫码打开页面输入配对码即可连接。手机端发送的文字自动写入电脑剪贴板。

## 命令

| 命令 | 说明 |
|---|---|
| `/help` | 查看所有命令 |
| `/status` | 查看服务状态 |
| `/list` | 历史消息列表 |
| `/copy [N]` | 复制历史消息 |
| `/mode [cover\|add]` | 切换复制模式（覆盖/追加） |
| `/link <设备>` | 进入设备会话模式 |
| `/send <文件>` | 发送文件到当前设备 |
| `/beauty [N]` | LLM 美化文本 |
| `/exit` | 退出 |

## 选项

```
lportal -p 14554 --auto-copy --max-history 10
```

| 选项 | 默认值 | 说明 |
|---|---|---|
| `-p, --port` | 14554 | 服务端口 |
| `--auto-copy` | true | 自动复制到剪贴板 |
| `--no-auto-copy` | | 关闭自动复制 |
| `--max-history` | 10 | 最大历史条数 |
| `--zh / --en` | | 强制语言 |
