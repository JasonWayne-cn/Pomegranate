import { Card, Typography } from "antd";

const { Text } = Typography;

/**
 * 数据迁移说明。
 *
 * 从「应用信息」迁到「应用配置 → 数据目录」下方：迁移操作与数据目录位置强相关，
 * 放在一起更符合用户查找路径。
 */
export function DataMigrationSection({ embedded }: { embedded?: boolean }) {
  const content = (
    <>
      <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 10 }}>
        按使用场景从简单到专业，推荐 4 种方式：
      </Typography.Paragraph>

      <Typography.Title level={5} style={{ fontSize: 13, marginBottom: 4, marginTop: 0 }}>
        ① 单台电脑换硬盘 / 搬到 D 盘
      </Typography.Title>
      <Typography.Paragraph style={{ fontSize: 13, marginBottom: 12 }}>
        <Text strong>设置 → 数据目录</Text> 选新路径，勾选「
        <Text type="success">自动迁移</Text>
        」即可。应用会启动迁移引导窗口完成搬运，无需手工复制文件。
      </Typography.Paragraph>

      <Typography.Title level={5} style={{ fontSize: 13, marginBottom: 4, marginTop: 0 }}>
        ② 一次性整包搬到另一台电脑（离线）
      </Typography.Title>
      <Typography.Paragraph style={{ fontSize: 13, marginBottom: 12 }}>
        旧电脑：<Text strong>设置 → 同步 → 本地 ZIP → 导出</Text>{" "}
        得到一个 .zip 快照（含全部数据库 + 图片 + PDF + 附件 + 源文件）。
        新电脑安装应用后到同位置选择 <Text strong>导入 ZIP</Text>，自动解压覆盖。
      </Typography.Paragraph>

      <Typography.Title level={5} style={{ fontSize: 13, marginBottom: 4, marginTop: 0 }}>
        ③ 多端实时双向同步（推荐长期用户）
      </Typography.Title>
      <Typography.Paragraph style={{ fontSize: 13, marginBottom: 12 }}>
        <Text strong>设置 → 同步 → 多端同步（V1）</Text>{" "}
        配置 WebDAV / 坚果云 / NAS 后端；多台电脑都登录同一个账号，应用会按文件级
        manifest 增量推拉，自动消化双端冲突。也可以只用「
        <Text>WebDAV 全量快照</Text>」做单向手动备份。
      </Typography.Paragraph>

      <Typography.Title level={5} style={{ fontSize: 13, marginBottom: 4, marginTop: 0 }}>
        ④ 手动复制（兜底方案，应急用）
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 6 }}>
        数据目录下的核心文件 / 子目录：
      </Typography.Paragraph>
      <ul style={{ fontSize: 12, paddingLeft: 20, margin: "0 0 8px", color: "rgba(0,0,0,0.45)" }}>
        <li style={{ marginBottom: 2 }}><code>app.db</code> — 文档 / 文件夹 / 标签 / 链接 / AI 对话 / 待办 / 加密数据等全部元数据（SQLite）</li>
        <li style={{ marginBottom: 2 }}><code>kb_assets/</code> — 文档内嵌图片（含 <code>kb_assets/videos/</code> 子目录的视频）</li>
        <li style={{ marginBottom: 2 }}><code>pdfs/</code> — 导入的 PDF 原始文件</li>
        <li style={{ marginBottom: 2 }}><code>sources/</code> — 导入的 Word（.docx/.doc）原始文件</li>
        <li style={{ marginBottom: 2 }}><code>attachments/</code> — 文档附件（zip / 音频等通用文件）</li>
        <li><code>settings.json</code> — 应用偏好（主题、窗口状态、字体等）</li>
      </ul>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
        步骤：关闭应用 → 整目录复制到新电脑相同路径（点上方「打开数据目录」定位）→
        启动即可。<Text strong>务必整目录一起搬</Text>，单独复制 <code>app.db</code>{" "}
        会丢图片 / PDF / 附件。
      </Typography.Paragraph>

      <Typography.Paragraph
        type="warning"
        style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}
      >
        ⚠ 任何方式都要在迁移前关闭应用；新旧两端版本号差距不要超过一个小版本，避免
        schema 不兼容。需要给其他工具用，可在
        <Text strong> 设置 → 导出 Markdown</Text> 单独导出标准 .md 文件。
      </Typography.Paragraph>
    </>
  );

  // 以帮助信息的形式嵌在「数据目录」卡片内时不再套一层 Card
  if (embedded) {
    return <div id="settings-data-migration">{content}</div>;
  }

  return (
    <Card id="settings-data-migration" title="数据迁移说明" size="small">
      {content}
    </Card>
  );
}

export default DataMigrationSection;
