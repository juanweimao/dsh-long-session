# Third-party notices

This repository contains code and patch definitions derived from DeepSeek's
`@deepseek-ai/*` packages, which are distributed under the MIT License.

Specifically, `patch/apply-cold-open.cjs` embeds fragments of the original and
modified source of the following packages in order to locate and edit them at
runtime:

- `@deepseek-ai/dsh-session`
- `@deepseek-ai/dsh-session-persistence`
- `@deepseek-ai/dsh-session-persistence-jsonl`
- `@deepseek-ai/dsh-session-query`
- `@deepseek-ai/dsh-session-title`
- `@deepseek-ai/dsh-session-projection-cache`
- `@deepseek-ai/dsh-agent-loop`
- `@deepseek-ai/dsh-api-session-controller`
- `@deepseek-ai/dsh-token-meter`
- `@deepseek-ai/dsh-message-feedback`
- `@deepseek-ai/dsh-session-query-sqlite`
- `@deepseek-ai/dsh-tool-session-query`

`patch/cold-open.js` is original code, but it is written against the internal
interfaces of `@deepseek-ai/dsh-session` and is intended to be installed into
that package.

`heap/apply-host-heap.cjs` modifies `/lib/main.js` inside DeepSeek Harness's
`app.asar` and embeds the literal anchor fragments it replaces (the host
launcher's `node: process.execPath,`, its `"--expose-internals",` argument, and
`join(app.getAppPath(), "dsh")`). That code is part of the same MIT-licensed
packages. `heap/extract-dsh-runtime.cjs` only reads the asar archive format and
verifies extracted files against the header hashes; it contains no DeepSeek
source.

The MIT License text applicable to those packages follows.

---

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
