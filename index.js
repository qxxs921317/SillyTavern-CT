/* === Peek 👀 ===
 * 캐릭터 카드 번역 뷰어 — 실제 카드는 안 건드림.
 * 연결 프로필로 번역 → 캐릭터 카드 아래에 표시 → 로컬 저장.
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid } from '../../../../script.js';
import { Popup } from '../../../popup.js';

const EXT_ID = 'peek';
const EXT_NAME = 'Peek 👀';

// 번역 가능한 필드들 (SillyTavern 캐릭터 카드 기준)
const TRANSLATABLE_FIELDS = [
    { key: 'description', label: 'Description', desc: '캐릭터 설명' },
    { key: 'personality', label: 'Personality', desc: '성격 요약' },
    { key: 'scenario', label: 'Scenario', desc: '시나리오' },
    { key: 'first_mes', label: 'First Message', desc: '첫 메시지' },
    { key: 'mes_example', label: 'Example Messages', desc: '예시 대화' },
    { key: 'creatorcomment', label: 'Creator Notes', desc: '제작자 노트' },
];

// 기본 설정
const defaultSettings = {
    profileId: '',
    selectedFields: ['description'],  // 기본은 description만 체크
    translations: {},  // { [avatarKey]: { [fieldKey]: { text, translatedAt } } }
    panelCollapsed: false,
};

/**
 * 설정 초기화 / 로드
 */
function loadSettings() {
    if (!extension_settings[EXT_ID]) {
        extension_settings[EXT_ID] = structuredClone(defaultSettings);
    }
    // 새 필드 추가 시 누락 방지
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[EXT_ID][key] === undefined) {
            extension_settings[EXT_ID][key] = structuredClone(defaultSettings[key]);
        }
    }
    return extension_settings[EXT_ID];
}

/**
 * 현재 캐릭터의 고유 키 (avatar 파일명) 가져오기
 */
function getCurrentCharKey() {
    const chid = this_chid;
    if (chid === undefined || chid === null) return null;
    const char = characters[chid];
    if (!char) return null;
    return char.avatar || char.name || null;
}

/**
 * 현재 캐릭터 객체 가져오기
 */
function getCurrentChar() {
    const chid = this_chid;
    if (chid === undefined || chid === null) return null;
    return characters[chid] || null;
}

/**
 * 연결 프로필 목록 가져오기 (Connection Manager에서)
 */
function getConnectionProfiles() {
    const cm = extension_settings.connectionManager;
    if (!cm || !Array.isArray(cm.profiles)) return [];
    return cm.profiles;
}

/**
 * 번역 프롬프트 생성
 */
function buildTranslationPrompt(fieldLabel, sourceText) {
    return `You are a professional translator. Translate the following character card field into natural, fluent Korean.

Rules:
- Preserve all formatting, line breaks, and special tokens like {{char}}, {{user}}, <tags>, brackets, asterisks for emphasis, etc.
- Do NOT add any explanation, commentary, preamble, or notes.
- Output ONLY the translated text, nothing else.
- Keep proper nouns (names of people, places) in their original form unless they have a standard Korean equivalent.
- Maintain the original tone (formal, casual, narrative, etc.).

Field: ${fieldLabel}

---SOURCE---
${sourceText}
---END SOURCE---

Korean translation:`;
}

/**
 * 연결 프로필로 번역 요청
 * ConnectionManagerRequestService는 getContext()를 통해 접근
 */
async function translateWithProfile(profileId, fieldLabel, sourceText) {
    const ctx = getContext();
    const service = ctx?.ConnectionManagerRequestService
        || globalThis.ConnectionManagerRequestService;

    if (!service || typeof service.sendRequest !== 'function') {
        throw new Error('Connection Manager 서비스를 찾을 수 없어 (SillyTavern 버전 확인 필요)');
    }

    const prompt = buildTranslationPrompt(fieldLabel, sourceText);
    const result = await service.sendRequest(
        profileId,
        prompt,
        2048,  // max response tokens (긴 카드 대응)
    );
    if (!result || !result.content) {
        throw new Error('빈 응답을 받았어');
    }
    return result.content.trim();
}

/**
 * 모든 선택된 필드 번역 실행
 */
async function runTranslation() {
    const settings = loadSettings();
    const char = getCurrentChar();
    const charKey = getCurrentCharKey();

    if (!char || !charKey) {
        toastr.warning('캐릭터를 먼저 선택해줘', EXT_NAME);
        return;
    }

    if (!settings.profileId) {
        toastr.warning('연결 프로필을 먼저 선택해줘', EXT_NAME);
        return;
    }

    if (!settings.selectedFields || settings.selectedFields.length === 0) {
        toastr.warning('번역할 필드를 하나 이상 체크해줘', EXT_NAME);
        return;
    }

    // 번역할 필드 + 비어있지 않은 것만
    const fieldsToTranslate = TRANSLATABLE_FIELDS
        .filter(f => settings.selectedFields.includes(f.key))
        .filter(f => {
            const val = char.data?.[f.key] ?? char[f.key];
            return val && String(val).trim().length > 0;
        });

    if (fieldsToTranslate.length === 0) {
        toastr.info('번역할 내용이 없어 (해당 필드들이 비어있음)', EXT_NAME);
        return;
    }

    // 확인창
    const profiles = getConnectionProfiles();
    const profile = profiles.find(p => p.id === settings.profileId);
    const profileName = profile?.name || '(알 수 없는 프로필)';

    const fieldList = fieldsToTranslate.map(f => `• ${f.label} (${f.desc})`).join('\n');
    const charName = char.name || '이 캐릭터';

    const confirmed = await Popup.show.confirm(
        '번역 확인',
        `<div style="text-align:left;">
            <p><b>${charName}</b>의 다음 필드를 <b>${profileName}</b>으로 번역할까?</p>
            <pre style="white-space:pre-wrap;font-size:0.9em;opacity:0.85;margin:8px 0;">${fieldList}</pre>
            <p style="font-size:0.85em;opacity:0.7;">기존 번역이 있으면 덮어쓸거야.</p>
        </div>`
    );

    if (!confirmed) return;

    // 번역 실행
    const panel = document.getElementById('peek_translation_panel');
    if (panel) panel.classList.add('peek-loading');

    if (!settings.translations[charKey]) {
        settings.translations[charKey] = {};
    }

    let success = 0;
    let failed = 0;

    for (const field of fieldsToTranslate) {
        try {
            const sourceText = String(char.data?.[field.key] ?? char[field.key] ?? '');
            updateLoadingMessage(`${field.label} 번역 중...`);
            const translated = await translateWithProfile(
                settings.profileId,
                field.label,
                sourceText
            );
            settings.translations[charKey][field.key] = {
                text: translated,
                translatedAt: Date.now(),
            };
            success++;
        } catch (err) {
            console.error(`[Peek] ${field.label} 번역 실패:`, err);
            toastr.error(`${field.label} 번역 실패: ${err.message}`, EXT_NAME);
            failed++;
        }
    }

    saveSettingsDebounced();
    if (panel) panel.classList.remove('peek-loading');
    renderTranslationPanel();

    if (success > 0 && failed === 0) {
        toastr.success(`${success}개 필드 번역 완료!`, EXT_NAME);
    } else if (success > 0 && failed > 0) {
        toastr.warning(`${success}개 성공, ${failed}개 실패`, EXT_NAME);
    } else {
        toastr.error('번역 실패', EXT_NAME);
    }
}

/**
 * 로딩 인디케이터 메시지 업데이트
 */
function updateLoadingMessage(msg) {
    const indicator = document.querySelector('#peek_translation_panel .peek-loading-indicator');
    if (indicator) indicator.textContent = msg;
}

/**
 * 캐릭터 카드 아래에 표시되는 번역 패널 렌더링
 */
function renderTranslationPanel() {
    const settings = loadSettings();
    const char = getCurrentChar();
    const charKey = getCurrentCharKey();

    let panel = document.getElementById('peek_translation_panel');

    // 캐릭터 없으면 패널 숨김
    if (!char || !charKey) {
        if (panel) panel.style.display = 'none';
        return;
    }

    // 패널 컨테이너 없으면 생성 + 적절한 위치에 inject
    if (!panel) {
        panel = createPanelElement();
        injectPanel(panel);
    }

    panel.style.display = '';

    const charTranslations = settings.translations[charKey] || {};
    const hasAny = Object.keys(charTranslations).length > 0;

    // 접힘 상태 적용
    if (settings.panelCollapsed) {
        panel.classList.add('peek-collapsed');
    } else {
        panel.classList.remove('peek-collapsed');
    }

    // 헤더 메타 (몇 개 번역됐는지)
    const titleMeta = panel.querySelector('.peek-title-meta');
    if (titleMeta) {
        titleMeta.textContent = hasAny ? `(${Object.keys(charTranslations).length}개 필드)` : '';
    }

    // 본문
    const body = panel.querySelector('.peek-panel-body');
    if (!body) return;

    if (!hasAny) {
        body.innerHTML = `<div class="peek-empty">아직 번역된 게 없어.<br>확장 탭에서 "번역하기" 눌러봐 👀</div>`;
        return;
    }

    // 필드 순서대로 표시 (TRANSLATABLE_FIELDS 순서 유지)
    const blocks = [];
    for (const field of TRANSLATABLE_FIELDS) {
        const tr = charTranslations[field.key];
        if (!tr || !tr.text) continue;
        const safeText = escapeHtml(tr.text);
        blocks.push(`
            <div class="peek-field-block">
                <div class="peek-field-label">${field.label} · ${field.desc}</div>
                <div class="peek-field-content">${safeText}</div>
            </div>
        `);
    }

    body.innerHTML = blocks.join('');

    // 푸터 - 가장 최근 번역 시각
    const allTimes = Object.values(charTranslations).map(t => t.translatedAt || 0);
    const latest = Math.max(...allTimes);
    const footer = panel.querySelector('.peek-footer-time');
    if (footer && latest > 0) {
        const d = new Date(latest);
        footer.textContent = `마지막 번역: ${d.toLocaleString()}`;
    }
}

/**
 * 패널 DOM 요소 생성
 */
function createPanelElement() {
    const panel = document.createElement('div');
    panel.id = 'peek_translation_panel';
    panel.innerHTML = `
        <div class="peek-panel-header">
            <div class="peek-title">
                <span>👀 Peek</span>
                <span class="peek-title-meta"></span>
            </div>
            <span class="peek-toggle-icon">▼</span>
        </div>
        <div class="peek-panel-body"></div>
        <div class="peek-loading-indicator">번역 중...</div>
        <div class="peek-panel-footer">
            <span class="peek-footer-time"></span>
            <div class="peek-footer-actions">
                <span class="peek-footer-btn" data-action="clear" title="이 캐릭터 번역 삭제">🗑 지우기</span>
            </div>
        </div>
    `;

    // 헤더 클릭 → 접기/펼치기
    panel.querySelector('.peek-panel-header').addEventListener('click', () => {
        const settings = loadSettings();
        settings.panelCollapsed = !settings.panelCollapsed;
        saveSettingsDebounced();
        renderTranslationPanel();
    });

    // 지우기 버튼
    panel.querySelector('[data-action="clear"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        const charKey = getCurrentCharKey();
        if (!charKey) return;
        const confirmed = await Popup.show.confirm('삭제 확인', '이 캐릭터의 번역을 모두 지울까?');
        if (!confirmed) return;
        const settings = loadSettings();
        delete settings.translations[charKey];
        saveSettingsDebounced();
        renderTranslationPanel();
        toastr.info('번역 삭제됨', EXT_NAME);
    });

    return panel;
}

/**
 * 패널을 캐릭터 카드 편집 영역 아래에 inject
 * SillyTavern의 캐릭터 편집 패널 구조에 맞춰 적절한 위치 찾기
 */
function injectPanel(panel) {
    // 캐릭터 편집 폼 끝 부분에 붙이기
    // #form_create 안의 마지막에 넣으면 카드 아래쪽에 자연스럽게 위치
    const target = document.getElementById('form_create')
        || document.getElementById('rm_ch_create_block');

    if (target) {
        target.appendChild(panel);
    } else {
        // 폴백: body에라도 (안전망)
        document.body.appendChild(panel);
        console.warn('[Peek] 캐릭터 편집 폼을 못 찾아서 body에 붙였어');
    }
}

/**
 * HTML escape (XSS 방지)
 */
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 확장 설정 패널 (Extensions 탭) UI 렌더링
 */
function renderSettingsPanel() {
    const settings = loadSettings();
    const profiles = getConnectionProfiles();

    const profileOptions = profiles.length === 0
        ? '<option value="">(연결 프로필이 없어 — Connection Manager에서 만들어줘)</option>'
        : '<option value="">-- 프로필 선택 --</option>' +
          profiles.map(p => {
              const selected = p.id === settings.profileId ? 'selected' : '';
              const name = escapeHtml(p.name || '(이름 없음)');
              return `<option value="${escapeHtml(p.id)}" ${selected}>${name}</option>`;
          }).join('');

    const fieldCheckboxes = TRANSLATABLE_FIELDS.map(f => {
        const checked = settings.selectedFields.includes(f.key) ? 'checked' : '';
        return `
            <label class="peek-field-checkbox" title="${f.desc}">
                <input type="checkbox" data-field="${f.key}" ${checked}>
                <span>${f.label}</span>
            </label>
        `;
    }).join('');

    const html = `
        <div id="peek_settings" class="extension_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Peek 👀</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="peek-settings-block">
                        <small style="opacity:0.75;">캐릭터 카드를 한국어로 번역해서 카드 아래에 보여줘. 실제 카드 데이터는 안 건드림.</small>

                        <label for="peek_profile_select"><b>연결 프로필</b></label>
                        <select id="peek_profile_select">${profileOptions}</select>

                        <label><b>번역할 필드</b></label>
                        <div class="peek-fields-grid">${fieldCheckboxes}</div>

                        <div style="display:flex; gap:6px; margin-top:8px;">
                            <button id="peek_translate_btn" class="menu_button" style="flex:1;">
                                <i class="fa-solid fa-language"></i> 번역하기
                            </button>
                        </div>

                        <div class="peek-status" id="peek_status"></div>
                    </div>
                </div>
            </div>
        </div>
    `;

    // 이미 존재하면 제거 후 다시 생성
    const existing = document.getElementById('peek_settings');
    if (existing) existing.remove();

    const wrapper = document.createElement('div');
    wrapper.innerHTML = html.trim();
    const settingsEl = wrapper.firstElementChild;

    // SillyTavern은 #extensions_settings2가 표준 마운트 포인트
    const container = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings');
    if (container && settingsEl) {
        container.appendChild(settingsEl);
    } else {
        console.warn('[Peek] 확장 설정 컨테이너를 못 찾았어');
        return;
    }

    // 이벤트 바인딩
    bindSettingsEvents();
    updateStatus();
}

/**
 * 설정 UI 이벤트 바인딩
 */
function bindSettingsEvents() {
    const profileSelect = document.getElementById('peek_profile_select');
    if (profileSelect) {
        profileSelect.addEventListener('change', (e) => {
            const settings = loadSettings();
            settings.profileId = e.target.value;
            saveSettingsDebounced();
            updateStatus();
        });
    }

    const checkboxes = document.querySelectorAll('#peek_settings input[type="checkbox"][data-field]');
    checkboxes.forEach(cb => {
        cb.addEventListener('change', () => {
            const settings = loadSettings();
            const checked = Array.from(checkboxes)
                .filter(c => c.checked)
                .map(c => c.dataset.field);
            settings.selectedFields = checked;
            saveSettingsDebounced();
        });
    });

    const btn = document.getElementById('peek_translate_btn');
    if (btn) {
        btn.addEventListener('click', () => {
            runTranslation().catch(err => {
                console.error('[Peek] 번역 에러:', err);
                toastr.error(err.message || '알 수 없는 에러', EXT_NAME);
            });
        });
    }
}

/**
 * 상태 메시지 업데이트
 */
function updateStatus() {
    const statusEl = document.getElementById('peek_status');
    if (!statusEl) return;
    const settings = loadSettings();
    const char = getCurrentChar();

    if (!char) {
        statusEl.textContent = '캐릭터 미선택';
        return;
    }
    if (!settings.profileId) {
        statusEl.textContent = `현재: ${char.name} · 프로필 선택 필요`;
        return;
    }
    const profiles = getConnectionProfiles();
    const profile = profiles.find(p => p.id === settings.profileId);
    statusEl.textContent = `현재: ${char.name} · ${profile?.name || '(프로필 없음)'}`;
}

/**
 * 캐릭터 변경 / 편집 / 채팅 변경 시 패널 다시 렌더
 */
function onCharacterContextChange() {
    renderTranslationPanel();
    updateStatus();
}

/**
 * 확장 초기화
 */
jQuery(async () => {
    loadSettings();

    // 설정 UI 그리기 (DOM 준비될 때까지 살짝 대기)
    setTimeout(() => {
        renderSettingsPanel();
        renderTranslationPanel();
    }, 200);

    // 캐릭터 관련 이벤트들 바인딩
    eventSource.on(event_types.CHAT_CHANGED, onCharacterContextChange);
    eventSource.on(event_types.CHARACTER_EDITED, onCharacterContextChange);
    eventSource.on(event_types.CHARACTER_PAGE_LOADED, onCharacterContextChange);

    // Connection Manager 프로필 변경됐을 때 셀렉트박스 새로고침
    eventSource.on(event_types.SETTINGS_UPDATED, () => {
        // 프로필 셀렉트만 업데이트 (전체 다시 그리면 체크박스 상태 날아감)
        const select = document.getElementById('peek_profile_select');
        if (!select) return;
        const settings = loadSettings();
        const profiles = getConnectionProfiles();
        const currentVal = settings.profileId;
        const newOptions = profiles.length === 0
            ? '<option value="">(연결 프로필 없음)</option>'
            : '<option value="">-- 프로필 선택 --</option>' +
              profiles.map(p => {
                  const sel = p.id === currentVal ? 'selected' : '';
                  return `<option value="${escapeHtml(p.id)}" ${sel}>${escapeHtml(p.name)}</option>`;
              }).join('');
        select.innerHTML = newOptions;
    });

    console.log(`[${EXT_NAME}] 로드 완료`);
});
