// bbgamez frontend v3 - rebuilt
(() => {
    'use strict';

    function resolveBackendUrl() {
        const params = new URLSearchParams(window.location.search);
        const queryApi = (params.get('api') || '').trim();
        if (queryApi) return queryApi.replace(/\/+$/, '');

        const configApi = (window.JETTIC_CONFIG?.backendUrl || '').trim();
        if (configApi) return configApi.replace(/\/+$/, '');

        const host = window.location.hostname;
        const port = window.location.port;
        if ((host === 'localhost' || host === '127.0.0.1') && port && port !== '3000') {
            return `http://${host}:3000`;
        }

        return window.location.origin.replace(/\/+$/, '');
    }

    let backendUrl = resolveBackendUrl();
    window.JETTIC_BACKEND_URL = backendUrl;
    const ONLINE_PING_INTERVAL = 10 * 1000;

    const state = {
        games: [],
        filtered: [],
        categories: [],
        favorites: new Set(),
        user: null,
        friends: { friends: [], incomingRequests: [], outgoingRequests: [], blocked: [] },
        settings: null,
        settingPresets: { panicButtons: [], tabDisguises: [] },
        currentGame: null,
        proxyEnabled: false,
        adminRequests: [],
        adminReports: [],
        adminGames: [],
        adminUsers: [],
        adminLoginCache: {},
        adminDefaults: null,
        adminAnalytics: null,
        adminAnalyticsRetention: null,
        adminAnalyticsRange: '24h',
        adminAnalyticsSearch: '',
        adminConfig: null,
        adminSearchQueries: { requests: '', reports: '', games: '', users: '' },
        adminTab: 'requests'
    };

    const runtime = {
        friendsPoll: null,
        friendsSnapshot: null,
        friendsPlayingMap: new Map(),
        onlinePing: null,
        healthPoll: null,
        currentPage: 'home',
        closingGame: null,
        closeTicker: null,
        playSession: null,
        adminGameThumbData: null,
        adminGameRequestId: null,
        settingsSaveTimer: null,
        panicHandler: null,
        defaultTitle: document.title,
        defaultFavicon: null,
        lastOnlineState: navigator.onLine !== false,
        offlineNotified: false,
        handlingRoute: false,
        pendingRoute: null,
        lastPlayedCache: [],
        pageTransitionId: 0,
        panelTransitionId: 0
    };

    const HOME_PATH = '/';
    const GAME_ROUTE_PREFIX = '/game/';

    let actionModalResolver = null;
    let presetEditContext = null;

    const els = {};

    const api = {
        async request(path, options = {}) {
            if (!backendUrl) throw new Error('Backend URL is not configured');
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            let res;
            try {
                res = await fetch(`${backendUrl}${path}`, {
                    credentials: 'include',
                    cache: 'no-store',
                    mode: 'cors',
                    signal: options.signal || controller.signal,
                    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
                    ...options
                });
            } catch (err) {
                clearTimeout(timer);
                const name = err?.name || '';
                throw new Error(name === 'AbortError' ? 'Backend request timed out' : 'Backend is offline or unreachable');
            }
            clearTimeout(timer);
            if (!res.ok) {
                let msg = res.statusText;
                try { msg = (await res.json()).error || msg; } catch (_) {}
                const err = new Error(msg);
                err.status = res.status;
                throw err;
            }
            const ct = res.headers.get('content-type') || '';
            return ct.includes('application/json') ? res.json() : res.text();
        },
        get: (p) => api.request(p),
        post: (p, b) => api.request(p, { method: 'POST', body: JSON.stringify(b || {}) }),
        put: (p, b) => api.request(p, { method: 'PUT', body: JSON.stringify(b || {}) })
    };

    async function loadAdminDefaults(force = false) {
        if (!state.user?.admin) return;
        if (state.adminDefaults && !force) { renderAdminDefaults(); return; }
        if (els.adminDefaultsFeedback) els.adminDefaultsFeedback.textContent = '';
        try {
            const data = await api.get('/api/admin/defaults');
            const sanitizedPresets = sanitizePresets(data.presets || {});
            state.adminDefaults = { ...data, presets: sanitizedPresets };
            state.settingPresets = sanitizedPresets;
            renderAdminDefaults();
        } catch (err) {
            if (els.adminDefaultsFeedback) els.adminDefaultsFeedback.textContent = err.message || 'Failed to load defaults';
        }
    }

    function renderAdminDefaults() {
        if (!state.adminDefaults) return;
        const { defaults = {}, presets = {} } = state.adminDefaults;
        if (els.adminDefaultPanicEnabled) els.adminDefaultPanicEnabled.checked = !!defaults.panicEnabled;
        if (els.adminDefaultPanicUrl) els.adminDefaultPanicUrl.value = defaults.panicUrl || '';
        if (els.adminDefaultPanicKeybind) els.adminDefaultPanicKeybind.value = defaults.panicKeybind || '';
        if (els.adminDefaultPanicPreset) els.adminDefaultPanicPreset.value = defaults.panicPreset || '';
        if (els.adminDefaultTabEnabled) els.adminDefaultTabEnabled.checked = !!defaults.tabDisguiseEnabled;
        if (els.adminDefaultTabTitle) els.adminDefaultTabTitle.value = defaults.tabDisguiseTitle || '';
        if (els.adminDefaultTabFavicon) els.adminDefaultTabFavicon.value = defaults.tabDisguiseFavicon || '';
        if (els.adminDefaultTabSource) els.adminDefaultTabSource.value = defaults.tabDisguiseSource || '';
        if (els.adminDefaultTabPreset) els.adminDefaultTabPreset.value = defaults.tabDisguisePreset || '';
        populatePresetSelect(els.adminDefaultPanicPreset, presets.panicButtons || []);
        populatePresetSelect(els.adminDefaultTabPreset, presets.tabDisguises || []);
        renderAdminPresetList('panic', els.adminDefaultsPanicList, presets.panicButtons || []);
        renderAdminPresetList('disguise', els.adminDefaultsDisguiseList, presets.tabDisguises || []);
    }

    function sanitizePresets(presets = {}) {
        const panicButtons = (presets.panicButtons || []).map((p) => ({
            ...p,
            label: (p.label || '').trim() || 'Preset',
            url: (p.url || '').trim(),
            keybind: (p.keybind || 'Escape').trim() || 'Escape'
        }));
        const tabDisguises = (presets.tabDisguises || []).map((p) => ({
            ...p,
            label: (p.label || p.title || '').trim() || 'Preset',
            title: (p.title || p.label || '').trim(),
            favicon: (p.favicon || '').trim(),
            sourceUrl: (p.sourceUrl || '').trim()
        }));
        return { panicButtons, tabDisguises };
    }

    function renderAdminPresetList(type, container, items) {
        if (!container) return;
        container.classList.add('admin-presets-list');
        container.innerHTML = '';
        const list = items || [];
        list.forEach((item, idx) => {
            if (type === 'panic') {
                const card = document.createElement('div');
                card.className = 'admin-preset-card';
                const meta = document.createElement('div');
                meta.className = 'admin-preset-meta';
                const name = document.createElement('div');
                name.className = 'admin-preset-name';
                name.textContent = item.label || 'Preset';
                const url = document.createElement('a');
                url.className = 'admin-preset-url';
                url.textContent = item.url || 'https://';
                url.href = item.url || '#';
                url.target = '_blank';
                url.rel = 'noreferrer noopener';
                meta.append(name, url);

                const actions = document.createElement('div');
                actions.className = 'admin-preset-actions';
                const edit = document.createElement('button');
                edit.type = 'button';
                edit.className = 'friend-action-btn';
                edit.title = 'Edit preset';
                edit.innerHTML = '<i class="fas fa-pen"></i>';
                edit.addEventListener('click', () => openPresetEditModal('panic', idx));
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'friend-action-btn danger';
                del.title = 'Delete preset';
                del.innerHTML = '<i class="fas fa-trash"></i>';
                del.addEventListener('click', async () => {
                    const res = await openActionModal({
                        title: 'Delete preset',
                        message: `Delete preset "${item.label || 'Preset'}"?`,
                        confirmText: 'Delete',
                        cancelText: 'Cancel',
                        tone: 'danger'
                    });
                    if (!res.confirmed) return;
                    list.splice(idx, 1);
                    renderAdminDefaults();
                });
                actions.append(edit, del);
                card.append(meta, actions);
                container.appendChild(card);
            } else {
                const card = document.createElement('div');
                card.className = 'admin-preset-card';
                const meta = document.createElement('div');
                meta.className = 'admin-preset-meta';
                const name = document.createElement('div');
                name.className = 'admin-preset-name';
                name.textContent = item.label || item.title || 'Preset';
                const source = document.createElement('a');
                source.className = 'admin-preset-url';
                source.textContent = item.sourceUrl || 'https://';
                source.href = item.sourceUrl || '#';
                source.target = '_blank';
                source.rel = 'noreferrer noopener';
                meta.append(name, source);
                if (item.favicon) {
                    const fav = document.createElement('div');
                    fav.className = 'admin-preset-keybind';
                    fav.textContent = item.favicon;
                    meta.appendChild(fav);
                }

                const actions = document.createElement('div');
                actions.className = 'admin-preset-actions';
                const edit = document.createElement('button');
                edit.type = 'button';
                edit.className = 'friend-action-btn';
                edit.title = 'Edit disguise preset';
                edit.innerHTML = '<i class="fas fa-pen"></i>';
                edit.addEventListener('click', () => openPresetEditModal('disguise', idx));
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'friend-action-btn danger';
                del.title = 'Delete preset';
                del.innerHTML = '<i class="fas fa-trash"></i>';
                del.addEventListener('click', async () => {
                    const res = await openActionModal({
                        title: 'Delete preset',
                        message: `Delete preset "${item.label || item.title || 'Preset'}"?`,
                        confirmText: 'Delete',
                        cancelText: 'Cancel',
                        tone: 'danger'
                    });
                    if (!res.confirmed) return;
                    list.splice(idx, 1);
                    renderAdminDefaults();
                });
                actions.append(edit, del);
                card.append(meta, actions);
                container.appendChild(card);
            }
        });
    }

    function addAdminPreset(type) {
        if (!state.adminDefaults) state.adminDefaults = { defaults: {}, presets: { panicButtons: [], tabDisguises: [] } };
        const presets = state.adminDefaults.presets || { panicButtons: [], tabDisguises: [] };
        if (type === 'panic') {
            presets.panicButtons = presets.panicButtons || [];
            const id = (crypto?.randomUUID?.() || `panic-${Date.now()}-${Math.random().toString(16).slice(2)}`);
            presets.panicButtons.push({ id, label: 'Preset', url: '', keybind: 'Escape' });
        } else {
            presets.tabDisguises = presets.tabDisguises || [];
            const id = (crypto?.randomUUID?.() || `disguise-${Date.now()}-${Math.random().toString(16).slice(2)}`);
            presets.tabDisguises.push({ id, label: 'Preset', title: '', favicon: '', sourceUrl: '' });
        }
        state.adminDefaults.presets = presets;
        renderAdminDefaults();
    }

    async function saveAdminDefaults() {
        if (!state.user?.admin) return;
        if (els.adminDefaultsFeedback) {
            els.adminDefaultsFeedback.textContent = '';
            els.adminDefaultsFeedback.style.color = '#58a6ff';
        }
        const payload = {
            defaults: {
                panicEnabled: !!els.adminDefaultPanicEnabled?.checked,
                panicUrl: (els.adminDefaultPanicUrl?.value || '').trim(),
                panicKeybind: (els.adminDefaultPanicKeybind?.value || '').trim(),
                panicPreset: (els.adminDefaultPanicPreset?.value || '').trim(),
                tabDisguiseEnabled: !!els.adminDefaultTabEnabled?.checked,
                tabDisguiseTitle: (els.adminDefaultTabTitle?.value || '').trim(),
                tabDisguiseFavicon: (els.adminDefaultTabFavicon?.value || '').trim(),
                tabDisguiseSource: (els.adminDefaultTabSource?.value || '').trim(),
                tabDisguisePreset: (els.adminDefaultTabPreset?.value || '').trim()
            },
            presets: sanitizePresets(state.adminDefaults?.presets)
        };
        if (els.adminDefaultsSaveBtn) els.adminDefaultsSaveBtn.disabled = true;
        try {
            const res = await api.put('/api/admin/defaults', payload);
            state.adminDefaults = res;
            state.settingPresets = res.presets || state.settingPresets;
            renderAdminDefaults();
            if (els.adminDefaultsFeedback) {
                els.adminDefaultsFeedback.textContent = 'Saved defaults';
                els.adminDefaultsFeedback.style.color = '#58a6ff';
            }
        } catch (err) {
            if (els.adminDefaultsFeedback) {
                els.adminDefaultsFeedback.textContent = err.message || 'Failed to save defaults';
                els.adminDefaultsFeedback.style.color = '#f85149';
            }
        } finally {
            if (els.adminDefaultsSaveBtn) els.adminDefaultsSaveBtn.disabled = false;
        }
    }

    function setAdminConfigFeedback(message, isError = false) {
        if (!els.adminConfigFeedback) return;
        els.adminConfigFeedback.textContent = message || '';
        els.adminConfigFeedback.style.color = isError ? '#f85149' : '#58a6ff';
    }

    function renderAdminConfigMeta(meta = {}) {
        if (!els.adminConfigMeta || !els.adminConfigFileSelect) return;
        const updatedText = meta.updatedAt ? new Date(meta.updatedAt).toLocaleString() : 'unknown';
        const bytes = Number(meta.bytes) || 0;
        const currentFile = meta.file || els.adminConfigFileSelect.value || 'config.yml';
        els.adminConfigMeta.innerHTML = `
            <select id="adminConfigFileSelect" class="admin-config-file-select" aria-label="Select backend data file"></select>
            <span class="admin-config-meta-info">Size: ${bytes} bytes • Updated: ${updatedText}</span>
        `;
        const select = els.adminConfigMeta.querySelector('#adminConfigFileSelect');
        if (select) {
            select.innerHTML = '';
            const options = (state.adminConfigFiles && state.adminConfigFiles.length ? state.adminConfigFiles : [currentFile]);
            options.forEach((file) => {
                const option = document.createElement('option');
                option.value = file;
                option.textContent = file;
                if (file === currentFile) option.selected = true;
                select.appendChild(option);
            });
            select.value = currentFile;
            select.onchange = async () => {
                await loadAdminConfigFile(true);
            };
            els.adminConfigFileSelect = select;
        }
    }

    async function loadAdminConfigFiles() {
        try {
            const data = await api.get('/api/admin/config-files');
            state.adminConfigFiles = Array.isArray(data.files) ? data.files : [];
            if (!state.adminConfigFiles.length) state.adminConfigFiles = ['config.yml'];
            if (els.adminConfigFileSelect) {
                const current = els.adminConfigFileSelect.value || state.adminConfig?.file || 'config.yml';
                const select = els.adminConfigFileSelect;
                select.innerHTML = '';
                state.adminConfigFiles.forEach((file) => {
                    const option = document.createElement('option');
                    option.value = file;
                    option.textContent = file;
                    if (file === current) option.selected = true;
                    select.appendChild(option);
                });
                if (!state.adminConfigFiles.includes(current)) select.value = state.adminConfigFiles[0];
            }
        } catch (err) {
            console.warn('Failed to list config files', err);
            state.adminConfigFiles = ['config.yml'];
        }
    }

    async function loadAdminConfigFile(force = false) {
        if (!state.user?.admin) return;
        const selectedFile = els.adminConfigFileSelect?.value || state.adminConfig?.file || 'config.yml';
        if (state.adminConfig && state.adminConfig.file === selectedFile && !force) {
            if (els.adminConfigEditor) els.adminConfigEditor.value = state.adminConfig.content || '';
            renderAdminConfigMeta(state.adminConfig);
            return;
        }
        setAdminConfigFeedback('Loading config file...');
        if (els.adminConfigRefresh) els.adminConfigRefresh.disabled = true;
        try {
            const data = await api.get(`/api/admin/config-file?file=${encodeURIComponent(selectedFile)}`);
            state.adminConfig = {
                file: data.file || selectedFile,
                content: data.content || '',
                bytes: data.bytes || 0,
                updatedAt: data.updatedAt || null
            };
            if (els.adminConfigEditor) els.adminConfigEditor.value = state.adminConfig.content;
            renderAdminConfigMeta(state.adminConfig);
            setAdminConfigFeedback(`Loaded ${state.adminConfig.file}`);
        } catch (err) {
            setAdminConfigFeedback(err.message || 'Failed to load config file', true);
        } finally {
            if (els.adminConfigRefresh) els.adminConfigRefresh.disabled = false;
        }
    }

    async function saveAdminConfigFile() {
        if (!state.user?.admin || !els.adminConfigEditor) return;
        const selectedFile = els.adminConfigFileSelect?.value || state.adminConfig?.file || 'config.yml';
        const content = els.adminConfigEditor.value || '';
        if (!content.trim()) {
            setAdminConfigFeedback('Config content cannot be empty', true);
            return;
        }
        if (els.adminConfigSaveBtn) els.adminConfigSaveBtn.disabled = true;
        if (els.adminConfigRefresh) els.adminConfigRefresh.disabled = true;
        setAdminConfigFeedback(`Saving ${selectedFile}...`);
        try {
            const result = await api.put('/api/admin/config-file', { file: selectedFile, content });
            state.adminConfig = {
                ...(state.adminConfig || {}),
                content,
                file: result.file || selectedFile,
                bytes: result.bytes || new Blob([content]).size,
                updatedAt: result.updatedAt || null
            };
            renderAdminConfigMeta(state.adminConfig);
            setAdminConfigFeedback(`Saved ${state.adminConfig.file}`);
            showToast('Backend data file saved');
        } catch (err) {
            setAdminConfigFeedback(err.message || 'Failed to save config file', true);
        } finally {
            if (els.adminConfigSaveBtn) els.adminConfigSaveBtn.disabled = false;
            if (els.adminConfigRefresh) els.adminConfigRefresh.disabled = false;
        }
    }

    document.addEventListener('DOMContentLoaded', init);

    function init() {
        cacheElements();
        const currentIcon = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"]');
        runtime.defaultFavicon = currentIcon ? currentIcon.getAttribute('href') : null;
        runtime.pendingRoute = parseRouteFromPath(window.location.pathname);
        bindNavigation();
        bindAuthModal();
        bindRequestForm();
        bindAdminUI();
        bindProfileForm();
        bindProfileSecurity();
        bindSettingsForm();
        bindFriendsUI();
        bindFavoritesUI();
        bindGameControls();
        bindReportUI();
        bindLogoutModal();
        bindBannedModal();
        renderVersionInfo();
        renderBackendInfo();
        window.addEventListener('resize', renderGameAds);
        registerServiceWorker();
        applyCurrentSectionSetting(true);
        els.offlineReloadBtn?.addEventListener('click', () => window.location.reload());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') sendOnlinePing();
        });
        window.addEventListener('focus', () => sendOnlinePing());
        window.addEventListener('offline', () => handleConnectivityChange(false));
        window.addEventListener('online', () => handleConnectivityChange(true));
        window.addEventListener('popstate', handlePopState);
        setActiveNav('home');
        showPage('home', { skipHistory: true, replaceHistory: true });
        loadInitial();
    }

    function renderVersionInfo() {
        if (!els.settingsVersion) return;
        const raw = (window.JETTIC_VERSION || '').toString().trim();
        const version = raw || 'dev';
        els.settingsVersion.textContent = `Version: ${version}`;
    }

    function renderBackendInfo() {
        if (!els.settingsBackend) return;
        if (!backendUrl) {
            backendUrl = resolveBackendUrl();
            window.JETTIC_BACKEND_URL = backendUrl;
        }
        const backend = (window.JETTIC_BACKEND_URL || backendUrl || '').trim();
        els.settingsBackend.textContent = backend ? `Backend: ${backend}` : 'Backend: not configured';
    }

    function cacheElements() {
        Object.assign(els, {
            navItems: Array.from(document.querySelectorAll('.nav-item')),
            pages: {
                home: document.getElementById('homePage'),
                favorites: document.getElementById('favoritesPage'),
                friends: document.getElementById('friendsPage'),
                settings: document.getElementById('settingsPage'),
                profile: document.getElementById('profilePage'),
                request: document.getElementById('requestPage'),
                admin: document.getElementById('adminPage'),
                privacy: document.getElementById('privacyPage'),
                terms: document.getElementById('termsPage'),
                game: document.getElementById('gamePage')
            },
            statsGames: document.querySelector('[data-stat="games"]'),
            statsCategories: document.querySelector('[data-stat="categories"]'),
            statusDot: document.getElementById('statusDot'),
            statusText: document.getElementById('statusText'),
            searchInput: document.getElementById('searchInput'),
            categoryTabs: document.getElementById('categoryTabs'),
            allGames: document.getElementById('allGames'),
            favoritesGrid: document.getElementById('favoritesGrid'),
            favoritesEmpty: document.getElementById('favoritesEmpty'),
            favoritesLoginBox: document.getElementById('favoritesLoginBox'),
            favoritesLoginNotice: document.getElementById('favoritesLoginNotice'),
            favoritesLoginBtn: document.getElementById('favoritesLoginBtn'),
            accountNavItem: document.getElementById('accountNavItem'),
            accountLabel: document.getElementById('accountLabel'),
            accountAvatar: document.getElementById('accountAvatar'),
            profileDropdown: document.getElementById('profileDropdown'),
            openProfileSettingsBtn: document.getElementById('openProfileSettingsBtn'),
            openSettingsBtn: document.getElementById('openSettingsBtn'),
            logoutFromDropdownBtn: document.getElementById('logoutFromDropdownBtn'),
            friendsAuthNotice: document.getElementById('friendsAuthNotice'),
            friendsAuthNoticeBox: document.getElementById('friendsAuthNoticeBox'),
            friendsContent: document.getElementById('friendsContent'),
            friendsTabNav: document.getElementById('friendsTabNav'),
            friendsTabPanels: Array.from(document.querySelectorAll('.friends-tab-panel')),
            friendsList: document.getElementById('friendsList'),
            manageFriendsList: document.getElementById('manageFriendsList'),
            manageIncomingList: document.getElementById('manageIncomingList'),
            manageOutgoingList: document.getElementById('manageOutgoingList'),
            blockedList: document.getElementById('blockedList'),
            openAddFriendModalBtn: document.getElementById('openAddFriendModalBtn'),
            openAddFriendModalBtnInline: document.getElementById('openAddFriendModalBtnInline'),
            addFriendModal: document.getElementById('addFriendModal'),
            addFriendModalForm: document.getElementById('addFriendModalForm'),
            addFriendModalInput: document.getElementById('addFriendModalInput'),
            addFriendModalFeedback: document.getElementById('addFriendModalFeedback'),
            closeAddFriendModal: document.getElementById('closeAddFriendModal'),
            addFriendModalOverlay: document.getElementById('addFriendModalOverlay'),
            friendsLoginBtn: document.getElementById('friendsLoginBtn'),
            friendsCount: document.getElementById('friendsCount'),
            pendingCount: document.getElementById('pendingCount'),
            profileForm: document.getElementById('profileForm'),
            profileUsername: document.getElementById('profileUsername'),
            profileEmail: document.getElementById('profileEmail'),
            avatarInput: document.getElementById('avatarInput'),
            avatarPreview: document.getElementById('avatarPreview'),
            avatarPlaceholder: document.getElementById('avatarPlaceholder'),
            profileSaveIndicator: document.getElementById('profileSaveIndicator'),
            profileNewEmail: document.getElementById('profileNewEmail'),
            profileEmailPassword: document.getElementById('profileEmailPassword'),
            profileEmailFeedback: document.getElementById('profileEmailFeedback'),
            profileChangeEmailBtn: document.getElementById('profileChangeEmailBtn'),
            profileCurrentPassword: document.getElementById('profileCurrentPassword'),
            profileNewPassword: document.getElementById('profileNewPassword'),
            profilePasswordFeedback: document.getElementById('profilePasswordFeedback'),
            profileChangePasswordBtn: document.getElementById('profileChangePasswordBtn'),
            profileDeletePassword: document.getElementById('profileDeletePassword'),
            profileDeleteFeedback: document.getElementById('profileDeleteFeedback'),
            profileDeleteAccountBtn: document.getElementById('profileDeleteAccountBtn'),
            profilePlaytimeList: document.getElementById('profilePlaytimeList'),
            profilePlaytimeEmpty: document.getElementById('profilePlaytimeEmpty'),
            settingProxyDefault: document.getElementById('settingProxyDefault'),
            settingShowCurrent: document.getElementById('settingShowCurrent'),
            settingsFeedback: document.getElementById('settingsFeedback'),
            settingsVersion: document.getElementById('settingsVersion'),
            settingsBackend: document.getElementById('settingsBackend'),
            settingPanicEnabled: document.getElementById('settingPanicEnabled'),
            settingPanicUrl: document.getElementById('settingPanicUrl'),
            settingPanicKeybind: document.getElementById('settingPanicKeybind'),
            settingPanicPreset: document.getElementById('settingPanicPreset'),
            settingTabEnabled: document.getElementById('settingTabEnabled'),
            settingTabTitle: document.getElementById('settingTabTitle'),
            settingTabFavicon: document.getElementById('settingTabFavicon'),
            settingTabSource: document.getElementById('settingTabSource'),
            settingTabPreset: document.getElementById('settingTabPreset'),
            settingTabFetchBtn: document.getElementById('settingTabFetchBtn'),
            gameFrame: document.getElementById('gameFrame'),
            gameFrameWrapper: document.querySelector('.game-frame-wrapper'),
            gameTitle: document.getElementById('gameTitle'),
            gameCategory: document.getElementById('gameCategory'),
            gameDescription: document.getElementById('gameDescription'),
            gameFriendAvatars: document.getElementById('gameFriendAvatars'),
            gameLoadingOverlay: document.getElementById('gameLoadingOverlay'),
            loadingStatusText: document.getElementById('loadingStatusText'),
            loadingHintText: document.getElementById('loadingHintText'),
            loadingProxyToggle: document.getElementById('loadingProxyToggle'),
            proxyToggleGame: document.getElementById('proxyToggleGame'),
            openReportBtn: document.getElementById('openReportBtn'),
            gameFavBtn: document.getElementById('gameFavBtn'),
            fullscreenBtn: document.getElementById('fullscreenBtn'),
            offlineOverlays: document.getElementById('offlineOverlays'),
            mainOfflineOverlay: document.getElementById('mainOfflineOverlay'),
            gameOfflineOverlay: document.getElementById('gameOfflineOverlay'),
            offlineReloadBtn: document.getElementById('offlineReloadBtn'),
            offlineMessage: document.getElementById('offlineMessage'),
            authModal: document.getElementById('authModal'),
            authTabs: Array.from(document.querySelectorAll('.auth-tab')),
            authForm: document.getElementById('authForm'),
            authEmail: document.getElementById('authEmail'),
            authFeedback: document.getElementById('authFeedback'),
            closeAuthModal: document.getElementById('closeAuthModal'),
            logoutConfirmModal: document.getElementById('logoutConfirmModal'),
            logoutConfirmBtn: document.getElementById('logoutConfirmBtn'),
            logoutCancelBtn: document.getElementById('logoutCancelBtn'),
            toast: document.getElementById('jg-toast'),
            notificationStack: document.getElementById('notificationStack'),
            sidebarCurrentPlaying: document.getElementById('sidebarCurrentPlaying'),
            sidebarHistory: document.getElementById('sidebarHistory'),
            sidebarOnlineFriends: document.getElementById('sidebarOnlineFriends'),
            sidebarCurrentSection: document.getElementById('sidebarCurrentSection'),
            sidebarHistorySection: document.getElementById('sidebarHistorySection'),
            sidebarOnlineSection: document.getElementById('sidebarOnlineSection'),
            settingShowCurrent: document.getElementById('settingShowCurrent'),
            settingsGrid: document.getElementById('settingsGrid'),
            settingsActions: document.getElementById('settingsActions'),
            settingsLoginBox: document.getElementById('settingsLoginBox'),
            settingsLoginBtn: document.getElementById('settingsLoginBtn'),
            panicButton: document.getElementById('panicButton'),
            adminNotifyTests: document.getElementById('adminNotifyTests'),
            adminNotifySuccess: document.getElementById('adminNotifySuccess'),
            adminNotifyWarning: document.getElementById('adminNotifyWarning'),
            adminNotifyError: document.getElementById('adminNotifyError'),
            adminNotifyInfo: document.getElementById('adminNotifyInfo'),
            adminTabSearch: document.getElementById('adminTabSearch'),
            analyticsPlayerCounts: document.getElementById('analyticsPlayerCounts'),
            analyticsAccountsTotal: document.getElementById('analyticsAccountsTotal'),
            analyticsSystemStatus: document.getElementById('analyticsSystemStatus'),
            analyticsGameTable: document.getElementById('analyticsGameTable'),
            analyticsModal: document.getElementById('analyticsModal'),
            analyticsModalBody: document.getElementById('analyticsModalBody'),
            analyticsModalClose: document.getElementById('analyticsModalClose'),
            analyticsMaxButtons: Array.from(document.querySelectorAll('[data-analytics-modal]'))
        });

        els.analyticsRangeLabels = [];

        els.openRequestGameBtn = document.getElementById('openRequestGameBtn');
        els.openAdminPageBtn = document.getElementById('openAdminPageBtn');
        els.accountRequestBtn = document.getElementById('accountRequestBtn');
        els.accountAdminBtn = document.getElementById('accountAdminBtn');
        els.adminRequestsList = document.getElementById('adminRequestsList');
        els.adminRequestsEmpty = document.getElementById('adminRequestsEmpty');
        els.adminRequestsError = document.getElementById('adminRequestsError');
        els.adminRequestsRefresh = document.getElementById('adminRequestsRefresh');
        els.adminReportsList = document.getElementById('adminReportsList');
        els.adminReportsEmpty = document.getElementById('adminReportsEmpty');
        els.adminReportsError = document.getElementById('adminReportsError');
        els.adminReportsRefresh = document.getElementById('adminReportsRefresh');
        els.adminTabNav = document.getElementById('adminTabNav');
        els.adminTabActions = document.getElementById('adminTabActions');
        els.adminTabPanels = Array.from(document.querySelectorAll('#adminTabPanels .friends-tab-panel'));
        els.adminSubpageTitle = document.getElementById('adminSubpageTitle');
        els.adminGamesList = document.getElementById('adminGamesList');
        els.adminGamesEmpty = document.getElementById('adminGamesEmpty');
        els.adminGamesRefresh = document.getElementById('adminGamesRefresh');
        els.adminGameNew = document.getElementById('adminGameNew');
        els.adminGameModal = document.getElementById('adminGameModal');
        els.adminGameModalClose = document.getElementById('adminGameModalClose');
        els.adminGameForm = document.getElementById('adminGameForm');
        els.adminGameId = document.getElementById('adminGameId');
        els.adminGameTitle = document.getElementById('adminGameTitle');
        els.adminGameCategory = document.getElementById('adminGameCategory');
        els.adminGameEmbed = document.getElementById('adminGameEmbed');
        els.adminGameThumb = document.getElementById('adminGameThumb');
        els.adminGameDescription = document.getElementById('adminGameDescription');
        els.adminGameSaveIndicator = document.getElementById('adminGameSaveIndicator');
        els.adminGameFeedback = document.getElementById('adminGameFeedback');
        els.adminGameSaveBtn = document.getElementById('adminGameSaveBtn');
        els.adminMaintenanceConfirmModal = document.getElementById('adminMaintenanceConfirmModal');
        els.adminMaintenanceConfirmText = document.getElementById('adminMaintenanceConfirmText');
        els.adminMaintenanceConfirmBtn = document.getElementById('adminMaintenanceConfirmBtn');
        els.adminMaintenanceCancelBtn = document.getElementById('adminMaintenanceCancelBtn');
        els.adminUserFeedback = document.getElementById('adminUserFeedback');
        els.adminUsersList = document.getElementById('adminUsersList');
        els.adminUsersEmpty = document.getElementById('adminUsersEmpty');
        els.adminUsersRefresh = document.getElementById('adminUsersRefresh');
        els.adminUserNew = document.getElementById('adminUserNew');
        els.adminUserModal = document.getElementById('adminUserModal');
        els.adminUserModalClose = document.getElementById('adminUserModalClose');
        els.adminUserForm = document.getElementById('adminUserForm');
        els.adminUserId = document.getElementById('adminUserId');
        els.adminUserUsername = document.getElementById('adminUserUsername');
        els.adminUserEmail = document.getElementById('adminUserEmail');
        els.adminUserPassword = document.getElementById('adminUserPassword');
        els.adminUserSaveIndicator = document.getElementById('adminUserSaveIndicator');
        els.adminUserSaveBtn = document.getElementById('adminUserSaveBtn');
        els.adminGameThumbUpload = document.getElementById('adminGameThumbUpload');
        els.adminTabNavButtons = Array.from(document.querySelectorAll('#adminTabNav .friends-tab'));
        els.adminDefaultsPanel = document.getElementById('adminDefaultsPanel');
        els.adminDefaultsForm = document.getElementById('adminDefaultsForm');
        els.adminDefaultsFeedback = document.getElementById('adminDefaultsFeedback');
        els.adminDefaultsSaveBtn = document.getElementById('adminDefaultsSaveBtn');
        els.adminDefaultsPanicList = document.getElementById('adminDefaultsPanicList');
        els.adminDefaultsDisguiseList = document.getElementById('adminDefaultsDisguiseList');
        els.adminDefaultsPanicAdd = document.getElementById('adminDefaultsPanicAdd');
        els.adminDefaultsDisguiseAdd = document.getElementById('adminDefaultsDisguiseAdd');
        els.adminConfigPanel = document.getElementById('adminConfigPanel');
        els.adminConfigEditor = document.getElementById('adminConfigEditor');
        els.adminConfigFeedback = document.getElementById('adminConfigFeedback');
        els.adminConfigMeta = document.getElementById('adminConfigMeta');
        els.adminConfigFileSelect = document.getElementById('adminConfigFileSelect');
        els.adminConfigRefresh = document.getElementById('adminConfigRefresh');
        els.adminConfigSaveBtn = document.getElementById('adminConfigSaveBtn');
        els.adminRelationsModal = document.getElementById('adminRelationsModal');
        els.adminRelationsOverlay = document.getElementById('adminRelationsOverlay');
        els.adminRelationsClose = document.getElementById('adminRelationsClose');
        els.adminRelationsBody = document.getElementById('adminRelationsBody');
        els.adminRelationsTitle = document.getElementById('adminRelationsTitle');
        if (els.analyticsModal && els.analyticsModal.parentElement !== document.body) {
            document.body.appendChild(els.analyticsModal);
        }
        els.adminDefaultPanicEnabled = document.getElementById('adminDefaultPanicEnabled');
        els.adminDefaultPanicUrl = document.getElementById('adminDefaultPanicUrl');
        els.adminDefaultPanicKeybind = document.getElementById('adminDefaultPanicKeybind');
        els.adminDefaultPanicPreset = document.getElementById('adminDefaultPanicPreset');
        els.adminDefaultTabEnabled = document.getElementById('adminDefaultTabEnabled');
        els.adminDefaultTabTitle = document.getElementById('adminDefaultTabTitle');
        els.adminDefaultTabFavicon = document.getElementById('adminDefaultTabFavicon');
        els.adminDefaultTabSource = document.getElementById('adminDefaultTabSource');
        els.adminDefaultTabPreset = document.getElementById('adminDefaultTabPreset');
        els.adminActionModal = document.getElementById('adminActionModal');
        els.adminActionOverlay = document.getElementById('adminActionOverlay');
        els.adminActionTitle = document.getElementById('adminActionTitle');
        els.adminActionMessage = document.getElementById('adminActionMessage');
        els.adminActionInputRow = document.getElementById('adminActionInputRow');
        els.adminActionInputLabel = document.getElementById('adminActionInputLabel');
        els.adminActionInput = document.getElementById('adminActionInput');
        els.adminActionConfirm = document.getElementById('adminActionConfirm');
        els.adminActionCancel = document.getElementById('adminActionCancel');
        els.adminPresetModal = document.getElementById('adminPresetModal');
        els.adminPresetOverlay = document.getElementById('adminPresetOverlay');
        els.adminPresetClose = document.getElementById('adminPresetClose');
        els.adminPresetTitle = document.getElementById('adminPresetTitle');
        els.adminPresetForm = document.getElementById('adminPresetForm');
        els.adminPresetName = document.getElementById('adminPresetName');
        els.adminPresetUrl = document.getElementById('adminPresetUrl');
        els.adminPresetFavicon = document.getElementById('adminPresetFavicon');
        els.adminPresetSource = document.getElementById('adminPresetSource');
        els.adminPresetSave = document.getElementById('adminPresetSave');
        els.adminPresetCloseBtn = document.getElementById('adminPresetCloseBtn');
        els.adminLoginModal = document.getElementById('adminLoginModal');
        els.adminLoginOverlay = document.getElementById('adminLoginOverlay');
        els.adminLoginTitle = document.getElementById('adminLoginTitle');
        els.adminLoginList = document.getElementById('adminLoginList');
        els.adminLoginClose = document.getElementById('adminLoginClose');
        els.bannedModal = document.getElementById('bannedModal');
        els.bannedReason = document.getElementById('bannedReason');
        els.bannedLogoutBtn = document.getElementById('bannedLogoutBtn');
        els.bannedDeleteBtn = document.getElementById('bannedDeleteBtn');
        els.gameDisabledNotice = document.getElementById('gameDisabledNotice');
        els.gameAdRail = document.getElementById('gameAdRail');
        els.gameAdSlots = document.getElementById('gameAdSlots');
        els.reportModal = document.getElementById('reportModal');
        els.reportOverlay = document.getElementById('reportOverlay');
        els.reportForm = document.getElementById('reportForm');
        els.reportSummary = document.getElementById('reportSummary');
        els.reportCategory = document.getElementById('reportCategory');
        els.reportDescription = document.getElementById('reportDescription');
        els.reportFeedback = document.getElementById('reportFeedback');
        els.reportSubmitBtn = document.getElementById('reportSubmitBtn');
        els.reportSubmitIndicator = document.getElementById('reportSubmitIndicator');
        els.reportClose = document.getElementById('reportClose');
        els.reportCancelBtn = document.getElementById('reportCancelBtn');
        els.reportGameId = document.getElementById('reportGameId');
        els.reportGameTitle = document.getElementById('reportGameTitle');
        els.reportGameMeta = document.getElementById('reportGameMeta');
    }

    function bindNavigation() {
        els.navItems.forEach((item) => item.addEventListener('click', (e) => {
            const page = item.dataset.page;
            if (!page) return; // Skip non-navigation items like account
            e.preventDefault();
            setActiveNav(page);
            showPage(page);
        }));

        els.accountNavItem?.addEventListener('click', (e) => {
            e.preventDefault();
            if (state.user) {
                toggleAccountDropdown();
            } else {
                openAuthModal('login');
            }
        });

        els.openProfileSettingsBtn?.addEventListener('click', () => { hideProfileDropdown(); showPage('profile'); });
        els.openSettingsBtn?.addEventListener('click', () => { hideProfileDropdown(); showPage('settings'); });
        els.openRequestGameBtn?.addEventListener('click', () => { hideProfileDropdown(); showPage('request'); });
        els.openAdminPageBtn?.addEventListener('click', () => { hideProfileDropdown(); showPage('admin'); });
        els.logoutFromDropdownBtn?.addEventListener('click', () => { hideProfileDropdown(); showLogoutConfirm(); });

        document.addEventListener('click', (e) => {
            if (e.target.closest('#accountNavItem') || e.target.closest('#accountDropdown')) return;
            hideAccountDropdown();
        });

        document.getElementById('accountProfileBtn')?.addEventListener('click', () => { hideAccountDropdown(); showPage('profile'); });
        document.getElementById('accountRequestBtn')?.addEventListener('click', () => { hideAccountDropdown(); showPage('request'); });
        document.getElementById('accountAdminBtn')?.addEventListener('click', () => { hideAccountDropdown(); showPage('admin'); });
        document.getElementById('accountLogoutBtn')?.addEventListener('click', () => { hideAccountDropdown(); showLogoutConfirm(); });
    }

    function bindAuthModal() {
        const updateAuthMode = (mode) => {
            els.authTabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === mode));
            if (els.authModal) els.authModal.dataset.mode = mode;
            const emailRow = document.querySelector('.auth-email');
            if (emailRow) emailRow.style.display = mode === 'register' ? 'block' : 'none';
            if (els.authEmail) {
                els.authEmail.required = mode === 'register';
                if (mode !== 'register') els.authEmail.value = '';
            }
        };
        els.authTabs.forEach((tab) => tab.addEventListener('click', () => {
            updateAuthMode(tab.dataset.tab);
        }));
        updateAuthMode('login');
        els.closeAuthModal?.addEventListener('click', closeAuthModal);
        els.authModal?.querySelector('.modal-overlay')?.addEventListener('click', closeAuthModal);
        els.authForm?.addEventListener('submit', handleAuthSubmit);
    }

    function bindAdminUI() {
        els.adminRequestsRefresh?.addEventListener('click', () => loadAdminRequests(true));
        els.adminReportsRefresh?.addEventListener('click', () => loadAdminReports(true));
        els.adminGamesRefresh?.addEventListener('click', () => loadAdminGames(true));
        els.adminUsersRefresh?.addEventListener('click', () => loadAdminUsers(true));
        els.adminConfigRefresh?.addEventListener('click', () => loadAdminConfigFile(true));
        els.adminConfigFileSelect?.addEventListener('change', async () => { await loadAdminConfigFile(true); });
        els.adminConfigSaveBtn?.addEventListener('click', async () => { await saveAdminConfigFile(); });
        els.adminConfigEditor?.addEventListener('keydown', async (e) => {
            const wantsSave = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's';
            if (!wantsSave) return;
            e.preventDefault();
            await saveAdminConfigFile();
        });
        els.adminTabSearch?.addEventListener('input', (e) => {
            const value = (e.target.value || '').trim().toLowerCase();
            const tab = state.adminTab || 'requests';
            if (tab === 'requests' || tab === 'reports' || tab === 'games' || tab === 'users') {
                state.adminSearchQueries[tab] = value;
                if (tab === 'requests') renderAdminRequests();
                if (tab === 'reports') renderAdminReports();
                if (tab === 'games') renderAdminGames();
                if (tab === 'users') renderAdminUsers();
                return;
            }
            if (tab === 'analytics') {
                state.adminAnalyticsSearch = value;
                renderAdminAnalytics();
            }
        });

        els.adminGameNew?.addEventListener('click', () => openAdminGameModal());
        els.adminGameModalClose?.addEventListener('click', closeAdminGameModal);
        els.adminGameModal?.addEventListener('click', (e) => { if (e.target === els.adminGameModal) closeAdminGameModal(); });
        els.adminMaintenanceCancelBtn?.addEventListener('click', closeAdminMaintenanceConfirm);
        els.adminMaintenanceConfirmModal?.addEventListener('click', (e) => { if (e.target === els.adminMaintenanceConfirmModal) closeAdminMaintenanceConfirm(); });
        els.adminUserNew?.addEventListener('click', () => openAdminUserModal());
        els.adminUserModalClose?.addEventListener('click', closeAdminUserModal);
        els.adminUserModal?.addEventListener('click', (e) => { if (e.target === els.adminUserModal) closeAdminUserModal(); });
        els.adminDefaultsForm?.addEventListener('submit', async (e) => { e.preventDefault(); await saveAdminDefaults(); });
        els.adminDefaultsPanicAdd?.addEventListener('click', () => addAdminPreset('panic'));
        els.adminDefaultsDisguiseAdd?.addEventListener('click', () => addAdminPreset('disguise'));
        els.adminActionCancel?.addEventListener('click', handleActionCancel);
        els.adminActionConfirm?.addEventListener('click', handleActionConfirm);
        els.adminActionModal?.addEventListener('click', (e) => { if (e.target === els.adminActionModal || e.target === els.adminActionOverlay) handleActionCancel(); });
        els.adminPresetClose?.addEventListener('click', closePresetEditModal);
        els.adminPresetCloseBtn?.addEventListener('click', closePresetEditModal);
        els.adminPresetModal?.addEventListener('click', (e) => { if (e.target === els.adminPresetModal || e.target === els.adminPresetOverlay) closePresetEditModal(); });
        els.adminPresetForm?.addEventListener('submit', savePresetEdit);
        els.adminLoginClose?.addEventListener('click', closeLoginHistoryModal);
        els.adminLoginModal?.addEventListener('click', (e) => { if (e.target === els.adminLoginModal || e.target === els.adminLoginOverlay) closeLoginHistoryModal(); });
        els.adminRelationsClose?.addEventListener('click', closeAdminRelationsModal);
        els.adminRelationsModal?.addEventListener('click', (e) => { if (e.target === els.adminRelationsModal || e.target === els.adminRelationsOverlay) closeAdminRelationsModal(); });
        (els.analyticsMaxButtons || []).forEach((btn) => {
            btn.addEventListener('click', () => {
                const type = btn.dataset.analyticsModal;
                openAnalyticsModal(type);
            });
        });
        els.analyticsModalClose?.addEventListener('click', closeAnalyticsModal);
        els.analyticsModal?.addEventListener('click', (e) => {
            if (e.target === els.analyticsModal || e.target.dataset.analyticsModalClose !== undefined) closeAnalyticsModal();
        });

        els.adminTabNav?.addEventListener('click', (e) => {
            const btn = e.target.closest('.friends-tab');
            if (!btn) return;
            switchAdminTab(btn.dataset.tab);
        });

        if (els.adminGameForm) {
            els.adminGameForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                if (!state.user?.admin) return;
                const payload = {
                    title: els.adminGameTitle?.value?.trim(),
                    category: els.adminGameCategory?.value?.trim(),
                    embed: els.adminGameEmbed?.value?.trim(),
                    thumbnail: els.adminGameThumb?.value?.trim(),
                    thumbnailData: runtime.adminGameThumbData,
                    description: els.adminGameDescription?.value?.trim()
                };
                const id = els.adminGameId?.value;
                setAdminGameSaving(true);
                setAdminGameFeedback('', false);
                try {
                    if (id) {
                        const { game } = await api.put(`/api/admin/games/${id}`, payload);
                        upsertAdminGame(game);
                        showToast('Game updated');
                    } else {
                        const { game } = await api.post('/api/admin/games', payload);
                        upsertAdminGame(game);
                        showToast('Game added');
                        if (runtime.adminGameRequestId) {
                            await updateRequestStatus(runtime.adminGameRequestId, 'converted');
                        }
                    }
                    renderAdminGames();
                    closeAdminGameModal();
                } catch (err) {
                    setAdminGameFeedback(err.message || 'Save failed', true);
                } finally {
                    setAdminGameSaving(false);
                    runtime.adminGameRequestId = null;
                    runtime.adminGameThumbData = null;
                }
            });

            els.adminGameThumbUpload?.addEventListener('change', async (e) => {
                const file = e.target.files?.[0];
                runtime.adminGameThumbData = null;
                if (!file) return;
                if (file.size > 1.5 * 1024 * 1024) {
                    setAdminGameFeedback('Thumbnail must be under 1.5MB', true);
                    e.target.value = '';
                    return;
                }
                const reader = new FileReader();
                reader.onload = () => {
                    runtime.adminGameThumbData = reader.result;
                    setAdminGameFeedback('Thumbnail ready to upload', false);
                };
                reader.readAsDataURL(file);
            });
        }

        els.adminMaintenanceConfirmBtn?.addEventListener('click', handleConfirmDisable);
                            if (state.user?.banned?.active) showBannedModal(state.user.banned.reason || 'Your account is banned');

        if (els.adminUserForm) {
            els.adminUserForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                if (!state.user?.admin) return;
                const username = els.adminUserUsername?.value?.trim();
                const email = els.adminUserEmail?.value?.trim();
                const password = els.adminUserPassword?.value || '';
                const id = els.adminUserId?.value;
                setAdminUserSaving(true);
                setAdminUserFeedback('', false);
                if (!email) {
                    setAdminUserFeedback('Email is required', true);
                    setAdminUserSaving(false);
                    return;
                }
                try {
                    if (id) {
                        const payload = { username, email };
                        if (password) payload.password = password;
                        const { user } = await api.put(`/api/admin/users/${id}`, payload);
                        upsertAdminUser(user);
                        showToast('User updated');
                    } else {
                        const { user } = await api.post('/api/admin/users', { username, password, email });
                        upsertAdminUser(user);
                        showToast('User created');
                    }
                    renderAdminUsers();
                    closeAdminUserModal();
                } catch (err) {
                    setAdminUserFeedback(err.message || 'Failed to save user', true);
                } finally {
                    setAdminUserSaving(false);
                }
            });
        }
    }

    function bindRequestForm() {
        const form = document.getElementById('requestForm');
        if (!form) return;
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!state.user) return openAuthModal('login');
            const title = document.getElementById('requestTitle')?.value.trim();
            const url = document.getElementById('requestUrl')?.value.trim();
            const category = document.getElementById('requestCategory')?.value.trim();
            const description = document.getElementById('requestDescription')?.value.trim();
            const indicator = document.getElementById('requestSaveIndicator');
            const feedback = document.getElementById('requestFeedback');
            feedback.textContent = '';
            if (indicator) indicator.style.display = 'inline-block';
            try {
                await api.post('/api/requests', { title, url, category, description });
                feedback.textContent = 'Request submitted for review';
                feedback.style.color = '#58a6ff';
                form.reset();
            } catch (err) {
                feedback.textContent = err.message || 'Failed to submit request';
                feedback.style.color = '#f85149';
            } finally {
                if (indicator) indicator.style.display = 'none';
            }
        });
    }

    function bindSearch() {
        if (!els.searchInput) return;
        const enableSearch = () => {
            els.searchInput.disabled = false;
            els.searchInput.classList.remove('search-disabled');
            els.searchInput.addEventListener('input', () => filterAndRender(), { once: false });
        };
        els.searchInput.disabled = true;
        els.searchInput.classList.add('search-disabled');
        setTimeout(enableSearch, 3000);
    }

    function bindProfileForm() {
        if (!els.profileForm) return;
        els.profileForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!state.user) return openAuthModal('login');
            const payload = {
                username: els.profileUsername.value.trim(),
                avatar: els.avatarPreview?.dataset?.value || null
            };
            toggleSaving(true);
            try {
                const { user } = await api.put('/api/profile', payload);
                state.user = normalizeUser(user);
                state.settings = user.settings || state.settings;
                showToast('Profile saved');
                populateProfileForm();
            } catch (err) {
                showToast(err.message || 'Failed to save profile', true);
            } finally {
                toggleSaving(false);
            }
        });

        els.avatarInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (file.size > 1.5 * 1024 * 1024) {
                showToast('Avatar must be under 1.5 MB', true);
                e.target.value = '';
                return;
            }
            const reader = new FileReader();
            reader.onload = () => {
                els.avatarPreview.src = reader.result;
                els.avatarPreview.style.display = 'block';
                els.avatarPreview.dataset.value = reader.result;
                els.avatarPlaceholder.style.display = 'none';
            };
            reader.readAsDataURL(file);
        });
    }

    function bindProfileSecurity() {
        els.profileChangeEmailBtn?.addEventListener('click', handleProfileEmailChange);
        els.profileChangePasswordBtn?.addEventListener('click', handleProfilePasswordChange);
        els.profileDeleteAccountBtn?.addEventListener('click', () => handleDeleteAccount(false, els.profileDeleteAccountBtn));
    }

    function bindBannedModal() {
        els.bannedLogoutBtn?.addEventListener('click', async () => {
            await logout();
            hideBannedModal();
        });
        els.bannedDeleteBtn?.addEventListener('click', () => handleDeleteAccount(true, els.bannedDeleteBtn));
    }

    function setSecurityFeedback(el, message, isError = false) {
        if (!el) return;
        el.textContent = message || '';
        el.style.color = isError ? '#f85149' : '#58a6ff';
    }

    function setButtonLoading(btn, isLoading) {
        if (!btn) return;
        btn.disabled = !!isLoading;
        btn.classList.toggle('loading', !!isLoading);
    }

    async function handleProfileEmailChange() {
        if (!state.user) return openAuthModal('login');
        const newEmail = (els.profileNewEmail?.value || '').trim();
        const currentPassword = els.profileEmailPassword?.value || '';
        setSecurityFeedback(els.profileEmailFeedback, '');
        if (!newEmail || !currentPassword) {
            setSecurityFeedback(els.profileEmailFeedback, 'Enter a new email and your current password', true);
            return;
        }
        setButtonLoading(els.profileChangeEmailBtn, true);
        try {
            const { user } = await api.put('/api/profile/email', { newEmail, currentPassword });
            state.user = normalizeUser(user);
            populateProfileForm();
            showToast('Email updated');
            setSecurityFeedback(els.profileEmailFeedback, 'Email updated');
            if (els.profileNewEmail) els.profileNewEmail.value = '';
            if (els.profileEmailPassword) els.profileEmailPassword.value = '';
        } catch (err) {
            setSecurityFeedback(els.profileEmailFeedback, err.message || 'Failed to update email', true);
        } finally {
            setButtonLoading(els.profileChangeEmailBtn, false);
        }
    }

    async function handleProfilePasswordChange() {
        if (!state.user) return openAuthModal('login');
        const currentPassword = els.profileCurrentPassword?.value || '';
        const newPassword = els.profileNewPassword?.value || '';
        setSecurityFeedback(els.profilePasswordFeedback, '');
        if (!currentPassword || !newPassword) {
            setSecurityFeedback(els.profilePasswordFeedback, 'Enter your current and new password', true);
            return;
        }
        setButtonLoading(els.profileChangePasswordBtn, true);
        try {
            await api.put('/api/profile/password', { currentPassword, newPassword });
            showToast('Password updated');
            setSecurityFeedback(els.profilePasswordFeedback, 'Password updated');
            if (els.profileCurrentPassword) els.profileCurrentPassword.value = '';
            if (els.profileNewPassword) els.profileNewPassword.value = '';
        } catch (err) {
            setSecurityFeedback(els.profilePasswordFeedback, err.message || 'Failed to update password', true);
        } finally {
            setButtonLoading(els.profileChangePasswordBtn, false);
        }
    }

    async function handleDeleteAccount(fromBannedModal = false, triggerBtn = null) {
        if (!state.user) return openAuthModal('login');
        const password = fromBannedModal ? '' : (els.profileDeletePassword?.value || '').trim();
        const feedbackEl = fromBannedModal ? null : els.profileDeleteFeedback;
        if (feedbackEl) setSecurityFeedback(feedbackEl, '');
        if (!fromBannedModal && !password) {
            setSecurityFeedback(feedbackEl, 'Enter your password to confirm', true);
            return;
        }
        if (!fromBannedModal) {
            const confirmRes = await openActionModal({
                title: 'Delete account',
                message: 'This will permanently remove your account and data.',
                confirmText: 'Delete',
                cancelText: 'Keep account',
                tone: 'danger'
            });
            if (!confirmRes.confirmed) return;
        }
        setButtonLoading(triggerBtn || els.profileDeleteAccountBtn, true);
        try {
            const body = password ? { currentPassword: password } : {};
            await api.request('/api/profile', { method: 'DELETE', body: JSON.stringify(body) });
            showToast('Account deleted');
            if (els.profileDeletePassword) els.profileDeletePassword.value = '';
            hideBannedModal();
            await logout();
        } catch (err) {
            if (feedbackEl) setSecurityFeedback(feedbackEl, err.message || 'Failed to delete account', true);
            else showToast(err.message || 'Failed to delete account', true);
        } finally {
            setButtonLoading(triggerBtn || els.profileDeleteAccountBtn, false);
        }
    }

    function bindSettingsForm() {
        els.settingsLoginBtn?.addEventListener('click', () => openAuthModal('login'));

        const autoSaveInputs = [
            els.settingProxyDefault,
            els.settingShowCurrent,
            els.settingPanicEnabled,
            els.settingPanicUrl,
            els.settingPanicKeybind,
            els.settingPanicPreset,
            els.settingTabEnabled,
            els.settingTabTitle,
            els.settingTabFavicon,
            els.settingTabSource,
            els.settingTabPreset
        ].filter(Boolean);

        autoSaveInputs.forEach((input) => {
            const evt = input.type === 'color' || input.type === 'number' ? 'input' : 'change';
            input.addEventListener(evt, () => queueSaveSettings());
        });

        els.settingShowCurrent?.addEventListener('change', (e) => {
            applyCurrentSectionSetting(e.target.checked);
        });

        els.settingPanicPreset?.addEventListener('change', (e) => {
            const id = e.target.value;
            applyPanicPreset(id);
            queueSaveSettings();
        });
        els.settingTabPreset?.addEventListener('change', (e) => {
            const id = e.target.value;
            applyTabPreset(id);
            queueSaveSettings();
        });
        els.settingPanicKeybind?.addEventListener('keydown', (e) => {
            e.preventDefault();
            const combo = formatKeybindFromEvent(e);
            els.settingPanicKeybind.value = combo;
            queueSaveSettings();
        });
        els.settingTabFetchBtn?.addEventListener('click', async () => {
            await fetchTabMetadata();
        });

        const wireTest = (btn, title, msg, tone) => {
            btn?.addEventListener('click', () => pushNotification(title, msg, tone));
        };
        wireTest(els.adminNotifySuccess, 'Success', 'This is a success notification test.', 'success');
        wireTest(els.adminNotifyWarning, 'Warning', 'This is a warning notification test.', 'warning');
        wireTest(els.adminNotifyError, 'Error', 'This is an error notification test.', 'error');
        wireTest(els.adminNotifyInfo, 'Info', 'This is an info notification test.', 'info');

    }

    function bindFriendsUI() {
        els.friendsLoginBtn?.addEventListener('click', () => openAuthModal('login'));

        els.friendsTabNav?.addEventListener('click', (e) => {
            const btn = e.target.closest('.friends-tab');
            if (!btn) return;
            const tab = btn.dataset.tab;
            if (tab === 'add') {
                openAddFriendModal();
                return;
            }
            switchFriendsPanel(tab, btn);
        });

        const openAdd = () => openAddFriendModal();
        els.openAddFriendModalBtn?.addEventListener('click', openAdd);
        els.openAddFriendModalBtnInline?.addEventListener('click', openAdd);

        els.addFriendModalForm?.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!state.user) return openAuthModal('login');
            const username = (els.addFriendModalInput.value || '').trim();
            if (!username) return;
            els.addFriendModalFeedback.textContent = '';
            try {
                await api.post('/api/friends/request', { username });
                els.addFriendModalFeedback.textContent = `Request sent to ${username}`;
                els.addFriendModalFeedback.style.color = '#58a6ff';
                els.addFriendModalInput.value = '';
                setTimeout(closeAddFriendModal, 500);
                await loadFriends();
            } catch (err) {
                if (err.status === 404) {
                    els.addFriendModalFeedback.textContent = 'That account does not exist.';
                } else {
                    els.addFriendModalFeedback.textContent = err.message || 'Failed to send request';
                }
                els.addFriendModalFeedback.style.color = '#f85149';
            }
        });

        const closeAdd = () => closeAddFriendModal();
        els.closeAddFriendModal?.addEventListener('click', closeAdd);
        els.addFriendModalOverlay?.addEventListener('click', closeAdd);
    }

    function bindFavoritesUI() {
        els.favoritesLoginBtn?.addEventListener('click', () => openAuthModal('login'));
    }

    function switchPanelWithTransition(panels = [], targetPanel) {
        if (!targetPanel) return;
        const current = panels.find((p) => p.classList.contains('active'));
        if (current === targetPanel) return;
        const transitionId = ++runtime.panelTransitionId;
        const container = targetPanel.parentElement;
        
        if (container && current) {
            const lockHeight = Math.max(current.offsetHeight || 0, targetPanel.offsetHeight || 0);
            if (lockHeight > 0) container.style.minHeight = `${lockHeight}px`;
            container.style.position = 'relative';
        }

        let currentDone = false;
        let nextDone = false;

        const checkUnlock = () => {
            if (currentDone && nextDone && container) {
                container.style.minHeight = '';
            }
        };

        const finishCurrent = () => {
            if (transitionId !== runtime.panelTransitionId) return;
            if (!current) return;
            current.classList.remove('active', 'leaving', 'animating', 'overlay-leave');
            current.style.display = 'none';
            currentDone = true;
            checkUnlock();
        };

        const finishNext = () => {
            if (transitionId !== runtime.panelTransitionId) return;
            targetPanel.classList.remove('entering', 'animating', 'overlay-enter');
            nextDone = true;
            checkUnlock();
        };

        if (current) {
            current.classList.add('animating', 'leaving', 'overlay-leave');
            const onCurrentEnd = (event) => {
                if (event.target !== current) return;
                current.removeEventListener('transitionend', onCurrentEnd);
                if (transitionId !== runtime.panelTransitionId) return;
                finishCurrent();
            };
            current.addEventListener('transitionend', onCurrentEnd);
            setTimeout(finishCurrent, 280);
        } else {
            currentDone = true;
        }

        targetPanel.style.display = 'block';
        targetPanel.classList.add('active', 'animating', 'entering', 'overlay-enter');
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                targetPanel.classList.remove('entering');
            });
        });
        const onNextEnd = (event) => {
            if (event.target !== targetPanel) return;
            targetPanel.removeEventListener('transitionend', onNextEnd);
            if (transitionId !== runtime.panelTransitionId) return;
            finishNext();
        };
        targetPanel.addEventListener('transitionend', onNextEnd);
        setTimeout(finishNext, 280);
    }

    function switchFriendsPanel(tab, btn) {
        const next = els.friendsTabPanels.find((p) => p.dataset.panel === tab);
        if (!next) return;

        els.friendsTabNav.querySelectorAll('.friends-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));

        switchPanelWithTransition(els.friendsTabPanels, next);
    }

    function bindGameControls() {
        els.proxyToggleGame?.addEventListener('click', () => {
            state.proxyEnabled = !state.proxyEnabled;
            updateProxyUI();
            if (state.currentGame) loadGameFrame(state.currentGame);
        });
        els.gameFavBtn?.addEventListener('click', () => {
            if (!state.currentGame) return;
            toggleFavorite(state.currentGame.id);
        });
        els.fullscreenBtn?.addEventListener('click', () => {
            const wrap = document.querySelector('.game-frame-wrapper');
            if (!wrap) return;
            if (!document.fullscreenElement) wrap.requestFullscreen?.(); else document.exitFullscreen?.();
        });
        els.openReportBtn?.addEventListener('click', () => {
            if (!state.user) return openAuthModal('login');
            openReportModal();
        });
        els.gameFrameWrapper?.addEventListener('click', focusGameFrame, true);
    }

    function bindReportUI() {
        const close = () => closeReportModal();
        els.reportClose?.addEventListener('click', close);
        els.reportCancelBtn?.addEventListener('click', close);
        els.reportOverlay?.addEventListener('click', close);
        els.reportForm?.addEventListener('submit', handleReportSubmit);
    }

    function bindLogoutModal() {
        els.logoutConfirmBtn?.addEventListener('click', async () => { await logout(); hideLogoutConfirm(); });
        els.logoutCancelBtn?.addEventListener('click', hideLogoutConfirm);
    }

    async function loadInitial() {
        try {
            const [config, games, stats, me] = await Promise.all([
                api.get('/api/config').catch(() => null),
                api.get('/api/games'),
                api.get('/api/stats').catch(() => null),
                api.get('/api/auth/me').catch(() => null)
            ]);
            state.games = Array.isArray(games) ? games : [];
            state.filtered = state.games.slice();
            state.categories = buildCategories(state.games);
            buildCategoryTabs();
            renderGames();
            if (stats) updateStats(stats); else updateStats({ totalGames: state.games.length, categoryCount: state.categories.length });
            if (me?.user) {
                state.user = normalizeUser(me.user);
                state.favorites = new Set((me.user.favorites || []).map(String));
                state.settings = me.user.settings || null;
                await loadSettingsIfNeeded();
                await loadFriends();
                startFriendsPolling();
                updateAccountAvatar(state.user);
                await sendOnlinePing();
                updatePresence(true, null);
                refreshUserUI();
                renderPlayHistory();
                if (state.user?.banned?.active) showBannedModal(state.user.banned.reason || 'Your account is banned');
            } else {
                refreshUserUI();
            }
            applyRouteFromLocation({ initial: true });
        } catch (err) {
            showToast(err.message || 'Failed to load data', true);
            showOfflineOverlay('bbgamez is currently offline or blocked by your network.');
        } finally {
            startOnlineHeartbeat();
            startHealthPolling();
        }
    }

    function startFriendsPolling() {
        if (runtime.friendsPoll) clearInterval(runtime.friendsPoll);
        if (!state.user) return;
        runtime.friendsPoll = setInterval(() => {
            loadFriends();
        }, 20000);
    }

    function startOnlineHeartbeat() {
        if (runtime.onlinePing) clearInterval(runtime.onlinePing);
        sendOnlinePing();
        runtime.onlinePing = setInterval(() => {
            sendOnlinePing();
        }, ONLINE_PING_INTERVAL);
    }

    function startHealthPolling() {
        if (runtime.healthPoll) clearInterval(runtime.healthPoll);
        updateHealth();
        runtime.healthPoll = setInterval(() => {
            updateHealth();
        }, 5000);
    }

    function sendOnlinePing(gameIdOverride) {
        syncPlaySession();
        const payload = { online: true };
        if (gameIdOverride !== undefined) {
            payload.gameId = gameIdOverride;
        } else if (state.currentGame) {
            payload.gameId = state.currentGame.id;
        }
        return api.post('/api/online/ping', payload)
            .then((res) => {
                if (Array.isArray(res?.lastPlayed)) updateLastPlayedState(res.lastPlayed);
                if (res?.playtime) setPlaytimeMap(res.playtime);
                return res;
            })
            .catch(() => {});
    }

    function updatePresence(online = true, gameId = null) {
        if (!online) return api.post('/api/online/ping', { online: false, gameId: null }).catch(() => {});
        return sendOnlinePing(gameId);
    }

    function startPlaySession(gameId) {
        if (!state.user || !gameId) { runtime.playSession = null; return; }
        runtime.playSession = { gameId: String(gameId), lastMark: Date.now() };
    }

    function syncPlaySession(force = false) {
        const session = runtime.playSession;
        if (!state.user || !session) return;
        const now = Date.now();
        const delta = Math.max(0, now - session.lastMark);
        if (!force && delta < 1000) return;
        session.lastMark = now;
        sendPlaytimeDelta(session.gameId, delta);
    }

    function finalizePlaySession(force = false) {
        const session = runtime.playSession;
        if (!session) return;
        const now = Date.now();
        const delta = Math.max(0, now - session.lastMark);
        runtime.playSession = null;
        if (!state.user) return;
        if (!force && delta < 500) return;
        sendPlaytimeDelta(session.gameId, delta);
    }

    function sendPlaytimeDelta(gameId, deltaMs) {
        const delta = Number(deltaMs);
        if (!state.user || !gameId || !Number.isFinite(delta) || delta <= 0) return;
        addLocalPlaytime(gameId, delta);
        renderPlayHistory();
        api.post('/api/playtime', { gameId: String(gameId), deltaMs: delta })
            .then((res) => {
                if (res?.playtime) setPlaytimeMap(res.playtime);
                if (Array.isArray(res?.lastPlayed)) updateLastPlayedState(res.lastPlayed);
            })
            .catch(() => {});
    }

    function updateStats(stats) {
        if (!stats) return;
        if (els.statsGames) els.statsGames.textContent = stats.totalGames ?? stats.games ?? '—';
        if (els.statsCategories) els.statsCategories.textContent = stats.categoryCount ?? '—';
    }

    async function loadSettingsIfNeeded() {
        if (!state.user) return;
            const hasPresets = Array.isArray(state.settingPresets?.panicButtons) && state.settingPresets.panicButtons.length;
            if (state.settings && hasPresets) { applySettingsToUI(state.settings); return; }
        try {
            const data = await api.get('/api/settings');
            state.settings = data.settings;
            state.settingPresets = data.presets || state.settingPresets;
            applySettingsToUI(data.settings);
        } catch (_) {}
    }

    function getCategories(games = []) {
        const cats = new Set(['all']);
        if (!Array.isArray(games)) return Array.from(cats);
        games.forEach((g) => { if (g && g.category) cats.add(g.category); });
        return Array.from(cats);
    }

    function buildCategories(games = []) {
        return getCategories(games);
    }

    function buildCategoryTabs() {
        if (!els.categoryTabs) return;
        els.categoryTabs.innerHTML = '';
        state.categories.forEach((cat, idx) => {
            const btn = document.createElement('button');
            btn.className = `cat-tab${idx === 0 ? ' active' : ''}`;
            btn.textContent = cat === 'all' ? 'All' : capitalize(cat);
            btn.dataset.category = cat;
            btn.addEventListener('click', () => {
                els.categoryTabs.querySelectorAll('.cat-tab').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                filterAndRender();
            });
            els.categoryTabs.appendChild(btn);
        });
    }

    function filterAndRender() {
        const query = (els.searchInput?.value || '').toLowerCase();
        const activeBtn = els.categoryTabs?.querySelector('.cat-tab.active');
        const activeCat = activeBtn ? activeBtn.dataset.category : 'all';
        state.filtered = state.games.filter((g) => {
            const matchesQuery = !query || g.title.toLowerCase().includes(query) || (g.description || '').toLowerCase().includes(query);
            const matchesCat = activeCat === 'all' || (g.category || '').toLowerCase() === activeCat.toLowerCase();
            return matchesQuery && matchesCat;
        });
        renderGames();
    }

    function renderGames() {
        if (!els.allGames) return;
        els.allGames.innerHTML = '';
        const frag = document.createDocumentFragment();
        state.filtered.forEach((game, idx) => frag.appendChild(buildGameCard(game, idx)));
        els.allGames.appendChild(frag);
    }

    const placeholderThumb = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270" fill="none"><rect width="480" height="270" fill="%23161b22"/><path d="M70 190h340M70 150h200M70 110h140" stroke="%2330363d" stroke-width="14" stroke-linecap="round"/><circle cx="380" cy="110" r="38" stroke="%2358a6ff" stroke-width="12"/></svg>';

    function resolveAssetUrl(url) {
        if (!url) return '';
        if (url.startsWith('data:')) return url;
        try {
            const parsed = new URL(url);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
        } catch (_) {
            /* fall through to relative handling */
        }
        const base = backendUrl || window.JETTIC_BACKEND_URL || '';
        const cleaned = String(url).replace(/^\/+/, '');
        if (base) return `${base}/${cleaned}`;
        return `/${cleaned}`;
    }

    function buildGameCard(game, idx = 0) {
        const thumb = resolveAssetUrl(game.thumbnail) || placeholderThumb;
        const card = document.createElement('div');
        card.className = 'game-card';
        card.dataset.id = game.id;
        card.style.animationDelay = `${Math.min(idx, 60) * 60}ms`;
        card.innerHTML = `
            <div class="card-friend-avatars"></div>
            <div class="game-thumb">
                <img src="${thumb}" alt="${game.title}" loading="lazy" />
                <div class="game-card-overlay"></div>
                ${game.disabled ? '<div class="game-badge danger">Maintenance</div>' : ''}
            </div>
            <div class="game-card-content">
                <div class="game-card-title">${game.title}</div>
                <div class="game-card-category">${capitalize(game.category || 'Other')}</div>
            </div>
            <div class="game-card-actions">
                <button class="icon-btn small fav-toggle" aria-label="Favorite" data-id="${game.id}"><i class="fas fa-heart"></i></button>
            </div>`;

        const img = card.querySelector('img');
        img.addEventListener('error', () => { img.src = placeholderThumb; });

        card.addEventListener('click', (e) => {
            if (e.target.closest('.fav-toggle')) return;
            openGame(game.id);
        });
        card.querySelector('.fav-toggle').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFavorite(game.id);
        });
        updateFavButton(card.querySelector('.fav-toggle'), game.id);
        renderCardFriends(card, game.id);
        return card;
    }

    function refreshGameCardFriends() {
        if (!els.allGames) return;
        els.allGames.querySelectorAll('.game-card').forEach((card) => {
            const gameId = card.dataset.id;
            renderCardFriends(card, gameId);
        });
    }

    function renderCardFriends(card, gameId) {
        const wrap = card.querySelector('.card-friend-avatars');
        if (!wrap) return;
        wrap.innerHTML = '';
        const friends = runtime.friendsPlayingMap.get(String(gameId)) || [];
        if (!friends.length) { wrap.style.display = 'none'; return; }
        wrap.style.display = 'flex';
        const maxShow = 3;
        friends.slice(0, maxShow).forEach((f) => {
            const pill = document.createElement('div');
            pill.className = 'card-avatar-pill';
            if (f.avatar) pill.style.backgroundImage = `url(${f.avatar})`; else pill.textContent = (f.username || '?')[0].toUpperCase();
            wrap.appendChild(pill);
        });
        if (friends.length > maxShow) {
            const more = document.createElement('div');
            more.className = 'card-avatar-pill more';
            more.textContent = `+${friends.length - maxShow}`;
            wrap.appendChild(more);
        }
    }

    function renderFavoritesPage() {
        if (!els.favoritesGrid) return;
        const isAuthed = !!state.user;
        const favGames = isAuthed ? state.games.filter((g) => state.favorites.has(String(g.id))) : [];

        els.favoritesGrid.innerHTML = '';

        if (els.favoritesLoginBox) els.favoritesLoginBox.style.display = isAuthed ? 'none' : 'block';
        if (!isAuthed) {
            if (els.favoritesAuthHint) els.favoritesAuthHint.style.display = 'none';
            if (els.favoritesGrid) els.favoritesGrid.style.display = 'none';
            if (els.favoritesEmpty) els.favoritesEmpty.style.display = 'none';
            return;
        }

        if (els.favoritesAuthHint) els.favoritesAuthHint.style.display = 'none';
        if (els.favoritesGrid) els.favoritesGrid.style.display = 'grid';

        if (!favGames.length) {
            if (els.favoritesEmpty) els.favoritesEmpty.style.display = 'block';
            return;
        }
        if (els.favoritesEmpty) els.favoritesEmpty.style.display = 'none';

        const frag = document.createDocumentFragment();
        favGames.forEach((g, idx) => frag.appendChild(buildGameCard(g, idx)));
        els.favoritesGrid.appendChild(frag);
    }

    function renderGameFriends(gameId) {
        const wrap = els.gameFriendAvatars;
        if (!wrap) return;
        wrap.innerHTML = '';
        const friends = runtime.friendsPlayingMap.get(String(gameId)) || [];
        if (!friends.length) { wrap.style.display = 'none'; return; }
        wrap.style.display = 'flex';
        const maxShow = 4;
        friends.slice(0, maxShow).forEach((f) => {
            const pill = document.createElement('div');
            pill.className = 'card-avatar-pill';
            if (f.avatar) pill.style.backgroundImage = `url(${f.avatar})`; else pill.textContent = (f.username || '?')[0].toUpperCase();
            wrap.appendChild(pill);
        });
        if (friends.length > maxShow) {
            const more = document.createElement('div');
            more.className = 'card-avatar-pill more';
            more.textContent = `+${friends.length - maxShow}`;
            wrap.appendChild(more);
        }
    }

    async function openGame(gameId, options = {}) {
        const game = state.games.find((g) => String(g.id) === String(gameId));
        if (!game) return false;
        const shouldUpdateUrl = !options.skipHistory && !runtime.handlingRoute;
        if (shouldUpdateUrl) updateGameRoute(game.id, { replace: !!options.replaceHistory });
        document.title = `${game.title} • bbgamez`;
        finalizePlaySession(true);
        cancelCloseTimer(true);
        state.currentGame = game;
        els.gameTitle.textContent = game.title;
        els.gameCategory.textContent = capitalize(game.category || 'Other');
        els.gameDescription.textContent = game.description || '';
        showPage('game', { skipHistory: true });
        updateGameFavoriteButton(game.id);
        state.proxyEnabled = state.settings?.proxyDefault || false;
        updateProxyUI();
        startPlaySession(game.id);
        updatePresence(true, game.id);
        renderGameFriends(game.id);
        updateLocalLastPlayed(game.id);
        loadGameFrame(game);
        return true;
    }

    function loadGameFrame(game) {
        if (!els.gameFrame) return;
        const disabled = !!game.disabled;
        if (els.gameDisabledNotice) els.gameDisabledNotice.style.display = disabled ? 'flex' : 'none';

        if (disabled) {
            els.gameFrame.src = 'about:blank';
            els.gameLoadingOverlay.style.display = 'none';
            return;
        }

        els.gameLoadingOverlay.style.display = 'flex';
        els.loadingStatusText.textContent = 'Loading game...';
        if (els.loadingHintText) els.loadingHintText.textContent = '';
        const src = state.proxyEnabled ? `${backendUrl}/proxy?url=${encodeURIComponent(game.embed)}` : game.embed;
        els.gameFrame.src = src;
        const onLoad = () => {
            els.gameLoadingOverlay.style.display = 'none';
            els.gameFrame.removeEventListener('load', onLoad);
            focusGameFrame();
        };
        els.gameFrame.addEventListener('load', onLoad);
        focusGameFrame();
    }

    function focusGameFrame() {
        const frame = els.gameFrame;
        if (!frame) return;
        try { frame.contentWindow?.focus?.(); } catch (_) {}
        frame.focus?.();
    }

    function openReportModal() {
        if (!els.reportModal) return;
        const game = state.currentGame;
        if (els.reportGameId) els.reportGameId.value = game ? game.id : '';
        if (els.reportGameTitle) els.reportGameTitle.value = game ? game.title : '';
        if (els.reportGameMeta) {
            els.reportGameMeta.textContent = game ? `Reporting ${game.title}` : 'No game selected';
        }
        if (els.reportSummary) els.reportSummary.value = '';
        if (els.reportCategory) els.reportCategory.value = 'bug';
        if (els.reportDescription) els.reportDescription.value = '';
        setReportFeedback('');
        setReportSubmitting(false);
        els.reportModal.style.display = 'flex';
        els.reportModal.setAttribute('aria-hidden', 'false');
        els.reportSummary?.focus();
    }

    function closeReportModal() {
        if (!els.reportModal) return;
        els.reportModal.style.display = 'none';
        els.reportModal.setAttribute('aria-hidden', 'true');
        setReportSubmitting(false);
    }

    function setReportFeedback(msg, isError = false) {
        if (!els.reportFeedback) return;
        els.reportFeedback.textContent = msg || '';
        els.reportFeedback.style.color = isError ? '#f85149' : '#58a6ff';
    }

    function setReportSubmitting(isLoading) {
        if (els.reportSubmitIndicator) els.reportSubmitIndicator.style.display = isLoading ? 'inline-block' : 'none';
        if (els.reportForm) els.reportForm.querySelectorAll('input, textarea, button, select').forEach((el) => { el.disabled = !!isLoading; });
    }

    async function handleReportSubmit(e) {
        e.preventDefault();
        if (!state.user) { openAuthModal('login'); return; }
        const summary = (els.reportSummary?.value || '').trim();
        const description = (els.reportDescription?.value || '').trim();
        const category = (els.reportCategory?.value || '').trim() || 'general';
        const gameId = (els.reportGameId?.value || state.currentGame?.id || '').toString().trim();
        const gameTitle = (els.reportGameTitle?.value || state.currentGame?.title || '').toString().trim();
        setReportFeedback('');
        setReportSubmitting(true);
        try {
            const payload = { summary, description, category };
            if (gameId) payload.gameId = gameId;
            if (gameTitle) payload.gameTitle = gameTitle;
            await api.post('/api/reports', payload);
            showToast('Report sent');
            closeReportModal();
        } catch (err) {
            setReportFeedback(err.message || 'Failed to send report', true);
        } finally {
            setReportSubmitting(false);
        }
    }

    function toggleFavorite(gameId) {
        if (!state.user) {
            pushNotification('Sign in required', 'Create an account to save favorites to your profile.', 'warning');
            return;
        }
        api.post('/api/favorites/toggle', { gameId: String(gameId) })
            .then(({ favorites }) => {
                state.favorites = new Set((favorites || []).map(String));
                renderFavoritesPage();
                renderGames();
                updateGameFavoriteButton(gameId);
                if (state.currentGame?.id === gameId) renderGameFriends(gameId);
            })
            .catch((err) => showToast(err.message || 'Failed to update favorites', true));
    }

    function updateGameFavoriteButton(gameId) {
        const isFav = state.favorites.has(String(gameId));
        els.gameFavBtn?.classList.toggle('active', isFav);
        els.gameFavBtn?.setAttribute('aria-pressed', isFav ? 'true' : 'false');
        renderGameFriends(gameId);
    }

    function updateFavButton(btn, gameId) {
        if (!btn) return;
        const isFav = state.favorites.has(String(gameId));
        btn.classList.toggle('active', isFav);
        btn.setAttribute('aria-pressed', isFav ? 'true' : 'false');
    }

    async function loadFriends() {
        if (!state.user) return;
        try {
            const data = await api.get('/api/friends');
            diffFriendsAndNotify(runtime.friendsSnapshot, data);
            runtime.friendsSnapshot = snapshotFriends(data);
            state.friends = data;
            runtime.friendsPlayingMap = buildFriendsPlayingMap(data);
            renderFriends();
        } catch (err) {
            if (err.status === 401 || err.status === 404) {
                // Session likely expired—stop polling and show the auth prompt without spamming toasts.
                if (runtime.friendsPoll) {
                    clearInterval(runtime.friendsPoll);
                    runtime.friendsPoll = null;
                }
                runtime.friendsSnapshot = null;
                runtime.friendsPlayingMap = new Map();
                state.friends = { friends: [], incomingRequests: [], outgoingRequests: [], blocked: [] };
                renderFriends();
                if (els.friendsContent) els.friendsContent.style.display = 'none';
                if (els.friendsAuthNotice) els.friendsAuthNotice.style.display = 'block';
                if (els.friendsAuthNoticeBox) els.friendsAuthNoticeBox.style.display = 'block';
                return;
            }
            showToast(err.message || 'Friends unavailable', true);
            if (els.friendsContent) els.friendsContent.style.display = 'none';
            if (els.friendsAuthNotice) els.friendsAuthNotice.style.display = state.user ? 'none' : 'block';
            if (els.friendsAuthNoticeBox) els.friendsAuthNoticeBox.style.display = state.user ? 'none' : 'block';
        }
    }

    async function loadAdminRequests(force = false) {
        if (!state.user?.admin) return;
        if (!force && state.adminRequests?.length) { renderAdminRequests(); return; }
        if (els.adminRequestsError) els.adminRequestsError.textContent = '';
        try {
            const { requests = [] } = await api.get('/api/requests');
            state.adminRequests = requests;
            renderAdminRequests();
        } catch (err) {
            if (els.adminRequestsError) els.adminRequestsError.textContent = err.message || 'Failed to load requests';
        }
    }

    async function loadAdminReports(force = false) {
        if (!state.user?.admin) return;
        if (!force && state.adminReports?.length) { renderAdminReports(); return; }
        if (els.adminReportsError) els.adminReportsError.textContent = '';
        try {
            const { reports = [] } = await api.get('/api/admin/reports');
            state.adminReports = reports;
            renderAdminReports();
        } catch (err) {
            if (els.adminReportsError) els.adminReportsError.textContent = err.message || 'Failed to load reports';
        }
    }

    async function loadAdminGames(force = false) {
        if (!state.user?.admin) return;
        if (!force && state.adminGames?.length) { renderAdminGames(); return; }
        try {
            const { games = [] } = await api.get('/api/admin/games');
            state.adminGames = games;
            renderAdminGames();
        } catch (err) {
            setAdminGameFeedback(err.message || 'Failed to load games', true);
        }
    }

    async function loadAdminUsers(force = false) {
        if (!state.user?.admin) return;
        if (!force && state.adminUsers?.length) { renderAdminUsers(); return; }
        try {
            const { users = [] } = await api.get('/api/admin/users');
            state.adminUsers = users;
            renderAdminUsers();
        } catch (err) {
            setAdminUserFeedback(err.message || 'Failed to load users', true);
        }
    }

    async function loadAdminAnalytics(force = false) {
        if (!state.user?.admin) return;
        const limit = 288;
        if (state.adminAnalytics && !force) { renderAdminAnalytics(); return; }
        setAnalyticsPlaceholders('Loading analytics...');
        try {
            const data = await api.get(`/api/admin/analytics?limit=${limit}&t=${Date.now()}`);
            state.adminAnalyticsRetention = data.retentionMinutes || null;
            state.adminAnalytics = data;
            renderAdminAnalytics();
        } catch (err) {
            setAnalyticsPlaceholders(err.message || 'Failed to load analytics');
        }
    }

    function setAnalyticsPlaceholders(text = 'Data unavailable') {
        [
            els.analyticsPlayerCounts,
            els.analyticsAccountsTotal,
            els.analyticsSystemStatus,
            els.analyticsGameTable
        ].forEach((el) => { if (el) el.textContent = text; });
    }

    function openAnalyticsModal(type) {
        return;
    }

    function closeAnalyticsModal() {
        if (!els.analyticsModal) return;
        els.analyticsModal.classList.remove('open');
        els.analyticsModal.setAttribute('aria-hidden', 'true');
        els.analyticsModal.style.display = 'none';
    }

    function renderAdminAnalytics() {
        const data = state.adminAnalytics || {};
        if (!data.enabled) {
            setAnalyticsPlaceholders('Analytics disabled in config');
            return;
        }

        const summary = data.summary || {};
        const latestPlayers = Array.isArray(data.players) && data.players.length ? data.players[data.players.length - 1] : null;
        const onlinePlayers = Number(summary.onlinePlayers ?? latestPlayers?.players) || 0;
        const onlineUsers = Number(latestPlayers?.onlineUsers) || 0;
        const onlineGuests = Number(latestPlayers?.onlineGuests) || 0;
        const totalAccounts = Number(summary.totalAccounts) || 0;
        const status = summary.systemStatus || 'Operational';

        if (els.analyticsPlayerCounts) {
            els.analyticsPlayerCounts.innerHTML = `
                <div class="analytics-chart-text">
                    <div>${onlinePlayers} online now</div>
                    <div class="analytics-subtext">Users ${onlineUsers} • Guests ${onlineGuests}</div>
                </div>
            `;
        }
        if (els.analyticsAccountsTotal) {
            els.analyticsAccountsTotal.innerHTML = `
                <div class="analytics-chart-text">
                    <div>${totalAccounts} total accounts</div>
                    <div class="analytics-subtext">Current registered users</div>
                </div>
            `;
        }
        if (els.analyticsSystemStatus) {
            els.analyticsSystemStatus.innerHTML = `
                <div class="analytics-chart-text">
                    <div>${escapeHtml(status)}</div>
                    <div class="analytics-subtext">Based on server maintenance mode</div>
                </div>
            `;
        }

        if (els.analyticsGameTable) {
            const latestSnapshot = Array.isArray(data.games) && data.games.length ? data.games[data.games.length - 1] : null;
            if (!latestSnapshot?.games?.length) {
                els.analyticsGameTable.textContent = 'No game metrics captured yet.';
            } else {
                const term = (state.adminAnalyticsSearch || '').toLowerCase();
                const games = latestSnapshot.games.filter((g) => !term || (g.title || '').toLowerCase().includes(term));
                if (!games.length) {
                    els.analyticsGameTable.textContent = 'No games match this search.';
                    return;
                }
                const cards = games
                    .slice()
                    .sort((a, b) => (Number(b.players) || 0) - (Number(a.players) || 0) || (Number(b.favorites) || 0) - (Number(a.favorites) || 0))
                    .map((g) => `
                        <div class="analytics-game-card${g.disabled ? ' disabled' : ''}">
                            <div class="analytics-game-thumb" ${g.thumbnail ? `style="background-image:url('${escapeAttr(resolveAssetUrl(g.thumbnail))}');"` : ''}></div>
                            <div class="analytics-game-meta">
                                <div class="analytics-game-title">${escapeHtml(g.title || `Game ${g.id}`)}</div>
                                <div class="analytics-game-stats"><span>Players ${g.players || 0}</span><span>Favs ${g.favorites || 0}</span></div>
                            </div>
                        </div>
                    `).join('');
                const updated = latestSnapshot.time ? new Date(latestSnapshot.time).toLocaleString() : 'recently';
                els.analyticsGameTable.innerHTML = `
                    <div class="analytics-game-grid">${cards}</div>
                    <div class="muted-hint" style="text-align:left;">Snapshot updated ${updated}</div>
                `;
            }
        }
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function escapeAttr(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function upsertAdminGame(game) {
        const idx = state.adminGames.findIndex((g) => String(g.id) === String(game.id));
        if (idx === -1) state.adminGames.push(game); else state.adminGames[idx] = game;
        state.games = state.games.map((g) => String(g.id) === String(game.id) ? game : g);
        filterAndRender();
        if (state.currentGame && String(state.currentGame.id) === String(game.id)) {
            state.currentGame = game;
            loadGameFrame(game);
        }
    }

    function upsertAdminUser(user) {
        const idx = state.adminUsers.findIndex((u) => u.id === user.id);
        if (idx === -1) state.adminUsers.push(user); else state.adminUsers[idx] = user;
        if (state.user && state.user.id === user.id) {
            state.user = normalizeUser(user);
            refreshUserUI();
        }
    }

    async function updateRequestStatus(id, status) {
        if (!state.user?.admin) return;
        try {
            const { request } = await api.put(`/api/requests/${id}`, { status });
            state.adminRequests = state.adminRequests.map((r) => (r.id === id ? request : r));
            renderAdminRequests();
            showToast(`Marked ${request.title} as ${status}`);
        } catch (err) {
            showToast(err.message || 'Failed to update request', true);
        }
    }

    async function updateReportStatus(id, status) {
        if (!state.user?.admin) return;
        try {
            const { report } = await api.put(`/api/admin/reports/${id}/status`, { status });
            state.adminReports = state.adminReports.map((r) => (r.id === id ? report : r));
            renderAdminReports();
            showToast(`Report marked ${status}`);
        } catch (err) {
            showToast(err.message || 'Failed to update report', true);
        }
    }

    async function deleteReport(id) {
        if (!state.user?.admin) return;
        const res = await openActionModal({
            title: 'Delete report',
            message: 'Delete this report? This cannot be undone.',
            confirmText: 'Delete',
            cancelText: 'Cancel',
            tone: 'danger'
        });
        if (!res.confirmed) return;
        try {
            await api.request(`/api/admin/reports/${id}`, { method: 'DELETE' });
            state.adminReports = state.adminReports.filter((r) => r.id !== id);
            renderAdminReports();
            showToast('Report deleted');
        } catch (err) {
            showToast(err.message || 'Failed to delete report', true);
        }
    }

    async function deleteRequest(id) {
        if (!state.user?.admin) return;
        try {
            await api.request(`/api/requests/${id}`, { method: 'DELETE' });
            state.adminRequests = state.adminRequests.filter((r) => r.id !== id);
            renderAdminRequests();
            showToast('Request deleted');
        } catch (err) {
            showToast(err.message || 'Failed to delete request', true);
        }
    }

    function openAdminGameModalFromRequest(req) {
        if (!req) return;
        resetAdminGameForm();
        runtime.adminGameRequestId = req.id;
        if (els.adminGameTitle) els.adminGameTitle.value = req.title || '';
        if (els.adminGameCategory) els.adminGameCategory.value = req.category || '';
        if (els.adminGameEmbed) els.adminGameEmbed.value = req.url || '';
        if (els.adminGameDescription) els.adminGameDescription.value = req.description || '';
        if (els.adminGameThumb) els.adminGameThumb.value = '';
        if (els.adminGameThumbUpload) els.adminGameThumbUpload.value = '';
        runtime.adminGameThumbData = null;
        if (els.adminGameModal) els.adminGameModal.style.display = 'flex';
        els.adminGameTitle?.focus();
        setAdminGameFeedback('Review details, add thumbnail, then save to convert.', false);
    }

    function snapshotFriends(data = {}) {
        const norm = (arr = []) => arr.map((u) => u.username).filter(Boolean);
        const presence = {};
        (data.friends || []).forEach((u) => {
            presence[u.username] = {
                online: !!u.presence?.online,
                gameId: u.presence?.gameId || null
            };
        });
        return {
            friends: norm(data.friends),
            incoming: norm(data.incomingRequests),
            outgoing: norm(data.outgoingRequests),
            presence
        };
    }

    function diffFriendsAndNotify(prev, next) {
        if (!prev) return;
        const incomingNew = (next.incomingRequests || []).filter((u) => !prev.incoming?.includes(u.username));
        incomingNew.forEach((u) => pushNotification('Friend request', `${u.username} sent you a friend request`, 'info'));

        const accepted = (next.friends || []).filter((u) => prev.outgoing?.includes(u.username));
        accepted.forEach((u) => pushNotification('Request accepted', `${u.username} accepted your friend request`, 'success'));

        const prevPresence = prev.presence || {};
        const nextPresence = {};
        (next.friends || []).forEach((u) => { nextPresence[u.username] = u.presence || {}; });
        Object.entries(nextPresence).forEach(([name, pres]) => {
            const prevP = prevPresence[name] || {};
            if (prevP.online !== pres.online) {
                pushNotification('Presence', `${name} is now ${pres.online ? 'online' : 'offline'}`, pres.online ? 'success' : 'warning');
            }
            if (pres.online && pres.gameId && pres.gameId !== prevP.gameId) {
                const title = getGameTitleById(pres.gameId) || 'a game';
                pushNotification('Now playing', `${name} started playing ${title}`, 'info');
            }
        });
    }

    function buildFriendsPlayingMap(data) {
        const map = new Map();
        (data?.friends || []).forEach((f) => {
            const gid = f.presence?.gameId;
            if (!f.presence?.online || !gid) return;
            const key = String(gid);
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(f);
        });
        return map;
    }

    function renderFriends() {
        if (!state.user) {
            els.friendsAuthNotice.style.display = 'block';
            els.friendsContent.style.display = 'none';
            if (els.friendsTabNav) els.friendsTabNav.style.display = 'none';
            return;
        }

        const { friends = [], incomingRequests = [], outgoingRequests = [], blocked = [] } = state.friends || {};

        els.friendsAuthNotice.style.display = 'none';
        els.friendsContent.style.display = 'grid';
        if (els.friendsTabNav) els.friendsTabNav.style.display = 'flex';
        if (els.addFriendModal) els.addFriendModal.style.display = 'none';

        renderUserList(els.friendsList, friends, { statusText: 'Friend', emptyText: 'No friends yet.' });

        renderUserList(els.manageFriendsList, friends, {
            statusText: 'Friend',
            emptyText: 'No friends to manage.',
            actions: [
                { label: 'Remove', icon: 'fa-xmark', action: (user) => removeFriend(user.username), success: (user) => `Removed ${user.username}` },
                { label: 'Block', icon: 'fa-ban', action: (user) => blockUser(user.username), tone: 'danger', success: (user) => `Blocked ${user.username}` }
            ]
        });
        renderUserList(els.manageIncomingList, incomingRequests, {
            statusText: 'Incoming request',
            emptyText: 'No incoming requests.',
            actions: [
                { label: 'Accept', icon: 'fa-check', tone: 'positive', action: (user) => respondToRequest(user.username, 'accept'), success: (user) => `Accepted ${user.username}` },
                { label: 'Decline', icon: 'fa-xmark', tone: 'danger', action: (user) => respondToRequest(user.username, 'decline'), success: (user) => `Declined ${user.username}` },
                { label: 'Block', icon: 'fa-ban', tone: 'danger', action: (user) => blockUser(user.username), success: (user) => `Blocked ${user.username}` }
            ]
        });
        renderUserList(els.manageOutgoingList, outgoingRequests, {
            statusText: 'Awaiting approval',
            emptyText: 'No outgoing requests.',
            actions: [
                { label: 'Cancel', icon: 'fa-xmark', tone: 'danger', action: (user) => cancelRequest(user.username), success: (user) => `Canceled request to ${user.username}` }
            ]
        });
        renderUserList(els.blockedList, blocked, {
            statusText: 'Blocked',
            emptyText: 'No blocked users.',
            actions: [
                { label: 'Unblock', icon: 'fa-unlock', action: (user) => unblockUser(user.username), success: (user) => `Unblocked ${user.username}` }
            ]
        });

        els.friendsCount.textContent = friends.length;
        els.pendingCount.textContent = incomingRequests.length;

        // update overlays for current game
        if (state.currentGame) renderGameFriends(state.currentGame.id);
        refreshGameCardFriends();
        renderOnlineFriends();
    }

    function renderAdminRequests() {
        if (!els.adminRequestsList) return;
        const list = Array.isArray(state.adminRequests) ? state.adminRequests.slice() : [];
        const query = (state.adminSearchQueries?.requests || '').trim().toLowerCase();
        const filtered = (query
            ? list.filter((req) => (req.title || '').toLowerCase().includes(query) || (req.username || '').toLowerCase().includes(query) || (req.description || '').toLowerCase().includes(query))
            : list).sort((a, b) => {
            if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
            return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
        });

        els.adminRequestsList.innerHTML = '';
        if (!filtered.length) {
            if (els.adminRequestsEmpty) els.adminRequestsEmpty.style.display = 'block';
            return;
        }
        if (els.adminRequestsEmpty) els.adminRequestsEmpty.style.display = 'none';

        const frag = document.createDocumentFragment();
        filtered.forEach((req) => {
            const li = document.createElement('li');
            li.className = 'friend-row';

            const meta = document.createElement('div');
            meta.className = 'friend-meta';
            const name = document.createElement('div');
            name.className = 'friend-name';
            name.textContent = req.title;
            const status = document.createElement('div');
            status.className = 'friend-status';
            status.textContent = `${req.username || 'Unknown'} • ${req.status}`;
            meta.append(name, status);

            const desc = document.createElement('div');
            desc.className = 'muted-hint';
            desc.textContent = req.description || '';

            const actionsWrap = document.createElement('div');
            actionsWrap.className = 'friend-actions';
            actionsWrap.style.display = 'flex';
            actionsWrap.style.gap = '8px';

            const makeBtn = (label, icon, statusValue, tone) => {
                const btn = document.createElement('button');
                btn.className = 'friend-action-btn';
                if (tone === 'danger') btn.classList.add('danger');
                if (tone === 'positive') btn.classList.add('positive');
                btn.innerHTML = `<i class="fas ${icon}"></i>`;
                btn.title = label;
                btn.addEventListener('click', () => updateRequestStatus(req.id, statusValue));
                return btn;
            };

            if (req.status !== 'approved') actionsWrap.appendChild(makeBtn('Approve', 'fa-check', 'approved', 'positive'));
            if (req.status !== 'rejected') actionsWrap.appendChild(makeBtn('Reject', 'fa-xmark', 'rejected', 'danger'));
            if (req.status !== 'pending') actionsWrap.appendChild(makeBtn('Mark pending', 'fa-undo', 'pending'));

            const convertBtn = document.createElement('button');
            convertBtn.className = 'friend-action-btn positive';
            convertBtn.innerHTML = '<i class="fas fa-gamepad"></i>';
            convertBtn.title = 'Convert to game';
            convertBtn.addEventListener('click', () => openAdminGameModalFromRequest(req));
            actionsWrap.appendChild(convertBtn);

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'friend-action-btn danger';
            deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
            deleteBtn.title = 'Delete request';
            deleteBtn.addEventListener('click', () => deleteRequest(req.id));
            actionsWrap.appendChild(deleteBtn);

            if (req.url) {
                const link = document.createElement('a');
                link.href = req.url;
                link.textContent = 'Open URL';
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.style.marginLeft = '12px';
                link.className = 'muted-hint';
                li.append(meta, desc, link);
            } else {
                li.append(meta, desc);
            }
            if (actionsWrap.childElementCount) li.appendChild(actionsWrap);
            frag.appendChild(li);
        });
        els.adminRequestsList.appendChild(frag);
    }

    function renderAdminReports() {
        if (!els.adminReportsList) return;
        const list = Array.isArray(state.adminReports) ? state.adminReports.slice() : [];
        const query = (state.adminSearchQueries?.reports || '').trim().toLowerCase();
        const filtered = (query
            ? list.filter((rep) =>
                (rep.summary || '').toLowerCase().includes(query) ||
                (rep.description || '').toLowerCase().includes(query) ||
                (rep.username || '').toLowerCase().includes(query) ||
                (rep.category || '').toLowerCase().includes(query) ||
                (rep.gameTitle || '').toLowerCase().includes(query)
            )
            : list)
            .sort((a, b) => {
                if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
                return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
            });

        els.adminReportsList.innerHTML = '';
        if (!filtered.length) {
            if (els.adminReportsEmpty) els.adminReportsEmpty.style.display = 'block';
            return;
        }
        if (els.adminReportsEmpty) els.adminReportsEmpty.style.display = 'none';

        const frag = document.createDocumentFragment();
        filtered.forEach((rep) => {
            const li = document.createElement('li');
            li.className = 'friend-row';

            const meta = document.createElement('div');
            meta.className = 'friend-meta';
            const name = document.createElement('div');
            name.className = 'friend-name';
            name.textContent = rep.summary || 'Report';
            const status = document.createElement('div');
            status.className = 'friend-status';
            const statusLabel = rep.status || 'open';
            const metaParts = [rep.username || 'Unknown user', statusLabel];
            if (rep.category) metaParts.push(rep.category);
            status.textContent = metaParts.join(' • ');
            meta.append(name, status);

            const desc = document.createElement('div');
            desc.className = 'muted-hint';
            desc.textContent = rep.description || '';

            const info = document.createElement('div');
            info.className = 'report-meta-line';
            const created = rep.updatedAt || rep.createdAt;
            const gameText = rep.gameTitle ? `Game: ${rep.gameTitle}` : null;
            const pieces = [];
            if (gameText) pieces.push(gameText);
            if (rep.category) pieces.push(`Category: ${rep.category}`);
            if (created) pieces.push(new Date(created).toLocaleString());
            info.textContent = pieces.join(' • ');

            const actionsWrap = document.createElement('div');
            actionsWrap.className = 'friend-actions';
            actionsWrap.style.display = 'flex';
            actionsWrap.style.gap = '8px';

            const addStatusBtn = (label, icon, nextStatus, tone) => {
                const btn = document.createElement('button');
                btn.className = 'friend-action-btn';
                if (tone === 'danger') btn.classList.add('danger');
                if (tone === 'positive') btn.classList.add('positive');
                btn.innerHTML = `<i class="fas ${icon}"></i>`;
                btn.title = label;
                btn.addEventListener('click', () => updateReportStatus(rep.id, nextStatus));
                return btn;
            };

            if (rep.status !== 'open') actionsWrap.appendChild(addStatusBtn('Reopen', 'fa-rotate-left', 'open'));
            if (rep.status !== 'resolved') actionsWrap.appendChild(addStatusBtn('Mark resolved', 'fa-check', 'resolved', 'positive'));
            if (rep.status !== 'dismissed') actionsWrap.appendChild(addStatusBtn('Dismiss', 'fa-ban', 'dismissed', 'danger'));

            const delBtn = document.createElement('button');
            delBtn.className = 'friend-action-btn danger';
            delBtn.innerHTML = '<i class="fas fa-trash"></i>';
            delBtn.title = 'Delete report';
            delBtn.addEventListener('click', () => deleteReport(rep.id));
            actionsWrap.appendChild(delBtn);

            li.append(meta, desc, info, actionsWrap);
            frag.appendChild(li);
        });

        els.adminReportsList.appendChild(frag);
    }

    function renderAdminGames() {
        if (!els.adminGamesList) return;
        els.adminGamesList.innerHTML = '';
        const list = Array.isArray(state.adminGames) ? state.adminGames.slice() : [];
        const query = (state.adminSearchQueries?.games || '').trim().toLowerCase();
        const filtered = query
            ? list.filter((game) => (game.title || '').toLowerCase().includes(query) || (game.category || '').toLowerCase().includes(query))
            : list;
        filtered.sort((a, b) => String(a.title).localeCompare(String(b.title)));
        if (!filtered.length) {
            if (els.adminGamesEmpty) els.adminGamesEmpty.style.display = 'block';
            return;
        }
        if (els.adminGamesEmpty) els.adminGamesEmpty.style.display = 'none';

        const frag = document.createDocumentFragment();
        filtered.forEach((game) => {
            const li = document.createElement('li');
            li.className = 'friend-row';

            const meta = document.createElement('div');
            meta.className = 'friend-meta';
            const name = document.createElement('div');
            name.className = 'friend-name';
            name.textContent = game.title;
            const status = document.createElement('div');
            status.className = 'friend-status';
            const disabledText = game.disabled ? 'Maintenance' : 'Active';
            status.textContent = `${capitalize(game.category || 'Other')} • ${disabledText}`;
            meta.append(name, status);

            const actions = document.createElement('div');
            actions.className = 'friend-actions';
            actions.style.display = 'flex';
            actions.style.gap = '8px';

            const editBtn = document.createElement('button');
            editBtn.className = 'friend-action-btn positive';
            editBtn.innerHTML = '<i class="fas fa-pen"></i>';
            editBtn.title = 'Edit';
            editBtn.addEventListener('click', () => openAdminGameModal(game));

            const disableBtn = document.createElement('button');
            disableBtn.className = 'friend-action-btn';
            disableBtn.innerHTML = game.disabled ? '<i class="fas fa-power-off"></i>' : '<i class="fas fa-ban"></i>';
            disableBtn.title = game.disabled ? 'Enable' : 'Disable';
            disableBtn.addEventListener('click', () => {
                if (game.disabled) {
                    enableGame(game);
                } else {
                    openAdminMaintenanceConfirm(game);
                }
            });

            const delBtn = document.createElement('button');
            delBtn.className = 'friend-action-btn danger';
            delBtn.innerHTML = '<i class="fas fa-trash"></i>';
            delBtn.title = 'Delete';
            delBtn.addEventListener('click', () => deleteGame(game));

            actions.append(editBtn, disableBtn, delBtn);

            li.append(meta, actions);
            frag.appendChild(li);
        });
        els.adminGamesList.appendChild(frag);
    }

    function renderAdminUsers() {
        if (!els.adminUsersList) return;
        els.adminUsersList.innerHTML = '';
        const list = Array.isArray(state.adminUsers) ? state.adminUsers.slice() : [];
        const query = (state.adminSearchQueries?.users || '').trim().toLowerCase();
        const filtered = query
            ? list.filter((u) => (u.username || '').toLowerCase().includes(query) || (u.email || '').toLowerCase().includes(query))
            : list;
        filtered.sort((a, b) => a.username.localeCompare(b.username));
        if (!filtered.length) {
            if (els.adminUsersEmpty) els.adminUsersEmpty.style.display = 'block';
            return;
        }
        if (els.adminUsersEmpty) els.adminUsersEmpty.style.display = 'none';

        const frag = document.createDocumentFragment();
        filtered.forEach((user) => {
            const li = document.createElement('li');
            li.className = 'friend-row';

            const avatar = document.createElement('div');
            avatar.className = 'friend-avatar admin-user-avatar';
            if (user.profile?.avatar) {
                avatar.style.backgroundImage = `url(${user.profile.avatar})`;
            } else {
                avatar.style.background = '#58a6ff';
                avatar.textContent = (user.username || '?')[0].toUpperCase();
            }

            const meta = document.createElement('div');
            meta.className = 'friend-meta';
            const name = document.createElement('div');
            name.className = 'friend-name';
            const nameText = document.createElement('span');
            nameText.textContent = user.username;
            const online = document.createElement('span');
            online.className = `admin-user-online ${user.online ? '' : 'admin-user-offline'}`;
            online.innerHTML = `<span class="dot"></span>${user.online ? 'Online' : 'Offline'}`;
            name.append(nameText, online);
            const status = document.createElement('div');
            status.className = 'friend-status';
            const statusParts = [user.admin ? 'Admin' : 'User'];
            if (user.banned?.active) statusParts.push('Banned');
            status.textContent = `${statusParts.join(' • ')} • ${user.email || 'No email'}`;

            meta.append(name, status);

            const actions = document.createElement('div');
            actions.className = 'friend-actions';
            actions.style.display = 'flex';
            actions.style.gap = '8px';

            const loginBadge = document.createElement('div');
            loginBadge.className = 'admin-user-logins';
            loginBadge.textContent = user.banned?.active ? (user.banned.reason || 'Banned') : getUserLoginPreview(user);
            loginBadge.addEventListener('click', () => loadUserLogins(user, loginBadge));
            actions.appendChild(loginBadge);
            refreshLoginPreview(user, loginBadge);

            const relationsBtn = document.createElement('button');
            relationsBtn.className = 'friend-action-btn';
            relationsBtn.innerHTML = '<i class="fas fa-users"></i>';
            relationsBtn.title = 'View relations';
            relationsBtn.addEventListener('click', () => openAdminRelationsModal(user));

            const adminBtn = document.createElement('button');
            adminBtn.className = 'friend-action-btn';
            adminBtn.innerHTML = user.admin ? '<i class="fas fa-shield"></i>' : '<i class="fas fa-user-shield"></i>';
            adminBtn.title = user.admin ? 'Remove admin' : 'Make admin';
            adminBtn.addEventListener('click', () => setUserAdmin(user, !user.admin));

            const renameBtn = document.createElement('button');
            renameBtn.className = 'friend-action-btn positive';
            renameBtn.innerHTML = '<i class="fas fa-pen"></i>';
            renameBtn.title = 'Rename';
            renameBtn.addEventListener('click', () => openAdminUserModal(user));

            const resetBtn = document.createElement('button');
            resetBtn.className = 'friend-action-btn';
            resetBtn.innerHTML = '<i class="fas fa-key"></i>';
            resetBtn.title = 'Reset password';
            resetBtn.addEventListener('click', () => resetUserPassword(user));

            const resetAvatarBtn = document.createElement('button');
            resetAvatarBtn.className = 'friend-action-btn';
            resetAvatarBtn.innerHTML = '<i class="fas fa-image"></i>';
            resetAvatarBtn.title = 'Reset profile image';
            resetAvatarBtn.addEventListener('click', () => resetUserAvatar(user));

            const banBtn = document.createElement('button');
            banBtn.className = 'friend-action-btn';
            banBtn.innerHTML = user.banned?.active ? '<i class="fas fa-unlock"></i>' : '<i class="fas fa-ban"></i>';
            banBtn.title = user.banned?.active ? 'Unban user' : 'Ban user';
            banBtn.addEventListener('click', () => toggleUserBan(user, !user.banned?.active));

            const delBtn = document.createElement('button');
            delBtn.className = 'friend-action-btn danger';
            delBtn.innerHTML = '<i class="fas fa-trash"></i>';
            delBtn.title = 'Delete';
            delBtn.addEventListener('click', () => deleteUser(user));

            actions.append(loginBadge, relationsBtn, adminBtn, renameBtn, resetBtn, resetAvatarBtn, banBtn, delBtn);

            li.append(avatar, meta, actions);
            frag.appendChild(li);
        });
        els.adminUsersList.appendChild(frag);
    }

    function renderRelationsGroup(title, list) {
        const wrapper = document.createElement('div');
        wrapper.className = 'relations-group';
        const heading = document.createElement('h4');
        heading.textContent = `${title} (${list.length})`;
        const chips = document.createElement('div');
        chips.className = 'relations-chips';
        if (!list.length) {
            const empty = document.createElement('span');
            empty.className = 'relations-chip';
            empty.textContent = 'None';
            chips.appendChild(empty);
        } else {
            list.forEach((u) => {
                const chip = document.createElement('span');
                chip.className = `relations-chip ${u.presence?.online ? 'online' : ''}`;
                chip.innerHTML = `<span class="status-dot"></span>${u.username || 'Unknown'}`;
                chips.appendChild(chip);
            });
        }
        wrapper.append(heading, chips);
        return wrapper;
    }

    async function openAdminRelationsModal(user) {
        if (!user?.id || !els.adminRelationsModal || !els.adminRelationsBody) return;
        els.adminRelationsTitle.textContent = `Relations for ${user.username || 'User'}`;
        els.adminRelationsBody.innerHTML = '<div class="muted-hint" style="text-align:left; padding:0;">Loading...</div>';
        els.adminRelationsModal.style.display = 'flex';
        try {
            const data = await api.get(`/api/admin/users/${user.id}/relations`);
            els.adminRelationsBody.innerHTML = '';
            const groups = [
                ['Friends', data.friends || []],
                ['Incoming Requests', data.incoming || []],
                ['Outgoing Requests', data.outgoing || []],
                ['Blocked', data.blocked || []]
            ];
            groups.forEach(([title, list]) => {
                els.adminRelationsBody.appendChild(renderRelationsGroup(title, list));
            });
        } catch (err) {
            els.adminRelationsBody.innerHTML = `<div class="muted-hint" style="text-align:left; padding:0; color:#f85149;">${escapeHtml(err.message || 'Failed to load relations')}</div>`;
        }
    }

    function closeAdminRelationsModal() {
        if (!els.adminRelationsModal) return;
        els.adminRelationsModal.style.display = 'none';
    }

    function switchAdminTab(tab) {
        if (!tab) return;
        state.adminTab = tab;
        els.adminTabNavButtons?.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
        const nextPanel = els.adminTabPanels?.find((p) => p.dataset.panel === tab);
        switchPanelWithTransition(els.adminTabPanels || [], nextPanel);
        const actionButtons = Array.from(els.adminTabActions?.querySelectorAll('[data-admin-tabs]') || []);
        actionButtons.forEach((btn) => {
            const allowedTabs = String(btn.dataset.adminTabs || '').split(',').map((v) => v.trim()).filter(Boolean);
            const visible = allowedTabs.includes(tab);
            btn.style.display = visible ? '' : 'none';
        });
        if (els.adminTabSearch) {
            const searchable = tab === 'requests' || tab === 'reports' || tab === 'games' || tab === 'users' || tab === 'analytics';
            const placeholders = {
                requests: 'Search requests...',
                reports: 'Search reports...',
                games: 'Search games...',
                users: 'Search users...',
                analytics: 'Search games...'
            };
            els.adminTabSearch.style.display = searchable ? '' : 'none';
            if (searchable) {
                els.adminTabSearch.placeholder = placeholders[tab] || 'Search...';
                els.adminTabSearch.value = tab === 'analytics'
                    ? (state.adminAnalyticsSearch || '')
                    : (state.adminSearchQueries?.[tab] || '');
            }
        }
        const adminTabTitles = {
            requests: 'Game Requests',
            reports: 'Reports',
            games: 'Games',
            users: 'Users',
            defaults: 'Default Settings & Presets',
            config: 'Backend Config File',
            analytics: 'Analytics'
        };
        if (els.adminSubpageTitle) {
            els.adminSubpageTitle.textContent = adminTabTitles[tab] || 'Requests';
        }
        if (tab === 'requests') loadAdminRequests(true);
        if (tab === 'reports') loadAdminReports(true);
        if (tab === 'games') loadAdminGames(true);
        if (tab === 'users') loadAdminUsers(true);
        if (tab === 'defaults') loadAdminDefaults(true);
        if (tab === 'config') {
            loadAdminConfigFiles().finally(() => loadAdminConfigFile(true));
        }
        if (tab === 'analytics') loadAdminAnalytics(true);
    }

    function resetAdminGameForm() {
        if (!els.adminGameForm) return;
        els.adminGameForm.reset();
        if (els.adminGameId) els.adminGameId.value = '';
        if (els.adminGameThumbUpload) els.adminGameThumbUpload.value = '';
        runtime.adminGameThumbData = null;
        runtime.adminGameRequestId = null;
        setAdminGameFeedback('', false);
    }

    function fillAdminGameForm(game) {
        if (!els.adminGameForm || !game) return;
        els.adminGameId.value = game.id;
        els.adminGameTitle.value = game.title || '';
        els.adminGameCategory.value = game.category || '';
        els.adminGameEmbed.value = game.embed || '';
        els.adminGameThumb.value = game.thumbnail || '';
        els.adminGameDescription.value = game.description || '';
    }

    function openAdminGameModal(game = null) {
        resetAdminGameForm();
        if (game) fillAdminGameForm(game);
        if (els.adminGameModal) els.adminGameModal.style.display = 'flex';
        els.adminGameTitle?.focus();
    }

    function closeAdminGameModal() {
        if (els.adminGameModal) els.adminGameModal.style.display = 'none';
        setAdminGameSaving(false);
        runtime.adminGameThumbData = null;
        runtime.adminGameRequestId = null;
    }

    function openAdminMaintenanceConfirm(game) {
        if (!game) return;
        state.adminMaintenanceTarget = game;
        if (els.adminMaintenanceConfirmText) {
            els.adminMaintenanceConfirmText.textContent = `Put "${game.title}" into maintenance mode?`;
        }
        if (els.adminMaintenanceConfirmModal) els.adminMaintenanceConfirmModal.style.display = 'flex';
    }

    function closeAdminMaintenanceConfirm() {
        state.adminMaintenanceTarget = null;
        if (els.adminMaintenanceConfirmModal) els.adminMaintenanceConfirmModal.style.display = 'none';
        setAdminMaintenanceSaving(false);
    }

    function resetAdminUserForm() {
        if (!els.adminUserForm) return;
        els.adminUserForm.reset();
        if (els.adminUserId) els.adminUserId.value = '';
        if (els.adminUserEmail) els.adminUserEmail.value = '';
        setAdminUserFeedback('', false);
    }

    function fillAdminUserForm(user) {
        if (!els.adminUserForm || !user) return;
        els.adminUserId.value = user.id;
        els.adminUserUsername.value = user.username || '';
        if (els.adminUserEmail) els.adminUserEmail.value = user.email || '';
        els.adminUserPassword.value = '';
    }

    function openAdminUserModal(user = null) {
        resetAdminUserForm();
        if (user) fillAdminUserForm(user);
        if (els.adminUserModal) els.adminUserModal.style.display = 'flex';
        (els.adminUserUsername || els.adminUserPassword)?.focus?.();
    }

    function closeAdminUserModal() {
        if (els.adminUserModal) els.adminUserModal.style.display = 'none';
        setAdminUserSaving(false);
    }

    function setAdminGameSaving(isSaving) {
        if (els.adminGameSaveIndicator) els.adminGameSaveIndicator.style.display = isSaving ? 'inline-block' : 'none';
        if (els.adminGameForm) els.adminGameForm.querySelectorAll('input, textarea, button').forEach((el) => { el.disabled = isSaving; });
    }

    function setAdminGameFeedback(msg, isError) {
        if (!els.adminGameFeedback) return;
        els.adminGameFeedback.textContent = msg;
        els.adminGameFeedback.style.color = isError ? '#f85149' : '#58a6ff';
    }

    function setAdminMaintenanceSaving(isSaving) {
        const toggle = (btn) => {
            if (!btn) return;
            if (isSaving) btn.setAttribute('disabled', 'true');
            else btn.removeAttribute('disabled');
        };
        toggle(els.adminMaintenanceConfirmBtn);
        toggle(els.adminMaintenanceCancelBtn);
    }

    async function handleConfirmDisable() {
        if (!state.user?.admin || !state.adminMaintenanceTarget) return;
        const game = state.adminMaintenanceTarget;
        setAdminMaintenanceSaving(true);
        try {
            const { game: updated } = await api.put(`/api/admin/games/${game.id}/disable`, { disabled: true, message: '' });
            upsertAdminGame(updated);
            renderAdminGames();
            showToast('Game disabled');
            closeAdminMaintenanceConfirm();
        } catch (err) {
            showToast(err.message || 'Failed to disable game', true);
            setAdminMaintenanceSaving(false);
        }
    }

    function setAdminUserSaving(isSaving) {
        if (els.adminUserSaveIndicator) els.adminUserSaveIndicator.style.display = isSaving ? 'inline-block' : 'none';
        if (els.adminUserForm) els.adminUserForm.querySelectorAll('input, button').forEach((el) => { el.disabled = isSaving; });
    }

    function setAdminUserFeedback(msg, isError) {
        if (!els.adminUserFeedback) return;
        els.adminUserFeedback.textContent = msg;
        els.adminUserFeedback.style.color = isError ? '#f85149' : '#58a6ff';
    }

    async function enableGame(game) {
        if (!game || !state.user?.admin) return;
        try {
            const { game: updated } = await api.put(`/api/admin/games/${game.id}/disable`, { disabled: false, message: '' });
            upsertAdminGame(updated);
            renderAdminGames();
            showToast('Game enabled');
        } catch (err) {
            showToast(err.message || 'Failed to enable game', true);
        }
    }

    async function deleteGame(game) {
        if (!game || !state.user?.admin) return;
        const res = await openActionModal({
            title: 'Delete game',
            message: `Delete "${game.title}"? This cannot be undone.`,
            confirmText: 'Delete',
            cancelText: 'Cancel',
            tone: 'danger'
        });
        if (!res.confirmed) return;
        try {
            await api.request(`/api/admin/games/${game.id}`, { method: 'DELETE' });
            state.adminGames = state.adminGames.filter((g) => String(g.id) !== String(game.id));
            state.games = state.games.filter((g) => String(g.id) !== String(game.id));
            renderAdminGames();
            filterAndRender();
            showToast('Game deleted');
        } catch (err) {
            showToast(err.message || 'Failed to delete game', true);
        }
    }

    async function setUserAdmin(user, isAdmin) {
        try {
            const { user: updated } = await api.put(`/api/admin/users/${user.id}`, { admin: isAdmin });
            upsertAdminUser(updated);
            renderAdminUsers();
            showToast(isAdmin ? 'Admin granted' : 'Admin removed');
        } catch (err) {
            showToast(err.message || 'Failed to update user', true);
        }
    }

    async function resetUserPassword(user) {
        const res = await openActionModal({
            title: 'Reset password',
            message: `Set a new password for ${user.username}.`,
            inputLabel: 'New password',
            inputPlaceholder: 'Minimum 6 characters',
            inputType: 'password',
            confirmText: 'Save password',
            cancelText: 'Cancel',
            tone: 'positive'
        });
        const next = res?.value?.trim();
        if (!res.confirmed || !next) return;
        try {
            const { user: updated } = await api.put(`/api/admin/users/${user.id}`, { password: next });
            upsertAdminUser(updated);
            renderAdminUsers();
            showToast('Password reset');
        } catch (err) {
            showToast(err.message || 'Failed to reset password', true);
        }
    }

    async function deleteUser(user) {
        if (user?.id && state.user?.id === user.id) {
            showToast('You cannot delete your own account here.', true);
            return;
        }
        const res = await openActionModal({
            title: 'Delete user',
            message: `Delete ${user.username}? This cannot be undone.`,
            confirmText: 'Delete',
            cancelText: 'Cancel',
            tone: 'danger'
        });
        if (!res.confirmed) return;
        try {
            await api.request(`/api/admin/users/${user.id}`, { method: 'DELETE' });
            state.adminUsers = state.adminUsers.filter((u) => u.id !== user.id);
            renderAdminUsers();
            showToast('User deleted');
        } catch (err) {
            showToast(err.message || 'Failed to delete user', true);
        }
    }

    async function resetUserAvatar(user) {
        if (!state.user?.admin || !user?.id) return;
        const res = await openActionModal({
            title: 'Reset profile image',
            message: `Remove ${user.username}'s profile image?`,
            confirmText: 'Reset image',
            cancelText: 'Cancel',
            tone: 'positive'
        });
        if (!res.confirmed) return;
        try {
            const { user: updated } = await api.put(`/api/admin/users/${user.id}`, { profile: { avatar: '' } });
            upsertAdminUser(updated);
            renderAdminUsers();
            showToast('Profile image reset');
        } catch (err) {
            showToast(err.message || 'Failed to reset avatar', true);
        }
    }

    async function toggleUserBan(user, active) {
        if (!state.user?.admin || !user) return;
        if (user.id === state.user?.id) {
            showToast('You cannot ban yourself.', true);
            return;
        }
        let reason = '';
        if (active) {
            const res = await openActionModal({
                title: 'Ban user',
                message: `Ban ${user.username}? They will lose access immediately.`,
                inputLabel: 'Reason (optional)',
                inputPlaceholder: 'Misuse, abuse, etc.',
                confirmText: 'Ban user',
                cancelText: 'Cancel',
                tone: 'danger'
            });
            if (!res.confirmed) return;
            reason = res.value || '';
        } else {
            const res = await openActionModal({
                title: 'Unban user',
                message: `Allow ${user.username} to sign in again?`,
                confirmText: 'Unban',
                cancelText: 'Cancel',
                tone: 'positive'
            });
            if (!res.confirmed) return;
        }
        try {
            const { user: updated } = await api.put(`/api/admin/users/${user.id}/ban`, { active, reason });
            upsertAdminUser(updated);
            renderAdminUsers();
            if (updated.id === state.user?.id) {
                if (updated.banned?.active) showBannedModal(updated.banned.reason || 'Your account is banned');
                else hideBannedModal();
            }
            showToast(active ? 'User banned' : 'User unbanned');
        } catch (err) {
            setAdminUserFeedback(err.message || 'Failed to update ban', true);
        }
    }

    async function fetchUserLoginHistory(userId) {
        if (!userId) return [];
        if (state.adminLoginCache?.[userId]) return state.adminLoginCache[userId];
        const { loginHistory = [] } = await api.get(`/api/admin/users/${userId}/logins`);
        state.adminLoginCache[userId] = loginHistory;
        return loginHistory;
    }

    function buildLoginPreview(history = []) {
        if (!history.length) return 'Last login: —';
        const first = history[0];
        const ip = first?.ip || 'Unknown IP';
        const ts = first?.lastAt ? new Date(first.lastAt).toLocaleString() : 'Unknown time';
        return `Last login from ${ip} • ${ts}`;
    }

    function getUserLoginPreview(user) {
        if (!user) return 'Last login: —';
        const cached = state.adminLoginCache?.[user.id];
        return buildLoginPreview(cached || []);
    }

    async function refreshLoginPreview(user, targetEl) {
        if (!user?.id || !targetEl) return;
        targetEl.textContent = 'Loading last login...';
        try {
            const history = await fetchUserLoginHistory(user.id);
            targetEl.textContent = buildLoginPreview(history);
        } catch (err) {
            targetEl.textContent = err.message || 'Failed to load logins';
        }
    }

    async function loadUserLogins(user, targetEl) {
        if (!state.user?.admin || !user?.id) return;
        if (targetEl) targetEl.textContent = 'Loading logins...';
        try {
            const history = await fetchUserLoginHistory(user.id);
            const preview = buildLoginPreview(history);
            if (targetEl) targetEl.textContent = preview;
            openLoginHistoryModal(`Login history • ${user.username}`);
            renderLoginHistoryList(history);
            renderAdminUsers();
        } catch (err) {
            if (targetEl) targetEl.textContent = err.message || 'Failed to load logins';
            else showToast(err.message || 'Failed to load logins', true);
        }
    }

    function renderUserList(container, list = [], options = {}) {
        if (!container) return;
        const { emptyText = 'Nothing here yet.', statusText = '', actions = [] } = options;
        container.innerHTML = '';
        if (!list.length) {
            container.innerHTML = `<li class="muted-hint">${emptyText}</li>`;
            return;
        }
        list.forEach((user) => {
            const li = document.createElement('li');
            li.className = 'friend-row';

            const avatar = document.createElement('div');
            avatar.className = 'friend-avatar';
            if (user.avatar) {
                avatar.style.backgroundImage = `url(${user.avatar})`;
            } else {
                avatar.style.background = '#58a6ff';
                avatar.textContent = (user.username || '?')[0].toUpperCase();
            }

            const meta = document.createElement('div');
            meta.className = 'friend-meta';
            const name = document.createElement('div');
            name.className = 'friend-name';
            name.textContent = user.username;
            const status = document.createElement('div');
            status.className = 'friend-status';
            status.textContent = buildFriendStatus(user, statusText);
            meta.append(name, status);

            const actionsWrap = document.createElement('div');
            actionsWrap.className = 'friend-actions';
            actionsWrap.style.display = 'flex';
            actionsWrap.style.gap = '8px';

            actions.forEach(({ label, action, tone, success, icon }) => {
                const btn = document.createElement('button');
                btn.className = 'friend-action-btn';
                btn.setAttribute('aria-label', label);
                if (tone === 'danger') btn.classList.add('danger');
                if (tone === 'positive') btn.classList.add('positive');
                btn.innerHTML = `<i class="fas ${icon || 'fa-check'}"></i>`;
                btn.addEventListener('click', async () => {
                    const successMsg = typeof success === 'function' ? success(user) : success;
                    await performFriendAction(() => action(user), successMsg);
                });
                actionsWrap.appendChild(btn);
            });

            li.append(avatar, meta);
            if (actionsWrap.childElementCount) li.appendChild(actionsWrap);
            container.appendChild(li);
        });
    }

    function buildFriendStatus(user, fallback) {
        const presence = user?.presence;
        if (!presence) return fallback || 'Online';
        if (presence.online && presence.gameId) {
            const title = getGameTitleById(presence.gameId);
            return title ? `Playing ${title}` : 'Playing';
        }
        if (presence.online) return 'Online';
        return 'Offline';
    }

    async function performFriendAction(actionFn, successMessage) {
        try {
            await actionFn();
            if (successMessage) showToast(successMessage);
            await loadFriends();
        } catch (err) {
            showToast(err.message || 'Action failed', true);
        }
    }

    function respondToRequest(username, action) {
        return api.post('/api/friends/respond', { username, action });
    }

    function removeFriend(username) {
        return api.post('/api/friends/remove', { username });
    }

    function blockUser(username) {
        return api.post('/api/friends/block', { username });
    }

    function unblockUser(username) {
        return api.post('/api/friends/unblock', { username });
    }

    function cancelRequest(username) {
        return api.post('/api/friends/cancel', { username });
    }

    function applySettingsToUI(settings) {
        if (!settings) return;
        if (els.settingProxyDefault) els.settingProxyDefault.checked = !!settings.proxyDefault;
        if (els.settingShowCurrent) els.settingShowCurrent.checked = settings.showCurrent !== false;
        populatePresetSelect(els.settingPanicPreset, state.settingPresets?.panicButtons || []);
        populatePresetSelect(els.settingTabPreset, state.settingPresets?.tabDisguises || []);
        if (els.settingPanicEnabled) els.settingPanicEnabled.checked = !!settings.panicEnabled;
        if (els.settingPanicUrl) els.settingPanicUrl.value = settings.panicUrl || '';
        if (els.settingPanicKeybind) els.settingPanicKeybind.value = settings.panicKeybind || '';
        if (els.settingPanicPreset) els.settingPanicPreset.value = settings.panicPreset || '';
        if (els.settingTabEnabled) els.settingTabEnabled.checked = !!settings.tabDisguiseEnabled;
        if (els.settingTabTitle) els.settingTabTitle.value = settings.tabDisguiseTitle || '';
        if (els.settingTabFavicon) els.settingTabFavicon.value = settings.tabDisguiseFavicon || '';
        if (els.settingTabSource) els.settingTabSource.value = settings.tabDisguiseSource || '';
        if (els.settingTabPreset) els.settingTabPreset.value = settings.tabDisguisePreset || '';
        applySettingsBehavior(settings);
    }

    function populatePresetSelect(selectEl, items = []) {
        if (!selectEl) return;
        const current = selectEl.value;
        selectEl.innerHTML = '<option value="">Custom</option>';
        items.forEach((item) => {
            const opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = item.label || item.id;
            selectEl.appendChild(opt);
        });
        selectEl.value = current || selectEl.value;
    }

    function getPresetById(list = [], id) {
        return list.find((p) => String(p.id) === String(id));
    }

    function formatKeybindFromEvent(e) {
        const parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.metaKey) parts.push('Meta');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        const key = e.key && e.key.length === 1 ? e.key.toUpperCase() : (e.key || '').replace('Arrow', '');
        if (key && !['Control', 'Meta', 'Alt', 'Shift'].includes(key)) parts.push(key);
        return parts.join('+') || 'Escape';
    }

    function parseKeybindString(str) {
        const parts = (str || '').split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
        const combo = { ctrl: false, meta: false, alt: false, shift: false, key: '' };
        parts.forEach((p) => {
            if (p === 'ctrl' || p === 'control') combo.ctrl = true;
            else if (p === 'meta' || p === 'cmd' || p === 'command') combo.meta = true;
            else if (p === 'alt' || p === 'option') combo.alt = true;
            else if (p === 'shift') combo.shift = true;
            else combo.key = p;
        });
        return combo;
    }

    function matchesKeybind(event, combo) {
        if (!combo) return false;
        if (!!combo.ctrl !== !!event.ctrlKey) return false;
        if (!!combo.meta !== !!event.metaKey) return false;
        if (!!combo.alt !== !!event.altKey) return false;
        if (!!combo.shift !== !!event.shiftKey) return false;
        if (!combo.key) return false;
        const key = (event.key || '').toLowerCase();
        return combo.key === key;
    }

    function applyPanicPreset(id) {
        if (!id) return;
        const preset = getPresetById(state.settingPresets?.panicButtons, id);
        if (!preset) return;
        if (els.settingPanicUrl) els.settingPanicUrl.value = preset.url || '';
        if (els.settingPanicKeybind) els.settingPanicKeybind.value = preset.keybind || '';
    }

    function applyTabPreset(id) {
        if (!id) return;
        const preset = getPresetById(state.settingPresets?.tabDisguises, id);
        if (!preset) return;
        if (els.settingTabTitle) els.settingTabTitle.value = preset.title || '';
        if (els.settingTabFavicon) els.settingTabFavicon.value = preset.favicon || '';
        if (els.settingTabSource) els.settingTabSource.value = preset.sourceUrl || '';
    }

    async function fetchTabMetadata() {
        const url = (els.settingTabSource?.value || '').trim();
        if (!url) {
            setSettingsFeedback('Enter a URL to fetch metadata', true);
            return;
        }
        setSettingsFeedback('Fetching metadata...', false);
        try {
            const { title, favicon } = await api.post('/api/utils/page-meta', { url });
            if (title && els.settingTabTitle) els.settingTabTitle.value = title;
            if (favicon && els.settingTabFavicon) els.settingTabFavicon.value = favicon;
            setSettingsFeedback('Metadata applied', false);
            queueSaveSettings();
        } catch (err) {
            setSettingsFeedback(err.message || 'Failed to fetch metadata', true);
        }
    }

    function setFavicon(href) {
        if (!href && runtime.defaultFavicon) href = runtime.defaultFavicon;
        let link = document.querySelector('link[rel="shortcut icon"]') || document.querySelector('link[rel~="icon"]');
        if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            document.head.appendChild(link);
        }
        if (href) link.href = href;
    }

    function applyPanicBehavior(settings) {
        if (runtime.panicHandler) {
            document.removeEventListener('keydown', runtime.panicHandler);
            runtime.panicHandler = null;
        }
        const preset = getPresetById(state.settingPresets?.panicButtons, settings.panicPreset);
        const url = settings.panicUrl || preset?.url;
        const keybindStr = settings.panicKeybind || preset?.keybind || '';
        const enabled = !!settings.panicEnabled && !!url;
        if (els.panicButton) {
            els.panicButton.style.display = enabled ? 'inline-flex' : 'none';
            els.panicButton.onclick = enabled ? (() => triggerPanicRedirect(url)) : null;
        }
        if (!enabled) return;
        const combo = parseKeybindString(keybindStr || 'escape');
        const handler = (e) => {
            if (matchesKeybind(e, combo)) {
                e.preventDefault();
                triggerPanicRedirect(url);
            }
        };
        runtime.panicHandler = handler;
        document.addEventListener('keydown', handler);
    }

    function triggerPanicRedirect(url) {
        if (!url) return;
        window.location.href = url;
    }

    function applyTabDisguiseBehavior(settings) {
        const preset = getPresetById(state.settingPresets?.tabDisguises, settings.tabDisguisePreset);
        if (!runtime.defaultTitle) runtime.defaultTitle = document.title;
        const enabled = !!settings.tabDisguiseEnabled;
        if (!enabled) {
            document.title = runtime.defaultTitle;
            if (runtime.defaultFavicon) setFavicon(runtime.defaultFavicon);
            return;
        }
        const title = settings.tabDisguiseTitle || preset?.title || runtime.defaultTitle;
        const favicon = settings.tabDisguiseFavicon || preset?.favicon || runtime.defaultFavicon;
        if (title) document.title = title;
        if (favicon) setFavicon(favicon);
    }

    function applySettingsBehavior(settings) {
        if (!settings) return;
        state.proxyEnabled = !!settings.proxyDefault;
        updateProxyUI();
        applyCurrentSectionSetting(settings.showCurrent !== false);
        applyPanicBehavior(settings);
        applyTabDisguiseBehavior(settings);
    }

    async function updateHealth() {
        if (!backendUrl) {
            setStatus(false, 'Backend not configured');
            handleConnectivityChange(false, 'Backend URL is not configured. Update config.js or ?api query.');
            return;
        }
        try {
            const health = await api.get('/health');
            const players = Number.isFinite(health.players) ? health.players : (Number.isFinite(health.games) ? health.games : null);
            if (players === null) throw new Error('Bad health payload');
            const label = state.user?.admin ? `Online - ${players} Players` : 'Online';
            setStatus(true, label);
            handleConnectivityChange(true);
            hideOfflineOverlay();
        } catch (_) {
            setStatus(false, 'Offline - Check Network');
            handleConnectivityChange(false, 'bbgamez is currently offline or blocked by your network.');
        }
    }

    function setStatus(isOnline, text) {
        els.statusDot?.classList.toggle('online', isOnline);
        els.statusDot?.classList.toggle('offline', !isOnline);
        els.statusText.textContent = text;
        els.statusText.classList.toggle('online', isOnline);
        els.statusText.classList.toggle('offline', !isOnline);
    }

    function handleConnectivityChange(isOnline, reason) {
        if (runtime.lastOnlineState === isOnline && (isOnline || runtime.offlineNotified)) return;
        runtime.lastOnlineState = isOnline;
        if (!isOnline) {
            runtime.offlineNotified = true;
            pushNotification('Offline', 'bbgamez Online Services are unavailable while offline.', 'warning');
            setStatus(false, 'Offline - Check Network');
            showOfflineOverlay(reason || 'bbgamez is currently offline or blocked by your network.');
        } else {
            runtime.offlineNotified = false;
            pushNotification('Back online', 'Reconnected to bbgamez Online Services.', 'success');
            setStatus(true, 'Online');
            hideOfflineOverlay();
            sendOnlinePing();
        }
    }

    function showOfflineOverlay(message) {
        if (!els.offlineOverlays || !els.mainOfflineOverlay) return;
        if (els.offlineMessage && message) els.offlineMessage.textContent = message;
        els.offlineOverlays.style.display = 'block';
        els.offlineOverlays.style.pointerEvents = 'auto';
        els.mainOfflineOverlay.style.display = 'flex';
        document.body.classList.add('offline-mode');
    }

    function hideOfflineOverlay() {
        if (!els.offlineOverlays) return;
        els.offlineOverlays.style.display = 'none';
        els.offlineOverlays.style.pointerEvents = 'none';
        if (els.mainOfflineOverlay) els.mainOfflineOverlay.style.display = 'none';
        if (els.gameOfflineOverlay) els.gameOfflineOverlay.style.display = 'none';
        document.body.classList.remove('offline-mode');
    }

    function refreshUserUI() {
        if (state.user) {
            els.accountLabel.textContent = state.user.username;
            if (els.friendsAuthNotice) els.friendsAuthNotice.style.display = 'none';
            if (els.friendsAuthNoticeBox) els.friendsAuthNoticeBox.style.display = 'none';
            els.friendsContent.style.display = 'grid';
            populateProfileForm();
            applySettingsToUI(state.settings || state.user.settings);
            updateAccountAvatar(state.user);
            toggleAdminUI(!!state.user.admin);
            if (els.settingsLoginBox) els.settingsLoginBox.style.display = 'none';
            if (els.settingsGrid) els.settingsGrid.style.display = 'grid';
            if (els.settingsActions) els.settingsActions.style.display = 'flex';
            if (els.adminNotifyTests) els.adminNotifyTests.style.display = state.user.admin ? 'flex' : 'none';
        } else {
            els.accountLabel.textContent = 'Log in';
            if (els.friendsAuthNotice) els.friendsAuthNotice.style.display = 'block';
            if (els.friendsAuthNoticeBox) els.friendsAuthNoticeBox.style.display = 'block';
            els.friendsContent.style.display = 'none';
            state.favorites = new Set();
            state.friends = { friends: [], incomingRequests: [], outgoingRequests: [], blocked: [] };
            if (els.friendsCount) els.friendsCount.textContent = '0';
            if (els.pendingCount) els.pendingCount.textContent = '0';
            updateAccountAvatar(null);
            toggleAdminUI(false);
            if (els.settingsGrid) els.settingsGrid.style.display = 'none';
            if (els.settingsActions) els.settingsActions.style.display = 'none';
            if (els.adminNotifyTests) els.adminNotifyTests.style.display = 'none';
            if (els.settingsLoginBox) els.settingsLoginBox.style.display = 'block';
            if (els.profileEmail) els.profileEmail.value = '';
        }
        closeAddFriendModal();
        renderPlayHistory();
        renderFavoritesPage();
    }

    function showBannedModal(reason = 'Your account is banned') {
        if (els.bannedReason) els.bannedReason.textContent = reason;
        if (els.bannedModal) els.bannedModal.style.display = 'flex';
    }

    function hideBannedModal() {
        if (els.bannedModal) els.bannedModal.style.display = 'none';
    }

    function toggleAdminUI(isAdmin) {
        if (els.accountAdminBtn) els.accountAdminBtn.style.display = isAdmin ? 'block' : 'none';
        if (els.openAdminPageBtn) els.openAdminPageBtn.style.display = isAdmin ? 'block' : 'none';
        if (!isAdmin && runtime.currentPage === 'admin') showPage('home');
    }

        function updateAccountAvatar(user) {
            if (!els.accountAvatar) return;
            const avatarUrl = user?.profile?.avatar;
            els.accountAvatar.style.backgroundImage = avatarUrl ? `url(${avatarUrl})` : 'none';
            els.accountAvatar.textContent = avatarUrl ? '' : (user?.username?.[0]?.toUpperCase() || '');
        }

    function populateProfileForm() {
        if (!state.user) return;
        els.profileUsername.value = state.user.username || '';
        if (els.profileEmail) {
            els.profileEmail.value = state.user.email || '';
            els.profileEmail.readOnly = true;
        }
        if (state.user.profile?.avatar) {
            els.avatarPreview.src = state.user.profile.avatar;
            els.avatarPreview.style.display = 'block';
            els.avatarPreview.dataset.value = state.user.profile.avatar;
            els.avatarPlaceholder.style.display = 'none';
        }
    }

    function normalizePathname(pathname = HOME_PATH) {
        if (!pathname) return HOME_PATH;
        const [raw] = pathname.split('?');
        const cleaned = raw.replace(/\/+/g, '/').replace(/\/+$/, '') || HOME_PATH;
        const normalized = cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
        return normalized || HOME_PATH;
    }

    function parseRouteFromPath(pathname = window.location.pathname) {
        const path = normalizePathname(pathname);
        const match = path.match(/^\/game\/([^/]+)\/?$/);
        if (match) return { page: 'game', gameId: decodeURIComponent(match[1]) };
        return { page: 'home' };
    }

    function buildGamePath(gameId) {
        return `${GAME_ROUTE_PREFIX}${encodeURIComponent(gameId)}`;
    }

    function setRoute(path, state = {}, { replace = false } = {}) {
        if (!window?.history?.pushState) return;
        const target = normalizePathname(path);
        const current = normalizePathname(window.location.pathname);
        const method = replace || target === current ? 'replaceState' : 'pushState';
        window.history[method](state, '', target);
    }

    function updateGameRoute(gameId, { replace = false } = {}) {
        setRoute(buildGamePath(gameId), { page: 'game', gameId: String(gameId) }, { replace });
    }

    function resetBaseRoute({ replace = false } = {}) {
        setRoute(HOME_PATH, { page: 'home' }, { replace });
    }

    function applyRouteFromLocation(options = {}) {
        const route = options.route || runtime.pendingRoute || parseRouteFromPath(window.location.pathname);
        runtime.pendingRoute = null;
        runtime.handlingRoute = true;
        if (route.page === 'game') {
            const opened = openGame(route.gameId, { skipHistory: true, replaceHistory: true });
            if (opened) {
                updateGameRoute(route.gameId, { replace: true });
                runtime.handlingRoute = false;
                return;
            }
            resetBaseRoute({ replace: true });
            showPage('home', { skipHistory: true, replaceHistory: true });
        } else {
            showPage(route.page || 'home', { skipHistory: true, replaceHistory: true });
            document.title = runtime.defaultTitle;
            if (normalizePathname(window.location.pathname) !== HOME_PATH) resetBaseRoute({ replace: true });
        }
        runtime.handlingRoute = false;
    }

    function handlePopState() {
        applyRouteFromLocation({ fromPopState: true });
    }

    function setActiveNav(page) {
        els.navItems.forEach((item) => item.classList.toggle('active', item.dataset.page === page));
    }

    function showPage(page, opts = {}) {
        const skipHistory = opts.skipHistory === true;
        const replaceHistory = opts.replaceHistory === true;
        const next = els.pages?.[page];
        if (!next) return;
        if (page === 'admin' && !state.user?.admin) {
            showToast('Admin only', true);
            return showPage('home', opts);
        }

        const currentKey = runtime.currentPage;
        const current = document.querySelector('.page.active') || (currentKey ? els.pages?.[currentKey] : null);
        if (current === next || next.classList.contains('active')) {
            runtime.currentPage = page;
            return;
        }

        const wasGame = runtime.currentPage === 'game' && state.currentGame;
        const transitionId = ++runtime.pageTransitionId;
        const container = next.parentElement;
        if (container && current) {
            const lockHeight = Math.max(current.offsetHeight || 0, next.offsetHeight || 0);
            if (lockHeight > 0) container.style.minHeight = `${lockHeight}px`;
        }

        let currentDone = false;
        let nextDone = false;

        const checkUnlock = () => {
            if (currentDone && nextDone && container) {
                container.style.minHeight = '';
            }
        };

        const finishCurrent = () => {
            if (transitionId !== runtime.pageTransitionId) return;
            if (current) {
                current.classList.remove('leaving', 'is-visible', 'overlay-leave');
                current.style.display = 'none';
            }
            currentDone = true;
            checkUnlock();
        };

        const finishNext = () => {
            if (transitionId !== runtime.pageTransitionId) return;
            next.classList.remove('entering', 'overlay-enter');
            nextDone = true;
            checkUnlock();
        };

        if (current) {
            current.classList.add('leaving', 'is-visible', 'overlay-leave');
            current.classList.remove('active');
            const onLeaveEnd = (event) => {
                if (event.target !== current) return;
                current.removeEventListener('transitionend', onLeaveEnd);
                if (transitionId !== runtime.pageTransitionId) return;
                finishCurrent();
            };
            current.addEventListener('transitionend', onLeaveEnd);
            setTimeout(finishCurrent, 280);
        } else {
            currentDone = true;
        }

        next.style.display = 'block';
        next.classList.remove('leaving');
        next.classList.add('is-visible', 'entering', 'overlay-enter');
        
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (transitionId !== runtime.pageTransitionId) return;
                next.classList.add('active');
                next.classList.remove('entering');
            });
        });

        const onNextEnd = (event) => {
            if (event.target !== next) return;
            next.removeEventListener('transitionend', onNextEnd);
            if (transitionId !== runtime.pageTransitionId) return;
            finishNext();
        };
        next.addEventListener('transitionend', onNextEnd);
        setTimeout(finishNext, 280);

        runtime.currentPage = page;
        const leavingGame = wasGame && page !== 'game';
        if (page !== 'game' && !skipHistory && !runtime.handlingRoute) {
            resetBaseRoute({ replace: replaceHistory });
        }
        if (page !== 'game') document.title = runtime.defaultTitle;
        if (page === 'favorites') renderFavoritesPage();
        if (page === 'home') filterAndRender();
        if (page === 'admin') {
            switchAdminTab(state.adminTab || 'requests');
        }
        if (page !== 'game' && wasGame) {
            beginCloseCurrentGame();
        } else if (page !== 'game') {
            updatePresence(true, null);
        }
        if (page === 'game') renderGameAds(); else renderGameAds();
        renderPlayHistory();
        renderOnlineFriends();
    }

    function toggleProfileDropdown() {
        if (!els.profileDropdown) return;
        const open = els.profileDropdown.getAttribute('aria-hidden') === 'false';
        els.profileDropdown.setAttribute('aria-hidden', open ? 'true' : 'false');
    }

    function openAddFriendModal() {
        if (!state.user) {
            openAuthModal('login');
            return;
        }
        if (!els.addFriendModal) return;
        els.addFriendModal.style.display = 'flex';
        els.addFriendModalInput?.focus();
    }

    function closeAddFriendModal() {
        if (!els.addFriendModal) return;
        els.addFriendModal.style.display = 'none';
        if (els.addFriendModalFeedback) els.addFriendModalFeedback.textContent = '';
    }

    function toggleAccountDropdown() {
        const drop = document.getElementById('accountDropdown');
        if (!drop) return;
        const open = drop.getAttribute('aria-hidden') === 'false';
        drop.setAttribute('aria-hidden', open ? 'true' : 'false');
    }

    function hideAccountDropdown() {
        const drop = document.getElementById('accountDropdown');
        if (drop) drop.setAttribute('aria-hidden', 'true');
    }

    function hideProfileDropdown() {
        if (els.profileDropdown) els.profileDropdown.setAttribute('aria-hidden', 'true');
    }

    function openAuthModal(defaultTab = 'login') {
        if (!els.authModal) return;
        els.authModal.style.display = 'flex';
        els.authModal.dataset.mode = defaultTab;
        els.authTabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === defaultTab));
    }

    function closeAuthModal() {
        if (els.authModal) els.authModal.style.display = 'none';
    }

    async function handleAuthSubmit(e) {
        e.preventDefault();
        const mode = els.authModal.dataset.mode || 'login';
        const identifier = els.authForm.username.value.trim();
        const password = els.authForm.password.value;
        const email = els.authEmail?.value?.trim();
        els.authFeedback.textContent = '';
        try {
            const path = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
            const payload = mode === 'register'
                ? { username: identifier, password, email }
                : { identifier, password };
            const res = await api.post(path, payload);
            const user = res.user;
            if (res.banned) {
                state.user = normalizeUser(user);
                state.favorites = new Set();
                state.settings = null;
                refreshUserUI();
                closeAuthModal();
                showBannedModal(res.reason || 'Your account is banned');
                return;
            }
            hideBannedModal();
            state.user = normalizeUser(user);
            state.favorites = new Set((user.favorites || []).map(String));
            state.settings = user.settings || null;
            await loadSettingsIfNeeded();
            await loadFriends();
            startFriendsPolling();
            updateAccountAvatar(state.user);
            await sendOnlinePing();
            updatePresence(true, null);
            refreshUserUI();
            renderPlayHistory();
            closeAuthModal();
            showToast(mode === 'register' ? 'Account created' : 'Signed in');
        } catch (err) {
            els.authFeedback.textContent = err.message || 'Authentication failed';
        }
    }

    async function logout() {
        try { await api.post('/api/auth/logout'); } catch (_) {}
        finalizePlaySession(true);
        state.user = null;
        state.favorites = new Set();
        state.settings = null;
        state.adminLoginCache = {};
        state.adminAnalytics = null;
        state.friends = { friends: [], incomingRequests: [], outgoingRequests: [], blocked: [] };
        runtime.friendsSnapshot = null;
        if (runtime.friendsPoll) { clearInterval(runtime.friendsPoll); runtime.friendsPoll = null; }
        runtime.friendsPlayingMap = new Map();
        runtime.lastPlayedCache = [];
        cancelCloseTimer(true);
        stopGameFrame();
        applyPanicBehavior({ panicEnabled: false });
        applyTabDisguiseBehavior({ tabDisguiseEnabled: false });
        hideBannedModal();
        hideOfflineOverlay();
        refreshUserUI();
        renderOnlineFriends();
        showPage('home');
    }

    function showLogoutConfirm() {
        if (els.logoutConfirmModal) els.logoutConfirmModal.style.display = 'flex';
    }

    function hideLogoutConfirm() {
        if (els.logoutConfirmModal) els.logoutConfirmModal.style.display = 'none';
    }

    function closeActionModal() {
        if (els.adminActionModal) els.adminActionModal.style.display = 'none';
        if (els.adminActionInput) els.adminActionInput.value = '';
        els.adminActionConfirm?.classList.remove('danger', 'positive');
    }

    function resolveActionModal(result) {
        if (!actionModalResolver) return;
        const resolver = actionModalResolver;
        actionModalResolver = null;
        resolver(result);
    }

    function openActionModal(options = {}) {
        if (!els.adminActionModal) return Promise.resolve({ confirmed: false });
        const {
            title = 'Confirm',
            message = '',
            confirmText = 'Confirm',
            cancelText = 'Cancel',
            inputLabel = '',
            inputPlaceholder = '',
            defaultValue = '',
            inputType = 'text',
            tone = 'danger'
        } = options;

        if (actionModalResolver) resolveActionModal({ confirmed: false });

        if (els.adminActionTitle) els.adminActionTitle.textContent = title;
        if (els.adminActionMessage) els.adminActionMessage.textContent = message;
        const wantsInput = !!inputLabel;
        if (els.adminActionInputRow) els.adminActionInputRow.style.display = wantsInput ? 'flex' : 'none';
        if (wantsInput && els.adminActionInputLabel) els.adminActionInputLabel.textContent = inputLabel;
        if (els.adminActionInput) {
            els.adminActionInput.placeholder = inputPlaceholder || '';
            els.adminActionInput.value = defaultValue || '';
            els.adminActionInput.type = inputType || 'text';
        }

        if (els.adminActionConfirm) {
            els.adminActionConfirm.textContent = confirmText;
            els.adminActionConfirm.classList.toggle('danger', tone === 'danger');
            els.adminActionConfirm.classList.toggle('positive', tone === 'positive');
        }
        if (els.adminActionCancel) els.adminActionCancel.textContent = cancelText;

        if (els.adminActionModal) els.adminActionModal.style.display = 'flex';
        setTimeout(() => {
            const target = wantsInput ? els.adminActionInput : els.adminActionConfirm;
            target?.focus?.();
        }, 0);

        return new Promise((resolve) => { actionModalResolver = resolve; });
    }

    function handleActionConfirm() {
        const wantsInput = els.adminActionInputRow?.style.display === 'flex';
        const value = wantsInput ? (els.adminActionInput?.value || '') : null;
        closeActionModal();
        resolveActionModal({ confirmed: true, value });
    }

    function handleActionCancel() {
        closeActionModal();
        resolveActionModal({ confirmed: false });
    }

    function openPresetEditModal(type = 'panic', index = 0) {
        const presets = state.adminDefaults?.presets || { panicButtons: [], tabDisguises: [] };
        const list = type === 'panic' ? (presets.panicButtons || []) : (presets.tabDisguises || []);
        const preset = list[index];
        if (!preset || !els.adminPresetModal) return;
        presetEditContext = { type, index };
        if (els.adminPresetTitle) els.adminPresetTitle.textContent = type === 'panic' ? 'Edit panic preset' : 'Edit disguise preset';
        if (els.adminPresetName) els.adminPresetName.value = preset.label || preset.title || '';
        if (els.adminPresetUrl) els.adminPresetUrl.value = preset.url || preset.sourceUrl || '';
        if (els.adminPresetFavicon) {
            els.adminPresetFavicon.value = preset.favicon || '';
            els.adminPresetFavicon.parentElement.style.display = type === 'disguise' ? 'block' : 'none';
        }
        if (els.adminPresetSource) {
            els.adminPresetSource.value = preset.sourceUrl || '';
            els.adminPresetSource.parentElement.style.display = type === 'disguise' ? 'block' : 'none';
        }
        els.adminPresetModal.style.display = 'flex';
        setTimeout(() => els.adminPresetName?.focus?.(), 0);
    }

    function closePresetEditModal() {
        if (els.adminPresetModal) els.adminPresetModal.style.display = 'none';
        if (els.adminPresetForm) els.adminPresetForm.reset();
        presetEditContext = null;
    }

    function savePresetEdit(e) {
        if (e) e.preventDefault();
        if (!presetEditContext) return closePresetEditModal();
        const { type, index } = presetEditContext;
        const presets = state.adminDefaults?.presets || { panicButtons: [], tabDisguises: [] };
        const list = type === 'panic' ? (presets.panicButtons || []) : (presets.tabDisguises || []);
        const preset = list[index];
        if (!preset) return closePresetEditModal();
        if (type === 'panic') {
            preset.label = (els.adminPresetName?.value || '').trim() || 'Preset';
            preset.url = (els.adminPresetUrl?.value || '').trim();
        } else {
            const name = (els.adminPresetName?.value || '').trim() || 'Preset';
            preset.label = name;
            preset.title = name;
            preset.favicon = (els.adminPresetFavicon?.value || '').trim();
            preset.sourceUrl = (els.adminPresetSource?.value || '').trim();
            preset.url = preset.sourceUrl;
        }
        state.adminDefaults = state.adminDefaults || { defaults: {}, presets: { panicButtons: [], tabDisguises: [] } };
        state.adminDefaults.presets = presets;
        renderAdminDefaults();
        closePresetEditModal();
    }

    function openLoginHistoryModal(titleText = 'Login history') {
        if (els.adminLoginTitle) els.adminLoginTitle.textContent = titleText;
        if (els.adminLoginModal) els.adminLoginModal.style.display = 'flex';
    }

    function closeLoginHistoryModal() {
        if (els.adminLoginModal) els.adminLoginModal.style.display = 'none';
    }

    function renderLoginHistoryList(history = []) {
        if (!els.adminLoginList) return;
        els.adminLoginList.innerHTML = '';
        if (!history.length) {
            const empty = document.createElement('div');
            empty.className = 'muted-hint';
            empty.textContent = 'No login history yet';
            els.adminLoginList.appendChild(empty);
            return;
        }
        const frag = document.createDocumentFragment();
        history.forEach((entry) => {
            const row = document.createElement('div');
            row.className = 'login-history-row';
            const ip = document.createElement('div');
            ip.className = 'login-history-ip';
            ip.textContent = entry?.ip || 'Unknown IP';
            const meta = document.createElement('div');
            meta.className = 'login-history-meta';
            const count = entry?.count ? `x${entry.count}` : 'x1';
            const ts = entry?.lastAt ? new Date(entry.lastAt).toLocaleString() : 'Unknown time';
            meta.textContent = `${count} • ${ts}`;
            row.append(ip, meta);
            frag.appendChild(row);
        });
        els.adminLoginList.appendChild(frag);
    }

    function updateProxyUI() {
        const active = state.proxyEnabled;
        els.proxyToggleGame?.classList.toggle('off', !active);
        els.proxyToggleGame?.setAttribute('aria-pressed', active ? 'true' : 'false');
        if (state.currentGame) renderGameFriends(state.currentGame.id);
    }

    function toggleSaving(isSaving) {
        if (!els.profileSaveIndicator) return;
        els.profileSaveIndicator.style.display = isSaving ? 'inline-block' : 'none';
        els.profileForm.querySelectorAll('input, button').forEach((el) => { el.disabled = isSaving; });
    }

    function setSettingsFeedback(msg, isError) {
        if (!els.settingsFeedback) return;
        els.settingsFeedback.textContent = msg;
        els.settingsFeedback.style.color = isError ? '#f85149' : '#58a6ff';
    }

    function buildSettingsPayload() {
        return {
            proxyDefault: !!els.settingProxyDefault?.checked,
            showCurrent: els.settingShowCurrent ? els.settingShowCurrent.checked : true,
            panicEnabled: !!els.settingPanicEnabled?.checked,
            panicUrl: (els.settingPanicUrl?.value || '').trim(),
            panicKeybind: (els.settingPanicKeybind?.value || '').trim(),
            panicPreset: els.settingPanicPreset?.value || '',
            tabDisguiseEnabled: !!els.settingTabEnabled?.checked,
            tabDisguiseTitle: (els.settingTabTitle?.value || '').trim(),
            tabDisguiseFavicon: (els.settingTabFavicon?.value || '').trim(),
            tabDisguiseSource: (els.settingTabSource?.value || '').trim(),
            tabDisguisePreset: els.settingTabPreset?.value || ''
        };
    }

    function queueSaveSettings() {
        if (!state.user) {
            setSettingsFeedback('Log in to save settings', true);
            return;
        }
        if (runtime.settingsSaveTimer) clearTimeout(runtime.settingsSaveTimer);
        setSettingsFeedback('Saving...', false);
        runtime.settingsSaveTimer = setTimeout(() => {
            saveSettings();
        }, 200);
    }

    async function saveSettings() {
        if (!state.user) return openAuthModal('login');
        const payload = buildSettingsPayload();
        setSettingsFeedback('Saving...', false);
        try {
            const { settings } = await api.put('/api/settings', payload);
            state.settings = settings;
            applySettingsBehavior(settings);
            setSettingsFeedback('Saved', false);
        } catch (err) {
            setSettingsFeedback(err.message || 'Failed to save', true);
        }
    }

    function showToast(message, isError = false) {
        const tone = isError ? 'error' : 'success';
        pushNotification(isError ? 'Error' : 'Success', message, tone);
    }

    function pushNotification(title, message, type = 'info') {
        if (!els.notificationStack) return;
        const tone = normalizeTone(type);
        const duration = 4500;
        const card = document.createElement('div');
        card.className = `notification-card ${tone}`;
        card.style.setProperty('--notif-duration', `${duration}ms`);
        card.innerHTML = `
            <div class="notification-icon"><i class="fas ${iconForType(tone)}"></i></div>
            <div class="notification-body">
                <div class="notification-title">${title}</div>
                <div class="notification-text">${message}</div>
            </div>
            <button class="notification-close" aria-label="Dismiss"><i class="fas fa-times"></i></button>
            <div class="notification-progress"></div>
        `;
        const progressWrap = card.querySelector('.notification-progress');
        const progress = document.createElement('div');
        progress.className = 'notification-progress-bar';
        progressWrap?.appendChild(progress);

        animateStackShift('up');

        const remove = () => {
            if (card.classList.contains('exiting')) return;
            card.classList.add('exiting');
            card.style.animation = 'notifOut .7s cubic-bezier(.22,1,.36,1) forwards';
            const cleanup = () => card.remove();
            const onExitEnd = (event) => {
                if (event.target !== card) return;
                if (event.animationName && event.animationName !== 'notifOut') return;
                card.removeEventListener('animationend', onExitEnd);
                cleanup();
            };
            card.addEventListener('animationend', onExitEnd);
            setTimeout(cleanup, 900); // fallback if animationend doesn't fire
        };

        card.querySelector('.notification-close')?.addEventListener('click', remove);
        els.notificationStack.appendChild(card);

        let remaining = duration;
        let start = performance.now();
        let hideTimer = setTimeout(remove, remaining);

        const pause = () => {
            clearTimeout(hideTimer);
            remaining -= performance.now() - start;
            if (progress) progress.style.animationPlayState = 'paused';
        };

        const resume = () => {
            start = performance.now();
            hideTimer = setTimeout(remove, remaining);
            if (progress) progress.style.animationPlayState = 'running';
        };

        card.addEventListener('mouseenter', pause);
        card.addEventListener('mouseleave', resume);
    }

    function animateStackShift(direction = 'up', excludeNode = null) {
        const delta = direction === 'up' ? -14 : 14;
        const nodes = Array.from(els.notificationStack?.children || []).filter((node) => node !== excludeNode && !node.classList.contains('exiting'));
        const keyframes = [
            { transform: 'translateY(0)', offset: 0 },
            { transform: `translateY(${delta}px)`, offset: 0.35 },
            { transform: `translateY(${delta * -0.5}px)`, offset: 0.65 },
            { transform: 'translateY(0)', offset: 1 }
        ];
        nodes.forEach((node) => {
            node.animate(keyframes, { duration: 600, easing: 'cubic-bezier(.25,.75,.35,1.15)', fill: 'none' });
        });
    }

    function normalizeTone(type = 'info') {
        const t = String(type || '').toLowerCase();
        if (t === 'success' || t === 'warning' || t === 'error' || t === 'info') return t;
        if (t === 'fail' || t === 'danger') return 'error';
        if (t === 'passive') return 'info';
        return 'info';
    }


    function iconForType(type) {
        switch (type) {
            case 'success': return 'fa-check-circle';
            case 'warning': return 'fa-exclamation-circle';
            case 'error': return 'fa-times-circle';
            default: return 'fa-bell';
        }
    }

    function getGameTitleById(id) {
        if (!id) return '';
        const game = state.games.find((g) => String(g.id) === String(id));
        return game?.title || '';
    }

    function buildMiniAvatar(user) {
        if (!user) return null;
        const div = document.createElement('div');
        div.className = 'mini-avatar';
        const avatarUrl = user.profile?.avatar || user.avatar;
        if (avatarUrl) div.style.backgroundImage = `url(${avatarUrl})`;
        else {
            div.style.background = '#58a6ff';
            div.textContent = (user.username || '?')[0].toUpperCase();
        }
        return div;
    }

    function capitalize(str) { return str ? str.charAt(0).toUpperCase() + str.slice(1) : ''; }


    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    function normalizeUser(user) {
        if (!user) return null;
        const normalized = { ...user };
        normalized.profile = normalized.profile || {};
        normalized.profile.lastPlayed = Array.isArray(normalized.profile.lastPlayed) ? normalized.profile.lastPlayed : [];
        normalized.profile.playtime = normalizePlaytimeMap(normalized.profile.playtime);
        runtime.lastPlayedCache = normalized.profile.lastPlayed.slice();
        return normalized;
    }

    function normalizePlaytimeMap(map) {
        if (!map || typeof map !== 'object') return {};
        const next = {};
        Object.entries(map).forEach(([id, value]) => {
            const ms = Number(value);
            if (!Number.isFinite(ms) || ms < 0) return;
            next[String(id)] = ms;
        });
        return next;
    }

    function updateLocalLastPlayed(gameId) {
        if (!state.user || !gameId) return;
        state.user.profile = state.user.profile || {};
        const existing = Array.isArray(state.user.profile.lastPlayed) ? state.user.profile.lastPlayed.slice() : [];
        const idStr = String(gameId);
        const filtered = existing.filter((id) => String(id) !== idStr);
        filtered.unshift(idStr);
        state.user.profile.lastPlayed = filtered.slice(0, 10);
        runtime.lastPlayedCache = state.user.profile.lastPlayed.slice();
        renderPlayHistory();
    }

    function updateLastPlayedState(list) {
        if (!state.user || !Array.isArray(list)) return;
        const sanitized = list.map((id) => String(id)).filter(Boolean);
        const current = getLastPlayedGames();
        if (!sanitized.length && current.length) return; // avoid wiping history when server yields empty list
        state.user.profile = state.user.profile || {};
        state.user.profile.lastPlayed = sanitized;
        runtime.lastPlayedCache = sanitized.slice();
        renderPlayHistory();
    }

    function setPlaytimeMap(map) {
        if (!state.user) return;
        state.user.profile.playtime = normalizePlaytimeMap(map);
        runtime.lastPlayedCache = getLastPlayedGames();
        renderPlayHistory();
    }

    function getPlaytimeMap() {
        return normalizePlaytimeMap(state.user?.profile?.playtime);
    }

    function getPlaytimeForGame(gameId) {
        const playtime = getPlaytimeMap();
        return playtime[String(gameId)] || 0;
    }

    function addLocalPlaytime(gameId, deltaMs) {
        if (!state.user) return;
        const delta = Number(deltaMs);
        if (!Number.isFinite(delta) || delta <= 0) return;
        const map = getPlaytimeMap();
        const key = String(gameId);
        map[key] = (map[key] || 0) + delta;
        state.user.profile.playtime = map;
    }

    function getLastPlayedGames() {
        const list = Array.isArray(state.user?.profile?.lastPlayed) ? state.user.profile.lastPlayed : [];
        if (!list.length && runtime.lastPlayedCache?.length) return runtime.lastPlayedCache;
        return list;
    }

    function formatPlaytime(ms) {
        const minutes = Math.floor(ms / 60000);
        if (!Number.isFinite(minutes) || minutes <= 0) return 'Under 1 min';
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        if (hours && mins) return `${hours}h ${mins}m`;
        if (hours) return `${hours}h`;
        return `${minutes}m`;
    }

    function renderPlayHistory() {
        renderCurrentlyPlaying();
        renderPreviouslyPlayed();
        renderProfilePlaytime();
        renderOnlineFriends();
        renderGameAds();
    }

    function renderGameAds() {
        const slots = els.gameAdSlots;
        if (!slots) return;
        slots.innerHTML = '';
        if (runtime.currentPage !== 'game') return;
        const count = Math.max(1, Math.min(6, Math.floor(window.innerHeight / 240)));
        const frag = document.createDocumentFragment();
        for (let i = 0; i < count; i += 1) {
            const slot = document.createElement('div');
            slot.className = 'ad-slot-placeholder';
            slot.textContent = 'Ad placeholder';
            frag.appendChild(slot);
        }
        slots.appendChild(frag);
    }

    function renderOnlineFriends() {
        const list = els.sidebarOnlineFriends;
        if (!list) return;
        list.innerHTML = '';
        if (!state.user) {
            list.innerHTML = '<li class="sidebar-empty">Sign in to see friends online</li>';
            return;
        }
        const online = (state.friends?.friends || []).filter((f) => f.presence?.online);
        if (!online.length) {
            list.innerHTML = '<li class="sidebar-empty">No friends online</li>';
            return;
        }
        const frag = document.createDocumentFragment();
        online.slice(0, 10).forEach((f) => {
            const li = document.createElement('li');
            li.className = 'sidebar-online-item';
            const avatar = buildMiniAvatar(f);
            if (avatar) li.appendChild(avatar);
            const meta = document.createElement('div');
            meta.className = 'sidebar-online-meta';
            const name = document.createElement('span');
            name.className = 'mini-text';
            name.textContent = f.username;
            const game = document.createElement('span');
            game.className = 'mini-subtext';
            const title = f.presence?.gameId ? getGameTitleById(f.presence.gameId) || 'Playing' : 'Online';
            game.textContent = title;
            meta.append(name, game);
            li.appendChild(meta);
            li.addEventListener('click', () => {
                if (f.presence?.gameId) openGame(f.presence.gameId);
            });
            frag.appendChild(li);
        });
        list.appendChild(frag);
    }

    function renderCurrentlyPlaying() {
        const list = els.sidebarCurrentPlaying;
        if (!list) return;
        list.innerHTML = '';
        if (!state.user) {
            list.innerHTML = '<li class="sidebar-empty">Sign in to show activity</li>';
            return;
        }
        const activeGame = state.currentGame || runtime.closingGame?.game;
        if (!activeGame) {
            list.innerHTML = '<li class="sidebar-empty">Not playing right now</li>';
            return;
        }
        const item = document.createElement('li');
        item.className = 'sidebar-mini-item active-game';
        const isClosing = !!runtime.closingGame && !state.currentGame;
        const progress = isClosing ? runtime.closingGame.progress || 0 : 1;
        const left = document.createElement('div');
        left.className = 'mini-left';
        const ring = document.createElement('div');
        ring.className = 'sidebar-mini-progress';
        ring.style.setProperty('--progress', `${Math.round(progress * 100)}%`);
        left.appendChild(ring);
        const titleEl = document.createElement('span');
        titleEl.className = 'mini-text';
        titleEl.textContent = activeGame.title;
        left.appendChild(titleEl);
        item.appendChild(left);

        const avatar = buildMiniAvatar(state.user);
        if (avatar) item.appendChild(avatar);
        item.addEventListener('click', () => openGame(activeGame.id));
        list.appendChild(item);
    }

    function renderPreviouslyPlayed() {
        const list = els.sidebarHistory;
        if (!list) return;
        list.innerHTML = '';
        if (!state.user) {
            list.innerHTML = '<li class="sidebar-empty">Sign in to track play history</li>';
            return;
        }
        const lastPlayed = getLastPlayedGames();
        if (!lastPlayed.length) {
            list.innerHTML = '<li class="sidebar-empty">No previous games yet</li>';
            return;
        }
        const frag = document.createDocumentFragment();
        lastPlayed.slice(0, 10).forEach((id) => {
            const title = getGameTitleById(id) || 'Unknown Game';
            const li = document.createElement('li');
            li.className = 'sidebar-mini-item';
            const left = document.createElement('div');
            left.className = 'mini-left';
            const textWrap = document.createElement('div');
            textWrap.className = 'mini-text-wrap';
            const text = document.createElement('span');
            text.className = 'mini-text';
            text.textContent = title;
            const playtime = document.createElement('span');
            playtime.className = 'mini-subtext';
            const ms = getPlaytimeForGame(id);
            playtime.textContent = ms ? formatPlaytime(ms) : 'Under 1 min';
            textWrap.append(text, playtime);
            left.appendChild(textWrap);
            li.appendChild(left);
            const icon = document.createElement('i');
            icon.className = 'fas fa-arrow-up-right-from-square';
            li.appendChild(icon);
            li.addEventListener('click', () => openGame(id));
            frag.appendChild(li);
        });
        list.appendChild(frag);
    }

    function renderProfilePlaytime() {
        const list = els.profilePlaytimeList;
        const empty = els.profilePlaytimeEmpty;
        if (!list || !empty) return;
        list.innerHTML = '';
        const playtimeMap = getPlaytimeMap();
        if (!state.user) {
            empty.textContent = 'Sign in to track playtime.';
            empty.style.display = 'block';
            return;
        }
        const seen = new Set();
        const ordered = [];
        getLastPlayedGames().forEach((id) => {
            const key = String(id);
            seen.add(key);
            ordered.push({ id: key, ms: playtimeMap[key] || 0 });
        });
        Object.entries(playtimeMap)
            .sort((a, b) => (b[1] || 0) - (a[1] || 0))
            .forEach(([id, ms]) => {
                if (seen.has(id)) return;
                ordered.push({ id, ms });
            });
        const displayList = ordered.filter((item) => getGameTitleById(item.id) || item.ms > 0);
        if (!displayList.length) {
            empty.textContent = 'No playtime tracked yet.';
            empty.style.display = 'block';
            return;
        }
        empty.style.display = 'none';
        const frag = document.createDocumentFragment();
        displayList.slice(0, 10).forEach(({ id, ms }) => {
            const li = document.createElement('li');
            li.className = 'sidebar-mini-item';
            const left = document.createElement('div');
            left.className = 'mini-left';
            const textWrap = document.createElement('div');
            textWrap.className = 'mini-text-wrap';
            const title = document.createElement('span');
            title.className = 'mini-text';
            title.textContent = getGameTitleById(id) || 'Unknown Game';
            const time = document.createElement('span');
            time.className = 'mini-subtext';
            time.textContent = ms ? formatPlaytime(ms) : 'Under 1 min';
            textWrap.append(title, time);
            left.appendChild(textWrap);
            li.appendChild(left);
            const icon = document.createElement('i');
            icon.className = 'fas fa-arrow-up-right-from-square';
            li.appendChild(icon);
            li.addEventListener('click', () => openGame(id));
            frag.appendChild(li);
        });
        list.appendChild(frag);
    }


    function applyCurrentSectionSetting(show) {
        const enable = show !== false;
        if (els.sidebarCurrentSection) els.sidebarCurrentSection.style.display = enable ? 'list-item' : 'none';
    }

    function beginCloseCurrentGame() {
        if (!state.currentGame && !runtime.closingGame) return;
        const game = state.currentGame || runtime.closingGame?.game;
        finalizePlaySession(true);
        state.currentGame = null;
        if (!game) return;
        runtime.closingGame = { game, endAt: Date.now() + 10000, progress: 0 };
        updatePresence(true, null);
        startCloseTimer();
        renderPlayHistory();
    }

    function startCloseTimer() {
        if (runtime.closeTicker) cancelAnimationFrame(runtime.closeTicker);
        const tick = () => {
            if (!runtime.closingGame) return;
            const total = runtime.closingGame.endAt - (runtime.closingGame.startAt || (runtime.closingGame.endAt - 10000));
            const remaining = runtime.closingGame.endAt - Date.now();
            const elapsed = total - remaining;
            const progress = Math.min(1, Math.max(0, elapsed / total));
            runtime.closingGame.progress = progress;
            if (remaining <= 0) {
                finalizeClosingGame();
                return;
            }
            renderCurrentlyPlaying();
            runtime.closeTicker = requestAnimationFrame(tick);
        };
        runtime.closingGame.startAt = runtime.closingGame.startAt || Date.now();
        runtime.closeTicker = requestAnimationFrame(tick);
    }

    function cancelCloseTimer(stopFrame = false) {
        if (runtime.closeTicker) cancelAnimationFrame(runtime.closeTicker);
        runtime.closeTicker = null;
        runtime.closingGame = null;
        if (stopFrame) stopGameFrame();
    }

    function finalizeClosingGame() {
        stopGameFrame();
        runtime.closingGame = null;
        if (runtime.closeTicker) cancelAnimationFrame(runtime.closeTicker);
        runtime.closeTicker = null;
        renderPlayHistory();
    }

    function stopGameFrame() {
        if (els.gameFrame) {
            els.gameFrame.src = 'about:blank';
        }
    }
})();
