# 自定义图片接口实施

已确认设计：设置页选择 OpenAI 兼容、阿里云 DashScope 原生或自定义。自定义展开请求、返回解析、预览检查，支持 JSON 和 multipart 表单、可编辑请求头、工作台变量和图片字段路径。沿用已批准视觉预览，不增加账号或服务管理平台。

## 接口适配设计

### 1. 服务类型

设置页的服务类型与请求协议一一对应，不把“有 API Key”视为协议兼容：

| 服务类型 | 地址填写方式 | 后端请求方式 | 适用范围 |
| --- | --- | --- | --- |
| OpenAI 兼容 | 填写 Base URL，例如 `https://example.com/v1` | 自动追加 `/images/generations` 或 `/images/edits` | 上游明确支持 OpenAI Images API 的服务 |
| 阿里云 DashScope 原生 | 填写完整生成 URL | 直接 POST 到填写的 URL | DashScope 原生多图生成/编辑 |
| 自定义 | 填写完整 URL | 按模板发送 JSON 或 multipart | 其他同步返回图片的服务 |

“OpenAI 兼容”不是所有模型都能使用的通用开关。只有上游同时提供 OpenAI Images 的路径、请求体和返回结构时，才选择该类型。

### 2. OpenAI 兼容协议

配置字段：

- Base URL：包含版本前缀的基础地址，例如 `https://example.com/v1`。
- API Key：使用 `Authorization: Bearer <API Key>`。
- 图片模型：由上游服务提供的模型名称。

无参考图时，后端发送 JSON 到 `/images/generations`：

```json
{
  "model": "<model>",
  "prompt": "<prompt>",
  "n": 1,
  "size": "1152x1536"
}
```

有参考图时，后端发送 multipart 到 `/images/edits`，字段包括 `model`、`prompt`、`n`、`size` 和一个或多个 `image[]` 文件。

成功响应读取 `data[0].url` 或 `data[0].b64_json`。如果服务只支持聊天接口、厂商私有字段或异步任务 ID，不能直接归入此类型，应使用 DashScope 原生或自定义适配。

### 3. 阿里云 DashScope 原生协议

DashScope 原生必须填写官方 curl 中的完整地址，不能填写 OpenAI 兼容基础地址：

```text
https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
```

地址中的业务空间、地域、API Key 和模型必须属于同一套 DashScope 配置。`https://dashscope.aliyuncs.com/compatible-mode/v1` 属于另一种协议，不能在“DashScope 原生”类型下使用。

请求头：

```text
Content-Type: application/json
Authorization: Bearer <DASHSCOPE_API_KEY>
```

请求体结构：

```json
{
  "model": "qwen-image-3.0-pro",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": [
          { "image": "data:image/png;base64,<参考图 1>" },
          { "image": "data:image/png;base64,<参考图 2>" },
          { "text": "让参考图片1中的模特穿上参考图片2中的服装。" }
        ]
      }
    ]
  },
  "parameters": {
    "prompt_extend": true,
    "n": 1,
    "size": "1152*1536"
  }
}
```

约束：最多 3 张参考图，单张不超过 10 MB；没有参考图时 `content` 只保留 `text` 项。成功响应从 `output.choices[0].message.content[]` 中读取第一个 `image` 字段。DashScope 返回的图片 URL 有效期有限，后端收到响应后立即下载并保存到本地资产数据目录。

DashScope 原生没有通用的 `/models` 检查流程，设置页的“检查配置”只做地址、模型和字段检查，不发起真实生成；真实连通性在创作页发布任务时验证。

### 4. 自定义协议

自定义接口支持 JSON 或 multipart 请求模板，使用 `{{model}}`、`{{prompt}}`、`{{images}}`、`{{content}}`、`{{size}}` 和 `{{apiKey}}` 变量。用户可以指定返回图片字段路径，例如 `output.images[0]`。模板只允许数据和字段路径，不执行脚本。

### 5. 本地任务边界

- 前端每次创建一个生成任务，后端本地队列最多同时执行两次请求。
- 当前适配只处理一次响应直接返回图片 URL 或 Base64 的同步接口。
- 上游返回任务 ID、需要轮询或需要回调的接口暂不支持，后续新增适配器时再扩展。
- 取消只停止本地等待，不保证上游停止处理或停止计费。
- API Key 只保存在本地服务配置文件，浏览器只接收“是否已保存”，不回传密钥。

- [x] 隔离模拟服务测试覆盖 DashScope 原生多图、无参考图、自定义 JSON/文件上传、错误解析与配置持久化。
- [x] 新增 `interface-config.js`：前后端共享模板校验、变量替换、字段读取与预设；不执行用户代码。
- [x] 更新 `provider.mjs`、`server.mjs`：按服务类型请求，服务限制提前校验，保存模板但不回传 Key；自定义检查不联网。
- [x] 更新 `index.html`、`settings.js`、`studio.css`：实现批准的三页签及模板、试读、脱敏预览、保存；工作台显示引用数量限制。
- [x] `npm test` 通过；浏览器已检查设置预览和工作台，准备重启本地 Demo。

边界：只支持一次响应直接返回图片 URL 或 Base64；任务 ID 轮询接口需后续适配。DashScope 原生使用官方同步接口，最多 3 张图、单图 10 MB。真实模型效果留给用户测试。只改工作区必要文件，不提交已有未跟踪文件。
