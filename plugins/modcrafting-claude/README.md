# ModCrafting Fabric for Claude Code

安装：

```
/plugin marketplace add newstarbar/ModCrafting
/plugin install modcrafting-fabric@modcrafting
```

首次启动时 Claude Code 通过 `npx -y modcrafting-mcp@0.1.8` 拉起 MCP，技能随插件加载。
需要绝对 node 路径、离线安装或多宿主管理时改用安装器：

```
npx -y github:newstarbar/ModCrafting#release install --host claude
```
