# PPT 模板测试包

由 `scripts/prepare-ppt-template-test-packs.mjs` 生成。

## user/aviation_training_blue

- 用途：测试「用户自定义模板」导入。
- 方式一：打开 **扩展包 → 模板库 → 导入文件夹**，选择 `user/aviation_training_blue`。
- 方式二：**导入 zip**，选择 `user/aviation_training_blue-user.zip`。
- 也可以直接把文件夹或 zip 拖进模板库页面。

## system/layouts

- 用途：作为「系统默认模板包」（6 套）。
- 测试时需要重建扩展包，并指定：

```bash
node scripts/build-ppt-extension.mjs \
  --ppt-master-root "D:/AI/ALL-PPT/ppt-master-main" \
  --layouts-dir "D:/AI/W-Pomegranate/test-data/ppt-templates/system/layouts" \
  --out "D:/AI/W-Pomegranate/test-data/ppt-templates/extension-build" \
  --version "1.2.6-system6"
```

- 输出：`extension-build/ppt-master-extension-1.2.6-system6-win7-x64.zip`
- 使用独立版本号，避免与已安装的 1.2.5 冲突；安装后可在扩展页回滚到 1.2.5。
- 说明：只有测试「系统默认模板」才需要重建扩展；普通用户模板导入不需要。
- `system-templates-6.zip` 只是同一份系统包的压缩存档，便于分发。

## 关于 exports/

- 两套测试包都保留了各模板 `exports/*_template_preview.pptx`，方便对照母版/版式。
- 这些 preview PPTX 只用于人工审阅，**不会被应用导入或安装**；应用只读取 `templates/`、`images/`、`icons/`。
