/* ==========================================================================
   误差合成 · 课程知识智能体
   Vanilla JS. No modules, no dependencies beyond the vendored KaTeX build.
   ========================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------------------
     Constants and tiny helpers
     ------------------------------------------------------------------------ */

  var CHAT_ENDPOINT = "/api/chat";
  var SCOPE_ENDPOINT = "/api/scope";
  var STORAGE_KEY = "error-synthesis-chat.v1";
  var VALID_MODES = ["auto", "brief", "detail", "example"];
  var MAX_STORED_MESSAGES = 200;
  var MAX_SOURCES = 12;

  var FALLBACK_SCOPE = {
    in_scope: [
      "误差合成的基本概念与三条原理",
      "随机误差的方和根合成",
      "已定系统误差的代数合成",
      "未定系统误差的合成与相关系数",
      "合成不确定度与扩展不确定度",
      "典型测量案例的误差合成计算"
    ],
    out_of_scope: [
      "误差分配与误差反问题",
      "最小二乘法与回归分析",
      "动态测试、频谱分析与信号处理",
      "第 2.3 节以外的其他章节内容"
    ]
  };

  var SAMPLES = [
    "用一句话说清误差合成到底在做什么",
    "随机误差为什么要按方和根合成？",
    "已定系统误差和未定系统误差的合成为什么不一样？",
    "举一个弓高弦长测直径的例子"
  ];

  var MODE_LABELS = {
    auto: "自动",
    brief: "一句话",
    detail: "详细讲解",
    example: "举例说明"
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function cleanOneLine(value, maxLength) {
    if (value == null) return "";
    var text = String(value).replace(/\s+/g, " ").trim();
    if (maxLength && text.length > maxLength) text = text.slice(0, maxLength);
    return text;
  }

  function isReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function createId() {
    idSequence += 1;
    return "m" + Date.now().toString(36) + "-" + idSequence.toString(36);
  }

  /* ------------------------------------------------------------------------
     DOM
     ------------------------------------------------------------------------ */

  var dom = {
    app: byId("app"),
    header: byId("appHeader"),
    chatScroll: byId("chatScroll"),
    chatLog: byId("chatLog"),
    welcome: byId("welcome"),
    sampleList: byId("sampleList"),
    scopeToggle: byId("scopeToggle"),
    scopeToggleText: document.querySelector("#scopeToggle .scope-toggle-text"),
    scopeDetails: byId("scopeDetails"),
    scopeIn: byId("scopeIn"),
    scopeOut: byId("scopeOut"),
    modeSelector: byId("modeSelector"),
    modeButtons: Array.prototype.slice.call(document.querySelectorAll(".mode-btn")),
    composerForm: byId("composerForm"),
    input: byId("messageInput"),
    sendBtn: byId("sendBtn"),
    stopBtn: byId("stopBtn"),
    clearBtn: byId("clearBtn"),
    clearDialog: byId("clearDialog"),
    liveStatus: byId("liveStatus")
  };

  /* ------------------------------------------------------------------------
     State
     ------------------------------------------------------------------------ */

  var idSequence = 0;
  var composing = false;
  var saveTimer = 0;
  var scrollRaf = 0;
  var viewportRaf = 0;
  var announceTimer = 0;

  var state = {
    messages: [],
    mode: "auto",
    streaming: false,
    abortController: null,
    activeAssistantId: null,
    runToken: 0,
    stopRequested: false,
    stickToBottom: true,
    scopeOpen: false
  };

  /* ------------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------------ */

  function init() {
    restoreState();
    renderSamples();
    renderScope(FALLBACK_SCOPE);
    bindEvents();
    syncModeUI();
    renderConversation();
    updateComposerState();
    syncViewport();
    requestAnimationFrame(function () {
      scrollToBottom(true);
    });
    window.setTimeout(function () {
      scrollToBottom(true);
    }, 80);
    loadScope();
  }

  function bindEvents() {
    dom.scopeToggle.addEventListener("click", function () {
      setScopeOpen(!state.scopeOpen);
    });

    dom.modeButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        setMode(button.getAttribute("data-mode"));
      });
      button.addEventListener("keydown", onModeKeydown);
    });

    dom.composerForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (state.streaming) return;
      sendMessage(dom.input.value);
    });

    dom.input.addEventListener("input", function () {
      updateComposerState();
    });

    dom.input.addEventListener("compositionstart", function () {
      composing = true;
    });

    dom.input.addEventListener("compositionend", function () {
      composing = false;
      updateComposerState();
    });

    dom.input.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" || event.shiftKey) return;
      if (event.isComposing || composing || event.keyCode === 229) return;
      event.preventDefault();
      if (state.streaming) return;
      sendMessage(dom.input.value);
    });

    dom.input.addEventListener("focus", function () {
      state.stickToBottom = true;
      scheduleViewportSync();
      window.setTimeout(function () {
        scheduleScroll();
      }, 260);
    });

    dom.stopBtn.addEventListener("click", function () {
      stopGeneration();
    });

    dom.clearBtn.addEventListener("click", openClearDialog);

    dom.clearDialog.addEventListener("close", function () {
      var confirmed = dom.clearDialog.returnValue === "confirm";
      dom.clearDialog.returnValue = "";
      if (confirmed) clearConversation();
    });

    dom.clearDialog.addEventListener("click", function (event) {
      if (event.target !== dom.clearDialog) return;
      if (typeof dom.clearDialog.close === "function") {
        dom.clearDialog.close("cancel");
      }
    });

    dom.chatScroll.addEventListener(
      "scroll",
      function () {
        state.stickToBottom = isNearBottom();
        updateHeaderShadow();
      },
      { passive: true }
    );

    window.addEventListener("resize", scheduleViewportSync);
    window.addEventListener("orientationchange", scheduleViewportSync);
    window.addEventListener("beforeunload", saveStateNow);
    window.addEventListener("pagehide", saveStateNow);

    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", scheduleViewportSync);
      window.visualViewport.addEventListener("scroll", scheduleViewportSync);
    }
  }

  /* ------------------------------------------------------------------------
     Persistence
     ------------------------------------------------------------------------ */

  function restoreState() {
    var raw;
    try {
      raw = window.sessionStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return;
    }
    if (!raw) return;

    var saved;
    try {
      saved = JSON.parse(raw);
    } catch (error) {
      return;
    }
    if (!saved || !Array.isArray(saved.messages)) return;

    var seenIds = Object.create(null);
    var restored = [];

    saved.messages.slice(-MAX_STORED_MESSAGES).forEach(function (item) {
      var message = normalizeStoredMessage(item);
      if (!message) return;
      if (seenIds[message.id]) message.id = createId();
      seenIds[message.id] = true;
      restored.push(message);
    });

    state.messages = restored;
    state.mode = VALID_MODES.indexOf(saved.mode) !== -1 ? saved.mode : "auto";
  }

  function normalizeStoredMessage(item) {
    if (!item || typeof item !== "object") return null;
    var role = item.role === "user" || item.role === "assistant" ? item.role : "";
    if (!role) return null;

    var content = typeof item.content === "string" ? item.content : "";
    if (role === "user") {
      if (!content.trim()) return null;
      return {
        id: typeof item.id === "string" && item.id ? item.id : createId(),
        role: "user",
        content: content
      };
    }

    var status = item.status;
    if (["done", "error", "refused", "stopped", "streaming"].indexOf(status) === -1) {
      status = content.trim() ? "done" : "error";
    }
    if (status === "streaming") {
      status = content.trim() ? "stopped" : "error";
    }

    var sources = normalizeSources(item.sources);
    var message = {
      id: typeof item.id === "string" && item.id ? item.id : createId(),
      role: "assistant",
      content: content,
      status: status,
      error: typeof item.error === "string" ? item.error : "",
      refused: status === "refused",
      sources: sources,
      sourcesOpen: !!item.sourcesOpen && sources.length > 0,
      mode: VALID_MODES.indexOf(item.mode) !== -1 ? item.mode : "auto"
    };

    if (status === "refused" && !message.content.trim()) {
      message.content = refusalText("范围外");
    }
    if (status === "error" && !message.error) {
      message.error = message.content.trim()
        ? "上次回答被中断，请重试。"
        : "上次回答未完成，请重试。";
    }
    if (status === "done" && !message.content.trim() && !sources.length) {
      message.status = "error";
      message.error = "上次回答没有返回内容，请重试。";
    }

    return message;
  }

  function serializeMessages() {
    return state.messages.map(function (message) {
      if (message.role === "user") {
        return { id: message.id, role: "user", content: message.content };
      }
      return {
        id: message.id,
        role: "assistant",
        content: message.content,
        status: message.status,
        error: message.error || "",
        refused: !!message.refused,
        sources: message.sources || [],
        sourcesOpen: !!message.sourcesOpen,
        mode: message.mode || "auto"
      };
    });
  }

  function saveStateNow() {
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = 0;
    }
    try {
      var payload = {
        version: 1,
        mode: state.mode,
        messages: serializeMessages()
      };
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
      /* Private browsing or a full storage quota should never break chat. */
    }
  }

  function scheduleSave() {
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(function () {
      saveTimer = 0;
      saveStateNow();
    }, 220);
  }

  /* ------------------------------------------------------------------------
     Scope
     ------------------------------------------------------------------------ */

  function renderScope(data) {
    var inScope = sanitizeScopeList(data && data.in_scope);
    var outScope = sanitizeScopeList(data && data.out_of_scope);
    renderScopeList(dom.scopeIn, inScope.length ? inScope : FALLBACK_SCOPE.in_scope);
    renderScopeList(dom.scopeOut, outScope.length ? outScope : FALLBACK_SCOPE.out_of_scope);
  }

  function sanitizeScopeList(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map(function (item) {
        return cleanOneLine(item, 120);
      })
      .filter(Boolean)
      .slice(0, 20);
  }

  function renderScopeList(container, items) {
    container.textContent = "";
    items.forEach(function (item) {
      container.appendChild(make("li", "", item));
    });
  }

  function setScopeOpen(open) {
    state.scopeOpen = !!open;
    dom.scopeDetails.hidden = !state.scopeOpen;
    dom.scopeToggle.setAttribute("aria-expanded", state.scopeOpen ? "true" : "false");
    if (dom.scopeToggleText) {
      dom.scopeToggleText.textContent = state.scopeOpen ? "收起" : "展开";
    }
  }

  function loadScope() {
    // 静态版：优先用 brain.js 内置的范围（无需后端 /api/scope）
    if (window.brain && window.brain.IN_SCOPE && window.brain.IN_SCOPE.length) {
      renderScope({ in_scope: window.brain.IN_SCOPE, out_of_scope: window.brain.OUT_SCOPE });
      return;
    }
    if (!window.fetch) return;
    fetch(SCOPE_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store"
    })
      .then(function (response) {
        if (!response.ok) throw new Error("scope unavailable");
        return response.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.in_scope) || !Array.isArray(data.out_of_scope)) {
          return;
        }
        if (!data.in_scope.length || !data.out_of_scope.length) return;
        renderScope(data);
      })
      .catch(function () {
        /* The hardcoded fallback is already visible. */
      });
  }

  /* ------------------------------------------------------------------------
     Sample questions
     ------------------------------------------------------------------------ */

  function renderSamples() {
    dom.sampleList.textContent = "";
    SAMPLES.forEach(function (question, index) {
      var button = make("button", "sample-chip");
      button.type = "button";
      var sampleIndex = make("span", "sample-index", "0" + (index + 1));
      sampleIndex.setAttribute("aria-hidden", "true");
      button.appendChild(sampleIndex);
      button.appendChild(make("span", "sample-text", question));
      button.addEventListener("click", function () {
        if (state.streaming) return;
        sendMessage(question);
      });
      dom.sampleList.appendChild(button);
    });
    updateSampleState();
  }

  function updateSampleState() {
    var buttons = dom.sampleList.querySelectorAll(".sample-chip");
    Array.prototype.forEach.call(buttons, function (button) {
      button.disabled = state.streaming;
    });
  }

  /* ------------------------------------------------------------------------
     Mode selector
     ------------------------------------------------------------------------ */

  function setMode(mode, options) {
    options = options || {};
    if (VALID_MODES.indexOf(mode) === -1) mode = "auto";
    state.mode = mode;

    dom.modeButtons.forEach(function (button) {
      var active = button.getAttribute("data-mode") === mode;
      button.setAttribute("aria-checked", active ? "true" : "false");
      button.setAttribute("tabindex", active ? "0" : "-1");
    });

    if (options.focus) {
      var target = dom.modeButtons.filter(function (button) {
        return button.getAttribute("data-mode") === mode;
      })[0];
      if (target) target.focus();
    }

    if (options.save !== false) scheduleSave();
  }

  function syncModeUI() {
    setMode(state.mode, { save: false });
  }

  function onModeKeydown(event) {
    var key = event.key;
    var index = dom.modeButtons.indexOf(event.currentTarget);
    if (index < 0) return;
    var next = null;

    if (key === "ArrowRight" || key === "ArrowDown") next = (index + 1) % dom.modeButtons.length;
    if (key === "ArrowLeft" || key === "ArrowUp") next = (index - 1 + dom.modeButtons.length) % dom.modeButtons.length;
    if (key === "Home") next = 0;
    if (key === "End") next = dom.modeButtons.length - 1;

    if (next == null) return;
    event.preventDefault();
    var button = dom.modeButtons[next];
    setMode(button.getAttribute("data-mode"), { focus: true });
  }

  /* ------------------------------------------------------------------------
     Viewport, scrolling, and composer sizing
     ------------------------------------------------------------------------ */

  function scheduleViewportSync() {
    if (viewportRaf) return;
    viewportRaf = requestAnimationFrame(function () {
      viewportRaf = 0;
      syncViewport();
    });
  }

  function syncViewport() {
    if (window.visualViewport && window.visualViewport.height > 0) {
      document.documentElement.style.setProperty(
        "--app-height",
        Math.round(window.visualViewport.height) + "px"
      );
    } else {
      document.documentElement.style.removeProperty("--app-height");
    }
    autoGrowInput();
    if (dom.input === document.activeElement) {
      window.setTimeout(function () {
        scheduleScroll();
      }, 60);
    }
  }

  function isNearBottom() {
    var el = dom.chatScroll;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  function scrollToBottom(force) {
    if (force) state.stickToBottom = true;
    scheduleScroll();
  }

  function scheduleScroll() {
    if (!state.stickToBottom) return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = 0;
      if (!state.stickToBottom) return;
      dom.chatScroll.scrollTop = dom.chatScroll.scrollHeight;
      updateHeaderShadow();
    });
  }

  function updateHeaderShadow() {
    dom.header.classList.toggle("is-scrolled", dom.chatScroll.scrollTop > 4);
  }

  function autoGrowInput() {
    var input = dom.input;
    if (!input) return;
    input.style.height = "auto";

    var styles = window.getComputedStyle(input);
    var lineHeight = parseFloat(styles.lineHeight) || 27;
    var paddingTop = parseFloat(styles.paddingTop) || 0;
    var paddingBottom = parseFloat(styles.paddingBottom) || 0;
    var maxHeight = Math.round(lineHeight * 5 + paddingTop + paddingBottom);
    var nextHeight = Math.min(input.scrollHeight, maxHeight);

    input.style.height = Math.max(nextHeight, Math.round(lineHeight + paddingTop + paddingBottom)) + "px";
    input.style.overflowY = input.scrollHeight > maxHeight + 1 ? "auto" : "hidden";
  }

  function updateComposerState() {
    var hasText = dom.input.value.trim().length > 0;
    dom.sendBtn.disabled = state.streaming || !hasText;
    dom.stopBtn.hidden = !state.streaming;
    dom.stopBtn.disabled = !state.streaming;
    dom.chatLog.setAttribute("aria-busy", state.streaming ? "true" : "false");
    updateSampleState();
    autoGrowInput();
  }

  function resetInput() {
    dom.input.value = "";
    dom.input.style.height = "";
    updateComposerState();
  }

  function announce(message) {
    if (!dom.liveStatus) return;
    if (announceTimer) window.clearTimeout(announceTimer);
    dom.liveStatus.textContent = "";
    announceTimer = window.setTimeout(function () {
      dom.liveStatus.textContent = message;
      announceTimer = 0;
    }, 30);
  }

  /* ------------------------------------------------------------------------
     Conversation rendering
     ------------------------------------------------------------------------ */

  function renderConversation() {
    dom.chatLog.textContent = "";
    state.messages.forEach(function (message) {
      dom.chatLog.appendChild(createMessageNode(message));
    });
    dom.welcome.hidden = state.messages.length > 0;
    updateSampleState();
    if (state.messages.length) {
      requestAnimationFrame(function () {
        scrollToBottom(true);
      });
    }
  }

  function getMessageNode(id) {
    var children = dom.chatLog.children;
    for (var i = 0; i < children.length; i += 1) {
      if (children[i].getAttribute("data-message-id") === String(id)) return children[i];
    }
    return null;
  }

  function refreshMessageNode(message) {
    var oldNode = getMessageNode(message.id);
    var nextNode = createMessageNode(message);
    if (oldNode) {
      oldNode.replaceWith(nextNode);
    } else {
      dom.chatLog.appendChild(nextNode);
    }
    scheduleScroll();
  }

  function createMessageNode(message) {
    var article = make("article", "msg " + (message.role === "user" ? "msg-user" : "msg-assistant"));
    article.setAttribute("data-message-id", message.id);

    var meta = make("div", "msg-meta");
    meta.appendChild(make("span", "msg-who", message.role === "user" ? "你" : "误差助教"));

    if (message.role === "user") {
      article.appendChild(meta);
      article.appendChild(make("div", "user-bubble", message.content));
      return article;
    }

    if (message.status === "streaming") {
      meta.appendChild(make("span", "meta-dot"));
      meta.appendChild(make("span", "stream-status", "正在生成"));
    } else if (message.status === "refused") {
      meta.appendChild(make("span", "meta-dot"));
      meta.appendChild(make("span", "refused-tag", "范围提示"));
    }

    article.appendChild(meta);

    var card = make("div", "assistant-card");
    if (message.status === "refused") card.classList.add("is-refused");
    if (
      (message.status === "error" || message.status === "stopped") &&
      !String(message.content || "").trim()
    ) {
      card.classList.add("is-hidden");
    }

    var content = make("div", "md");
    if (message.status === "streaming") {
      article.setAttribute("aria-busy", "true");
      content.classList.add("is-streaming", "md-plain");
      var streamText = make("span", "stream-text", message.content || "");
      var caret = make("span", "caret");
      caret.setAttribute("aria-hidden", "true");
      content.appendChild(streamText);
      content.appendChild(caret);
    } else if (message.content) {
      renderMarkdown(content, message.content);
    }

    card.appendChild(content);
    article.appendChild(card);

    if (message.sources && message.sources.length) {
      article.appendChild(createSourcesBlock(message));
    }

    if (message.status === "error") {
      article.appendChild(createErrorNotice(message));
    }

    if (message.status === "stopped") {
      article.appendChild(createStoppedNote(message));
    }

    return article;
  }

  function updateStreamingMessage(message) {
    var node = getMessageNode(message.id);
    if (!node) return;
    var content = node.querySelector(".md");
    if (!content) return;
    var streamText = content.querySelector(".stream-text");
    if (!streamText) {
      content.textContent = "";
      content.classList.add("is-streaming", "md-plain");
      streamText = make("span", "stream-text");
      content.appendChild(streamText);
      var caret = make("span", "caret");
      caret.setAttribute("aria-hidden", "true");
      content.appendChild(caret);
    }
    streamText.textContent = message.content || "";
    scheduleScroll();
  }

  function createSourcesBlock(message) {
    var block = make("div", "sources-block");
    var chips = make("div", "source-chips");
    var panelId = "source-panel-" + String(message.id).replace(/[^a-zA-Z0-9_-]/g, "");
    var panel = make("div", "source-panel");
    panel.id = panelId;
    panel.hidden = !message.sourcesOpen;

    var title = make("p", "source-panel-title", "依据");
    title.appendChild(make("span", "source-count", "· " + message.sources.length + " 条"));
    panel.appendChild(title);

    var list = make("ul", "source-list");
    message.sources.forEach(function (source) {
      var item = make("li", "source-item");
      item.appendChild(make("span", "source-id", source.id || "—"));
      var copy = make("span", "source-copy");
      copy.appendChild(make("span", "source-title", source.title || "教材片段"));
      if (source.ref) copy.appendChild(make("span", "source-ref", source.ref));
      item.appendChild(copy);
      list.appendChild(item);
    });
    panel.appendChild(list);

    message.sources.forEach(function (source) {
      var chip = make("button", "source-chip", formatSourceLabel(source));
      chip.type = "button";
      chip.setAttribute("aria-expanded", message.sourcesOpen ? "true" : "false");
      chip.setAttribute("aria-controls", panelId);
      chip.setAttribute("title", "展开或收起依据");
      chip.addEventListener("click", function () {
        message.sourcesOpen = !message.sourcesOpen;
        var current = getMessageNode(message.id);
        if (!current) return;
        var currentPanel = current.querySelector(".source-panel");
        if (currentPanel) currentPanel.hidden = !message.sourcesOpen;
        var currentChips = current.querySelectorAll(".source-chip");
        Array.prototype.forEach.call(currentChips, function (item) {
          item.setAttribute("aria-expanded", message.sourcesOpen ? "true" : "false");
        });
        scheduleSave();
      });
      chips.appendChild(chip);
    });

    block.appendChild(chips);
    block.appendChild(panel);
    return block;
  }

  function formatSourceLabel(source) {
    var raw = source.ref || source.title || source.id || "教材片段";
    return cleanOneLine(raw, 90).replace(/[，,]\s*/g, " · ");
  }

  function createErrorNotice(message) {
    var notice = make("div", "error-notice");
    notice.setAttribute("role", "alert");
    notice.appendChild(make("span", "error-mark", "!"));
    var copy = make("div", "error-copy");
    var text = message.error || "生成回答时出现问题，请稍后重试。";
    var paragraph = make("p", "", "回答中断：" + text + " ");
    var retry = make("button", "retry-btn", "重试");
    retry.type = "button";
    retry.addEventListener("click", function () {
      retryMessage(message.id);
    });
    paragraph.appendChild(retry);
    copy.appendChild(paragraph);
    notice.appendChild(copy);
    return notice;
  }

  function createStoppedNote(message) {
    var note = make("div", "stopped-note");
    note.appendChild(make("span", "", "已停止生成"));
    var retry = make("button", "note-retry", "重新生成");
    retry.type = "button";
    retry.addEventListener("click", function () {
      retryMessage(message.id);
    });
    note.appendChild(retry);
    return note;
  }

  /* ------------------------------------------------------------------------
     Sending, streaming, retrying
     ------------------------------------------------------------------------ */

  function sendMessage(rawText) {
    if (state.streaming) return;
    var text = String(rawText == null ? "" : rawText).trim();
    if (!text) return;

    var keepFocus = document.activeElement === dom.input;
    var userMessage = {
      id: createId(),
      role: "user",
      content: text
    };

    state.messages.push(userMessage);
    var history = toApiMessages(state.messages);
    var assistantMessage = {
      id: createId(),
      role: "assistant",
      content: "",
      status: "streaming",
      error: "",
      refused: false,
      sources: [],
      sourcesOpen: false,
      mode: state.mode
    };
    state.messages.push(assistantMessage);

    dom.welcome.hidden = true;
    dom.chatLog.appendChild(createMessageNode(userMessage));
    dom.chatLog.appendChild(createMessageNode(assistantMessage));

    resetInput();
    scheduleSave();
    scrollToBottom(true);

    if (keepFocus) {
      window.requestAnimationFrame(function () {
        try {
          dom.input.focus({ preventScroll: true });
        } catch (error) {
          dom.input.focus();
        }
      });
    }

    runStream(assistantMessage, history, state.mode);
  }

  function retryMessage(messageId) {
    if (state.streaming) return;
    var index = -1;
    for (var i = 0; i < state.messages.length; i += 1) {
      if (state.messages[i].id === messageId && state.messages[i].role === "assistant") {
        index = i;
        break;
      }
    }
    if (index < 0) return;

    var message = state.messages[index];
    var history = toApiMessages(state.messages.slice(0, index));
    if (!history.length || history[history.length - 1].role !== "user") return;

    state.messages = state.messages.slice(0, index + 1);
    message.content = "";
    message.status = "streaming";
    message.error = "";
    message.refused = false;
    message.sources = [];
    message.sourcesOpen = false;

    var retryMode = VALID_MODES.indexOf(message.mode) !== -1 ? message.mode : state.mode;
    message.mode = retryMode;
    setMode(retryMode);

    renderConversation();
    scrollToBottom(true);
    runStream(message, history, retryMode);
  }

  function stopGeneration() {
    if (!state.streaming) return;
    state.stopRequested = true;
    dom.stopBtn.disabled = true;
    if (state.abortController) state.abortController.abort();
    announce("已停止生成");
  }

  async function runStream(assistantMessage, history, mode) {
    if (state.streaming) return;

    var runToken = ++state.runToken;
    state.streaming = true;
    state.stopRequested = false;
    state.abortController = new AbortController();
    state.activeAssistantId = assistantMessage.id;

    assistantMessage.content = "";
    assistantMessage.status = "streaming";
    assistantMessage.error = "";
    assistantMessage.refused = false;
    assistantMessage.sources = [];
    assistantMessage.sourcesOpen = false;
    assistantMessage.mode = mode;

    refreshMessageNode(assistantMessage);
    updateComposerState();
    scheduleSave();
    scrollToBottom(true);

    try {
      await window.brain.streamChat(
        history,
        mode,
        function (event) {
          return handleStreamEvent(event, assistantMessage, runToken);
        },
        state.abortController.signal
      );

      if (runToken !== state.runToken) return;

      if (assistantMessage.status === "error") {
        finishErrorMessage(assistantMessage);
      } else if (assistantMessage.status === "refused") {
        finishRefusedMessage(assistantMessage);
      } else {
        finishDoneMessage(assistantMessage);
      }
    } catch (error) {
      if (runToken !== state.runToken) return;

      if (state.stopRequested || (error && error.name === "AbortError")) {
        finishStoppedMessage(assistantMessage);
      } else {
        finishErrorMessage(assistantMessage, humanizeError(error));
      }
    } finally {
      if (runToken === state.runToken) {
        state.streaming = false;
        state.abortController = null;
        state.activeAssistantId = null;
        state.stopRequested = false;
        updateComposerState();
        scheduleSave();
      }
    }
  }

  function handleStreamEvent(event, assistantMessage, runToken) {
    if (runToken !== state.runToken) return "stop";
    if (!event || typeof event !== "object") return;

    switch (event.type) {
      case "sources":
        assistantMessage.sources = normalizeSources(event.sources);
        scheduleSave();
        break;

      case "delta":
        if (typeof event.text === "string" && event.text.length) {
          assistantMessage.content += event.text;
          updateStreamingMessage(assistantMessage);
          scheduleSave();
        }
        break;

      case "done":
        return "stop";

      case "error":
        assistantMessage.status = "error";
        assistantMessage.error =
          cleanOneLine(event.message, 300) || "服务返回错误，请稍后重试。";
        return "stop";

      case "refused":
        assistantMessage.status = "refused";
        assistantMessage.refused = true;
        assistantMessage.content = refusalText(event.reason);
        assistantMessage.sources = [];
        assistantMessage.sourcesOpen = false;
        return "stop";

      default:
        break;
    }
    return "";
  }

  function finishDoneMessage(message) {
    var text = String(message.content || "").trim();
    if (!text) {
      finishErrorMessage(message, "回答没有返回内容，请重试。");
      return;
    }
    message.content = text;
    message.status = "done";
    message.error = "";
    message.refused = false;
    refreshMessageNode(message);
    scheduleSave();
  }

  function finishRefusedMessage(message) {
    if (!String(message.content || "").trim()) {
      message.content = refusalText("范围外");
    }
    message.content = String(message.content).trim();
    message.status = "refused";
    message.refused = true;
    message.error = "";
    message.sources = [];
    message.sourcesOpen = false;
    refreshMessageNode(message);
    scheduleSave();
  }

  function finishErrorMessage(message, humanMessage) {
    if (!message || !state.messages.some(function (item) { return item === message; })) return;
    message.status = "error";
    message.error =
      humanMessage || message.error || "生成回答时出现问题，请重试。";
    refreshMessageNode(message);
    scheduleSave();
  }

  function finishStoppedMessage(message) {
    message.content = String(message.content || "").trim();
    message.status = "stopped";
    message.error = "";
    message.refused = false;
    refreshMessageNode(message);
    scheduleSave();
    announce("已停止生成");
  }

  function toApiMessages(messages) {
    var result = [];
    messages.forEach(function (message) {
      if (message.role !== "user" && message.role !== "assistant") return;
      if (message.role === "assistant" && message.status === "error") return;
      if (!String(message.content || "").trim()) return;
      result.push({ role: message.role, content: message.content });
    });
    return result;
  }

  function refusalText(reason) {
    var text = typeof reason === "string" ? reason.trim() : "";
    var shortReason = cleanOneLine(reason, 300);
    if (!text || /^(范围外|超出范围|out[\s_-]*of[\s_-]*scope)$/i.test(shortReason)) {
      return "这个提问不在本课程助手的范围内。我只回答《误差理论与数据处理》第 2 章 2.3「误差的合成」相关问题。";
    }
    return text.slice(0, 4000);
  }

  function httpErrorMessage(status) {
    if (status === 404) return "服务接口暂不可用（HTTP 404），请确认后端服务已启动。";
    if (status === 429) return "请求过于频繁，请稍等片刻再试。";
    if (status >= 500) return "服务暂时不可用（HTTP " + status + "），请稍后重试。";
    return "请求失败（HTTP " + status + "），请稍后重试。";
  }

  function humanizeError(error) {
    if (error instanceof ChatError) return error.message;
    if (error && error.name === "AbortError") return "";
    if (error && error.name === "TypeError") {
      return "网络连接失败，请检查网络后重试。";
    }
    return "生成回答时出现问题，请稍后重试。";
  }

  function ChatError(message) {
    this.name = "ChatError";
    this.message = message;
    if (Error.captureStackTrace) Error.captureStackTrace(this, ChatError);
  }
  ChatError.prototype = Object.create(Error.prototype);
  ChatError.prototype.constructor = ChatError;

  /* ------------------------------------------------------------------------
     SSE parsing
     ------------------------------------------------------------------------ */

  async function readSseStream(reader, onEvent) {
    var decoder = new TextDecoder("utf-8");
    var buffer = "";
    var dataLines = [];
    var stopped = false;

    function dispatch() {
      if (!dataLines.length) return false;
      var payload = dataLines.join("\n");
      dataLines = [];
      var trimmed = payload.trim();
      if (!trimmed) return false;
      if (trimmed === "[DONE]") return true;

      var event;
      try {
        event = JSON.parse(trimmed);
      } catch (error) {
        return false;
      }
      return onEvent(event) === "stop";
    }

    function consumeLine(rawLine) {
      var line = rawLine;
      if (line.charAt(line.length - 1) === "\r") line = line.slice(0, -1);
      if (line === "") return dispatch();
      if (line.charAt(0) === ":") return false;
      if (line.indexOf("data:") === 0) {
        var value = line.slice(5);
        if (value.charAt(0) === " ") value = value.slice(1);
        dataLines.push(value);
      }
      return false;
    }

    try {
      while (!stopped) {
        var read = await reader.read();
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });

        var newlineIndex;
        while (!stopped && (newlineIndex = buffer.indexOf("\n")) !== -1) {
          var line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (consumeLine(line)) stopped = true;
        }
      }

      if (!stopped) {
        buffer += decoder.decode();
        if (buffer.length) {
          var finalLines = buffer.split("\n");
          for (var i = 0; i < finalLines.length; i += 1) {
            if (consumeLine(finalLines[i])) {
              stopped = true;
              break;
            }
          }
        }
        if (!stopped) dispatch();
      }
    } finally {
      try {
        await reader.cancel();
      } catch (error) {
        /* The stream may already be closed. */
      }
    }
  }

  function parseSseText(text, onEvent) {
    var normalized = String(text == null ? "" : text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var lines = normalized.split("\n");
    var dataLines = [];
    var stopped = false;

    function dispatch() {
      if (!dataLines.length) return false;
      var payload = dataLines.join("\n");
      dataLines = [];
      var trimmed = payload.trim();
      if (!trimmed) return false;
      if (trimmed === "[DONE]") return true;

      var event;
      try {
        event = JSON.parse(trimmed);
      } catch (error) {
        return false;
      }
      return onEvent(event) === "stop";
    }

    for (var i = 0; i < lines.length && !stopped; i += 1) {
      var line = lines[i];
      if (line === "") {
        if (dispatch()) stopped = true;
        continue;
      }
      if (line.charAt(0) === ":") continue;
      if (line.indexOf("data:") === 0) {
        var value = line.slice(5);
        if (value.charAt(0) === " ") value = value.slice(1);
        dataLines.push(value);
      }
    }
    if (!stopped) dispatch();
  }

  /* ------------------------------------------------------------------------
     Sources
     ------------------------------------------------------------------------ */

  function normalizeSources(value) {
    if (!Array.isArray(value)) return [];
    var seen = Object.create(null);
    var result = [];

    for (var i = 0; i < value.length && result.length < MAX_SOURCES; i += 1) {
      var raw = value[i];
      if (!raw || typeof raw !== "object") continue;

      var id = cleanOneLine(raw.id, 32);
      var title = cleanOneLine(raw.title, 160) || "教材片段";
      var ref = cleanOneLine(raw.ref, 160);
      var key = id || title;
      if (key && seen[key]) continue;
      if (key) seen[key] = true;

      result.push({
        id: id || "—",
        title: title,
        ref: ref
      });
    }
    return result;
  }

  /* ------------------------------------------------------------------------
     Markdown renderer
     Blocks are built as DOM nodes; all model text enters through textContent.
     ------------------------------------------------------------------------ */

  function renderMarkdown(container, text) {
    container.textContent = "";
    container.classList.remove("md-plain", "is-streaming");
    try {
      var fragment = parseBlocks(String(text == null ? "" : text));
      container.appendChild(fragment);
    } catch (error) {
      container.textContent = String(text == null ? "" : text);
      container.classList.add("md-plain");
    }
  }

  function parseBlocks(text) {
    var fragment = document.createDocumentFragment();
    var lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) {
        i += 1;
        continue;
      }

      var fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
      if (fence) {
        var markerChar = fence[1].charAt(0);
        var markerLength = fence[1].length;
        var codeLines = [];
        i += 1;
        while (i < lines.length) {
          var candidate = lines[i].trim();
          var closingPattern = new RegExp("^" + (markerChar === "`" ? "`" : "~") + "{" + markerLength + ",}\\s*$");
          if (closingPattern.test(candidate)) {
            i += 1;
            break;
          }
          codeLines.push(lines[i]);
          i += 1;
        }
        var pre = document.createElement("pre");
        var code = document.createElement("code");
        code.textContent = codeLines.join("\n");
        pre.appendChild(code);
        fragment.appendChild(pre);
        continue;
      }

      var trimmed = line.trim();

      if (trimmed.indexOf("$$") === 0) {
        var mathResult = consumeDisplayMath(lines, i, "$$", "$$");
        fragment.appendChild(createMathNode(mathResult.tex, true));
        i = mathResult.nextIndex;
        continue;
      }

      if (trimmed.indexOf("\\[") === 0) {
        var bracketResult = consumeDisplayMath(lines, i, "\\[", "\\]");
        fragment.appendChild(createMathNode(bracketResult.tex, true));
        i = bracketResult.nextIndex;
        continue;
      }

      var heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        var level = Math.min(heading[1].length, 6);
        var headingNode = document.createElement("h" + level);
        appendInline(headingNode, heading[2]);
        fragment.appendChild(headingNode);
        i += 1;
        continue;
      }

      if (isHorizontalRule(line)) {
        fragment.appendChild(document.createElement("hr"));
        i += 1;
        continue;
      }

      if (/^\s{0,3}>/.test(line)) {
        var quoteLines = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
          i += 1;
        }
        var quote = document.createElement("blockquote");
        quote.appendChild(parseBlocks(quoteLines.join("\n")));
        fragment.appendChild(quote);
        continue;
      }

      if (isTableStart(lines, i)) {
        var tableResult = consumeTable(lines, i);
        fragment.appendChild(tableResult.node);
        i = tableResult.nextIndex;
        continue;
      }

      if (listInfo(line)) {
        var listResult = consumeList(lines, i);
        fragment.appendChild(listResult.node);
        i = listResult.nextIndex;
        continue;
      }

      var paragraphLines = [];
      while (i < lines.length) {
        if (!lines[i].trim()) break;
        if (paragraphLines.length && isBlockStart(lines, i)) break;
        paragraphLines.push(lines[i]);
        i += 1;
      }

      var paragraph = document.createElement("p");
      appendInline(paragraph, paragraphLines.join("\n"));
      fragment.appendChild(paragraph);
    }

    return fragment;
  }

  function isHorizontalRule(line) {
    return /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
  }

  function isBlockStart(lines, index) {
    var line = lines[index];
    if (!line || !line.trim()) return false;
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) return true;
    if (/^\s*\$\$/.test(line)) return true;
    if (/^\s*\\\[/.test(line)) return true;
    if (/^\s{0,3}(#{1,6})\s+/.test(line)) return true;
    if (/^\s{0,3}>/.test(line)) return true;
    if (isHorizontalRule(line)) return true;
    if (listInfo(line)) return true;
    if (isTableStart(lines, index)) return true;
    return false;
  }

  function consumeDisplayMath(lines, startIndex, opener, closer) {
    var line = lines[startIndex].trim();
    var tex = line.slice(opener.length);
    var i = startIndex + 1;

    if (tex.lastIndexOf(closer) !== -1) {
      var closeAt = tex.lastIndexOf(closer);
      return {
        tex: tex.slice(0, closeAt).trim(),
        nextIndex: i
      };
    }

    while (i < lines.length) {
      var current = lines[i];
      var currentTrimmed = current.trim();
      var endAt = currentTrimmed.lastIndexOf(closer);
      if (endAt !== -1) {
        tex += (tex ? "\n" : "") + currentTrimmed.slice(0, endAt);
        i += 1;
        break;
      }
      tex += (tex ? "\n" : "") + current;
      i += 1;
    }

    return { tex: tex.trim(), nextIndex: i };
  }

  function listInfo(line) {
    var match = String(line).match(/^([ \t]*)([-+*]|\d{1,3}[.)])(?:[ \t]+)(.*)$/);
    if (!match) return null;

    var indent = match[1].replace(/\t/g, "    ").length;
    var ordered = /^\d/.test(match[2]);
    return {
      indent: indent,
      ordered: ordered,
      start: ordered ? parseInt(match[2], 10) || 1 : 1,
      content: match[3]
    };
  }

  function consumeList(lines, startIndex) {
    var first = listInfo(lines[startIndex]);
    return buildList(lines, startIndex, first.indent, first.ordered);
  }

  function buildList(lines, startIndex, indent, ordered) {
    var list = document.createElement(ordered ? "ol" : "ul");
    var first = listInfo(lines[startIndex]);
    if (ordered && first && first.start !== 1) {
      list.setAttribute("start", String(first.start));
    }

    var i = startIndex;
    var itemCount = 0;

    while (i < lines.length) {
      var info = listInfo(lines[i]);
      if (!info) break;
      if (info.indent < indent) break;
      if (info.indent > indent) break;
      if (info.ordered !== ordered) break;

      var item = document.createElement("li");
      appendInline(item, info.content);
      list.appendChild(item);
      itemCount += 1;
      i += 1;

      while (i < lines.length) {
        var nextInfo = listInfo(lines[i]);
        if (nextInfo && nextInfo.indent > indent) {
          var nested = buildList(lines, i, nextInfo.indent, nextInfo.ordered);
          item.appendChild(nested.node);
          i = nested.nextIndex;
          continue;
        }
        if (nextInfo) break;
        if (!lines[i].trim()) break;
        if (/^[ \t]{2,}\S/.test(lines[i])) {
          var continuation = document.createElement("p");
          appendInline(continuation, lines[i].trim());
          item.appendChild(continuation);
          i += 1;
          continue;
        }
        break;
      }
    }

    if (!itemCount) {
      var fallback = document.createElement("p");
      appendInline(fallback, String(lines[startIndex] || "").trim());
      return { node: fallback, nextIndex: startIndex + 1 };
    }

    return { node: list, nextIndex: i };
  }

  function splitTableRow(line) {
    var value = String(line).trim();
    if (value.charAt(0) === "|") value = value.slice(1);
    if (value.charAt(value.length - 1) === "|") value = value.slice(0, -1);

    var cells = [];
    var current = "";
    for (var i = 0; i < value.length; i += 1) {
      var character = value.charAt(i);
      if (character === "\\" && value.charAt(i + 1) === "|") {
        current += "|";
        i += 1;
        continue;
      }
      if (character === "|") {
        cells.push(current.trim());
        current = "";
        continue;
      }
      current += character;
    }
    cells.push(current.trim());
    return cells;
  }

  function isTableStart(lines, index) {
    if (index + 1 >= lines.length) return false;
    var header = lines[index];
    var separator = lines[index + 1];
    if (header.indexOf("|") === -1 || separator.indexOf("|") === -1) return false;

    var separatorCells = splitTableRow(separator);
    if (!separatorCells.length) return false;

    return separatorCells.every(function (cell) {
      return /^:?-{2,}:?$/.test(cell.replace(/\s/g, ""));
    });
  }

  function consumeTable(lines, startIndex) {
    var headers = splitTableRow(lines[startIndex]);
    var separatorCells = splitTableRow(lines[startIndex + 1]);
    var alignments = separatorCells.map(function (cell) {
      var value = cell.replace(/\s/g, "");
      if (value.charAt(0) === ":" && value.charAt(value.length - 1) === ":") return "center";
      if (value.charAt(value.length - 1) === ":") return "right";
      return "left";
    });

    var wrapper = make("div", "md-table-wrap");
    wrapper.setAttribute("tabindex", "0");
    wrapper.setAttribute("aria-label", "表格，可横向滚动");
    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var headerRow = document.createElement("tr");

    headers.forEach(function (header, index) {
      var th = document.createElement("th");
      if (alignments[index]) th.style.textAlign = alignments[index];
      appendInline(th, header);
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    var i = startIndex + 2;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim() || line.indexOf("|") === -1) break;
      var cells = splitTableRow(line);
      var row = document.createElement("tr");
      for (var c = 0; c < headers.length; c += 1) {
        var td = document.createElement("td");
        if (alignments[c]) td.style.textAlign = alignments[c];
        appendInline(td, cells[c] || "");
        row.appendChild(td);
      }
      tbody.appendChild(row);
      i += 1;
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);
    return { node: wrapper, nextIndex: i };
  }

  /* ------------------------------------------------------------------------
     Inline formatting
     ------------------------------------------------------------------------ */

  function appendInline(parent, source) {
    var text = String(source == null ? "" : source);
    var buffer = "";
    var i = 0;

    function flush() {
      if (!buffer) return;
      parent.appendChild(document.createTextNode(buffer));
      buffer = "";
    }

    while (i < text.length) {
      var character = text.charAt(i);

      if (character === "\\") {
        var escaped = text.charAt(i + 1);
        if (escaped && /[\\`*_{}\[\]()#+\-.!$>~|]/.test(escaped)) {
          buffer += escaped;
          i += 2;
          continue;
        }
        buffer += "\\";
        i += 1;
        continue;
      }

      if (character === "`") {
        var codeEnd = text.indexOf("`", i + 1);
        if (codeEnd !== -1) {
          flush();
          var code = document.createElement("code");
          code.textContent = text.slice(i + 1, codeEnd);
          parent.appendChild(code);
          i = codeEnd + 1;
          continue;
        }
      }

      if (character === "$") {
        if (text.slice(i, i + 2) === "$$") {
          var displayEnd = text.indexOf("$$", i + 2);
          if (displayEnd > i + 2) {
            flush();
            parent.appendChild(createMathNode(text.slice(i + 2, displayEnd).trim(), true));
            i = displayEnd + 2;
            continue;
          }
        } else if (/[^\s$]/.test(text.charAt(i + 1))) {
          var mathEnd = findInlineMathEnd(text, i + 1);
          if (mathEnd !== -1) {
            var tex = text.slice(i + 1, mathEnd).trim();
            if (tex) {
              flush();
              parent.appendChild(createMathNode(tex, false));
              i = mathEnd + 1;
              continue;
            }
          }
        }
      }

      if (character === "*") {
        if (text.slice(i, i + 2) === "**") {
          var strongEnd = findStrongEnd(text, i + 2);
          if (strongEnd !== -1) {
            flush();
            var strong = document.createElement("strong");
            appendInline(strong, text.slice(i + 2, strongEnd));
            parent.appendChild(strong);
            i = strongEnd + 2;
            continue;
          }
        } else {
          var emphasisEnd = findEmphasisEnd(text, i + 1);
          if (emphasisEnd !== -1) {
            flush();
            var emphasis = document.createElement("em");
            appendInline(emphasis, text.slice(i + 1, emphasisEnd));
            parent.appendChild(emphasis);
            i = emphasisEnd + 1;
            continue;
          }
        }
      }

      if (character === "\n") {
        flush();
        parent.appendChild(document.createElement("br"));
        i += 1;
        continue;
      }

      buffer += character;
      i += 1;
    }

    flush();
  }

  function findInlineMathEnd(text, start) {
    for (var i = start; i < text.length; i += 1) {
      var character = text.charAt(i);
      if (character === "\\") {
        i += 1;
        continue;
      }
      if (character === "\n") return -1;
      if (character === "$") {
        if (i === start) return -1;
        if (/\s/.test(text.charAt(i - 1))) return -1;
        return i;
      }
    }
    return -1;
  }

  function findStrongEnd(text, start) {
    for (var i = start; i < text.length - 1; i += 1) {
      if (text.charAt(i) === "\\") {
        i += 1;
        continue;
      }
      if (text.charAt(i) === "*" && text.charAt(i + 1) === "*" && i > start) {
        return i;
      }
    }
    return -1;
  }

  function findEmphasisEnd(text, start) {
    for (var i = start; i < text.length; i += 1) {
      var character = text.charAt(i);
      if (character === "\\") {
        i += 1;
        continue;
      }
      if (character === "\n") return -1;
      if (character === "*" && text.charAt(i - 1) !== "*" && text.charAt(i + 1) !== "*") {
        return i;
      }
    }
    return -1;
  }

  /* ------------------------------------------------------------------------
     Math via vendored KaTeX, with a raw-LaTeX fallback
     ------------------------------------------------------------------------ */

  function createMathNode(tex, displayMode) {
    var clean = String(tex == null ? "" : tex).trim();
    var node = document.createElement(displayMode ? "div" : "span");
    node.className = displayMode ? "math-display" : "math-inline";

    if (!clean) {
      node.classList.add("math-fallback");
      node.textContent = displayMode ? "$$ $$" : "$ $";
      return node;
    }

    if (window.katex && typeof window.katex.render === "function") {
      try {
        window.katex.render(clean, node, {
          displayMode: !!displayMode,
          throwOnError: true,
          strict: "ignore",
          trust: false
        });
        if (node.childNodes.length) return node;
      } catch (error) {
        node.textContent = "";
        node.className = displayMode ? "math-display math-fallback" : "math-inline math-fallback";
      }
    }

    node.classList.add("math-fallback");
    node.textContent = displayMode ? "$$" + clean + "$$" : "$" + clean + "$";
    return node;
  }

  /* ------------------------------------------------------------------------
     Clear conversation
     ------------------------------------------------------------------------ */

  function openClearDialog() {
    if (dom.clearDialog && typeof dom.clearDialog.showModal === "function") {
      if (!dom.clearDialog.open) dom.clearDialog.showModal();
      return;
    }
    if (window.confirm("确定清空当前对话吗？此操作无法撤销。")) {
      clearConversation();
    }
  }

  function clearConversation() {
    state.runToken += 1;
    var controller = state.abortController;
    state.abortController = null;
    state.streaming = false;
    state.stopRequested = false;
    state.activeAssistantId = null;
    if (controller) {
      try {
        controller.abort();
      } catch (error) {
        /* Ignore an already-settled controller. */
      }
    }

    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = 0;
    }

    state.messages = [];
    setMode("auto", { save: false });
    setScopeOpen(false);

    dom.chatLog.textContent = "";
    dom.welcome.hidden = false;
    dom.chatLog.setAttribute("aria-busy", "false");
    dom.chatScroll.scrollTop = 0;
    updateHeaderShadow();
    resetInput();
    updateComposerState();

    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      /* Storage can be unavailable; the in-memory reset still succeeded. */
    }

    announce("对话已清空");
  }

  /* ------------------------------------------------------------------------
     Go
     ------------------------------------------------------------------------ */

  init();
})();
