# 柏宝·改 (`ST-BaiBai-Mod`)

融合 **柏宝绘 (`ST-BaiBai-Image`)** 与 **智绘姬 (`st-chatu8`)** 核心优势的 SillyTavern 独立自动插画扩展。

## 核心特性

1. **独立命名空间与双向兼容**
   - 拥有完全独立的扩展设置键（`baibai_mod`）、DOM 宿主（`#bbm-app-host`）、生图标签（`<bbm_image>` / `div[data-bbm-slot]`）、人物档案字段（`bbmCharChanges`）与图库目录前缀（`柏宝改_`），可与原版柏宝绘并存安装。
   - **完全兼容原版「柏宝书 (`STBaiBaiBook`)」记忆**、共享副 API 渠道库（`extensionSettings['baibai_api_channels']`）与共享排除名单（`extensionSettings['baibai_exclude_settings']`）。
   - 支持从同宿主原版「柏宝绘」按条目手动导入 NAI 画师串、接入点、Vibe、出图方案、ComfyUI 库与全局角色库，图库页可只读浏览原版图片。
2. **纯浏览器直连 OpenAI 兼容协议**
   - 直接由浏览器向 OpenAI 兼容 `/chat/completions` 与 `/models` 发起请求，不经酒馆服务端代理、不依赖酒馆主 API / ST 预设管线。
   - 支持单渠道独立参数开关（`temperature`、`top_p`、`max_tokens`、`stream`、`excludeParams`）以及自定义 JSON 请求头与额外请求体参数。
3. **三档 LLM 输出协议（提示词页一键切换）**
   - **`text_json`（文本 JSON 协议）**：标准 `<thinking>...</thinking>` + JSON，兼容性最广。
   - **`tool_tunnel`（Tool Calls 隧道）**：使用 OpenAI `tools` + `tool_choice` 作为隐蔽输出隧道。支持 **Mode A（引导包裹，将全部非引导上下文打包进工具 `description`）** 与 **Mode B（标准隧道 + 可编辑尾部消息）**，配备增量状态机流式解码器，可平滑降级至文本解析。
   - **`tool_structured`（原生结构化 Schema Tool）**：根据当前后端（ComfyUI / NAI 4.5/5 / 条漫）动态生成 JSON Schema（`submit_illustration_plan` / `submit_comic_plan`），若上游忽略工具调用则自动回退文本解析。
4. **模块化条目级提示词编排 & 智绘姬导入**
   - 独立「提示词」管理页：支持增删改查预设与条目、上下排序、条件门控（NL / 条漫 / 后端 / 单槽重写）、OR + AND 关键词触发器、`{{// 注释}}` 剥离、动态空槽跳过、只读 `{{getvar::}}` / `{{getglobalvar::}}`、`{{roll N}}`、系统/相邻角色合并。
   - 支持 **脱敏 JSON 导出**（绝不携带密钥）与 **智绘姬 `test_context_profiles` 导入**（自动映射中文宏、`【ToolCall引导】` 与触发词）。
   - 支持 **实时编译预览（静态 Lint + 估算 Token）** 与 **真请求试运行（不改写楼层、不触发出图）**。
5. **世界书白名单 + 正文自定义清洗 + 敏感词双向替换**
   - 世界书支持条目级白名单勾选，**ACU 自动条目（`ACU-[...]-` / `TavernDB-ACU-`）按标题稳定绑定**，重排重建 UID 不丢失。
   - 自定义正文/历史清洗正则：内置静态 ReDoS 危害检测与 **1 秒 Web Worker 超时强杀保护**，保留原始物理行号映射，确保上下文位置重定位（LCS Rebase）不偏移。
   - 敏感词双向替换：发往 LLM 前正向替换，返回解析及出图前逆向还原。
6. **正文美化正则与同源 `<iframe>` 穿透（默认开启）**
   - 三级渐进式锚点定位：原生槽位直取 → 同源 `iframe` 扫描 / 转义残余 `<bbm_image>` 复原 / `TreeWalker` + `fuzzyMatchLine` 模糊上下文插槽 → 极端情况 `.bbm-fallback-slots` 楼底兜底容器，配合 `WeakMap<Document, CSSStyleSheet>` 隔离样式与 `MutationObserver` / `load` 自动重水合。
7. **精简且专注的双生图后端**
   - 原生支持 **NovelAI（NAI 4.5 / V5 Base + Character Prompts + Vibe）** 与 **ComfyUI（简易模板 / 自定义 API 工作流 / MOSS 条漫分镜 / AI 工作流助手）**，单次请求同步完成选图、提示词撰写与三层人物 DNA 维护。

## 安装方式

将构建后的插件目录放入 SillyTavern 的第三方扩展目录（确保包含 `manifest.json` 与 `dist/`）：

```
SillyTavern/public/scripts/extensions/third-party/ST-BaiBai-Mod/
```

重启或刷新 SillyTavern 页面即可使用。

## 开发与构建命令

```bash
pnpm install
pnpm test        # 运行 Vitest 单元测试
pnpm typecheck   # 运行 vue-tsc 类型检查
pnpm build       # 生成 dist/index.js 与 dist/index.css
```
