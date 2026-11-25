import { describe, it, expect } from "vitest";
import {
  backupHasSecrets,
  describeBackup,
  filterPortableConfig,
  pickBackup,
  redactSyncSecrets,
  validateBackupData,
  ALL_BACKUP_CATEGORIES,
} from "./settingsBackup";
import { BACKUP_VERSION, type BundleData } from "./configShare";
import { normalizePortableUiPrefs } from "@/store";
import type { AppConfig } from "@/types";

function cfg(key: string, value: string): AppConfig {
  return { key, value };
}

describe("filterPortableConfig", () => {
  const entries = [
    cfg("start_minimized", "1"),
    cfg("module.notes.default_sort", "created"),
    cfg("default_folder_id", "3"),
    cfg("sync.webdav_url", "https://example.com/dav"),
    cfg("web_clip_jina_key", "jina-secret"),
    cfg("some.random.key", "x"),
  ];

  it("只保留精确白名单与 module. 前缀", () => {
    expect(filterPortableConfig(entries, false)).toEqual({
      start_minimized: "1",
      "module.notes.default_sort": "created",
    });
  });

  it("包含密钥时额外带上密钥键", () => {
    expect(filterPortableConfig(entries, true)).toEqual({
      start_minimized: "1",
      "module.notes.default_sort": "created",
      web_clip_jina_key: "jina-secret",
    });
  });

  it("本地 id / 旧同步键永远不导出", () => {
    const out = filterPortableConfig(entries, true);
    expect(out).not.toHaveProperty("default_folder_id");
    expect(out).not.toHaveProperty("sync.webdav_url");
  });
});

describe("redactSyncSecrets", () => {
  it("webdav 去掉 password，保留地址与用户名，且不改原对象", () => {
    const original = {
      kind: "webdav" as const,
      name: "公司盘",
      config: {
        url: "https://dav.example.com",
        username: "alice",
        password: "p@ss",
      },
    };
    const out = redactSyncSecrets(original);
    expect(out.config).toEqual({
      url: "https://dav.example.com",
      username: "alice",
    });
    expect(original.config.password).toBe("p@ss");
  });

  it("s3 去掉 secretKey / accessKey，保留 endpoint / bucket", () => {
    const out = redactSyncSecrets({
      kind: "s3",
      name: "r2",
      config: {
        endpoint: "https://r2.example.com",
        bucket: "kb",
        accessKey: "AK",
        secretKey: "SK",
      },
    });
    expect(out.config).toEqual({
      endpoint: "https://r2.example.com",
      bucket: "kb",
    });
  });

  it("local 同步源路径保留原样", () => {
    const local = {
      kind: "local" as const,
      name: "同步盘",
      config: { path: "D:/Sync/kb" },
    };
    expect(redactSyncSecrets(local)).toBe(local);
  });
});

describe("backupHasSecrets", () => {
  it("无敏感字段时为 false", () => {
    expect(
      backupHasSecrets({
        appConfig: { start_minimized: "1" },
        aiModels: [
          {
            name: "m",
            provider: "p",
            api_url: "https://x",
            api_key: null,
            model_id: "x",
          },
        ],
      }),
    ).toBe(false);
  });

  it("任一来源含密钥即为 true", () => {
    expect(
      backupHasSecrets({ appConfig: { web_clip_jina_key: "k" } }),
    ).toBe(true);
    expect(
      backupHasSecrets({
        aiModels: [
          {
            name: "m",
            provider: "p",
            api_url: "https://x",
            api_key: "sk",
            model_id: "x",
          },
        ],
      }),
    ).toBe(true);
    expect(
      backupHasSecrets({
        syncBackends: [
          {
            kind: "webdav",
            name: "w",
            config: { password: "p" },
          },
        ],
      }),
    ).toBe(true);
    expect(
      backupHasSecrets({
        asrConfig: {
          provider: "dashscope",
          apiKey: "k",
          model: "m",
          region: "beijing",
          enabled: true,
          correctionEnabled: false,
        },
      }),
    ).toBe(true);
  });
});

describe("describeBackup", () => {
  const data: BundleData = {
    backupVersion: BACKUP_VERSION,
    uiPrefs: {
      version: 1,
      values: { editorFontSize: 16, autoSaveEnabled: true },
    },
    appConfig: {
      start_minimized: "1",
      web_clip_jina_key: "secret",
    },
    aiModels: [
      {
        name: "deepseek",
        provider: "deepseek",
        api_url: "https://api.deepseek.com",
        api_key: "sk",
        model_id: "deepseek-chat",
      },
    ],
    syncBackends: [
      {
        kind: "webdav",
        name: "网盘",
        config: { url: "https://x", username: "u", password: "p" },
      },
      {
        kind: "local",
        name: "本机",
        config: { path: "D:/kb" },
      },
    ],
    asrConfig: {
      provider: "dashscope",
      apiKey: "",
      model: "paraformer-v2",
      region: "beijing",
      enabled: false,
      correctionEnabled: false,
    },
  };

  it("按分类输出条数与密钥标记", () => {
    const items = describeBackup(data);
    expect(items.map((i) => i.category)).toEqual([
      "uiPrefs",
      "appConfig",
      "aiModels",
      "syncBackends",
      "asrConfig",
    ]);
    expect(items[0].count).toBe(2);
    expect(items[1].count).toBe(2);
    expect(items[1].hasSecrets).toBe(true);
    expect(items[2].count).toBe(1);
    expect(items[2].hasSecrets).toBe(true);
    expect(items[3].count).toBe(2);
    expect(items[3].hasSecrets).toBe(true);
    // 本地同步源路径提示
    expect(items[3].warnings.join("")).toContain("本地同步源");
    expect(items[4].hasSecrets).toBe(false);
  });

  it("旧版 featureToggles 合并进应用行为分类", () => {
    const items = describeBackup({
      featureToggles: { enabledViews: ["daily"] },
    });
    expect(items).toHaveLength(1);
    expect(items[0].category).toBe("appConfig");
    expect(items[0].count).toBe(1);
    expect(items[0].warnings.join("")).toContain("旧版功能开关");
  });
});

describe("pickBackup", () => {
  const data: BundleData = {
    backupVersion: 1,
    uiPrefs: { version: 1, values: { a: true } },
    appConfig: { start_minimized: "1" },
    featureToggles: { enabledViews: ["daily"] },
    aiModels: [],
    syncBackends: [],
    asrConfig: {
      provider: "dashscope",
      apiKey: "",
      model: "m",
      region: "beijing",
      enabled: false,
      correctionEnabled: false,
    },
  };

  it("只保留勾选分类", () => {
    const picked = pickBackup(data, ["uiPrefs", "aiModels"]);
    expect(picked.uiPrefs).toEqual(data.uiPrefs);
    expect(picked.aiModels).toEqual([]);
    expect(picked.appConfig).toBeUndefined();
    expect(picked.asrConfig).toBeUndefined();
  });

  it("应用行为分类同时带出旧版功能开关", () => {
    const picked = pickBackup(data, ["appConfig"]);
    expect(picked.appConfig).toEqual({ start_minimized: "1" });
    expect(picked.featureToggles).toEqual({ enabledViews: ["daily"] });
  });

  it("全选时保留全部现存字段", () => {
    const picked = pickBackup(data, ALL_BACKUP_CATEGORIES);
    expect(Object.keys(picked).sort()).toEqual(
      [
        "aiModels",
        "appConfig",
        "asrConfig",
        "backupVersion",
        "featureToggles",
        "syncBackends",
        "uiPrefs",
      ].sort(),
    );
  });
});

describe("validateBackupData", () => {
  it("旧 bundle（无 uiPrefs/appConfig）合法", () => {
    expect(
      validateBackupData({
        aiModels: [],
        asrConfig: {
          provider: "dashscope",
          apiKey: "",
          model: "m",
          region: "beijing",
          enabled: false,
          correctionEnabled: false,
        },
      }),
    ).toBeNull();
  });

  it("结构损坏返回原因", () => {
    expect(
      validateBackupData({
        uiPrefs: { version: 1, values: [] as unknown as Record<string, unknown> },
      }),
    ).toContain("界面偏好");
    expect(
      validateBackupData({
        appConfig: { start_minimized: 1 as unknown as string },
      }),
    ).toContain("不是字符串");
    expect(
      validateBackupData({ aiModels: {} as unknown as [] }),
    ).toContain("模型服务");
  });
});

describe("normalizePortableUiPrefs", () => {
  it("未知键 / 非法值跳过，合法值按 setter 规则 clamp", () => {
    const result = normalizePortableUiPrefs({
      editorFontSize: 999,
      notesPageSize: 0,
      editorRuleLines: "bogus",
      customBgDim: 2,
      customAccent: "#abc",
      lightTheme: "dark-ocean",
      sidePanelWidth: 300,
      notesListColumnPrefs: { hidden: ["tags", "nope"], widths: {} },
    });
    expect(result.values.editorFontSize).toBe(22);
    expect(result.values.notesPageSize).toBe(1);
    expect(result.values.customBgDim).toBe(1);
    expect(result.values.customAccent).toBe("#abc");
    expect(result.values.lightTheme).toBe("dark-ocean");
    expect(result.values.notesListColumnPrefs).toEqual({
      hidden: ["tags"],
      widths: {},
    });
    expect(result.values).not.toHaveProperty("editorRuleLines");
    expect(result.values).not.toHaveProperty("sidePanelWidth");
    expect(result.skipped.sort()).toEqual(
      ["editorRuleLines", "sidePanelWidth"].sort(),
    );
  });

  it("排除键即使出现在输入里也不会被恢复", () => {
    const result = normalizePortableUiPrefs({
      customBgImage: "C:/bg.png",
      uiScale: 1.5,
      recentSearches: ["x"],
      notesHeadingFolded: { 1: ["a"] },
    });
    expect(result.values).toEqual({});
    expect(result.skipped).toHaveLength(4);
  });
});
