import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Typography, Descriptions, Spin, message, Modal, Button, Tooltip, Image } from "antd";
import { SyncOutlined, SettingOutlined } from "@ant-design/icons";
import { FolderOpen, ExternalLink } from "lucide-react";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { appLogDir } from "@tauri-apps/api/path";
import type { SystemInfo } from "@/types";
import { systemApi } from "@/lib/api";
import { RecommendCards } from "@/components/ui/RecommendCards";
import { useUpdater } from "@/components/updater/UpdaterProvider";

const OFFICIAL_SITE = "https://me.bit.edu.cn/";
const BILIBILI_URL = "https://space.bilibili.com/1439852793";
const BILIBILI_TUTORIAL_URL = "https://www.bilibili.com/video/BV1xvosBREbr";
const ZSXQ_NAME = "工程应用的青椒";
const ZSXQ_ID = "3963127";
const QQ_GROUP_ID = "1124130987";
const AUTHOR_CONTACT = "3963127";

const { Title, Text, Paragraph } = Typography;

/**
 * 关于页左侧锚点导航。
 * 行为与 settings 页 SettingsAnchorNav 一致：点击 smooth 滚动 + IntersectionObserver 同步高亮。
 */
const ABOUT_NAV_ITEMS: { id: string; label: string }[] = [
  { id: "about-system", label: "系统信息" },
  { id: "about-community", label: "作者 & 社区" },
  { id: "about-sponsor", label: "赞赏支持" },
  { id: "about-recommend", label: "推荐应用" },
];

function AboutAnchorNav() {
  const [activeId, setActiveId] = useState<string>(ABOUT_NAV_ITEMS[0].id);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: "0px 0px -66% 0px", threshold: 0 },
    );
    ABOUT_NAV_ITEMS.forEach((item) => {
      const el = document.getElementById(item.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  function jumpTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <aside className="anchor-page-nav">
      <ul>
        {ABOUT_NAV_ITEMS.map((item) => (
          <li
            key={item.id}
            data-active={activeId === item.id || undefined}
            onClick={() => jumpTo(item.id)}
          >
            {item.label}
          </li>
        ))}
      </ul>
    </aside>
  );
}

interface AboutDetailsProps {
  /** 显示页面标题与副标题 */
  showHeader?: boolean;
  /** 显示左侧锚点导航 */
  showAnchorNav?: boolean;
  /** 显示「前往设置」按钮 */
  showSettingsButton?: boolean;
}

/**
 * 关于信息主体。
 *
 * /about 独立页与「设置 → 关于」Tab 共用同一份组件，避免两处内容漂移
 * （此前两套实现里的 QQ 群号 / 作者联系方式就不一致）。
 */
export function AboutDetails({
  showHeader = true,
  showAnchorNav = true,
  showSettingsButton = true,
}: AboutDetailsProps) {
  const navigate = useNavigate();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dbChecking, setDbChecking] = useState(false);
  const updater = useUpdater();

  useEffect(() => {
    systemApi
      .getSystemInfo()
      .then(setInfo)
      .catch((e) => message.error(String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function handleOpenLogs() {
    try {
      await openPath(await appLogDir());
    } catch (e) {
      message.error(`打开日志目录失败: ${e}`);
    }
  }

  async function handleExportDiagnostics() {
    setExporting(true);
    try {
      const zip = await systemApi.exportDiagnostics();
      message.success("诊断包已导出到桌面");
      // 在文件管理器中定位到 zip，方便用户直接拿去发送
      await revealItemInDir(zip).catch(() => {});
    } catch (e) {
      message.error(`导出诊断包失败: ${e}`);
    } finally {
      setExporting(false);
    }
  }

  /**
   * 数据库文本体检：先只读扫描，发现问题再让用户确认是否修复。
   *
   * 排查的是「同步报 Conversion error from type Text at index: N, invalid utf-8」——
   * db 文件被外部拷坏（跨平台直接拷 app.db 漏了 -wal、数据目录放网盘双向同步、
   * 磁盘坏道）导致某个 TEXT cell 存了非法 UTF-8 字节。
   */
  async function handleCheckDbText() {
    setDbChecking(true);
    try {
      const report = await systemApi.checkDbTextHealth(false);
      if (report.issues.length === 0) {
        message.success(`数据库文本正常（已扫描 ${report.scannedCells} 处）`);
        return;
      }
      // 只列前 10 条，避免坏数据多时弹窗撑爆
      const list = report.issues
        .slice(0, 10)
        .map((i) => `· ${i.table}.${i.column} (#${i.rowId})：${i.preview}`)
        .join("\n");
      const more =
        report.issues.length > 10 ? `\n…另有 ${report.issues.length - 10} 处` : "";
      Modal.confirm({
        title: `发现 ${report.issues.length} 处损坏文本`,
        width: 640,
        content: (
          <div>
            <Paragraph type="secondary" style={{ fontSize: 13 }}>
              这些内容含非法 UTF-8 字节，会让同步整体失败。成因通常是跨设备
              <Text strong>直接拷贝 app.db</Text>
              ，或把数据目录放在网盘里双向同步。修复会把坏字节替换成 �，
              只影响已损坏的那几个字符，其余内容不动。
            </Paragraph>
            <pre
              style={{
                maxHeight: 240,
                overflow: "auto",
                fontSize: 12,
                background: "var(--kb-bg-subtle, rgba(0,0,0,.04))",
                padding: 8,
                borderRadius: 4,
                whiteSpace: "pre-wrap",
              }}
            >
              {list + more}
            </pre>
          </div>
        ),
        okText: "立即修复",
        cancelText: "暂不修复",
        onOk: async () => {
          const fixed = await systemApi.checkDbTextHealth(true);
          if (fixed.errors.length > 0) {
            message.warning(
              `修复 ${fixed.repairedCells} 处，${fixed.errors.length} 处失败：${fixed.errors[0]}`,
            );
          } else {
            message.success(`已修复 ${fixed.repairedCells} 处，可以重新同步了`);
          }
        },
      });
    } catch (e) {
      message.error(`数据库体检失败: ${e}`);
    } finally {
      setDbChecking(false);
    }
  }

  async function handleCheckUpdate() {
    if (!updater) return;
    setChecking(true);
    try {
      // 走全局更新状态机：有更新会自动弹出（并已在后台开始下载）的全局 UpdateModal，
      // 这里只需对「已是最新 / 检查失败」给出反馈。
      const r = await updater.checkManually();
      if (r.error) {
        message.warning(`检查更新失败: ${r.error}`);
      } else if (!r.hasUpdate) {
        message.success("当前已是最新版本");
      }
    } finally {
      setChecking(false);
    }
  }

  const content = (
    <div
      className={showAnchorNav ? "anchor-page-content" : undefined}
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      {showHeader && (
        <div className="flex items-start justify-between gap-2">
          <div>
            <Title level={3} style={{ marginBottom: 4 }}>关于</Title>
            <Text type="secondary">系统信息和应用版本</Text>
          </div>
          {showSettingsButton && (
            <Button
              icon={<SettingOutlined />}
              onClick={() => navigate("/settings")}
            >
              前往设置
            </Button>
          )}
        </div>
      )}

      <Card id="about-system" title="系统信息">
        {loading ? (
          <div className="flex justify-center py-8">
            <Spin />
          </div>
        ) : info ? (
          <Descriptions
            column={1}
            bordered
            size="small"
            labelStyle={{ width: 110 }}
          >
            <Descriptions.Item label="操作系统">{info.os}</Descriptions.Item>
            <Descriptions.Item label="CPU 架构">{info.arch}</Descriptions.Item>
            <Descriptions.Item label="应用版本">
              <div className="flex items-center justify-between gap-2">
                <Text style={{ fontSize: 13 }}>v{info.appVersion}</Text>
                <Button
                  type="link"
                  size="small"
                  icon={<SyncOutlined spin={checking} />}
                  loading={checking}
                  onClick={handleCheckUpdate}
                >
                  检查更新
                </Button>
              </div>
            </Descriptions.Item>
            <Descriptions.Item label="官网">
              <div className="flex items-center justify-between gap-2">
                <Text style={{ fontSize: 13 }}>{OFFICIAL_SITE}</Text>
                <Tooltip title="在浏览器中打开">
                  <Button
                    type="link"
                    size="small"
                    icon={<ExternalLink size={14} />}
                    onClick={() => openUrl(OFFICIAL_SITE)}
                  />
                </Tooltip>
              </div>
            </Descriptions.Item>
            <Descriptions.Item label="日志与诊断">
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  size="small"
                  icon={<FolderOpen size={14} />}
                  onClick={handleOpenLogs}
                >
                  打开日志目录
                </Button>
                <Button
                  size="small"
                  type="primary"
                  ghost
                  loading={exporting}
                  onClick={handleExportDiagnostics}
                >
                  导出诊断包
                </Button>
                <Button size="small" loading={dbChecking} onClick={handleCheckDbText}>
                  数据库体检
                </Button>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  闪退 / 异常时点「导出诊断包」生成 zip 发给开发者排查；
                  同步报「invalid utf-8」时点「数据库体检」
                </Text>
              </div>
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Text type="danger">无法获取系统信息</Text>
        )}
      </Card>

      <Card id="about-community" title="社区">
        <Descriptions
          column={1}
          bordered
          size="small"
          labelStyle={{ width: 110 }}
        >
          <Descriptions.Item label="B 站主页">
            <div className="flex items-center justify-between gap-2">
              <Text style={{ fontSize: 13 }}>{BILIBILI_URL}</Text>
              <Tooltip title="在浏览器中打开">
                <Button
                  type="link"
                  size="small"
                  icon={<ExternalLink size={14} />}
                  onClick={() => openUrl(BILIBILI_URL)}
                />
              </Tooltip>
            </div>
          </Descriptions.Item>
          <Descriptions.Item label="视频讲解">
            <div className="flex items-center justify-between gap-2">
              <Text style={{ fontSize: 13 }}>B 站使用教程 / 功能演示</Text>
              <Tooltip title="在浏览器中打开">
                <Button
                  type="link"
                  size="small"
                  icon={<ExternalLink size={14} />}
                  onClick={() => openUrl(BILIBILI_TUTORIAL_URL)}
                />
              </Tooltip>
            </div>
          </Descriptions.Item>
          <Descriptions.Item label="知识星球">
            <div className="flex items-center gap-2 flex-wrap">
              <Text style={{ fontSize: 13 }}>{ZSXQ_NAME}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>·</Text>
              <Text style={{ fontSize: 13 }}>星球号</Text>
              <Text copyable={{ text: ZSXQ_ID }} strong style={{ fontSize: 13 }}>
                {ZSXQ_ID}
              </Text>
            </div>
          </Descriptions.Item>
          <Descriptions.Item label="QQ 交流群">
            <div className="flex items-center gap-2 flex-wrap">
              <Text style={{ fontSize: 13 }}>群号</Text>
              <Text copyable={{ text: QQ_GROUP_ID }} strong style={{ fontSize: 13 }}>
                {QQ_GROUP_ID}
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                （Bug 反馈 / 使用交流 / 新功能讨论）
              </Text>
            </div>
          </Descriptions.Item>
          <Descriptions.Item label="联系作者">
            <div className="flex items-center gap-2 flex-wrap">
              <Text style={{ fontSize: 13 }}>QQ / 微信</Text>
              <Tooltip title="点击复制">
                <Text copyable={{ text: AUTHOR_CONTACT }} strong style={{ fontSize: 13 }}>
                  {AUTHOR_CONTACT}
                </Text>
              </Tooltip>
              <Text type="secondary" style={{ fontSize: 12 }}>
                （添加时请备注「来自知识库」）
              </Text>
            </div>
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {/* 赞赏支持：本应用完全免费，扫码请作者喝杯咖啡 ☕ */}
      <Card id="about-sponsor" title="赞赏支持">
        <div className="flex items-center gap-6 flex-wrap">
          <div className="flex flex-col items-center gap-1">
            <Image
              src="/donate-qr.png"
              alt="赞赏码"
              width={280}
              height={280}
              style={{
                objectFit: "contain",
                borderRadius: 8,
                background: "#fff",
                padding: 8,
                border: "1px solid #f0f0f0",
                cursor: "zoom-in",
              }}
              // Ant Design Image 自带点击预览：点开可全屏放大 / 缩放，方便扫码
              preview={{ mask: "点击放大扫码" }}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              点击图片可放大扫码
            </Text>
          </div>
          <div className="flex-1 min-w-[200px]">
            <Title level={5} style={{ marginTop: 0 }}>
              如果这款工具帮到了你 ❤️
            </Title>
            <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 8 }}>
              本应用完全免费、无任何会员/订阅。如果觉得对你有用，欢迎扫描左侧
              微信赞赏码请作者喝杯咖啡 ☕，能让我有更多动力继续投入。
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
              💡 不想赞赏也欢迎：在 B 站点个关注 / 在 GitHub 给项目点 Star /
              把它推荐给身边需要的朋友。
            </Typography.Paragraph>
          </div>
        </div>
      </Card>

      <div id="about-recommend">
        <RecommendCards />
      </div>
    </div>
  );

  if (!showAnchorNav) return content;

  return (
    <div className="anchor-page-layout">
      <AboutAnchorNav />
      {content}
    </div>
  );
}

/** /about 独立页入口 */
export default function AboutPage() {
  return <AboutDetails />;
}
