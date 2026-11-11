/* brain.js —— 静态版"大脑"：客户端检索 + 范围守卫 + 提示词 + 直连 DeepSeek。
   移植自 server/retrieval.py 与 server/prompts.py，逻辑保持一致。 */
(function () {
  "use strict";

  var SYNONYMS = {
    "方和根": ["平方和", "均方根", "平方相加", "开方", "根号"],
    "平方和": ["方和根", "均方根"],
    "代数和": ["代数相加", "直接相加", "相加"],
    "随机误差": ["偶然误差", "随机"],
    "系统误差": ["系统", "已定", "未定"],
    "已定系统误差": ["确定系统误差", "已定"],
    "未定系统误差": ["未定"],
    "灵敏系数": ["传递系数", "偏导", "偏导数", "∂"],
    "不确定度": ["uc", "u_c", "合成标准不确定度", "扩展不确定度", "自由度"],
    "微小误差": ["取舍", "忽略", "舍去", "可以忽略"],
    "极限误差": ["最大误差", "允许误差", "允差"],
    "相关系数": ["相关", "协方差", "不相关", "独立"],
    "弓高弦长": ["弓高", "弦长", "大直径", "直径"],
    "标准差": ["均方差", "sigma", "σ"],
    "修正": ["修正值", "修正掉", "补偿"],
    "重复测量": ["多次测量", "重复性", "平均", "n次"],
    "置信系数": ["包含因子", "k值", "k="],
    "误差合成": ["合成", "综合", "总误差", "合起来"],
    "误差传递": ["传递", "传播"]
  };

  var STOP_BIGRAMS = {
    "什么": 1, "怎么": 1, "为什": 1, "么是": 1, "如何": 1, "可以": 1,
    "能不": 1, "不能": 1, "一下": 1, "解释": 1, "说明": 1, "请问": 1,
    "帮我": 1, "告诉": 1, "这个": 1, "那个": 1, "就是": 1, "还是": 1,
    "以及": 1, "如果": 1, "那么": 1, "所以": 1, "但是": 1, "因为": 1,
    "我该": 1, "应该": 1, "是不": 1
  };

  var STRONG_IN = [
    "误差合成", "合成", "方和根", "代数和", "灵敏系数", "误差传递",
    "微小误差", "不确定度合成", "合成标准不确定度", "极限误差"
  ];

  var OUT_PATTERNS = [
    [["最小二乘", "小二乘", "正规方程", "残差平方和最小"], "最小二乘原理与数据处理", "第 4 章"],
    [["回归", "拟合", "相关系数显著性检验", "经验公式"], "回归分析", "第 5 章"],
    [["动态测试", "动态误差", "频谱", "自相关", "互相关", "功率谱", "传递函数",
      "频率响应", "补偿网络", "锯齿波"], "动态测试数据的处理与误差补偿", "第 6、7 章"],
    [["粗大误差", "拉依达", "格拉布斯", "罗曼诺夫斯基", "3σ准则", "异常值剔除",
      "t检验", "t 检验", "F检验"], "粗大误差的判别与剔除", "第 2 章 2.2 节"],
    [["加权", "权的确定", "不等精度", "权分配"], "不等精度测量与权的处理", "第 2 章"],
    [["误差分配", "分配误差", "误差的分配", "等影响原则", "等作用原则", "等精度原则",
      "按比例分配", "按可能性调整", "反求", "该选什么精度", "选型"], "误差分配", "第 2 章 2.4 节"],
    [["最佳测量方案", "最佳方案", "测量方案的选择"], "最佳测量方案的确定", "第 2 章 2.5.2 节"],
    [["怎么写代码", "python", "java", "论文", "作文", "翻译", "天气", "股票"], "与本课程无关", "—"]
  ];

  var SCORE_ADJUST = { "范围与用法": 0.45 };
  var K1 = 1.5, B = 0.75, MIN_SCORE = 1.2, TOP_K = 6;

  var IN_SCOPE = [
    "误差合成的概念，以及它与误差分配的区别",
    "函数误差与误差传递系数（灵敏系数）",
    "随机误差的合成：方和根、相关系数、协方差项、置信系数不同时的换算",
    "系统误差的合成：已定系统误差代数和、未定系统误差按随机处理、多次重复测量的区别",
    "误差合成的三条原理（教材 2.3.4）",
    "微小误差取舍准则（教材 2.5.1）",
    "测量不确定度的合成、有效自由度、扩展不确定度（教材 3.2.4–3.2.6）",
    "教材例 2.3.1–2.3.5、习题 2-9、2-10 的解法",
    "上述内容的常见考点与易错点"
  ];

  var OUT_SCOPE = [
    "误差分配（教材 2.4 节）",
    "最佳测量方案的确定（教材 2.5.2 节）",
    "最小二乘原理与数据处理（第 4 章）",
    "回归分析（第 5 章）",
    "动态测试数据的处理（第 6 章）",
    "测试系统的误差分析与动态补偿（第 7 章）",
    "粗大误差判别准则的细节",
    "与本课程无关的一切问题"
  ];

  var REFUSE_TEMPLATE =
    "这个问题超出了我的知识范围。\n\n" +
    "我专门负责**误差合成**这一专题——包括函数误差与灵敏系数、随机误差的方和根合成、" +
    "系统误差的合成、误差合成的三条原理、微小误差取舍准则（第 2 章 2.3、2.5.1 节），" +
    "以及测量不确定度的合成与扩展（第 3 章 3.2.4–3.2.6 节）。\n\n" +
    "你问的「{keyword}」属于{chapter}「{topic}」的内容，不在我的范围内。" +
    "我不做猜测性回答，以免给你错误结论——建议直接查教材该章节或问老师。\n\n" +
    "如果你其实想问「{topic}和误差合成有什么区别」，我可以回答两者关系，换个问法就行。";

  var REFUSE_UNRELATED =
    "这个问题和《误差理论与数据处理》课程无关，我无法回答。\n\n" +
    "我只负责**误差合成**这一个专题：随机/系统误差怎么合成、方和根与代数和、" +
    "误差合成的三条原理、微小误差取舍准则、不确定度合成。\n\n" +
    "有这方面的问题，尽管问我。";

  var LOW_SCORE_MSG =
    "我在知识库里没有找到与这个问题直接相关的依据，因此不做回答。\n\n" +
    "这可能是两种情况之一：\n" +
    "1. 问题超出了「误差合成」专题的范围（我只覆盖第 2 章 2.3 节、2.5.1 节与第 3 章 3.2.4–3.2.6 节）；\n" +
    "2. 问题提得太笼统，检索不到对应知识点。\n\n" +
    "你可以试着问得更具体一些，例如「随机误差为什么按方和根合成」" +
    "「已定系统误差和未定系统误差的合成有什么不同」「举一个弓高弦长测直径的例子」。";

  /* ---------------- 分词与检索 ---------------- */

  function tokenize(text) {
    text = (text || "").toLowerCase().trim();
    var tokens = [];
    var wordRe = /[a-z][a-z0-9_]{1,}|[0-9]+(?:\.[0-9]+)?/g, m;
    while ((m = wordRe.exec(text)) !== null) tokens.push("w:" + m[0]);
    var hanRe = /[\u4e00-\u9fff]+/g;
    while ((m = hanRe.exec(text)) !== null) {
      var seg = m[0];
      for (var i = 0; i < seg.length - 1; i++) {
        var bg = seg.slice(i, i + 2);
        if (!STOP_BIGRAMS[bg]) tokens.push("b:" + bg);
      }
      if (seg.length === 1) tokens.push("c:" + seg);
    }
    return tokens;
  }

  function expandQuery(q) {
    var extra = [];
    for (var key in SYNONYMS) {
      if (q.indexOf(key) !== -1) extra = extra.concat(SYNONYMS[key]);
    }
    return extra.length ? q + " " + extra.join(" ") : q;
  }

  function countTokens(tokens) {
    var map = {};
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      map[t] = (map[t] || 0) + 1;
    }
    return map;
  }

  var CORPUS = null;
  var INDEX = null; // {docs:[{freq,len,chunk}], df:{}, idf:{}, avgdl, N}

  function buildIndex(chunks) {
    var docs = [];
    var df = {};
    var totalLen = 0;
    for (var i = 0; i < chunks.length; i++) {
      var c = chunks[i];
      var freq = {};
      function add(toks, w) {
        for (var k = 0; k < toks.length; k++) {
          var t = toks[k];
          freq[t] = (freq[t] || 0) + w;
        }
      }
      add(tokenize(c.title), 3);
      add(tokenize((c.tags || []).join(" ")), 2);
      add(tokenize(c.text), 1);
      var len = 0;
      for (var t in freq) { len += freq[t]; df[t] = (df[t] || 0) + 1; }
      totalLen += len;
      docs.push({ freq: freq, len: len, chunk: c });
    }
    var N = docs.length;
    var avgdl = N ? totalLen / N : 1;
    var idf = {};
    for (var t in df) {
      idf[t] = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
    }
    var defaultIdf = Math.log(1 + (N + 0.5) / 0.5);
    return { docs: docs, df: df, idf: idf, avgdl: avgdl, N: N, defaultIdf: defaultIdf };
  }

  function search(query, topK) {
    topK = topK || TOP_K;
    if (!INDEX) return [];
    var q = expandQuery(query);
    var qt = countTokens(tokenize(q));
    var terms = Object.keys(qt);
    if (!terms.length) return [];
    var scored = [];
    for (var i = 0; i < INDEX.docs.length; i++) {
      var d = INDEX.docs[i];
      var s = 0;
      for (var j = 0; j < terms.length; j++) {
        var t = terms[j];
        var f = d.freq[t] || 0;
        if (!f) continue;
        var idf = INDEX.idf[t] !== undefined ? INDEX.idf[t] : INDEX.defaultIdf;
        var qf = qt[t];
        s += idf * qf * (f * (K1 + 1)) /
             (f + K1 * (1 - B + B * d.len / INDEX.avgdl));
      }
      if (s > 0) {
        s *= SCORE_ADJUST[d.chunk.doc] || 1.0;
        scored.push({ score: s, idx: i });
      }
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    var out = [];
    for (var k = 0; k < Math.min(topK, scored.length); k++) {
      var c = INDEX.docs[scored[k].idx].chunk;
      out.push({ id: c.id, title: c.title, ref: c.ref, score: Math.round(scored[k].score * 1000) / 1000,
                 text: c.text, doc: c.doc });
    }
    return out;
  }

  function classifyScope(question) {
    var q = (question || "").toLowerCase();
    var strong = STRONG_IN.some(function (w) { return q.indexOf(w) !== -1; });
    for (var i = 0; i < OUT_PATTERNS.length; i++) {
      var kws = OUT_PATTERNS[i][0], topic = OUT_PATTERNS[i][1], chapter = OUT_PATTERNS[i][2];
      for (var j = 0; j < kws.length; j++) {
        if (q.indexOf(kws[j]) !== -1) {
          if (!strong) return { verdict: "out", keyword: kws[j], topic: topic, chapter: chapter };
          return { verdict: "in" };
        }
      }
    }
    return { verdict: "in" };
  }

  function fmt(tpl, meta) {
    return tpl.replace(/\{(\w+)\}/g, function (_, k) {
      return meta[k] !== undefined ? meta[k] : "";
    });
  }

  /* ---------------- 提示词 ---------------- */

  var BASE =
    "你是《误差理论与数据处理》课程的助教型智能体，专题是「**误差合成**」。\n\n" +
    "## 你的知识范围（白名单，超出即拒答）\n{in_scope}\n\n" +
    "## 明确不在范围内（出现即拒答）\n{out_scope}\n\n" +
    "## 铁律（违反任何一条都算失败）\n" +
    "1. **只依据【参考资料】作答。** 参考资料里没有的公式、数值、页码、结论，一律不许出现。\n" +
    "2. **每处关键结论后必须标注来源**，格式严格为 `[ref]`，其中 ref 直接照抄参考资料条目标注的 ref 字段，" +
    "例如 `[教材 §2.3.2，p.60-61]`。不要自己编造节号或页码。\n" +
    "3. **不许编造数值。** 只有参考资料里出现的例题数据才能引用；用户自带的题目数据可以代入计算，" +
    "但必须明显标注\"按你给的数值计算\"。\n" +
    "4. **数值计算必须逐步展开**：①写函数关系 ②求灵敏系数 ③判断误差性质（已定系统/未定系统/随机）" +
    "④按对应规则合成 ⑤修正与报告。不要跳步直接给结果。\n" +
    "5. **公式格式**：行内用 `$...$`，独立公式用 `$$...$$`。不要用 Unicode 字符（如 √、Σ）拼凑公式。\n" +
    "6. 不写参考文献列表，不写\"希望对你有帮助\"\"以上\"之类的套话，直接给内容。\n" +
    "7. 若【参考资料】与问题不相关或不足以回答，**直接说\"知识库中未找到依据\"**，" +
    "并说明你能覆盖哪些小节，不要硬答。\n\n" +
    "## 输出语言与风格\n" +
    "简体中文。像一位讲得清楚、不绕弯子的助教：先给结论，再给依据，最后给易错提醒。" +
    "专业术语首次出现时给出定义。避免空话和过度修饰。";

  var MODE = {
    brief: "\n\n## 本次是「一句话概括」模式\n只用 **1 句话、不超过 60 字**回答核心结论，" +
           "不展开、不举例、不列标题。若必须给公式，只给最核心的一个。末尾仍要带 [ref]。",
    detail: "\n\n## 本次是「详细讲解」模式\n按以下结构输出（用 ### 小标题分段，不要加粗整段）：\n" +
            "### 结论\n一句话点明要点。\n### 原理与公式\n给出定义、公式，并解释每个符号。\n" +
            "### 为什么这样合成\n讲清逻辑。\n### 适用条件与易错点\n列出 2–4 条，每条一两句话。\n长度控制在 500–800 字。",
    example: "\n\n## 本次是「举例说明」模式\n必须给出一个**具体的、带数字的算例**，" +
             "优先用参考资料的例题（例 2.3.2 / 2.3.4 / 2.3.5 / 习题 2-9 等）。" +
             "按\"题目 → 建模 → 求灵敏系数 → 判断误差性质 → 代入计算 → 结果与结论\"逐步走完，" +
             "每一步都写清数值和单位。最后用一句话点出这个例子的教学价值。",
    auto: "\n\n## 解释深度自行判断\n- 问\"是什么/为什么/有什么区别\"→ 中等深度，先结论再依据，200–400 字。\n" +
          "- 问\"怎么算/举个例子/这道题\"→ 给完整演算过程。\n- 问\"一句话说清\"→ 只给一句。"
  };

  function buildSystemPrompt(mode, hits) {
    var ctx = [];
    for (var i = 0; i < hits.length; i++) {
      var c = hits[i];
      ctx.push("【参考资料 " + (i + 1) + "】ref: " + c.ref + "\n标题: " + c.title +
               "\n内容:\n" + c.text);
    }
    var context = ctx.length ? ctx.join("\n\n") : "（本次检索没有命中任何知识块）";
    var inList = IN_SCOPE.map(function (s) { return "- " + s; }).join("\n");
    var outList = OUT_SCOPE.map(function (s) { return "- " + s; }).join("\n");
    return BASE.replace("{in_scope}", inList).replace("{out_scope}", outList) +
           (MODE[mode] || MODE.auto) +
           "\n\n## 参考资料\n" + context +
           "\n\n（以上参考资料是本次回答的**唯一**事实来源。若其中没有对应内容，请按铁律第 7 条处理。）";
  }

  /* ---------------- DeepSeek 直连 + 流式 ---------------- */

  function load() {
    if (CORPUS) return Promise.resolve();
    return fetch("corpus.json", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("corpus load failed");
        return r.json();
      })
      .then(function (chunks) {
        CORPUS = chunks;
        INDEX = buildIndex(chunks);
      });
  }

  async function streamChat(messages, mode, onEvent, signal) {
    await load();
    var cfg = window.DSH_CONFIG || {};
    if (!Array.isArray(messages) || !messages.length) {
      onEvent({ type: "error", message: "没有收到提问。" });
      onEvent({ type: "done" });
      return;
    }
    // 只保留最近 8 条，控制上下文与费用
    messages = messages.slice(-8);
    var last = messages[messages.length - 1];
    var question = (last && last.content ? String(last.content) : "").trim();
    if (last && last.role !== "user") {
      for (var mi = messages.length - 1; mi >= 0; mi--) {
        if (messages[mi].role === "user") { question = String(messages[mi].content || "").trim(); break; }
      }
    }

    // 第一道闸门：规则化范围守卫
    var scope = classifyScope(question);
    if (scope.verdict === "out") {
      var tpl = scope.chapter === "—" ? REFUSE_UNRELATED : REFUSE_TEMPLATE;
      onEvent({ type: "refused", reason: fmt(tpl, scope) });
      onEvent({ type: "done" });
      return;
    }

    // 第二道闸门：检索
    var hits = search(question, TOP_K);
    var best = hits.length ? hits[0].score : 0;
    var strong = STRONG_IN.some(function (w) { return question.indexOf(w) !== -1; });
    if (!hits.length || (best < MIN_SCORE && !strong)) {
      onEvent({ type: "sources", sources: hits.slice(0, 3) });
      onEvent({ type: "refused", reason: LOW_SCORE_MSG });
      onEvent({ type: "done" });
      return;
    }
    onEvent({ type: "sources", sources: hits });

    if (!cfg.apiKey) {
      onEvent({ type: "error", message: "config.js 里没有填 apiKey，无法生成回答。" });
      onEvent({ type: "done" });
      return;
    }

    var system = buildSystemPrompt(mode || "auto", hits);
    var chat = [{ role: "system", content: system }].concat(messages);

    var body = {
      model: cfg.model || "deepseek-chat",
      messages: chat,
      stream: true,
      temperature: 0.3,
      max_tokens: mode === "brief" ? 700 : 1800
    };

    var resp;
    try {
      resp = await fetch((cfg.base || "https://api.deepseek.com") + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + cfg.apiKey,
          "Accept": "text/event-stream"
        },
        body: JSON.stringify(body),
        signal: signal || null,
        cache: "no-store"
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      onEvent({ type: "error", message: "网络错误，无法连接模型接口。" });
      onEvent({ type: "done" });
      return;
    }

    if (!resp.ok) {
      var detail = "";
      try { detail = (await resp.text()).slice(0, 300); } catch (e) {}
      onEvent({ type: "error", message: "模型接口返回错误 " + resp.status + "。" + detail });
      onEvent({ type: "done" });
      return;
    }

    try {
      var reader = resp.body.getReader();
      var decoder = new TextDecoder("utf-8");
      var buf = "";
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        var lines = buf.split("\n");
        buf = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].replace(/\r$/, "").trim();
          if (line.indexOf("data:") !== 0) continue;
          var data = line.slice(5).trim();
          if (data === "[DONE]") break;
          var obj;
          try { obj = JSON.parse(data); } catch (e) { continue; }
          var delta = (obj.choices && obj.choices[0] && obj.choices[0].delta) || {};
          if (delta.content) {
            var stop = onEvent({ type: "delta", text: delta.content });
            if (stop === "stop") { try { reader.cancel(); } catch (e) {} return; }
          }
        }
      }
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      onEvent({ type: "error", message: "读取模型返回时出错。" });
      onEvent({ type: "done" });
      return;
    }
    onEvent({ type: "done" });
  }

  window.brain = {
    load: load,
    streamChat: streamChat,
    search: search,
    classifyScope: classifyScope,
    IN_SCOPE: IN_SCOPE,
    OUT_SCOPE: OUT_SCOPE
  };
})();
