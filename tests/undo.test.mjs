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
        structuredClone, TextEncoder, btoa, setTimeout, clearTimeout, characters: [],
        extension_settings: settings,
        jQuery: () => {},
        getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }),
        saveSettingsDebounced: () => {},
        toastr: { warning() {}, error() {}, success() {} },
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

test('macro preservation takes priority in the prompt without rejecting a changed macro', async () => {
    const { storage, context } = harness();
    const source = '{{user}} {{getvar:: Greeting }} {{user}}';
    let calls = 0;
    context.ConnectionManagerRequestService = {
        async sendRequest(profileId, prompt) {
            calls++;
            assert.match(prompt, /Highest-priority rule: Copy every SillyTavern macro/);
            assert.ok(prompt.indexOf('Highest-priority rule:') < prompt.indexOf('Rules:'));
            assert.ok(prompt.includes(source));
            return { content: '안녕하세요, {{char}}.' };
        },
    };
    assert.equal(await storage.translateWithProfile('profile', 'ALT 1', source), '안녕하세요, {{char}}.');
    assert.equal(calls, 1);
});

test('translating only ALT keeps the existing default greeting on disk', async () => {
    const h = harness();
    const firstMes = { text: '기존 기본 그리팅', translatedAt: 1 };
    await seed(h, 'char', { first_mes: firstMes });
    h.settings.peek.selectedFields = ['alternate_greetings'];
    h.settings.peek.profileId = 'profile';
    h.context.this_chid = 0;
    h.context.characters.push({ avatar: 'target.png', data: { first_mes: 'Default', alternate_greetings: ['Extra'] } });
    h.context.Popup = { show: { confirm: async () => true } };
    h.context.document = { getElementById: () => null, querySelector: () => null };
    h.context.renderTranslationPanel = () => {};
    h.context.ConnectionManagerRequestService = { sendRequest: async () => ({ content: '새 ALT 번역' }) };
    await h.storage.runTranslation();
    const { auto } = h.files.get(h.storage.entityFileName('char', 'target.png'));
    assert.deepEqual(auto.first_mes, firstMes);
    assert.equal(auto.alt_greeting_1.text, '새 ALT 번역');
});
