# dsh-skillmanager

DSH web 标准插件：管理自定义固定提示词技能文件，启用的技能内容会在每次模型请求时自动注入系统提示。

## 功能

- 设置 → 「固定提示词」：全局启停开关、新增/删除技能、每个技能单独启停
- 数据持久化在 `~/.dsh-skillmanager.json`，重启 dsh 后依然保留

## 安装

```bash
dsh plugin --profile web add file:E:/dsh/dsh-skillmanager
```

并把 `dsh-skillmanager` 加入 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组，然后**重启 dsh** 生效。

## 仓库

https://github.com/AppliedYuu/dsh-skillmanager
