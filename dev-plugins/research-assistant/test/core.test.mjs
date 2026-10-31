import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const code = fs.readFileSync(new URL("../main.js", import.meta.url), "utf8");
const module = { exports: {} };
vm.runInNewContext(code, {
  module,
  exports: module.exports,
  console,
  setTimeout,
  clearTimeout,
  Date,
  Math,
  JSON,
  Intl,
  Promise,
  URL
});

const core = module.exports.__test;

test("normalizeDoi 去除 DOI 前缀", () => {
  assert.equal(
    core.normalizeDoi("https://doi.org/10.1000/ABC"),
    "10.1000/abc"
  );
  assert.equal(core.normalizeDoi("doi: 10.1000/xyz"), "10.1000/xyz");
  assert.equal(core.normalizeDoi(""), "");
});

test("paperIdentity 优先 DOI，其次标题+年份", () => {
  const withDoi = core.paperIdentity({ doi: "10.1/X", title: "A" });
  assert.equal(withDoi, "doi:10.1/x");
  const withoutDoi = core.paperIdentity({ title: "A Study!", year: 2024 });
  assert.equal(withoutDoi, "title:astudy:2024");
  assert.ok(core.samePaper({ doi: "10.1/X" }, { doi: "https://doi.org/10.1/x" }));
});

test("splitKeywords 与 buildQuery", () => {
  assert.equal(
    JSON.stringify(core.splitKeywords("薄壁件, 加工变形；预测")),
    JSON.stringify(["薄壁件", "加工变形", "预测"])
  );
  assert.equal(
    JSON.stringify(core.splitKeywords("复杂导管、干涉矩阵、顺序规划")),
    JSON.stringify(["复杂导管", "干涉矩阵", "顺序规划"])
  );
  assert.equal(core.buildQuery("机械制造", "薄壁件, 预测"), "机械制造 薄壁件 预测");
});

test("dedupePapers 合并重复论文并保留最大引用量", () => {
  const papers = [
    {
      title: "Paper A",
      doi: "10.1/a",
      year: 2024,
      citedByCount: 10,
      abstractText: "short",
      sources: [{ name: "Crossref", url: "https://a" }]
    },
    {
      title: "Paper A (duplicate)",
      doi: "10.1/a",
      year: 2024,
      citedByCount: 50,
      abstractText: "a much longer abstract",
      sources: [{ name: "Europe PMC", url: "https://b" }]
    }
  ];
  const result = core.dedupePapers(papers, ["paper"], 2026);
  assert.equal(result.length, 1);
  assert.equal(result[0].citedByCount, 50);
  assert.equal(result[0].abstractText, "a much longer abstract");
  assert.equal(
    JSON.stringify(result[0].sources.map((item) => item.name).sort()),
    JSON.stringify(["Crossref", "Europe PMC"])
  );
  assert.ok(result[0].frontierScore >= 0 && result[0].frontierScore <= 100);
});

test("computeFrontierScore 新论文应高于很老的论文", () => {
  const base = {
    title: "deep learning for manufacturing",
    abstractText: "deep learning",
    sources: [{ name: "Crossref" }],
    citedByCount: 20
  };
  const fresh = core.computeFrontierScore(
    Object.assign({}, base, { year: 2026 }),
    ["deep", "learning"],
    2026
  );
  const old = core.computeFrontierScore(
    Object.assign({}, base, { year: 2000 }),
    ["deep", "learning"],
    2026
  );
  assert.ok(fresh > old);
});

test("renderMarkdown 转义脚本并渲染标题与表格", () => {
  const html = core.renderMarkdown(
    "# 标题\n\n<script>alert(1)</script>\n\n| A | B |\n|---|---|\n| 1 | 2 |"
  );
  assert.ok(html.includes("<h1>标题</h1>"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("<table"));
});

test("parseJsonLoose 兼容代码块与前后说明", () => {
  const parsed = core.parseJsonLoose(
    '说明文字\n```json\n{"decision":"recommended","confidence":0.8}\n```'
  );
  assert.equal(parsed.decision, "recommended");
  assert.equal(parsed.confidence, 0.8);
});

test("computeRelevance 标题命中高于仅摘要命中", () => {
  const terms = ["assembly", "interference"];
  const titleHit = core.computeRelevance(
    { title: "Assembly interference matrix", abstractText: "", sourceRank: 0 },
    terms
  );
  const abstractHit = core.computeRelevance(
    { title: "Other paper", abstractText: "assembly interference", sourceRank: 0 },
    terms
  );
  assert.ok(titleHit > abstractHit);
  assert.ok(titleHit > 0 && titleHit <= 1);
});

test("sanitizeExpansion 清洗英文扩展", () => {
  const result = core.sanitizeExpansion({
    englishQuery: "  complex tube assembly sequence planning ",
    englishKeywords: ["assembly", "assembly", "a", "interference matrix"],
    alternateQueries: ["tube routing", "tube routing"],
  });
  assert.equal(result.englishQuery, "complex tube assembly sequence planning");
  assert.equal(result.englishKeywords.length, 3);
  assert.equal(result.alternateQueries.length, 1);
});

test("buildSourceQueries 英文库缺少英文时跳过", () => {
  assert.equal(core.queryHasCjk("导管装配"), true);
  assert.equal(core.queryHasCjk("assembly planning"), false);
  assert.equal(
    JSON.stringify(
      core.buildSourceQueries("arxiv", {
        query: "导管装配",
        englishQuery: "",
        alternateQueries: [],
      })
    ),
    JSON.stringify([])
  );
  assert.equal(
    JSON.stringify(
      core.buildSourceQueries("arxiv", {
        query: "导管装配",
        englishQuery: "tube assembly",
        alternateQueries: [],
      })
    ),
    JSON.stringify(["tube assembly"])
  );
  assert.equal(
    JSON.stringify(
      core.buildSourceQueries("crossref", {
        query: "导管装配",
        englishQuery: "tube assembly",
        alternateQueries: [],
      })
    ),
    JSON.stringify(["导管装配", "tube assembly"])
  );
});

test("formatReferenceEntry 生成 GB/T 风格条目", () => {
  const entry = core.formatReferenceEntry(
    {
      title: "Assembly sequence planning",
      authors: ["Li J.", "Wang C.", "Niu C."],
      year: 2026,
      venue: "Journal of Manufacturing",
      workType: "journal-article",
      doi: "10.1000/xyz",
      url: "https://doi.org/10.1000/xyz",
    },
    1
  );
  assert.ok(entry.startsWith("[1] Li J., Wang C., Niu C. "));
  assert.ok(entry.includes("[J]"));
  assert.ok(entry.includes("DOI: 10.1000/xyz"));
});

test("formatReferenceEntry 超过三位作者追加等", () => {
  const entry = core.formatReferenceEntry(
    {
      title: "Test",
      authors: ["A", "B", "C", "D"],
      year: 2024,
      venue: "Venue",
      workType: "journal-article",
    },
    1
  );
  assert.ok(entry.includes("A, B, C, et al."));
});

test("buildReferenceIndex 生成编号与 BibTeX", () => {
  const items = [
    {
      title: "Paper A",
      authors: ["Alice"],
      year: 2024,
      venue: "Journal A",
      workType: "journal-article",
      doi: "10.1/a",
    },
    {
      title: "Paper B",
      authors: ["Bob"],
      year: 2023,
      venue: "Conference B",
      workType: "proceedings-article",
    },
  ];
  const gbt = core.buildReferenceIndex(items, "gbt7714");
  assert.ok(gbt.includes("[1]"));
  assert.ok(gbt.includes("[2]"));
  assert.ok(gbt.includes("[C]"));
  const bib = core.buildReferenceIndex(items, "bibtex");
  assert.ok(bib.includes("@article{alice2024paper"));
  assert.ok(bib.includes("@inproceedings{bob2023paper"));
});

test("bibtexKey 与空列表", () => {
  assert.equal(
    core.bibtexKey({ authors: ["Li J."], year: 2026, title: "Assembly" }, 1),
    "lij2026assembly"
  );
  assert.equal(core.buildReferenceIndex([], "gbt7714"), "");
});

test("hashString 稳定且随输入变化", () => {
  assert.equal(core.hashString("abc"), core.hashString("abc"));
  assert.notEqual(core.hashString("abc"), core.hashString("abd"));
});

test("sanitizeExtraction 清洗主题、关键词与候选项", () => {
  const project = { title: "课题标题", keywords: "课题关键词", field: "机械" };
  const result = core.sanitizeExtraction(
    {
      topic: "  导管装配规划  ",
      topicCandidates: ["候选一", "候选一", "候选二"],
      keywords: ["装配", "装配", "assembly", "a", "this-is-a-very-long-keyword-over-30-chars"],
      researchQuestions: ["问题一", "问题一"],
      methods: "方法一",
      confidence: 1.8,
      warnings: ["警告"]
    },
    project
  );
  assert.equal(result.topic, "导管装配规划");
  assert.equal(result.keywords[0], "装配");
  assert.equal(result.keywords.filter((item) => item === "装配").length, 1);
  assert.ok(!result.keywords.includes("a"));
  assert.equal(result.researchQuestions.length, 1);
  assert.equal(result.methods[0], "方法一");
  assert.equal(result.confidence, 1);
  assert.equal(
    JSON.stringify(result.topicCandidates.slice(0, 2)),
    JSON.stringify(["导管装配规划", "候选一"])
  );
});

test("sanitizeExtraction 无关键词时回退课题关键词", () => {
  const result = core.sanitizeExtraction(
    { topic: "", keywords: [] },
    { title: "课题", keywords: "薄壁件, 加工变形" }
  );
  assert.equal(result.topic, "课题");
  assert.equal(result.keywords[0], "薄壁件");
});

test("localExtraction 返回本地兜底结果", () => {
  const result = core.localExtraction(
    [{ title: "论文 A", text: "thin wall machining deformation thin wall" }],
    { title: "导管装配", keywords: "导管, 装配", field: "机械" }
  );
  assert.equal(result.evaluationMode, "local_fallback");
  assert.equal(result.topic, "导管装配");
  assert.ok(result.keywords.includes("导管"));
  assert.ok(result.keywords.includes("thin"));
  assert.ok(result.warnings.length > 0);
});

test("truncateExtractionSources 限制来源数量与单源长度", () => {
  const sources = [];
  for (let i = 0; i < 20; i += 1) {
    sources.push({ kind: "note", id: i, title: "S" + i, identity: "note:" + i, text: "x".repeat(5000) });
  }
  const result = core.truncateExtractionSources(sources);
  assert.equal(result.length, 12);
  result.forEach((source) => assert.ok(source.chars <= 12000));
});

test("extractionCacheKey 稳定且随内容变化", () => {
  const a = core.extractionCacheKey(1, [{ identity: "note:1", text: "abc" }], 2);
  const b = core.extractionCacheKey(1, [{ identity: "note:1", text: "abc" }], 2);
  const c = core.extractionCacheKey(1, [{ identity: "note:1", text: "abcd" }], 2);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("cacheIsUsable 忽略全部来源不可用的缓存", () => {
  assert.equal(core.cacheIsUsable(null), false);
  assert.equal(
    core.cacheIsUsable({
      result: {
        sources: [
          { available: false },
          { available: false }
        ]
      }
    }),
    false
  );
  assert.equal(
    core.cacheIsUsable({
      result: {
        sources: [{ available: true }, { available: false }]
      }
    }),
    true
  );
  assert.equal(core.cacheIsUsable({ result: { sources: [] } }), true);
});
