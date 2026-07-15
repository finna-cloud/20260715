const MODULE_ID = 'midnight_signal_app';
const ROOT_ID = 'msa-root';
const TOKEN_SETTINGS_KEY = 'token_usage_panel';
const TOKEN_CHAT_KEY = 'token_usage_panel_data';
const TOKEN_FETCH_GUARD = '__midnightSignalTokenFetchPatched';
const ROLEPLAY_CHAT_KEY = 'midnight_signal_roleplay_context';
const ROLEPLAY_PROMPT_KEY = 'midnight_signal_relationship_memory';
const ROLEPLAY_PROMPT_DEPTH = 4;
const ROLEPLAY_PROMPT_MAX_MEMORIES = 24;
const CHAT_MODEL_SELECTORS = Object.freeze({
    openai: 'model_openai_select', claude: 'model_claude_select', openrouter: 'model_openrouter_select',
    ai21: 'model_ai21_select', makersuite: 'model_google_select', vertexai: 'model_vertexai_select',
    mistralai: 'model_mistralai_select', custom: 'model_custom_select', cohere: 'model_cohere_select',
    perplexity: 'model_perplexity_select', groq: 'model_groq_select', siliconflow: 'model_siliconflow_select',
    minimax: 'model_minimax_select', electronhub: 'model_electronhub_select', chutes: 'model_chutes_select',
    nanogpt: 'model_nanogpt_select', deepseek: 'model_deepseek_select', aimlapi: 'model_aimlapi_select',
    xai: 'model_xai_select', pollinations: 'model_pollinations_select', cometapi: 'model_cometapi_select',
    moonshot: 'model_moonshot_select', fireworks: 'model_fireworks_select', azure_openai: 'azure_openai_model',
    zai: 'model_zai_select', workers_ai: 'model_workers_ai_select',
});
const DEFAULT_SETTINGS = Object.freeze({
    autoOpen: false,
    favorites: [],
    relationshipNotes: {},
    memories: {},
    compactMode: false,
    uiFontScale: 1,
    chatFontSize: 12,
    chatBackground: '',
});

let coreModulePromise;
let tokenizerModulePromise;
let personaModulePromise;
let activeView = 'home';
let selectedCharacterId = null;
let selectedProfileCharacterId = null;
let selectedPersonaId = null;
let characterSearchQuery = '';
let characterFilter = 'all';
let chatThreads = [];
let chatThreadsCharacterId = null;
let chatThreadsLoading = false;
let chatThreadsError = '';
const avatarRevisions = new Map();
let fullViewportHeight = 0;
let viewportFrame = 0;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function context() {
    return globalThis.SillyTavern?.getContext?.();
}

function settings() {
    const ctx = context();
    if (!ctx) return structuredClone(DEFAULT_SETTINGS);

    ctx.extensionSettings[MODULE_ID] ??= structuredClone(DEFAULT_SETTINGS);
    const value = ctx.extensionSettings[MODULE_ID];
    for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(value, key)) value[key] = structuredClone(fallback);
    }
    return value;
}

function saveSettings() {
    context()?.saveSettingsDebounced?.();
}

function emptyChatRoleplayState(character = null) {
    return {
        version: 1,
        characterKey: character ? characterKey(character) : '',
        relationshipNote: '',
        memories: [],
        migratedFromLegacy: false,
    };
}

function getChatRoleplayState() {
    const ctx = context();
    const current = getCurrentCharacter()?.character;
    if (!ctx?.chatMetadata || !current || ctx.groupId) return emptyChatRoleplayState(current);

    const activeCharacterKey = characterKey(current);
    let state = ctx.chatMetadata[ROLEPLAY_CHAT_KEY];
    if (!state || typeof state !== 'object' || (state.characterKey && state.characterKey !== activeCharacterKey)) {
        state = emptyChatRoleplayState(current);
        ctx.chatMetadata[ROLEPLAY_CHAT_KEY] = state;
    }
    state.version = 1;
    state.characterKey = activeCharacterKey;
    if (typeof state.relationshipNote !== 'string') state.relationshipNote = '';
    if (!Array.isArray(state.memories)) state.memories = [];

    if (!state.migratedFromLegacy) {
        const legacy = settings();
        if (!state.relationshipNote && typeof legacy.relationshipNotes?.[activeCharacterKey] === 'string') {
            state.relationshipNote = legacy.relationshipNotes[activeCharacterKey];
        }
        if (!state.memories.length && Array.isArray(legacy.memories?.[activeCharacterKey])) {
            state.memories = [...legacy.memories[activeCharacterKey]];
        }
        state.migratedFromLegacy = true;
        ctx.saveMetadataDebounced?.();
    }
    return state;
}

async function saveChatRoleplayState() {
    const ctx = context();
    if (typeof ctx?.saveMetadata === 'function') await ctx.saveMetadata();
    else ctx?.saveMetadataDebounced?.();
}

function buildRoleplayContextPrompt() {
    const current = getCurrentCharacter()?.character;
    if (!current || context()?.groupId) return '';
    const state = getChatRoleplayState();
    const relationship = state.relationshipNote.trim();
    const memories = state.memories
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .slice(0, ROLEPLAY_PROMPT_MAX_MEMORIES);
    if (!relationship && !memories.length) return '';

    return [
        `[Midnight Signal｜${characterName(current)}｜目前聊天室專屬資料]`,
        relationship ? `[關係狀態]\n${relationship}` : '',
        memories.length ? `[重要記憶]\n${memories.map(item => `- ${item}`).join('\n')}` : '',
        '[使用規則]\n以上是角色與玩家在目前聊天室中已成立的關係與共同經歷。回覆時應自然延續並避免矛盾；除非情境需要，不要逐條複述，也不要提及「提示詞」、「資料庫」或「記憶欄位」。',
    ].filter(Boolean).join('\n\n');
}

async function syncRoleplayContextPrompt() {
    const ctx = context();
    let setPrompt = ctx?.setExtensionPrompt;
    let promptTypes;
    let promptRoles;
    if (typeof setPrompt !== 'function') {
        const core = await getCoreModule();
        setPrompt = core.setExtensionPrompt;
        promptTypes = core.extension_prompt_types;
        promptRoles = core.extension_prompt_roles;
    }
    if (typeof setPrompt !== 'function') {
        console.warn('[Midnight Signal] SillyTavern extension prompt API is unavailable.');
        return false;
    }
    const prompt = buildRoleplayContextPrompt();
    const inChatPosition = promptTypes?.IN_CHAT ?? 1;
    const systemRole = promptRoles?.SYSTEM ?? 0;
    setPrompt.call(ctx, ROLEPLAY_PROMPT_KEY, prompt, inChatPosition, ROLEPLAY_PROMPT_DEPTH, false, systemRole);
    return true;
}

function getChatFontSize() {
    const value = Number(settings().chatFontSize);
    return Math.min(22, Math.max(10, Number.isFinite(value) ? value : 12));
}

function getUIFontScale() {
    const value = Number(settings().uiFontScale);
    return Math.min(1.4, Math.max(0.8, Number.isFinite(value) ? value : 1));
}

function applyVisualSettings(root = document.getElementById(ROOT_ID)) {
    if (!root) return;
    root.classList.toggle('msa-compact', settings().compactMode);
    root.style.setProperty('--msa-ui-font-scale', String(getUIFontScale()));
    root.style.setProperty('--msa-chat-font-size', `${getChatFontSize()}px`);
    const background = String(settings().chatBackground || '');
    const safeBackground = background.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    root.style.setProperty('--msa-chat-background-image', background ? `url("${safeBackground}")` : 'none');
    root.classList.toggle('msa-has-chat-background', Boolean(background));
}

function notify(message, type = 'info') {
    const toast = globalThis.toastr;
    if (toast?.[type]) toast[type](message, 'Midnight Signal');
    else console[type === 'error' ? 'error' : 'log'](`[Midnight Signal] ${message}`);
}

function escapeHtml(value = '') {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function excerpt(value = '', length = 64) {
    const plain = String(value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\{\{[^}]+\}\}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return plain.length > length ? `${plain.slice(0, length)}…` : plain;
}

function fullMessageText(value = '') {
    return String(value)
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<\/p\s*>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/\r\n?/g, '\n')
        .trim();
}

function emptyTokenUsage() {
    return {
        input: 0,
        output: 0,
        total: 0,
        requests: 0,
        userMessages: 0,
        lastInput: 0,
        lastOutput: 0,
        lastTotal: 0,
        chatTextTokens: 0,
        tokenizerStatus: '尚未計算',
        status: '等待生成',
    };
}

function ensureTokenUsage(value) {
    const defaults = emptyTokenUsage();
    for (const [key, fallback] of Object.entries(defaults)) {
        if (!Object.hasOwn(value, key)) value[key] = fallback;
    }
    return value;
}

function getGlobalTokenUsage() {
    const ctx = context();
    if (!ctx?.extensionSettings) return emptyTokenUsage();
    ctx.extensionSettings[TOKEN_SETTINGS_KEY] ??= emptyTokenUsage();
    return ensureTokenUsage(ctx.extensionSettings[TOKEN_SETTINGS_KEY]);
}

function getChatTokenUsage() {
    const ctx = context();
    if (!ctx?.chatMetadata) return emptyTokenUsage();
    ctx.chatMetadata[TOKEN_CHAT_KEY] ??= emptyTokenUsage();
    return ensureTokenUsage(ctx.chatMetadata[TOKEN_CHAT_KEY]);
}

function tokenNumberFrom(object, keys) {
    for (const key of keys) {
        const value = Number(object?.[key]);
        if (Number.isFinite(value) && value >= 0) return value;
    }
    return null;
}

function normalizeTokenUsage(object) {
    if (!object || typeof object !== 'object') return null;
    const input = tokenNumberFrom(object, ['prompt_tokens', 'input_tokens', 'promptTokenCount', 'prompt_eval_count']);
    const output = tokenNumberFrom(object, ['completion_tokens', 'output_tokens', 'candidatesTokenCount', 'eval_count']);
    let total = tokenNumberFrom(object, ['total_tokens', 'totalTokenCount']);
    if (input === null || output === null) return null;
    if (total === null) total = input + output;
    return { input, output, total };
}

function findTokenUsage(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    const direct = normalizeTokenUsage(value.usage ?? value.usageMetadata ?? value.timings ?? value);
    if (direct) return direct;
    for (const child of Object.values(value)) {
        const found = findTokenUsage(child, seen);
        if (found) return found;
    }
    return null;
}

function extractTokenUsage(text) {
    if (!text) return null;
    try {
        const found = findTokenUsage(JSON.parse(text));
        if (found) return found;
    } catch { /* Streaming or non-JSON response. */ }

    let latest = null;
    for (const rawLine of text.split(/\r?\n/)) {
        let line = rawLine.trim();
        if (line.startsWith('data:')) line = line.slice(5).trim();
        if (!line || line === '[DONE]') continue;
        try {
            const found = findTokenUsage(JSON.parse(line));
            if (found) latest = found;
        } catch { /* Ordinary streamed text. */ }
    }
    return latest;
}

function isTokenGenerationRequest(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    return method === 'POST' && /(?:\/generate(?:\?|$)|chat-completions\/generate|text-completions\/generate)/i.test(url);
}

function formatToken(value) {
    return Number(value || 0).toLocaleString('zh-TW');
}

function refreshTokenUi() {
    const chat = getChatTokenUsage();
    const global = getGlobalTokenUsage();
    const values = {
        'msa-token-home-chat': chat.total,
        'msa-token-home-last': chat.lastTotal,
        'msa-token-last-input': chat.lastInput,
        'msa-token-last-output': chat.lastOutput,
        'msa-token-last-total': chat.lastTotal,
        'msa-token-chat-total': chat.total,
        'msa-token-global-total': global.total,
        'msa-token-requests': chat.requests,
        'msa-token-user-messages': chat.userMessages,
        'msa-token-chat-estimate': chat.chatTextTokens,
    };
    for (const [id, value] of Object.entries(values)) {
        const element = document.getElementById(id);
        if (element) element.textContent = formatToken(value);
    }
    const status = document.getElementById('msa-token-status');
    if (status) status.textContent = chat.status;
    const tokenizerStatus = document.getElementById('msa-tokenizer-status');
    if (tokenizerStatus) tokenizerStatus.textContent = chat.tokenizerStatus;
}

async function saveTokenState() {
    const ctx = context();
    ctx?.saveSettingsDebounced?.();
    await ctx?.saveMetadata?.();
}

async function recordTokenUsage(usage) {
    const global = getGlobalTokenUsage();
    const chat = getChatTokenUsage();
    for (const target of [global, chat]) {
        target.input += usage.input;
        target.output += usage.output;
        target.total += usage.total;
        target.requests += 1;
        target.lastInput = usage.input;
        target.lastOutput = usage.output;
        target.lastTotal = usage.total;
        target.status = 'API 精確數據';
    }
    await saveTokenState();
    refreshTokenUi();
}

async function recordTokenUserMessage() {
    getGlobalTokenUsage().userMessages += 1;
    getChatTokenUsage().userMessages += 1;
    await saveTokenState();
    refreshTokenUi();
}

function markTokenUnavailable() {
    getGlobalTokenUsage().status = 'API 未回傳 usage';
    getChatTokenUsage().status = 'API 未回傳 usage';
    context()?.saveSettingsDebounced?.();
    refreshTokenUi();
}

function installTokenTracker() {
    if (globalThis[TOKEN_FETCH_GUARD]) return;

    const existingTokenPanel = document.getElementById('token-usage-panel');
    const existingTokenFetch = String(globalThis.fetch?.name || '').includes('tokenUsageFetch');
    if (existingTokenPanel || existingTokenFetch) {
        console.info('[Midnight Signal] Reusing API Token 用量面板 data.');
        return;
    }

    const originalFetch = globalThis.fetch?.bind(globalThis);
    if (typeof originalFetch !== 'function') return;
    globalThis[TOKEN_FETCH_GUARD] = true;

    globalThis.fetch = async function midnightSignalTokenFetch(input, init) {
        const response = await originalFetch(input, init);
        if (!isTokenGenerationRequest(input, init)) return response;

        response.clone().text()
            .then(extractTokenUsage)
            .then(usage => usage ? recordTokenUsage(usage) : markTokenUnavailable())
            .catch(markTokenUnavailable);
        return response;
    };

    const ctx = context();
    const messageSent = ctx?.eventTypes?.MESSAGE_SENT || ctx?.event_types?.MESSAGE_SENT;
    if (messageSent) ctx.eventSource?.on?.(messageSent, recordTokenUserMessage);
}

function getCharacters() {
    return (context()?.characters || [])
        .map((character, id) => ({ character, id }))
        .filter(({ character }) => character && (character.name || character.data?.name));
}

function getCurrentCharacter() {
    const ctx = context();
    const hasCharacterId = ctx?.characterId !== undefined && ctx?.characterId !== null && Number.isInteger(Number(ctx.characterId));
    const id = hasCharacterId ? Number(ctx.characterId) : selectedCharacterId;
    return ctx?.characters?.[id] ? { character: ctx.characters[id], id } : null;
}

function currentChatName() {
    const ctx = context();
    const current = getCurrentCharacter();
    return String(ctx?.chatId || current?.character?.chat || '').replace(/\.jsonl$/i, '');
}

function chatThreadFileName(chat) {
    return String(chat?.file_name || chat?.file_id || '').replace(/\.jsonl$/i, '');
}

function chatThreadTimestamp(chat) {
    const value = chat?.last_mes;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatChatThreadTime(chat) {
    const timestamp = chatThreadTimestamp(chat);
    if (!timestamp) return '尚無時間';
    try {
        return new Intl.DateTimeFormat('zh-TW', {
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(new Date(timestamp));
    } catch {
        return '最近使用';
    }
}

function characterName(character) {
    return character?.name || character?.data?.name || '尚未選擇角色';
}

function characterKey(character) {
    return character?.avatar || character?.data?.avatar || characterName(character);
}

function avatarUrl(character) {
    const avatar = character?.avatar || character?.data?.avatar;
    if (!avatar || avatar === 'none') return '';
    const ctx = context();
    if (typeof ctx?.getThumbnailUrl === 'function') return ctx.getThumbnailUrl('avatar', avatar);
    return `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
}

function originalAvatarUrl(character) {
    const avatar = character?.avatar || character?.data?.avatar;
    if (!avatar || avatar === 'none') return '';
    const revision = avatarRevisions.get(String(avatar));
    return `/characters/${encodeURIComponent(avatar)}${revision ? `?t=${revision}` : ''}`;
}

function getGreetings(character) {
    if (!character) return [];
    const first = character.first_mes ?? character.data?.first_mes ?? '';
    const alternates = character.data?.alternate_greetings ?? character.alternate_greetings ?? [];
    return [first, ...(Array.isArray(alternates) ? alternates : [])].filter(value => String(value).trim());
}

function getLatestMessage() {
    const chat = context()?.chat || [];
    return [...chat].reverse().find(message => !message?.is_system)?.mes || '選擇角色，開始一段新的對話。';
}

function getChatModelControl() {
    const ctx = context();
    const source = ctx?.chatCompletionSettings?.chat_completion_source || document.getElementById('chat_completion_source')?.value || '';
    let control = document.getElementById(CHAT_MODEL_SELECTORS[source]);
    if (source === 'custom' && (!control || !control.options?.length)) control = document.getElementById('custom_model_id');
    const selected = control?.tagName === 'SELECT' ? control.selectedOptions?.[0] : null;
    const label = selected?.textContent?.trim() || control?.value || '尚未選擇模型';
    return { source, control, label };
}

function getChatPresetControl() {
    const control = document.getElementById('settings_preset_openai');
    const label = control?.selectedOptions?.[0]?.textContent?.trim() || control?.value || '尚未選擇預設';
    return { control, label };
}

function getCoreModule() {
    coreModulePromise ??= import('/script.js').catch(error => {
        console.warn('[Midnight Signal] Unable to import core module.', error);
        return {};
    });
    return coreModulePromise;
}

function getTokenizerModule() {
    tokenizerModulePromise ??= import('/scripts/tokenizers.js').catch(error => {
        console.warn('[Midnight Signal] Unable to import tokenizer module.', error);
        return {};
    });
    return tokenizerModulePromise;
}

function getPersonaModule() {
    personaModulePromise ??= import('/scripts/personas.js').catch(error => {
        console.warn('[Midnight Signal] Unable to import persona module.', error);
        return {};
    });
    return personaModulePromise;
}

async function getPersonaRuntime() {
    const ctx = context();
    const personaModule = await getPersonaModule();
    const powerUser = ctx?.powerUserSettings || {};
    powerUser.personas ??= {};
    powerUser.persona_descriptions ??= {};

    const selectedFromDom = document.querySelector('#user_avatar_block .avatar-container.selected')?.getAttribute('data-avatar-id');
    const selectedByName = Object.keys(powerUser.personas).find(id => powerUser.personas[id] === ctx?.name1);
    const currentId = personaModule.user_avatar || selectedPersonaId || selectedFromDom || selectedByName || Object.keys(powerUser.personas)[0] || '';
    return { ctx, personaModule, powerUser, currentId };
}

function personaAvatarUrl(id) {
    if (!id) return '';
    const ctx = context();
    if (typeof ctx?.getThumbnailUrl === 'function') return ctx.getThumbnailUrl('persona', id);
    return `/thumbnail?type=persona&file=${encodeURIComponent(id)}`;
}

async function calculateCurrentChatTokens() {
    const ctx = context();
    const usage = getChatTokenUsage();
    const chatText = (ctx?.chat || [])
        .filter(message => !message?.is_system)
        .map(message => `${message?.name || ''}: ${message?.mes || ''}`)
        .join('\n');

    if (!chatText.trim()) {
        usage.chatTextTokens = 0;
        usage.tokenizerStatus = '目前聊天沒有內容';
        refreshTokenUi();
        return 0;
    }

    try {
        let counter = ctx?.getTokenCountAsync;
        if (typeof counter !== 'function') {
            const tokenizer = await getTokenizerModule();
            counter = tokenizer.getTokenCountAsync;
        }
        if (typeof counter !== 'function') throw new Error('Tokenizer API unavailable');
        usage.chatTextTokens = await counter.call(ctx, chatText, 0);
        usage.tokenizerStatus = 'SillyTavern tokenizer 計算';
        await ctx?.saveMetadata?.();
        refreshTokenUi();
        return usage.chatTextTokens;
    } catch (error) {
        usage.tokenizerStatus = '無法啟用 SillyTavern tokenizer';
        refreshTokenUi();
        console.warn('[Midnight Signal] Chat token calculation failed.', error);
        return null;
    }
}

async function selectCharacter(id) {
    const ctx = context();
    if (!ctx?.characters?.[id]) throw new Error('找不到所選角色。');
    if (ctx.groupId) throw new Error('目前是群組聊天，請先切換到單人角色聊天。');

    selectedCharacterId = Number(id);
    if (Number(ctx.characterId) === Number(id)) return;

    let select = ctx.selectCharacterById;
    if (typeof select !== 'function') {
        const core = await getCoreModule();
        select = core.selectCharacterById;
    }
    if (typeof select === 'function') {
        await select.call(ctx, Number(id));
    } else {
        const card = document.querySelector(`.character_select[chid="${id}"], .character_select[data-chid="${id}"]`);
        if (!card) throw new Error('這個 SillyTavern 版本沒有提供角色切換介面。');
        card.click();
    }

    for (let attempt = 0; attempt < 12; attempt++) {
        if (Number(context()?.characterId) === Number(id)) break;
        await sleep(100);
    }
}

async function fetchCharacterChatThreads(characterId) {
    const ctx = context();
    const character = ctx?.characters?.[Number(characterId)];
    if (!character) throw new Error('找不到所選角色。');

    const core = await getCoreModule();
    let chats;
    if (typeof core.getPastCharacterChats === 'function') {
        chats = await core.getPastCharacterChats(Number(characterId));
    } else {
        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: await getAppRequestHeaders(),
            body: JSON.stringify({ avatar_url: character.avatar || character.data?.avatar }),
            cache: 'no-cache',
        });
        if (!response.ok) throw new Error('無法讀取聊天室清單。');
        const data = await response.json();
        if (data?.error) throw new Error('聊天室清單回傳錯誤。');
        chats = Object.values(data || {});
    }

    return (Array.isArray(chats) ? chats : [])
        .filter(chat => chatThreadFileName(chat))
        .sort((a, b) => chatThreadTimestamp(b) - chatThreadTimestamp(a));
}

async function loadCharacterChatThreads(characterId = context()?.characterId, { showLoading = true } = {}) {
    const id = Number(characterId);
    if (!Number.isInteger(id) || !context()?.characters?.[id]) {
        chatThreads = [];
        chatThreadsCharacterId = null;
        chatThreadsError = '請先選擇一名角色。';
        chatThreadsLoading = false;
        if (activeView === 'threads') render('threads');
        return [];
    }

    chatThreadsCharacterId = id;
    chatThreadsError = '';
    chatThreadsLoading = true;
    if (showLoading && activeView === 'threads') render('threads');

    try {
        const result = await fetchCharacterChatThreads(id);
        if (chatThreadsCharacterId !== id) return result;
        chatThreads = result;
        return result;
    } catch (error) {
        if (chatThreadsCharacterId === id) {
            chatThreads = [];
            chatThreadsError = error.message || '無法讀取聊天室清單。';
        }
        console.error('[Midnight Signal] Failed to load character chats.', error);
        return [];
    } finally {
        if (chatThreadsCharacterId === id) chatThreadsLoading = false;
        if (activeView === 'threads' && Number(context()?.characterId) === id) render('threads');
    }
}

async function openCharacterThreads(characterId = context()?.characterId) {
    const id = Number(characterId);
    if (!Number.isInteger(id) || !context()?.characters?.[id]) {
        notify('請先選擇一名角色。', 'warning');
        render('home');
        return;
    }

    if (Number(context()?.characterId) !== id) await selectCharacter(id);
    selectedCharacterId = id;
    selectedProfileCharacterId = id;
    chatThreadsCharacterId = id;
    chatThreads = [];
    chatThreadsError = '';
    render('threads');
    await loadCharacterChatThreads(id);
}

async function openChatThread(fileName) {
    const name = String(fileName || '').replace(/\.jsonl$/i, '').trim();
    if (!name || !getCurrentCharacter()) return;

    if (name !== currentChatName()) {
        const ctx = context();
        const core = await getCoreModule();
        const open = ctx?.openCharacterChat || core.openCharacterChat;
        if (typeof open !== 'function') throw new Error('此版本無法切換聊天室。');
        await open.call(ctx, name);
    }

    await syncRoleplayContextPrompt();
    render('messages');
}

async function createNewCharacterChat() {
    if (!getCurrentCharacter()) {
        notify('請先選擇一名角色。', 'warning');
        return;
    }
    const core = await getCoreModule();
    if (typeof core.doNewChat !== 'function') throw new Error('此版本無法建立新聊天室。');
    await core.doNewChat({ deleteCurrentChat: false });
    chatThreads = [];
    chatThreadsError = '';
    await syncRoleplayContextPrompt();
    render('messages');
    notify('已建立新的獨立聊天室。', 'success');
}

async function applyGreeting(index) {
    const current = getCurrentCharacter();
    const ctx = context();
    if (!current) throw new Error('請先選擇一名角色。');

    const greetings = getGreetings(current.character);
    const greeting = greetings[index];
    if (!greeting) throw new Error('找不到這個開場白。');
    if (!ctx.chat?.[0] || ctx.chat[0].is_user) throw new Error('目前聊天沒有可替換的角色開場白。');

    const firstMessage = ctx.chat[0];
    firstMessage.swipes = [...greetings];
    firstMessage.swipe_id = Number(index);
    firstMessage.mes = greeting;
    firstMessage.name = characterName(current.character);

    let core = {};
    let save = ctx.saveChat;
    if (typeof save !== 'function') {
        core = await getCoreModule();
        save = core.saveChatConditional;
    }
    if (typeof save === 'function') await save.call(ctx);

    let reload = ctx.reloadCurrentChat || core.reloadCurrentChat;
    if (typeof reload !== 'function') {
        core = await getCoreModule();
        reload = core.reloadCurrentChat;
    }
    if (typeof reload === 'function') {
        await reload.call(ctx);
    } else {
        const text = document.querySelector('#chat .mes[mesid="0"] .mes_text');
        if (text) text.textContent = greeting;
        ctx.eventSource?.emit?.(ctx.event_types?.MESSAGE_SWIPED, 0);
    }
}

function icon(name) {
    return `<i class="fa-solid fa-${name}" aria-hidden="true"></i>`;
}

function launcherMarkup() {
    return `
        <button id="msa-launcher" type="button" aria-label="開啟 Midnight Signal APP" title="Midnight Signal APP">
            ${icon('mobile-screen-button')}<span>手機</span>
        </button>`;
}

function shellMarkup() {
    return `
        <div id="${ROOT_ID}" class="msa-hidden" aria-hidden="true">
            <div class="msa-backdrop" data-action="close"></div>
            <section class="msa-phone" role="dialog" aria-modal="true" aria-label="Midnight Signal APP">
                <div class="msa-app-scroll">
                    <header class="msa-header">
                        <button class="msa-brand" type="button" data-nav="home" aria-label="回到探索首頁">
                            <span class="msa-brand-mark">${icon('signal')}</span>
                            <span><strong>MIDNIGHT</strong><small>角色訊號站</small></span>
                        </button>
                        <div class="msa-header-actions">
                            <button class="msa-current-character" type="button" data-action="current-profile" aria-label="查看目前角色主頁"><span class="msa-avatar msa-avatar-current"></span></button>
                            <button class="msa-icon-button" type="button" data-action="notifications" aria-label="通知">${icon('bell')}<span class="msa-notification-dot"></span></button>
                            <button class="msa-close" type="button" data-action="close" aria-label="關閉">${icon('xmark')}</button>
                        </div>
                    </header>
                    <main id="msa-content"></main>
                </div>
                <nav class="msa-bottom-nav" aria-label="APP 導覽">
                    <button type="button" data-nav="home">${icon('compass')}<span>探索</span></button>
                    <button type="button" data-nav="cards">${icon('address-card')}<span>角色</span></button>
                    <button class="msa-nav-chat" type="button" data-nav="messages">${icon('comment-dots')}<span>對話</span></button>
                    <button type="button" data-nav="favorites">${icon('heart')}<span>收藏</span></button>
                    <button type="button" data-nav="settings">${icon('sliders')}<span>設定</span></button>
                </nav>
            </section>
            <div id="msa-sheet" class="msa-sheet msa-hidden" aria-hidden="true"></div>
        </div>`;
}

function exploreCharacterCardMarkup({ character, id }) {
    const favorite = settings().favorites.includes(characterKey(character));
    const greetingCount = getGreetings(character).length;
    const searchText = [characterName(character), character.description, character.data?.description, character.personality, character.data?.personality].filter(Boolean).join(' ').toLocaleLowerCase('zh-Hant');
    return `
        <article class="msa-explore-card" data-character-search="${escapeHtml(searchText)}" data-character-favorite="${favorite}" data-character-multiple="${greetingCount > 1}">
            <button class="msa-explore-cover" type="button" data-profile-character-id="${id}" style="--msa-card-avatar:url(&quot;${escapeHtml(originalAvatarUrl(character))}&quot;)">
                <span class="msa-explore-cover-shade"></span>
                <span class="msa-explore-badges"><b>${icon('message')} ${greetingCount}</b>${favorite ? `<b class="is-favorite">${icon('heart')}</b>` : ''}</span>
                <span class="msa-explore-title"><strong>${escapeHtml(characterName(character))}</strong><small>查看角色主頁</small></span>
            </button>
            <div class="msa-explore-card-copy">
                <p>${escapeHtml(excerpt(character.description || character.data?.description || '等待你探索這名角色的故事。', 70))}</p>
                <div>
                    <button type="button" data-start-character-id="${id}">${icon('comment-dots')} 開始對話</button>
                    <button class="msa-explore-favorite ${favorite ? 'is-favorite' : ''}" type="button" data-favorite-id="${id}" aria-label="${favorite ? '取消收藏' : '加入收藏'}">${icon('heart')}</button>
                </div>
            </div>
        </article>`;
}

function homeMarkup() {
    const current = getCurrentCharacter();
    const character = current?.character;
    const name = characterName(character);
    const characters = getCharacters();
    const messages = (context()?.chat || []).filter(message => !message?.is_system).length;
    const currentAvatar = originalAvatarUrl(character);
    const tokenUsage = getChatTokenUsage();
    return `
        <section class="msa-home msa-discover-home">
            <div class="msa-discover-heading">
                <span><small>DISCOVER CHARACTERS</small><strong>今天想和誰聊？</strong></span>
                <button type="button" data-nav="cards">${icon('plus')} 新增角色</button>
            </div>

            <label class="msa-character-search">${icon('magnifying-glass')}<input id="msa-character-search" type="search" value="${escapeHtml(characterSearchQuery)}" placeholder="搜尋角色名稱或設定……" autocomplete="off"><kbd>${characters.length}</kbd></label>

            <div class="msa-character-filters" role="group" aria-label="角色篩選">
                <button class="${characterFilter === 'all' ? 'is-active' : ''}" type="button" data-character-filter="all">全部角色</button>
                <button class="${characterFilter === 'favorites' ? 'is-active' : ''}" type="button" data-character-filter="favorites">${icon('heart')} 已收藏</button>
                <button class="${characterFilter === 'multiple' ? 'is-active' : ''}" type="button" data-character-filter="multiple">多開場</button>
            </div>

            <article class="msa-current-session" style="--msa-current-avatar:url(&quot;${escapeHtml(currentAvatar)}&quot;)">
                <span class="msa-current-session-shade"></span>
                <div class="msa-current-session-copy"><small><b></b> CURRENT SIGNAL</small><strong>${escapeHtml(name)}</strong><p>${escapeHtml(excerpt(getLatestMessage(), 76))}</p></div>
                <div class="msa-current-session-stats">
                    <span><b>${messages}</b> 則訊息</span>
                    <button class="msa-session-token-button" type="button" data-action="tokens" aria-label="開啟 TOKEN USAGE 實際用量明細">
                        <span><small>ACTUAL API TOKENS</small><strong>TOKEN USAGE</strong></span>
                        <b><small>聊天累計 / 本次</small><strong><span id="msa-token-home-chat">${formatToken(tokenUsage.total)}</span> / <span id="msa-token-home-last">${formatToken(tokenUsage.lastTotal)}</span></strong></b>
                        ${icon('chevron-right')}
                    </button>
                </div>
            </article>

            <div class="msa-section-heading"><span><small>CHARACTER FEED</small><strong>角色卡</strong></span><output id="msa-character-result-count">${characters.length} 位角色</output></div>
            <div class="msa-explore-grid">${characters.length ? characters.map(exploreCharacterCardMarkup).join('') : ''}</div>
            <div id="msa-character-filter-empty" class="msa-character-filter-empty" ${characters.length ? 'hidden' : ''}>${icon('ghost')}<strong>沒有符合的角色</strong><span>調整搜尋或匯入新的角色卡。</span></div>
        </section>`;
}

function emptyMarkup(title, message) {
    return `<div class="msa-empty">${icon('moon')}<strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p></div>`;
}

function favoritesMarkup() {
    const favoriteKeys = settings().favorites;
    const matches = getCharacters().filter(({ character }) => favoriteKeys.includes(characterKey(character)));
    if (!matches.length) return emptyMarkup('還沒有收藏角色', '在角色選擇頁點擊星號，即可將角色加入收藏。');
    return `
        <section class="msa-page">
            <div class="msa-page-title"><span><small>FAVORITES</small><strong>收藏角色</strong></span></div>
            <div class="msa-character-list">${matches.map(characterCardMarkup).join('')}</div>
        </section>`;
}

function characterManagementMarkup() {
    const characters = getCharacters();
    return `
        <section class="msa-page msa-card-manager-page">
            <div class="msa-page-title"><span><small>CHARACTER CARDS</small><strong>角色卡管理</strong></span></div>
            <div class="msa-card-actions">
                <button type="button" data-action="import-character">${icon('file-import')}<span><strong>匯入角色卡</strong><small>PNG、JSON、YAML、CHARX、BYAF</small></span></button>
                <button type="button" data-action="new-character">${icon('user-plus')}<span><strong>新增角色卡</strong><small>直接建立基本角色資料</small></span></button>
            </div>
            <p class="msa-card-manager-note">角色封面可重新上傳高畫質原圖，不會在瀏覽器端壓縮；刪除角色卡時會保留原有聊天紀錄。</p>
            <div class="msa-managed-card-list">${characters.length ? characters.map(({ character, id }) => `
                <article class="msa-managed-card ${Number(context()?.characterId) === id ? 'is-current' : ''}">
                    <button type="button" class="msa-managed-card-main" data-character-id="${id}">
                        <span class="msa-avatar" style="--msa-avatar-url:url('${escapeHtml(avatarUrl(character))}')"></span>
                        <span><strong>${escapeHtml(characterName(character))}</strong><small>${escapeHtml(excerpt(character.description || character.data?.description || '尚未填寫角色描述', 58))}</small></span>
                    </button>
                    <button type="button" class="msa-managed-card-upload" data-upload-character-avatar="${id}" aria-label="替換 ${escapeHtml(characterName(character))} 的高畫質封面" title="重新上傳高畫質封面">${icon('image')}<span>換圖</span></button>
                    <button type="button" class="msa-managed-card-delete" data-delete-character="${id}" aria-label="刪除 ${escapeHtml(characterName(character))}">${icon('trash-can')}</button>
                </article>`).join('') : '<div class="msa-card-manager-empty">目前沒有角色卡，可從上方匯入或新增。</div>'}</div>
        </section>`;
}

function getProfileCharacter() {
    const characters = context()?.characters || [];
    const hasSelectedProfile = selectedProfileCharacterId !== null
        && selectedProfileCharacterId !== undefined
        && Number.isInteger(Number(selectedProfileCharacterId));
    const id = hasSelectedProfile ? Number(selectedProfileCharacterId) : Number(context()?.characterId);
    const character = characters[id];
    return character ? { character, id } : null;
}

function profileTabsMarkup(activeTab = 'profile') {
    return `<div class="msa-profile-tabs" role="tablist" aria-label="角色頁面">
        <button class="${activeTab === 'profile' ? 'is-active' : ''}" type="button" data-action="profile" role="tab" aria-selected="${activeTab === 'profile'}">角色資料</button>
        <button class="${activeTab === 'relationship' ? 'is-active' : ''}" type="button" data-action="relationship" role="tab" aria-selected="${activeTab === 'relationship'}">關係狀態</button>
        <button class="${activeTab === 'memories' ? 'is-active' : ''}" type="button" data-action="memories" role="tab" aria-selected="${activeTab === 'memories'}">重要記憶</button>
    </div>`;
}

function characterProfileMarkup() {
    const selected = getProfileCharacter();
    if (!selected) return emptyMarkup('找不到角色卡', '請回到主頁重新選擇角色。');
    const { character, id } = selected;
    const description = character.description || character.data?.description || '尚未填寫角色描述。';
    const personality = character.personality || character.data?.personality || '尚未填寫性格。';
    const scenario = character.scenario || character.data?.scenario || '尚未填寫場景。';
    const firstMessage = character.first_mes || character.data?.first_mes || '尚未設定開場白。';
    const greetingCount = getGreetings(character).length;
    const favorite = settings().favorites.includes(characterKey(character));
    return `
        <section class="msa-page msa-character-profile">
            <div class="msa-profile-topbar"><button type="button" data-nav="home">${icon('arrow-left')} 探索</button><div><button type="button" data-upload-character-avatar="${id}">${icon('image')} 高畫質換圖</button><button class="${favorite ? 'is-favorite' : ''}" type="button" data-favorite-id="${id}">${icon('heart')} ${favorite ? '已收藏' : '收藏'}</button></div></div>
            <div class="msa-profile-cover">
                <span class="msa-profile-cover-art" style="--msa-profile-avatar:url(&quot;${escapeHtml(originalAvatarUrl(character))}&quot;)"></span>
                <span class="msa-profile-cover-shade"></span>
                <span class="msa-profile-cover-copy"><small>CHARACTER PROFILE</small><strong>${escapeHtml(characterName(character))}</strong><em>${escapeHtml(excerpt(personality, 48))}</em></span>
                <span class="msa-profile-counts"><b>${icon('comment-dots')} ${greetingCount} 個開場</b><b>${icon('signal')} ONLINE</b></span>
            </div>
            <div class="msa-profile-actions">
                <button class="is-primary" type="button" data-start-character-id="${id}">${icon('comment-dots')} 與角色對話</button>
                <button type="button" data-profile-greetings-id="${id}">${icon('shuffle')} 選擇開場白</button>
            </div>
            ${profileTabsMarkup('profile')}
            <article class="msa-profile-section"><small>${icon('address-card')} DESCRIPTION</small><strong>角色設定</strong><p>${escapeHtml(fullMessageText(description))}</p></article>
            <div class="msa-profile-detail-grid">
                <article class="msa-profile-section"><small>${icon('fingerprint')} PERSONALITY</small><strong>性格</strong><p>${escapeHtml(fullMessageText(personality))}</p></article>
                <article class="msa-profile-section"><small>${icon('earth-americas')} SCENARIO</small><strong>場景</strong><p>${escapeHtml(fullMessageText(scenario))}</p></article>
            </div>
            <article class="msa-profile-section is-first-message"><small>${icon('quote-left')} FIRST MESSAGE</small><strong>預設開場白</strong><p>${escapeHtml(fullMessageText(firstMessage))}</p></article>
        </section>`;
}

function settingsMarkup() {
    const value = settings();
    const uiFontPercent = Math.round(getUIFontScale() * 100);
    const chatFontSize = getChatFontSize();
    return `
        <section class="msa-page">
            <div class="msa-page-title"><span><small>SETTINGS</small><strong>介面設定</strong></span></div>
            <label class="msa-setting-row">
                <span><strong>啟動時自動開啟</strong><small>載入 SillyTavern 後顯示 APP</small></span>
                <input type="checkbox" data-setting="autoOpen" ${value.autoOpen ? 'checked' : ''}>
            </label>
            <label class="msa-setting-row">
                <span><strong>緊湊模式</strong><small>縮小按鈕與區塊間距</small></span>
                <input type="checkbox" data-setting="compactMode" ${value.compactMode ? 'checked' : ''}>
            </label>
            <label class="msa-setting-row msa-font-setting msa-ui-font-setting">
                <span><strong>UI 介面字體</strong><small>調整按鈕、標題、角色卡與設定文字，不影響聊天訊息</small></span>
                <output id="msa-ui-font-value" for="msa-ui-font-size">${uiFontPercent}%</output>
                <input id="msa-ui-font-size" type="range" min="80" max="140" step="5" value="${uiFontPercent}" data-setting="uiFontScale" aria-label="UI 介面字體大小">
                <span class="msa-ui-font-preview"><b>介面文字預覽</b><em>按鈕與標題會依此比例顯示</em></span>
            </label>
            <label class="msa-setting-row msa-font-setting">
                <span><strong>聊天室訊息字體</strong><small>調整訊息泡泡內的文字大小</small></span>
                <output id="msa-chat-font-value" for="msa-chat-font-size">${chatFontSize} px</output>
                <input id="msa-chat-font-size" type="range" min="10" max="22" step="1" value="${chatFontSize}" data-setting="chatFontSize" aria-label="聊天室訊息字體大小">
                <span class="msa-font-preview">這是一段聊天室訊息大小預覽。</span>
            </label>
            <button class="msa-background-setting-button" type="button" data-action="chat-background">
                <span class="msa-background-setting-icon">${icon('image')}</span>
                <span><strong>聊天室背景</strong><small>${value.chatBackground ? '已套用自訂背景，可隨時替換' : '上傳圖片並套用到訊息區域'}</small></span>
                ${icon('chevron-right')}
            </button>
            <button class="msa-danger-button" type="button" data-action="reset-data">${icon('rotate-left')} 清除 APP 筆記資料</button>
            <p class="msa-version">Midnight Signal APP · v2.4.4</p>
        </section>`;
}

function characterCardMarkup({ character, id }) {
    const key = characterKey(character);
    const favorite = settings().favorites.includes(key);
    return `
        <div class="msa-character-card ${Number(context()?.characterId) === id ? 'is-current' : ''}">
            <button type="button" class="msa-character-main" data-character-id="${id}">
                <span class="msa-avatar" style="--msa-avatar-url:url('${escapeHtml(avatarUrl(character))}')"></span>
                <span><strong>${escapeHtml(characterName(character))}</strong><small>${getGreetings(character).length} 個開場白</small></span>
            </button>
            <button type="button" class="msa-favorite-toggle ${favorite ? 'is-favorite' : ''}" data-favorite-id="${id}" aria-label="切換收藏">${icon('star')}</button>
        </div>`;
}

function conversationsMarkup() {
    const characters = getCharacters();
    const currentId = Number(context()?.characterId);
    return `
        <section class="msa-page msa-conversations-page">
            <div class="msa-conversations-heading">
                <span><small>CONVERSATIONS</small><strong>選擇對話角色</strong><em>點選角色後，再選擇該角色的聊天室</em></span>
                <button type="button" data-nav="cards">${icon('plus')} 角色</button>
            </div>
            <div class="msa-conversation-role-list">${characters.length ? characters.map(({ character, id }) => `
                <article class="msa-conversation-role ${id === currentId ? 'is-current' : ''}">
                    <button type="button" data-conversation-character-id="${id}">
                        <span class="msa-conversation-role-art">${originalAvatarUrl(character) ? `<img src="${escapeHtml(originalAvatarUrl(character))}" alt="" loading="lazy" decoding="async">` : icon('user')}</span>
                        <span class="msa-conversation-role-copy">
                            <strong>${escapeHtml(characterName(character))}</strong>
                        </span>
                    </button>
                </article>`).join('') : '<div class="msa-thread-state"><i class="fa-solid fa-user-slash"></i><strong>還沒有角色</strong><span>請先匯入或新增角色卡。</span><button type="button" data-nav="cards">前往角色管理</button></div>'}</div>
        </section>`;
}

function chatThreadsMarkup() {
    const current = getCurrentCharacter();
    if (!current) return emptyMarkup('尚未選擇角色', '請先回到探索頁選擇想要對話的角色。');

    const isLoadedCharacter = chatThreadsCharacterId === current.id;
    const items = isLoadedCharacter ? chatThreads : [];
    const activeChat = currentChatName();
    const avatar = originalAvatarUrl(current.character);
    const list = chatThreadsLoading && !items.length
        ? `<div class="msa-thread-state">${icon('spinner')}<strong>正在讀取聊天室</strong><span>整理 ${escapeHtml(characterName(current.character))} 的對話紀錄……</span></div>`
        : chatThreadsError
            ? `<div class="msa-thread-state is-error">${icon('triangle-exclamation')}<strong>無法讀取聊天室</strong><span>${escapeHtml(chatThreadsError)}</span><button type="button" data-action="reload-chat-threads">重新讀取</button></div>`
            : items.length
                ? items.map(chat => {
                    const fileName = chatThreadFileName(chat);
                    const isCurrent = fileName === activeChat;
                    const messages = Math.max(0, Number(chat.chat_items) || 0);
                    const preview = excerpt(chat.mes || '這個聊天室還沒有訊息。', 88);
                    return `
                        <article class="msa-thread-card ${isCurrent ? 'is-current' : ''}">
                            <button class="msa-thread-main" type="button" data-open-chat-file="${escapeHtml(fileName)}" aria-label="開啟聊天室 ${escapeHtml(fileName)}">
                                <span class="msa-thread-status">${icon(isCurrent ? 'signal' : 'comment-dots')}</span>
                                <span class="msa-thread-copy">
                                    <span class="msa-thread-title"><strong>${escapeHtml(fileName)}</strong>${isCurrent ? '<b>目前</b>' : ''}</span>
                                    <small>${escapeHtml(preview)}</small>
                                    <span class="msa-thread-meta"><b>${messages} 則訊息</b><time>${escapeHtml(formatChatThreadTime(chat))}</time></span>
                                </span>
                                ${icon('chevron-right')}
                            </button>
                            <button class="msa-thread-rename" type="button" data-rename-chat-file="${escapeHtml(fileName)}" aria-label="重新命名 ${escapeHtml(fileName)}" title="重新命名聊天室">${icon('pen')}</button>
                        </article>`;
                }).join('')
                : `<div class="msa-thread-state">${icon('comment-slash')}<strong>還沒有聊天室</strong><span>建立第一個聊天室，關係狀態與重要記憶會獨立保存。</span><button type="button" data-action="new-chat">建立聊天室</button></div>`;

    return `
        <section class="msa-page msa-threads-page">
            <div class="msa-threads-topbar">
                <button type="button" data-action="conversation-hub">${icon('arrow-left')} 對話</button>
                <button class="is-primary" type="button" data-action="new-chat">${icon('plus')} 新增聊天室</button>
            </div>
            <div class="msa-threads-hero" style="--msa-thread-avatar:url(&quot;${escapeHtml(avatar)}&quot;)">
                <span class="msa-threads-hero-art"></span><span class="msa-threads-hero-shade"></span>
                <span class="msa-threads-hero-copy"><small>CHAT WINDOWS</small><strong>${escapeHtml(characterName(current.character))}</strong><em>${items.length} 個獨立聊天室</em></span>
            </div>
            <div class="msa-threads-heading"><span><small>選擇聊天室</small><strong>對話紀錄</strong></span><button type="button" data-action="reload-chat-threads" aria-label="重新整理聊天室清單">${icon('rotate')}</button></div>
            <p class="msa-threads-note">${icon('layer-group')} 每個聊天室都有各自的名稱、關係狀態與重要記憶。點選後才會進入聊天畫面。</p>
            <div class="msa-thread-list" role="list">${list}</div>
        </section>`;
}

function messagesMarkup() {
    const chat = context()?.chat || [];
    const visibleMessages = chat.slice(-100);
    const hiddenCount = Math.max(0, chat.length - visibleMessages.length);
    const model = getChatModelControl();
    const preset = getChatPresetControl();
    const current = getCurrentCharacter();
    const currentAvatar = avatarUrl(current?.character);
    return `
        <section class="msa-page msa-chat-page">
            <div class="msa-chat-contactbar">
                <button class="msa-chat-back" type="button" data-action="chat-list" aria-label="返回聊天室清單">${icon('arrow-left')}</button>
                ${current ? `<button class="msa-chat-contact" type="button" data-profile-character-id="${current.id}"><span class="msa-avatar" style="--msa-avatar-url:url(&quot;${escapeHtml(currentAvatar)}&quot;)"></span><span><strong>${escapeHtml(characterName(current.character))}</strong><small><b></b> ${escapeHtml(currentChatName() || '目前聊天室')} · 角色主頁</small></span></button>` : `<div class="msa-chat-contact"><span><strong>尚未選擇角色</strong><small>請先返回探索</small></span></div>`}
                ${currentChatName() ? `<button class="msa-chat-rename-button" type="button" data-rename-chat-file="${escapeHtml(currentChatName())}" aria-label="重新命名目前聊天室" title="重新命名聊天室">${icon('pen')}</button>` : ''}
                <button class="msa-chat-background-button" type="button" data-action="chat-background" aria-label="更換聊天室背景" title="更換聊天室背景">${icon('image')}</button>
            </div>
            ${hiddenCount ? `<p class="msa-chat-history-note">為保持流暢，目前顯示最近 100 則訊息；更早的 ${hiddenCount} 則仍保存在 SillyTavern。</p>` : ''}
            <div id="msa-message-list" class="msa-message-list" aria-live="polite">${visibleMessages.length ? visibleMessages.map((message, index) => `
                <article class="msa-message ${message.is_user ? 'is-user' : 'is-character'}">
                    <small>${escapeHtml(message.name || (message.is_user ? '你' : characterName(getCurrentCharacter()?.character)))}</small>
                    <p>${escapeHtml(fullMessageText(message.mes))}</p>
                </article>`).join('') : '<div class="msa-chat-empty">還沒有訊息，從下方輸入第一句話吧。</div>'}</div>
            <div class="msa-chat-switchers" aria-label="聊天生成設定">
                <button class="msa-chat-switcher-icon" type="button" data-action="switch-model" aria-label="切換 AI 模型，目前為 ${escapeHtml(model.label)}" title="AI 模型：${escapeHtml(model.label)}">${icon('microchip')}</button>
                <button class="msa-chat-switcher-icon" type="button" data-action="switch-preset" aria-label="切換聊天補全預設設定檔，目前為 ${escapeHtml(preset.label)}" title="聊天補全預設：${escapeHtml(preset.label)}">${icon('wand-magic-sparkles')}</button>
            </div>
            <div class="msa-chat-composer">
                <textarea id="msa-chat-input" rows="2" maxlength="12000" placeholder="輸入訊息……（Enter 傳送，Shift+Enter 換行）" aria-label="聊天訊息"></textarea>
                <button class="msa-persona-button" type="button" data-action="personas" aria-label="更換或編輯人設" title="更換或編輯人設">${icon('user-pen')}<span>人設</span></button>
                <button type="button" data-action="send-message" aria-label="傳送訊息">${icon('paper-plane')}</button>
            </div>
            <small class="msa-chat-bridge-status">訊息將透過 SillyTavern 目前的角色、世界書與模型設定傳送</small>
        </section>`;
}

function relationshipMarkup() {
    const current = getCurrentCharacter();
    if (!current) return emptyMarkup('請先選擇角色', '關係狀態會分別儲存在每一個角色聊天室。');
    const { character } = current;
    const state = getChatRoleplayState();
    const rounds = Math.max(0, (context()?.chat?.length || 1) - 1);
    return `
        <section class="msa-page">
            <div class="msa-page-title"><span><small>RELATIONSHIP</small><strong>與 ${escapeHtml(characterName(character))} 的關係</strong></span></div>
            ${profileTabsMarkup('relationship')}
            <button class="msa-roleplay-chat-chip" type="button" data-action="chat-list">${icon('comments')}<span><small>目前聊天室</small><strong>${escapeHtml(currentChatName() || '未命名聊天室')}</strong></span>${icon('chevron-right')}</button>
            <p class="msa-context-sync-note">${icon('link')} 此內容只屬於目前聊天室，角色每次回覆前都會讀取</p>
            <div class="msa-stat-card"><span>目前聊天室對話回合</span><strong>${rounds}</strong></div>
            <label class="msa-textarea-label">關係備忘錄
                <textarea id="msa-relationship-note" rows="9" maxlength="6000" placeholder="例如：目前互相信任、約定下次去看海……">${escapeHtml(state.relationshipNote)}</textarea>
            </label>
            <button class="msa-save-button" type="button" data-action="save-relationship">${icon('floppy-disk')} 儲存並同步至角色回覆</button>
        </section>`;
}

function memoriesMarkup() {
    const current = getCurrentCharacter();
    if (!current) return emptyMarkup('請先選擇角色', '重要記憶會分別儲存在每一個角色聊天室。');
    const { character } = current;
    const list = getChatRoleplayState().memories;
    return `
        <section class="msa-page">
            <div class="msa-page-title"><span><small>MEMORIES</small><strong>和 ${escapeHtml(characterName(character))} 的回憶</strong></span></div>
            ${profileTabsMarkup('memories')}
            <button class="msa-roleplay-chat-chip" type="button" data-action="chat-list">${icon('comments')}<span><small>目前聊天室</small><strong>${escapeHtml(currentChatName() || '未命名聊天室')}</strong></span>${icon('chevron-right')}</button>
            <p class="msa-context-sync-note">${icon('link')} 每個聊天室獨立保存；最近 ${ROLEPLAY_PROMPT_MAX_MEMORIES} 則會同步至角色回覆</p>
            <div class="msa-add-row"><input id="msa-memory-input" type="text" maxlength="240" placeholder="記下一件重要的事"><button type="button" data-action="add-memory">${icon('plus')}</button></div>
            <div class="msa-memory-list">${list.length ? list.map((item, index) => `
                <article><span>${icon('heart')}<p>${escapeHtml(item)}</p></span><button type="button" data-delete-memory="${index}" aria-label="刪除">${icon('trash')}</button></article>`).join('') : '<p class="msa-list-hint">尚未新增回憶。</p>'}</div>
        </section>`;
}

function momentsMarkup() {
    const chat = (context()?.chat || []).filter(message => !message.is_user && !message.is_system).slice(-6).reverse();
    if (!chat.length) return emptyMarkup('尚無角色動態', '角色回覆後，近期片段會自動整理在這裡。');
    return `
        <section class="msa-page">
            <div class="msa-page-title"><span><small>MOMENTS</small><strong>角色動態</strong></span></div>
            <div class="msa-moment-list">${chat.map((message, index) => `
                <article><span class="msa-moment-head"><b></b><strong>${escapeHtml(message.name || characterName(getCurrentCharacter()?.character))}</strong><time>#${chat.length - index}</time></span><p>${escapeHtml(excerpt(message.mes, 220))}</p></article>`).join('')}</div>
        </section>`;
}

function tokensMarkup() {
    const chat = getChatTokenUsage();
    const global = getGlobalTokenUsage();
    return `
        <section class="msa-page msa-token-page">
            <div class="msa-page-title"><span><small>TOKEN USAGE</small><strong>Token 使用量</strong></span></div>
            <div class="msa-token-summary">
                <small>目前聊天累計</small>
                <strong id="msa-token-chat-total">${formatToken(chat.total)}</strong>
                <span>TOKENS</span>
            </div>
            <div class="msa-token-rows">
                <div><span>本次輸入</span><strong id="msa-token-last-input">${formatToken(chat.lastInput)}</strong></div>
                <div><span>本次回覆</span><strong id="msa-token-last-output">${formatToken(chat.lastOutput)}</strong></div>
                <div class="is-total"><span>本次合計</span><strong id="msa-token-last-total">${formatToken(chat.lastTotal)}</strong></div>
                <div><span>API 呼叫次數</span><strong id="msa-token-requests">${formatToken(chat.requests)}</strong></div>
                <div><span>玩家傳送訊息</span><strong id="msa-token-user-messages">${formatToken(chat.userMessages)}</strong></div>
                <div><span>全部聊天累計</span><strong id="msa-token-global-total">${formatToken(global.total)}</strong></div>
                <div class="is-estimate"><span>目前聊天內容 Token</span><strong id="msa-token-chat-estimate">${formatToken(chat.chatTextTokens)}</strong></div>
            </div>
            <div id="msa-token-status" class="msa-token-status">${escapeHtml(chat.status)}</div>
            <div id="msa-tokenizer-status" class="msa-tokenizer-status">${escapeHtml(chat.tokenizerStatus)}</div>
            <p class="msa-token-help">輸入、回覆與累計數字取自模型 API 回傳的 usage；「目前聊天內容 Token」使用 SillyTavern 當前模型 tokenizer 即時計算。</p>
            <div class="msa-token-reset-row">
                <button type="button" data-action="reset-chat-tokens">重設目前聊天</button>
                <button type="button" data-action="reset-all-tokens">重設全部累計</button>
            </div>
        </section>`;
}

function applyCharacterFilters() {
    const root = document.getElementById(ROOT_ID);
    if (!root || activeView !== 'home') return;
    const query = characterSearchQuery.trim().toLocaleLowerCase('zh-Hant');
    let visible = 0;
    root.querySelectorAll('.msa-explore-card').forEach(card => {
        const matchesQuery = !query || String(card.dataset.characterSearch || '').includes(query);
        const matchesFilter = characterFilter === 'all'
            || (characterFilter === 'favorites' && card.dataset.characterFavorite === 'true')
            || (characterFilter === 'multiple' && card.dataset.characterMultiple === 'true');
        card.hidden = !(matchesQuery && matchesFilter);
        if (!card.hidden) visible += 1;
    });
    const count = document.getElementById('msa-character-result-count');
    if (count) count.textContent = `${visible} 位角色`;
    const empty = document.getElementById('msa-character-filter-empty');
    if (empty) empty.hidden = visible > 0;
}

function render(view = activeView) {
    const previousView = activeView;
    activeView = view;
    const root = document.getElementById(ROOT_ID);
    const content = document.getElementById('msa-content');
    if (!root || !content) return;
    applyVisualSettings(root);
    root.classList.toggle('msa-view-messages', view === 'messages');
    root.classList.toggle('msa-view-threads', view === 'threads');

    const markup = {
        home: homeMarkup,
        profile: characterProfileMarkup,
        favorites: favoritesMarkup,
        cards: characterManagementMarkup,
        settings: settingsMarkup,
        conversations: conversationsMarkup,
        threads: chatThreadsMarkup,
        messages: messagesMarkup,
        relationship: relationshipMarkup,
        memories: memoriesMarkup,
        moments: momentsMarkup,
        tokens: tokensMarkup,
    }[view]?.() || homeMarkup();

    content.innerHTML = markup;
    const navView = view === 'profile' ? 'cards' : (['conversations', 'threads'].includes(view) ? 'messages' : view);
    root.querySelectorAll('.msa-bottom-nav [data-nav]').forEach(button => button.classList.toggle('is-active', button.dataset.nav === navView));
    updateCurrentAvatar();
    if (previousView !== view) {
        const scroller = root.querySelector('.msa-app-scroll');
        if (scroller) scroller.scrollTop = 0;
    }
    if (view === 'messages') {
        const schedule = globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0));
        schedule(() => {
            const list = document.getElementById('msa-message-list');
            if (list) list.scrollTop = list.scrollHeight;
        });
    }
    if (view === 'home') applyCharacterFilters();
}

function syncViewportMetrics() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;

    const viewport = globalThis.visualViewport;
    const height = Math.max(1, Math.round(viewport?.height || globalThis.innerHeight || document.documentElement.clientHeight || 1));
    const offsetTop = Math.max(0, Math.round(viewport?.offsetTop || 0));
    const activeElement = document.activeElement;
    const editing = root.contains(activeElement) && activeElement?.matches?.('input, textarea, [contenteditable="true"]');

    if (!editing) fullViewportHeight = Math.max(fullViewportHeight, height);
    else if (!fullViewportHeight) fullViewportHeight = Math.max(height, globalThis.innerHeight || height);

    root.style.setProperty('--msa-viewport-height', `${height}px`);
    root.style.setProperty('--msa-viewport-top', `${offsetTop}px`);
    root.classList.toggle('msa-keyboard-open', editing && fullViewportHeight - height > 120);
}

function scheduleViewportSync() {
    const schedule = globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0));
    const cancel = globalThis.cancelAnimationFrame || clearTimeout;
    if (viewportFrame) cancel(viewportFrame);
    viewportFrame = schedule(() => {
        viewportFrame = 0;
        syncViewportMetrics();
    });
}

function updateCurrentAvatar() {
    const character = getCurrentCharacter()?.character;
    const url = avatarUrl(character);
    document.querySelectorAll('.msa-avatar-current').forEach(node => {
        node.style.setProperty('--msa-avatar-url', url ? `url("${url}")` : 'none');
    });
}

function showApp(view = 'home') {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    syncViewportMetrics();
    root.classList.remove('msa-hidden');
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('msa-open');
    render(view);
}

function hideApp() {
    closeSheet();
    const root = document.getElementById(ROOT_ID);
    root?.classList.add('msa-hidden');
    root?.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('msa-open');
}

function showSheet(title, content) {
    const sheet = document.getElementById('msa-sheet');
    if (!sheet) return;
    sheet.innerHTML = `<div class="msa-sheet-backdrop" data-action="close-sheet"></div><section><header><span><small>MIDNIGHT SIGNAL</small><strong>${escapeHtml(title)}</strong></span><button type="button" data-action="close-sheet">${icon('xmark')}</button></header><div class="msa-sheet-content">${content}</div></section>`;
    sheet.classList.remove('msa-hidden');
    sheet.setAttribute('aria-hidden', 'false');
    const sheetContent = sheet.querySelector('.msa-sheet-content');
    if (sheetContent) sheetContent.scrollTop = 0;
}

function closeSheet() {
    const sheet = document.getElementById('msa-sheet');
    sheet?.classList.add('msa-hidden');
    sheet?.setAttribute('aria-hidden', 'true');
}

function openRenameChatSheet(fileName) {
    const oldName = String(fileName || '').replace(/\.jsonl$/i, '').trim();
    if (!oldName) return;
    const current = getCurrentCharacter();
    const content = `
        <div id="msa-rename-chat-form" class="msa-rename-chat-form" data-old-chat-name="${escapeHtml(oldName)}">
            <div class="msa-rename-chat-intro">${icon('pen-to-square')}<span><strong>更改聊天室名稱</strong><small>${escapeHtml(characterName(current?.character))} · 關係狀態與重要記憶不會受到影響</small></span></div>
            <label>聊天室名稱<input id="msa-rename-chat-input" type="text" maxlength="180" value="${escapeHtml(oldName)}" autocomplete="off" spellcheck="false"></label>
            <p>${icon('circle-info')} 僅變更顯示與檔案名稱；目前聊天室內的訊息、Token 紀錄、關係狀態及重要記憶都會完整保留。</p>
            <button class="msa-save-button" type="button" data-action="confirm-rename-chat">${icon('floppy-disk')} 儲存聊天室名稱</button>
        </div>`;
    showSheet('重新命名聊天室', content);
    setTimeout(() => document.getElementById('msa-rename-chat-input')?.focus(), 80);
}

async function renameCharacterChatFromApp() {
    const form = document.getElementById('msa-rename-chat-form');
    const input = document.getElementById('msa-rename-chat-input');
    const oldName = String(form?.dataset.oldChatName || '').trim();
    const newName = String(input?.value || '').trim().replace(/\.jsonl$/i, '');
    if (!oldName || !newName) {
        notify('請輸入聊天室名稱。', 'warning');
        input?.focus();
        return;
    }
    if (oldName === newName) {
        closeSheet();
        return;
    }

    const button = form.querySelector('[data-action="confirm-rename-chat"]');
    if (button) button.disabled = true;
    try {
        const ctx = context();
        const core = await getCoreModule();
        const rename = ctx?.renameChat || core.renameChat;
        if (typeof rename !== 'function') throw new Error('此版本無法重新命名聊天室。');
        await rename.call(ctx, oldName, newName);
        await sleep(300);
        closeSheet();
        const chats = await loadCharacterChatThreads(context()?.characterId, { showLoading: false });
        if (chats.some(chat => chatThreadFileName(chat) === oldName)) {
            notify('聊天室名稱未變更，請確認名稱沒有重複。', 'error');
            return;
        }
        await syncRoleplayContextPrompt();
        render('threads');
        notify('聊天室名稱已更新，所有聊天室專屬資料均已保留。', 'success');
    } catch (error) {
        notify(error.message || '聊天室重新命名失敗。', 'error');
        console.error('[Midnight Signal] Failed to rename chat.', error);
        if (button?.isConnected) button.disabled = false;
    }
}

function openCharacterSheet() {
    const characters = getCharacters();
    const content = characters.length
        ? `<div class="msa-character-list">${characters.map(characterCardMarkup).join('')}</div>`
        : `<div class="msa-sheet-empty">尚未匯入任何角色卡。</div>`;
    showSheet('選擇對話角色', content);
}

function openGreetingSheet() {
    const current = getCurrentCharacter();
    if (!current) {
        openCharacterSheet();
        return;
    }
    const greetings = getGreetings(current.character);
    const currentSwipe = Number(context()?.chat?.[0]?.swipe_id || 0);
    const content = greetings.length
        ? `<div class="msa-greeting-list">${greetings.map((greeting, index) => `
            <button type="button" data-greeting-index="${index}" class="${currentSwipe === index ? 'is-current' : ''}">
                <span><small>${index === 0 ? '預設開場白' : `開場白 ${index + 1}`}</small><strong>${escapeHtml(excerpt(greeting, 110))}</strong></span>${icon(currentSwipe === index ? 'check' : 'chevron-right')}
            </button>`).join('')}</div>`
        : `<div class="msa-sheet-empty">這張角色卡沒有設定開場白。</div>`;
    showSheet('開場白選擇', content);
}

function openNotifications() {
    showSheet('通知', `<div class="msa-notice-card">${icon('circle-check')}<span><strong>APP 已與 SillyTavern 連線</strong><small>角色、聊天與開場白資料會隨目前對話更新。</small></span></div>`);
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
        reader.readAsDataURL(file);
    });
}

function loadDataUrlImage(dataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Image decode failed'));
        image.src = dataUrl;
    });
}

async function optimizeChatBackground(file) {
    if (!file?.type?.startsWith('image/')) throw new Error('請選擇圖片檔。');
    if (file.size > 12 * 1024 * 1024) throw new Error('圖片需小於 12 MB。');

    const original = await readFileAsDataUrl(file);
    const image = await loadDataUrlImage(original);
    const maxEdge = 1440;
    const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
    canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
    const draw = canvas.getContext('2d');
    if (!draw) throw new Error('瀏覽器無法處理這張圖片。');
    draw.fillStyle = '#050a12';
    draw.fillRect(0, 0, canvas.width, canvas.height);
    draw.drawImage(image, 0, 0, canvas.width, canvas.height);

    let result = canvas.toDataURL('image/jpeg', 0.82);
    if (result.length > 3_200_000 && Math.max(canvas.width, canvas.height) > 1050) {
        const compact = document.createElement('canvas');
        const compactScale = 1050 / Math.max(canvas.width, canvas.height);
        compact.width = Math.max(1, Math.round(canvas.width * compactScale));
        compact.height = Math.max(1, Math.round(canvas.height * compactScale));
        const compactDraw = compact.getContext('2d');
        compactDraw.fillStyle = '#050a12';
        compactDraw.fillRect(0, 0, compact.width, compact.height);
        compactDraw.drawImage(canvas, 0, 0, compact.width, compact.height);
        result = compact.toDataURL('image/jpeg', 0.72);
    }
    if (!result.startsWith('data:image/') || result.length > 4_500_000) throw new Error('圖片壓縮後仍過大，請改用尺寸較小的圖片。');
    return result;
}

function openChatBackgroundSheet() {
    const hasBackground = Boolean(settings().chatBackground);
    const content = `
        <div class="msa-background-editor">
            <div class="msa-background-preview ${hasBackground ? 'has-image' : ''}" style="--msa-preview-background:${hasBackground ? `url(&quot;${escapeHtml(settings().chatBackground)}&quot;)` : 'none'}">
                <span>${icon('comments')}<strong>訊息背景預覽</strong><small>${hasBackground ? '目前已套用自訂背景' : '目前使用預設深色背景'}</small></span>
            </div>
            <label class="msa-background-upload">${icon('upload')}<span><strong>選擇背景圖片</strong><small>支援 JPG、PNG、WEBP；會壓縮並儲存在擴充設定中</small></span><input id="msa-chat-background-file" type="file" accept="image/*"></label>
            ${hasBackground ? `<button class="msa-background-clear" type="button" data-action="clear-chat-background">${icon('trash-can')} 移除自訂背景</button>` : ''}
            <p>圖片不需要放在伺服器資料夾，雲端版與手機版都會從這組擴充設定讀取。</p>
        </div>`;
    showSheet('聊天室背景', content);
}

async function setChatBackgroundFromFile(file) {
    if (!file) return;
    const input = document.getElementById('msa-chat-background-file');
    if (input) input.disabled = true;
    notify('正在處理聊天室背景……', 'info');
    try {
        settings().chatBackground = await optimizeChatBackground(file);
        saveSettings();
        applyVisualSettings();
        render(activeView);
        openChatBackgroundSheet();
        notify('聊天室背景已套用。', 'success');
    } catch (error) {
        notify(error.message || '背景圖片讀取失敗。', 'error');
        if (input?.isConnected) input.disabled = false;
    }
}

function clearChatBackground() {
    settings().chatBackground = '';
    saveSettings();
    applyVisualSettings();
    render(activeView);
    openChatBackgroundSheet();
    notify('已恢復預設聊天室背景。', 'success');
}

function nativeSettingOptionsMarkup(kind, control, currentValue) {
    if (control?.tagName !== 'SELECT') return '';
    const options = [...control.options].filter(option => !option.disabled && String(option.value).trim());
    return options.map(option => `
        <button type="button" class="msa-native-setting-option ${String(option.value) === String(currentValue) ? 'is-current' : ''}" data-native-setting="${kind}" data-native-value="${escapeHtml(option.value)}">
            <span><strong>${escapeHtml(option.textContent?.trim() || option.value)}</strong><small>${escapeHtml(option.value)}</small></span>${icon(String(option.value) === String(currentValue) ? 'circle-check' : 'chevron-right')}
        </button>`).join('');
}

function openNativeSettingSheet(kind) {
    const isModel = kind === 'model';
    const runtime = isModel ? getChatModelControl() : getChatPresetControl();
    const title = isModel ? '切換 AI 模型' : '切換補全預設';
    if (!runtime.control) {
        showSheet(title, `<div class="msa-sheet-empty">找不到對應的 SillyTavern 原生設定。請先在 API 連線頁選擇 Chat Completion 來源。</div>`);
        return;
    }

    if (runtime.control.tagName !== 'SELECT') {
        const content = `
            <div class="msa-custom-model-editor">
                <small>CUSTOM MODEL</small><strong>自訂模型 ID</strong>
                <input id="msa-custom-model-value" type="text" value="${escapeHtml(runtime.control.value || '')}" placeholder="輸入模型 ID">
                <button type="button" class="msa-save-button" data-action="save-custom-model">${icon('floppy-disk')} 套用模型</button>
            </div>`;
        showSheet(title, content);
        return;
    }

    const options = nativeSettingOptionsMarkup(kind, runtime.control, runtime.control.value);
    const meta = isModel ? `目前 API 來源：${escapeHtml(runtime.source || 'Chat Completion')}` : '選擇後會立即套用到 SillyTavern Chat Completion 設定';
    showSheet(title, `<div class="msa-native-setting-meta">${icon(isModel ? 'microchip' : 'sliders')}<span><strong>${escapeHtml(runtime.label)}</strong><small>${meta}</small></span></div><div class="msa-native-setting-list">${options || '<div class="msa-sheet-empty">目前沒有可用選項。</div>'}</div>`);
}

function applyNativeSetting(kind, value) {
    const runtime = kind === 'model' ? getChatModelControl() : getChatPresetControl();
    const control = runtime.control;
    if (!control || control.tagName !== 'SELECT' || ![...control.options].some(option => String(option.value) === String(value))) {
        notify('這個設定選項已不存在，請重新開啟選單。', 'error');
        return;
    }
    control.value = value;
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
    closeSheet();
    render('messages');
    notify(kind === 'model' ? 'AI 模型已切換。' : '聊天補全預設已切換。', 'success');
}

function saveCustomModel() {
    const runtime = getChatModelControl();
    const value = document.getElementById('msa-custom-model-value')?.value.trim();
    if (!runtime.control || !value) {
        notify('請輸入模型 ID。', 'warning');
        return;
    }
    runtime.control.value = value;
    runtime.control.dispatchEvent(new Event('input', { bubbles: true }));
    runtime.control.dispatchEvent(new Event('change', { bubbles: true }));
    closeSheet();
    render('messages');
    notify('自訂模型已套用。', 'success');
}

async function openPersonaSheet() {
    showSheet('更換與編輯人設', `<div class="msa-sheet-loading">${icon('spinner')}<span>正在讀取 SillyTavern 人設……</span></div>`);
    try {
        const { powerUser, currentId } = await getPersonaRuntime();
        const personas = Object.entries(powerUser.personas)
            .map(([id, name]) => ({ id, name: String(name || id), descriptor: powerUser.persona_descriptions[id] || {} }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));

        if (!personas.length) {
            showSheet('更換與編輯人設', `<div class="msa-sheet-empty">尚未建立任何人設。請先在 SillyTavern 的「人設管理」建立一組人設。</div>`);
            return;
        }

        const current = personas.find(persona => persona.id === currentId) || personas[0];
        const list = personas.map(persona => {
            const avatar = personaAvatarUrl(persona.id);
            const description = excerpt(persona.descriptor.description || '尚未填寫人設描述', 52);
            return `
                <button type="button" class="msa-persona-option ${persona.id === current.id ? 'is-current' : ''}" data-persona-id="${escapeHtml(persona.id)}">
                    <span class="msa-persona-avatar" ${avatar ? `style="--msa-persona-avatar:url(&quot;${escapeHtml(avatar)}&quot;)"` : ''}>${icon('user')}</span>
                    <span><strong>${escapeHtml(persona.name)}</strong><small>${escapeHtml(description)}</small></span>
                    ${icon(persona.id === current.id ? 'circle-check' : 'chevron-right')}
                </button>`;
        }).join('');

        const content = `
            <div class="msa-persona-intro"><small>目前使用人設</small><strong>${escapeHtml(current.name)}</strong><span>點選上方人設即可切換；下方內容儲存後會立即套用於下一次對話。</span></div>
            <div class="msa-persona-list">${list}</div>
            <div id="msa-persona-editor" class="msa-persona-editor" data-persona-id="${escapeHtml(current.id)}">
                <div class="msa-persona-editor-title">${icon('pen-to-square')}<span><small>EDIT PERSONA</small><strong>直接編輯人設</strong></span></div>
                <label>人設名稱<input id="msa-persona-name" type="text" maxlength="120" value="${escapeHtml(current.name)}" placeholder="輸入人設名稱"></label>
                <label>人設描述<textarea id="msa-persona-description" rows="9" maxlength="30000" placeholder="輸入身分、外表、性格、說話方式等人設內容……">${escapeHtml(current.descriptor.description || '')}</textarea></label>
                <button class="msa-save-button" type="button" data-action="save-persona">${icon('floppy-disk')} 儲存並立即套用</button>
            </div>`;
        showSheet('更換與編輯人設', content);
    } catch (error) {
        showSheet('更換與編輯人設', `<div class="msa-sheet-empty">無法讀取 SillyTavern 人設資料，請重新整理頁面後再試。</div>`);
        console.error('[Midnight Signal] Failed to open persona editor.', error);
    }
}

async function selectPersonaFromApp(id) {
    const { ctx, personaModule, powerUser } = await getPersonaRuntime();
    if (!id || !Object.hasOwn(powerUser.personas, id)) {
        notify('找不到這組人設。', 'error');
        return;
    }

    if (typeof personaModule.setUserAvatar === 'function') {
        await personaModule.setUserAvatar(id, { navigateToCurrent: false });
    } else {
        const nativePersona = [...document.querySelectorAll('#user_avatar_block .avatar-container')]
            .find(node => node.getAttribute('data-avatar-id') === id);
        if (nativePersona) nativePersona.click();
        const descriptor = powerUser.persona_descriptions[id] || {};
        powerUser.persona_description = descriptor.description || '';
        const core = await getCoreModule();
        core.setUserName?.(powerUser.personas[id]);
        ctx?.saveSettingsDebounced?.();
    }

    selectedPersonaId = id;
    await openPersonaSheet();
    notify(`已切換為人設「${powerUser.personas[id]}」。`, 'success');
}

async function savePersonaFromApp() {
    const editor = document.getElementById('msa-persona-editor');
    const nameInput = document.getElementById('msa-persona-name');
    const descriptionInput = document.getElementById('msa-persona-description');
    const id = editor?.dataset.personaId;
    const newName = nameInput?.value.trim();
    const newDescription = descriptionInput?.value.trim() || '';
    if (!id || !newName) {
        notify('請輸入人設名稱。', 'warning');
        nameInput?.focus();
        return;
    }

    const { ctx, personaModule, powerUser, currentId } = await getPersonaRuntime();
    if (!Object.hasOwn(powerUser.personas, id)) {
        notify('找不到要編輯的人設。', 'error');
        return;
    }

    const oldName = powerUser.personas[id];
    const descriptor = powerUser.persona_descriptions[id] ??= {
        description: '', position: 0, depth: 2, role: 0, lorebook: '', connections: [], title: '',
    };
    powerUser.personas[id] = newName;
    descriptor.description = newDescription;

    const eventTypes = ctx?.eventTypes || ctx?.event_types || {};
    if (id === currentId || id === selectedPersonaId) {
        powerUser.persona_description = newDescription;
        const core = await getCoreModule();
        core.setUserName?.(newName);
        personaModule.setPersonaDescription?.();
    }

    ctx?.saveSettingsDebounced?.();
    if (oldName !== newName && eventTypes.PERSONA_RENAMED) {
        await ctx?.eventSource?.emit?.(eventTypes.PERSONA_RENAMED, { avatarId: id, oldName, newName });
    }
    if (eventTypes.PERSONA_UPDATED) await ctx?.eventSource?.emit?.(eventTypes.PERSONA_UPDATED, id);

    selectedPersonaId = id;
    await openPersonaSheet();
    notify(`人設「${newName}」已儲存並套用。`, 'success');
}

async function getAppRequestHeaders(options = {}) {
    const ctx = context();
    if (typeof ctx?.getRequestHeaders === 'function') return ctx.getRequestHeaders(options);
    const core = await getCoreModule();
    return typeof core.getRequestHeaders === 'function' ? core.getRequestHeaders(options) : {};
}

async function refreshCharacterData() {
    const ctx = context();
    let refresh = ctx?.getCharacters;
    if (typeof refresh !== 'function') {
        const core = await getCoreModule();
        refresh = core.getCharacters;
    }
    if (typeof refresh === 'function') await refresh.call(ctx);
}

function triggerCharacterImport() {
    const input = document.getElementById('character_import_file');
    if (!input) {
        notify('找不到 SillyTavern 原生角色卡匯入器，請重新整理頁面後再試。', 'error');
        return;
    }
    input.click();
}

function openHighQualityAvatarSheet(id) {
    const character = context()?.characters?.[Number(id)];
    if (!character) {
        notify('找不到要更新封面的角色。', 'error');
        return;
    }
    const original = originalAvatarUrl(character);
    const content = `
        <div class="msa-avatar-upload-editor">
            <div class="msa-avatar-upload-preview" style="--msa-upload-avatar:url(&quot;${escapeHtml(original)}&quot;)"><span><b>ORIGINAL QUALITY</b><strong>${escapeHtml(characterName(character))}</strong></span></div>
            <div class="msa-avatar-quality-note">${icon('expand')}<span><strong>保留原始解析度</strong><small>APP 不會縮小或轉成低畫質縮圖；SillyTavern 會以 PNG 無損保存角色資料與新封面。</small></span></div>
            <label class="msa-avatar-upload-picker">${icon('cloud-arrow-up')}<span><strong>選擇高畫質圖片</strong><small>PNG、JPG、WEBP 或 GIF，檔案上限 25 MB</small></span><input id="msa-character-avatar-file" data-avatar-character-id="${id}" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>
            <p>建議使用直式圖片，長邊 1600–3000 px。上傳只會替換封面，不會清除角色設定或聊天紀錄。</p>
        </div>`;
    showSheet('高畫質角色封面', content);
}

async function uploadHighQualityCharacterAvatar(id, file) {
    const character = context()?.characters?.[Number(id)];
    if (!character || !file) return;
    if (!file.type?.startsWith('image/')) {
        notify('請選擇圖片檔。', 'warning');
        return;
    }
    if (file.size > 25 * 1024 * 1024) {
        notify('高畫質封面需小於 25 MB。', 'warning');
        return;
    }

    const input = document.getElementById('msa-character-avatar-file');
    if (input) input.disabled = true;
    const avatar = character.avatar || character.data?.avatar;
    const formData = new FormData();
    formData.append('avatar_url', avatar);
    formData.append('avatar', file, file.name);
    notify('正在上傳原始畫質角色封面……', 'info');

    try {
        const response = await fetch('/api/characters/edit-avatar', {
            method: 'POST',
            headers: await getAppRequestHeaders({ omitContentType: true }),
            body: formData,
            cache: 'no-cache',
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        avatarRevisions.set(String(avatar), Date.now());
        await refreshCharacterData();
        const ctx = context();
        const eventTypes = ctx?.eventTypes || ctx?.event_types || {};
        if (eventTypes.CHARACTER_EDITED) {
            await ctx?.eventSource?.emit?.(eventTypes.CHARACTER_EDITED, { detail: { id: Number(id), character: ctx.characters?.[Number(id)] } });
        }
        closeSheet();
        render('cards');
        notify(`「${characterName(character)}」已換成高畫質封面。`, 'success');
    } catch (error) {
        notify('高畫質封面上傳失敗，請確認圖片格式後再試。', 'error');
        console.error('[Midnight Signal] Failed to replace character avatar.', error);
        if (input?.isConnected) input.disabled = false;
    }
}

function openCreateCharacterSheet() {
    const content = `
        <div id="msa-new-character-form" class="msa-new-character-form">
            <div class="msa-create-card-intro">${icon('user-plus')}<span><strong>建立新角色卡</strong><small>儲存後會立即加入 SillyTavern 角色清單。</small></span></div>
            <label>角色名稱 <b>*</b><input id="msa-new-character-name" type="text" maxlength="120" placeholder="例如：ARK-07"></label>
            <label>角色頭像 <small>選填，支援 PNG、JPG、GIF</small><input id="msa-new-character-avatar" type="file" accept="image/png,image/jpeg,image/gif"></label>
            <label>角色描述<textarea id="msa-new-character-description" rows="6" maxlength="30000" placeholder="外表、身分、背景與重要設定……"></textarea></label>
            <label>性格<textarea id="msa-new-character-personality" rows="4" maxlength="12000" placeholder="性格特徵、情緒反應與說話方式……"></textarea></label>
            <label>場景<textarea id="msa-new-character-scenario" rows="3" maxlength="12000" placeholder="角色與玩家所在的世界、時間與初始情境……"></textarea></label>
            <label>開場白<textarea id="msa-new-character-first-message" rows="6" maxlength="30000" placeholder="角色在新聊天中說出的第一段話……"></textarea></label>
            <button class="msa-save-button" type="button" data-action="create-character">${icon('floppy-disk')} 建立角色卡</button>
        </div>`;
    showSheet('新增角色卡', content);
    setTimeout(() => document.getElementById('msa-new-character-name')?.focus(), 80);
}

async function createCharacterFromApp() {
    const nameInput = document.getElementById('msa-new-character-name');
    const name = nameInput?.value.trim();
    if (!name) {
        notify('請輸入角色名稱。', 'warning');
        nameInput?.focus();
        return;
    }

    const button = document.querySelector('[data-action="create-character"]');
    if (button) button.disabled = true;
    const formData = new FormData();
    const fields = {
        ch_name: name,
        description: document.getElementById('msa-new-character-description')?.value.trim() || '',
        personality: document.getElementById('msa-new-character-personality')?.value.trim() || '',
        scenario: document.getElementById('msa-new-character-scenario')?.value.trim() || '',
        first_mes: document.getElementById('msa-new-character-first-message')?.value.trim() || '',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        talkativeness: '0.5', fav: 'false', tags: '', creator: '', character_version: '',
        depth_prompt_prompt: '', depth_prompt_depth: '4', depth_prompt_role: 'system', extensions: '{}',
    };
    for (const [key, value] of Object.entries(fields)) formData.append(key, value);
    const avatar = document.getElementById('msa-new-character-avatar')?.files?.[0];
    if (avatar) formData.append('avatar', avatar);

    try {
        const response = await fetch('/api/characters/create', {
            method: 'POST',
            headers: await getAppRequestHeaders({ omitContentType: true }),
            body: formData,
            cache: 'no-cache',
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        await response.text();
        await refreshCharacterData();
        closeSheet();
        render('cards');
        notify(`角色卡「${name}」已建立。`, 'success');
    } catch (error) {
        notify('角色卡建立失敗，請確認名稱與圖片格式後再試。', 'error');
        console.error('[Midnight Signal] Failed to create character.', error);
        if (button) button.disabled = false;
    }
}

async function deleteCharacterFromApp(id) {
    const ctx = context();
    const character = ctx?.characters?.[Number(id)];
    if (!character) {
        notify('找不到要刪除的角色卡。', 'error');
        return;
    }

    const name = characterName(character);
    if (!confirm(`確定刪除角色卡「${name}」嗎？\n\n既有聊天紀錄會保留，但角色卡刪除後無法復原。`)) return;

    try {
        const core = await getCoreModule();
        let deleted = false;
        if (typeof core.deleteCharacter === 'function') {
            deleted = await core.deleteCharacter(characterKey(character), { deleteChats: false });
        } else {
            const response = await fetch('/api/characters/delete', {
                method: 'POST',
                headers: await getAppRequestHeaders(),
                body: JSON.stringify({ avatar_url: characterKey(character), delete_chats: false }),
                cache: 'no-cache',
            });
            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
            deleted = true;
        }
        if (!deleted) return;
        await refreshCharacterData();
        render('cards');
        notify(`角色卡「${name}」已刪除，聊天紀錄已保留。`, 'success');
    } catch (error) {
        notify('角色卡刪除失敗，請稍後再試。', 'error');
        console.error('[Midnight Signal] Failed to delete character.', error);
    }
}

function toggleFavorite(id) {
    const character = context()?.characters?.[id];
    if (!character) return;
    const value = settings();
    const key = characterKey(character);
    const index = value.favorites.indexOf(key);
    if (index >= 0) value.favorites.splice(index, 1);
    else value.favorites.push(key);
    saveSettings();
    if (!document.getElementById('msa-sheet')?.classList.contains('msa-hidden')) openCharacterSheet();
    else render();
}

async function saveRelationship() {
    const character = getCurrentCharacter()?.character;
    const textarea = document.getElementById('msa-relationship-note');
    if (!character || !textarea) return;
    getChatRoleplayState().relationshipNote = textarea.value.trim();
    await saveChatRoleplayState();
    await syncRoleplayContextPrompt();
    notify('目前聊天室的關係狀態已儲存並同步。', 'success');
}

async function addMemory() {
    const character = getCurrentCharacter()?.character;
    const input = document.getElementById('msa-memory-input');
    if (!character || !input?.value.trim()) return;
    getChatRoleplayState().memories.unshift(input.value.trim());
    await saveChatRoleplayState();
    await syncRoleplayContextPrompt();
    render('memories');
}

async function deleteMemory(index) {
    const character = getCurrentCharacter()?.character;
    if (!character) return;
    const list = getChatRoleplayState().memories;
    list.splice(Number(index), 1);
    await saveChatRoleplayState();
    await syncRoleplayContextPrompt();
    render('memories');
}

async function openProfileStateView(view) {
    const selected = getProfileCharacter();
    if (!selected) {
        notify('請先選擇一名角色。', 'warning');
        return;
    }
    if (Number(context()?.characterId) !== selected.id) {
        try {
            notify(`正在開啟「${characterName(selected.character)}」目前的聊天室……`, 'info');
            await selectCharacter(selected.id);
        } catch (error) {
            notify(error.message || '無法開啟這名角色的聊天室。', 'error');
            return;
        }
    }
    selectedProfileCharacterId = Number(context()?.characterId);
    render(view);
    await syncRoleplayContextPrompt();
}

async function sendMessageFromApp() {
    const appInput = document.getElementById('msa-chat-input');
    const message = appInput?.value?.trim();
    if (!message) return;
    if (!getCurrentCharacter()) {
        notify('請先選擇一名對話角色。', 'warning');
        return;
    }

    const nativeInput = document.getElementById('send_textarea');
    const nativeSend = document.getElementById('send_but');
    if (!nativeInput) {
        notify('找不到 SillyTavern 原生聊天輸入框，請重新整理頁面後再試。', 'error');
        return;
    }
    const ctx = context();
    let core = {};
    if (typeof ctx?.Generate !== 'function' || typeof ctx?.isGenerating !== 'function') {
        core = await getCoreModule();
    }
    const isGenerating = ctx?.isGenerating || core.isGenerating;
    if (isGenerating?.() || nativeSend?.disabled || nativeSend?.classList.contains('displayNone')) {
        notify('目前正在生成回覆，請等待完成後再傳送。', 'warning');
        return;
    }
    if (nativeInput.value.trim() && nativeInput.value.trim() !== message) {
        const replaceDraft = confirm('SillyTavern 原本的聊天輸入框中還有草稿，要用 APP 內的訊息取代草稿並傳送嗎？');
        if (!replaceDraft) return;
    }

    appInput.disabled = true;
    const appSend = document.querySelector('[data-action="send-message"]');
    if (appSend) appSend.disabled = true;

    nativeInput.value = message;
    nativeInput.dispatchEvent(new Event('input', { bubbles: true }));
    nativeInput.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(0);

    try {
        appInput.value = '';
        await syncRoleplayContextPrompt();
        const generate = ctx?.Generate || core.Generate;
        if (typeof generate === 'function') {
            await generate.call(ctx, 'normal');
        } else if (nativeSend) {
            nativeSend.click();
        } else {
            throw new Error('SillyTavern generation API unavailable');
        }
    } catch (error) {
        appInput.value = message;
        notify('訊息傳送失敗，請確認 SillyTavern 已選擇角色並連接模型。', 'error');
        console.error('[Midnight Signal] Failed to send message.', error);
    }

    setTimeout(() => {
        const currentInput = document.getElementById('msa-chat-input');
        const currentSend = document.querySelector('[data-action="send-message"]');
        if (currentInput) currentInput.disabled = false;
        if (currentSend) currentSend.disabled = false;
    }, 250);
}

async function handleClick(event) {
    const button = event.target.closest('button, [data-action], [data-nav]');
    if (!button) return;

    if (button.dataset.nav === 'messages') {
        render('conversations');
        return;
    }
    if (button.dataset.nav) {
        render(button.dataset.nav);
        return;
    }
    if (button.dataset.characterFilter !== undefined) {
        characterFilter = button.dataset.characterFilter || 'all';
        render('home');
        return;
    }
    if (button.dataset.profileCharacterId !== undefined) {
        selectedProfileCharacterId = Number(button.dataset.profileCharacterId);
        render('profile');
        return;
    }
    if (button.dataset.startCharacterId !== undefined) {
        button.disabled = true;
        try {
            await openCharacterThreads(Number(button.dataset.startCharacterId));
            notify(`已開啟 ${characterName(getCurrentCharacter()?.character)} 的聊天室清單。`, 'success');
        } catch (error) {
            notify(error.message || '角色切換失敗。', 'error');
        } finally {
            if (button.isConnected) button.disabled = false;
        }
        return;
    }
    if (button.dataset.conversationCharacterId !== undefined) {
        button.disabled = true;
        try {
            await openCharacterThreads(Number(button.dataset.conversationCharacterId));
        } catch (error) {
            notify(error.message || '無法開啟這名角色的聊天室。', 'error');
        } finally {
            if (button.isConnected) button.disabled = false;
        }
        return;
    }
    if (button.dataset.profileGreetingsId !== undefined) {
        button.disabled = true;
        try {
            await selectCharacter(Number(button.dataset.profileGreetingsId));
            openGreetingSheet();
        } catch (error) {
            notify(error.message || '無法開啟角色開場白。', 'error');
        } finally {
            if (button.isConnected) button.disabled = false;
        }
        return;
    }
    if (button.dataset.nativeSetting !== undefined) {
        applyNativeSetting(button.dataset.nativeSetting, button.dataset.nativeValue || '');
        return;
    }
    if (button.dataset.characterId !== undefined) {
        button.disabled = true;
        try {
            await selectCharacter(Number(button.dataset.characterId));
            closeSheet();
            render('home');
            notify(`已切換至 ${characterName(getCurrentCharacter()?.character)}。`, 'success');
        } catch (error) {
            notify(error.message || '角色切換失敗。', 'error');
        } finally {
            button.disabled = false;
        }
        return;
    }
    if (button.dataset.favoriteId !== undefined) {
        toggleFavorite(Number(button.dataset.favoriteId));
        return;
    }
    if (button.dataset.greetingIndex !== undefined) {
        button.disabled = true;
        try {
            await applyGreeting(Number(button.dataset.greetingIndex));
            closeSheet();
            render('home');
            notify('已套用新的開場白。', 'success');
        } catch (error) {
            notify(error.message || '開場白切換失敗。', 'error');
        } finally {
            button.disabled = false;
        }
        return;
    }
    if (button.dataset.personaId !== undefined) {
        button.disabled = true;
        try {
            await selectPersonaFromApp(button.dataset.personaId);
        } catch (error) {
            notify('人設切換失敗，請重新整理頁面後再試。', 'error');
            console.error('[Midnight Signal] Failed to switch persona.', error);
        } finally {
            button.disabled = false;
        }
        return;
    }
    if (button.dataset.deleteCharacter !== undefined) {
        button.disabled = true;
        try {
            await deleteCharacterFromApp(button.dataset.deleteCharacter);
        } finally {
            if (button.isConnected) button.disabled = false;
        }
        return;
    }
    if (button.dataset.uploadCharacterAvatar !== undefined) {
        openHighQualityAvatarSheet(Number(button.dataset.uploadCharacterAvatar));
        return;
    }
    if (button.dataset.deleteMemory !== undefined) {
        deleteMemory(button.dataset.deleteMemory);
        return;
    }
    if (button.dataset.openChatFile !== undefined) {
        button.disabled = true;
        try {
            await openChatThread(button.dataset.openChatFile);
        } catch (error) {
            notify(error.message || '聊天室切換失敗。', 'error');
            console.error('[Midnight Signal] Failed to open chat.', error);
        } finally {
            if (button.isConnected) button.disabled = false;
        }
        return;
    }
    if (button.dataset.renameChatFile !== undefined) {
        openRenameChatSheet(button.dataset.renameChatFile);
        return;
    }

    const actions = {
        close: hideApp,
        'close-sheet': closeSheet,
        characters: openCharacterSheet,
        greetings: openGreetingSheet,
        notifications: openNotifications,
        'current-profile': () => {
            const current = getCurrentCharacter();
            if (!current) {
                openCharacterSheet();
                return;
            }
            selectedProfileCharacterId = current.id;
            render('profile');
        },
        personas: openPersonaSheet,
        'chat-background': openChatBackgroundSheet,
        'clear-chat-background': clearChatBackground,
        'switch-model': () => openNativeSettingSheet('model'),
        'switch-preset': () => openNativeSettingSheet('preset'),
        'save-custom-model': saveCustomModel,
        'import-character': triggerCharacterImport,
        'new-character': openCreateCharacterSheet,
        tokens: () => {
            render('tokens');
            calculateCurrentChatTokens();
        },
        profile: () => render('profile'),
        messages: () => render('messages'),
        'conversation-hub': () => render('conversations'),
        'chat-list': () => openCharacterThreads(context()?.characterId),
        'new-chat': async () => {
            try {
                await createNewCharacterChat();
            } catch (error) {
                notify(error.message || '建立聊天室失敗。', 'error');
                console.error('[Midnight Signal] Failed to create chat.', error);
            }
        },
        'reload-chat-threads': () => loadCharacterChatThreads(context()?.characterId),
        'confirm-rename-chat': renameCharacterChatFromApp,
        relationship: () => openProfileStateView('relationship'),
        memories: () => openProfileStateView('memories'),
        moments: () => render('moments'),
        'save-relationship': saveRelationship,
        'add-memory': addMemory,
        'send-message': sendMessageFromApp,
        'save-persona': savePersonaFromApp,
        'create-character': createCharacterFromApp,
        'reset-chat-tokens': async () => {
            const ctx = context();
            if (!ctx?.chatMetadata) return;
            ctx.chatMetadata[TOKEN_CHAT_KEY] = emptyTokenUsage();
            await ctx.saveMetadata?.();
            render('tokens');
            notify('目前聊天的 Token 統計已重設。', 'success');
        },
        'reset-all-tokens': async () => {
            if (!confirm('確定要清除全部 Token 累計嗎？')) return;
            const ctx = context();
            ctx.extensionSettings[TOKEN_SETTINGS_KEY] = emptyTokenUsage();
            ctx.saveSettingsDebounced?.();
            render('tokens');
            notify('全部 Token 累計已重設。', 'success');
        },
        'reset-data': async () => {
            if (!confirm('確定要清除 Midnight Signal 的收藏，以及目前聊天室的關係狀態與重要記憶嗎？')) return;
            const ctx = context();
            ctx.extensionSettings[MODULE_ID] = structuredClone(DEFAULT_SETTINGS);
            if (ctx.chatMetadata) ctx.chatMetadata[ROLEPLAY_CHAT_KEY] = emptyChatRoleplayState(getCurrentCharacter()?.character);
            saveSettings();
            await saveChatRoleplayState();
            await syncRoleplayContextPrompt();
            render('settings');
            notify('收藏與目前聊天室資料已清除。', 'success');
        },
    };
    actions[button.dataset.action]?.();
}

function handleChange(event) {
    if (event.target?.id === 'msa-character-avatar-file') {
        uploadHighQualityCharacterAvatar(Number(event.target.dataset.avatarCharacterId), event.target.files?.[0]);
        return;
    }
    if (event.target?.id === 'msa-chat-background-file') {
        setChatBackgroundFromFile(event.target.files?.[0]);
        return;
    }
    const input = event.target.closest('[data-setting]');
    if (!input) return;
    if (input.dataset.setting === 'chatFontSize' || input.dataset.setting === 'uiFontScale') {
        handleInput(event);
        return;
    }
    settings()[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.value;
    saveSettings();
    render('settings');
}

function handleInput(event) {
    if (event.target?.id === 'msa-character-search') {
        characterSearchQuery = event.target.value || '';
        applyCharacterFilters();
        return;
    }
    const input = event.target.closest('[data-setting="chatFontSize"], [data-setting="uiFontScale"]');
    if (!input) return;
    if (input.dataset.setting === 'uiFontScale') {
        const percent = Math.min(140, Math.max(80, Number(input.value) || 100));
        settings().uiFontScale = percent / 100;
        applyVisualSettings();
        const output = document.getElementById('msa-ui-font-value');
        if (output) output.textContent = `${percent}%`;
        saveSettings();
        return;
    }
    const value = Math.min(22, Math.max(10, Number(input.value) || 12));
    settings().chatFontSize = value;
    applyVisualSettings();
    const output = document.getElementById('msa-chat-font-value');
    if (output) output.textContent = `${value} px`;
    saveSettings();
}

function mount() {
    if (document.getElementById(ROOT_ID)) return;
    document.body.insertAdjacentHTML('beforeend', launcherMarkup());
    document.body.insertAdjacentHTML('beforeend', shellMarkup());

    document.getElementById('msa-launcher').addEventListener('click', () => showApp('home'));
    document.getElementById(ROOT_ID).addEventListener('click', handleClick);
    document.getElementById(ROOT_ID).addEventListener('change', handleChange);
    document.getElementById(ROOT_ID).addEventListener('input', handleInput);
    document.getElementById(ROOT_ID).addEventListener('focusin', event => {
        scheduleViewportSync();
        if (event.target.id === 'msa-chat-input') {
            setTimeout(() => event.target.scrollIntoView?.({ block: 'nearest' }), 80);
        }
    });
    document.getElementById(ROOT_ID).addEventListener('focusout', () => setTimeout(scheduleViewportSync, 80));
    document.getElementById(ROOT_ID).addEventListener('keydown', event => {
        if (event.key === 'Escape') hideApp();
        if (event.key === 'Enter' && event.target.id === 'msa-memory-input') addMemory();
        if (event.key === 'Enter' && event.target.id === 'msa-rename-chat-input') {
            event.preventDefault();
            renameCharacterChatFromApp();
        }
        if (event.key === 'Enter' && event.target.id === 'msa-chat-input' && !event.shiftKey) {
            event.preventDefault();
            sendMessageFromApp();
        }
    });

    globalThis.addEventListener?.('resize', scheduleViewportSync, { passive: true });
    globalThis.addEventListener?.('orientationchange', () => {
        fullViewportHeight = 0;
        setTimeout(scheduleViewportSync, 120);
    }, { passive: true });
    globalThis.visualViewport?.addEventListener?.('resize', scheduleViewportSync, { passive: true });
    globalThis.visualViewport?.addEventListener?.('scroll', scheduleViewportSync, { passive: true });
    syncViewportMetrics();

    const extensionsMenu = document.querySelector('#extensionsMenu');
    if (extensionsMenu && !document.getElementById('msa-extension-menu-button')) {
        extensionsMenu.insertAdjacentHTML('beforeend', `<div id="msa-extension-menu-button" class="list-group-item flex-container flexGap5 interactable" tabindex="0">${icon('mobile-screen-button')}<span>Midnight Signal APP</span></div>`);
        document.getElementById('msa-extension-menu-button').addEventListener('click', () => showApp('home'));
    }

    const characterImportInput = document.getElementById('character_import_file');
    if (characterImportInput && !characterImportInput.dataset.msaRefreshBound) {
        characterImportInput.dataset.msaRefreshBound = 'true';
        characterImportInput.addEventListener('change', async () => {
            for (let attempt = 0; attempt < 40; attempt++) {
                await sleep(250);
                if (!characterImportInput.value) break;
            }
            try {
                await refreshCharacterData();
                if (activeView === 'cards' && !document.getElementById(ROOT_ID)?.classList.contains('msa-hidden')) render('cards');
            } catch (error) {
                console.warn('[Midnight Signal] Unable to refresh characters after import.', error);
            }
        });
    }

    const ctx = context();
    installTokenTracker();
    const refresh = async () => {
        const currentId = context()?.characterId;
        selectedCharacterId = currentId !== undefined && currentId !== null && Number.isInteger(Number(currentId)) ? Number(currentId) : selectedCharacterId;
        if (['relationship', 'memories'].includes(activeView)) selectedProfileCharacterId = selectedCharacterId;
        await syncRoleplayContextPrompt();
        if (activeView === 'threads') {
            await loadCharacterChatThreads(selectedCharacterId, { showLoading: false });
        } else if (!document.getElementById(ROOT_ID)?.classList.contains('msa-hidden')) {
            render(activeView);
        }
        if (activeView === 'tokens') calculateCurrentChatTokens();
    };
    ['CHAT_CHANGED', 'CHAT_RENAMED', 'CHAT_DELETED', 'CHARACTER_EDITED', 'CHARACTER_DELETED', 'CHARACTER_CREATED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED'].forEach(name => {
        const eventName = ctx?.eventTypes?.[name] || ctx?.event_types?.[name];
        if (eventName) ctx.eventSource?.on?.(eventName, refresh);
    });

    selectedCharacterId = ctx?.characterId !== undefined && ctx?.characterId !== null && Number.isInteger(Number(ctx.characterId)) ? Number(ctx.characterId) : null;
    syncRoleplayContextPrompt().catch(error => console.warn('[Midnight Signal] Unable to initialize roleplay context prompt.', error));
    if (settings().autoOpen) setTimeout(() => showApp('home'), 350);
    console.info('[Midnight Signal] Extension loaded.');
}

async function initialize() {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (globalThis.SillyTavern?.getContext && document.body) {
            mount();
            return;
        }
        await sleep(100);
    }
    console.error('[Midnight Signal] SillyTavern context was not available.');
}

initialize();
