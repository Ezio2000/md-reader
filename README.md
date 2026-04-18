# MD Reader

一个本地运行的 Web 应用，用来把本机某个目录作为工作目录浏览，只显示目录和 `.md` 文件，并在点击文件后即时渲染 Markdown。

## 功能

- 打开任意本机目录作为工作目录
- 支持通过系统原生文件夹选择器直接选择工作目录
- 目录树按点击时再请求子节点，避免一次性展开整个目录
- 树中只显示目录和 `.md` 文件
- 点击 `.md` 文件后在右侧实时渲染
- 提供插件宿主骨架、插件管理页面和启停管理
- 默认启动时工作目录为当前项目目录

## 运行

```bash
npm install
npm start
```

启动后访问：

```text
http://127.0.0.1:3000
```

## 构建

```bash
npm run build
```

构建完成后会生成 `dist/`，里面包含可运行的服务端文件、前端静态资源和插件目录。

如果你想从构建产物运行：

```bash
cd dist
npm install
npm start
```

然后访问：

```text
http://127.0.0.1:3000
```

## 插件体系

- 插件目录默认是项目根目录下的 `plugins/`
- 每个插件都需要自己的子目录，并至少包含一个 `plugin.json`
- 可选的 `serverEntry` 用于注册宿主 hooks
- 可选的 `clientEntry` 会在阅读器页作为浏览器模块加载
- 插件管理页地址是 `http://127.0.0.1:3000/plugins.html`

最小 manifest 结构：

```json
{
  "id": "your-plugin-id",
  "name": "Your Plugin",
  "version": "0.1.0",
  "description": "What this plugin does.",
  "serverEntry": "server.js",
  "clientEntry": "client.js",
  "permissions": ["markdown:transform"]
}
```

当前宿主已开放的服务端 hooks：

- `registerMarkdownTransformer(name, handler)`
- `registerTreeTransformer(name, handler)`

浏览器端插件入口需要导出：

```js
export async function activate(api) {
  api.onPreviewRendered(async ({ previewElement, filePath, pluginMeta }) => {
    // ...
  });
}
```

## 怎么使用

1. 启动应用后，左侧会显示当前工作目录里的目录树。
2. 顶部可以直接点“选择文件夹”，系统会弹出原生目录选择器，不用手输路径。
3. 默认只显示目录和 `.md` 文件，别的文件不会出现。
4. 点击目录会动态加载它的子节点，不会一次性把整棵树读出来。
5. 点击任意 `.md` 文件，右侧会自动渲染预览。
6. 访问 `/plugins.html` 可以查看插件目录、扫描结果、错误状态和插件启停开关。
7. 如果你更习惯手动输入，也可以继续在顶部输入绝对路径后点“打开目录”。

## 说明

- 工作目录输入框需要填写本机目录的绝对路径
- 出于安全考虑，服务端会限制访问在当前工作目录内部
- 符号链接不会显示在目录树里
- `node_modules` 和隐藏目录会被默认忽略，减少无关噪音
- Linux 需要本机安装 `zenity` 或 `kdialog` 才能使用系统原生文件夹选择器
- 插件启停状态会写入 `.md-reader/plugins-state.json`
