# Mermaid Plugin

这是一个纯插件实现的 Mermaid 渲染器，不需要修改宿主代码。

## 结构

- `plugin.json`: 插件 manifest
- `server.js`: 把 Mermaid fenced code block 包装成可渲染容器
- `client.mjs`: 在预览区中把 Mermaid 容器渲染成 SVG
- `vendor/`: Mermaid 运行时资源

## 本地测试

```bash
node plugins/mermaid/test.mjs
```
