# 贡献指南 / Contributing

感谢你愿意改进 dsh-agent-plugin-research。

## 提交问题

插件自身的安装、工具行为、文档或兼容性问题请提交到本仓库 Issues。请提供：

- DSH 与 Node.js 版本；
- 使用的 profile 和安装来源；
- 已脱敏的工具输出；
- 最小复现步骤、预期结果和实际结果。

不要在公开问题中粘贴 API key、GitHub token、凭据文件或完整个人路径。只有确认问题属于 DeepSeek Harness 上游时，才转交官方 Discussions。

## 提交变更

1. 从最新代码创建独立分支。
2. 保持工具名称、顺序和 schema 稳定；如需改变，必须说明缓存和兼容性影响。
3. 永久写入必须保留显式确认与审批边界。
4. 同步更新中英文 README。
5. 运行：

```powershell
npm ci
npm test
npm pack --dry-run
```

PR 应说明普通用户看到的变化、风险、测试结果及回滚方式。

---

Thank you for improving dsh-agent-plugin-research. File plugin-specific problems in this repository with DSH/Node versions, the target profile, redacted output, and a minimal reproduction. Never post credentials or tokens.

Keep tool names, ordering, and schemas stable unless the cache and compatibility impact is documented. Preserve explicit confirmation and approval for permanent writes, update both README languages, and run `npm ci`, `npm test`, and `npm pack --dry-run` before submitting a change.
