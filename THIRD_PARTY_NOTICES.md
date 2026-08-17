# Third-Party Notices

**English** | [简体中文](THIRD_PARTY_NOTICES.zh-CN.md)

## Scope

AEC-S uses third-party software that remains subject to its own license terms. The PolyForm Noncommercial License 1.0.0 applies to the original AEC-S work provided by Aphelion_Lab; it does not replace or restrict the licenses of third-party components.

The current source and npm package do not bundle `node_modules`, third-party native binaries, or third-party source code. Dependencies are installed as separate packages and carry their own license files. This document records the reviewed dependency set from `package-lock.json`; it does not replace the complete license texts included with those packages.

## Direct runtime dependencies

| Component | Version | License | Copyright or project |
| --- | --- | --- | --- |
| [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | 1.30.0 | MIT | Copyright 2024 Anthropic, PBC |
| [Zod](https://github.com/colinhacks/zod) | 4.4.3 | MIT | Copyright 2025 Colin McDonnell |

The locked production dependency graph contains 93 packages: 83 MIT, 2 BSD-3-Clause, 7 ISC, and 1 BSD-2-Clause.

The non-MIT transitive production dependencies are:

| Component | Version | License |
| --- | --- | --- |
| `json-schema-typed` | 8.0.2 | BSD-2-Clause |
| `fast-uri` | 3.1.5 | BSD-3-Clause |
| `qs` | 6.15.3 | BSD-3-Clause |
| `inherits` | 2.0.4 | ISC |
| `isexe` | 2.0.0 | ISC |
| `once` | 1.4.0 | ISC |
| `setprototypeof` | 1.2.0 | ISC |
| `which` | 2.0.2 | ISC |
| `wrappy` | 1.0.2 | ISC |
| `zod-to-json-schema` | 3.25.2 | ISC |

All other production dependencies currently recorded in `package-lock.json` use the MIT License.

## Direct development dependencies

| Component | Version | License | Copyright or project |
| --- | --- | --- | --- |
| [`@types/node`](https://github.com/DefinitelyTyped/DefinitelyTyped) | 26.2.0 | MIT | Copyright Microsoft Corporation and contributors |
| [Oxlint](https://github.com/oxc-project/oxc) | 1.76.0 | MIT | Copyright VoidZero Inc., Boshen, and contributors |
| [tsx](https://github.com/privatenumber/tsx) | 4.23.12 | MIT | Copyright Hiroki Osame |
| [TypeScript](https://github.com/microsoft/TypeScript) | 7.0.2 | Apache-2.0 | Copyright Microsoft Corporation |

The locked development-only graph contains 72 packages: 51 MIT and 21 Apache-2.0. The Apache-2.0 entries are TypeScript and its platform packages. TypeScript also provides a `NOTICE.txt` that must be preserved if TypeScript itself is redistributed. These development tools are not currently bundled with AEC-S.

## Redistribution requirements

If a future distribution bundles dependency source, `node_modules`, a standalone executable, native binaries, or a container image containing these components, that distribution must include every applicable third-party copyright notice, complete license text, disclaimer, and any required upstream NOTICE content.

The authoritative component versions are recorded in `package-lock.json`. The CI license policy permits only the currently reviewed SPDX identifiers: Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, and MIT. A new or missing license fails CI and requires explicit review.
