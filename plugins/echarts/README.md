# ECharts Plugin

这是一个纯插件实现的 ECharts 渲染器，不需要修改宿主代码。

## 结构

- `plugin.json`: 插件 manifest
- `server.js`: 把 ECharts fenced code block 包装成可渲染容器
- `client.mjs`: 在预览区中把 ECharts 容器渲染成图表
- `vendor/`: ECharts 浏览器运行时

## 支持

- 代码块语言：`echarts` 或 `echart`
- 内容格式：
  - 直接写 ECharts option 对象
  - 写包含 `option`、`height`、`renderer` 的包装对象

## 本地测试

```bash
node plugins/echarts/test.mjs
```
