# 第三方软件声明

[English](THIRD_PARTY_NOTICES.md) | **简体中文**

## 适用范围

AEC-S 使用了一些仍受其各自许可证约束的第三方软件。PolyForm Noncommercial License 1.0.0 适用于 Aphelion_Lab 提供的 AEC-S 原创作品，不会替代或限制第三方组件自身的许可证。

当前源码和 npm 包没有捆绑 `node_modules`、第三方原生二进制或第三方源代码。依赖作为独立软件包安装，并分别携带自己的许可证文件。本文档记录 `package-lock.json` 中已经审查的依赖集合，但不能替代这些软件包附带的完整许可证文本。

## 直接运行时依赖

| 组件 | 版本 | 许可证 | 版权所有者或项目 |
| --- | --- | --- | --- |
| [Agent Client Protocol TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) | 0.23.0 | Apache-2.0 | Zed Industries 及贡献者 |
| [Kimi Agent SDK](https://github.com/MoonshotAI/kimi-agent-sdk) | 0.1.8 | MIT | Moonshot AI |
| [DeepSeek Harness SDK、Credential seam 与锁定 Runtime composition 包](https://github.com/deepseek-ai/deepseek-harness) | 0.1.0-rc.6 | MIT | DeepSeek AI |
| [Cordis](https://github.com/cordiverse/cordis) | 4.0.1 | MIT | Cordis 贡献者 |
| [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | 1.30.0 | MIT | Copyright 2024 Anthropic, PBC |
| [Zod](https://github.com/colinhacks/zod) | 4.4.3 | MIT | Copyright 2025 Colin McDonnell |

锁定的生产依赖图共包含 192 个软件包：176 个 MIT、1 个 Apache-2.0、5 个 BSD-3-Clause、8 个 ISC、1 个 BSD-2-Clause 和 1 个 Python-2.0。DSH 软件包统一锁定在 `0.1.0-rc.6` 软件包/Runtime 版本线；AEC-S 还会通过初始化握手验证 JSON-RPC Server 身份。版本不匹配时 Runtime 必须不可用，不得回退为 command Adapter。

非 MIT 的生产依赖如下：

| 组件 | 版本 | 许可证 |
| --- | --- | --- |
| `@agentclientprotocol/sdk` | 0.23.0 | Apache-2.0 |
| `json-schema-typed` | 8.0.2 | BSD-2-Clause |
| `fast-uri` | 3.1.5 | BSD-3-Clause |
| `qs` | 6.15.3 | BSD-3-Clause |
| `@deepseek-ai/node-addon-landlock-run` 及平台包 | 0.1.1 | BSD-3-Clause |
| `argparse` | 2.0.1 | Python-2.0 |
| `inherits` | 2.0.4 | ISC |
| `isexe` | 2.0.0 | ISC |
| `once` | 1.4.0 | ISC |
| `setprototypeof` | 1.2.0 | ISC |
| `which` | 2.0.2 | ISC |
| `wrappy` | 1.0.2 | ISC |
| `zod-to-json-schema` | 3.25.2 | ISC |

除以上已列项目外，`package-lock.json` 当前记录的其他生产依赖均采用 MIT License。

## 直接开发依赖

| 组件 | 版本 | 许可证 | 版权所有者或项目 |
| --- | --- | --- | --- |
| [`@types/node`](https://github.com/DefinitelyTyped/DefinitelyTyped) | 26.2.0 | MIT | Copyright Microsoft Corporation 及贡献者 |
| [Oxlint](https://github.com/oxc-project/oxc) | 1.76.0 | MIT | Copyright VoidZero Inc.、Boshen 及贡献者 |
| [tsx](https://github.com/privatenumber/tsx) | 4.23.12 | MIT | Copyright Hiroki Osame |
| [TypeScript](https://github.com/microsoft/TypeScript) | 7.0.2 | Apache-2.0 | Copyright Microsoft Corporation |

锁定的纯开发依赖图共包含 72 个软件包：51 个 MIT 和 21 个 Apache-2.0。Apache-2.0 项目为 TypeScript 及其平台包。如果分发 TypeScript 本身，还必须保留它提供的 `NOTICE.txt`。这些开发工具当前没有被捆绑进 AEC-S。

## 再分发要求

如果未来的分发物捆绑依赖源码、`node_modules`、独立可执行文件、原生二进制或包含这些组件的容器镜像，则该分发物必须提供每项适用的第三方版权声明、完整许可证、免责声明及上游要求保留的 NOTICE 内容。

组件的权威版本记录在 `package-lock.json` 中。CI 许可证策略只允许当前已经审查的 SPDX 标识符：Apache-2.0、BSD-2-Clause、BSD-3-Clause、ISC、MIT 和 Python-2.0。出现新的许可证或缺少许可证信息时，CI 将失败并要求进行明确审查。
