import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute the real storage functions without starting the SillyTavern UI.
const source = (await readFile(new URL('../index.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?$/gm, '');
const clone = value => JSON.parse(JSON.stringify(value));

function harness() {
    const files = new Map();
    const settings = {};
    let fail = () => false;
    const context = vm.createContext({
        structuredClone, TextEncoder, btoa, setTimeout, clearTimeout, characters: [], name1: '', this_chid: undefined,
        extension_settings: settings,
        jQuery: () => {},
        getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }),
        saveSettingsDebounced: () => {},
        toastr: { info() {}, warning() {}, error() {}, success() {} },
        console: { warn() {}, error() {}, log() {} },
        fetch: async (url, options = {}) => {
            const payload = options.body ? JSON.parse(options.body) : null;
            if (fail(url, payload)) return new Response('Storage unavailable', { status: 503 });
            if (url === '/api/files/upload') {
                files.set(payload.name, JSON.parse(Buffer.from(payload.data, 'base64').toString('utf8')));
                return Response.json({ path: `/user/files/${payload.name}` });
            }
            if (url === '/api/files/delete') {
                const found = files.delete(payload.path.replace('/user/files/', ''));
                return new Response(null, { status: found ? 200 : 404 });
            }
            const value = files.get(url.replace('/user/files/', ''));
            return value ? Response.json(value) : new Response(null, { status: 404 });
        },
    });
    vm.runInContext(`${source}\n globalThis.storage = {
        loadSettings, applyEntityData, collectEntityData, persistEntity, replaceAutoWithUndo,
        undoAutoImport, readUndoBackup, undoFileName, entityFileName,
        savedAutoEntries, characterTranslationTargets, translateWithProfile, runTranslation,
        greetingEntries, resolveGreetingSwipe, greetingLinkCandidate, activeGreetingLink, displayGreetingText, buildBackupObject,
        clearCache: () => undoBackups.clear(),
    };`, context);
    const storage = context.storage;
    storage.loadSettings();
    return { storage, files, settings, context, failWhen: predicate => { fail = predicate; } };
}

async function seed(h, kind, auto, { manual = { text: 'manual' }, note = { text: 'note' } } = {}) {
    h.storage.applyEntityData(kind, 'target.png', { auto, manual, note });
    await h.storage.persistEntity(kind, 'target.png');
}

for (const kind of ['char', 'persona']) {
    test(`${kind}: undo survives cache reset and preserves manual translation and notes`, async () => {
        const h = harness();
        const before = kind === 'char'
            ? { description: { text: 'before', translatedAt: 1 }, personality: { text: 'calm' } }
            : { text: 'before', translatedAt: 1 };
        const after = kind === 'char' ? { description: { text: 'after' } } : { text: 'after' };
        await seed(h, kind, before);
        await h.storage.replaceAutoWithUndo(kind, 'target.png', after);
        h.storage.clearCache();
        assert.deepEqual(clone((await h.storage.readUndoBackup(kind, 'target.png')).auto), before);
        await h.storage.undoAutoImport(kind, 'target.png');
        const saved = h.files.get(h.storage.entityFileName(kind, 'target.png'));
        assert.deepEqual(saved.auto, before);
        assert.deepEqual(saved.manual, { text: 'manual' });
        assert.deepEqual(saved.note, { text: 'note' });
        assert.equal(h.files.has(h.storage.undoFileName(kind, 'target.png')), false);
        assert.equal(h.settings.peek.translations, undefined);
        assert.equal(h.settings.peek.personaTranslations, undefined);
        assert.equal(Object.keys(h.settings.peek).some(key => /undo/i.test(key)), false);
    });
}

test('undo restores an initially empty automatic translation', async () => {
    const h = harness();
    await seed(h, 'persona', null, { manual: null, note: null });
    await h.storage.replaceAutoWithUndo('persona', 'target.png', { text: 'imported' });
    await h.storage.undoAutoImport('persona', 'target.png');
    assert.equal(h.storage.collectEntityData('persona', 'target.png').auto, null);
    assert.equal(h.files.size, 0);
});

test('a failed backup prevents replacement', async () => {
    const h = harness();
    await seed(h, 'persona', { text: 'before' });
    h.failWhen((url, data) => url === '/api/files/upload' && data.name.startsWith('peek_undo_'));
    await assert.rejects(h.storage.replaceAutoWithUndo('persona', 'target.png', { text: 'after' }));
    assert.equal(h.storage.collectEntityData('persona', 'target.png').auto.text, 'before');
    assert.equal(h.files.get(h.storage.entityFileName('persona', 'target.png')).auto.text, 'before');
});

test('a failed import restores current data and the previous undo point', async () => {
    const h = harness();
    await seed(h, 'persona', { text: 'original' });
    await h.storage.replaceAutoWithUndo('persona', 'target.png', { text: 'first import' });
    h.failWhen((url, data) => url === '/api/files/upload' && !data.name.startsWith('peek_undo_'));
    await assert.rejects(h.storage.replaceAutoWithUndo('persona', 'target.png', { text: 'failed import' }));
    assert.equal(h.storage.collectEntityData('persona', 'target.png').auto.text, 'first import');
    assert.equal(h.files.get(h.storage.undoFileName('persona', 'target.png')).auto.text, 'original');
    h.failWhen(() => false);
    await h.storage.undoAutoImport('persona', 'target.png');
    assert.equal(h.storage.collectEntityData('persona', 'target.png').auto.text, 'original');
});

test('failed undo keeps its backup and can be retried', async () => {
    const h = harness();
    await seed(h, 'persona', { text: 'original' });
    await h.storage.replaceAutoWithUndo('persona', 'target.png', { text: 'imported' });
    h.failWhen((url, data) => url === '/api/files/upload' && !data.name.startsWith('peek_undo_'));
    await assert.rejects(h.storage.undoAutoImport('persona', 'target.png'));
    assert.equal(h.storage.collectEntityData('persona', 'target.png').auto.text, 'imported');
    assert.equal(h.files.has(h.storage.undoFileName('persona', 'target.png')), true);
    h.failWhen(() => false);
    await h.storage.undoAutoImport('persona', 'target.png');
    assert.equal(h.storage.collectEntityData('persona', 'target.png').auto.text, 'original');
});

test('each import stores the immediately preceding translation', async () => {
    const h = harness();
    await seed(h, 'persona', { text: 'original' });
    await h.storage.replaceAutoWithUndo('persona', 'target.png', { text: 'first' });
    await h.storage.replaceAutoWithUndo('persona', 'target.png', { text: 'second' });
    await h.storage.undoAutoImport('persona', 'target.png');
    assert.equal(h.storage.collectEntityData('persona', 'target.png').auto.text, 'first');
});

test('ALT translation includes every nonempty greeting with its original number', () => {
    const { storage } = harness();
    const alternate_greetings = Array.from({ length: 125 }, (_, index) => index === 1 ? ' ' : `Greeting ${index + 1}`);
    const char = { data: { alternate_greetings, first_mes: 'Default' } };
    const targets = storage.characterTranslationTargets(char, ['first_mes', 'alternate_greetings']);
    assert.equal(targets.length, 125);
    assert.equal(targets[0].key, 'first_mes');
    assert.equal(targets[2].label, 'ALT 3');
    assert.equal(targets.at(-1).source, 'Greeting 125');
    assert.equal(storage.characterTranslationTargets(char, ['first_mes']).length, 1);
    assert.equal(storage.characterTranslationTargets({ alternate_greetings }, ['alternate_greetings']).length, 124);
});

test('ALT-only translations appear in search in numeric order and are restored by undo', async () => {
    const h = harness();
    const before = { alt_greeting_20: { text: '마지막 인사' }, alt_greeting_2: { text: '두 번째 인사' } };
    await seed(h, 'char', before);
    const { entries } = await h.storage.savedAutoEntries('char');
    assert.deepEqual(clone(entries[0].records), [['ALT 2', '두 번째 인사'], ['ALT 20', '마지막 인사']]);
    await h.storage.replaceAutoWithUndo('char', 'target.png', { alt_greeting_1: { text: '가져온 인사' } });
    await h.storage.undoAutoImport('char', 'target.png');
    assert.deepEqual(clone(h.storage.collectEntityData('char', 'target.png').auto), before);
});

test('greeting translation prompts prioritize macro preservation and guide natural Korean', async () => {
    const { storage, context } = harness();
    const source = '{{user}} {{getvar:: Greeting }} {{user}}';
    const prompts = [];
    context.ConnectionManagerRequestService = {
        async sendRequest(profileId, prompt) {
            prompts.push(prompt);
            assert.match(prompt, /Highest-priority rule: Copy every SillyTavern macro/);
            assert.ok(prompt.indexOf('Highest-priority rule:') < prompt.indexOf('Rules:'));
            assert.ok(prompt.includes(source));
            return { content: '안녕하세요, {{char}}.' };
        },
    };
    assert.equal(await storage.translateWithProfile('profile', 'ALT 1', source), '안녕하세요, {{char}}.');
    await storage.translateWithProfile('profile', 'First Message', source);
    await storage.translateWithProfile('profile', 'Description', source);
    assert.equal(prompts.length, 3);
    assert.match(prompts[0], /write idiomatic Korean dialogue and narration/);
    assert.match(prompts[1], /Avoid literal phrasing and English word order/);
    assert.doesNotMatch(prompts[2], /write idiomatic Korean dialogue and narration/);
});

test('default translation requests only new greetings and explicit retranslation updates automatic fields', async () => {
    const h = harness();
    const key = 'target.png';
    const existing = {
        description: { text: '기존 캐릭터 설명' },
        first_mes: { text: '기존 기본 그리팅' },
        alt_greeting_1: { text: '기존 ALT 번역' },
    };
    const greetings = { alt_greeting_2: { text: '직접 추가본' } };
    h.storage.applyEntityData('char', key, { auto: structuredClone(existing), greetings });
    await h.storage.persistEntity('char', key);
    h.settings.peek.selectedFields = ['description', 'first_mes', 'alternate_greetings'];
    h.settings.peek.profileId = 'profile';
    h.context.this_chid = 0;
    h.context.characters.push({ avatar: key, data: {
        description: 'Description', first_mes: 'Default', alternate_greetings: ['Extra one', 'Extra two', 'Extra three'],
    } });
    h.context.Popup = { show: { confirm: async () => true } };
    h.context.document = { getElementById: () => null, querySelector: () => null };
    h.context.renderTranslationPanel = () => {};
    const requests = [];
    h.context.ConnectionManagerRequestService = {
        async sendRequest(profile, prompt) {
            requests.push(prompt.split('---SOURCE---\n')[1].split('\n---END SOURCE---')[0]);
            return { content: '새 자동번역' };
        },
    };
    const file = h.storage.entityFileName('char', key);
    await h.storage.runTranslation();
    assert.deepEqual(requests, ['Extra three']);
    const { alt_greeting_3: newGreeting, ...previous } = h.files.get(file).auto;
    assert.deepEqual(previous, existing);
    assert.equal(newGreeting.text, '새 자동번역');
    assert.deepEqual(h.files.get(file).greetings, greetings);

    await h.storage.runTranslation();
    assert.deepEqual(requests, ['Extra three']);
    h.settings.peek.retranslateExistingFields = true;
    await h.storage.runTranslation();
    assert.deepEqual(requests.slice(1), ['Description', 'Default', 'Extra one', 'Extra two', 'Extra three']);
    assert.equal(h.files.get(file).auto.description.text, '새 자동번역');
    assert.deepEqual(h.files.get(file).greetings, greetings);
});

test('direct additions and authored greetings persist separately from searched and restored auto translations', async () => {
    const h = harness();
    const key = 'target.png';
    const greetings = { alt_greeting_1: { text: '직접 추가', source: 'ALT' }, extra_1: { text: '직접 작성' } };
    h.storage.applyEntityData('char', key, { auto: { alt_greeting_1: { text: '자동 번역' } }, greetings });
    await h.storage.persistEntity('char', key);
    const saved = h.files.get(h.storage.entityFileName('char', key));
    assert.deepEqual(saved.greetings, greetings);
    assert.deepEqual(clone((await h.storage.savedAutoEntries('char')).entries[0].records), [['ALT 1', '자동 번역']]);
    await h.storage.replaceAutoWithUndo('char', key, {});
    await h.storage.undoAutoImport('char', key);
    assert.deepEqual(clone(h.storage.collectEntityData('char', key).greetings), greetings);
    assert.deepEqual(clone((await h.storage.buildBackupObject()).data.greetingAdditions[key]), greetings);
    h.storage.applyEntityData('char', key, { greetings });
    await h.storage.persistEntity('char', key);
    assert.deepEqual(h.files.get(h.storage.entityFileName('char', key)).greetings, greetings);
});

test('swipe resolution uses original text, prefers direct additions, and skips ambiguous, stale and generated matches', () => {
    const h = harness();
    h.context.name1 = '독자';
    h.context.this_chid = 0;
    h.context.characters.push({ name: '테스트' });
    const { greetingEntries, resolveGreetingSwipe, greetingLinkCandidate } = h.storage;
    const char = { first_mes: 'Hello {{user}}', data: { alternate_greetings: ['ALT', 'Duplicate', 'Duplicate'] } };
    const entries = greetingEntries(char,
        { first_mes: { text: '안녕' }, alt_greeting_1: { text: '오래된 자동 번역', source: 'Old' }, alt_greeting_9: { text: '남은 자동 번역' } },
        { alt_greeting_1: { text: '직접 추가', source: 'ALT' }, alt_greeting_8: { text: '남은 직접 추가' }, extra_1: { text: '직접 작성' } });
    const message = { mes: 'ALT', swipe_id: 0, swipes: ['ALT', 'Hello 독자', 'Duplicate', '직접 작성', 'ALT'], swipe_info: [{}, {}, {}, {}, { gen_started: 1 }] };
    assert.equal(greetingLinkCandidate(message, 0, entries).record.text, '직접 추가');
    assert.equal(greetingLinkCandidate(message, 1, entries).record.text, '안녕');
    assert.equal(resolveGreetingSwipe(message, 2, entries), undefined);
    assert.equal(resolveGreetingSwipe(message, 3, entries), undefined);
    assert.equal(resolveGreetingSwipe(message, 4, entries), undefined);
    assert.deepEqual(clone(entries.slice(-3).map(entry => entry.label)), ['ALT 8', 'ALT 9', '추가 1']);
    assert.equal(greetingLinkCandidate({ mes: 'ALT' }, 0, [{ key: 'first_mes', source: 'ALT', automatic: { text: 'stale', source: 'Old' } }]).status, '원문 변경');
    assert.equal(h.storage.displayGreetingText('{{user}} · {{char}} {{setvar::x::y}} {{newline}}'), '독자 · 테스트 {{setvar::x::y}} \n');
    assert.equal(message.mes, 'ALT');
    assert.equal(message.swipes[1], 'Hello 독자');
});

test('links track recorded source across index changes and expire when original or translation changes', () => {
    const { storage } = harness();
    const auto = { alt_greeting_1: { text: '한국어', source: 'Original' }, alt_greeting_2: { text: '과거 번역' } };
    const entries = storage.greetingEntries({ first_mes: 'Start', alternate_greetings: ['Other', 'Original'] }, auto);
    const message = { mes: 'Start', swipes: ['Start', 'Other', 'Original'] };
    const candidate = storage.greetingLinkCandidate(message, 2, entries);
    assert.equal(candidate.entry.key, 'alt_greeting_1');
    assert.equal(candidate.status, '원문 일치');
    const links = { 2: { avatar: 'target.png', source: candidate.source, key: candidate.entry.key, text: candidate.record.text } };
    assert.equal(storage.activeGreetingLink(message, 2, entries, links, 'target.png').text, '한국어');
    assert.equal(storage.activeGreetingLink(message, 2, entries, links, 'other.png'), undefined);
    assert.equal(storage.activeGreetingLink(message, 1, entries, links, 'target.png'), undefined);
    message.swipes[2] = 'Changed';
    assert.equal(storage.activeGreetingLink(message, 2, entries, links, 'target.png'), undefined);
    assert.equal(storage.greetingLinkCandidate(message, 2, entries).status, '원문 기록 없음');
    message.swipes[2] = 'Original';
    auto.alt_greeting_1.text = '수정됨';
    assert.equal(storage.activeGreetingLink(message, 2, entries, links, 'target.png'), undefined);
});
