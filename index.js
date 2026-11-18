/* === Peek 👀 ===
 * 캐릭터 카드 번역 뷰어 — 실제 카드는 안 건드림.
 * 연결 프로필로 번역 → 캐릭터 카드 아래에 표시 → 로컬 저장.
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid, user_avatar, name1 } from '../../../../script.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';
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
const ALT_FIELD = { key: 'alternate_greetings', label: 'ALT 전체 번역', desc: '모든 대체 그리팅' };
const ALT_KEY_PREFIX = 'alt_greeting_';

function characterTranslationTargets(char, selectedFields) {
    const targets = TRANSLATABLE_FIELDS
        .filter(field => selectedFields.includes(field.key))
        .map(field => ({ ...field, source: char.data?.[field.key] ?? char[field.key] }));
    const greetings = char.data?.[ALT_FIELD.key] ?? char[ALT_FIELD.key];
    if (selectedFields.includes(ALT_FIELD.key) && Array.isArray(greetings)) {
        greetings.forEach((source, index) => {
            const number = index + 1;
            targets.push({ key: ALT_KEY_PREFIX + number, label: `ALT ${number}`, source });
        });
    }
    return targets.filter(target => target.source && String(target.source).trim());
}

function savedAltGreetings(auto) {
    return Object.keys(auto ?? {})
        .filter(key => /^alt_greeting_[1-9]\d*$/.test(key) && auto[key]?.text)
        .map(key => ({ key, number: Number(key.slice(ALT_KEY_PREFIX.length)) }))
        .sort((a, b) => a.number - b.number)
        .map(({ key, number }) => ({ key, label: `ALT ${number}` }));
}


// 기본 설정
const defaultSettings = {
    profileId: '',
    selectedFields: ['description'],  // 캐릭터 카드 기본은 description만 체크
    panelCollapsed: false,
    personaPanelCollapsed: false,
    maxResponseTokens: 8192,
    // === v1.7 - 번역/메모 데이터는 settings가 아니라 /user/files 에 저장됨 ===
    // 레거시 키(translations, notes 등)는 기존 유저 데이터라 여기서 재생성하지 않음.
    fileIndex: {},                  // { "char:Sera.png": { file, updatedAt } }
    legacyTombstones: {},           // 유저가 지운 엔티티 — 레거시에서 부활 방지
    storageMode: 'file',            // 'file' | 'legacy'
    activeTab: 'auto',              // 캐릭터 탭 상태: 'auto' | 'manual'
    personaActiveTab: 'auto',
    notesPanelCollapsed: true,      // 메모 패널 접힘 상태 (기본 접힘)
    personaNotesPanelCollapsed: true,
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

/* ===================================================================
 * 파일 기반 저장소 (v1.7)
 *
 * 번역/메모 데이터는 settings.json이 아니라 /user/files/peek_*.json 에
 * 캐릭터 1명당 파일 1개로 저장됨. settings에는 인덱스만 남음.
 *
 * 기존 유저 보호:
 *  - 읽기는 캐시 → 파일 → 레거시(settings) 순으로 폴백
 *  - 레거시 데이터는 자동으로 지우지 않음 (정리 버튼으로만)
 *  - 파일 API가 없거나 실패하면 레거시 모드로 자동 강등
 * =================================================================== */

const FILE_UPLOAD_URL = '/api/files/upload';
const FILE_DELETE_URL = '/api/files/delete';
const FILE_DIR = '/user/files';

// 런타임 데이터 — extension_settings 바깥에 두는 게 핵심
const peekData = {
    translations: {},
    personaTranslations: {},
    manualTranslations: {},
    personaManualTranslations: {},
    notes: {},
    personaNotes: {},
};

// kind별 섹션 매핑
const SECTIONS = {
    char: { auto: 'translations', manual: 'manualTranslations', note: 'notes' },
    persona: { auto: 'personaTranslations', manual: 'personaManualTranslations', note: 'personaNotes' },
};

let charRenderGen = 0;              // 렌더 세대 — 늦게 도착한 응답이 덮어쓰는 것 방지
let personaRenderGen = 0;

const loadedEntities = new Set();   // "char:Sera.png"
const pendingWrites = new Map();    // entityId -> timeout id
let storageFailed = false;          // 파일 API 사용 불가
let storageWarned = false;

function entityId(kind, key) {
    return `${kind}:${key}`;
}

function isEntityLoaded(kind, key) {
    return !key || loadedEntities.has(entityId(kind, key));
}

/**
 * FNV-1a 32bit — crypto.subtle은 LAN(http) 접속에서 사용 불가라 순수 JS로 구현
 */
function fnv1a(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h = Math.imul(h ^ (c & 0xff), 0x01000193) >>> 0;
        h = Math.imul(h ^ ((c >>> 8) & 0xff), 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/**
 * 키 → 16자리 hex. 서버가 한글/공백/슬래시 파일명을 거부하므로 해시 필수.
 */
function keyHash(str) {
    const a = fnv1a(str, 0x811c9dc5);
    const b = fnv1a(`${str}\u0001peek`, 0x9e3779b1);
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

function entityFileName(kind, key) {
    return `peek_${kind === 'persona' ? 'p' : 'c'}_${keyHash(key)}.json`;
}

function reqHeaders() {
    try {
        const ctx = getContext();
        if (typeof ctx.getRequestHeaders === 'function') return ctx.getRequestHeaders();
    } catch { /* noop */ }
    return { 'Content-Type': 'application/json' };
}

/**
 * UTF-8 안전 base64 (한글/이모지 포함)
 */
function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

async function readEntityFile(fileName) {
    const res = await fetch(`${FILE_DIR}/${fileName}`, { headers: reqHeaders(), cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`읽기 실패 (${res.status})`);
    return await res.json();
}

async function writeEntityFile(fileName, payload) {
    const res = await fetch(FILE_UPLOAD_URL, {
        method: 'POST',
        headers: reqHeaders(),
        body: JSON.stringify({ name: fileName, data: toBase64(JSON.stringify(payload)) }),
    });
    if (!res.ok) throw new Error(`저장 실패 (${res.status})`);
    const json = await res.json().catch(() => null);
    return json?.path || `${FILE_DIR}/${fileName}`;
}

async function removeEntityFile(fileName) {
    const res = await fetch(FILE_DELETE_URL, {
        method: 'POST',
        headers: reqHeaders(),
        body: JSON.stringify({ path: `${FILE_DIR}/${fileName}` }),
    });
    return res.ok;
}

/**
 * 파일/레거시에서 읽은 데이터를 런타임 저장소에 반영
 */
function applyEntityData(kind, key, obj) {
    const sec = SECTIONS[kind];
    const slots = [['auto', sec.auto], ['manual', sec.manual], ['note', sec.note]];
    for (const [slot, section] of slots) {
        const val = obj?.[slot];
        if (val === undefined || val === null) delete peekData[section][key];
        else peekData[section][key] = val;
    }
}

function collectEntityData(kind, key) {
    const sec = SECTIONS[kind];
    return {
        v: 1,
        kind,
        key,
        auto: peekData[sec.auto][key] ?? null,
        manual: peekData[sec.manual][key] ?? null,
        note: peekData[sec.note][key] ?? null,
        updatedAt: Date.now(),
    };
}

function isEntityEmpty(payload) {
    return !payload.auto && !payload.manual && !payload.note;
}

/**
 * 레거시(settings) 안에 있는 이 엔티티의 데이터
 */
function legacyEntityData(kind, key) {
    const raw = extension_settings[EXT_ID] || {};
    const sec = SECTIONS[kind];
    const auto = raw[sec.auto]?.[key] ?? null;
    const manual = raw[sec.manual]?.[key] ?? null;
    const note = raw[sec.note]?.[key] ?? null;
    if (!auto && !manual && !note) return null;
    return { auto, manual, note };
}

/**
 * 엔티티 로드 — 캐시 → 파일 → 레거시
 */
async function ensureEntity(kind, key) {
    if (!key || !SECTIONS[kind]) return;
    const id = entityId(kind, key);
    if (loadedEntities.has(id)) return;

    const settings = loadSettings();
    const indexed = settings.fileIndex?.[id];
    const tombstoned = !!settings.legacyTombstones?.[id];
    let data = null;

    if (indexed?.file && !storageFailed) {
        try {
            const file = await readEntityFile(indexed.file);
            if (file && file.key === key) {
                data = file;
            } else if (file) {
                // 해시 충돌 등 — 신뢰할 수 없으니 레거시로 폴백
                console.warn('[Peek] 파일 키 불일치:', indexed.file, file.key, '≠', key);
            }
        } catch (err) {
            console.warn('[Peek] 파일 읽기 실패:', err);
        }
    }

    if (!data && !tombstoned) {
        const legacy = legacyEntityData(kind, key);
        if (legacy) {
            loadedEntities.add(id);
            applyEntityData(kind, key, legacy);
            schedulePersist(kind, key, 0);   // 파일로 이관 (레거시는 그대로 둠)
            return;
        }
    }

    loadedEntities.add(id);
    if (data) applyEntityData(kind, key, data);
}

/**
 * 저장 예약 — 타이핑 중 연타 방지
 */
function schedulePersist(kind, key, delay = 700) {
    if (!key) return;
    const id = entityId(kind, key);
    clearTimeout(pendingWrites.get(id));
    pendingWrites.set(id, setTimeout(() => {
        pendingWrites.delete(id);
        persistEntity(kind, key).catch(err => console.error('[Peek] 저장 실패:', err));
    }, delay));
}

/**
 * 실제 저장. 실패하면 레거시 모드로 강등하고 데이터는 settings에 보존
 */
async function persistEntity(kind, key) {
    if (!key || !SECTIONS[kind]) return;
    return queueEntityWrite(kind, key, () => persistEntityImmediately(kind, key));
}

async function persistEntityImmediately(kind, key) {
    loadedEntities.add(entityId(kind, key));
    if (storageFailed) {
        persistLegacy(kind, key);
        return;
    }
    try {
        await persistEntityFile(kind, key);
    } catch (err) {
        console.error('[Peek] 파일 저장 실패 — 레거시 모드로 전환:', err);
        storageFailed = true;
        loadSettings().storageMode = 'legacy';
        if (!storageWarned) {
            storageWarned = true;
            toastr.warning('파일 저장에 실패해서 기존 방식(설정 저장)으로 전환했어. 데이터는 안 날아가.', EXT_NAME);
        }
        persistLegacy(kind, key);
    }
}

async function persistEntityFile(kind, key) {
    const id = entityId(kind, key);
    const settings = loadSettings();
    const payload = collectEntityData(kind, key);
    const fileName = entityFileName(kind, key);
    if (isEntityEmpty(payload)) {
        if (settings.fileIndex?.[id]) {
            if (!await removeEntityFile(settings.fileIndex[id].file)) throw new Error('기존 파일을 지우지 못했어.');
            delete settings.fileIndex[id];
        }
        // 레거시에 같은 키가 남아있으면 다음 로드 때 되살아나므로 묘비 표시
        if (legacyEntityData(kind, key)) {
            if (!settings.legacyTombstones) settings.legacyTombstones = {};
            settings.legacyTombstones[id] = true;
        }
        saveSettingsDebounced();
        return;
    }
    await writeEntityFile(fileName, payload);
    if (!settings.fileIndex) settings.fileIndex = {};
    settings.fileIndex[id] = { file: fileName, updatedAt: payload.updatedAt };
    settings.storageMode = 'file';
    saveSettingsDebounced();
}

/**
 * 레거시 모드 — 예전처럼 settings에 직접 씀
 */
function persistLegacy(kind, key) {
    const raw = loadSettings();
    const sec = SECTIONS[kind];
    for (const section of [sec.auto, sec.manual, sec.note]) {
        if (!raw[section]) raw[section] = {};
        const val = peekData[section][key];
        if (val === undefined) delete raw[section][key];
        else raw[section][key] = val;
    }
    saveSettingsDebounced();
}

/**
 * 최근 쓴 엔티티 미리 로드 (동시 3건) — 부팅 부하 최소화
 */
async function preloadRecent(limit = 20) {
    if (storageFailed) return;
    const settings = loadSettings();
    const entries = Object.entries(settings.fileIndex || {})
        .sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0))
        .slice(0, limit);

    for (let i = 0; i < entries.length; i += 3) {
        await Promise.all(entries.slice(i, i + 3).map(([id]) => {
            const sep = id.indexOf(':');
            if (sep < 0) return Promise.resolve();
            return ensureEntity(id.slice(0, sep), id.slice(sep + 1)).catch(() => {});
        }));
    }
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

Highest-priority rule: Copy every SillyTavern macro (anything written as {{...}}) verbatim, including its name, arguments, case, punctuation, and internal whitespace. Preserve the order and repetitions of the macros. Do not translate, expand, remove, or add macros.

Rules:
- Preserve formatting, line breaks, tags, brackets, and emphasis.
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

    const fieldsToTranslate = characterTranslationTargets(char, settings.selectedFields);

    if (fieldsToTranslate.length === 0) {
        toastr.info('번역할 내용이 없어 (해당 필드들이 비어있음)', EXT_NAME);
        return;
    }

    // 확인창
    const profiles = getConnectionProfiles();
    const profile = profiles.find(p => p.id === settings.profileId);
    const profileName = profile?.name || '(알 수 없는 프로필)';

    const altCount = fieldsToTranslate.filter(field => field.key.startsWith(ALT_KEY_PREFIX)).length;
    const fieldList = fieldsToTranslate.filter(field => field.desc).map(field => `• ${field.label} (${field.desc})`);
    if (altCount) fieldList.push(`• ALT 그리팅 ${altCount}개`);
    const charName = char.name || '이 캐릭터';
    const profileId = settings.profileId;

    const confirmed = await Popup.show.confirm(
        '번역 확인',
        `<div style="text-align:left;">
            <p><b>${escapeHtml(charName)}</b>의 다음 필드를 <b>${escapeHtml(profileName)}</b>으로 번역할까?</p>
            <pre style="white-space:pre-wrap;font-size:0.9em;opacity:0.85;margin:8px 0;">${fieldList.join('\n')}</pre>
            <p style="font-size:0.85em;opacity:0.7;">기존 번역이 있으면 덮어쓸거야.</p>
        </div>`
    );

    if (!confirmed) return;

    // 번역 실행
    const panel = document.getElementById('peek_translation_panel');
    if (panel) panel.classList.add('peek-loading');

    const translatedFields = {};

    let success = 0;
    let failed = 0;

    for (const field of fieldsToTranslate) {
        try {
            updateLoadingMessage(`${field.label} 번역 중...`);
            const translated = await translateWithProfile(
                profileId,
                field.label,
                String(field.source)
            );
            translatedFields[field.key] = {
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

    try {
        if (success) {
            await queueEntityWrite('char', charKey, async () => {
                await ensureEntity('char', charKey);
                peekData.translations[charKey] = { ...peekData.translations[charKey], ...translatedFields };
                await persistEntityImmediately('char', charKey);
            });
        }
    } catch (err) {
        toastr.error(`번역 저장 실패: ${err.message}`, EXT_NAME);
        return;
    } finally {
        if (panel) panel.classList.remove('peek-loading');
        renderTranslationPanel();
    }

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

/* ========== 공통: 작은 메모 패널 ========== */

/**
 * HTML escape용 (text → attribute 안전)
 */
function escapeAttr(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 작은 메모 패널 생성.
 *
 * 저장 정책 - 단순함이 안전함:
 * - input 시: 메모리에 쓰고 saveSettingsDebounced() 한 번 호출 끝
 * - 저장 버튼: 메모리에 쓰고 saveSettingsDebounced() 호출 + ✓ 표시
 * - 그 외 어떤 강제 저장/flush/race 회피 로직도 없음
 *
 * @param {object} opts
 * @param {string} opts.id - 패널 DOM id
 * @param {string} opts.titleText - 헤더 제목
 * @param {string} opts.placeholder - textarea placeholder
 * @param {string} opts.collapsedKey - 접힘 상태 저장 키
 * @param {function(string, string): void} opts.writeToMemory - (value, dataKey) → settings 객체에 쓰기
 * @param {function(): string|null} opts.getDataKey - 현재 활성 dataKey 반환
 * @returns {HTMLElement}
 */
function createMemoPanel({ id, titleText, placeholder, collapsedKey, writeToMemory, getDataKey, persistKind }) {
    const panel = document.createElement('div');
    panel.id = id;
    panel.className = 'peek-small-panel';
    panel.innerHTML = `
        <div class="peek-small-header">
            <span class="peek-small-title">${titleText}</span>
            <span class="peek-small-meta"></span>
            <button class="peek-save-btn" type="button" title="저장">💾</button>
            <span class="peek-toggle-icon">▼</span>
        </div>
        <div class="peek-small-body">
            <textarea class="peek-small-textarea" placeholder="${escapeAttr(placeholder)}" rows="3"></textarea>
        </div>
    `;

    const header = panel.querySelector('.peek-small-header');
    const textarea = panel.querySelector('.peek-small-textarea');
    const saveBtn = panel.querySelector('.peek-save-btn');

    // 접기/펼치기 (저장 버튼 클릭 시 무시)
    header.addEventListener('click', (e) => {
        if (e.target.closest('.peek-save-btn')) return;
        const settings = loadSettings();
        settings[collapsedKey] = !settings[collapsedKey];
        saveSettingsDebounced();
        applyCollapsedState(panel, settings[collapsedKey]);
    });

    // input: 메모리 + 자동 저장 + dirty 표시
    textarea.addEventListener('input', () => {
        const key = getDataKey();
        if (!key) return;
        writeToMemory(textarea.value, key);
        schedulePersist(persistKind, key);
        panel.classList.add('peek-dirty');
    });

    // 저장 버튼: 명시적 저장 + ✓ 표시
    saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = getDataKey();
        if (!key) return;
        writeToMemory(textarea.value, key);
        schedulePersist(persistKind, key, 0);
        panel.classList.remove('peek-dirty');
        const orig = saveBtn.textContent;
        saveBtn.textContent = '✓';
        saveBtn.classList.add('peek-saved-flash');
        setTimeout(() => {
            saveBtn.textContent = orig;
            saveBtn.classList.remove('peek-saved-flash');
        }, 1200);
    });

    return panel;
}

/**
 * 패널 접힘 상태 적용
 */
function applyCollapsedState(panel, isCollapsed) {
    if (isCollapsed) panel.classList.add('peek-collapsed');
    else panel.classList.remove('peek-collapsed');
}

/**
 * 작은 패널 textarea/메타 업데이트 (캐릭터 키 바뀔 때만 textarea 새로 채움).
 * 같은 키에서 재호출되면 textarea는 안 건드림 — 입력 중 덮어쓰기 방지.
 * (이건 race 만들지 않는 단순 비교라 안전함)
 */
function updateMemoPanel(panel, dataKey, value, updatedAt, isCollapsed) {
    if (!panel) return;
    const textarea = panel.querySelector('.peek-small-textarea');
    const meta = panel.querySelector('.peek-small-meta');

    if (textarea) {
        const currentKey = textarea.dataset.peekKey;
        if (currentKey !== dataKey) {
            textarea.value = value || '';
            textarea.dataset.peekKey = dataKey || '';
            // 키가 바뀌었으니 dirty 해제
            panel.classList.remove('peek-dirty');
        }
    }

    if (meta) {
        if (value && updatedAt) {
            meta.textContent = `· ${new Date(updatedAt).toLocaleString()}`;
        } else {
            meta.textContent = '';
        }
    }

    applyCollapsedState(panel, isCollapsed);
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
        peekData.personaTranslations[persona.avatar] = {
            text: translated,
            translatedAt: Date.now(),
        };
        await persistEntity('persona', persona.avatar);
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

    // 페르소나 컨트롤 영역이 안 보이면 패널도 숨김
    const personaControls = document.getElementById('persona_controls');
    if (!personaControls || !persona) {
        if (panel) panel.style.display = 'none';
        const np = document.getElementById('peek_persona_notes_panel');
        if (np) np.style.display = 'none';
        return;
    }

    if (!panel) {
        panel = createPersonaPanelElement();
        if (personaControls.nextSibling) {
            personaControls.parentNode.insertBefore(panel, personaControls.nextSibling);
        } else {
            personaControls.parentNode.appendChild(panel);
        }
    }

    // 페르소나 컨트롤 영역의 👀 단축 버튼 보장 (Observer 제거됐으니 여기서 매번 체크)
    injectPersonaQuickButton();

    panel.style.display = '';

    if (!isEntityLoaded('persona', persona.avatar)) {
        const gen = ++personaRenderGen;
        const avatar = persona.avatar;
        panel.classList.add('peek-loading');
        ensureEntity('persona', avatar).finally(() => {
            if (gen !== personaRenderGen) return;
            if (getCurrentPersona()?.avatar !== avatar) return;
            panel.classList.remove('peek-loading');
            renderPersonaPanel();
        });
        return;
    }
    panel.classList.remove('peek-loading');

    const tr = peekData.personaTranslations[persona.avatar];
    const hasAuto = tr && tr.text;
    const manual = peekData.personaManualTranslations[persona.avatar];
    const hasManual = manual && manual.text && manual.text.trim();

    let activeTab = settings.personaActiveTab || 'auto';
    if (!hasAuto && hasManual && (!settings.personaActiveTab || settings.personaActiveTab === 'auto')) {
        activeTab = 'manual';
    }

    // 탭 활성/데이터 표시
    panel.querySelectorAll('.peek-tabs .peek-tab').forEach(t => {
        if (t.dataset.tab === activeTab) t.classList.add('peek-tab-active');
        else t.classList.remove('peek-tab-active');
        const has = t.dataset.tab === 'auto' ? hasAuto : hasManual;
        if (has) t.classList.add('peek-tab-hasdata');
        else t.classList.remove('peek-tab-hasdata');
    });

    // 접힘
    if (settings.personaPanelCollapsed) panel.classList.add('peek-collapsed');
    else panel.classList.remove('peek-collapsed');

    // 탭 전환
    const autoContent = panel.querySelector('.peek-tab-auto');
    const manualContent = panel.querySelector('.peek-tab-manual');
    if (activeTab === 'auto') {
        autoContent.style.display = '';
        manualContent.style.display = 'none';
    } else {
        autoContent.style.display = 'none';
        manualContent.style.display = '';
    }

    // 헤더 메타
    const titleMeta = panel.querySelector('.peek-title-meta');
    if (titleMeta) {
        if (activeTab === 'auto') {
            titleMeta.textContent = hasAuto ? '(번역됨)' : '';
        } else {
            titleMeta.textContent = manual?.updatedAt ? `· 수정: ${new Date(manual.updatedAt).toLocaleString()}` : '';
        }
    }

    // 자동 본문
    if (!hasAuto) {
        autoContent.innerHTML = `<div class="peek-empty">아직 자동 번역이 없어.<br>👀 버튼을 눌러서 번역해봐</div>`;
    } else {
        autoContent.innerHTML = `
            <div class="peek-field-block">
                <div class="peek-field-content">${escapeHtml(tr.text)}</div>
                <button class="peek-copy-btn" type="button" title="복사"><i class="fa-solid fa-copy"></i></button>
            </div>
        `;
        bindAutoFieldEditor(autoContent.querySelector('.peek-field-block'), 'persona', persona.avatar, null, tr);
        const copyBtn = autoContent.querySelector('.peek-copy-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                copyTextWithFeedback(tr.text, copyBtn);
            });
        }
    }

    // 수동 textarea - 페르소나 키 바뀐 경우만 갱신
    const manualTextarea = panel.querySelector('.peek-manual-textarea');
    if (manualTextarea) {
        const currentKey = manualTextarea.dataset.peekKey;
        if (currentKey !== persona.avatar) {
            manualTextarea.value = manual?.text || '';
            manualTextarea.dataset.peekKey = persona.avatar;
            panel.classList.remove('peek-dirty');
        }
    }

    // 푸터
    const footerTime = panel.querySelector('.peek-footer-time');
    if (footerTime) {
        if (activeTab === 'auto' && hasAuto) {
            footerTime.textContent = `마지막 자동 번역: ${new Date(tr.translatedAt).toLocaleString()}`;
        } else if (activeTab === 'manual' && manual?.updatedAt) {
            footerTime.textContent = `마지막 수정: ${new Date(manual.updatedAt).toLocaleString()}`;
        } else {
            footerTime.textContent = '';
        }
    }

    renderUndoControl(panel, 'persona', persona.avatar);

    // 메모 패널
    renderPersonaNotesPanel(panel, persona.avatar);
}

/**
 * 페르소나 메모 패널 렌더링
 */
function renderPersonaNotesPanel(translationPanel, personaAvatar) {
    const settings = loadSettings();

    let notesPanel = document.getElementById('peek_persona_notes_panel');
    if (!notesPanel) {
        notesPanel = createMemoPanel({
            id: 'peek_persona_notes_panel',
            titleText: '📝 메모',
            placeholder: '페르소나 변경 내역, 자유 노트 등.',
            collapsedKey: 'personaNotesPanelCollapsed',
            persistKind: 'persona',
            getDataKey: () => getCurrentPersona()?.avatar || null,
            writeToMemory: (val, key) => {
                const s = loadSettings();
                if (val.trim()) {
                    peekData.personaNotes[key] = { text: val, updatedAt: Date.now() };
                } else {
                    delete peekData.personaNotes[key];
                }
            },
        });
        translationPanel.parentNode.insertBefore(notesPanel, translationPanel.nextSibling);
    }

    notesPanel.style.display = '';
    const note = peekData.personaNotes[personaAvatar];
    updateMemoPanel(
        notesPanel,
        personaAvatar,
        note?.text || '',
        note?.updatedAt,
        settings.personaNotesPanelCollapsed
    );
}

/**
 * 페르소나 패널 DOM 요소 생성 - 탭 구조
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
            <div class="peek-tabs">
                <button class="peek-tab" data-tab="auto" type="button">자동</button>
                <button class="peek-tab" data-tab="manual" type="button">수동</button>
            </div>
            <span class="peek-toggle-icon">▼</span>
        </div>
        <div class="peek-panel-body">
            <div class="peek-tab-content peek-tab-auto"></div>
            <div class="peek-tab-content peek-tab-manual" style="display:none;">
                <div class="peek-manual-textarea-wrap">
                    <textarea class="peek-manual-textarea" placeholder="외부에서 번역해온 페르소나 설명을 여기 붙여넣어. 자동 저장돼."></textarea>
                    <button class="peek-copy-btn peek-manual-copy-btn" type="button" title="복사"><i class="fa-solid fa-copy"></i></button>
                </div>
                <div class="peek-manual-actions">
                    <button class="peek-save-btn-large" type="button">💾 저장</button>
                </div>
            </div>
        </div>
        <div class="peek-loading-indicator">번역 중...</div>
        <div class="peek-panel-footer">
            <span class="peek-footer-time"></span>
            <div class="peek-footer-actions">
                <span class="peek-footer-btn" data-action="clear-persona" title="현재 탭 데이터 삭제">🗑 지우기</span>
            </div>
        </div>
    `;

    // 헤더 클릭 → 접기/펼치기 (탭 영역 무시)
    panel.querySelector('.peek-panel-header').addEventListener('click', (e) => {
        if (e.target.closest('.peek-tab') || e.target.closest('.peek-tabs')) return;
        const settings = loadSettings();
        settings.personaPanelCollapsed = !settings.personaPanelCollapsed;
        saveSettingsDebounced();
        renderPersonaPanel();
    });

    // 탭 클릭
    panel.querySelectorAll('.peek-tabs .peek-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.stopPropagation();
            const settings = loadSettings();
            settings.personaActiveTab = tab.dataset.tab;
            settings.personaPanelCollapsed = false;
            saveSettingsDebounced();
            renderPersonaPanel();
        });
    });

    // 수동 textarea + 저장 버튼
    const manualTextarea = panel.querySelector('.peek-manual-textarea');
    const manualSaveBtn = panel.querySelector('.peek-save-btn-large');
    const manualCopyBtn = panel.querySelector('.peek-manual-copy-btn');
    if (manualCopyBtn && manualTextarea) {
        manualCopyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            copyTextWithFeedback(manualTextarea.value, manualCopyBtn);
        });
    }
    if (manualTextarea) {
        const writeManual = () => {
            const persona = getCurrentPersona();
            if (!persona) return;
            const settings = loadSettings();
            const val = manualTextarea.value;
            if (val.trim()) {
                peekData.personaManualTranslations[persona.avatar] = { text: val, updatedAt: Date.now() };
            } else {
                delete peekData.personaManualTranslations[persona.avatar];
            }
        };
        manualTextarea.addEventListener('input', () => {
            writeManual();
            schedulePersist('persona', persona?.avatar);
            panel.classList.add('peek-dirty');
        });
        if (manualSaveBtn) {
            manualSaveBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                writeManual();
                schedulePersist('persona', persona?.avatar, 0);
                panel.classList.remove('peek-dirty');
                const orig = manualSaveBtn.textContent;
                manualSaveBtn.textContent = '✓ 저장됨';
                manualSaveBtn.classList.add('peek-saved-flash');
                setTimeout(() => {
                    manualSaveBtn.textContent = orig;
                    manualSaveBtn.classList.remove('peek-saved-flash');
                }, 1200);
            });
        }
    }

    // 지우기 버튼 - 활성 탭 데이터만
    panel.querySelector('[data-action="clear-persona"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        const persona = getCurrentPersona();
        if (!persona) return;
        const settings = loadSettings();
        const tab = settings.personaActiveTab || 'auto';
        const tabName = tab === 'auto' ? '자동 번역' : '수동 번역';
        const confirmed = await Popup.show.confirm(
            '삭제 확인',
            `이 페르소나의 <b>${tabName}</b>을 지울까?`
        );
        if (!confirmed) return;
        if (tab === 'auto') {
            clearAutoDrafts('persona', persona.avatar);
            delete peekData.personaTranslations[persona.avatar];
        } else {
            delete peekData.personaManualTranslations[persona.avatar];
            const ta = panel.querySelector('.peek-manual-textarea');
            if (ta) {
                ta.value = '';
                ta.dataset.peekKey = persona.avatar;
            }
        }
        await persistEntity('persona', persona.avatar);
        renderPersonaPanel();
        toastr.info(`${tabName} 삭제됨`, EXT_NAME);
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
    if (buttonsBlock.querySelector('#peek_persona_quick_btn')) {
        injectSearchButton(buttonsBlock.querySelector('#peek_persona_quick_btn'), 'persona');
        return;
    }

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
    injectSearchButton(btn, 'persona');
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
    const greetingPanel = document.getElementById('peek_greeting_panel');

    // 캐릭터 없으면 패널 숨김
    if (!char || !charKey) {
        if (panel) panel.style.display = 'none';
        if (greetingPanel) greetingPanel.hidden = true;
        const notesPanel = document.getElementById('peek_notes_panel');
        if (notesPanel) notesPanel.style.display = 'none';
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

    // 파일에서 아직 안 읽어온 캐릭터면 로딩 표시 후 비동기 로드
    if (!isEntityLoaded('char', charKey)) {
        if (greetingPanel) greetingPanel.hidden = true;
        const gen = ++charRenderGen;
        panel.classList.add('peek-loading');
        updateLoadingMessage('불러오는 중...');
        ensureEntity('char', charKey).finally(() => {
            if (gen !== charRenderGen) return;              // 더 최신 렌더가 있음
            if (getCurrentCharKey() !== charKey) return;    // 그새 캐릭터 바뀜
            panel.classList.remove('peek-loading');
            renderTranslationPanel();
        });
        return;
    }
    panel.classList.remove('peek-loading');

    const charTranslations = peekData.translations[charKey] || {};
    const hasAuto = Object.keys(charTranslations).length > 0;
    const manual = peekData.manualTranslations[charKey];
    const hasManual = manual && manual.text && manual.text.trim();

    // 활성 탭 결정
    let activeTab = settings.activeTab || 'auto';
    if (!hasAuto && hasManual && (!settings.activeTab || settings.activeTab === 'auto')) {
        activeTab = 'manual';
    }

    // 탭 버튼 활성/데이터 표시
    panel.querySelectorAll('.peek-tabs .peek-tab').forEach(t => {
        if (t.dataset.tab === activeTab) t.classList.add('peek-tab-active');
        else t.classList.remove('peek-tab-active');
        const has = t.dataset.tab === 'auto' ? hasAuto : hasManual;
        if (has) t.classList.add('peek-tab-hasdata');
        else t.classList.remove('peek-tab-hasdata');
    });

    // 접힘 상태
    if (settings.panelCollapsed) panel.classList.add('peek-collapsed');
    else panel.classList.remove('peek-collapsed');

    // 탭 콘텐츠 표시 전환
    const autoContent = panel.querySelector('.peek-tab-auto');
    const manualContent = panel.querySelector('.peek-tab-manual');
    if (activeTab === 'auto') {
        autoContent.style.display = '';
        manualContent.style.display = 'none';
    } else {
        autoContent.style.display = 'none';
        manualContent.style.display = '';
    }

    // 헤더 메타
    const titleMeta = panel.querySelector('.peek-title-meta');
    if (titleMeta) {
        if (activeTab === 'auto') {
            titleMeta.textContent = hasAuto ? `(${Object.keys(charTranslations).length}개 필드)` : '';
        } else {
            titleMeta.textContent = manual?.updatedAt ? `· 수정: ${new Date(manual.updatedAt).toLocaleString()}` : '';
        }
    }

    // ALT 번역이 있으면 기본 그리팅도 별도 카드에 표시한다.
    const greetings = savedAltGreetings(charTranslations);
    if (!hasAuto) {
        autoContent.innerHTML = `<div class="peek-empty">아직 자동 번역이 없어.<br>캐릭터 설명 옆 👀 버튼을 눌러서 번역해봐</div>`;
    } else {
        autoContent.replaceChildren();
        for (const field of TRANSLATABLE_FIELDS) {
            if (field.key === 'first_mes' && greetings.length) continue;
            const translation = charTranslations[field.key];
            if (translation?.text) {
                autoContent.append(createCharacterTranslationBlock(charKey, field.key, `${field.label} · ${field.desc}`, translation));
            }
        }
    }
    if (!greetings.length) greetingPanel?.remove();
    else if (activeTab !== 'auto') {
        if (greetingPanel) greetingPanel.hidden = true;
    } else {
        if (charTranslations.first_mes?.text) greetings.unshift({ key: 'first_mes', label: '기본' });
        const sameCharacter = greetingPanel?.dataset.peekKey === charKey;
        const priorIndex = greetingPanel?.querySelector('.peek-greeting-index');
        const selected = sameCharacter ? priorIndex?.querySelector('[aria-pressed="true"]')?.dataset.field : undefined;
        const scrollLeft = sameCharacter ? priorIndex?.scrollLeft ?? 0 : 0;
        const card = createGreetingIndex(charKey, charTranslations, greetings, selected, scrollLeft);
        greetingPanel?.remove();
        panel.after(card);
    }

    // 수동 탭 textarea - 캐릭터 키 바뀐 경우만 value 갱신
    const manualTextarea = panel.querySelector('.peek-manual-textarea');
    if (manualTextarea) {
        const currentKey = manualTextarea.dataset.peekKey;
        if (currentKey !== charKey) {
            manualTextarea.value = manual?.text || '';
            manualTextarea.dataset.peekKey = charKey;
            panel.classList.remove('peek-dirty');
        }
    }

    // 푸터
    const footer = panel.querySelector('.peek-footer-time');
    if (footer) {
        if (activeTab === 'auto' && hasAuto) {
            const latest = Object.values(charTranslations).reduce((time, item) => Math.max(time, item?.translatedAt || 0), 0);
            footer.textContent = latest > 0 ? `마지막 자동 번역: ${new Date(latest).toLocaleString()}` : '';
        } else if (activeTab === 'manual' && manual?.updatedAt) {
            footer.textContent = `마지막 수정: ${new Date(manual.updatedAt).toLocaleString()}`;
        } else {
            footer.textContent = '';
        }
    }

    renderUndoControl(panel, 'char', charKey);

    // 메모 패널도 같이 렌더
    renderCharNotesPanel(panel, charKey);
}

function createCharacterTranslationBlock(charKey, field, label, translation) {
    const block = document.createElement('div');
    block.className = 'peek-field-block';
    block.innerHTML = `
        <div class="peek-field-label">${escapeHtml(label)}</div>
        <div class="peek-field-content">${escapeHtml(translation.text)}</div>
        <button class="peek-copy-btn" type="button" title="복사" aria-label="복사"><i class="fa-solid fa-copy"></i></button>
    `;
    const copy = block.querySelector('.peek-copy-btn');
    copy.addEventListener('click', event => {
        event.stopPropagation();
        copyTextWithFeedback(translation.text, copy);
    });
    bindAutoFieldEditor(block, 'char', charKey, field, translation);
    return block;
}

function createGreetingIndex(charKey, translations, greetings, selected, scrollLeft) {
    const section = document.createElement('section');
    section.id = 'peek_greeting_panel';
    section.dataset.peekKey = charKey;
    section.setAttribute('aria-label', 'First Message');
    section.innerHTML = `
        <div class="peek-greeting-heading"><strong class="peek-field-label">First Message</strong><span aria-live="polite"></span></div>
        <div class="peek-greeting-navigation">
            <button type="button" class="peek-tab peek-greeting-previous" aria-label="앞 번호 보기">‹</button>
            <div class="peek-greeting-index" role="group" aria-label="그리팅 번호"></div>
            <button type="button" class="peek-tab peek-greeting-next" aria-label="뒤 번호 보기">›</button>
        </div>
        <div class="peek-greeting-body"></div>
    `;
    const index = section.querySelector('.peek-greeting-index');
    const position = section.querySelector('.peek-greeting-heading span');
    const body = section.querySelector('.peek-greeting-body');
    const previous = section.querySelector('.peek-greeting-previous');
    const next = section.querySelector('.peek-greeting-next');

    const buttons = greetings.map(({ key, label }, number) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'peek-tab';
        button.dataset.field = key;
        button.textContent = label;
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => select(number));
        index.append(button);
        return button;
    });
    let active;
    function select(number) {
        active?.classList.remove('peek-tab-active');
        active?.setAttribute('aria-pressed', 'false');
        active = buttons[number];
        active.classList.add('peek-tab-active');
        active.setAttribute('aria-pressed', 'true');
        const { key, label } = greetings[number];
        position.textContent = `${number + 1} / ${greetings.length}`;
        body.replaceChildren(createCharacterTranslationBlock(charKey, key, label, translations[key]));
    }

    select(Math.max(0, greetings.findIndex(greeting => greeting.key === selected)));
    previous.addEventListener('click', () => index.scrollBy({ left: -index.clientWidth * 0.8, behavior: 'smooth' }));
    next.addEventListener('click', () => index.scrollBy({ left: index.clientWidth * 0.8, behavior: 'smooth' }));
    const updateArrows = () => {
        const maxScroll = index.scrollWidth - index.clientWidth;
        previous.disabled = index.scrollLeft <= 1;
        next.disabled = index.scrollLeft >= maxScroll - 1;
    };
    index.addEventListener('scroll', updateArrows, { passive: true });
    requestAnimationFrame(() => {
        if (!section.isConnected) return;
        index.scrollLeft = scrollLeft;
        const viewport = index.getBoundingClientRect();
        const selection = active.getBoundingClientRect();
        if (selection.left < viewport.left || selection.right > viewport.right) {
            index.scrollLeft += selection.left - viewport.left;
        }
        updateArrows();
    });
    // Check overflow on demand after switching tabs or resizing the card panel.
    section.addEventListener('pointerenter', updateArrows);
    section.addEventListener('focusin', updateArrows);
    return section;
}

/**
 * 캐릭터 패널 아래에 메모 패널 렌더링
 */
function renderCharNotesPanel(translationPanel, charKey) {
    const settings = loadSettings();

    let notesPanel = document.getElementById('peek_notes_panel');
    if (!notesPanel) {
        notesPanel = createMemoPanel({
            id: 'peek_notes_panel',
            titleText: '📝 메모',
            placeholder: '캐릭터 시트 변경 내역, 자유 노트 등.',
            collapsedKey: 'notesPanelCollapsed',
            persistKind: 'char',
            getDataKey: () => getCurrentCharKey(),
            writeToMemory: (val, key) => {
                const s = loadSettings();
                if (val.trim()) {
                    peekData.notes[key] = { text: val, updatedAt: Date.now() };
                } else {
                    delete peekData.notes[key];
                }
            },
        });
        const previousPanel = document.getElementById('peek_greeting_panel') || translationPanel;
        previousPanel.after(notesPanel);
    }

    notesPanel.style.display = '';
    const note = peekData.notes[charKey];
    updateMemoPanel(
        notesPanel,
        charKey,
        note?.text || '',
        note?.updatedAt,
        settings.notesPanelCollapsed
    );
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
            <div class="peek-tabs">
                <button class="peek-tab" data-tab="auto" type="button">자동</button>
                <button class="peek-tab" data-tab="manual" type="button">수동</button>
            </div>
            <span class="peek-toggle-icon">▼</span>
        </div>
        <div class="peek-panel-body">
            <div class="peek-tab-content peek-tab-auto"></div>
            <div class="peek-tab-content peek-tab-manual" style="display:none;">
                <div class="peek-manual-textarea-wrap">
                    <textarea class="peek-manual-textarea" placeholder="외부에서 번역해온 내용을 여기 붙여넣어. 자동 저장돼."></textarea>
                    <button class="peek-copy-btn peek-manual-copy-btn" type="button" title="복사"><i class="fa-solid fa-copy"></i></button>
                </div>
                <div class="peek-manual-actions">
                    <button class="peek-save-btn-large" type="button">💾 저장</button>
                </div>
            </div>
        </div>
        <div class="peek-loading-indicator">번역 중...</div>
        <div class="peek-panel-footer">
            <span class="peek-footer-time"></span>
            <div class="peek-footer-actions">
                <span class="peek-footer-btn" data-action="clear" title="현재 탭 데이터 삭제">🗑 지우기</span>
            </div>
        </div>
    `;

    // 헤더 클릭 → 접기/펼치기 (탭 영역 클릭은 무시)
    panel.querySelector('.peek-panel-header').addEventListener('click', (e) => {
        if (e.target.closest('.peek-tab') || e.target.closest('.peek-tabs')) return;
        const settings = loadSettings();
        settings.panelCollapsed = !settings.panelCollapsed;
        saveSettingsDebounced();
        renderTranslationPanel();
    });

    // 탭 클릭
    panel.querySelectorAll('.peek-tabs .peek-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.stopPropagation();
            const settings = loadSettings();
            settings.activeTab = tab.dataset.tab;
            settings.panelCollapsed = false;
            saveSettingsDebounced();
            renderTranslationPanel();
        });
    });

    // 수동 번역 textarea - input 시 자동 저장
    const manualTextarea = panel.querySelector('.peek-manual-textarea');
    const manualSaveBtn = panel.querySelector('.peek-save-btn-large');
    const manualCopyBtn = panel.querySelector('.peek-manual-copy-btn');
    if (manualCopyBtn && manualTextarea) {
        manualCopyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            copyTextWithFeedback(manualTextarea.value, manualCopyBtn);
        });
    }
    if (manualTextarea) {
        const writeManual = () => {
            const charKey = getCurrentCharKey();
            if (!charKey) return;
            const settings = loadSettings();
            const val = manualTextarea.value;
            if (val.trim()) {
                peekData.manualTranslations[charKey] = { text: val, updatedAt: Date.now() };
            } else {
                delete peekData.manualTranslations[charKey];
            }
        };
        manualTextarea.addEventListener('input', () => {
            writeManual();
            schedulePersist('char', getCurrentCharKey());
            panel.classList.add('peek-dirty');
        });
        if (manualSaveBtn) {
            manualSaveBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                writeManual();
                schedulePersist('char', getCurrentCharKey(), 0);
                panel.classList.remove('peek-dirty');
                const orig = manualSaveBtn.textContent;
                manualSaveBtn.textContent = '✓ 저장됨';
                manualSaveBtn.classList.add('peek-saved-flash');
                setTimeout(() => {
                    manualSaveBtn.textContent = orig;
                    manualSaveBtn.classList.remove('peek-saved-flash');
                }, 1200);
            });
        }
    }

    // 지우기 버튼 - 현재 활성 탭 데이터만 삭제
    panel.querySelector('[data-action="clear"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        const charKey = getCurrentCharKey();
        if (!charKey) return;
        const settings = loadSettings();
        const tab = settings.activeTab || 'auto';
        const tabName = tab === 'auto' ? '자동 번역' : '수동 번역';
        const confirmed = await Popup.show.confirm(
            '삭제 확인',
            `이 캐릭터의 <b>${tabName}</b>을 지울까?`
        );
        if (!confirmed) return;
        if (tab === 'auto') {
            clearAutoDrafts('char', charKey);
            delete peekData.translations[charKey];
        } else {
            delete peekData.manualTranslations[charKey];
            const ta = panel.querySelector('.peek-manual-textarea');
            if (ta) {
                ta.value = '';
                ta.dataset.peekKey = charKey;
            }
        }
        await persistEntity('char', charKey);
        renderTranslationPanel();
        toastr.info(`${tabName} 삭제됨`, EXT_NAME);
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
    if (descDiv.querySelector('#peek_quick_btn')) {
        injectSearchButton(descDiv.querySelector('#peek_quick_btn'), 'char');
        return;
    }

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
    injectSearchButton(btn, 'char');
}

/* 저장된 자동번역 검색 — 검색 본문/편집 초안은 settings에 저장하지 않음. */
function savedEntityName(kind, key) {
    return kind === 'char'
        ? characters.find(c => c?.avatar === key)?.name || key
        : power_user?.personas?.[key] || key;
}

function currentEntityKey(kind) {
    return kind === 'char' ? getCurrentCharKey() : getCurrentPersona()?.avatar;
}

function renderEntityPanel(kind) {
    if (kind === 'char') renderTranslationPanel();
    else renderPersonaPanel();
}

function showAutoTab(kind) {
    const settings = loadSettings();
    settings[kind === 'char' ? 'activeTab' : 'personaActiveTab'] = 'auto';
    settings[kind === 'char' ? 'panelCollapsed' : 'personaPanelCollapsed'] = false;
    saveSettingsDebounced();
    renderEntityPanel(kind);
}

async function savedAutoEntries(kind) {
    const entries = [];
    let failed = 0;
    const ids = allEntityIds().filter(id => id.startsWith(`${kind}:`));
    for (let i = 0; i < ids.length; i += 4) {
        await Promise.all(ids.slice(i, i + 4).map(async id => {
            const key = id.slice(kind.length + 1);
            let auto;
            if (loadedEntities.has(id)) {
                auto = peekData[SECTIONS[kind].auto][key];
            } else {
                const indexed = loadSettings().fileIndex?.[id];
                if (indexed?.file && !storageFailed) {
                    try {
                        const data = await readEntityFile(indexed.file);
                        if (!data || data.key !== key || data.kind !== kind) throw new Error('파일 정보 불일치');
                        auto = data.auto;
                    } catch (err) {
                        failed++;
                        console.warn('[Peek] 검색 중 파일 읽기 실패:', indexed.file, err);
                        return;
                    }
                } else if (!loadSettings().legacyTombstones?.[id]) {
                    auto = legacyEntityData(kind, key)?.auto;
                }
            }
            const records = kind === 'char'
                ? [...TRANSLATABLE_FIELDS, ...savedAltGreetings(auto)]
                    .filter(field => auto?.[field.key]?.text).map(field => [field.label, auto[field.key].text])
                : auto?.text ? [['Persona Description', auto.text]] : [];
            if (records.length) entries.push({ key, name: savedEntityName(kind, key), auto: structuredClone(auto), records });
        }));
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { entries, failed };
}

async function openTranslationSearch(kind) {
    const targetKey = currentEntityKey(kind);
    if (!targetKey) {
        toastr.warning('먼저 캐릭터나 페르소나를 선택해줘.', EXT_NAME);
        return;
    }
    const root = document.createElement('div');
    root.className = 'peek-search';
    root.innerHTML = `
        <h3>저장된 ${kind === 'char' ? '캐릭터' : '페르소나'} 번역 불러오기</h3>
        <p class="peek-search-target"></p>
        <input class="text_pole peek-search-input" type="text" inputmode="search" aria-label="저장된 번역 검색" placeholder="이름 · 파일명 · 번역 내용 검색" disabled>
        <p class="peek-search-status" role="status" aria-live="polite">저장된 번역을 읽는 중...</p>
        <div class="peek-search-results"></div>
        <div class="peek-search-preview" hidden></div>
        <div class="peek-search-actions"><button type="button" class="peek-action-btn peek-search-load" disabled>불러오기</button></div>`;
    root.querySelector('.peek-search-target').textContent = `불러올 대상: ${savedEntityName(kind, targetKey)}`;
    const popup = new Popup(root, POPUP_TYPE.TEXT, null, { okButton: '닫기', wide: true });
    const closed = popup.show();
    let disposed = false;
    closed.then(() => { disposed = true; });
    const input = root.querySelector('.peek-search-input');
    const list = root.querySelector('.peek-search-results');
    const preview = root.querySelector('.peek-search-preview');
    const load = root.querySelector('.peek-search-load');
    const status = root.querySelector('.peek-search-status');
    let selected = null;
    try {
        const { entries, failed } = await savedAutoEntries(kind);
        if (disposed) return;
        const update = () => {
            selected = null;
            load.disabled = true;
            preview.hidden = true;
            preview.replaceChildren();
            list.replaceChildren();
            const query = input.value.trim().toLocaleLowerCase();
            const matches = entries.filter(entry => [entry.name, entry.key, ...entry.records.flat()].join('\n').toLocaleLowerCase().includes(query));
            status.textContent = `${matches.length}개 결과${failed ? ` · ${failed}개 파일을 읽지 못했어. 닫았다가 다시 시도해줘.` : ''}`;
            if (!matches.length) {
                list.textContent = entries.length ? '검색 결과가 없어.' : '저장된 자동번역이 없어.';
            }
            for (const entry of matches) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'peek-search-result';
                button.setAttribute('aria-pressed', 'false');
                const title = document.createElement('strong');
                title.textContent = entry.name;
                const snippet = document.createElement('span');
                snippet.textContent = `${entry.key} · ${entry.records.map(r => r[1]).join(' ').slice(0, 120)}`;
                button.append(title, snippet);
                button.addEventListener('click', () => {
                    selected = entry;
                    list.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
                    preview.replaceChildren();
                    for (const [label, text] of entry.records) {
                        const heading = document.createElement('h4');
                        heading.textContent = label;
                        const content = document.createElement('div');
                        content.textContent = text;
                        preview.append(heading, content);
                    }
                    preview.hidden = false;
                    load.disabled = false;
                });
                list.append(button);
            }
        };
        input.disabled = false;
        input.addEventListener('input', update);
        update();
        input.focus();
        load.addEventListener('click', async () => {
            if (!selected || load.disabled) return;
            load.disabled = true;
            try {
                if (currentEntityKey(kind) !== targetKey) {
                    toastr.warning('선택 대상이 바뀌었어. 검색창을 다시 열어줘.', EXT_NAME);
                    return;
                }
                await ensureEntity(kind, targetKey);
                const section = SECTIONS[kind].auto;
                const existing = peekData[section][targetKey];
                if (existing && (kind === 'persona' ? existing.text : Object.keys(existing).length)) {
                    const ok = await Popup.show.confirm('자동번역 덮어쓰기', '현재 대상의 자동번역을 선택한 결과로 바꿀까? 직전 내용은 되돌리기로 복원할 수 있어. 수동번역과 메모는 유지돼.');
                    if (!ok) return;
                }
                if (disposed || currentEntityKey(kind) !== targetKey) return;
                await replaceAutoWithUndo(kind, targetKey, selected.auto);
                showAutoTab(kind);
                await popup.complete(1);
                toastr.success('자동번역을 불러왔어. 패널의 되돌리기로 복원할 수 있어.', EXT_NAME);
            } catch (err) {
                toastr.error(`불러오기 실패: ${err.message}`, EXT_NAME);
            } finally {
                load.disabled = !selected;
            }
        });
    } catch (err) {
        if (!disposed) status.textContent = `검색 실패: ${err.message}`;
    }
    await closed;
}

function injectSearchButton(translationButton, kind) {
    const id = kind === 'char' ? 'peek_search_btn' : 'peek_persona_search_btn';
    if (document.getElementById(id)) return;
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.className = translationButton.className;
    button.title = 'Peek: 저장된 번역 검색해서 불러오기';
    button.setAttribute('aria-label', button.title);
    button.textContent = '🔍';
    button.addEventListener('click', e => {
        e.stopPropagation();
        openTranslationSearch(kind).catch(err => toastr.error(err.message, EXT_NAME));
    });
    translationButton.after(button);
}

// 불러오기 직전의 자동번역 한 단계만 별도 파일에 보관한다.
const undoBackups = new Map();
const entityWriteQueues = new Map();

function queueEntityWrite(kind, key, operation) {
    const id = entityId(kind, key);
    const previous = entityWriteQueues.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    entityWriteQueues.set(id, next);
    const cleanup = () => {
        if (entityWriteQueues.get(id) === next) entityWriteQueues.delete(id);
    };
    next.then(cleanup, cleanup);
    return next;
}

function undoFileName(kind, key) {
    return `peek_undo_${kind === 'char' ? 'c' : 'p'}_${keyHash(key)}.json`;
}

async function readUndoBackup(kind, key) {
    const id = entityId(kind, key);
    if (undoBackups.has(id)) return undoBackups.get(id);
    const pending = (async () => {
        const data = await readEntityFile(undoFileName(kind, key));
        if (data && (data.v !== 1 || data.kind !== kind || data.key !== key || !Object.hasOwn(data, 'auto'))) {
            throw new Error('되돌리기 파일 정보가 맞지 않아.');
        }
        return data;
    })();
    undoBackups.set(id, pending);
    try {
        const data = await pending;
        if (undoBackups.get(id) === pending) undoBackups.set(id, data);
        return data;
    } catch (err) {
        if (undoBackups.get(id) === pending) undoBackups.delete(id);
        throw err;
    }
}

async function replaceAutoWithUndo(kind, key, auto) {
    return queueEntityWrite(kind, key, async () => {
        if (storageFailed) throw new Error('파일 저장을 사용할 수 없어. 연결을 확인하고 새로고침해줘.');
        const section = SECTIONS[kind].auto;
        const previous = peekData[section][key];
        const priorBackup = await readUndoBackup(kind, key);
        const backup = { v: 1, kind, key, auto: structuredClone(previous ?? null), savedAt: Date.now() };
        // 백업 저장에 실패하면 현재 번역을 바꾸지 않는다.
        await writeEntityFile(undoFileName(kind, key), backup);
        undoBackups.set(entityId(kind, key), backup);
        peekData[section][key] = structuredClone(auto);
        try {
            // 불러오기는 파일 저장 성공을 확인한 뒤에만 완료한다.
            await persistEntityFile(kind, key);
        } catch (err) {
            if (previous === undefined) delete peekData[section][key];
            else peekData[section][key] = previous;
            try {
                if (priorBackup) await writeEntityFile(undoFileName(kind, key), priorBackup);
                else if (!await removeEntityFile(undoFileName(kind, key))) throw new Error('백업 정리 실패');
                undoBackups.set(entityId(kind, key), priorBackup);
            } catch (backupError) {
                // 새 백업에도 불러오기 전 현재 번역은 보존돼 있다.
                console.warn('[Peek] 이전 되돌리기 지점 복구 실패:', backupError);
                toastr.warning('현재 번역은 유지됐지만 이전 되돌리기 지점을 복구하지 못했어. 새 백업에는 현재 번역이 보관돼 있어.', EXT_NAME);
            }
            throw err;
        }
        clearAutoDrafts(kind, key);
    });
}

async function undoAutoImport(kind, key) {
    return queueEntityWrite(kind, key, async () => {
        const backup = await readUndoBackup(kind, key);
        if (!backup) throw new Error('되돌릴 번역이 없어.');
        const section = SECTIONS[kind].auto;
        const current = peekData[section][key];
        if (backup.auto === null) delete peekData[section][key];
        else peekData[section][key] = structuredClone(backup.auto);
        try {
            await persistEntityFile(kind, key);
        } catch (err) {
            if (current === undefined) delete peekData[section][key];
            else peekData[section][key] = current;
            throw err;
        }
        clearAutoDrafts(kind, key);
        // 복원 저장이 끝난 뒤 백업을 소비한다. 삭제 실패 시 재시도가 가능하도록 남긴다.
        if (await removeEntityFile(undoFileName(kind, key)).catch(() => false)) {
            undoBackups.set(entityId(kind, key), null);
        } else {
            toastr.warning('번역은 복원됐지만 되돌리기 파일 정리에 실패했어. 다시 시도할 수 있어.', EXT_NAME);
        }
    });
}

function renderUndoControl(panel, kind, key) {
    const footer = panel.querySelector('.peek-footer-actions');
    const id = entityId(kind, key);
    panel.dataset.peekUndoKey = id;
    footer.querySelector('.peek-undo-btn')?.remove();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'peek-action-btn peek-undo-btn';
    button.textContent = '되돌리기';
    button.title = '마지막 불러오기 직전의 자동번역으로 복원';
    button.hidden = true;
    footer.prepend(button);
    readUndoBackup(kind, key).then(() => {
        if (panel.dataset.peekUndoKey === id && button.isConnected) {
            Promise.resolve(undoBackups.get(id)).then(data => { button.hidden = !data; });
        }
    }).catch(err => {
        if (panel.dataset.peekUndoKey === id && button.isConnected) {
            button.hidden = false;
            button.title = `되돌리기 파일 확인 실패: ${err.message}. 눌러서 다시 시도`;
        }
    });
    button.addEventListener('click', async e => {
        e.stopPropagation();
        if (button.disabled) return;
        button.disabled = true;
        try {
            const confirmed = await Popup.show.confirm('번역 되돌리기', '마지막 불러오기 직전의 자동번역으로 돌아갈까? 불러온 뒤 수정한 자동번역은 대체되고, 수동번역과 메모는 유지돼.');
            if (!confirmed || currentEntityKey(kind) !== key) return;
            await undoAutoImport(kind, key);
            showAutoTab(kind);
            toastr.success('불러오기 전 자동번역으로 되돌렸어.', EXT_NAME);
        } catch (err) {
            toastr.error(`되돌리기 실패: ${err.message}`, EXT_NAME);
        } finally {
            button.disabled = false;
        }
    });
}

// 패널 재렌더 중에도 편집 초안을 유지하되, settings에는 기록하지 않음.
const autoEditDrafts = new Map();
function clearAutoDrafts(kind, key) {
    for (const [id, draft] of autoEditDrafts) {
        if (draft.kind === kind && draft.key === key) autoEditDrafts.delete(id);
    }
}

function bindAutoFieldEditor(block, kind, key, field, translation) {
    const id = JSON.stringify([kind, key, field]);
    const content = block.querySelector('.peek-field-content');
    const copy = block.querySelector('.peek-copy-btn');
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'peek-edit-btn';
    edit.title = '자동번역 수정';
    edit.setAttribute('aria-label', edit.title);
    edit.innerHTML = '<i class="fa-solid fa-pen"></i>';
    // 버튼은 헤더에 모아 본문 전체 폭을 사용할 수 있게 한다.
    const header = document.createElement('div');
    header.className = 'peek-field-header';
    const label = block.querySelector('.peek-field-label');
    if (label) header.append(label);
    const tools = document.createElement('div');
    tools.className = 'peek-field-tools';
    tools.append(edit, copy);
    header.append(tools);
    block.prepend(header);
    const showEditor = () => {
        const draft = autoEditDrafts.get(id);
        content.hidden = true;
        copy.hidden = true;
        edit.hidden = true;
        header.hidden = !label;
        const editor = document.createElement('div');
        editor.className = 'peek-auto-editor';
        const textarea = document.createElement('textarea');
        textarea.className = 'text_pole peek-auto-textarea';
        textarea.setAttribute('aria-label', '자동번역 수정 내용');
        textarea.value = draft.text;
        textarea.addEventListener('input', () => { draft.text = textarea.value; });
        const actions = document.createElement('div');
        actions.className = 'peek-editor-actions';
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'peek-action-btn peek-auto-save';
        save.textContent = '저장';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'peek-action-btn peek-auto-cancel';
        cancel.textContent = '취소';
        cancel.addEventListener('click', () => {
            autoEditDrafts.delete(id);
            renderEntityPanel(kind);
        });
        save.addEventListener('click', async () => {
            if (!textarea.value.trim()) {
                toastr.warning('번역 내용을 입력해줘. 삭제는 패널의 지우기를 사용해줘.', EXT_NAME);
                return;
            }
            save.disabled = true;
            cancel.disabled = true;
            try {
                const text = textarea.value;
                const saved = await queueEntityWrite(kind, key, async () => {
                    const auto = peekData[SECTIONS[kind].auto][key];
                    const current = kind === 'char' ? auto?.[field] : auto;
                    if (current !== draft.original) return false;
                    const updated = { ...current, text, updatedAt: Date.now() };
                    if (kind === 'char') auto[field] = updated;
                    else peekData.personaTranslations[key] = updated;
                    await persistEntityImmediately(kind, key);
                    return true;
                });
                if (!saved) {
                    toastr.warning('번역이 변경됐어. 취소한 뒤 다시 수정해줘.', EXT_NAME);
                    return;
                }
                autoEditDrafts.delete(id);
                renderEntityPanel(kind);
                toastr.success('수정한 자동번역을 저장했어.', EXT_NAME);
            } catch (err) {
                toastr.error(`저장 실패: ${err.message}`, EXT_NAME);
            } finally {
                save.disabled = false;
                cancel.disabled = false;
            }
        });
        actions.append(save, cancel);
        editor.append(textarea, actions);
        block.append(editor);
    };
    edit.addEventListener('click', e => {
        e.stopPropagation();
        autoEditDrafts.set(id, { kind, key, text: translation.text, original: translation });
        showEditor();
        block.querySelector('textarea').focus();
    });
    if (autoEditDrafts.has(id)) showEditor();
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
 * 텍스트를 클립보드에 복사하고 버튼에 완료 피드백을 잠깐 표시
 */
async function copyTextWithFeedback(text, btn) {
    if (!text) return;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        toastr.success('복사했어', EXT_NAME);
        if (btn) {
            const icon = btn.querySelector('i');
            const prevClass = icon ? icon.className : null;
            btn.classList.add('peek-copied');
            if (icon) icon.className = 'fa-solid fa-check';
            setTimeout(() => {
                btn.classList.remove('peek-copied');
                if (icon && prevClass) icon.className = prevClass;
            }, 1200);
        }
    } catch (err) {
        toastr.error('복사 실패: ' + err.message, EXT_NAME);
    }
}

/* ===================================================================
 * 데이터 백업 / 복원
 * 저장 구조를 바꾸기 전에 유저가 스스로 데이터를 지킬 수 있게 하는 안전망.
 * 여기서는 settings 구조를 일절 안 바꿈 — 읽고 쓰기만 함.
 * =================================================================== */

// 백업 대상 섹션과 중첩 깊이
// translations: { [avatarKey]: { [fieldKey]: {...} } }  → 2단계
// 나머지:        { [key]: {...} }                        → 1단계
const BACKUP_SECTIONS = {
    translations: 2,
    personaTranslations: 1,
    manualTranslations: 1,
    personaManualTranslations: 1,
    notes: 1,
    personaNotes: 1,
};

const BACKUP_FORMAT = 'peek-backup';

// 섹션 → kind 매핑
const SECTION_KIND = {
    translations: 'char',
    manualTranslations: 'char',
    notes: 'char',
    personaTranslations: 'persona',
    personaManualTranslations: 'persona',
    personaNotes: 'persona',
};

function splitEntityId(id) {
    const sep = id.indexOf(':');
    return sep < 0 ? null : { kind: id.slice(0, sep), key: id.slice(sep + 1) };
}

/**
 * settings 안에 남아있는 레거시 데이터 크기(KB)
 */
function legacySizeKB() {
    const raw = extension_settings[EXT_ID] || {};
    const payload = {};
    for (const key of Object.keys(BACKUP_SECTIONS)) {
        if (raw[key]) payload[key] = raw[key];
    }
    return JSON.stringify(payload).length / 1024;
}

/**
 * 알고 있는 모든 엔티티 id (파일 인덱스 + 레거시 + 메모리)
 */
function allEntityIds() {
    const settings = loadSettings();
    const raw = extension_settings[EXT_ID] || {};
    const ids = new Set(Object.keys(settings.fileIndex || {}));
    for (const [section, kind] of Object.entries(SECTION_KIND)) {
        for (const key of Object.keys(raw[section] || {})) ids.add(entityId(kind, key));
        for (const key of Object.keys(peekData[section] || {})) ids.add(entityId(kind, key));
    }
    return [...ids];
}

/**
 * 전체 엔티티를 메모리로 로드 (동시 4건)
 */
async function loadAllEntities(onProgress) {
    const ids = allEntityIds();
    for (let i = 0; i < ids.length; i += 4) {
        await Promise.all(ids.slice(i, i + 4).map(id => {
            const e = splitEntityId(id);
            return e ? ensureEntity(e.kind, e.key).catch(() => {}) : Promise.resolve();
        }));
        if (onProgress) onProgress(Math.min(i + 4, ids.length), ids.length);
    }
    return ids.length;
}

/**
 * 현재 데이터로 백업 객체 만들기 (파일 + 레거시 전부 포함)
 */
async function buildBackupObject(onProgress) {
    await loadAllEntities(onProgress);
    const settings = loadSettings();
    const raw = extension_settings[EXT_ID] || {};
    const tombs = settings.legacyTombstones || {};
    const data = {};

    for (const section of Object.keys(BACKUP_SECTIONS)) {
        data[section] = structuredClone(peekData[section] || {});
        // 아직 메모리에 안 올라온 레거시 잔여분 합치기 (삭제된 건 제외)
        const kind = SECTION_KIND[section];
        for (const [key, val] of Object.entries(raw[section] || {})) {
            if (data[section][key] !== undefined) continue;
            if (tombs[entityId(kind, key)]) continue;
            data[section][key] = structuredClone(val);
        }
    }

    return {
        format: BACKUP_FORMAT,
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        data,
    };
}

/**
 * 타임스탬프 문자열 (파일명용)
 */
function backupTimestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * JSON 파일로 다운로드
 */
function downloadJson(obj, filename) {
    const json = JSON.stringify(obj, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * 섹션별 항목 수 세기
 */
function countSection(obj, depth) {
    if (!obj || typeof obj !== 'object') return 0;
    if (depth === 1) return Object.keys(obj).length;
    return Object.values(obj).reduce(
        (n, v) => n + (v && typeof v === 'object' ? Object.keys(v).length : 0),
        0,
    );
}

/**
 * 내보내기
 */
async function exportPeekData(silent = false, suffix = '') {
    try {
        if (!silent) toastr.info('데이터 수집 중...', EXT_NAME);
        const backup = await buildBackupObject();
        downloadJson(backup, `peek-backup-${backupTimestamp()}${suffix}.json`);
        if (!silent) {
            const chars = Object.keys(backup.data.translations || {}).length;
            const kb = JSON.stringify(backup).length / 1024;
            toastr.success(`백업 저장됨 (캐릭터 ${chars}명 · ${kb.toFixed(0)}KB)`, EXT_NAME);
        }
        return true;
    } catch (err) {
        console.error('[Peek] 내보내기 실패:', err);
        toastr.error('내보내기 실패: ' + err.message, EXT_NAME);
        return false;
    }
}

/**
 * 섹션 병합. overwrite=false면 기존 항목은 안 건드리고 없는 것만 추가
 */
function mergeSection(target, source, depth, overwrite, stats, touched, kind) {
    for (const [key, val] of Object.entries(source || {})) {
        if (val === null || typeof val !== 'object') continue;
        if (depth === 2) {
            if (!target[key] || typeof target[key] !== 'object') target[key] = {};
            const before = JSON.stringify(target[key]);
            mergeSection(target[key], val, 1, overwrite, stats, null, kind);
            if (touched && JSON.stringify(target[key]) !== before) touched.add(entityId(kind, key));
        } else if (target[key] === undefined) {
            target[key] = structuredClone(val);
            stats.added++;
            if (touched) touched.add(entityId(kind, key));
        } else if (overwrite) {
            target[key] = structuredClone(val);
            stats.replaced++;
            if (touched) touched.add(entityId(kind, key));
        } else {
            stats.skipped++;
        }
    }
}

/**
 * 백업 파일 파싱 + 검증
 */
function parseBackup(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('JSON 파싱 실패 — 올바른 백업 파일이 아니야');
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('내용이 비어있어');
    if (parsed.format === BACKUP_FORMAT && parsed.data) return parsed.data;
    const hasSection = Object.keys(BACKUP_SECTIONS).some(k => parsed[k] && typeof parsed[k] === 'object');
    if (hasSection) return parsed;
    throw new Error('Peek 백업 파일이 아닌 것 같아');
}

/**
 * 가져오기
 */
async function importPeekData(file, overwrite) {
    let data;
    try {
        data = parseBackup(await file.text());
    } catch (err) {
        toastr.error(err.message, EXT_NAME);
        return;
    }

    const charCount = Object.keys(data.translations || {}).length;
    const charFields = countSection(data.translations, 2);
    const personaCount = countSection(data.personaTranslations, 1);
    const manualCount = countSection(data.manualTranslations, 1) + countSection(data.personaManualTranslations, 1);
    const noteCount = countSection(data.notes, 1) + countSection(data.personaNotes, 1);

    const modeText = overwrite
        ? '<b style="color:#e8a33d;">덮어쓰기</b> — 같은 키는 파일 내용으로 교체돼'
        : '<b>병합</b> — 기존 항목은 그대로 두고 없는 것만 추가돼';

    const confirmed = await Popup.show.confirm(
        '데이터 가져오기',
        `<div style="text-align:left;">
            <p>이 백업을 불러올까?</p>
            <pre style="white-space:pre-wrap;font-size:0.9em;opacity:0.85;margin:8px 0;">• 캐릭터 번역: ${charCount}명 / ${charFields}개 필드
• 페르소나 번역: ${personaCount}개
• 수동 번역: ${manualCount}개
• 메모: ${noteCount}개</pre>
            <p style="font-size:0.9em;">모드: ${modeText}</p>
            <p style="font-size:0.85em;opacity:0.7;">진행 전에 <b>지금 상태를 파일로 자동 백업</b>할게.</p>
        </div>`,
    );
    if (!confirmed) return;

    if (!await exportPeekData(true, '-before-import')) {
        toastr.error('사전 백업 실패 — 가져오기를 중단했어', EXT_NAME);
        return;
    }

    // 병합 판단이 정확하려면 대상 엔티티를 먼저 메모리에 올려야 함
    const targetIds = new Set();
    for (const [section, kind] of Object.entries(SECTION_KIND)) {
        for (const key of Object.keys(data[section] || {})) targetIds.add(entityId(kind, key));
    }
    const idList = [...targetIds];
    for (let i = 0; i < idList.length; i += 4) {
        await Promise.all(idList.slice(i, i + 4).map(id => {
            const e = splitEntityId(id);
            return e ? ensureEntity(e.kind, e.key).catch(() => {}) : Promise.resolve();
        }));
    }

    const stats = { added: 0, replaced: 0, skipped: 0 };
    const touched = new Set();
    for (const [section, depth] of Object.entries(BACKUP_SECTIONS)) {
        if (!data[section] || typeof data[section] !== 'object') continue;
        mergeSection(peekData[section], data[section], depth, overwrite, stats, touched, SECTION_KIND[section]);
    }

    // 되살린 항목의 묘비 제거
    const settings = loadSettings();
    for (const id of touched) {
        if (settings.legacyTombstones?.[id]) delete settings.legacyTombstones[id];
    }

    // 변경된 엔티티만 저장 (동시 3건)
    const list = [...touched];
    let saved = 0;
    for (let i = 0; i < list.length; i += 3) {
        await Promise.all(list.slice(i, i + 3).map(async id => {
            const e = splitEntityId(id);
            if (!e) return;
            try {
                await persistEntity(e.kind, e.key);
                saved++;
            } catch (err) {
                console.error('[Peek] 가져오기 저장 실패:', id, err);
            }
        }));
    }

    updateDataSizeDisplay();
    try {
        renderTranslationPanel();
        renderPersonaPanel();
    } catch (err) {
        console.warn('[Peek] 가져오기 후 패널 갱신 실패:', err);
    }

    const parts = [`추가 ${stats.added}`];
    if (stats.replaced) parts.push(`교체 ${stats.replaced}`);
    if (stats.skipped) parts.push(`유지 ${stats.skipped}`);
    toastr.success(`가져오기 완료 (${parts.join(' · ')}) · ${saved}개 저장됨`, EXT_NAME);
}

/**
 * 레거시(settings) 데이터를 파일로 이전 + 검증 후 정리
 */
async function migrateLegacyToFiles() {
    const settings = loadSettings();
    const raw = extension_settings[EXT_ID] || {};

    const ids = new Set();
    for (const [section, kind] of Object.entries(SECTION_KIND)) {
        for (const key of Object.keys(raw[section] || {})) ids.add(entityId(kind, key));
    }
    if (ids.size === 0) {
        toastr.info('이전할 레거시 데이터가 없어', EXT_NAME);
        return;
    }
    if (storageFailed) {
        toastr.error('파일 저장이 동작하지 않는 상태라 이전할 수 없어', EXT_NAME);
        return;
    }

    const kb = legacySizeKB();
    const confirmed = await Popup.show.confirm(
        '기존 데이터 파일로 이전',
        `<div style="text-align:left;">
            <p>settings에 남아있는 <b>${ids.size}개 항목 (${kb.toFixed(0)}KB)</b>을 파일로 옮길까?</p>
            <p style="font-size:0.9em;opacity:0.8;">① 자동 백업 → ② 파일로 쓰기 → ③ 하나씩 다시 읽어 검증 → ④ 전부 통과하면 삭제 여부를 다시 물어봄</p>
            <p style="font-size:0.85em;opacity:0.7;">검증에 하나라도 실패하면 기존 데이터는 그대로 둘게.</p>
        </div>`,
    );
    if (!confirmed) return;

    if (!await exportPeekData(true, '-before-migrate')) {
        toastr.error('사전 백업 실패 — 이전을 중단했어', EXT_NAME);
        return;
    }

    const list = [...ids];
    const failures = [];
    let done = 0;

    for (const id of list) {
        const e = splitEntityId(id);
        if (!e) continue;
        try {
            await ensureEntity(e.kind, e.key);
            await persistEntity(e.kind, e.key);

            // 검증: 파일을 실제로 다시 읽어서 내용 비교
            const entry = loadSettings().fileIndex?.[id];
            if (!entry?.file) throw new Error('인덱스 없음');
            const back = await readEntityFile(entry.file);
            if (!back || back.key !== e.key) throw new Error('키 불일치');
            const expect = collectEntityData(e.kind, e.key);
            const norm = (o) => JSON.stringify({ auto: o.auto ?? null, manual: o.manual ?? null, note: o.note ?? null });
            if (norm(back) !== norm(expect)) throw new Error('내용 불일치');
        } catch (err) {
            console.error('[Peek] 이전 실패:', id, err);
            failures.push(`${id} (${err.message})`);
        }
        done++;
        const el = document.getElementById('peek_data_size');
        if (el) el.textContent = `이전 중... ${done}/${list.length}`;
    }

    updateDataSizeDisplay();

    if (failures.length) {
        toastr.error(`${failures.length}개 실패 — 기존 데이터는 그대로 뒀어. 콘솔 확인해줘`, EXT_NAME);
        console.error('[Peek] 실패 목록:', failures);
        return;
    }

    const cleanup = await Popup.show.confirm(
        '이전 완료',
        `<div style="text-align:left;">
            <p><b>${list.length}개 전부 파일로 옮기고 검증까지 통과</b>했어.</p>
            <p>이제 settings에 남은 옛 데이터(${kb.toFixed(0)}KB)를 지울까?</p>
            <p style="font-size:0.85em;opacity:0.7;">지우면 settings.json이 그만큼 가벼워져. 백업 파일은 이미 받아놨고, 지워도 번역은 파일에서 그대로 읽혀.</p>
        </div>`,
    );

    if (!cleanup) {
        toastr.info('이전은 끝났어. 정리는 나중에 해도 돼', EXT_NAME);
        return;
    }

    for (const section of Object.keys(BACKUP_SECTIONS)) {
        delete extension_settings[EXT_ID][section];
    }
    settings.legacyTombstones = {};
    saveSettingsDebounced();
    updateDataSizeDisplay();
    toastr.success(`정리 완료 — settings에서 ${kb.toFixed(0)}KB 줄었어`, EXT_NAME);
}

/**
 * 데이터 용량 표시 갱신
 */
function updateDataSizeDisplay() {
    const el = document.getElementById('peek_data_size');
    if (!el) return;
    const settings = loadSettings();
    const fileCount = Object.keys(settings.fileIndex || {}).length;
    const legacyKB = legacySizeKB();
    const settingsKB = JSON.stringify(settings).length / 1024;

    let text = `파일 ${fileCount}개 · settings 사용량 ${settingsKB.toFixed(1)}KB`;
    if (storageFailed) text += ' · ⚠ 레거시 모드(파일 저장 불가)';
    el.textContent = text;

    const migrateBtn = document.getElementById('peek_migrate_btn');
    if (migrateBtn) {
        if (legacyKB > 1) {
            migrateBtn.style.display = '';
            migrateBtn.innerHTML = `<i class="fa-solid fa-right-left"></i> 기존 데이터 이전 (${legacyKB.toFixed(0)}KB)`;
        } else {
            migrateBtn.style.display = 'none';
        }
    }
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

    const fieldCheckboxes = [...TRANSLATABLE_FIELDS, ALT_FIELD].map(f => {
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
                        <small style="opacity:0.75;">캐릭터 카드 / 페르소나를 한국어로 번역해서 보여줘. 실제 데이터는 안 건드림.<br>패널에 <b>자동/수동</b> 탭이 있어. 수동 번역과 메모는 자동 저장되고 💾 버튼으로 강제 저장도 가능.</small>

                        <label for="peek_profile_select"><b>연결 프로필</b></label>
                        <select id="peek_profile_select">${profileOptions}</select>

                        <label for="peek_max_tokens"><b>응답 토큰 최대</b> <small style="opacity:0.6;">(기본 8192, 모델에 맞춰 조정)</small></label>
                        <input type="number" id="peek_max_tokens" min="512" max="65536" step="256" class="text_pole" value="${settings.maxResponseTokens || 8192}">

                        <label><b>캐릭터 카드 번역 시 포함할 필드</b></label>
                        <div class="peek-fields-grid">${fieldCheckboxes}</div>

                        <div class="peek-status" id="peek_status"></div>

                        <hr class="peek-divider">

                        <label><b>데이터 백업</b></label>
                        <small style="opacity:0.75;">번역 데이터는 <code>/user/files</code>에 캐릭터별 파일로 저장돼. 언제든 통째로 내보내고 불러올 수 있어.</small>
                        <div class="peek-data-size" id="peek_data_size"></div>
                        <div class="peek-data-buttons">
                            <div class="menu_button" id="peek_export_btn" title="현재 데이터를 JSON 파일로 저장">
                                <i class="fa-solid fa-download"></i> 내보내기
                            </div>
                            <div class="menu_button" id="peek_import_btn" title="백업 JSON 파일 불러오기">
                                <i class="fa-solid fa-upload"></i> 가져오기
                            </div>
                            <input type="file" id="peek_import_file" accept=".json,application/json" style="display:none;">
                        </div>
                        <div class="peek-data-buttons">
                            <div class="menu_button" id="peek_migrate_btn" style="display:none;" title="settings에 남은 옛 데이터를 파일로 옮기고 정리">
                                <i class="fa-solid fa-right-left"></i> 기존 데이터 이전
                            </div>
                        </div>
                        <label class="peek-field-checkbox" title="켜면 파일 내용이 기존 데이터를 덮어써">
                            <input type="checkbox" id="peek_import_overwrite">
                            <span>가져올 때 덮어쓰기 <small style="opacity:0.6;">(끄면 없는 것만 추가)</small></span>
                        </label>
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

    // === 데이터 백업 ===
    const exportBtn = document.getElementById('peek_export_btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => { exportPeekData(); });
    }

    const importBtn = document.getElementById('peek_import_btn');
    const importFile = document.getElementById('peek_import_file');
    if (importBtn && importFile) {
        importBtn.addEventListener('click', () => {
            importFile.value = '';  // 같은 파일 다시 고를 수 있게
            importFile.click();
        });
        importFile.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const overwrite = document.getElementById('peek_import_overwrite')?.checked || false;
            await importPeekData(file, overwrite);
            e.target.value = '';
        });
    }

    const migrateBtn = document.getElementById('peek_migrate_btn');
    if (migrateBtn) {
        migrateBtn.addEventListener('click', async () => {
            migrateBtn.classList.add('disabled');
            try {
                await migrateLegacyToFiles();
            } finally {
                migrateBtn.classList.remove('disabled');
            }
        });
    }

    updateDataSizeDisplay();
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
    // CHAT_CHANGED / CHARACTER_EDITED / CHARACTER_PAGE_LOADED:
    //   캐릭터/채팅 컨텍스트 변경 시 양쪽 패널 다시 렌더 (단축 버튼 inject도 같이)
    eventSource.on(event_types.CHAT_CHANGED, onCharacterContextChange);
    eventSource.on(event_types.CHARACTER_EDITED, onCharacterContextChange);
    eventSource.on(event_types.CHARACTER_PAGE_LOADED, onCharacterContextChange);

    // 캐릭터 카드를 클릭해서 편집창 여는 경우 — SillyTavern 이벤트로는 못 잡는 경로 한정해서만.
    // 채팅 메시지/스크롤 등엔 영향 없도록 매우 좁은 위임으로.
    document.addEventListener('click', (e) => {
        const charBlock = e.target.closest('#rm_print_characters_block .character_select');
        if (charBlock) {
            // 카드 패널이 새로 그려지는 데 시간 필요
            setTimeout(() => renderTranslationPanel(), 150);
            return;
        }
        // 페르소나 관리 메뉴 클릭 → 페르소나 패널 표시
        const personaMenu = e.target.closest('#persona-management-button');
        if (personaMenu) {
            setTimeout(() => renderPersonaPanel(), 200);
        }
    });

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

    // 자주 쓰는 캐릭터만 유휴 시점에 미리 로드 (동시 3건) — 부팅 부하 최소화
    setTimeout(() => {
        preloadRecent(20).catch(err => console.warn('[Peek] 프리로드 실패:', err));
    }, 4000);

    console.log(`[${EXT_NAME}] 로드 완료`);
});
