/* === 🦋 Butterfly Translator ===
 * 메시지 자동/수동 번역 + 상태창 번역 + 한영병기
 * ConnectionManagerRequestService 호출 방식은 Peek 확장에서 검증된 패턴을 그대로 사용.
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, updateMessageBlock, saveChatConditional, chat_metadata } from "../../../../script.js";
import { getCached, setCached, clearCurrentChatCache, CACHE_KEY } from "./cache.js";

const EXT_ID = "butterfly_translator";
const EXT_NAME = "🦋 Butterfly Translator";

const defaultSettings = {
  enabled: true,       // 자동번역 전체 켜기/끄기
  autoMode: "all",     // "off" | "user" | "char" | "all"
  profileId: "",
  prompt: "",           // 비워두면 기본 지시문만 사용
  maxResponseTokens: 4096,
};

function loadSettings() {
  if (!extension_settings[EXT_ID]) {
    extension_settings[EXT_ID] = structuredClone(defaultSettings);
  }
  for (const key of Object.keys(defaultSettings)) {
    if (extension_settings[EXT_ID][key] === undefined) {
      extension_settings[EXT_ID][key] = defaultSettings[key];
    }
  }
  return extension_settings[EXT_ID];
}

function getConnectionProfiles() {
  const cm = extension_settings.connectionManager;
  if (!cm || !Array.isArray(cm.profiles)) return [];
  return cm.profiles;
}

// ---------- 번역 프롬프트 ----------
function buildPrompt(sourceText, { bilingual, extraInstruction }) {
  const formatRule = bilingual
    ? `원문 뒤에 대괄호로 번역문을 붙여줘. 예: "Hi.[안녕하세요.]" 줄바꿈은 원문 구조를 유지해줘.`
    : `번역문만 출력해줘. 원문은 포함하지 마.`;

  return `You are a professional translator. Translate the following text into natural, fluent Korean.

Rules:
- ${formatRule}
- Preserve formatting, line breaks, and special tokens like {{char}}, {{user}}, HTML tags.
- Do NOT add explanation, commentary, or preamble.
${extraInstruction ? `- ${extraInstruction}` : ""}

---SOURCE---
${sourceText}
---END SOURCE---`;
}

// ---------- 응답 파싱 (Peek 확장에서 검증된 방식) ----------
function extractTextFromResponse(result) {
  if (!result) return "";
  if (typeof result.content === "string") return result.content;

  if (Array.isArray(result.choices) && result.choices.length > 0) {
    const choice = result.choices[0];
    if (choice?.message?.content) return choice.message.content;
    if (typeof choice?.text === "string") return choice.text;
  }

  if (Array.isArray(result.candidates) && result.candidates.length > 0) {
    const parts = result.candidates[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const text = parts.map((p) => p?.text || "").join("");
      if (text) return text;
    }
  }

  if (Array.isArray(result.content)) {
    const text = result.content.filter((b) => b?.type === "text").map((b) => b.text || "").join("");
    if (text) return text;
  }

  if (typeof result.text === "string") return result.text;
  return "";
}

// ---------- 실제 번역 요청 ----------
async function translateWithProfile(sourceText, opts) {
  const settings = loadSettings();
  if (!settings.profileId) {
    throw new Error("연결 프로필이 선택되지 않았습니다. 설정에서 먼저 선택해주세요.");
  }

  const ctx = getContext();
  const service = ctx?.ConnectionManagerRequestService || globalThis.ConnectionManagerRequestService;
  if (!service || typeof service.sendRequest !== "function") {
    throw new Error("Connection Manager 서비스를 찾을 수 없습니다. (SillyTavern 버전 확인 필요)");
  }

  const prompt = buildPrompt(sourceText, opts);
  const maxTokens = settings.maxResponseTokens || 4096;

  let lastRaw = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await service.sendRequest(settings.profileId, prompt, maxTokens, { extractData: false });
      lastRaw = result;
      const text = extractTextFromResponse(result);
      if (text && text.trim()) return text.trim();
      console.warn(`[${EXT_NAME}] 응답 비어있음 (시도 ${attempt}/2)`, result);
    } catch (err) {
      if (attempt === 1) {
        console.warn(`[${EXT_NAME}] extractData 옵션 실패, 기본 모드로 폴백`, err);
        try {
          const result = await service.sendRequest(settings.profileId, prompt, maxTokens);
          lastRaw = result;
          if (result?.content?.trim()) return result.content.trim();
        } catch (err2) {
          throw err2;
        }
      } else {
        throw err;
      }
    }
  }
  throw new Error("번역 응답이 비어있습니다. (모델 거부 또는 안전 필터일 수 있음, 콘솔에 raw 응답 출력됨)");
}

// ---------- 메시지 파싱: 대사 / 상태창 분리 ----------
function splitMessageParts(mes) {
  const panelMatch = mes.match(/<div[\s\S]*<\/div>/i);
  if (panelMatch) {
    const panel = panelMatch[0];
    const dialogue = mes.replace(panel, "").trim();
    return { dialogue, panel };
  }
  return { dialogue: mes, panel: null };
}

// ---------- 메시지 하나 번역 ----------
async function translateMessage(messageId, { force = false } = {}) {
  const ctx = getContext();
  const chat = ctx.chat;
  const message = chat[messageId];
  if (!message) return;

  const original = message.mes;
  const btn = document.querySelector(`.mes[mesid="${messageId}"] .bt-icon-btn`);

  try {
    if (!force) {
      const cached = getCached(chat_metadata, original);
      if (cached) {
        if (typeof message.extra !== "object" || message.extra === null) message.extra = {};
        message.extra.display_text = cached;
        updateMessageBlock(messageId, message);
        return;
      }
    }

    btn?.classList.add("bt-translating");

    const settings = loadSettings();
    const { dialogue, panel } = splitMessageParts(original);

    const translatedDialogue = dialogue
      ? await translateWithProfile(dialogue, { bilingual: true, extraInstruction: settings.prompt })
      : "";

    let translatedPanel = panel;
    if (panel) {
      try {
        translatedPanel = await translateWithProfile(panel, { bilingual: false, extraInstruction: settings.prompt });
      } catch (e) {
        console.warn(`[${EXT_NAME}] 상태창 번역 실패, 원문 유지`, e);
      }
    }

    const finalText = translatedPanel ? `${translatedDialogue}\n${translatedPanel}` : translatedDialogue;

    setCached(chat_metadata, original, finalText);
    if (typeof message.extra !== "object" || message.extra === null) message.extra = {};
    message.extra.display_text = finalText;
    updateMessageBlock(messageId, message);
    saveSettingsDebounced();
    saveChatConditional?.();
  } catch (e) {
    console.error(`[${EXT_NAME}] 번역 실패`, e);
    toastr.error(e.message || "번역 중 오류가 발생했습니다.", EXT_NAME);
  } finally {
    btn?.classList.remove("bt-translating");
  }
}

function revertMessage(messageId) {
  const ctx = getContext();
  const message = ctx.chat[messageId];
  if (!message) return;
  if (message.extra?.display_text) {
    delete message.extra.display_text;
    updateMessageBlock(messageId, message);
    saveChatConditional?.();
  } else {
    toastr.info("되돌릴 번역이 없습니다.", EXT_NAME);
  }
}

// ---------- 자동번역 ----------
function shouldAutoTranslate(isUser) {
  const settings = loadSettings();
  if (!settings.enabled || settings.autoMode === "off") return false;
  if (settings.autoMode === "all") return true;
  if (settings.autoMode === "user") return isUser;
  if (settings.autoMode === "char") return !isUser;
  return false;
}

// ---------- 🦋 버튼: 이름(.name_text) 바로 옆에 삽입 ----------
function injectButton(messageId) {
  const mesBlock = document.querySelector(`.mes[mesid="${messageId}"]`);
  if (!mesBlock) return;
  const nameBlock = mesBlock.querySelector(".name_text");
  if (!nameBlock) return;
  if (mesBlock.querySelector(".bt-icon-btn")) return; // 중복 삽입 방지

  const btn = document.createElement("span");
  btn.className = "bt-icon-btn";
  btn.title = "번역";
  btn.textContent = "🦋";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    openMenu(e, messageId, btn);
  });
  nameBlock.insertAdjacentElement("afterend", btn);
}

function openMenu(event, messageId, anchorEl) {
  document.querySelectorAll(".bt-menu").forEach((m) => m.remove());

  const menu = document.createElement("div");
  menu.className = "bt-menu";
  menu.innerHTML = `
    <div class="bt-menu-item" data-action="translate">번역</div>
    <div class="bt-menu-item" data-action="retranslate">재번역</div>
    <div class="bt-menu-item" data-action="revert">되돌리기</div>
  `;
  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY}px`;
  menu.style.left = `${rect.left + window.scrollX}px`;

  menu.addEventListener("click", (e) => {
    const action = e.target.dataset.action;
    if (action === "translate") translateMessage(messageId);
    if (action === "retranslate") translateMessage(messageId, { force: true });
    if (action === "revert") revertMessage(messageId);
    menu.remove();
  });

  setTimeout(() => {
    document.addEventListener("click", function handler(e2) {
      if (!menu.contains(e2.target) && e2.target !== anchorEl) {
        menu.remove();
        document.removeEventListener("click", handler);
      }
    });
  }, 0);
}

function onMessageRendered(messageId, isUser) {
  injectButton(messageId);
  if (shouldAutoTranslate(isUser)) translateMessage(messageId);
}

// ---------- 설정 패널 ----------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSettingsPanel() {
  const settings = loadSettings();
  const profiles = getConnectionProfiles();

  const profileOptions =
    profiles.length === 0
      ? '<option value="">(연결 프로필이 없어요 — Connection Manager에서 먼저 만들어주세요)</option>'
      : '<option value="">-- 프로필 선택 --</option>' +
        profiles
          .map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === settings.profileId ? "selected" : ""}>${escapeHtml(p.name || "(이름 없음)")}</option>`)
          .join("");

  const html = `
    <div id="bt_settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>${EXT_NAME}</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <label class="checkbox_label" for="bt_enabled">
            <input type="checkbox" id="bt_enabled" ${settings.enabled ? "checked" : ""}>
            <span>자동번역 전체 켜기/끄기</span>
          </label>

          <label for="bt_auto_mode">자동번역 범위</label>
          <select id="bt_auto_mode" class="text_pole">
            <option value="off">끄기</option>
            <option value="user">유저 메시지만</option>
            <option value="char">캐릭터 메시지만</option>
            <option value="all">전체</option>
          </select>

          <label for="bt_profile_select">연결 프로필</label>
          <select id="bt_profile_select" class="text_pole">${profileOptions}</select>

          <label for="bt_prompt">번역 프롬프트 (선택 — 비워두면 기본값 사용)</label>
          <textarea id="bt_prompt" class="text_pole" rows="3" placeholder="예: 반말로 번역해줘">${escapeHtml(settings.prompt)}</textarea>

          <div class="bt-btn-row">
            <button id="bt_clear_current" class="menu_button">현재 채팅 캐시 청소</button>
            <button id="bt_clear_all" class="menu_button">전체 캐시 청소</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const existing = document.getElementById("bt_settings");
  if (existing) existing.remove();

  const wrapper = document.createElement("div");
  wrapper.innerHTML = html.trim();
  const settingsEl = wrapper.firstElementChild;

  const container = document.getElementById("extensions_settings2") || document.getElementById("extensions_settings");
  if (!container) {
    console.warn(`[${EXT_NAME}] 설정 컨테이너를 찾지 못했습니다.`);
    return;
  }
  container.appendChild(settingsEl);

  document.getElementById("bt_auto_mode").value = settings.autoMode;

  document.getElementById("bt_enabled").addEventListener("change", (e) => {
    settings.enabled = e.target.checked;
    saveSettingsDebounced();
  });
  document.getElementById("bt_auto_mode").addEventListener("change", (e) => {
    settings.autoMode = e.target.value;
    saveSettingsDebounced();
  });
  document.getElementById("bt_profile_select").addEventListener("change", (e) => {
    settings.profileId = e.target.value;
    saveSettingsDebounced();
  });
  document.getElementById("bt_prompt").addEventListener("change", (e) => {
    settings.prompt = e.target.value;
    saveSettingsDebounced();
  });
  document.getElementById("bt_clear_current").addEventListener("click", () => {
    const ctx = getContext();
    clearCurrentChatCache(chat_metadata);
    saveSettingsDebounced();
    toastr.success("현재 채팅 번역 캐시를 청소했습니다.", EXT_NAME);
  });
  document.getElementById("bt_clear_all").addEventListener("click", () => {
    const ctx = getContext();
    clearCurrentChatCache(chat_metadata);
    saveSettingsDebounced();
    toastr.success("전체 번역 캐시를 청소했습니다. (현재 열린 채팅 기준)", EXT_NAME);
  });
}

// ---------- 초기화 ----------
jQuery(async () => {
  loadSettings();

  function injectAllVisible() {
    document.querySelectorAll(".mes[mesid]").forEach((el) => {
      const id = Number(el.getAttribute("mesid"));
      if (!Number.isNaN(id)) injectButton(id);
    });
  }

  setTimeout(() => {
    renderSettingsPanel();
    injectAllVisible();
  }, 200);

  eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(injectAllVisible, 200));

  eventSource.on(event_types.USER_MESSAGE_RENDERED, (id) => onMessageRendered(id, true));
  eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => onMessageRendered(id, false));

  eventSource.on(event_types.SETTINGS_UPDATED, () => {
    const select = document.getElementById("bt_profile_select");
    if (!select) return;
    const settings = loadSettings();
    const profiles = getConnectionProfiles();
    select.innerHTML =
      profiles.length === 0
        ? '<option value="">(연결 프로필 없음)</option>'
        : '<option value="">-- 프로필 선택 --</option>' +
          profiles.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === settings.profileId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("");
  });

  console.log(`[${EXT_NAME}] 로드 완료`);
});
