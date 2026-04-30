/* === Peek 👀 ===
 * 캐릭터 카드 번역 뷰어 — 실제 카드는 안 건드림.
 * 연결 프로필로 번역 → 캐릭터 카드 아래에 표시 → 로컬 저장.
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid, user_avatar, name1 } from '../../../../script.js';
import { Popup } from '../../../popup.js';
import { power_user } from '../../../power-user.js';

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
    selectedFields: ['description'],  // 캐릭터 카드 기본은 description만 체크
    translations: {},  // 캐릭터: { [avatarKey]: { [fieldKey]: { text, translatedAt } } }
    personaTranslations: {},  // 페르소나: { [personaAvatar]: { text, translatedAt } }
    panelCollapsed: false,
    personaPanelCollapsed: false,
    maxResponseTokens: 8192,  // 응답 토큰 한도 (긴 카드 + 한국어 번역 충분히 수용)
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
 * 현재 활성 페르소나 정보 가져오기
 * @returns {{ avatar: string, name: string, description: string } | null}
 */
function getCurrentPersona() {
    const avatar = user_avatar;
    if (!avatar) return null;

    // 이름: power_user.personas[avatar] || name1 (현재 페르소나 이름)
    const name = power_user?.personas?.[avatar] || name1 || '';

    // 설명: power_user.persona_descriptions[avatar].description
    // 또는 textarea에서 직접 읽기 (페르소나 설명창이 열려있을 때 더 정확)
    let description = '';
    const descObj = power_user?.persona_descriptions?.[avatar];
    if (descObj && typeof descObj === 'object') {
        description = descObj.description || '';
    } else if (typeof descObj === 'string') {
        description = descObj;
    }

    // textarea가 떠있다면 거기서도 한번 더 — 사용자가 편집 중인 최신 내용 우선
    const textarea = document.getElementById('persona_description');
    if (textarea && textarea.value && document.body.contains(textarea)) {
        description = textarea.value;
    }

    return { avatar, name, description };
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
    return `You are a professional translator. Translate the following text into natural, fluent Korean.

Context: This is a "${fieldLabel}" field from a SillyTavern roleplay character or persona definition.

Rules:
- Preserve all formatting, line breaks, and special tokens like {{char}}, {{user}}, <tags>, brackets, asterisks for emphasis, etc.
- Do NOT add any explanation, commentary, preamble, or notes.
- Output ONLY the translated text, nothing else.
- Keep proper nouns (names of people, places) in their original form unless they have a standard Korean equivalent.
- Maintain the original tone (formal, casual, narrative, etc.).

---SOURCE---
${sourceText}
---END SOURCE---

Korean translation:`;
}

/**
 * 연결 프로필로 번역 요청
 * ConnectionManagerRequestService는 getContext()를 통해 접근.
 * Vertex AI 호환을 위해 extractData: false 로 raw 응답을 받아 직접 파싱하고,
 * 빈 응답 시 1회 자동 재시도.
 */
async function translateWithProfile(profileId, fieldLabel, sourceText) {
    const ctx = getContext();
    const service = ctx?.ConnectionManagerRequestService
        || globalThis.ConnectionManagerRequestService;

    if (!service || typeof service.sendRequest !== 'function') {
        throw new Error('Connection Manager 서비스를 찾을 수 없어 (SillyTavern 버전 확인 필요)');
    }

    const prompt = buildTranslationPrompt(fieldLabel, sourceText);
    const maxTokens = extension_settings[EXT_ID]?.maxResponseTokens || 8192;

    // 1차 시도 + 빈 응답 시 1회 재시도
    let lastRaw = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            // extractData: false → raw 응답 객체 반환 (OpenAI 호환 구조)
            const result = await service.sendRequest(
                profileId,
                prompt,
                maxTokens,
                { extractData: false }
            );
            lastRaw = result;

            const text = extractTextFromResponse(result);
            if (text && text.trim().length > 0) {
                return text.trim();
            }

            console.warn(`[Peek] ${fieldLabel} 응답 비어있음 (시도 ${attempt}/2). raw:`, result);
        } catch (err) {
            // sendRequest가 throw한 경우 — extractData 옵션 미지원 옛 버전일 수도 있어서 폴백
            if (attempt === 1) {
                console.warn(`[Peek] extractData 옵션 사용 실패, 기본 모드로 폴백:`, err);
                try {
                    const result = await service.sendRequest(profileId, prompt, maxTokens);
                    lastRaw = result;
                    if (result && result.content && result.content.trim()) {
                        return result.content.trim();
                    }
                } catch (err2) {
                    console.error(`[Peek] 폴백 호출도 실패:`, err2);
                    if (attempt === 2) throw err2;
                }
            } else {
                throw err;
            }
        }
    }

    // 2회 다 빈 응답
    console.error('[Peek] 번역 실패 - 최종 raw 응답:', lastRaw);
    throw new Error('응답이 비어있어 (Vertex AI safety filter나 모델 거부일 가능성. 콘솔에 raw 응답 출력됨)');
}

/**
 * sendRequest의 raw 응답에서 텍스트 추출.
 * Vertex/OpenAI/Claude/Gemini 등 다양한 응답 구조 대응.
 */
function extractTextFromResponse(result) {
    if (!result) return '';

    // 1) 단순 content 필드 (extractData: true 모드의 결과)
    if (typeof result.content === 'string') return result.content;

    // 2) OpenAI 호환 (Vertex AI Full mode 응답이 이 형태)
    if (Array.isArray(result.choices) && result.choices.length > 0) {
        const choice = result.choices[0];
        if (choice?.message?.content) return choice.message.content;
        if (typeof choice?.text === 'string') return choice.text;
        // 빈 candidate 감지 (Vertex가 종종 이렇게 옴)
        if (choice?.finish_reason && !choice?.message?.content) {
            console.warn('[Peek] Vertex가 finish_reason은 줬지만 content가 빔. finish_reason:', choice.finish_reason);
        }
    }

    // 3) Gemini native 응답 (candidates 배열)
    if (Array.isArray(result.candidates) && result.candidates.length > 0) {
        const cand = result.candidates[0];
        const parts = cand?.content?.parts;
        if (Array.isArray(parts)) {
            const text = parts.map(p => p?.text || '').join('');
            if (text) return text;
        }
    }

    // 4) Anthropic Claude 네이티브
    if (Array.isArray(result.content)) {
        const text = result.content
            .filter(b => b?.type === 'text')
            .map(b => b.text || '')
            .join('');
        if (text) return text;
    }

    // 5) 최후의 수단 — text 필드
    if (typeof result.text === 'string') return result.text;

    return '';
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

/* ========== 페르소나 번역 ========== */

/**
 * 페르소나 번역 실행
 */
async function runPersonaTranslation() {
    const settings = loadSettings();
    const persona = getCurrentPersona();

    if (!persona || !persona.avatar) {
        toastr.warning('페르소나가 선택되지 않았어', EXT_NAME);
        return;
    }
    if (!persona.description || persona.description.trim().length === 0) {
        toastr.info('번역할 페르소나 설명이 비어있어', EXT_NAME);
        return;
    }
    if (!settings.profileId) {
        toastr.warning('Extensions → Peek 에서 연결 프로필 먼저 골라줘', EXT_NAME);
        return;
    }

    const profiles = getConnectionProfiles();
    const profile = profiles.find(p => p.id === settings.profileId);
    const profileName = profile?.name || '(알 수 없는 프로필)';

    const confirmed = await Popup.show.confirm(
        '페르소나 번역 확인',
        `<div style="text-align:left;">
            <p><b>${escapeHtml(persona.name)}</b>의 페르소나 설명을 <b>${escapeHtml(profileName)}</b>으로 번역할까?</p>
            <p style="font-size:0.85em;opacity:0.7;">기존 번역이 있으면 덮어쓸거야.</p>
        </div>`
    );
    if (!confirmed) return;

    const panel = document.getElementById('peek_persona_panel');
    if (panel) panel.classList.add('peek-loading');

    try {
        const translated = await translateWithProfile(
            settings.profileId,
            'Persona Description',
            persona.description
        );
        settings.personaTranslations[persona.avatar] = {
            text: translated,
            translatedAt: Date.now(),
        };
        saveSettingsDebounced();
        toastr.success('페르소나 번역 완료!', EXT_NAME);
    } catch (err) {
        console.error('[Peek] 페르소나 번역 실패:', err);
        toastr.error(`번역 실패: ${err.message}`, EXT_NAME);
    } finally {
        if (panel) panel.classList.remove('peek-loading');
        renderPersonaPanel();
    }
}

/**
 * 페르소나 번역 표시 패널 렌더링
 */
function renderPersonaPanel() {
    const settings = loadSettings();
    const persona = getCurrentPersona();

    let panel = document.getElementById('peek_persona_panel');

    // 페르소나 컨트롤 영역이 안 보이면 (페르소나 탭이 닫혀있으면) 패널도 의미 없음
    const personaControls = document.getElementById('persona_controls');
    if (!personaControls || !persona) {
        if (panel) panel.style.display = 'none';
        return;
    }

    if (!panel) {
        panel = createPersonaPanelElement();
        // persona_controls 바로 다음에 삽입
        if (personaControls.nextSibling) {
            personaControls.parentNode.insertBefore(panel, personaControls.nextSibling);
        } else {
            personaControls.parentNode.appendChild(panel);
        }
    }

    panel.style.display = '';

    const tr = settings.personaTranslations[persona.avatar];
    const hasTranslation = tr && tr.text;

    // 접힘 상태
    if (settings.personaPanelCollapsed) {
        panel.classList.add('peek-collapsed');
    } else {
        panel.classList.remove('peek-collapsed');
    }

    const titleMeta = panel.querySelector('.peek-title-meta');
    if (titleMeta) {
        titleMeta.textContent = hasTranslation ? '(번역됨)' : '';
    }

    const body = panel.querySelector('.peek-panel-body');
    if (!body) return;

    if (!hasTranslation) {
        body.innerHTML = `<div class="peek-empty">아직 번역된 게 없어.<br>👀 버튼을 눌러서 번역해봐</div>`;
    } else {
        body.innerHTML = `<div class="peek-field-content">${escapeHtml(tr.text)}</div>`;
    }

    const footerTime = panel.querySelector('.peek-footer-time');
    if (footerTime) {
        footerTime.textContent = hasTranslation
            ? `마지막 번역: ${new Date(tr.translatedAt).toLocaleString()}`
            : '';
    }
}

/**
 * 페르소나 패널 DOM 요소 생성
 */
function createPersonaPanelElement() {
    const panel = document.createElement('div');
    panel.id = 'peek_persona_panel';
    panel.className = 'peek-translation-panel';
    panel.innerHTML = `
        <div class="peek-panel-header">
            <div class="peek-title">
                <span>👀 Peek · 페르소나</span>
                <span class="peek-title-meta"></span>
            </div>
            <span class="peek-toggle-icon">▼</span>
        </div>
        <div class="peek-panel-body"></div>
        <div class="peek-loading-indicator">번역 중...</div>
        <div class="peek-panel-footer">
            <span class="peek-footer-time"></span>
            <div class="peek-footer-actions">
                <span class="peek-footer-btn" data-action="clear-persona" title="이 페르소나 번역 삭제">🗑 지우기</span>
            </div>
        </div>
    `;

    panel.querySelector('.peek-panel-header').addEventListener('click', () => {
        const settings = loadSettings();
        settings.personaPanelCollapsed = !settings.personaPanelCollapsed;
        saveSettingsDebounced();
        renderPersonaPanel();
    });

    panel.querySelector('[data-action="clear-persona"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        const persona = getCurrentPersona();
        if (!persona) return;
        const confirmed = await Popup.show.confirm('삭제 확인', '이 페르소나의 번역을 지울까?');
        if (!confirmed) return;
        const settings = loadSettings();
        delete settings.personaTranslations[persona.avatar];
        saveSettingsDebounced();
        renderPersonaPanel();
        toastr.info('번역 삭제됨', EXT_NAME);
    });

    return panel;
}

/**
 * 페르소나 컨트롤 버튼 영역에 👀 번역 버튼 inject
 */
function injectPersonaQuickButton() {
    const buttonsBlock = document.querySelector('#persona_controls .persona_controls_buttons_block');
    if (!buttonsBlock) return;

    // 이미 있으면 스킵
    if (buttonsBlock.querySelector('#peek_persona_quick_btn')) return;

    const btn = document.createElement('div');
    btn.id = 'peek_persona_quick_btn';
    btn.className = 'menu_button interactable peek-persona-btn';
    btn.title = 'Peek: 페르소나 설명 번역';
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('role', 'button');
    btn.textContent = '👀';

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        runPersonaTranslation().catch(err => {
            console.error('[Peek] 페르소나 번역 에러:', err);
            toastr.error(err.message || '알 수 없는 에러', EXT_NAME);
        });
    });

    // 마지막에 추가 (delete 버튼 뒤)
    buttonsBlock.appendChild(btn);
}

/* ========== 캐릭터 카드 ========== */

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

    // 단축 버튼은 항상 체크 (DOM 재생성됐을 수 있음)
    injectQuickButton();

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
        body.innerHTML = `<div class="peek-empty">아직 번역된 게 없어.<br>캐릭터 설명 옆 👀 버튼을 눌러서 번역해봐</div>`;
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
    // form_create 바깥에 붙여야 flex 압박/스크롤 영역 제약에서 자유로움.
    // rm_ch_create_block은 form_create의 부모(캐릭터 편집 패널 전체 컨테이너)
    const outerContainer = document.getElementById('rm_ch_create_block');
    const form = document.getElementById('form_create');

    if (outerContainer && form) {
        // form 바로 다음 형제로 삽입 (form 끝 = 카드 끝)
        if (form.nextSibling) {
            outerContainer.insertBefore(panel, form.nextSibling);
        } else {
            outerContainer.appendChild(panel);
        }
    } else if (outerContainer) {
        outerContainer.appendChild(panel);
    } else if (form) {
        // 폴백: 그래도 form 안쪽 끝
        form.appendChild(panel);
    } else {
        document.body.appendChild(panel);
        console.warn('[Peek] 캐릭터 편집 컨테이너를 못 찾아서 body에 붙였어');
    }
}

/**
 * 캐릭터 설명 라벨 옆에 👀 단축 번역 버튼 inject
 */
function injectQuickButton() {
    const descDiv = document.getElementById('description_div');
    if (!descDiv) return;

    // 이미 있으면 스킵
    if (descDiv.querySelector('#peek_quick_btn')) return;

    // editor_maximize 아이콘 옆에 끼워넣기
    const maximizeIcon = descDiv.querySelector('.editor_maximize');
    if (!maximizeIcon) return;

    const btn = document.createElement('i');
    btn.id = 'peek_quick_btn';
    btn.className = 'right_menu_button interactable peek-quick-btn';
    btn.title = 'Peek: 이 캐릭터 카드를 한국어로 번역';
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('role', 'button');
    btn.textContent = '👀';

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        runTranslation().catch(err => {
            console.error('[Peek] 번역 에러:', err);
            toastr.error(err.message || '알 수 없는 에러', EXT_NAME);
        });
    });

    // editor_maximize 바로 뒤에 삽입
    maximizeIcon.parentNode.insertBefore(btn, maximizeIcon.nextSibling);
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
                        <small style="opacity:0.75;">캐릭터 카드 / 페르소나를 한국어로 번역해서 보여줘. 실제 데이터는 안 건드림.<br>👀 아이콘이 캐릭터 설명 옆 / 페르소나 컨트롤에 추가됨 — 그걸 눌러서 번역 실행.</small>

                        <label for="peek_profile_select"><b>연결 프로필</b></label>
                        <select id="peek_profile_select">${profileOptions}</select>

                        <label for="peek_max_tokens"><b>응답 토큰 최대</b> <small style="opacity:0.6;">(기본 8192, 모델에 맞춰 조정)</small></label>
                        <input type="number" id="peek_max_tokens" min="512" max="65536" step="256" class="text_pole" value="${settings.maxResponseTokens || 8192}">

                        <label><b>캐릭터 카드 번역 시 포함할 필드</b></label>
                        <div class="peek-fields-grid">${fieldCheckboxes}</div>

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

    const tokensInput = document.getElementById('peek_max_tokens');
    if (tokensInput) {
        tokensInput.addEventListener('change', (e) => {
            const settings = loadSettings();
            const val = parseInt(e.target.value, 10);
            if (!isNaN(val) && val >= 512 && val <= 65536) {
                settings.maxResponseTokens = val;
                saveSettingsDebounced();
            } else {
                e.target.value = settings.maxResponseTokens || 8192;
            }
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
    renderPersonaPanel();
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
        renderPersonaPanel();
    }, 200);

    // 캐릭터 관련 이벤트들 바인딩
    eventSource.on(event_types.CHAT_CHANGED, onCharacterContextChange);
    eventSource.on(event_types.CHARACTER_EDITED, onCharacterContextChange);
    eventSource.on(event_types.CHARACTER_PAGE_LOADED, onCharacterContextChange);

    // 캐릭터 편집 패널이 열리거나 캐릭터가 바뀔 때 단축 버튼/패널 상태 보장
    document.addEventListener('click', (e) => {
        // 캐릭터 카드 클릭하면 form이 갱신될 수 있음
        const charBlock = e.target.closest('#rm_print_characters_block .character_select, #rm_button_back');
        if (charBlock) {
            setTimeout(() => renderTranslationPanel(), 100);
        }
        // 페르소나 관련 버튼 클릭 → 페르소나가 바뀌었을 수 있음
        const personaTrigger = e.target.closest('#persona-management-button, .persona-list-item, #persona_controls');
        if (personaTrigger) {
            setTimeout(() => renderPersonaPanel(), 150);
        }
    }, true);

    // 안전망: 관련 DOM이 등장/변경될 때 단축 버튼 자동 inject
    const domObserver = new MutationObserver(() => {
        // 캐릭터 설명 라벨 옆 👀
        const descDiv = document.getElementById('description_div');
        if (descDiv && !descDiv.querySelector('#peek_quick_btn') && this_chid !== undefined) {
            injectQuickButton();
        }
        // 페르소나 컨트롤 영역 👀
        const personaButtons = document.querySelector('#persona_controls .persona_controls_buttons_block');
        if (personaButtons && !personaButtons.querySelector('#peek_persona_quick_btn')) {
            injectPersonaQuickButton();
            // 버튼이 새로 들어갔으면 패널도 같이 챙기기
            renderPersonaPanel();
        }
    });
    domObserver.observe(document.body, { childList: true, subtree: true });

    // Connection Manager 프로필 변경됐을 때 셀렉트박스 새로고침
    eventSource.on(event_types.SETTINGS_UPDATED, () => {
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
