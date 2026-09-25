# 中文文档 / Chinese README

DXRouter 的中文文档现在位于 **[`i18n/README.zh-CN.md`](./i18n/README.zh-CN.md)**，与其他所有翻译放在一起。

The Chinese README now lives at **[`i18n/README.zh-CN.md`](./i18n/README.zh-CN.md)**, alongside every other translation.

---

## 为什么移动？ / Why did it move?

此仓库曾经有两份不同的中文 README：根目录的这一份，以及 `i18n/README.zh-CN.md`。
两份内容已经不一致，而语言切换器指向的是较旧的那一份。

This repository used to carry two divergent Chinese READMEs — this one at the root, and
`i18n/README.zh-CN.md`. Every language switcher in the repository pointed at the `i18n/`
copy, so that is the file Chinese readers actually reached, but it was the older of the
two: it predated the `DXR_*` runtime variables and carried five markdown corruptions.

The newer root content was promoted into `i18n/README.zh-CN.md`, which is now the single
canonical Chinese README. This file is kept — rather than deleted — so that existing links
and bookmarks to `README.zh-CN.md` still land somewhere useful instead of 404ing.

**Do not add Chinese documentation to this file.** A second Chinese source is exactly the
problem this pointer exists to prevent; `tests/unit/dxr-docs-consistency.test.js` fails if
prose reappears here.
