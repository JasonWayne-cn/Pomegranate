import { Alert, Button, Card } from "antd";
import { useNavigate } from "react-router-dom";

interface Props {
  /** 兼容旧深链的锚点 id，例如 settings-ai-models */
  id?: string;
  title: string;
  moduleLabel: string;
  /** 模块页地址，可带 ?config=<panelId> 直接打开配置抽屉 */
  to: string;
}

/**
 * 设置页中已迁移配置的占位提示。
 *
 * 保留旧锚点 id，避免历史跳转落到空页面；
 * 按钮直接跳模块并打开对应配置面板。
 */
export function MigratedNotice({ id, title, moduleLabel, to }: Props) {
  const navigate = useNavigate();

  return (
    <Card id={id} size="small" style={{ marginBottom: 16 }}>
      <Alert
        type="info"
        showIcon
        message={`${title}已移至「${moduleLabel}」模块`}
        description="在左侧导航进入该模块后点击 ⚙，或直接使用右侧按钮打开配置。"
        action={
          <Button size="small" type="primary" onClick={() => navigate(to)}>
            前往配置
          </Button>
        }
      />
    </Card>
  );
}

export default MigratedNotice;
