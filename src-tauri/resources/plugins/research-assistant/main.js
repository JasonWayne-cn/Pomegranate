/**
 * AI 助研插件
 *
 * 设计约束：
 * - 纯插件：不新增宿主数据表、不新增 Rust 命令（HTTP 代理为通用能力）
 * - 数据存 plugin_settings（宿主自动按 pluginId 隔离）
 * - UI 用原生 DOM + 宿主 CSS 变量，不依赖 React / Ant Design
 *
 * module.exports 约定：{ onLoad, onUnload }
 */
(function () {
  "use strict";

  var PLUGIN_ID = "research-assistant";
  var STORAGE_VERSION = 1;
  var DEFAULT_CACHE_HOURS = 24;
  var DEFAULT_MAX_RESULTS = 30;
  var MAX_PDF_FILES = 5;
  var MAX_PDF_CHARS = 30000;
  var MAX_INPUT_CHARS = 30000;

  var ALL_SOURCES = [
    { id: "crossref", name: "Crossref", color: "blue" },
    { id: "europepmc", name: "Europe PMC", color: "cyan" },
    { id: "arxiv", name: "arXiv", color: "volcano" },
    { id: "dblp", name: "DBLP", color: "geekblue" },
    { id: "pubmed", name: "PubMed", color: "green" },
    { id: "semanticscholar", name: "Semantic Scholar", color: "purple" }
  ];

  var WORK_TYPES = {
    "journal-article": "期刊论文",
    "proceedings-article": "会议论文",
    "posted-content": "预印本",
    "book-chapter": "书籍章节",
    dissertation: "学位论文",
    report: "研究报告"
  };

  var SYSTEM_RULES =
    "你是一名面向高校科研场景的学术研究助手。必须遵守：\n" +
    "1. 不得虚构论文、作者、期刊、年份、DOI、基金号或实验数据；无法确认的信息标注“待检索验证”。\n" +
    "2. 区分事实、推断与建议，结论要可核验。\n" +
    "3. 使用规范、克制的中文学术表达。\n" +
    "4. 只输出 Markdown 正文，不要寒暄、不要解释你在做什么。";

  // ───────────────────────── 工具函数 ─────────────────────────

  function nowIso() {
    return new Date().toISOString();
  }

  function uid(prefix) {
    return (
      (prefix || "id") +
      "-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  function first(value) {
    if (Array.isArray(value)) return value.length ? value[0] : "";
    return value || "";
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function stripTags(value) {
    return String(value || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function truncate(value, max) {
    var text = String(value || "");
    if (text.length <= max) return text;
    return text.slice(0, max) + "\n\n……（内容过长，已截断）";
  }

  function normalizeDoi(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
      .replace(/^doi:\s*/, "");
  }

  function normalizeTitle(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }

  function paperIdentity(paper) {
    var doi = normalizeDoi(paper && paper.doi);
    if (doi) return "doi:" + doi;
    return (
      "title:" +
      normalizeTitle(paper && paper.title) +
      ":" +
      String((paper && paper.year) || "")
    );
  }

  function samePaper(left, right) {
    return paperIdentity(left) === paperIdentity(right);
  }

  function splitKeywords(value) {
    return String(value || "")
      .split(/[,，;；、|｜\r\n\s]+/)
      .map(function (item) {
        return item.replace(/^[\s,，;；、|｜]+|[\s,，;；、|｜]+$/g, "");
      })
      .filter(Boolean);
  }

  function queryHasCjk(value) {
    return /[\u3400-\u9fff]/.test(String(value || ""));
  }

  function queryHasAscii(value) {
    return /[A-Za-z]{2,}/.test(String(value || ""));
  }

  function splitList(value) {
    return String(value || "")
      .split(/[,，;；\n]+/)
      .map(function (item) {
        return item.trim();
      })
      .filter(Boolean);
  }

  function buildQuery(topic, keywords) {
    return [String(topic || "").trim()]
      .concat(splitKeywords(keywords))
      .filter(Boolean)
      .join(" ");
  }

  function cacheIsUsable(cached) {
    if (!cached || !cached.result) return false;
    var sources = asArray(cached.result.sources);
    if (sources.length > 0) {
      var anyAvailable = sources.some(function (source) {
        return !!source.available;
      });
      if (!anyAvailable) return false;
    }
    return true;
  }

  function hashString(value) {
    var hash = 0;
    var text = String(value || "");
    for (var i = 0; i < text.length; i += 1) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }
    return "h" + Math.abs(hash).toString(36);
  }

  function currentYear() {
    return new Date().getFullYear();
  }

  function formatNumber(value) {
    var num = Number(value || 0);
    try {
      return new Intl.NumberFormat("zh-CN").format(num);
    } catch (e) {
      return String(num);
    }
  }

  function workTypeLabel(type) {
    return WORK_TYPES[type] || type || "论文";
  }

  function compactText(value, max) {
    var text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length <= max) return text;
    return text.slice(0, max) + "…";
  }

  function parseJsonLoose(text) {
    var raw = String(text || "").trim();
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    var start = raw.indexOf("{");
    var end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
    return JSON.parse(raw);
  }

  function computeRelevance(paper, terms) {
    var termList = asArray(terms)
      .map(function (term) {
        return String(term || "").toLowerCase();
      })
      .filter(function (term) {
        return term.length >= 2;
      });
    if (!termList.length) return 0;
    var title = String(paper.title || "").toLowerCase();
    var abstract = String(paper.abstractText || "").toLowerCase();
    var titleHits = 0;
    var abstractHits = 0;
    termList.forEach(function (term) {
      if (title.indexOf(term) >= 0) titleHits += 1;
      else if (abstract.indexOf(term) >= 0) abstractHits += 1;
    });
    var lexical = clamp(
      (titleHits * 2 + abstractHits) / (termList.length * 2),
      0,
      1
    );
    var rankScore = 0;
    if (paper.sourceRank !== null && paper.sourceRank !== undefined) {
      rankScore = clamp(1 - Number(paper.sourceRank) / 20, 0, 1);
    }
    return clamp(lexical * 0.8 + rankScore * 0.2, 0, 1);
  }

  function computeFrontierScore(paper, terms, nowYear) {
    var year = Number(paper.year) || 0;
    var recency = year ? clamp(1 - (nowYear - year) / 6, 0, 1) : 0;
    var cited = Number(paper.citedByCount) || 0;
    var citation = clamp(Math.log(cited + 1) / Math.log(1000), 0, 1);
    var sourceCount = clamp(asArray(paper.sources).length / 3, 0, 1);
    var relevance = computeRelevance(paper, terms);
    return Math.round(
      100 *
        (0.55 * relevance +
          0.2 * recency +
          0.1 * citation +
          0.15 * sourceCount)
    );
  }

  function buildRankReason(paper, terms, nowYear) {
    var year = Number(paper.year) || 0;
    var age = year ? nowYear - year : 99;
    var title = String(paper.title || "").toLowerCase();
    var abstract = String(paper.abstractText || "").toLowerCase();
    var hits = asArray(terms).filter(function (term) {
      var value = String(term || "").toLowerCase();
      return value && (title.indexOf(value) >= 0 || abstract.indexOf(value) >= 0);
    });
    var parts = [];
    parts.push("相关度 " + Math.round(computeRelevance(paper, terms) * 100) + "%");
    if (year) parts.push("发表于 " + year + "（" + age + " 年内）");
    parts.push("引用 " + formatNumber(paper.citedByCount || 0));
    parts.push("收录于 " + (asArray(paper.sources).length || 0) + " 个来源");
    if (hits.length) parts.push("命中检索词：" + hits.slice(0, 5).join("、"));
    return parts.join("；");
  }

  function dedupePapers(papers, terms, nowYear) {
    var map = {};
    var order = [];
    asArray(papers).forEach(function (paper) {
      if (!paper || !paper.title) return;
      var key = paperIdentity(paper);
      if (!map[key]) {
        map[key] = paper;
        order.push(key);
      } else {
        var current = map[key];
        current.sources = mergeSources(current.sources, paper.sources);
        current.citedByCount = Math.max(
          Number(current.citedByCount) || 0,
          Number(paper.citedByCount) || 0
        );
        if (
          String(paper.abstractText || "").length >
          String(current.abstractText || "").length
        ) {
          current.abstractText = paper.abstractText;
        }
        if (!current.doi && paper.doi) current.doi = paper.doi;
        if (!current.url && paper.url) current.url = paper.url;
        if (!current.venue && paper.venue) current.venue = paper.venue;
        if (!current.publisher && paper.publisher) current.publisher = paper.publisher;
        if (paper.sourceRank !== null && paper.sourceRank !== undefined) {
          current.sourceRank =
            current.sourceRank === null || current.sourceRank === undefined
              ? Number(paper.sourceRank)
              : Math.min(Number(current.sourceRank), Number(paper.sourceRank));
        }
      }
    });
    return order.map(function (key) {
      var paper = map[key];
      paper.relevanceScore = Math.round(computeRelevance(paper, terms) * 100);
      paper.frontierScore = computeFrontierScore(paper, terms, nowYear);
      paper.rankReason = buildRankReason(paper, terms, nowYear);
      return paper;
    });
  }

  function mergeSources(left, right) {
    var map = {};
    asArray(left)
      .concat(asArray(right))
      .forEach(function (source) {
        if (!source || !source.name) return;
        if (!map[source.name]) {
          map[source.name] = { name: source.name, url: source.url || "" };
        } else if (!map[source.name].url && source.url) {
          map[source.name].url = source.url;
        }
      });
    return Object.keys(map).map(function (key) {
      return map[key];
    });
  }

  // ───────────────────────── Markdown ─────────────────────────

  function renderInline(text) {
    var value = escapeHtml(text);
    value = value.replace(/`([^`]+)`/g, "<code>$1</code>");
    value = value.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    value = value.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, function (
      _m,
      label,
      url
    ) {
      return (
        '<a href="' +
        escapeHtml(url) +
        '" target="_blank" rel="noreferrer">' +
        escapeHtml(label) +
        "</a>"
      );
    });
    return value;
  }

  function renderMarkdown(markdown) {
    var lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    var html = [];
    var inCode = false;
    var codeLines = [];
    var listType = "";
    var tableRows = [];

    function closeList() {
      if (listType) {
        html.push("</" + listType + ">");
        listType = "";
      }
    }

    function flushTable() {
      if (!tableRows.length) return;
      var rows = tableRows.filter(function (row) {
        return !/^\s*\|?[\s:|-]+\|?\s*$/.test(row);
      });
      html.push('<table class="ra-md-table">');
      rows.forEach(function (row, index) {
        var cells = row
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|");
        html.push("<tr>");
        cells.forEach(function (cell) {
          var tag = index === 0 ? "th" : "td";
          html.push("<" + tag + ">" + renderInline(cell.trim()) + "</" + tag + ">");
        });
        html.push("</tr>");
      });
      html.push("</table>");
      tableRows = [];
    }

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];

      if (/^\s*```/.test(line)) {
        if (inCode) {
          html.push("<pre class=\"ra-md-code\"><code>" + escapeHtml(codeLines.join("\n")) + "</code></pre>");
          codeLines = [];
          inCode = false;
        } else {
          closeList();
          flushTable();
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        codeLines.push(line);
        continue;
      }

      if (/^\s*\|.*\|\s*$/.test(line)) {
        closeList();
        tableRows.push(line);
        continue;
      }
      flushTable();

      if (/^\s*$/.test(line)) {
        closeList();
        continue;
      }
      var heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeList();
        var level = heading[1].length;
        html.push("<h" + level + ">" + renderInline(heading[2]) + "</h" + level + ">");
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        closeList();
        html.push("<blockquote>" + renderInline(line.replace(/^\s*>\s?/, "")) + "</blockquote>");
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        if (listType !== "ul") {
          closeList();
          html.push("<ul>");
          listType = "ul";
        }
        html.push("<li>" + renderInline(line.replace(/^\s*[-*]\s+/, "")) + "</li>");
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        if (listType !== "ol") {
          closeList();
          html.push("<ol>");
          listType = "ol";
        }
        html.push("<li>" + renderInline(line.replace(/^\s*\d+\.\s+/, "")) + "</li>");
        continue;
      }
      if (/^\s*---+\s*$/.test(line)) {
        closeList();
        html.push("<hr />");
        continue;
      }
      closeList();
      html.push("<p>" + renderInline(line) + "</p>");
    }
    if (inCode) {
      html.push("<pre class=\"ra-md-code\"><code>" + escapeHtml(codeLines.join("\n")) + "</code></pre>");
    }
    closeList();
    flushTable();
    return html.join("");
  }

  // ───────────────────────── 存储 ─────────────────────────

  function createStorage(app) {
    var queue = Promise.resolve();
    return {
      get: function (key, fallback) {
        return app.settings
          .get(key)
          .then(function (value) {
            return value === undefined || value === null ? fallback : value;
          })
          .catch(function () {
            return fallback;
          });
      },
      set: function (key, value) {
        queue = queue
          .then(function () {
            return app.settings.set(key, value);
          })
          .catch(function (error) {
            console.warn("[research] 保存失败:", key, error);
          });
        return queue;
      }
    };
  }

  function activeProject(state) {
    var id = state.meta.activeProjectId;
    if (!id) return null;
    var list = state.meta.projects || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function createInitialState() {
    return {
      meta: { version: STORAGE_VERSION, activeProjectId: null, projects: [] },
      settings: {
        cacheHours: DEFAULT_CACHE_HOURS,
        maxResults: DEFAULT_MAX_RESULTS,
        autoExpandQuery: true,
        sources: ALL_SOURCES.map(function (source) {
          return source.id;
        }),
        modelId: null
      },
      literature: [],
      outputs: [],
      activeTab: "overview",
      search: null,
      searchFilters: {
        source: "",
        type: "",
        minYear: 0,
        minCitations: 0,
        sort: "relevance"
      },
      selectedIds: {},
      recommendations: {},
      analysis: null,
      analysisFiles: [],
      writing: { mode: "frontier", topic: "", content: "", extra: "", result: "", busy: false },
      extractHistory: [],
      models: [],
      busy: "",
      error: ""
    };
  }

  async function loadState(app, storage) {
    var state = createInitialState();
    var meta = await storage.get("meta", state.meta);
    if (meta && typeof meta === "object") {
      state.meta = {
        version: STORAGE_VERSION,
        activeProjectId: meta.activeProjectId || null,
        projects: asArray(meta.projects)
      };
    }
    var settings = await storage.get("settings", {});
    if (settings && typeof settings === "object") {
      state.settings = Object.assign(state.settings, settings);
      state.settings.sources = asArray(state.settings.sources).filter(Boolean);
    }
    state.extractHistory = asArray(await storage.get("extractHistory", []));
    try {
      state.models = await app.ai.listModels();
    } catch (error) {
      state.models = [];
    }
    var project = activeProject(state);
    if (!project && state.meta.projects.length) {
      project = state.meta.projects[0];
      state.meta.activeProjectId = project.id;
    }
    if (project) {
      state.literature = asArray(await storage.get("lit:" + project.id, []));
      state.outputs = asArray(await storage.get("out:" + project.id, []));
    }
    return state;
  }

  // ───────────────────────── HTTP / 论文源 ─────────────────────────

  async function httpGetText(app, url) {
    if (app.http && typeof app.http.request === "function") {
      var response = await app.http.request({ url: url, method: "GET" });
      return response.body;
    }
    var res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      throw new Error("请求失败 HTTP " + res.status);
    }
    return res.text();
  }

  async function httpGetJson(app, url) {
    var text = await httpGetText(app, url);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error("返回内容不是合法 JSON");
    }
  }

  function makePaper(partial) {
    return {
      id: partial.id || uid("paper"),
      title: partial.title || "",
      authors: asArray(partial.authors).filter(Boolean),
      year: Number(partial.year) || null,
      publicationDate: partial.publicationDate || null,
      venue: partial.venue || "",
      publisher: partial.publisher || "",
      workType: partial.workType || "journal-article",
      citedByCount: Number(partial.citedByCount) || 0,
      doi: partial.doi || "",
      url: partial.url || "",
      sources: asArray(partial.sources),
      abstractText: stripTags(partial.abstractText || ""),
      highlights: asArray(partial.highlights),
      sourceRank:
        partial.sourceRank === null || partial.sourceRank === undefined
          ? null
          : Number(partial.sourceRank)
    };
  }

  function crossrefAuthor(author) {
    if (!author) return "";
    return [author.given, author.family].filter(Boolean).join(" ");
  }

  async function searchCrossref(app, query, fromYear, limit) {
    var url =
      "https://api.crossref.org/works?query.bibliographic=" +
      encodeURIComponent(query) +
      "&sort=relevance&order=desc&filter=from-pub-date:" +
      fromYear +
      "-01-01&rows=" +
      limit +
      "&select=DOI,title,author,issued,container-title,publisher,type,is-referenced-by-count,URL,abstract";
    var data = await httpGetJson(app, url);
    var items = (data.message && data.message.items) || [];
    return items.map(function (item, index) {
      var doi = item.DOI || "";
      var itemUrl = item.URL || (doi ? "https://doi.org/" + doi : "");
      return makePaper({
        title: first(item.title),
        authors: asArray(item.author).map(crossrefAuthor),
        year: item.issued &&
          item.issued["date-parts"] &&
          item.issued["date-parts"][0] &&
          item.issued["date-parts"][0][0],
        venue: first(item["container-title"]),
        publisher: item.publisher || "",
        workType: item.type || "journal-article",
        citedByCount: item["is-referenced-by-count"] || 0,
        doi: doi,
        url: itemUrl,
        abstractText: item.abstract || "",
        sources: [{ name: "Crossref", url: itemUrl }],
        sourceRank: index
      });
    });
  }

  async function searchEuropePmc(app, query, fromYear, limit) {
    var fullQuery =
      query +
      " AND (FIRST_PDATE:[" +
      fromYear +
      "-01-01 TO 2100-12-31])";
    var url =
      "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=" +
      encodeURIComponent(fullQuery) +
      "&format=json&pageSize=" +
      limit +
      "&resultType=core";
    var data = await httpGetJson(app, url);
    var items = (data.resultList && data.resultList.result) || [];
    return items.map(function (item, index) {
      var doi = item.doi || "";
      var itemUrl = doi
        ? "https://doi.org/" + doi
        : "https://europepmc.org/article/" +
          (item.source || "MED") +
          "/" +
          (item.id || "");
      return makePaper({
        title: stripTags(item.title || ""),
        authors: String(item.authorString || "")
          .split(",")
          .map(function (name) {
            return name.trim();
          })
          .filter(Boolean),
        year: Number(item.pubYear) || null,
        venue: item.journalTitle || item.bookOrReportTitle || "",
        workType: item.pubType || "journal-article",
        citedByCount: item.citedByCount || 0,
        doi: doi,
        url: itemUrl,
        abstractText: item.abstractText || "",
        sources: [{ name: "Europe PMC", url: itemUrl }],
        sourceRank: index
      });
    });
  }

  async function searchArxiv(app, query, fromYear, limit) {
    var url =
      "https://export.arxiv.org/api/query?search_query=all:" +
      encodeURIComponent(query) +
      "&start=0&max_results=" +
      limit +
      "&sortBy=submittedDate&sortOrder=descending";
    var text = await httpGetText(app, url);
    if (typeof DOMParser === "undefined") {
      throw new Error("当前环境不支持 XML 解析");
    }
    var doc = new DOMParser().parseFromString(text, "application/xml");
    var entries = doc.getElementsByTagName("entry");
    var papers = [];
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      var published = entry.getElementsByTagName("published")[0];
      var year = published
        ? Number(String(published.textContent || "").slice(0, 4))
        : null;
      if (year && year < fromYear) continue;
      var title = entry.getElementsByTagName("title")[0];
      var summary = entry.getElementsByTagName("summary")[0];
      var idNode = entry.getElementsByTagName("id")[0];
      var arxivUrl = idNode ? String(idNode.textContent || "").trim() : "";
      var authors = [];
      var authorNodes = entry.getElementsByTagName("author");
      for (var j = 0; j < authorNodes.length; j += 1) {
        var nameNode = authorNodes[j].getElementsByTagName("name")[0];
        if (nameNode) authors.push(String(nameNode.textContent || "").trim());
      }
      var doiNode = entry.getElementsByTagName("arxiv:doi")[0];
      papers.push(
        makePaper({
          title: stripTags(title ? title.textContent : ""),
          authors: authors,
          year: year,
          publicationDate: published ? published.textContent : null,
          venue: "arXiv",
          workType: "posted-content",
          doi: doiNode ? String(doiNode.textContent || "").trim() : "",
          url: arxivUrl,
          abstractText: summary ? summary.textContent : "",
          sources: [{ name: "arXiv", url: arxivUrl }],
          sourceRank: i
        })
      );
    }
    return papers;
  }

  function dblpAuthors(info) {
    var node = info && info.authors && info.authors.author;
    return asArray(node)
      .map(function (author) {
        if (!author) return "";
        return typeof author === "string" ? author : author.text || author["#text"] || "";
      })
      .filter(Boolean);
  }

  async function searchDblp(app, query, fromYear, limit) {
    var url =
      "https://dblp.org/search/publ/api?q=" +
      encodeURIComponent(query) +
      "&format=json&h=" +
      limit;
    var data = await httpGetJson(app, url);
    var hits =
      (data.result && data.result.hits && data.result.hits.hit) || [];
    return asArray(hits)
      .map(function (hit, index) {
        var info = hit.info || {};
        var year = Number(info.year) || null;
        if (year && year < fromYear) return null;
        var doi = info.doi || "";
        var itemUrl = info.ee || info.url || "";
        return makePaper({
          title: stripTags(info.title || ""),
          authors: dblpAuthors(info),
          year: year,
          venue: info.venue || "",
          workType: info.type === "Conference and Workshop Papers"
            ? "proceedings-article"
            : "journal-article",
          doi: doi,
          url: itemUrl,
          sources: [{ name: "DBLP", url: itemUrl }],
          sourceRank: index
        });
      })
      .filter(Boolean);
  }

  async function searchPubMed(app, query, fromYear, limit) {
    var term = query + " AND (" + fromYear + ":3000[dp])";
    var searchUrl =
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=" +
      limit +
      "&sort=date&term=" +
      encodeURIComponent(term);
    var searchData = await httpGetJson(app, searchUrl);
    var ids =
      (searchData.esearchresult && searchData.esearchresult.idlist) || [];
    if (!ids.length) return [];
    var summaryUrl =
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=" +
      encodeURIComponent(ids.join(","));
    var summary = await httpGetJson(app, summaryUrl);
    var result = summary.result || {};
    return ids
      .map(function (id, index) {
        var item = result[id];
        if (!item) return null;
        var doi = "";
        asArray(item.articleids).forEach(function (articleId) {
          if (articleId.idtype === "doi") doi = articleId.value || "";
        });
        var itemUrl = "https://pubmed.ncbi.nlm.nih.gov/" + id + "/";
        return makePaper({
          title: stripTags(item.title || ""),
          authors: asArray(item.authors).map(function (author) {
            return author.name || "";
          }),
          year: Number(String(item.pubdate || "").slice(0, 4)) || null,
          publicationDate: item.pubdate || null,
          venue: item.fulljournalname || item.source || "",
          workType: "journal-article",
          doi: doi,
          url: itemUrl,
          abstractText: "",
          sources: [{ name: "PubMed", url: itemUrl }],
          sourceRank: index
        });
      })
      .filter(Boolean);
  }

  async function searchSemanticScholar(app, query, fromYear, limit) {
    var url =
      "https://api.semanticscholar.org/graph/v1/paper/search?query=" +
      encodeURIComponent(query) +
      "&limit=" +
      limit +
      "&fields=title,authors,year,venue,abstract,externalIds,citationCount,url,publicationTypes,publicationDate";
    var data = await httpGetJson(app, url);
    var items = data.data || [];
    return items
      .map(function (item, index) {
        var year = Number(item.year) || null;
        if (year && year < fromYear) return null;
        var doi = item.externalIds && item.externalIds.DOI;
        return makePaper({
          title: item.title || "",
          authors: asArray(item.authors).map(function (author) {
            return author.name || "";
          }),
          year: year,
          publicationDate: item.publicationDate || null,
          venue: item.venue || "",
          workType: first(item.publicationTypes) || "journal-article",
          citedByCount: item.citationCount || 0,
          doi: doi || "",
          url: item.url || (doi ? "https://doi.org/" + doi : ""),
          abstractText: item.abstract || "",
          sources: [{ name: "Semantic Scholar", url: item.url || "" }],
          sourceRank: index
        });
      })
      .filter(Boolean);
  }

  var SOURCE_FUNCS = {
    crossref: searchCrossref,
    europepmc: searchEuropePmc,
    arxiv: searchArxiv,
    dblp: searchDblp,
    pubmed: searchPubMed,
    semanticscholar: searchSemanticScholar
  };

  async function searchAll(app, options) {
    var sourceIds = asArray(options.sources).filter(function (id) {
      return SOURCE_FUNCS[id];
    });
    if (!sourceIds.length) sourceIds = ["crossref", "europepmc"];
    // 扩大候选池；Crossref 会同时跑中文/英文两路查询，去重后仍有足够候选。
    var perSource = Math.min(
      30,
      Math.max(15, Math.ceil((options.limit / sourceIds.length) * 2))
    );
    var statuses = [];
    var papers = [];
    var expandedEnglish = textOf(options.englishQuery);
    var original = textOf(options.query);

    await Promise.all(
      sourceIds.map(async function (id) {
        var meta = ALL_SOURCES.filter(function (source) {
          return source.id === id;
        })[0] || { id: id, name: id };
        var queries = buildSourceQueries(id, options);
        if (!queries.length) {
          statuses.push({
            id: id,
            name: meta.name,
            available: false,
            resultCount: 0,
            message:
              "该来源需要英文检索词；请补充英文关键词或启用“中文查询自动生成英文扩展”"
          });
          return;
        }
        var collected = [];
        var errors = [];
        for (var queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
          try {
            var result = await SOURCE_FUNCS[id](
              app,
              queries[queryIndex],
              options.fromYear,
              perSource
            );
            collected = collected.concat(result);
          } catch (error) {
            errors.push(String(error && error.message ? error.message : error));
          }
        }
        if (!collected.length && errors.length) {
          statuses.push({
            id: id,
            name: meta.name,
            available: false,
            resultCount: 0,
            message: errors[0]
          });
          return;
        }
        statuses.push({
          id: id,
          name: meta.name,
          available: true,
          resultCount: collected.length,
          message: errors.length ? errors[0] : null
        });
        papers = papers.concat(collected);
      })
    );

    var terms = uniqueStrings(
      splitKeywords(original)
        .concat(splitKeywords(expandedEnglish))
        .concat(asArray(options.englishKeywords)),
      30
    );
    var deduped = dedupePapers(papers, terms, currentYear());
    deduped.sort(function (left, right) {
      return (
        (right.relevanceScore || 0) - (left.relevanceScore || 0) ||
        (right.frontierScore || 0) - (left.frontierScore || 0)
      );
    });
    return {
      query: original,
      englishQuery:
        expandedEnglish &&
        expandedEnglish.toLowerCase() !== original.toLowerCase()
          ? expandedEnglish
          : "",
      alternateQueries: asArray(options.alternateQueries),
      fromYear: options.fromYear,
      toYear: currentYear(),
      papers: deduped.slice(0, options.limit),
      sources: statuses,
      total: deduped.length
    };
  }

  // ───────────────────────── AI ─────────────────────────

  async function aiChat(app, messages, modelId) {
    var options = modelId ? { modelId: modelId } : undefined;
    return app.ai.chatSync(messages, options);
  }

  function projectContext(project) {
    if (!project) return "（未绑定课题）";
    var lines = ["课题名称：" + (project.title || "")];
    if (project.field) lines.push("研究方向：" + project.field);
    if (project.keywords) lines.push("关键词：" + project.keywords);
    if (project.description) lines.push("课题说明：" + truncate(project.description, 4000));
    return lines.join("\n");
  }

  function literatureBlock(items) {
    if (!items || !items.length) return "（未选择文献）";
    return items
      .slice(0, 20)
      .map(function (item, index) {
        return (
          "[" +
          (index + 1) +
          "] " +
          (item.title || "") +
          "\n作者：" +
          (asArray(item.authors).join("、") || "未填写") +
          "\n年份：" +
          (item.year || "未填写") +
          "\n来源：" +
          (item.venue || "未填写") +
          "\n摘要：" +
          truncate(item.abstractText || "未填写", 800) +
          "\n阅读笔记：" +
          truncate(item.notes || "未填写", 800) +
          "\n"
        );
      })
      .join("\n");
  }

  // ───────────────────────── 资料提取检索词 ─────────────────────────

  var EXTRACT_MAX_SOURCES = 12;
  var EXTRACT_MAX_FILES = 5;
  var EXTRACT_TOTAL_CHARS = 24000;
  var EXTRACT_PER_SOURCE_CHARS = 12000;
  var EXTRACT_CACHE_HOURS = 168;
  var EXTRACT_HISTORY_MAX = 10;

  function textOf(value) {
    return String(value == null ? "" : value).trim();
  }

  function uniqueStrings(list, max) {
    var seen = {};
    var out = [];
    asArray(list).forEach(function (item) {
      var value = textOf(item);
      if (!value) return;
      var key = value.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(value);
    });
    return out.slice(0, max || out.length);
  }

  function sourceKey(source) {
    if (!source) return "";
    if (source.kind === "note") return "note:" + source.id;
    if (source.kind === "file") return "file:" + (source.path || source.title);
    if (source.kind === "library") return "library:" + source.id;
    return "source:" + (source.title || "");
  }

  function mergeExtractionSources(list) {
    var map = {};
    asArray(list).forEach(function (source) {
      if (!source) return;
      var key = sourceKey(source);
      if (!map[key]) map[key] = source;
    });
    return Object.keys(map).map(function (key) {
      return map[key];
    });
  }

  function truncateExtractionSources(sources) {
    var usable = asArray(sources).filter(function (source) {
      return source && textOf(source.text);
    });
    usable = usable.slice(0, EXTRACT_MAX_SOURCES);
    var per = Math.min(
      EXTRACT_PER_SOURCE_CHARS,
      Math.max(1500, Math.floor(EXTRACT_TOTAL_CHARS / Math.max(usable.length, 1)))
    );
    return usable.map(function (source) {
      var text = truncate(textOf(source.text), per);
      return {
        kind: source.kind,
        id: source.id || null,
        path: source.path || null,
        title: textOf(source.title) || "未命名资料",
        identity: source.identity || sourceKey(source),
        text: text,
        chars: text.length
      };
    });
  }

  function extractionCacheKey(projectId, sources, modelId) {
    return (
      "extract:v1:" +
      hashString(
        JSON.stringify({
          projectId: projectId || "",
          modelId: modelId || null,
          sources: sources.map(function (source) {
            return {
              identity: source.identity,
              hash: hashString(source.text || "")
            };
          })
        })
      )
    );
  }

  function buildExtractionPrompt(project, sources) {
    var blocks = sources
      .map(function (source, index) {
        return (
          "【来源 " +
          (index + 1) +
          "｜" +
          (source.kind === "note"
            ? "已有文档"
            : source.kind === "file"
            ? "本地文献"
            : "文献库") +
          "】" +
          source.title +
          "\n" +
          source.text
        );
      })
      .join("\n\n");
    return (
      "【任务】从以下资料中提取适合用于学术论文检索的研究主题与关键词。\n\n" +
      projectContext(project) +
      "\n\n【资料】\n" +
      blocks +
      "\n\n要求：\n" +
      "1. 主题不超过 30 个中文字符，准确概括资料的研究对象、问题与方法。\n" +
      "2. 关键词 5–8 个，优先中英文混合；英文关键词应可直接用于 Crossref / arXiv / PubMed 检索。\n" +
      "3. 关键词必须来自资料内容或高度相关，不得凭空扩展。\n" +
      "4. 另给 3 个候选主题，按推荐程度排序。\n" +
      "5. 无法判断时返回空数组，不要编造。\n" +
      "6. 只输出 JSON，不要 Markdown 代码块。\n\n" +
      "JSON 结构：\n" +
      '{"topic":"","topicCandidates":["","",""],"keywords":[""],"researchQuestions":[""],"methods":[""],"domain":"","confidence":0.0,"warnings":[""]}'
    );
  }

  function sanitizeExtraction(raw, project) {
    var data = raw && typeof raw === "object" ? raw : {};
    var topicCandidates = uniqueStrings(
      asArray(data.topicCandidates || data.topics),
      3
    );
    var topic =
      textOf(data.topic) ||
      topicCandidates[0] ||
      (project ? project.title : "") ||
      "";
    if (topic && topicCandidates.indexOf(topic) < 0) {
      topicCandidates.unshift(topic);
      topicCandidates = topicCandidates.slice(0, 3);
    }
    var keywordSource =
      typeof data.keywords === "string"
        ? splitKeywords(data.keywords)
        : asArray(data.keywords);
    var keywords = uniqueStrings(
      keywordSource
        .map(textOf)
        .filter(function (keyword) {
          return keyword.length >= 2 && keyword.length <= 30;
        }),
      10
    );
    if (!keywords.length && project) {
      keywords = splitKeywords(project.keywords).slice(0, 8);
    }
    return {
      topic: topic.slice(0, 40),
      topicCandidates: topicCandidates,
      keywords: keywords,
      researchQuestions: uniqueStrings(data.researchQuestions, 5),
      methods: uniqueStrings(data.methods, 8),
      domain: textOf(data.domain).slice(0, 40),
      confidence: clamp(Number(data.confidence) || 0, 0, 1),
      warnings: uniqueStrings(data.warnings, 5),
      evaluationMode: data.evaluationMode === "local_fallback" ? "local_fallback" : "ai"
    };
  }

  var EXTRACT_STOPWORDS = {
    the: 1, and: 1, for: 1, with: 1, from: 1, that: 1, this: 1, are: 1,
    was: 1, were: 1, have: 1, has: 1, into: 1, using: 1, based: 1, study: 1,
    research: 1, analysis: 1, method: 1, methods: 1, results: 1, paper: 1,
    研究: 1, 分析: 1, 方法: 1, 技术: 1, 基于: 1, 一种: 1, 本文: 1, 问题: 1,
    结果: 1, 应用: 1, 系统: 1, 设计: 1
  };

  function collectLocalKeywords(text, limit) {
    var counts = {};
    var english = String(text || "").match(/[A-Za-z][A-Za-z0-9-]{2,}/g) || [];
    english.forEach(function (word) {
      var key = word.toLowerCase();
      if (EXTRACT_STOPWORDS[key] || key.length < 3) return;
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.keys(counts)
      .sort(function (left, right) {
        return counts[right] - counts[left];
      })
      .slice(0, limit || 6);
  }

  function localExtraction(sources, project) {
    var topic =
      (project && project.title) ||
      (sources[0] && sources[0].title) ||
      "";
    var keywords = splitKeywords(project ? project.keywords : "");
    var combined = sources
      .map(function (source) {
        return source.title + " " + source.text;
      })
      .join(" ");
    keywords = keywords.concat(collectLocalKeywords(combined, 6));
    return sanitizeExtraction(
      {
        topic: topic,
        topicCandidates: [
          topic,
          topic ? topic + "研究" : "",
          topic ? topic + "方法与应用" : ""
        ],
        keywords: keywords,
        researchQuestions: [],
        methods: [],
        domain: project ? project.field : "",
        confidence: 0.3,
        warnings: [
          "AI 不可用，已使用本地规则提取；建议人工补充英文关键词后再检索。"
        ],
        evaluationMode: "local_fallback"
      },
      project
    );
  }

  async function extractTopicKeywords(app, project, sources, modelId) {
    var prompt = buildExtractionPrompt(project, sources);
    var text = await aiChat(
      app,
      [
        {
          role: "system",
          content: SYSTEM_RULES + "\n只输出 JSON，不要 Markdown 代码块。"
        },
        { role: "user", content: prompt }
      ],
      modelId
    );
    return sanitizeExtraction(parseJsonLoose(text), project);
  }

  // ───────────────────────── 参考文献索引 ─────────────────────────

  function referenceTypeCode(workType) {
    if (workType === "proceedings-article") return "[C]";
    if (workType === "posted-content") return "[EB/OL]";
    if (workType === "book-chapter") return "[M]";
    if (workType === "dissertation") return "[D]";
    if (workType === "report") return "[R]";
    return "[J]";
  }

  function referenceAuthors(authors) {
    var list = asArray(authors)
      .map(textOf)
      .filter(Boolean);
    if (!list.length) return "";
    if (list.length <= 3) return list.join(", ");
    var allAscii = list.every(function (name) {
      return /^[\x00-\x7F]+$/.test(name);
    });
    return list.slice(0, 3).join(", ") + (allAscii ? ", et al." : ", 等");
  }

  function formatReferenceEntry(item, index) {
    var authors = referenceAuthors(item.authors);
    var title = (textOf(item.title) || "未命名文献").replace(/[.。]\s*$/, "");
    var type = referenceTypeCode(item.workType);
    var venue = textOf(item.venue || item.publisher);
    var year = item.year ? String(item.year) : "";
    var source = [venue, year].filter(Boolean).join(", ");
    if (!source) source = "出版信息待补充";
    var tail = [];
    if (item.doi) tail.push("DOI: " + textOf(item.doi));
    if (item.url && item.workType === "posted-content") {
      tail.push("URL: " + textOf(item.url));
    }
    return (
      "[" +
      index +
      "] " +
      (authors ? authors + (/[.。]$/.test(authors) ? " " : ". ") : "") +
      title +
      type +
      ". " +
      source +
      (tail.length ? ". " + tail.join(". ") : "") +
      "."
    );
  }

  function referenceBibType(workType) {
    if (workType === "proceedings-article") return "inproceedings";
    if (workType === "book-chapter") return "incollection";
    if (workType === "dissertation") return "phdthesis";
    if (workType === "report") return "techreport";
    if (workType === "posted-content") return "misc";
    return "article";
  }

  function bibtexEscape(value) {
    return String(value == null ? "" : value)
      .replace(/\\/g, "\\\\")
      .replace(/([{}&%$#_])/g, "\\$1");
  }

  function bibtexKey(item, index) {
    var author = asArray(item.authors)[0] || "ref";
    var year = item.year ? String(item.year) : "nd";
    var titleWord = String(item.title || "")
      .split(/\s+/)
      .filter(Boolean)[0] || "";
    var raw = (author + year + titleWord)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    if (!raw) raw = "ref" + index;
    if (/^[0-9]/.test(raw)) raw = "ref" + raw;
    return raw;
  }

  function buildReferenceIndex(items, format) {
    var list = asArray(items).filter(function (item) {
      return item && (item.title || item.doi);
    });
    if (!list.length) return "";
    if (format === "bibtex") {
      return list
        .map(function (item, index) {
          var type = referenceBibType(item.workType);
          var lines = [
            "@" + type + "{" + bibtexKey(item, index + 1) + ",",
            "  title = {" + bibtexEscape(item.title || "") + "},",
            "  author = {" +
              asArray(item.authors)
                .map(function (author) {
                  return bibtexEscape(author);
                })
                .join(" and ") +
              "},"
          ];
          if (item.year) lines.push("  year = {" + item.year + "},");
          if (item.venue) {
            var field =
              type === "article"
                ? "journal"
                : type === "inproceedings" || type === "incollection"
                ? "booktitle"
                : type === "phdthesis"
                ? "school"
                : type === "techreport"
                ? "institution"
                : "howpublished";
            lines.push("  " + field + " = {" + bibtexEscape(item.venue) + "},");
          }
          if (item.doi) lines.push("  doi = {" + bibtexEscape(item.doi) + "},");
          if (item.url) lines.push("  url = {" + bibtexEscape(item.url) + "},");
          lines.push("}");
          return lines.join("\n");
        })
        .join("\n\n");
    }
    return list
      .map(function (item, index) {
        return formatReferenceEntry(item, index + 1);
      })
      .join("\n");
  }

  function buildWorkflowPrompt(mode, project, input, literature) {
    var context = projectContext(project);
    var topic = String(input.topic || "").trim();
    var content = truncate(input.content || "", MAX_INPUT_CHARS);
    var extra = String(input.extra || "").trim();

    if (mode === "frontier") {
      return (
        "【任务】领域前沿追踪\n\n" +
        context +
        "\n\n【研究主题】\n" +
        (topic || "未填写") +
        "\n\n【补充要求】\n" +
        (extra || "无") +
        "\n\n请输出：\n## 一、研究热点\n3–5 个方向，每个包含核心问题、代表方法、近期进展、为什么重要。\n" +
        "## 二、趋势判断\n## 三、机会与风险\n## 四、建议检索式\n给出 5–8 组可用于 CNKI / Web of Science / arXiv / Google Scholar 的检索式。\n" +
        "## 五、证据边界\n说明本回答未联网，具体文献与数据需检索验证。"
      );
    }
    if (mode === "review") {
      return (
        "【任务】文献综述\n\n" +
        context +
        "\n\n【研究主题】\n" +
        (topic || "未填写") +
        "\n\n【已选文献】\n" +
        literatureBlock(literature) +
        "\n【补充材料】\n" +
        (content || "无") +
        "\n\n【额外要求】\n" +
        (extra || "无") +
        "\n\n请输出：\n## 一、研究背景与问题\n## 二、研究脉络\n按主题或方法聚类，引用已选文献时使用 [1]、[2] 编号。\n" +
        "## 三、主要观点与方法对比\n尽量使用表格。\n## 四、研究缺口\n## 五、可推进的研究问题\n" +
        "## 参考文献\n只列已选文献，不得补充不存在文献；未提供文献时写“待补充真实文献后生成”。"
      );
    }
    if (mode === "outline") {
      return (
        "【任务】论文框架搭建\n\n" +
        context +
        "\n\n【论文题目 / 主题】\n" +
        (topic || "未填写") +
        "\n\n【论文类型 / 额外要求】\n" +
        (extra || "研究论文") +
        "\n\n【已有材料】\n" +
        (content || "无") +
        "\n\n请输出：\n## 一、题目建议\n## 二、摘要要点\n## 三、关键词\n## 四、章节框架\n每章给标题与 2–5 条写作要点。\n" +
        "## 五、方法与数据建议\n## 六、写作顺序与风险"
      );
    }
    if (mode === "polish") {
      return (
        "【任务】学术语言润色\n\n" +
        context +
        "\n\n【风格要求】\n" +
        (extra || "严谨、客观、简洁") +
        "\n\n【原文】\n" +
        content +
        "\n\n要求：保持原意、事实、数据与引用编号不变；提升准确性与逻辑衔接；先输出“## 润色后文本”，再输出“## 主要修改说明”表格。"
      );
    }
    if (mode === "format") {
      return (
        "【任务】学术写作规范检查\n\n" +
        context +
        "\n\n【检查重点】\n" +
        (extra || "通用学术写作规范") +
        "\n\n【原文】\n" +
        content +
        "\n\n输出：\n## 一、问题清单\n表格：位置 / 问题类型 / 修改建议 / 优先级。\n## 二、修改后文本\n## 三、仍需人工确认"
      );
    }
    return (
      "【任务】科研数据分析\n\n" +
      context +
      "\n\n【研究问题】\n" +
      (topic || "未填写") +
      "\n\n【数据 / 材料】\n" +
      content +
      "\n\n【额外要求】\n" +
      (extra || "无") +
      "\n\n不得编造数据、统计量或显著性结论。输出：\n## 一、数据概况\n## 二、可执行分析\n## 三、初步观察\n## 四、可视化建议\n## 五、结论与局限"
    );
  }

  async function generateWorkflow(app, mode, project, input, literature, modelId) {
    var prompt = buildWorkflowPrompt(mode, project, input, literature);
    var text = await aiChat(
      app,
      [
        { role: "system", content: SYSTEM_RULES },
        { role: "user", content: prompt }
      ],
      modelId
    );
    return String(text || "").trim();
  }

  function sanitizeExpansion(raw) {
    var data = raw && typeof raw === "object" ? raw : {};
    return {
      englishQuery: textOf(data.englishQuery).slice(0, 240),
      englishKeywords: uniqueStrings(
        typeof data.englishKeywords === "string"
          ? splitKeywords(data.englishKeywords)
          : data.englishKeywords,
        12
      ),
      alternateQueries: uniqueStrings(
        typeof data.alternateQueries === "string"
          ? splitKeywords(data.alternateQueries)
          : data.alternateQueries,
        3
      ).filter(function (query) {
        return query.length >= 3 && query.length <= 240;
      })
    };
  }

  async function expandSearchQuery(app, project, query, modelId) {
    var prompt =
      "【任务】把中文科研检索需求转换为可直接用于 Crossref / arXiv / DBLP / PubMed / Semantic Scholar 的英文检索式。\n\n" +
      projectContext(project) +
      "\n\n【中文检索需求】\n" +
      query +
      "\n\n要求：\n" +
      "1. 使用领域内通行的英文学术术语，不要逐字直译。\n" +
      "2. englishQuery 为 1 条主检索式，2–8 个英文词。\n" +
      "3. englishKeywords 给出 5–8 个英文关键词。\n" +
      "4. alternateQueries 给出最多 3 条可替换的检索式（同义词/上位词/方法词）。\n" +
      "5. 只输出 JSON，不要 Markdown 代码块。\n\n" +
      'JSON：{"englishQuery":"","englishKeywords":[""],"alternateQueries":[""]}';
    var text = await aiChat(
      app,
      [
        {
          role: "system",
          content: SYSTEM_RULES + "\n只输出 JSON，不要 Markdown 代码块。"
        },
        { role: "user", content: prompt }
      ],
      modelId
    );
    return sanitizeExpansion(parseJsonLoose(text));
  }

  function effectiveEnglishQuery(options) {
    var explicit = textOf(options.englishQuery);
    if (explicit) return explicit;
    var original = textOf(options.query);
    if (original && !queryHasCjk(original) && queryHasAscii(original)) {
      return original;
    }
    return "";
  }

  function buildSourceQueries(sourceId, options) {
    var english = effectiveEnglishQuery(options);
    var original = textOf(options.query);
    if (
      sourceId === "arxiv" ||
      sourceId === "dblp" ||
      sourceId === "pubmed" ||
      sourceId === "semanticscholar"
    ) {
      if (!english) return [];
      return [english].concat(asArray(options.alternateQueries)).slice(0, 2);
    }
    if (sourceId === "europepmc") {
      return [english || original];
    }
    if (sourceId === "crossref") {
      var queries = [original];
      if (english && english.toLowerCase() !== original.toLowerCase()) {
        queries.push(english);
      }
      return queries.filter(Boolean);
    }
    return [original];
  }

  function localRecommendation(paper, project) {
    var terms = splitKeywords(
      (project && project.keywords ? project.keywords + " " : "") +
        (project && project.title ? project.title : "")
    );
    var haystack = (
      String(paper.title || "") + " " + String(paper.abstractText || "")
    ).toLowerCase();
    var hits = terms.filter(function (term) {
      return term && haystack.indexOf(term.toLowerCase()) >= 0;
    }).length;
    var score = 0;
    if (paper.year && currentYear() - paper.year <= 3) score += 30;
    if ((paper.citedByCount || 0) >= 50) score += 30;
    else if ((paper.citedByCount || 0) >= 10) score += 15;
    if (hits > 0) score += Math.min(40, hits * 10);
    var decision = score >= 60 ? "recommended" : score >= 30 ? "consider" : "not_recommended";
    return {
      decision: decision,
      reason:
        "本地规则评估：年份、引用量与课题关键词匹配得分 " +
        score +
        "/100。AI 模型不可用时的兜底建议，仅供参考。",
      confidence: Math.round(score) / 100,
      suggestedTags: terms.slice(0, 5),
      evaluationMode: "local_fallback",
      warning: "未调用 AI，建议人工核验。"
    };
  }

  async function recommendPaper(app, paper, project, modelId) {
    var prompt =
      "【任务】评估论文是否值得加入课题知识库\n\n" +
      projectContext(project) +
      "\n\n【论文题录】\n标题：" +
      (paper.title || "") +
      "\n作者：" +
      (asArray(paper.authors).join("、") || "未收录") +
      "\n年份：" +
      (paper.year || "未知") +
      "\n来源：" +
      (paper.venue || "未收录") +
      "\nDOI：" +
      (paper.doi || "未收录") +
      "\n摘要：" +
      truncate(paper.abstractText || "未提供", 3000) +
      "\n\n只输出 JSON：{\"decision\":\"recommended|consider|not_recommended\",\"reason\":\"...\",\"confidence\":0.0,\"suggestedTags\":[\"...\"],\"warning\":\"可选\"}";
    try {
      var text = await aiChat(
        app,
        [
          { role: "system", content: SYSTEM_RULES + "\n只输出 JSON，不要 Markdown 代码块。" },
          { role: "user", content: prompt }
        ],
        modelId
      );
      var data = parseJsonLoose(text);
      var decision = data.decision;
      if (
        decision !== "recommended" &&
        decision !== "consider" &&
        decision !== "not_recommended"
      ) {
        decision = "consider";
      }
      return {
        decision: decision,
        reason: String(data.reason || "AI 未给出理由"),
        confidence: clamp(Number(data.confidence) || 0, 0, 1),
        suggestedTags: asArray(data.suggestedTags).map(String).slice(0, 8),
        evaluationMode: "ai",
        warning: data.warning ? String(data.warning) : null
      };
    } catch (error) {
      return localRecommendation(paper, project);
    }
  }

  async function analyzePdfs(app, project, files, context, modelId) {
    var selected = files.slice(0, MAX_PDF_FILES);
    var perFile = Math.max(
      5000,
      Math.floor(24000 / Math.max(selected.length, 1))
    );
    var blocks = selected
      .map(function (file, index) {
        return (
          "【论文 " +
          (index + 1) +
          "】文件名：" +
          file.name +
          "\n内容：\n" +
          truncate(file.content, Math.min(MAX_PDF_CHARS, perFile))
        );
      })
      .join("\n\n");
    var prompt =
      "【任务】分析以下论文，并与当前研究项目对照。\n\n" +
      projectContext(project) +
      "\n\n【项目背景】\n" +
      truncate(context || "无", 6000) +
      "\n\n" +
      blocks +
      "\n\n只输出 JSON，结构：\n" +
      '{"projectSummary":"", "papers":[{"fileName":"","title":"","abstractText":"","keywords":[],"researchQuestion":"","methods":[],"dataAndExperiments":[],"conclusions":[],"limitations":[]}], "keywordOverlaps":[{"keyword":"","paperIndexes":[1],"analysis":""}], "comparisons":[{"dimension":"","commonPoints":[],"differences":[],"conflicts":[]}], "recommendations":[{"title":"","action":"","rationale":"","confidence":0.0}], "graph":{"nodes":[{"id":"","label":"","type":"Project|Paper|Keyword|Method|Conclusion|Limitation"}],"edges":[{"source":"","target":"","relation":"","reason":""}]}, "warnings":[]}\n' +
      "不得虚构论文内容；无法确认的信息写入 warnings。";
    var text = await aiChat(
      app,
      [
        { role: "system", content: SYSTEM_RULES + "\n只输出 JSON，不要 Markdown 代码块。" },
        { role: "user", content: prompt }
      ],
      modelId
    );
    try {
      return parseJsonLoose(text);
    } catch (error) {
      return { raw: String(text || ""), warnings: ["AI 返回内容不是合法 JSON，已按原文展示。"] };
    }
  }

  // ───────────────────────── 知识库 ─────────────────────────

  var folderPromise = null;

  function flattenFolders(nodes) {
    var out = [];
    asArray(nodes).forEach(function (node) {
      if (!node) return;
      out.push(node);
      if (node.children) out = out.concat(flattenFolders(node.children));
    });
    return out;
  }

  async function ensureResearchFolder(app) {
    if (folderPromise) return folderPromise;
    folderPromise = (async function () {
      var folders = flattenFolders(await app.invoke("list_folders"));
      var found = folders.filter(function (folder) {
        return folder.name === "论文知识库";
      })[0];
      if (found) return found;
      return app.invoke("create_folder", { name: "论文知识库", parentId: null });
    })().catch(function (error) {
      folderPromise = null;
      throw error;
    });
    return folderPromise;
  }

  function paperNoteContent(paper, project, recommendation) {
    var sources = asArray(paper.sources)
      .map(function (source) {
        return "- [" + source.name + "](" + source.url + ")";
      })
      .join("\n");
    var tags = asArray(recommendation && recommendation.suggestedTags)
      .map(function (tag) {
        return "#" + String(tag).replace(/\s+/g, "-");
      })
      .join(" ");
    return (
      "<!-- research-paper:" +
      paperIdentity(paper) +
      " -->\n\n" +
      "# " +
      (paper.title || "未命名论文") +
      "\n\n> 由 AI 助研插件导出，AI 建议仅作筛选参考。\n\n" +
      "## 题录信息\n\n" +
      "- 课题：" +
      (project ? project.title : "未绑定") +
      "\n- 作者：" +
      (asArray(paper.authors).join("、") || "未收录") +
      "\n- 年份：" +
      (paper.year || "未收录") +
      "\n- 来源：" +
      (paper.venue || paper.publisher || "未收录") +
      "\n- 类型：" +
      workTypeLabel(paper.workType) +
      "\n- 引用量：" +
      (paper.citedByCount || 0) +
      "\n- DOI：" +
      (paper.doi || "未收录") +
      "\n- 原文：" +
      (paper.url || "未收录") +
      "\n- 收录平台：" +
      (asArray(paper.sources)
        .map(function (source) {
          return source.name;
        })
        .join("、") || "未收录") +
      "\n\n## 入库建议\n\n" +
      (recommendation
        ? "- 结论：" +
          recommendation.decision +
          "\n- 置信度：" +
          Math.round((recommendation.confidence || 0) * 100) +
          "%\n- 理由：" +
          recommendation.reason +
          "\n- 建议标签：" +
          (tags || "无")
        : "- 尚未评估") +
      "\n\n## 摘要\n\n" +
      (paper.abstractText || "论文库未提供摘要。") +
      "\n\n## 来源链接\n\n" +
      (sources || "- 未收录")
    );
  }

  async function exportPaperToNote(app, paper, project, recommendation) {
    var folder = await ensureResearchFolder(app);
    var note = await app.notes.create({
      title: "论文｜" + (paper.title || "未命名论文"),
      content: paperNoteContent(paper, project, recommendation),
      folder_id: folder.id
    });
    return note;
  }

  async function exportOutputToNote(app, output) {
    var folder = await ensureResearchFolder(app);
    return app.notes.create({
      title: "【助研】" + output.title,
      content:
        "<!-- research-output:" +
        output.id +
        " -->\n\n" +
        (output.content || ""),
      folder_id: folder.id
    });
  }

  // ───────────────────────── DOM 工具 ─────────────────────────

  function createEl(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined) return;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key === "html") node.innerHTML = value;
        else if (key === "style") node.style.cssText = value;
        else if (key === "value") node.value = value;
        else if (key === "checked" || key === "disabled" || key === "selected") {
          node[key] = !!value;
        } else if (key.indexOf("on") === 0 && typeof value === "function") {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
          node.setAttribute(key, value);
        }
      });
    }
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    if (children === null || children === undefined) return;
    if (Array.isArray(children)) {
      children.forEach(function (child) {
        appendChildren(node, child);
      });
      return;
    }
    if (typeof children === "string" || typeof children === "number") {
      node.appendChild(document.createTextNode(String(children)));
      return;
    }
    if (children.nodeType) node.appendChild(children);
  }

  function button(label, onClick, options) {
    var opts = options || {};
    var classes = "ra-btn";
    if (opts.primary) classes += " ra-btn-primary";
    if (opts.danger) classes += " ra-btn-danger";
    if (opts.ghost) classes += " ra-btn-ghost";
    if (opts.small) classes += " ra-btn-sm";
    return createEl(
      "button",
      {
        class: classes,
        type: "button",
        disabled: opts.disabled,
        onclick: onClick
      },
      label
    );
  }

  function tag(text, tone) {
    return createEl("span", {
      class: "ra-tag" + (tone ? " ra-tag-" + tone : ""),
      text: text
    });
  }

  function input(attrs) {
    return createEl("input", Object.assign({ class: "ra-input" }, attrs || {}));
  }

  function textarea(attrs) {
    return createEl("textarea", Object.assign({ class: "ra-textarea" }, attrs || {}));
  }

  function select(attrs, options) {
    var node = createEl("select", Object.assign({ class: "ra-select" }, attrs || {}));
    asArray(options).forEach(function (option) {
      node.appendChild(
        createEl("option", {
          value: option.value,
          text: option.label,
          selected: option.selected
        })
      );
    });
    return node;
  }

  function field(labelText, control) {
    return createEl("label", { class: "ra-field" }, [
      createEl("span", { class: "ra-field-label", text: labelText }),
      control
    ]);
  }

  function card(title, extra, body) {
    return createEl("section", { class: "ra-card" }, [
      title
        ? createEl("div", { class: "ra-card-head" }, [
            createEl("div", { class: "ra-card-title", text: title }),
            extra || null
          ])
        : null,
      createEl("div", { class: "ra-card-body" }, body)
    ]);
  }

  function emptyState(text) {
    return createEl("div", { class: "ra-empty", text: text });
  }

  function spinner(text) {
    return createEl("div", { class: "ra-loading" }, [
      createEl("span", { class: "ra-spinner" }),
      createEl("span", { text: text || "处理中…" })
    ]);
  }

  function markdownBlock(text) {
    return createEl("div", {
      class: "ra-markdown",
      html: renderMarkdown(text || "")
    });
  }

  function safe(fn) {
    return function (event) {
      Promise.resolve()
        .then(function () {
          return fn(event);
        })
        .catch(function (error) {
          var message = String(error && error.message ? error.message : error);
          try {
            if (window.__researchToast) window.__researchToast(message, true);
          } catch (e) {
            console.error("[research]", error);
          }
        });
    };
  }

  function openModal(options) {
    var overlay = createEl("div", { class: "ra-overlay" });
    var box = createEl("div", {
      class: "ra-modal",
      style: options.width ? "max-width:" + options.width + "px" : ""
    });
    var api = {
      close: function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }
    };
    var head = createEl("div", { class: "ra-modal-head" }, [
      createEl("div", { class: "ra-modal-title", text: options.title || "" }),
      createEl("button", {
        class: "ra-modal-close",
        type: "button",
        text: "×",
        onclick: api.close
      })
    ]);
    var body = createEl("div", { class: "ra-modal-body" });
    appendChildren(body, options.content || null);
    var foot = createEl("div", { class: "ra-modal-foot" });
    asArray(options.actions).forEach(function (action) {
      foot.appendChild(
        button(
          action.label,
          safe(function () {
            return action.onClick ? action.onClick(api) : undefined;
          }),
          { primary: action.primary, danger: action.danger }
        )
      );
    });
    box.appendChild(head);
    box.appendChild(body);
    if (foot.childNodes.length) box.appendChild(foot);
    overlay.appendChild(box);
    overlay.addEventListener("mousedown", function (event) {
      if (event.target === overlay) api.close();
    });
    document.body.appendChild(overlay);
    return api;
  }

  function promptText(title, value, placeholder) {
    return new Promise(function (resolve) {
      var control = input({
        value: value || "",
        placeholder: placeholder || "",
        style: "width:100%"
      });
      var modal;
      modal = openModal({
        title: title,
        content: control,
        actions: [
          {
            label: "取消",
            onClick: function () {
              modal.close();
              resolve(null);
            }
          },
          {
            label: "确定",
            primary: true,
            onClick: function () {
              var next = String(control.value || "").trim();
              if (!next) {
                control.focus();
                return;
              }
              modal.close();
              resolve(next);
            }
          }
        ]
      });
      control.focus();
    });
  }

  function confirmDialog(title, message) {
    return new Promise(function (resolve) {
      var modal;
      modal = openModal({
        title: title,
        content: createEl("p", { class: "ra-confirm-text", text: message }),
        actions: [
          {
            label: "取消",
            onClick: function () {
              modal.close();
              resolve(false);
            }
          },
          {
            label: "确认",
            danger: true,
            onClick: function () {
              modal.close();
              resolve(true);
            }
          }
        ]
      });
    });
  }

  function downloadFile(filename, text, mime) {
    var blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function downloadText(filename, text) {
    downloadFile(filename, text, "application/json;charset=utf-8");
  }

  function safeFilePart(value) {
    return String(value || "reference-index")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "reference-index";
  }

  function openExternal(app, url) {
    if (!url) return;
    app.invoke("plugin:opener|open_url", { url: url }).catch(function () {
      try {
        window.open(url, "_blank");
      } catch (error) {
        console.warn("[research] 打开链接失败", error);
      }
    });
  }

  function baseName(path) {
    var parts = String(path || "").split(/[\\/]/);
    return parts[parts.length - 1] || path;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error("当前环境不支持剪贴板"));
  }

  // ───────────────────────── 面板 ─────────────────────────

  function mountPanel(ctx, container) {
    var app = ctx.app;
    var storage = createStorage(app);
    var state = createInitialState();
    state.searchInput = { topic: "", keywords: "" };
    state.litQuery = "";
    state.litStatus = "";
    state.analysisContext = "";
    state.analysisFiles = [];
    state.viewingOutput = null;
    state.extractHistory = [];

    var root = createEl("div", { class: "ra-root" });
    container.appendChild(root);
    var disposed = false;

    function toast(message, isError) {
      try {
        if (isError) app.notices.error(message);
        else app.notices.show(message);
      } catch (error) {
        console.log("[research]", message);
      }
    }
    window.__researchToast = toast;

    function persistMeta() {
      return storage.set("meta", state.meta);
    }
    function persistLiterature() {
      if (!state.meta.activeProjectId) return Promise.resolve();
      return storage.set("lit:" + state.meta.activeProjectId, state.literature);
    }
    function persistOutputs() {
      if (!state.meta.activeProjectId) return Promise.resolve();
      return storage.set("out:" + state.meta.activeProjectId, state.outputs);
    }
    function persistSettings() {
      return storage.set("settings", state.settings);
    }

    function selectedLiterature() {
      return state.literature.filter(function (item) {
        return !!state.selectedIds[item.id];
      });
    }

    function defaultModel() {
      var list = state.models || [];
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].isDefault) return list[i];
      }
      return list[0] || null;
    }

    /** 检索表单默认值：课题名称 + 课题关键词 */
    function searchDefaults() {
      var project = activeProject(state);
      return {
        topic: project ? project.title || "" : "",
        keywords: project ? project.keywords || "" : ""
      };
    }

    // ── 资料提取检索词 ──

    function extractionKindLabel(kind) {
      if (kind === "note") return "文档";
      if (kind === "file") return "本地文献";
      return "文献库";
    }

    function persistExtractHistory() {
      return storage.set(
        "extractHistory",
        state.extractHistory.slice(0, EXTRACT_HISTORY_MAX)
      );
    }

    function pushExtractHistory(result, sources) {
      var entry = {
        topic: result.topic,
        keywords: result.keywords,
        createdAt: nowIso(),
        sourceTitles: sources.map(function (source) {
          return source.title;
        }).slice(0, 6),
        mode: result.evaluationMode || "ai"
      };
      state.extractHistory = [entry]
        .concat(
          state.extractHistory.filter(function (item) {
            return !(
              item.topic === entry.topic &&
              JSON.stringify(item.keywords) === JSON.stringify(entry.keywords)
            );
          })
        )
        .slice(0, EXTRACT_HISTORY_MAX);
      void persistExtractHistory();
    }

    function applyExtraction(topic, keywords) {
      var nextTopic = textOf(topic);
      if (!nextTopic) {
        toast("主题不能为空", true);
        return false;
      }
      state.searchInput.topic = nextTopic;
      state.searchInput.keywords = uniqueStrings(keywords, 12).join("，");
      state.activeTab = "discover";
      render();
      return true;
    }

    async function resolveExtractionSources(selected) {
      var warnings = [];
      var out = [];
      for (var i = 0; i < selected.length; i += 1) {
        var source = selected[i];
        try {
          if (source.kind === "note") {
            var note = await app.notes.get(source.id);
            if (!note) {
              warnings.push("文档已不存在：" + source.title);
              continue;
            }
            if (note.is_hidden) {
              warnings.push("已跳过隐藏文档：" + note.title);
              continue;
            }
            if (note.is_encrypted) {
              warnings.push("已跳过加密文档：" + note.title);
              continue;
            }
            if (note.is_scratch) {
              warnings.push("已跳过临时文档：" + note.title);
              continue;
            }
            if (note.note_type && note.note_type !== "markdown") {
              warnings.push("已跳过非 Markdown 文档：" + note.title);
              continue;
            }
            var noteText = textOf(note.content);
            if (!noteText) {
              warnings.push("跳过空文档：" + (note.title || source.title));
              continue;
            }
            out.push({
              kind: "note",
              id: note.id,
              title: note.title || source.title,
              identity: "note:" + note.id + ":" + (note.updated_at || ""),
              text: noteText
            });
          } else if (source.kind === "library") {
            var literature = null;
            for (var j = 0; j < state.literature.length; j += 1) {
              if (state.literature[j].id === source.id) {
                literature = state.literature[j];
                break;
              }
            }
            if (!literature) {
              warnings.push("文献已不存在：" + source.title);
              continue;
            }
            var literatureText = [
              literature.title || "",
              "作者：" + (asArray(literature.authors).join("、") || "未填写"),
              "年份：" + (literature.year || "未填写"),
              "来源：" + (literature.venue || "未填写"),
              "摘要：" + (literature.abstractText || "未填写"),
              "笔记：" + (literature.notes || "未填写")
            ].join("\n");
            out.push({
              kind: "library",
              id: literature.id,
              title: literature.title || source.title,
              identity:
                "library:" +
                literature.id +
                ":" +
                (literature.updatedAt || ""),
              text: literatureText
            });
          } else if (source.kind === "file") {
            var fileText = textOf(source.text);
            if (!fileText) {
              warnings.push("文件未提取到文本：" + source.title);
              continue;
            }
            out.push({
              kind: "file",
              path: source.path,
              title: source.title,
              identity:
                "file:" +
                (source.path || source.title) +
                ":" +
                hashString(fileText),
              text: fileText
            });
          }
        } catch (error) {
          warnings.push(
            "读取失败：" +
              source.title +
              "（" +
              String(error && error.message ? error.message : error) +
              "）"
          );
        }
      }
      return {
        sources: truncateExtractionSources(out),
        warnings: warnings
      };
    }

    async function chooseExtractFiles(local, renderFn) {
      try {
        var selected = await app.invoke("plugin:dialog|open", {
          options: {
            multiple: true,
            filters: [
              {
                name: "文献",
                extensions: [
                  "md",
                  "markdown",
                  "txt",
                  "pdf",
                  "doc",
                  "docx",
                  "xlsx",
                  "csv"
                ]
              }
            ]
          }
        });
        if (!selected) return;
        var paths = Array.isArray(selected) ? selected : [selected];
        var fileCount = local.selected.filter(function (source) {
          return source.kind === "file";
        }).length;
        paths = paths.slice(0, Math.max(0, EXTRACT_MAX_FILES - fileCount));
        for (var i = 0; i < paths.length; i += 1) {
          var path = paths[i];
          var title = baseName(path);
          var text = "";
          try {
            var extracted = await app.invoke(
              "ppt_extension_extract_local_file",
              { path: path }
            );
            text = textOf(extracted && extracted.text);
            title = (extracted && extracted.title) || title;
          } catch (pptError) {
            // 退路：PPT 扩展命令不可用时，使用通用附件解析（PDF / 文本 / Excel）。
            try {
              var preview = await app.invoke("ai_parse_attachment", {
                filePath: path
              });
              text = textOf(preview && (preview.content || preview.markdown));
              title = (preview && preview.displayName) || title;
            } catch (fallbackError) {
              toast(
                title +
                  "：" +
                  String(
                    fallbackError && fallbackError.message
                      ? fallbackError.message
                      : fallbackError
                  ),
                true
              );
              continue;
            }
          }
          if (!text) {
            toast(title + "：文件没有可提取的文本", true);
            continue;
          }
          local.selected = mergeExtractionSources(
            local.selected.filter(function (source) {
              return source.path !== path;
            }).concat([
              {
                kind: "file",
                path: path,
                title: title,
                text: text
              }
            ])
          );
          if (renderFn) renderFn();
        }
      } catch (error) {
        toast(String(error && error.message ? error.message : error), true);
      }
    }

    function openExtractWorkspace(preselected) {
      var project = activeProject(state);
      if (!project) {
        toast("请先新建课题", true);
        return;
      }
      var local = {
        tab: "notes",
        noteQuery: "",
        noteResults: null,
        noteLoading: false,
        selected: mergeExtractionSources(preselected || []),
        extracting: false,
        error: ""
      };
      var overlay = createEl("div", { class: "ra-overlay" });
      var box = createEl("div", {
        class: "ra-modal",
        style: "max-width:920px"
      });
      var api = {
        close: function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }
      };
      var head = createEl("div", { class: "ra-modal-head" }, [
        createEl("div", { class: "ra-modal-title", text: "从资料提取检索词" }),
        createEl("button", {
          class: "ra-modal-close",
          type: "button",
          text: "×",
          onclick: api.close
        })
      ]);
      var body = createEl("div", { class: "ra-modal-body" });
      var foot = createEl("div", { class: "ra-modal-foot" });
      box.appendChild(head);
      box.appendChild(body);
      box.appendChild(foot);
      overlay.appendChild(box);
      overlay.addEventListener("mousedown", function (event) {
        if (event.target === overlay) api.close();
      });
      document.body.appendChild(overlay);

      function sourceSelected(source) {
        var key = sourceKey(source);
        return local.selected.some(function (item) {
          return sourceKey(item) === key;
        });
      }

      function toggleSource(source) {
        var key = sourceKey(source);
        var exists = local.selected.some(function (item) {
          return sourceKey(item) === key;
        });
        if (exists) {
          local.selected = local.selected.filter(function (item) {
            return sourceKey(item) !== key;
          });
        } else {
          if (local.selected.length >= EXTRACT_MAX_SOURCES) {
            toast("最多选择 " + EXTRACT_MAX_SOURCES + " 个来源", true);
            return;
          }
          if (
            source.kind === "file" &&
            local.selected.filter(function (item) {
              return item.kind === "file";
            }).length >= EXTRACT_MAX_FILES
          ) {
            toast("最多选择 " + EXTRACT_MAX_FILES + " 个本地文件", true);
            return;
          }
          local.selected = mergeExtractionSources(local.selected.concat([source]));
        }
        renderExtractWorkspace();
      }

      async function loadNotes(query) {
        local.noteLoading = true;
        local.error = "";
        local.noteResults = local.noteResults || [];
        renderExtractWorkspace();
        try {
          var list;
          if (textOf(query)) {
            list = await app.notes.search(textOf(query), 30);
            local.noteResults = asArray(list).map(function (item) {
              return {
                kind: "note",
                id: item.id,
                title: item.title || "未命名文档",
                snippet: item.snippet || "",
                updatedAt: item.updated_at || ""
              };
            });
          } else {
            list = await app.notes.list({ page: 1, page_size: 30 });
            local.noteResults = asArray(list)
              .filter(function (note) {
                return (
                  !note.is_hidden &&
                  !note.is_encrypted &&
                  !note.is_scratch &&
                  (!note.note_type || note.note_type === "markdown")
                );
              })
              .map(function (note) {
                return {
                  kind: "note",
                  id: note.id,
                  title: note.title || "未命名文档",
                  snippet: compactText(note.content || "", 100),
                  updatedAt: note.updated_at || ""
                };
              });
          }
        } catch (error) {
          local.error = "加载文档失败：" + String(error && error.message ? error.message : error);
        } finally {
          local.noteLoading = false;
          renderExtractWorkspace();
        }
      }

      async function runExtract() {
        if (!local.selected.length) {
          toast("请先选择资料", true);
          return;
        }
        local.extracting = true;
        local.error = "";
        renderExtractWorkspace();
        try {
          var resolved = await resolveExtractionSources(local.selected);
          if (!resolved.sources.length) {
            throw new Error(
              resolved.warnings.join("；") || "所选资料没有可用文本"
            );
          }
          var cacheKey = extractionCacheKey(
            project.id,
            resolved.sources,
            state.settings.modelId
          );
          var cached = await storage.get(cacheKey, null);
          if (
            cached &&
            cached.expiresAt &&
            Number(cached.expiresAt) > Date.now() &&
            cached.result
          ) {
            api.close();
            openExtractionResult(cached.result, local.selected, true);
            return;
          }
          var result;
          try {
            result = await extractTopicKeywords(
              app,
              project,
              resolved.sources,
              state.settings.modelId
            );
          } catch (error) {
            result = localExtraction(resolved.sources, project);
            result.warnings = uniqueStrings(
              asArray(result.warnings).concat([
                "AI 调用失败：" +
                  String(error && error.message ? error.message : error)
              ]),
              6
            );
          }
          result.warnings = uniqueStrings(
            asArray(result.warnings).concat(resolved.warnings),
            6
          );
          if (
            result.evaluationMode !== "local_fallback" &&
            resolved.sources.length
          ) {
            await storage.set(cacheKey, {
              expiresAt:
                Date.now() + EXTRACT_CACHE_HOURS * 3600 * 1000,
              result: result
            });
          }
          pushExtractHistory(result, resolved.sources);
          api.close();
          openExtractionResult(result, local.selected, false);
        } catch (error) {
          local.extracting = false;
          local.error = String(error && error.message ? error.message : error);
          renderExtractWorkspace();
        }
      }

      function renderExtractWorkspace() {
        body.innerHTML = "";
        foot.innerHTML = "";

        var tabs = createEl("div", { class: "ra-pick-tabs" });
        [
          ["notes", "从文档选择"],
          ["files", "从本地文献"],
          ["library", "从文献库"]
        ].forEach(function (tab) {
          tabs.appendChild(
            createEl("button", {
              type: "button",
              class: "ra-pick-tab" + (local.tab === tab[0] ? " is-active" : ""),
              text: tab[1],
              onclick: function () {
                local.tab = tab[0];
                renderExtractWorkspace();
                if (tab[0] === "notes" && local.noteResults === null) {
                  void loadNotes("");
                }
              }
            })
          );
        });
        body.appendChild(tabs);

        var content = createEl("div", { class: "ra-pick-content" });
        if (local.tab === "notes") {
          var queryInput = input({
            value: local.noteQuery,
            placeholder: "搜索文档标题或内容（回车搜索）",
            oninput: function (event) {
              local.noteQuery = event.target.value;
            },
            onkeydown: function (event) {
              if (event.key === "Enter") {
                void loadNotes(local.noteQuery);
              }
            }
          });
          content.appendChild(
            createEl("div", { class: "ra-pick-toolbar" }, [
              queryInput,
              button("搜索", function () {
                void loadNotes(local.noteQuery);
              }, { small: true })
            ])
          );
          if (local.noteLoading) {
            content.appendChild(spinner("正在加载文档…"));
          } else if (local.noteResults && local.noteResults.length) {
            var noteList = createEl("div", { class: "ra-pick-list" });
            local.noteResults.forEach(function (item) {
              noteList.appendChild(
                createEl("label", { class: "ra-pick-row" }, [
                  createEl("input", {
                    type: "checkbox",
                    checked: sourceSelected(item),
                    onchange: function () {
                      toggleSource(item);
                    }
                  }),
                  createEl("div", { class: "ra-pick-main" }, [
                    createEl("div", { class: "ra-pick-title", text: item.title }),
                    createEl("div", {
                      class: "ra-pick-meta",
                      text: item.snippet || item.updatedAt || ""
                    })
                  ]),
                  tag("文档", "blue")
                ])
              );
            });
            content.appendChild(noteList);
          } else {
            content.appendChild(emptyState("没有可用文档，试试其他关键词。"));
          }
        } else if (local.tab === "files") {
          content.appendChild(
            createEl("div", { class: "ra-pick-toolbar" }, [
              button("选择本地文献", function () {
                void chooseExtractFiles(local, renderExtractWorkspace);
              }, { primary: true }),
              createEl("span", {
                class: "ra-muted",
                text: "支持 md / txt / pdf / doc / docx / xlsx，最多 5 个"
              })
            ])
          );
          var files = local.selected.filter(function (source) {
            return source.kind === "file";
          });
          if (files.length) {
            var fileList = createEl("div", { class: "ra-pick-list" });
            files.forEach(function (source) {
              fileList.appendChild(
                createEl("div", { class: "ra-pick-row" }, [
                  createEl("div", { class: "ra-pick-main" }, [
                    createEl("div", { class: "ra-pick-title", text: source.title }),
                    createEl("div", {
                      class: "ra-pick-meta",
                      text: (source.text || "").length + " 字符"
                    })
                  ]),
                  tag("本地文献", "cyan"),
                  button("移除", function () {
                    local.selected = local.selected.filter(function (item) {
                      return sourceKey(item) !== sourceKey(source);
                    });
                    renderExtractWorkspace();
                  }, { small: true, danger: true })
                ])
              );
            });
            content.appendChild(fileList);
          } else {
            content.appendChild(emptyState("尚未选择本地文献。"));
          }
        } else {
          var libraryRows = createEl("div", { class: "ra-pick-list" });
          if (!state.literature.length) {
            content.appendChild(emptyState("当前课题还没有文献。"));
          } else {
            state.literature.forEach(function (item) {
              var source = {
                kind: "library",
                id: item.id,
                title: item.title || "未命名文献"
              };
              libraryRows.appendChild(
                createEl("label", { class: "ra-pick-row" }, [
                  createEl("input", {
                    type: "checkbox",
                    checked: sourceSelected(source),
                    onchange: function () {
                      toggleSource(source);
                    }
                  }),
                  createEl("div", { class: "ra-pick-main" }, [
                    createEl("div", { class: "ra-pick-title", text: source.title }),
                    createEl("div", {
                      class: "ra-pick-meta",
                      text:
                        [asArray(item.authors).join("、"), item.year, item.venue]
                          .filter(Boolean)
                          .join(" · ") || "题录未完善"
                    })
                  ]),
                  tag("文献库", "purple")
                ])
              );
            });
            content.appendChild(libraryRows);
          }
        }

        content.appendChild(
          createEl("div", { class: "ra-extract-summary" }, [
            createEl("div", {
              class: "ra-field-label",
              text:
                "已选 " +
                local.selected.length +
                " 个来源（" +
                local.selected
                  .map(function (source) {
                    return extractionKindLabel(source.kind);
                  })
                  .filter(function (value, index, list) {
                    return list.indexOf(value) === index;
                  })
                  .join(" / ") +
                "）"
            }),
            local.selected.length
              ? createEl(
                  "div",
                  { class: "ra-selected-list" },
                  local.selected.map(function (source) {
                    return createEl("span", { class: "ra-chip" }, [
                      createEl("span", {
                        text:
                          extractionKindLabel(source.kind) +
                          "：" +
                          (source.title || "")
                      }),
                      createEl("button", {
                        type: "button",
                        class: "ra-chip-x",
                        text: "×",
                        onclick: function () {
                          local.selected = local.selected.filter(function (item) {
                            return sourceKey(item) !== sourceKey(source);
                          });
                          renderExtractWorkspace();
                        }
                      })
                    ]);
                  })
                )
              : null,
            createEl("div", {
              class: "ra-extract-note",
              text: "仅将所选内容发送给当前 AI 模型；隐藏/加密文档会自动跳过。"
            })
          ])
        );

        if (state.extractHistory.length) {
          var history = createEl("div", { class: "ra-history" });
          history.appendChild(
            createEl("div", { class: "ra-field-label", text: "最近提取" })
          );
          state.extractHistory.slice(0, 3).forEach(function (item) {
            history.appendChild(
              createEl("button", {
                type: "button",
                class: "ra-history-row",
                onclick: function () {
                  api.close();
                  applyExtraction(item.topic, item.keywords);
                }
              }, [
                createEl("span", { text: item.topic }),
                createEl("span", {
                  class: "ra-muted",
                  text: asArray(item.keywords).slice(0, 4).join("、")
                })
              ])
            );
          });
          content.appendChild(history);
        }

        if (local.error) {
          body.appendChild(
            createEl("div", { class: "ra-alert", text: local.error })
          );
        }
        body.appendChild(content);

        foot.appendChild(
          button("取消", api.close, { ghost: true })
        );
        foot.appendChild(
          button(
            local.extracting ? "提取中…" : "AI 提取检索词",
            safe(runExtract),
            { primary: true, disabled: local.extracting || !local.selected.length }
          )
        );
      }

      renderExtractWorkspace();
      void loadNotes("");
    }

    function openExtractionResult(result, selected, cached) {
      var project = activeProject(state);
      if (!project) return;
      var keywords = asArray(result.keywords).slice();
      var overlay = createEl("div", { class: "ra-overlay" });
      var box = createEl("div", { class: "ra-modal", style: "max-width:760px" });
      var api = {
        close: function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }
      };
      var head = createEl("div", { class: "ra-modal-head" }, [
        createEl("div", { class: "ra-modal-title", text: "提取结果" }),
        createEl("button", {
          class: "ra-modal-close",
          type: "button",
          text: "×",
          onclick: api.close
        })
      ]);
      var body = createEl("div", { class: "ra-modal-body" });
      var foot = createEl("div", { class: "ra-modal-foot" });

      body.appendChild(
        createEl("div", { class: "ra-row-actions" }, [
          result.evaluationMode === "local_fallback"
            ? tag("本地规则兜底", "amber")
            : tag("AI 提取", "green"),
          tag("置信度 " + Math.round((result.confidence || 0) * 100) + "%"),
          cached ? tag("缓存结果", "muted") : null
        ].filter(Boolean))
      );

      var topicInput = input({
        value: result.topic || project.title,
        placeholder: "研究主题"
      });
      body.appendChild(field("研究主题", topicInput));

      if (asArray(result.topicCandidates).length) {
        body.appendChild(
          createEl("div", { class: "ra-field" }, [
            createEl("span", { class: "ra-field-label", text: "候选主题" }),
            createEl(
              "div",
              { class: "ra-tag-row" },
              result.topicCandidates.map(function (candidate) {
                return createEl("button", {
                  type: "button",
                  class: "ra-candidate",
                  text: candidate,
                  onclick: function () {
                    topicInput.value = candidate;
                  }
                });
              })
            )
          ])
        );
      }

      var chipRow = createEl("div", { class: "ra-tag-row" });
      var addInput = input({
        placeholder: "添加关键词后回车",
        onkeydown: function (event) {
          if (event.key === "Enter") {
            addKeyword();
          }
        }
      });
      function renderChips() {
        chipRow.innerHTML = "";
        keywords.forEach(function (keyword, index) {
          chipRow.appendChild(
            createEl("span", { class: "ra-chip ra-chip-editable" }, [
              createEl("span", { text: keyword }),
              createEl("button", {
                type: "button",
                class: "ra-chip-x",
                text: "×",
                onclick: function () {
                  keywords.splice(index, 1);
                  renderChips();
                }
              })
            ])
          );
        });
      }
      function addKeyword() {
        var value = textOf(addInput.value);
        if (!value) return;
        keywords = uniqueStrings(keywords.concat([value]), 12);
        addInput.value = "";
        renderChips();
      }
      renderChips();
      body.appendChild(
        createEl("div", { class: "ra-field" }, [
          createEl("span", { class: "ra-field-label", text: "关键词" }),
          chipRow,
          createEl("div", { class: "ra-form-row" }, [
            addInput,
            button("添加", addKeyword, { small: true })
          ])
        ])
      );

      if (asArray(result.researchQuestions).length) {
        body.appendChild(
          createEl("div", { class: "ra-field" }, [
            createEl("span", { class: "ra-field-label", text: "研究问题" }),
            createEl(
              "ul",
              { class: "ra-extract-list" },
              result.researchQuestions.map(function (item) {
                return createEl("li", { text: item });
              })
            )
          ])
        );
      }
      if (asArray(result.methods).length) {
        body.appendChild(
          createEl("div", { class: "ra-field" }, [
            createEl("span", { class: "ra-field-label", text: "相关方法" }),
            createEl(
              "ul",
              { class: "ra-extract-list" },
              result.methods.map(function (item) {
                return createEl("li", { text: item });
              })
            )
          ])
        );
      }
      if (asArray(result.warnings).length) {
        body.appendChild(
          createEl(
            "div",
            { class: "ra-alert" },
            result.warnings.map(function (warning) {
              return createEl("div", { text: warning });
            })
          )
        );
      }

      function currentKeywords() {
        return uniqueStrings(keywords, 12);
      }

      foot.appendChild(
        button("关闭", api.close, { ghost: true })
      );
      foot.appendChild(
        button("重新提取", function () {
          api.close();
          openExtractWorkspace(selected);
        }, { small: true })
      );
      foot.appendChild(
        button("保存为课题关键词", safe(async function () {
          var next = currentKeywords();
          if (!next.length) {
            toast("关键词不能为空", true);
            return;
          }
          var current = activeProject(state);
          if (!current) return;
          current.keywords = next.join("，");
          current.updatedAt = nowIso();
          await persistMeta();
          toast("已保存到课题关键词");
          render();
        }), { small: true })
      );
      foot.appendChild(
        button("应用到检索", safe(async function () {
          if (!applyExtraction(topicInput.value, currentKeywords())) return;
          api.close();
        }), { small: true })
      );
      foot.appendChild(
        button("应用并检索", safe(async function () {
          if (!applyExtraction(topicInput.value, currentKeywords())) return;
          api.close();
          await actions.runSearch();
        }), { primary: true })
      );

      box.appendChild(head);
      box.appendChild(body);
      box.appendChild(foot);
      overlay.appendChild(box);
      overlay.addEventListener("mousedown", function (event) {
        if (event.target === overlay) api.close();
      });
      document.body.appendChild(overlay);
    }

    function modelName() {
      var model = defaultModel();
      return model ? model.name : "未配置默认模型";
    }

    // ── 渲染 ──
    function render() {
      if (disposed) return;
      var scrollTop = container.scrollTop || 0;
      var fragment = document.createDocumentFragment();
      fragment.appendChild(renderHeader());
      fragment.appendChild(renderTabs());
      fragment.appendChild(renderBody());
      root.replaceChildren
        ? root.replaceChildren(fragment)
        : (function () {
            root.innerHTML = "";
            root.appendChild(fragment);
          })();
      container.scrollTop = scrollTop;
    }

    function renderHeader() {
      var project = activeProject(state);
      var options = state.meta.projects.map(function (item) {
        return {
          value: item.id,
          label: item.title,
          selected: project && item.id === project.id
        };
      });
      if (!options.length) options.push({ value: "", label: "暂无课题" });
      var projectSelect = select(
        {
          style: "min-width:220px",
          disabled: !state.meta.projects.length,
          onchange: safe(function (event) {
            return actions.selectProject(event.target.value);
          })
        },
        options
      );
      return createEl("header", { class: "ra-header" }, [
        createEl("div", { class: "ra-title-wrap" }, [
          createEl("h1", { class: "ra-title", text: "AI 助研" }),
          createEl("p", {
            class: "ra-subtitle",
            text:
              "课题 · 文献 · 前沿追踪 · 学术写作 · 数据分析；AI 结果需人工核验。当前模型：" +
              modelName()
          })
        ]),
        createEl("div", { class: "ra-header-actions" }, [
          projectSelect,
          button("新建课题", safe(actions.newProject)),
          button(
            "编辑",
            safe(actions.editProject),
            { disabled: !project }
          ),
          button(
            "删除",
            safe(actions.deleteProject),
            { danger: true, disabled: !project }
          )
        ])
      ]);
    }

    var TAB_DEFS = [
      ["overview", "概览"],
      ["discover", "发现"],
      ["library", "文献库"],
      ["read", "精读"],
      ["writing", "写作"],
      ["outputs", "产出"],
      ["settings", "设置"]
    ];

    function renderTabs() {
      var tabs = createEl("nav", { class: "ra-tabs" });
      TAB_DEFS.forEach(function (def) {
        tabs.appendChild(
          createEl("button", {
            type: "button",
            class: "ra-tab" + (state.activeTab === def[0] ? " is-active" : ""),
            text: def[1],
            onclick: safe(function () {
              state.activeTab = def[0];
              render();
            })
          })
        );
      });
      return tabs;
    }

    function renderBody() {
      var body = createEl("div", { class: "ra-body" });
      if (state.error) {
        body.appendChild(createEl("div", { class: "ra-alert", text: state.error }));
      }
      if (state.activeTab === "overview") body.appendChild(renderOverview());
      else if (state.activeTab === "discover") body.appendChild(renderDiscover());
      else if (state.activeTab === "library") body.appendChild(renderLibrary());
      else if (state.activeTab === "read") body.appendChild(renderRead());
      else if (state.activeTab === "writing") body.appendChild(renderWriting());
      else if (state.activeTab === "outputs") body.appendChild(renderOutputs());
      else body.appendChild(renderSettings());
      return body;
    }

    // ── 概览 ──
    function renderOverview() {
      var project = activeProject(state);
      if (!project) return renderNoProject();
      var readCount = state.literature.filter(function (item) {
        return item.status === "read";
      }).length;
      var stats = createEl("div", { class: "ra-stats" }, [
        statCard("文献总数", state.literature.length),
        statCard("已读文献", readCount),
        statCard("产出", state.outputs.length),
        statCard("选中文献", selectedLiterature().length)
      ]);
      var quick = createEl("div", { class: "ra-quick-grid" }, [
        quickAction("发现前沿", "检索并筛选近五年前沿论文", function () {
          state.activeTab = "discover";
          render();
        }),
        quickAction("文献综述", "勾选文献后生成综述初稿", function () {
          state.activeTab = "literature";
          toast("先在文献库勾选文献，再点生成综述");
          render();
        }),
        quickAction("论文框架", "生成题目、摘要与章节", function () {
          state.writing.mode = "outline";
          state.activeTab = "writing";
          render();
        }),
        quickAction("PDF 精读", "分析 1–5 篇论文并生成图谱", function () {
          state.activeTab = "read";
          render();
        })
      ]);
      var recent = state.outputs.slice(0, 5);
      var recentNode = recent.length
        ? createEl(
            "div",
            { class: "ra-list" },
            recent.map(function (item) {
              return createEl(
                "div",
                {
                  class: "ra-list-row ra-clickable",
                  onclick: safe(function () {
                    state.activeTab = "outputs";
                    state.viewingOutput = item;
                    render();
                  })
                },
                [
                  createEl("div", { class: "ra-list-main" }, [
                    createEl("div", { class: "ra-list-title", text: item.title }),
                    createEl("div", {
                      class: "ra-list-meta",
                      text: kindLabel(item.kind) + " · " + item.updatedAt
                    })
                  ]),
                  tag(kindLabel(item.kind), "purple")
                ]
              );
            })
          )
        : emptyState("还没有产出。去「发现」「写作」或「精读」生成一份初稿。");

      return createEl("div", { class: "ra-stack" }, [
        stats,
        card(project.title, tag(statusLabel(project.status), "green"), [
          createEl("p", { class: "ra-paragraph", text: project.description || "还没有课题说明。" }),
          createEl(
            "div",
            { class: "ra-tag-row" },
            [project.field ? tag(project.field, "blue") : null]
              .concat(
                splitKeywords(project.keywords).map(function (keyword) {
                  return tag(keyword);
                })
              )
              .filter(Boolean)
          )
        ]),
        card("从这里开始", null, quick),
        card(
          "最近产出",
          button("全部", function () {
            state.activeTab = "outputs";
            render();
          }, { small: true }),
          recentNode
        )
      ]);
    }

    function renderNoProject() {
      return card("开始你的第一个研究课题", null, [
        createEl("p", {
          class: "ra-paragraph",
          text:
            "助研插件把课题、文献、前沿追踪、AI 写作与 PDF 精读放在一起。先建课题，再收集文献。"
        }),
        button("新建课题", safe(actions.newProject), { primary: true })
      ]);
    }

    function statCard(label, value) {
      return createEl("div", { class: "ra-stat" }, [
        createEl("div", { class: "ra-stat-value", text: String(value) }),
        createEl("div", { class: "ra-stat-label", text: label })
      ]);
    }

    function quickAction(title, desc, onClick) {
      return createEl(
        "button",
        {
          type: "button",
          class: "ra-quick",
          onclick: safe(onClick)
        },
        [
          createEl("span", { class: "ra-quick-title", text: title }),
          createEl("span", { class: "ra-quick-desc", text: desc })
        ]
      );
    }

    // ── 发现 ──
    function renderDiscover() {
      var project = activeProject(state);
      var topic = input({
        value: state.searchInput.topic,
        placeholder: "例如：薄壁零件加工变形预测",
        oninput: function (event) {
          state.searchInput.topic = event.target.value;
        }
      });
      var keywords = input({
        value: state.searchInput.keywords,
        placeholder: "补充关键词，逗号分隔",
        oninput: function (event) {
          state.searchInput.keywords = event.target.value;
        }
      });
      var sourceChecks = createEl(
        "div",
        { class: "ra-check-grid" },
        ALL_SOURCES.map(function (source) {
          var checked = state.settings.sources.indexOf(source.id) >= 0;
          return createEl("label", { class: "ra-check" }, [
            createEl("input", {
              type: "checkbox",
              checked: checked,
              onchange: safe(function (event) {
                var list = state.settings.sources.slice();
                if (event.target.checked) {
                  if (list.indexOf(source.id) < 0) list.push(source.id);
                } else {
                  list = list.filter(function (id) {
                    return id !== source.id;
                  });
                }
                state.settings.sources = list;
                persistSettings();
              })
            }),
            createEl("span", { text: source.name })
          ]);
        })
      );
      var searchCard = card("论文检索", tag(project ? project.title : "未绑定课题", "blue"), [
        createEl("div", { class: "ra-form-row" }, [
          field("研究主题", topic),
          field("补充关键词", keywords),
          button(
            "从资料提取",
            safe(function () {
              openExtractWorkspace();
            }),
            { ghost: true }
          ),
          button(
            state.busy === "expand"
              ? "生成英文检索词…"
              : state.busy === "search"
              ? "检索中…"
              : "检索论文",
            safe(actions.runSearch),
            { primary: true, disabled: state.busy === "search" || state.busy === "expand" }
          )
        ]),
        createEl("div", {
          class: "ra-hint",
          text:
            "默认带入课题名称与关键词，可修改；已接入 6 个来源，单个来源失败不影响其他来源。"
        }),
        sourceChecks,
        createEl("div", { class: "ra-filter-row" }, [
          select(
            {
              onchange: function (event) {
                state.searchFilters.source = event.target.value;
                render();
              }
            },
            [{ value: "", label: "全部来源", selected: !state.searchFilters.source }].concat(
              ALL_SOURCES.map(function (source) {
                return {
                  value: source.name,
                  label: source.name,
                  selected: state.searchFilters.source === source.name
                };
              })
            )
          ),
          select(
            {
              onchange: function (event) {
                state.searchFilters.type = event.target.value;
                render();
              }
            },
            [{ value: "", label: "全部类型", selected: !state.searchFilters.type }].concat(
              Object.keys(WORK_TYPES).map(function (key) {
                return {
                  value: key,
                  label: WORK_TYPES[key],
                  selected: state.searchFilters.type === key
                };
              })
            )
          ),
          input({
            type: "number",
            placeholder: "最低年份",
            value: state.searchFilters.minYear || "",
            onchange: function (event) {
              state.searchFilters.minYear = Number(event.target.value) || 0;
              render();
            }
          }),
          input({
            type: "number",
            placeholder: "最低引用",
            value: state.searchFilters.minCitations || "",
            onchange: function (event) {
              state.searchFilters.minCitations = Number(event.target.value) || 0;
              render();
            }
          }),
          select(
            {
              onchange: function (event) {
                state.searchFilters.sort = event.target.value;
                render();
              }
            },
            [
              { value: "relevance", label: "按相关度", selected: state.searchFilters.sort === "relevance" },
              { value: "frontier", label: "按综合分", selected: state.searchFilters.sort === "frontier" },
              { value: "year", label: "按年份", selected: state.searchFilters.sort === "year" },
              { value: "citations", label: "按引用量", selected: state.searchFilters.sort === "citations" }
            ]
          )
        ])
      ]);

      var resultNode;
      if (state.busy === "search") {
        resultNode = card("检索结果", null, spinner("正在跨平台检索…"));
      } else if (!state.search) {
        resultNode = emptyState("输入研究主题后，这里会显示近五年前沿论文。");
      } else {
        resultNode = renderSearchResult();
      }
      return createEl("div", { class: "ra-stack" }, [searchCard, resultNode]);
    }

    function filteredPapers() {
      if (!state.search) return [];
      var filters = state.searchFilters;
      var list = state.search.papers.slice();
      if (filters.source) {
        list = list.filter(function (paper) {
          return asArray(paper.sources).some(function (source) {
            return source.name === filters.source;
          });
        });
      }
      if (filters.type) {
        list = list.filter(function (paper) {
          return paper.workType === filters.type;
        });
      }
      if (filters.minYear) {
        list = list.filter(function (paper) {
          return (paper.year || 0) >= filters.minYear;
        });
      }
      if (filters.minCitations) {
        list = list.filter(function (paper) {
          return (paper.citedByCount || 0) >= filters.minCitations;
        });
      }
      if (filters.sort === "year") {
        list.sort(function (a, b) {
          return (b.year || 0) - (a.year || 0);
        });
      } else if (filters.sort === "citations") {
        list.sort(function (a, b) {
          return (b.citedByCount || 0) - (a.citedByCount || 0);
        });
      } else if (filters.sort === "frontier") {
        list.sort(function (a, b) {
          return (
            (b.frontierScore || 0) - (a.frontierScore || 0) ||
            (b.relevanceScore || 0) - (a.relevanceScore || 0)
          );
        });
      } else {
        list.sort(function (a, b) {
          return (
            (b.relevanceScore || 0) - (a.relevanceScore || 0) ||
            (b.frontierScore || 0) - (a.frontierScore || 0)
          );
        });
      }
      return list;
    }

    function renderSearchResult() {
      var result = state.search;
      var sources = createEl(
        "div",
        { class: "ra-source-row" },
        result.sources.map(function (source) {
          return tag(
            source.name + " · " + (source.available ? source.resultCount + " 篇" : "不可用"),
            source.available ? "blue" : "muted"
          );
        })
      );
      var papers = filteredPapers();
      var list = createEl("div", { class: "ra-list" });
      papers.forEach(function (paper) {
        list.appendChild(renderPaperCard(paper));
      });
      return card(
        "跨平台近五年前沿论文",
        createEl("div", { class: "ra-muted", text: "共 " + papers.length + " 篇" }),
        [
          createEl("div", { class: "ra-stat-row" }, [
            createEl("span", { text: "年份范围 " + result.fromYear + "–" + result.toYear }),
            createEl("span", { text: "跨平台去重后 " + result.total + " 篇" }),
            createEl("span", { text: "当前展示 " + result.papers.length + " 篇" })
          ]),
          result.englishQuery
            ? createEl("div", {
                class: "ra-hint",
                text: "英文扩展检索式：" + result.englishQuery
              })
            : null,
          result.expansionWarning
            ? createEl("div", { class: "ra-alert", text: result.expansionWarning })
            : null,
          sources,
          result.sources.some(function (source) {
            return source.message;
          })
            ? createEl(
                "div",
                { class: "ra-hint" },
                result.sources
                  .filter(function (source) {
                    return source.message;
                  })
                  .map(function (source) {
                    return createEl("div", {
                      text: source.name + "：" + source.message
                    });
                  })
              )
            : null,
          papers.length ? list : emptyState("没有符合当前筛选条件的论文。")
        ].filter(Boolean)
      );
    }

    function renderPaperCard(paper) {
      var identity = paperIdentity(paper);
      var recommendation = state.recommendations[identity];
      var inLibrary = state.literature.some(function (item) {
        return item.identity === identity || samePaper(item, paper);
      });
      var recNode = null;
      if (recommendation && recommendation.loading) {
        recNode = createEl("div", { class: "ra-rec ra-rec-loading", text: "AI 正在评估入库价值…" });
      } else if (recommendation) {
        recNode = createEl("div", { class: "ra-rec ra-rec-" + recommendation.decision }, [
          createEl("div", { class: "ra-rec-head" }, [
            tag(decisionLabel(recommendation.decision), decisionTone(recommendation.decision)),
            tag("置信度 " + Math.round((recommendation.confidence || 0) * 100) + "%"),
            recommendation.evaluationMode === "local_fallback"
              ? tag("本地规则兜底", "muted")
              : null
          ]),
          createEl("p", { class: "ra-paragraph", text: recommendation.reason }),
          recommendation.warning
            ? createEl("p", { class: "ra-warning", text: recommendation.warning })
            : null,
          asArray(recommendation.suggestedTags).length
            ? createEl(
                "div",
                { class: "ra-tag-row" },
                recommendation.suggestedTags.map(function (item) {
                  return tag(item);
                })
              )
            : null
        ]);
      }
      return createEl("article", { class: "ra-paper" }, [
        createEl("div", { class: "ra-paper-head" }, [
          createEl("div", { class: "ra-paper-title", text: paper.title }),
          tag("相关度 " + (paper.relevanceScore || 0), "green"),
          tag("综合分 " + (paper.frontierScore || 0), "blue")
        ]),
        createEl("div", { class: "ra-paper-meta" }, [
          tag(workTypeLabel(paper.workType), "geekblue"),
          createEl("span", { text: (paper.year || "年份未知") + " 年" }),
          createEl("span", { text: asArray(paper.authors).slice(0, 4).join("、") || "作者未收录" }),
          createEl("span", { text: paper.venue || paper.publisher || "来源未收录" }),
          paper.doi ? createEl("span", { text: "DOI " + paper.doi }) : null
        ]),
        createEl(
          "div",
          { class: "ra-tag-row" },
          asArray(paper.sources).map(function (source) {
            return tag(source.name, sourceTone(source.name));
          })
        ),
        createEl("p", { class: "ra-paper-abstract", text: compactText(paper.abstractText || "论文库未提供摘要。", 320) }),
        createEl("div", { class: "ra-reason", text: "筛选依据：" + (paper.rankReason || "") }),
        createEl("div", { class: "ra-paper-actions" }, [
          button(
            inLibrary ? "已在文献库" : "加入文献库",
            safe(function () {
              return actions.importPaper(paper);
            }),
            { primary: !inLibrary, disabled: inLibrary }
          ),
          button(
            recommendation ? "重新评估" : "AI 评估入库",
            safe(function () {
              return actions.recommend(paper);
            }),
            { disabled: !!(recommendation && recommendation.loading) }
          ),
          button("打开原文", function () {
            openExternal(app, paper.url);
          }, { ghost: true })
        ]),
        recNode
      ]);
    }

    // ── 文献库 ──
    function renderLibrary() {
      var project = activeProject(state);
      if (!project) return renderNoProject();
      var query = input({
        value: state.litQuery,
        placeholder: "搜索标题 / 作者 / 摘要 / 标签（回车生效）",
        onchange: function (event) {
          state.litQuery = event.target.value;
          render();
        }
      });
      var statusSelect = select(
        {
          onchange: function (event) {
            state.litStatus = event.target.value;
            render();
          }
        },
        [
          { value: "", label: "全部状态", selected: !state.litStatus },
          { value: "to_read", label: "待读", selected: state.litStatus === "to_read" },
          { value: "reading", label: "在读", selected: state.litStatus === "reading" },
          { value: "read", label: "已读", selected: state.litStatus === "read" }
        ]
      );
      var keyword = String(state.litQuery || "").toLowerCase();
      var items = state.literature.filter(function (item) {
        if (state.litStatus && item.status !== state.litStatus) return false;
        if (!keyword) return true;
        return (
          String(item.title || "") +
          " " +
          asArray(item.authors).join(" ") +
          " " +
          String(item.abstractText || "") +
          " " +
          asArray(item.tags).join(" ")
        )
          .toLowerCase()
          .indexOf(keyword) >= 0;
      });
      var selectedCount = selectedLiterature().length;
      var allLibrarySelected =
        state.literature.length > 0 &&
        state.literature.every(function (item) {
          return !!state.selectedIds[item.id];
        });
      var rows = createEl("div", { class: "ra-list" });
      items.forEach(function (item) {
        rows.appendChild(
          createEl("div", { class: "ra-list-row" }, [
            createEl("input", {
              type: "checkbox",
              checked: !!state.selectedIds[item.id],
              onchange: function (event) {
                state.selectedIds[item.id] = event.target.checked;
                render();
              }
            }),
            createEl("div", { class: "ra-list-main" }, [
              createEl("div", { class: "ra-list-title ra-clickable", text: item.title, onclick: safe(function () {
                return actions.viewLiterature(item);
              }) }),
              createEl("div", {
                class: "ra-list-meta",
                text:
                  [asArray(item.authors).join("、"), item.year, item.venue]
                    .filter(Boolean)
                    .join(" · ") || "题录未完善"
              }),
              createEl(
                "div",
                { class: "ra-tag-row" },
                [tag(statusLabel(item.status), item.status === "read" ? "green" : "muted")]
                  .concat(
                    asArray(item.tags).slice(0, 4).map(function (value) {
                      return tag(value);
                    })
                  )
              )
            ]),
            createEl("div", { class: "ra-row-actions" }, [
              button("编辑", safe(function () {
                return actions.editLiterature(item);
              }), { small: true }),
              button("导出笔记", safe(function () {
                return actions.exportPaper(item);
              }), { small: true, disabled: !!item.noteId }),
              button("删除", safe(function () {
                return actions.deleteLiterature(item);
              }), { small: true, danger: true })
            ])
          ])
        );
      });
      return createEl("div", { class: "ra-stack" }, [
        card("文献库（" + state.literature.length + "）", null, [
          createEl("div", { class: "ra-form-row" }, [
            query,
            statusSelect,
            button(
              allLibrarySelected
                ? "取消全选（" + state.literature.length + "）"
                : "全选（" + state.literature.length + "）",
              function () {
                var next = {};
                if (!allLibrarySelected) {
                  state.literature.forEach(function (item) {
                    next[item.id] = true;
                  });
                }
                state.selectedIds = next;
                render();
              },
              { disabled: state.literature.length === 0 }
            ),
            button("新增文献", safe(actions.addLiterature), { primary: true }),
            button(
              "用选中文献生成综述（" + selectedCount + "）",
              safe(actions.startReview),
              { disabled: selectedCount === 0 }
            ),
            button(
              "导出参考文献（" + selectedCount + "）",
              safe(actions.exportReferences),
              { disabled: selectedCount === 0 }
            )
          ]),
          items.length ? rows : emptyState("还没有文献。可从「发现」导入，或手动新增。")
        ])
      ]);
    }

    // ── 精读 ──
    function renderRead() {
      var project = activeProject(state);
      if (!project) return renderNoProject();
      var fileList = state.analysisFiles.length
        ? createEl(
            "div",
            { class: "ra-file-list" },
            state.analysisFiles.map(function (file) {
              return createEl("div", { class: "ra-file-row" }, [
                createEl("span", { text: file.name }),
                createEl("span", { class: "ra-muted", text: file.content.length + " 字符" })
              ]);
            })
          )
        : emptyState("尚未选择 PDF。最多 5 篇。");
      var contextArea = textarea({
        rows: 6,
        value: state.analysisContext,
        placeholder: "说明研究问题、当前方法、已有数据、评价指标、困难与限制。",
        oninput: function (event) {
          state.analysisContext = event.target.value;
        }
      });
      return createEl("div", { class: "ra-stack" }, [
        card("PDF 精读", tag("最多 5 篇", "blue"), [
          createEl("div", { class: "ra-form-row" }, [
            button("选择 PDF", safe(actions.choosePdfs)),
            button(
              state.busy === "pdf" ? "分析中…" : "分析并生成建议",
              safe(actions.analyzePdfs),
              { primary: true, disabled: state.busy === "pdf" || !state.analysisFiles.length }
            )
          ]),
          fileList,
          field("项目背景", contextArea)
        ]),
        state.busy === "pdf"
          ? card("分析结果", null, spinner("正在解析 PDF 并调用 AI…"))
          : state.analysis
          ? card(
              "分析结果",
              button("保存为产出", safe(actions.saveAnalysis), { small: true }),
              renderAnalysis(state.analysis)
            )
          : emptyState("选择 PDF 后开始分析。扫描版 PDF 可能无法提取文本。")
      ]);
    }

    function renderAnalysis(result) {
      if (result.raw) {
        return createEl("div", { class: "ra-stack" }, [
          createEl("div", { class: "ra-alert", text: "AI 返回内容不是合法 JSON，已按原文展示。" }),
          markdownBlock(result.raw)
        ]);
      }
      var nodes = [];
      nodes.push(card("AI 对项目的理解", null, createEl("p", { class: "ra-paragraph", text: result.projectSummary || "未提供" })));
      var papers = asArray(result.papers);
      if (papers.length) {
        nodes.push(
          card(
            "逐篇论文",
            null,
            papers.map(function (paper, index) {
              return createEl("div", { class: "ra-paper" }, [
                createEl("div", { class: "ra-paper-head" }, [
                  createEl("div", { class: "ra-paper-title", text: paper.title || paper.fileName || "论文 " + (index + 1) }),
                  tag("论文 " + (index + 1), "blue")
                ]),
                createEl("p", { class: "ra-paragraph", text: paper.abstractText || "未提取摘要" }),
                createEl("div", { class: "ra-tag-row" }, asArray(paper.keywords).map(function (keyword) {
                  return tag(keyword, "geekblue");
                })),
                createEl("div", { class: "ra-kv" }, [
                  kv("方法", asArray(paper.methods).join("；") || "未提取"),
                  kv("数据/实验", asArray(paper.dataAndExperiments).join("；") || "未提取"),
                  kv("结论", asArray(paper.conclusions).join("；") || "未提取"),
                  kv("局限", asArray(paper.limitations).join("；") || "未提取")
                ])
              ]);
            })
          )
        );
      }
      var overlaps = asArray(result.keywordOverlaps);
      if (overlaps.length) {
        nodes.push(
          card(
            "共同关键词",
            null,
            overlaps.map(function (item) {
              return createEl("div", { class: "ra-kv-row" }, [
                tag(item.keyword || "", "purple"),
                createEl("span", { text: item.analysis || "" })
              ]);
            })
          )
        );
      }
      var comparisons = asArray(result.comparisons);
      if (comparisons.length) {
        nodes.push(
          card(
            "跨论文异同",
            null,
            comparisons.map(function (item) {
              return createEl("div", { class: "ra-compare" }, [
                createEl("div", { class: "ra-compare-title", text: item.dimension || "维度" }),
                kv("共同点", asArray(item.commonPoints).join("；") || "无"),
                kv("差异", asArray(item.differences).join("；") || "无"),
                kv("冲突", asArray(item.conflicts).join("；") || "无")
              ]);
            })
          )
        );
      }
      var recs = asArray(result.recommendations);
      if (recs.length) {
        nodes.push(
          card(
            "项目建议",
            null,
            recs.map(function (item) {
              return createEl("div", { class: "ra-compare" }, [
                createEl("div", { class: "ra-compare-title" }, [
                  createEl("span", { text: item.title || "建议" }),
                  tag("置信度 " + Math.round((item.confidence || 0) * 100) + "%", "green")
                ]),
                createEl("p", { class: "ra-paragraph", text: item.action || "" }),
                createEl("p", { class: "ra-muted", text: "依据：" + (item.rationale || "") })
              ]);
            })
          )
        );
      }
      var graph = result.graph || {};
      if (asArray(graph.nodes).length) {
        nodes.push(card("论文知识图谱", null, renderGraph(graph.nodes, graph.edges)));
      }
      var warnings = asArray(result.warnings);
      if (warnings.length) {
        nodes.push(
          createEl(
            "div",
            { class: "ra-alert" },
            warnings.map(function (warning) {
              return createEl("div", { text: warning });
            })
          )
        );
      }
      return createEl("div", { class: "ra-stack" }, nodes);
    }

    function kv(label, value) {
      return createEl("div", { class: "ra-kv-item" }, [
        createEl("span", { class: "ra-kv-label", text: label + "：" }),
        createEl("span", { text: value })
      ]);
    }

    function renderGraph(nodes, edges) {
      var svgNS = "http://www.w3.org/2000/svg";
      var width = 760;
      var height = 440;
      var svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("viewBox", "0 0 " + width + " " + height);
      svg.setAttribute("class", "ra-graph");
      var list = asArray(nodes);
      var projectNode = list.filter(function (node) {
        return node.type === "Project";
      })[0];
      var paperNodes = list.filter(function (node) {
        return node.type === "Paper";
      });
      var otherNodes = list.filter(function (node) {
        return node.type !== "Project" && node.type !== "Paper";
      });
      var positions = {};
      var cx = width / 2;
      var cy = height / 2;
      if (projectNode) positions[projectNode.id] = { x: cx, y: cy };
      paperNodes.forEach(function (node, index) {
        var angle = (Math.PI * 2 * index) / Math.max(paperNodes.length, 1);
        positions[node.id] = {
          x: cx + Math.cos(angle) * 130,
          y: cy + Math.sin(angle) * 110
        };
      });
      otherNodes.forEach(function (node, index) {
        var angle = (Math.PI * 2 * index) / Math.max(otherNodes.length, 1) + 0.3;
        positions[node.id] = {
          x: cx + Math.cos(angle) * 240,
          y: cy + Math.sin(angle) * 190
        };
      });
      asArray(edges).forEach(function (edge) {
        var from = positions[edge.source];
        var to = positions[edge.target];
        if (!from || !to) return;
        var line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", from.x);
        line.setAttribute("y1", from.y);
        line.setAttribute("x2", to.x);
        line.setAttribute("y2", to.y);
        line.setAttribute("class", "ra-graph-edge");
        var title = document.createElementNS(svgNS, "title");
        title.textContent = (edge.relation || "") + " " + (edge.reason || "");
        line.appendChild(title);
        svg.appendChild(line);
      });
      list.forEach(function (node) {
        var pos = positions[node.id];
        if (!pos) return;
        var group = document.createElementNS(svgNS, "g");
        var circle = document.createElementNS(svgNS, "circle");
        circle.setAttribute("cx", pos.x);
        circle.setAttribute("cy", pos.y);
        circle.setAttribute("r", node.type === "Project" ? 28 : node.type === "Paper" ? 22 : 16);
        circle.setAttribute("class", "ra-graph-node ra-node-" + String(node.type || "Other").toLowerCase());
        var title = document.createElementNS(svgNS, "title");
        title.textContent = node.label || node.id;
        circle.appendChild(title);
        group.appendChild(circle);
        var label = document.createElementNS(svgNS, "text");
        label.setAttribute("x", pos.x);
        label.setAttribute("y", pos.y + 36);
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("class", "ra-graph-label");
        label.textContent = compactText(node.label || "", 16);
        group.appendChild(label);
        svg.appendChild(group);
      });
      return createEl("div", { class: "ra-graph-wrap" }, svg);
    }

    // ── 写作 ──
    var WRITING_MODES = [
      ["frontier", "前沿追踪"],
      ["review", "文献综述"],
      ["outline", "论文框架"],
      ["polish", "语言润色"],
      ["format", "规范检查"],
      ["analyze", "数据分析"]
    ];

    function renderWriting() {
      var project = activeProject(state);
      if (!project) return renderNoProject();
      var writing = state.writing;
      var modeButtons = createEl(
        "div",
        { class: "ra-segmented" },
        WRITING_MODES.map(function (mode) {
          return createEl("button", {
            type: "button",
            class: "ra-segment" + (writing.mode === mode[0] ? " is-active" : ""),
            text: mode[1],
            onclick: function () {
              writing.mode = mode[0];
              writing.result = "";
              render();
            }
          });
        })
      );
      var topicInput = input({
        value: writing.topic,
        placeholder: "研究主题 / 论文题目",
        oninput: function (event) {
          writing.topic = event.target.value;
        }
      });
      var contentArea = textarea({
        rows: writing.mode === "polish" || writing.mode === "format" || writing.mode === "analyze" ? 10 : 5,
        value: writing.content,
        placeholder: writingPlaceholder(writing.mode),
        oninput: function (event) {
          writing.content = event.target.value;
        }
      });
      var extraInput = input({
        value: writing.extra,
        placeholder: extraPlaceholder(writing.mode),
        oninput: function (event) {
          writing.extra = event.target.value;
        }
      });
      var selected = selectedLiterature();
      var reviewInfo =
        writing.mode === "review"
          ? createEl("div", { class: "ra-hint", text: "已选文献 " + selected.length + " 篇。可在「文献库」勾选。" })
          : null;
      var resultCard = writing.busy
        ? card("生成结果", null, spinner("AI 正在生成…"))
        : writing.result
        ? card(
            "生成结果",
            createEl("div", { class: "ra-row-actions" }, [
              button("复制", function () {
                copyText(writing.result)
                  .then(function () {
                    toast("已复制");
                  })
                  .catch(function (error) {
                    toast(String(error.message || error), true);
                  });
              }, { small: true }),
              button("保存为产出", safe(actions.saveWriting), { small: true, primary: true })
            ]),
            markdownBlock(writing.result)
          )
        : card("生成结果", null, emptyState("生成结果会显示在这里。"));

      return createEl("div", { class: "ra-stack" }, [
        card("学术写作", modeButtons, [
          reviewInfo,
          field("主题 / 题目", topicInput),
          field(writingContentLabel(writing.mode), contentArea),
          field(writingExtraLabel(writing.mode), extraInput),
          createEl("div", { class: "ra-row-actions" }, [
            button(
              writing.busy ? "生成中…" : "开始生成",
              safe(actions.runWriting),
              { primary: true, disabled: writing.busy }
            ),
            button("清空", function () {
              writing.topic = "";
              writing.content = "";
              writing.extra = "";
              writing.result = "";
              render();
            })
          ]),
          createEl("div", { class: "ra-hint", text: "AI 不联网，引用与数据需人工核验。" })
        ]),
        resultCard
      ]);
    }

    function writingPlaceholder(mode) {
      if (mode === "polish") return "粘贴需要润色的文本";
      if (mode === "format") return "粘贴需要检查的章节或全文";
      if (mode === "analyze") return "粘贴数据、表格文本或访谈摘录";
      if (mode === "review") return "可粘贴尚未录入文献库的材料（可选）";
      return "可粘贴背景、初步结果或导师要求（可选）";
    }
    function writingContentLabel(mode) {
      if (mode === "polish") return "待润色文本";
      if (mode === "format") return "待检查文本";
      if (mode === "analyze") return "数据 / 材料";
      if (mode === "review") return "补充材料（可选）";
      return "已有材料（可选）";
    }
    function writingExtraLabel(mode) {
      if (mode === "polish") return "风格要求";
      if (mode === "format") return "检查重点";
      if (mode === "outline") return "论文类型";
      if (mode === "review") return "撰写要求";
      if (mode === "analyze") return "额外要求";
      return "额外要求";
    }
    function extraPlaceholder(mode) {
      if (mode === "outline") return "例如：实证研究 / 开题报告 / 学位论文";
      if (mode === "polish") return "例如：更简洁 / 适合期刊投稿";
      if (mode === "format") return "例如：参考文献格式 / 术语一致性";
      return "可选";
    }

    // ── 产出 ──
    function renderOutputs() {
      var project = activeProject(state);
      if (!project) return renderNoProject();
      var list = createEl("div", { class: "ra-list" });
      state.outputs.forEach(function (item) {
        list.appendChild(
          createEl("div", { class: "ra-list-row" }, [
            createEl("div", { class: "ra-list-main" }, [
              createEl("div", { class: "ra-list-title ra-clickable", text: item.title, onclick: function () {
                state.viewingOutput = item;
                render();
              } }),
              createEl("div", {
                class: "ra-list-meta",
                text: kindLabel(item.kind) + " · " + item.updatedAt
              }),
              createEl("div", { class: "ra-list-snippet", text: compactText(item.content, 120) })
            ]),
            createEl("div", { class: "ra-row-actions" }, [
              button("查看", function () {
                state.viewingOutput = item;
                render();
              }, { small: true }),
              button("复制", function () {
                copyText(item.content).then(function () {
                  toast("已复制");
                }).catch(function (error) {
                  toast(String(error.message || error), true);
                });
              }, { small: true }),
              button("导出笔记", safe(function () {
                return actions.exportOutput(item);
              }), { small: true }),
              button("删除", safe(function () {
                return actions.deleteOutput(item);
              }), { small: true, danger: true })
            ])
          ])
        );
      });
      var viewNode = state.viewingOutput
        ? card(
            state.viewingOutput.title,
            createEl("div", { class: "ra-row-actions" }, [
              button("关闭", function () {
                state.viewingOutput = null;
                render();
              }, { small: true }),
              button("导出笔记", safe(function () {
                return actions.exportOutput(state.viewingOutput);
              }), { small: true, primary: true })
            ]),
            markdownBlock(state.viewingOutput.content)
          )
        : null;
      return createEl("div", { class: "ra-stack" }, [
        card("产出（" + state.outputs.length + "）", null, state.outputs.length ? list : emptyState("还没有产出。")),
        viewNode
      ]);
    }

    // ── 设置 ──
    function renderSettings() {
      var modelOptions = [{ value: "", label: "使用默认模型", selected: !state.settings.modelId }].concat(
        state.models.map(function (model) {
          return {
            value: String(model.id),
            label: model.name + (model.isDefault ? "（默认）" : ""),
            selected: String(state.settings.modelId) === String(model.id)
          };
        })
      );
      var sourceChecks = ALL_SOURCES.map(function (source) {
        return createEl("label", { class: "ra-check" }, [
          createEl("input", {
            type: "checkbox",
            checked: state.settings.sources.indexOf(source.id) >= 0,
            onchange: function (event) {
              var list = state.settings.sources.slice();
              if (event.target.checked) {
                if (list.indexOf(source.id) < 0) list.push(source.id);
              } else {
                list = list.filter(function (id) {
                  return id !== source.id;
                });
              }
              state.settings.sources = list;
            }
          }),
          createEl("span", { text: source.name })
        ]);
      });
      return createEl("div", { class: "ra-stack" }, [
        card("插件设置", null, [
          field(
            "AI 模型",
            select(
              {
                onchange: function (event) {
                  state.settings.modelId = event.target.value
                    ? Number(event.target.value)
                    : null;
                }
              },
              modelOptions
            )
          ),
          field(
            "缓存时长（小时）",
            input({
              type: "number",
              min: 1,
              max: 168,
              value: state.settings.cacheHours,
              onchange: function (event) {
                state.settings.cacheHours = clamp(Number(event.target.value) || 1, 1, 168);
              }
            })
          ),
          field(
            "单次最大结果数",
            input({
              type: "number",
              min: 10,
              max: 100,
              value: state.settings.maxResults,
              onchange: function (event) {
                state.settings.maxResults = clamp(Number(event.target.value) || 30, 10, 100);
              }
            })
          ),
          createEl("label", { class: "ra-check" }, [
            createEl("input", {
              type: "checkbox",
              checked: state.settings.autoExpandQuery !== false,
              onchange: function (event) {
                state.settings.autoExpandQuery = event.target.checked;
              }
            }),
            createEl("span", {
              text: "中文查询自动生成英文扩展（推荐，提升 Crossref / arXiv / DBLP 命中率）"
            })
          ]),
          createEl("div", { class: "ra-field" }, [
            createEl("span", { class: "ra-field-label", text: "启用的论文源" }),
            createEl("div", { class: "ra-check-grid" }, sourceChecks)
          ]),
          createEl("div", { class: "ra-row-actions" }, [
            button("保存设置", safe(actions.saveSettings), { primary: true }),
            button("导出全部数据", safe(actions.exportData)),
            button("导出旧内置数据", safe(actions.exportLegacy)),
            button("清理缓存", safe(actions.clearCache), { ghost: true })
          ])
        ]),
        card("说明", null, [
          createEl("p", {
            class: "ra-paragraph",
            text:
              "数据保存在插件自身的 settings 中，不新增数据表。AI 结果只作为初稿；文献与数据需人工核验。"
          }),
          createEl("p", {
            class: "ra-muted",
            text:
              "网络请求仅允许访问 Crossref、Europe PMC、arXiv、DBLP、PubMed、Semantic Scholar。"
          })
        ])
      ]);
    }

    // ── 动作 ──
    var actions = {
      selectProject: async function (id) {
        state.meta.activeProjectId = id || null;
        await persistMeta();
        state.literature = id ? asArray(await storage.get("lit:" + id, [])) : [];
        state.outputs = id ? asArray(await storage.get("out:" + id, [])) : [];
        state.selectedIds = {};
        state.search = null;
        state.analysis = null;
        state.viewingOutput = null;
        state.searchInput = searchDefaults();
        state.activeTab = "overview";
        render();
      },

      newProject: async function () {
        openProjectEditor(null);
      },

      editProject: async function () {
        var project = activeProject(state);
        if (project) openProjectEditor(project);
      },

      deleteProject: async function () {
        var project = activeProject(state);
        if (!project) return;
        var ok = await confirmDialog(
          "删除课题？",
          "课题下的文献与产出会一并从插件数据中删除，且不可恢复。"
        );
        if (!ok) return;
        state.meta.projects = state.meta.projects.filter(function (item) {
          return item.id !== project.id;
        });
        state.meta.activeProjectId = state.meta.projects.length
          ? state.meta.projects[0].id
          : null;
        await storage.set("lit:" + project.id, []);
        await storage.set("out:" + project.id, []);
        await persistMeta();
        await actions.selectProject(state.meta.activeProjectId);
      },

      runSearch: async function () {
        var project = activeProject(state);
        if (!project) {
          toast("请先新建课题", true);
          return;
        }
        var query = buildQuery(
          state.searchInput.topic,
          state.searchInput.keywords
        );
        if (!query) {
          toast("请输入研究主题", true);
          return;
        }
        var fromYear = currentYear() - 4;
        var sources = state.settings.sources.length
          ? state.settings.sources
          : ALL_SOURCES.map(function (source) {
              return source.id;
            });
        var limit = state.settings.maxResults || DEFAULT_MAX_RESULTS;
        var expansion = {
          englishQuery: "",
          englishKeywords: [],
          alternateQueries: []
        };
        var expansionWarning = "";

        if (queryHasCjk(query) && state.settings.autoExpandQuery !== false) {
          var expandKey =
            "expand:v1:" +
            hashString(
              JSON.stringify({
                projectId: project.id,
                query: query,
                modelId: state.settings.modelId || null
              })
            );
          var cachedExpansion = await storage.get(expandKey, null);
          if (
            cachedExpansion &&
            cachedExpansion.expiresAt &&
            Number(cachedExpansion.expiresAt) > Date.now() &&
            cachedExpansion.result
          ) {
            expansion = cachedExpansion.result;
          } else {
            state.busy = "expand";
            state.error = "";
            render();
            try {
              expansion = await expandSearchQuery(
                app,
                project,
                query,
                state.settings.modelId
              );
              if (expansion.englishQuery || expansion.englishKeywords.length) {
                await storage.set(expandKey, {
                  expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
                  result: expansion
                });
              }
            } catch (error) {
              expansionWarning =
                "英文扩展失败，已使用原查询：" +
                String(error && error.message ? error.message : error);
            }
          }
        }

        // v3：包含英文扩展与新的相关性排序；旧缓存不再复用。
        var cacheKey =
          "cache:v3:" +
          hashString(
            JSON.stringify({
              query: query,
              englishQuery: expansion.englishQuery,
              alternateQueries: expansion.alternateQueries,
              fromYear: fromYear,
              sources: sources,
              limit: limit
            })
          );
        var cached = await storage.get(cacheKey, null);
        if (
          cached &&
          cached.expiresAt &&
          Number(cached.expiresAt) > Date.now() &&
          cacheIsUsable(cached)
        ) {
          state.search = cached.result;
          state.busy = "";
          render();
          toast("已使用缓存结果");
          return;
        }
        state.busy = "search";
        state.error = "";
        render();
        try {
          var result = await searchAll(app, {
            query: query,
            englishQuery: expansion.englishQuery,
            englishKeywords: expansion.englishKeywords,
            alternateQueries: expansion.alternateQueries,
            fromYear: fromYear,
            limit: limit,
            sources: sources
          });
          if (expansionWarning) result.expansionWarning = expansionWarning;
          state.search = result;
          var allFailed =
            result.sources.length > 0 &&
            result.sources.every(function (source) {
              return !source.available;
            });
          if (!allFailed) {
            await storage.set(cacheKey, {
              expiresAt:
                Date.now() +
                (Number(state.settings.cacheHours) || DEFAULT_CACHE_HOURS) *
                  3600 *
                  1000,
              result: result
            });
          }
        } catch (error) {
          state.error = String(error && error.message ? error.message : error);
          toast(state.error, true);
        } finally {
          state.busy = "";
          render();
        }
      },

      importPaper: async function (paper) {
        var project = activeProject(state);
        if (!project) {
          toast("请先新建课题", true);
          return;
        }
        var identity = paperIdentity(paper);
        var exists = state.literature.some(function (item) {
          return item.identity === identity || samePaper(item, paper);
        });
        if (exists) {
          toast("这篇论文已在文献库中");
          return;
        }
        state.literature.unshift(mapPaperToLiterature(paper));
        await persistLiterature();
        toast("已加入文献库");
        render();
      },

      recommend: async function (paper) {
        var project = activeProject(state);
        if (!project) {
          toast("请先新建课题", true);
          return;
        }
        var identity = paperIdentity(paper);
        state.recommendations[identity] = { loading: true };
        render();
        try {
          var recommendation = await recommendPaper(
            app,
            paper,
            project,
            state.settings.modelId
          );
          state.recommendations[identity] = recommendation;
        } catch (error) {
          toast(String(error && error.message ? error.message : error), true);
          delete state.recommendations[identity];
        }
        render();
      },

      addLiterature: async function () {
        openLiteratureEditor(null);
      },

      viewLiterature: async function (item) {
        openLiteratureView(item);
      },

      editLiterature: async function (item) {
        openLiteratureEditor(item);
      },

      deleteLiterature: async function (item) {
        var ok = await confirmDialog("删除文献？", "将从当前课题移除这篇文献。");
        if (!ok) return;
        state.literature = state.literature.filter(function (row) {
          return row.id !== item.id;
        });
        delete state.selectedIds[item.id];
        await persistLiterature();
        render();
      },

      startReview: async function () {
        var selected = selectedLiterature();
        if (!selected.length) {
          toast("请先勾选文献", true);
          return;
        }
        state.writing.mode = "review";
        state.writing.topic = activeProject(state) ? activeProject(state).title : "";
        state.writing.content = "";
        state.writing.result = "";
        state.activeTab = "writing";
        render();
      },

      exportReferences: async function () {
        var project = activeProject(state);
        var selected = selectedLiterature();
        if (!project) {
          toast("请先新建课题", true);
          return;
        }
        if (!selected.length) {
          toast("请先勾选文献", true);
          return;
        }
        var format = "gbt7714";
        var preview = textarea({
          rows: 16,
          readonly: true,
          value: ""
        });
        preview.classList.add("ra-ref-preview");
        function generate() {
          return buildReferenceIndex(selected, format);
        }
        function refresh() {
          preview.value = generate();
        }
        refresh();
        var formatSelect = select(
          {
            onchange: function (event) {
              format = event.target.value;
              refresh();
            }
          },
          [
            { value: "gbt7714", label: "GB/T 7714 参考文献表", selected: true },
            { value: "bibtex", label: "BibTeX" }
          ]
        );
        var modal;
        modal = openModal({
          title: "导出参考文献索引",
          width: 820,
          content: createEl("div", { class: "ra-form" }, [
            createEl("div", {
              class: "ra-hint",
              text:
                "已选 " +
                selected.length +
                " 篇；题录缺失字段会留空，请在导出后人工核对。"
            }),
            field("导出格式", formatSelect),
            field("预览", preview)
          ]),
          actions: [
            {
              label: "关闭",
              onClick: function () {
                modal.close();
              }
            },
            {
              label: "复制",
              onClick: safe(async function () {
                await copyText(generate());
                toast("参考文献索引已复制");
              })
            },
            {
              label: "保存为笔记",
              onClick: safe(async function () {
                var body =
                  format === "bibtex"
                    ? "```bibtex\n" + generate() + "\n```"
                    : generate();
                var folder = await ensureResearchFolder(app);
                await app.notes.create({
                  title: "参考文献索引｜" + project.title,
                  content: "# 参考文献索引\n\n" + body,
                  folder_id: folder.id
                });
                toast("已保存为笔记");
              })
            },
            {
              label: "下载文件",
              primary: true,
              onClick: safe(async function () {
                var ext = format === "bibtex" ? "bib" : "md";
                var mime =
                  format === "bibtex"
                    ? "application/x-bibtex;charset=utf-8"
                    : "text/markdown;charset=utf-8";
                downloadFile(
                  safeFilePart("参考文献-" + project.title) + "." + ext,
                  generate(),
                  mime
                );
                toast("已开始下载");
              })
            }
          ]
        });
      },

      runWriting: async function () {
        var project = activeProject(state);
        if (!project) {
          toast("请先新建课题", true);
          return;
        }
        var writing = state.writing;
        if (
          (writing.mode === "frontier" || writing.mode === "outline") &&
          !String(writing.topic || "").trim()
        ) {
          toast("请填写主题 / 题目", true);
          return;
        }
        if (
          (writing.mode === "polish" ||
            writing.mode === "format" ||
            writing.mode === "analyze") &&
          !String(writing.content || "").trim()
        ) {
          toast("请填写需要处理的文本或数据", true);
          return;
        }
        if (
          writing.mode === "review" &&
          !selectedLiterature().length &&
          !String(writing.topic || "").trim() &&
          !String(writing.content || "").trim()
        ) {
          toast("请先勾选文献，或填写主题 / 补充材料", true);
          return;
        }
        writing.busy = true;
        writing.result = "";
        render();
        try {
          writing.result = await generateWorkflow(
            app,
            writing.mode,
            project,
            writing,
            selectedLiterature(),
            state.settings.modelId
          );
        } catch (error) {
          toast(String(error && error.message ? error.message : error), true);
        } finally {
          writing.busy = false;
          render();
        }
      },

      saveWriting: async function () {
        var project = activeProject(state);
        if (!project || !state.writing.result) return;
        var defaultTitle =
          kindLabel(state.writing.mode) +
          " · " +
          (state.writing.topic || project.title).slice(0, 30);
        var title = await promptText("保存为产出", defaultTitle, "给这份产出起个名字");
        if (!title) return;
        state.outputs.unshift({
          id: uid("out"),
          projectId: project.id,
          kind: state.writing.mode,
          title: title,
          content: state.writing.result,
          sourceRef:
            state.writing.mode === "review"
              ? "literature:" +
                selectedLiterature()
                  .map(function (item) {
                    return item.id;
                  })
                  .join(",")
              : modelName(),
          createdAt: nowIso(),
          updatedAt: nowIso()
        });
        await persistOutputs();
        toast("已保存到产出");
        render();
      },

      choosePdfs: async function () {
        try {
          var selected = await app.invoke("plugin:dialog|open", {
            options: {
              multiple: true,
              filters: [{ name: "PDF 论文", extensions: ["pdf"] }]
            }
          });
          if (!selected) return;
          var paths = Array.isArray(selected) ? selected : [selected];
          if (paths.length > MAX_PDF_FILES) {
            toast("最多选择 " + MAX_PDF_FILES + " 篇，已截取前 " + MAX_PDF_FILES + " 篇", true);
            paths = paths.slice(0, MAX_PDF_FILES);
          }
          state.analysisFiles = paths.map(function (path) {
            return { path: path, name: baseName(path), content: "" };
          });
          state.analysis = null;
          render();
        } catch (error) {
          toast(String(error && error.message ? error.message : error), true);
        }
      },

      analyzePdfs: async function () {
        var project = activeProject(state);
        if (!project) {
          toast("请先新建课题", true);
          return;
        }
        if (!state.analysisFiles.length) {
          toast("请先选择 PDF", true);
          return;
        }
        state.busy = "pdf";
        state.error = "";
        render();
        try {
          var parsed = [];
          for (var i = 0; i < state.analysisFiles.length; i += 1) {
            var file = state.analysisFiles[i];
            var preview = await app.invoke("ai_parse_attachment", {
              filePath: file.path
            });
            var content =
              preview && (preview.content || preview.markdown)
                ? String(preview.content || preview.markdown)
                : "";
            if (!content.trim()) {
              toast("未能提取 " + file.name + " 的文本（可能是扫描版 PDF）", true);
            }
            parsed.push({
              name: file.name,
              content: content
            });
          }
          if (!parsed.some(function (item) { return item.content.trim(); })) {
            throw new Error("所选 PDF 均未提取到文本");
          }
          state.analysis = await analyzePdfs(
            app,
            project,
            parsed,
            state.analysisContext,
            state.settings.modelId
          );
        } catch (error) {
          state.error = String(error && error.message ? error.message : error);
          toast(state.error, true);
        } finally {
          state.busy = "";
          render();
        }
      },

      saveAnalysis: async function () {
        var project = activeProject(state);
        if (!project || !state.analysis) return;
        var title = await promptText(
          "保存分析结果",
          "PDF 精读 · " + project.title,
          "给这份分析起个名字"
        );
        if (!title) return;
        var content = analysisToMarkdown(state.analysis);
        state.outputs.unshift({
          id: uid("out"),
          projectId: project.id,
          kind: "analysis",
          title: title,
          content: content,
          sourceRef: modelName(),
          createdAt: nowIso(),
          updatedAt: nowIso()
        });
        await persistOutputs();
        toast("分析结果已保存到产出");
        render();
      },

      exportPaper: async function (item) {
        var project = activeProject(state);
        try {
          var recommendation = state.recommendations[item.identity] || null;
          var note = await exportPaperToNote(app, item, project, recommendation);
          item.noteId = note.id;
          await persistLiterature();
          toast("已导出为笔记");
          render();
        } catch (error) {
          toast("导出失败：" + String(error && error.message ? error.message : error), true);
        }
      },

      exportOutput: async function (item) {
        if (!item) return;
        try {
          await exportOutputToNote(app, item);
          toast("已导出为笔记");
        } catch (error) {
          toast("导出失败：" + String(error && error.message ? error.message : error), true);
        }
      },

      deleteOutput: async function (item) {
        var ok = await confirmDialog("删除产出？", "删除后不可恢复。");
        if (!ok) return;
        state.outputs = state.outputs.filter(function (row) {
          return row.id !== item.id;
        });
        if (state.viewingOutput && state.viewingOutput.id === item.id) {
          state.viewingOutput = null;
        }
        await persistOutputs();
        render();
      },

      saveSettings: async function () {
        await persistSettings();
        toast("设置已保存");
        render();
      },

      exportData: async function () {
        var dump = {
          exportedAt: nowIso(),
          meta: state.meta,
          settings: state.settings,
          projects: []
        };
        for (var i = 0; i < state.meta.projects.length; i += 1) {
          var project = state.meta.projects[i];
          dump.projects.push({
            project: project,
            literature: asArray(await storage.get("lit:" + project.id, [])),
            outputs: asArray(await storage.get("out:" + project.id, []))
          });
        }
        downloadText("research-assistant-data.json", JSON.stringify(dump, null, 2));
        toast("已导出全部课题数据");
      },

      exportLegacy: async function () {
        try {
          var projects = await app.invoke("research_list_projects");
          var dump = { exportedAt: nowIso(), projects: [] };
          for (var i = 0; i < projects.length; i += 1) {
            var project = projects[i];
            var literature = await app.invoke("research_list_literature", {
              projectId: project.id
            });
            var outputs = await app.invoke("research_list_outputs", {
              projectId: project.id
            });
            dump.projects.push({
              project: project,
              literature: literature,
              outputs: outputs
            });
          }
          downloadText("research-legacy-data.json", JSON.stringify(dump, null, 2));
          toast("旧内置数据已导出");
        } catch (error) {
          toast("旧数据导出失败：" + String(error && error.message ? error.message : error), true);
        }
      },

      clearCache: async function () {
        var all = await app.settings.getAll();
        var keys = Object.keys(all || {}).filter(function (key) {
          return (
            key.indexOf("cache:") === 0 ||
            key.indexOf("extract:") === 0 ||
            key.indexOf("expand:") === 0
          );
        });
        for (var i = 0; i < keys.length; i += 1) {
          await app.settings.set(keys[i], null);
        }
        toast("缓存已清理");
      }
    };

    function mapPaperToLiterature(paper) {
      return {
        id: uid("lit"),
        identity: paperIdentity(paper),
        title: paper.title || "",
        authors: asArray(paper.authors),
        year: paper.year || null,
        venue: paper.venue || "",
        publisher: paper.publisher || "",
        workType: paper.workType || "journal-article",
        citedByCount: paper.citedByCount || 0,
        doi: paper.doi || "",
        url: paper.url || "",
        sources: asArray(paper.sources),
        abstractText: paper.abstractText || "",
        notes: "",
        tags: [],
        status: "to_read",
        frontierScore: paper.frontierScore || 0,
        rankReason: paper.rankReason || "",
        highlights: asArray(paper.highlights),
        noteId: null,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
    }

    function openProjectEditor(project) {
      var title = input({ value: project ? project.title : "", placeholder: "课题名称" });
      var fieldValue = input({ value: project ? project.field : "", placeholder: "学科 / 研究方向" });
      var keywords = input({ value: project ? project.keywords : "", placeholder: "关键词，逗号分隔" });
      var status = select(
        {},
        [
          { value: "active", label: "进行中", selected: !project || project.status === "active" },
          { value: "paused", label: "已暂停", selected: project && project.status === "paused" },
          { value: "archived", label: "已归档", selected: project && project.status === "archived" }
        ]
      );
      var description = textarea({
        rows: 4,
        value: project ? project.description : "",
        placeholder: "研究背景、目标、已有基础、导师要求"
      });
      var modal = openModal({
        title: project ? "编辑课题" : "新建课题",
        width: 640,
        content: createEl("div", { class: "ra-form" }, [
          field("课题名称", title),
          field("学科 / 研究方向", fieldValue),
          field("关键词", keywords),
          field("状态", status),
          field("课题说明", description)
        ]),
        actions: [
          { label: "取消", onClick: function () { modal.close(); } },
          {
            label: "保存",
            primary: true,
            onClick: safe(async function () {
              var value = String(title.value || "").trim();
              if (!value) {
                toast("课题名称不能为空", true);
                return;
              }
              var next = {
                id: project ? project.id : uid("proj"),
                title: value,
                field: String(fieldValue.value || "").trim(),
                keywords: String(keywords.value || "").trim(),
                status: status.value,
                description: String(description.value || "").trim(),
                createdAt: project ? project.createdAt : nowIso(),
                updatedAt: nowIso()
              };
              if (project) {
                state.meta.projects = state.meta.projects.map(function (item) {
                  return item.id === project.id ? next : item;
                });
              } else {
                state.meta.projects.unshift(next);
                state.meta.activeProjectId = next.id;
              }
              await persistMeta();
              modal.close();
              await actions.selectProject(state.meta.activeProjectId);
            })
          }
        ]
      });
    }

    function openLiteratureEditor(item) {
      var project = activeProject(state);
      if (!project) {
        toast("请先新建课题", true);
        return;
      }
      var title = input({ value: item ? item.title : "", placeholder: "论文标题" });
      var authors = input({
        value: item ? asArray(item.authors).join("、") : "",
        placeholder: "作者，逗号分隔"
      });
      var year = input({
        type: "number",
        value: item && item.year ? item.year : "",
        placeholder: "年份"
      });
      var venue = input({ value: item ? item.venue : "", placeholder: "期刊 / 会议" });
      var doi = input({ value: item ? item.doi : "", placeholder: "DOI" });
      var url = input({ value: item ? item.url : "", placeholder: "链接" });
      var tags = input({
        value: item ? asArray(item.tags).join("、") : "",
        placeholder: "标签，逗号分隔"
      });
      var status = select(
        {},
        [
          { value: "to_read", label: "待读", selected: !item || item.status === "to_read" },
          { value: "reading", label: "在读", selected: item && item.status === "reading" },
          { value: "read", label: "已读", selected: item && item.status === "read" }
        ]
      );
      var abstractText = textarea({
        rows: 4,
        value: item ? item.abstractText : "",
        placeholder: "摘要"
      });
      var notes = textarea({
        rows: 3,
        value: item ? item.notes : "",
        placeholder: "阅读笔记 / 摘录"
      });
      var modal = openModal({
        title: item ? "编辑文献" : "新增文献",
        width: 760,
        content: createEl("div", { class: "ra-form" }, [
          field("标题", title),
          createEl("div", { class: "ra-form-row" }, [
            field("作者", authors),
            field("年份", year),
            field("状态", status)
          ]),
          createEl("div", { class: "ra-form-row" }, [
            field("期刊 / 会议", venue),
            field("DOI", doi)
          ]),
          field("链接", url),
          field("标签", tags),
          field("摘要", abstractText),
          field("阅读笔记", notes)
        ]),
        actions: [
          { label: "取消", onClick: function () { modal.close(); } },
          {
            label: "保存",
            primary: true,
            onClick: safe(async function () {
              var value = String(title.value || "").trim();
              if (!value) {
                toast("文献标题不能为空", true);
                return;
              }
              var next = Object.assign({}, item || {}, {
                id: item ? item.id : uid("lit"),
                identity: item && item.identity
                  ? item.identity
                  : "title:" + normalizeTitle(value) + ":" + String(year.value || ""),
                title: value,
                authors: splitList(String(authors.value || "").replace(/、/g, "，")),
                year: Number(year.value) || null,
                venue: String(venue.value || "").trim(),
                doi: String(doi.value || "").trim(),
                url: String(url.value || "").trim(),
                tags: splitList(String(tags.value || "").replace(/、/g, "，")),
                status: status.value,
                abstractText: String(abstractText.value || "").trim(),
                notes: String(notes.value || "").trim(),
                sources: item && item.sources ? item.sources : [],
                citedByCount: item ? item.citedByCount : 0,
                workType: item ? item.workType : "journal-article",
                frontierScore: item ? item.frontierScore : 0,
                rankReason: item ? item.rankReason : "",
                highlights: item ? item.highlights : [],
                publisher: item ? item.publisher : "",
                noteId: item ? item.noteId : null,
                createdAt: item ? item.createdAt : nowIso(),
                updatedAt: nowIso()
              });
              if (item) {
                state.literature = state.literature.map(function (row) {
                  return row.id === item.id ? next : row;
                });
              } else {
                state.literature.unshift(next);
              }
              await persistLiterature();
              modal.close();
              render();
            })
          }
        ]
      });
    }

    function openLiteratureView(item) {
      var modal = openModal({
        title: item.title,
        width: 720,
        content: createEl("div", { class: "ra-stack" }, [
          createEl("div", { class: "ra-tag-row" }, [
            tag(workTypeLabel(item.workType), "blue"),
            tag(statusLabel(item.status)),
            item.doi ? tag("DOI " + item.doi) : null
          ]),
          createEl("p", { class: "ra-muted", text:
            [asArray(item.authors).join("、"), item.year, item.venue].filter(Boolean).join(" · ")
          }),
          createEl("h4", { class: "ra-subhead", text: "摘要" }),
          createEl("p", { class: "ra-paragraph", text: item.abstractText || "未填写" }),
          createEl("h4", { class: "ra-subhead", text: "阅读笔记" }),
          createEl("p", { class: "ra-paragraph", text: item.notes || "未填写" }),
          createEl("h4", { class: "ra-subhead", text: "筛选依据" }),
          createEl("p", { class: "ra-paragraph", text: item.rankReason || "无" })
        ]),
        actions: [
          { label: "关闭", onClick: function () { modal.close(); } },
          item.url
            ? {
                label: "打开原文",
                onClick: function () {
                  openExternal(app, item.url);
                }
              }
            : null,
          {
            label: "编辑",
            primary: true,
            onClick: function () {
              modal.close();
              openLiteratureEditor(item);
            }
          }
        ].filter(Boolean)
      });
    }

    async function init() {
      try {
        var loaded = await loadState(app, storage);
        state = loaded;
        state.searchInput = searchDefaults();
        state.litQuery = "";
        state.litStatus = "";
        state.analysisContext = "";
        state.analysisFiles = [];
        state.viewingOutput = null;
        state.activeTab = "overview";
        render();
      } catch (error) {
        state.error = "加载助研数据失败：" + String(error && error.message ? error.message : error);
        render();
      }
    }

    init();

    return function cleanup() {
      disposed = true;
      if (window.__researchToast === toast) window.__researchToast = null;
      if (root.parentNode) root.parentNode.removeChild(root);
    };
  }

  function statusLabel(status) {
    if (status === "read") return "已读";
    if (status === "reading") return "在读";
    if (status === "paused") return "已暂停";
    if (status === "archived") return "已归档";
    if (status === "active") return "进行中";
    return "待读";
  }

  function kindLabel(kind) {
    if (kind === "frontier") return "前沿追踪";
    if (kind === "review") return "文献综述";
    if (kind === "outline") return "论文框架";
    if (kind === "polish") return "语言润色";
    if (kind === "format") return "规范检查";
    if (kind === "analyze" || kind === "analysis") return "数据分析";
    return "产出";
  }

  function decisionLabel(decision) {
    if (decision === "recommended") return "建议加入";
    if (decision === "not_recommended") return "暂不建议加入";
    return "建议先核验";
  }

  function decisionTone(decision) {
    if (decision === "recommended") return "green";
    if (decision === "not_recommended") return "muted";
    return "amber";
  }

  function sourceTone(name) {
    if (name === "Crossref") return "blue";
    if (name === "Europe PMC") return "cyan";
    if (name === "arXiv") return "volcano";
    if (name === "DBLP") return "geekblue";
    if (name === "PubMed") return "green";
    if (name === "Semantic Scholar") return "purple";
    return "";
  }

  function analysisToMarkdown(result) {
    if (!result) return "";
    if (result.raw) return result.raw;
    var lines = ["# 论文精读分析", "", "## 项目理解", "", result.projectSummary || "未提供", ""];
    asArray(result.papers).forEach(function (paper, index) {
      lines.push("## 论文 " + (index + 1) + "：" + (paper.title || paper.fileName || ""));
      lines.push("");
      if (paper.abstractText) lines.push(paper.abstractText, "");
      if (asArray(paper.methods).length) lines.push("- 方法：" + paper.methods.join("；"));
      if (asArray(paper.dataAndExperiments).length) lines.push("- 数据/实验：" + paper.dataAndExperiments.join("；"));
      if (asArray(paper.conclusions).length) lines.push("- 结论：" + paper.conclusions.join("；"));
      if (asArray(paper.limitations).length) lines.push("- 局限：" + paper.limitations.join("；"));
      lines.push("");
    });
    asArray(result.comparisons).forEach(function (item) {
      lines.push("## 异同：" + (item.dimension || ""));
      lines.push("- 共同点：" + (asArray(item.commonPoints).join("；") || "无"));
      lines.push("- 差异：" + (asArray(item.differences).join("；") || "无"));
      lines.push("- 冲突：" + (asArray(item.conflicts).join("；") || "无"));
      lines.push("");
    });
    asArray(result.recommendations).forEach(function (item) {
      lines.push("## 建议：" + (item.title || ""));
      lines.push(item.action || "");
      lines.push("依据：" + (item.rationale || ""));
      lines.push("");
    });
    return lines.join("\n");
  }

  // ───────────────────────── 生命周期 ─────────────────────────

  var unregister = [];

  async function onLoad(ctx) {
    var app = ctx.app;

    app.sidebar.addItem({
      id: "research-sidebar",
      icon: "Sparkles",
      label: "AI 助研",
      viewId: "research-view",
      group: "ai"
    });

    app.panelViews.register({
      id: "research-view",
      title: "AI 助研",
      layout: "fullscreen",
      render: function (container) {
        return mountPanel(ctx, container);
      }
    });

    unregister.push(
      app.commands.addCommand({
        id: "research.open",
        name: "打开 AI 助研",
        group: "助研",
        callback: function () {
          try {
            window.location.hash = "#/plugin-view/research-view";
          } catch (error) {
            console.warn(error);
            app.notices.show("请从左侧「AI 助研」入口打开");
          }
        }
      })
    );
  }

  async function onUnload() {
    unregister.forEach(function (fn) {
      try {
        if (typeof fn === "function") fn();
      } catch (error) {
        console.warn("[research] unload cleanup failed", error);
      }
    });
    unregister = [];
  }

  module.exports = {
    onLoad: onLoad,
    onUnload: onUnload,
    __test: {
      normalizeDoi: normalizeDoi,
      normalizeTitle: normalizeTitle,
      paperIdentity: paperIdentity,
      samePaper: samePaper,
      splitKeywords: splitKeywords,
      buildQuery: buildQuery,
      computeFrontierScore: computeFrontierScore,
      dedupePapers: dedupePapers,
      mergeSources: mergeSources,
      renderMarkdown: renderMarkdown,
      parseJsonLoose: parseJsonLoose,
      hashString: hashString,
      cacheIsUsable: cacheIsUsable,
      sanitizeExtraction: sanitizeExtraction,
      localExtraction: localExtraction,
      truncateExtractionSources: truncateExtractionSources,
      extractionCacheKey: extractionCacheKey,
      mergeExtractionSources: mergeExtractionSources,
      computeRelevance: computeRelevance,
      sanitizeExpansion: sanitizeExpansion,
      buildSourceQueries: buildSourceQueries,
      queryHasCjk: queryHasCjk,
      formatReferenceEntry: formatReferenceEntry,
      buildReferenceIndex: buildReferenceIndex,
      bibtexKey: bibtexKey
    }
  };
})();
